import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement, RenderViewport } from 'claude-code'

import type { ChecklistItem } from '../types'
import {
  add,
  bandHead,
  clearDone,
  clip,
  done,
  formatList,
  nudgeText,
  parseCommand,
  parseToolInput,
  progress,
  remove,
  sanitize,
  start,
  statusText,
  undo,
  type OpResult,
} from './lib'

const TOOL = 'mcp__checklist__checklist'
const PANE = 'checklist'
const STORE_PREFIX = 'list:'
/** First line of `/checklist` when the pane cannot be placed; the CommandOutput hook draws the list for it. */
const WAITING_HEAD = 'The checklist pane has no room here (it opens once the terminal is wide enough), so here is the list:'
/** Args of `/checklist` that show the list (no args toggles the pane). */
const LIST_ARGS = new Set(['', 'list', 'ls', 'show'])

/** The elements every surface has, mobile included, plus the text field where the surface has one. */
type ListElements = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'> & { Input?: Elements['terminal']['Input'] }

/** How a list tree is drawn: the pane gets hotkeys, an add field and a key hint; the inline list does not. */
type ListOptions = { columns: number | undefined; isPane: boolean; isFocused?: boolean; showHint?: boolean }

/** Items that get a digit hotkey (1-9, by position) to tick them while the pane has the keys. */
const HOTKEY_ITEMS = 9
/** The width from which a pane opened unasked is seated (see PaneOpenArgs). */
const UNASKED_MIN_COLUMNS = 144

const items = atom({ plugin: 'checklist', key: 'items' } as const, [])
const storeKey = atom({ plugin: 'checklist', key: 'storeKey' } as const, '')
const autoOpened = atom({ plugin: 'checklist', key: 'autoOpened' } as const, false)

/**
 * The layout last seen while drawing. Module-level on purpose: a render hook may
 * not write `$.state`, and a reload re-learns it at the next draw.
 */
let layout: { isFullscreen?: boolean; columns?: number } = {}

function learnLayout(viewport: RenderViewport | undefined): void {
  if (viewport === undefined) return
  layout = { isFullscreen: viewport.isFullscreen ?? layout.isFullscreen, columns: viewport.columns }
}

const TOOL_DESCRIPTION = [
  "A persistent checklist for the current repository, shared with the user (they see it above the prompt and edit it with /checklist).",
  'Use it to track multi-step work: add the steps, "start" one when you begin it, "done" it as soon as it is finished, and add follow-up work you discover.',
  'Actions: "list" (show items); "add" with "items": ["text", ...] (several at once); "start" / "done" / "remove" with "ids": [n, ...] (item numbers as shown, e.g. #3 -> 3); "clear-done" (drop finished items).',
  'Every call returns the updated list as compact text: [ ] todo, [>] doing, [x] done, then #id and the text.',
].join(' ')

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'start', 'done', 'remove', 'clear-done'],
      description: 'What to do.',
    },
    items: {
      type: 'array',
      items: { type: 'string' },
      description: 'For "add": the texts of the new items, one short line each.',
    },
    ids: {
      type: 'array',
      items: { type: 'integer' },
      description: 'For "start", "done" and "remove": item numbers as the list shows them.',
    },
  },
  required: ['action'],
  additionalProperties: false,
} as const

type Dollar = EngineInterface

/** The repo root (or the working directory outside a repo) names the list. */
async function resolveStoreKey($: Dollar): Promise<string> {
  let root: string | undefined
  try {
    root = (await $.session.repo())?.root
  } catch {
    root = undefined
  }
  if (root === undefined) root = await $.session.cwd()
  return `${STORE_PREFIX}${root}`
}

/** Reads the repo's list from $.store into $.state. */
async function load($: Dollar): Promise<string> {
  const key = await resolveStoreKey($)
  const stored = sanitize(await $.store.get(key))
  await update($, storeKey, () => key)
  await update($, items, () => stored)
  refreshStatus($, stored)
  return key
}

let statusEnabled = true // set from the `showStatus` option on every (re)load of register

/** The status line (`☑ 3/7 · next: ...`): the one checklist view the mobile app shows unasked. */
function refreshStatus($: Dollar, list: readonly ChecklistItem[]): void {
  if (statusEnabled) $.ui.status(statusText(list))
}

async function ensureLoaded($: Dollar): Promise<string> {
  const key = await read($, storeKey)
  return key !== '' ? key : load($)
}

/** Applies a pure list operation to $.state and persists it to $.store. */
async function mutate($: Dollar, op: (list: ChecklistItem[], now: number) => OpResult): Promise<OpResult> {
  const key = await ensureLoaded($)
  const now = await $.clock.now()
  let outcome: OpResult = { items: [], changed: [] }
  const next = await update($, items, list => {
    outcome = op(list, now)
    return outcome.error === undefined ? outcome.items : list
  })
  if (outcome.error === undefined) {
    await $.store.set(key, next)
    refreshStatus($, next)
  }
  return { ...outcome, items: next }
}

function summary(list: readonly ChecklistItem[]): string {
  if (list.length === 0) return 'Checklist is empty.'
  const p = progress(list)
  return `${bandHead(list)} ${p.next === undefined ? 'all done' : `next: #${p.next.id} ${p.next.text}`}`
}

function names(list: readonly ChecklistItem[]): string {
  return list.map(item => `#${item.id} ${item.text}`).join('; ')
}

async function togglePane($: Dollar): Promise<string> {
  // A pane that is open but waits undrawn (narrow terminal, mobile-only session) is not "open" to the person.
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return 'Checklist pane closed.'
  }
  const list = await read($, items)
  // Asked for, so it takes the keyboard: digits tick, Tab walks, Esc hands the keys back.
  const opened = await $.ui.open({ id: PANE, title: 'Checklist', focus: true, rows: paneRows(list) })
  if (opened.isPlaced) return `Checklist pane opened. ${summary(list)}`
  return `${WAITING_HEAD}\n${formatList(list)}`
}

/** Inline height: the head, the items, the add field and the hint. */
function paneRows(list: readonly ChecklistItem[]): number {
  return Math.min(Math.max(list.length, 1) + 5, 22)
}

/**
 * Opens the pane unasked, once a session, only where it docks as a sidebar and
 * the list has open work. Without the keyboard: the person is typing elsewhere.
 */
async function maybeAutoOpen($: Dollar): Promise<void> {
  if (layout.isFullscreen !== true) return
  if (layout.columns !== undefined && layout.columns < UNASKED_MIN_COLUMNS) return
  if (await read($, autoOpened)) return
  const list = await read($, items)
  if (!list.some(item => item.status !== 'done')) return
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) return
  const opened = await $.ui.open({ id: PANE, title: 'Checklist', rows: paneRows(list) })
  if (opened.isPlaced) await update($, autoOpened, () => true)
  else await $.ui.close({ id: PANE })
}

export const register: Register = (on, options) => {
  const autoOpen = options.autoOpen !== false
  const showBand = options.showBand !== false
  const nudge = options.nudge !== false
  statusEnabled = options.showStatus !== false

  on('session.start', async ($, e, next) => {
    try {
      await load($)
    } catch (error) {
      $.ui.log(`checklist: could not load the list (${String(error)})`, { to: 'debug' })
    }
    await $.tool.register({ name: 'checklist', description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA })
    await $.command.register({
      name: 'checklist',
      description: 'Show or edit this repo\'s checklist (no args toggles the pane)',
      argumentHint: '[add <text> | done <n> | undo <n> | rm <n> | clear]',
    })
    // The layout is learned from the first draws; look once they have had a moment.
    if (autoOpen) $.clock.after(1500, () => void maybeAutoOpen($).catch(() => undefined))
    return next(e)
  })

  // Passive: learns whether the surface docks panes, for the unasked open.
  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    learnLayout(e.viewport)
    return next(e)
  })

  // Only touches this plugin's own list, so it never needs a permission prompt.
  on('tool.check', { tool: TOOL }, () => ({ decision: 'allow' as const }))

  // Keep the schema in the prompt's tool list rather than behind ToolSearch.
  on('tool.describe', { tool: TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const request = parseToolInput(e as unknown as Record<string, unknown>)
    let outcome: OpResult
    switch (request.action) {
      case 'error':
        return { deny: request.message }
      case 'list':
        await ensureLoaded($)
        return { result: formatList(await read($, items)) }
      case 'add': {
        const texts = request.texts
        outcome = await mutate($, (list, now) => add(list, texts, now))
        // Claude planning work is when the list is worth a sidebar.
        if (autoOpen && outcome.error === undefined) await maybeAutoOpen($).catch(() => undefined)
        break
      }
      case 'start': {
        const ids = request.ids
        outcome = await mutate($, (list, now) => start(list, ids, now))
        break
      }
      case 'done': {
        const ids = request.ids
        outcome = await mutate($, (list, now) => done(list, ids, now))
        break
      }
      case 'remove': {
        const ids = request.ids
        outcome = await mutate($, list => remove(list, ids))
        break
      }
      case 'clear-done':
        outcome = await mutate($, list => clearDone(list))
        break
    }
    if (outcome.error !== undefined) return { deny: `${outcome.error}\n${formatList(outcome.items)}` }
    return { result: formatList(outcome.items) }
  }).catch(() => ({ deny: 'checklist: the tool failed. Call it with action "list" to see the current state.' }))

  on('command.run', { command: 'checklist' }, async ($, e) => {
    const command = parseCommand(e.args)
    let outcome: OpResult
    let verb: string
    switch (command.kind) {
      case 'error':
        return { text: command.message }
      case 'toggle':
        await ensureLoaded($)
        return { text: await togglePane($) }
      case 'list':
        await ensureLoaded($)
        return { text: formatList(await read($, items)) }
      case 'add': {
        const texts = command.texts
        outcome = await mutate($, (list, now) => add(list, texts, now))
        verb = 'Added'
        break
      }
      case 'start': {
        const ids = command.ids
        outcome = await mutate($, (list, now) => start(list, ids, now))
        verb = 'Started'
        break
      }
      case 'done': {
        const ids = command.ids
        outcome = await mutate($, (list, now) => done(list, ids, now))
        verb = 'Done'
        break
      }
      case 'undo': {
        const ids = command.ids
        outcome = await mutate($, (list, now) => undo(list, ids, now))
        verb = 'Reopened'
        break
      }
      case 'rm': {
        const ids = command.ids
        outcome = await mutate($, list => remove(list, ids))
        verb = 'Removed'
        break
      }
      case 'clear':
        outcome = await mutate($, list => clearDone(list))
        if (outcome.changed.length === 0) return { text: `No done items to clear. ${summary(outcome.items)}` }
        return { text: `Cleared ${outcome.changed.length} done item(s). ${summary(outcome.items)}` }
    }
    if (outcome.error !== undefined) return { text: outcome.error }
    return { text: `${verb}: ${names(outcome.changed)}\n${summary(outcome.items)}` }
  })

  if (nudge) {
    on('prompt.compose', async ($, e, next) => {
      const composed = await next(e)
      if (e.traits.includes('bare')) return composed
      const text = nudgeText(await read($, items), TOOL)
      if (text === undefined) return composed
      return { sections: [...composed.sections, { id: 'checklist:open-items', text, scope: 'session' as const }] }
    })
  }

  if (showBand) {
    // One band for every plugin: draw this part, then stack whatever the hooks beneath draw under it.
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      learnLayout(e.viewport)
      const list = await read($, items)
      if (e.props.hasSurvey || list.length === 0) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      const p = progress(list)
      const mine = (
        <Box key="checklist-band" flexDirection="row">
          <Text color={p.next === undefined ? 'success' : undefined}>
            {bandHead(list)}{' '}
          </Text>
          <Text dimColor wrap="truncate-end">
            {p.next === undefined ? 'all done' : `next: ${p.next.text}`}
          </Text>
        </Box>
      )
      const below = await next(e)
      if (isEmptyTree(below)) return mine
      return (
        <Box key="checklist-stack" flexDirection="column">
          {mine}
          {below}
        </Box>
      )
    })
  }

  // The pane, every surface that places one. Only Box, Text and Button: all of them exist on mobile too.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    learnLayout(e.viewport)
    const ui = $.ui.resolve(e)
    const list = await read($, items)
    const Input = 'Input' in ui ? ui.Input : undefined
    return listTree($, { Box: ui.Box, Button: ui.Button, Text: ui.Text, ...(Input !== undefined ? { Input } : {}) }, list, {
      columns: e.props.bodyColumns,
      isPane: true,
      isFocused: e.props.isFocused,
      showHint: e.surface === 'terminal',
    })
  })

  // `/checklist` and `/checklist list` draw the list inline, with tappable ticks: always on mobile (which
  // places no pane), and elsewhere for `list` or when the pane could not be placed.
  on('ui.render', { component: 'CommandOutput', props: { command: 'checklist' } }, async ($, e, next) => {
    const args = e.props.args.trim().toLowerCase()
    if (e.props.isErrored || !LIST_ARGS.has(args)) return next(e)
    const inline = e.surface === 'mobile' || args !== '' || e.props.text.startsWith(WAITING_HEAD)
    if (!inline) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, items)
    return listTree($, { Box, Button, Text }, list, { columns: e.viewport?.columns, isPane: false })
  })
}

/** True for a tree that draws nothing: no element, or Boxes/Texts holding only empty strings. */
function isEmptyTree(tree: RenderElement | null | undefined): boolean {
  if (tree === null || tree === undefined) return true
  const el = tree as unknown as { type?: string; children?: unknown; props?: { children?: unknown } }
  if (el.type !== 'Box' && el.type !== 'Text') return false
  return isEmptyChildren(el.children ?? el.props?.children)
}

function isEmptyChildren(children: unknown): boolean {
  if (children === undefined || children === null || children === false) return true
  if (typeof children === 'string') return children === ''
  if (typeof children === 'number') return false
  if (Array.isArray(children)) return children.every(isEmptyChildren)
  return isEmptyTree(children as RenderElement)
}

/**
 * The full list with tick, start, remove and clear-done Buttons, for the pane and the inline command output.
 * In the pane the first nine ticks answer the digits 1-9, `c` clears done items, and an add field sits below.
 */
function listTree($: Dollar, ui: ListElements, list: readonly ChecklistItem[], opts: ListOptions): RenderElement {
  const { Box, Button, Input, Text } = ui
  const p = progress(list)
  const addField =
    opts.isPane && Input !== undefined ? (
      <Box key="add-row" flexDirection="row">
        <Input
          key="add"
          label="+ "
          placeholder="Add an item and press Enter"
          value=""
          submitLabel="add"
          {...(list.length === 0 ? { autoFocus: true as const } : {})}
          onSubmit={text => {
            const trimmed = text.trim()
            if (trimmed.length > 0) void mutate($, (l, now) => add(l, [trimmed], now))
          }}
        />
      </Box>
    ) : undefined
  const hint =
    opts.isPane && opts.showHint === true
      ? opts.isFocused === true
        ? `1-${Math.max(1, Math.min(list.length, HOTKEY_ITEMS))} tick · Tab/Enter buttons${p.done > 0 ? ' · c clear done' : ''} · Esc back`
        : 'ctrl+x tab to use the keys · or click'
      : undefined
  const hintRow =
    hint === undefined ? undefined : (
      <Text key="hint" dimColor wrap="truncate-end">
        {hint}
      </Text>
    )
  if (list.length === 0) {
    return (
      <Box key="empty" flexDirection="column">
        <Text dimColor>
          {addField !== undefined
            ? 'No items yet. Type one below, or ask Claude to plan its work with the checklist tool.'
            : 'No items yet. Add one with /checklist add <text>, or ask Claude to plan its work with the checklist tool.'}
        </Text>
        {addField}
        {hintRow}
      </Box>
    )
  }
  // Room for the tick (and its `1: `), the start mark, `#nn `, spaces and the ✕; a narrow phone gets a shorter line.
  const textMax = opts.columns === undefined ? 200 : Math.max(opts.columns - (opts.isPane ? 18 : 12), 8)
  return (
    <Box key="list" flexDirection="column">
      <Text bold>
        {bandHead(list)} {p.total - p.done} open
      </Text>
      {list.map((item, index) => {
        const hotkey = opts.isPane && index < HOTKEY_ITEMS ? String(index + 1) : undefined
        return (
          <Box key={`row-${item.id}`} flexDirection="row">
            <Button
              key={`tick-${item.id}`}
              plain
              {...(hotkey !== undefined ? { hotkey } : {})}
              label={item.status === 'done' ? '☑' : item.status === 'doing' ? '◐' : '☐'}
              onPress={() => mutate($, (l, now) => (item.status === 'done' ? undo(l, [item.id], now) : done(l, [item.id], now)))}
            />
            <Text
              dimColor={item.status === 'done'}
              strikethrough={item.status === 'done'}
              bold={item.status === 'doing'}
              wrap="truncate-end"
            >
              {' '}#{item.id} {clip(item.text, textMax)}{' '}
            </Text>
            {opts.isPane && item.status === 'todo' && (
              <Button key={`start-${item.id}`} plain dimColor label="▸" onPress={() => mutate($, (l, now) => start(l, [item.id], now))} />
            )}
            {opts.isPane && item.status === 'todo' && <Text> </Text>}
            <Button key={`rm-${item.id}`} plain dimColor label="✕" onPress={() => mutate($, l => remove(l, [item.id]))} />
          </Box>
        )
      })}
      {p.done > 0 && (
        <Box flexDirection="row">
          <Button
            key="clear-done"
            {...(opts.isPane ? { hotkey: 'c' } : {})}
            label="Clear done"
            onPress={() => mutate($, l => clearDone(l))}
          />
        </Box>
      )}
      {addField}
      {hintRow}
    </Box>
  )
}

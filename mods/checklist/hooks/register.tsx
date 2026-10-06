import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChecklistItem } from '../types'
import {
  add,
  bandHead,
  clearDone,
  done,
  formatList,
  nudgeText,
  parseCommand,
  parseToolInput,
  progress,
  remove,
  sanitize,
  start,
  undo,
  type OpResult,
} from './lib'

const TOOL = 'mcp__checklist__checklist'
const PANE = 'checklist'
const STORE_PREFIX = 'list:'

const items = atom({ plugin: 'checklist', key: 'items' } as const, [])
const storeKey = atom({ plugin: 'checklist', key: 'storeKey' } as const, '')

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
  return key
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
  if (outcome.error === undefined) await $.store.set(key, next)
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
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return 'Checklist pane closed.'
  }
  const list = await read($, items)
  const opened = await $.ui.open({ id: PANE, title: 'Checklist', rows: Math.min(Math.max(list.length, 1) + 3, 20) })
  if (opened.isPlaced) return `Checklist pane opened. ${summary(list)}`
  return `Checklist pane is waiting for room (widen the terminal).\n${formatList(list)}`
}

export const register: Register = (on, options) => {
  const showBand = options.showBand !== false
  const nudge = options.nudge !== false

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
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      const list = await read($, items)
      if (e.props.hasSurvey || list.length === 0) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      const p = progress(list)
      return (
        <Box key="checklist-band" flexDirection="row">
          <Text color={p.next === undefined ? 'success' : undefined}>
            {bandHead(list)}{' '}
          </Text>
          <Text dimColor wrap="truncate-end">
            {p.next === undefined ? 'all done' : `next: ${p.next.text}`}
          </Text>
        </Box>
      )
    })
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, items)
    const p = progress(list)
    if (list.length === 0) {
      return (
        <Box key="empty" flexDirection="column">
          <Text dimColor>
            {'No items yet. Add one with /checklist add <text>, or ask Claude to plan its work with the checklist tool.'}
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold>
          {bandHead(list)} {p.total - p.done} open
        </Text>
        {list.map(item => (
          <Box key={`row-${item.id}`} flexDirection="row">
            <Button
              key={`tick-${item.id}`}
              plain
              label={item.status === 'done' ? '☑' : item.status === 'doing' ? '◐' : '☐'}
              onPress={() => mutate($, (l, now) => (item.status === 'done' ? undo(l, [item.id], now) : done(l, [item.id], now)))}
            />
            <Text
              dimColor={item.status === 'done'}
              strikethrough={item.status === 'done'}
              bold={item.status === 'doing'}
              wrap="truncate-end"
            >
              {' '}#{item.id} {item.text}{' '}
            </Text>
            <Button key={`rm-${item.id}`} plain dimColor label="✕" onPress={() => mutate($, l => remove(l, [item.id]))} />
          </Box>
        ))}
        {p.done > 0 && (
          <Box flexDirection="row">
            <Button key="clear-done" label="Clear done" onPress={() => mutate($, l => clearDone(l))} />
          </Box>
        )}
      </Box>
    )
  })
}

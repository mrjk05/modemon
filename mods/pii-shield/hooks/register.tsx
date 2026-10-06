// pii-shield: masks personal data and secrets on screen while you record.
//
// Display only: every drawing hook here is a `ui.render` rewrite of the props
// a row is drawn from (`next({ ...e, props })`), a rewrite of the tree another
// plugin drew (panes, the band), or a rewrite of the text of a `$.ui` call
// (toasts, status entries, notices, pane titles). What the model reads and
// what the transcript stores are never touched.
//
// Surfaces: terminal, desktop and the mobile app. A remote surface asks core
// for a row over the wire (ui_render) and draws with the props these hooks
// handed core, so the phone draws the masked text too. No hook branches on
// the surface to decide whether to mask, and every element drawn here (Box,
// Text) is in every surface's table, mobile's included.
//
// Failure policy: FAIL CLOSED. If redacting a row throws or overruns its
// budget while redaction is (or may be) on, the row is replaced by a one-line
// placeholder instead of being drawn unredacted. While redaction is known to
// be off, a failure draws the engine's own row.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement, RenderInput, RenderNode } from 'claude-code'

import type { PiiShieldMode, PiiShieldState } from '../types'
import { findRecorder, isMaskableUsername, parsePlatform, platformFromHome, processListArgv } from './detect'
import type { Platform } from './detect'
import { BLOCK, CATEGORIES, parseNameList, redactDeep, redactText } from './redact'
import type { Category, RedactOptions } from './redact'

const POLL_MS = 5000
const PS_TIMEOUT_MS = 4000
const MAX_POLL_FAILURES = 3

export const STATUS_ON = '● REDACTING'
export const STATUS_OFF = '○ pii-shield'

const MODES: readonly PiiShieldMode[] = ['auto', 'on', 'off']

const CATEGORY_OPTION: Readonly<Record<Category, string>> = {
  contact: 'maskContact',
  network: 'maskNetwork',
  financial: 'maskFinancial',
  secrets: 'maskSecrets',
  names: 'maskNames',
  paths: 'maskPaths',
}

const shield = atom({ plugin: 'pii-shield', key: 'shield' } as const, { override: null, recorder: null })
const identity = atom({ plugin: 'pii-shield', key: 'identity' } as const, [])

/** What one load of the module knows: its options and its poller. */
type Ctx = {
  defaultMode: PiiShieldMode
  categories: Record<Category, boolean>
  extraNames: string[]
  /**
   * Only for the failure fallback: whether the last draw that read the state
   * redacted. Unknown counts as on, so a failure before any read fails closed.
   */
  wasRedacting: boolean
  platform: Platform
  pollFailures: number
  isPolling: boolean
  timer: { cancel: () => void } | undefined
}

// ---------------------------------------------------------------------------
// Pure helpers

function configMode(options: PluginOptions): PiiShieldMode {
  const value = options['mode']
  return MODES.find(mode => mode === value) ?? 'auto'
}

function configCategories(options: PluginOptions): Record<Category, boolean> {
  const out = {} as Record<Category, boolean>
  for (const category of CATEGORIES) out[category] = options[CATEGORY_OPTION[category]] !== false
  return out
}

function configNames(options: PluginOptions): string[] {
  const value = options['names']
  if (typeof value === 'string') return parseNameList(value)
  if (Array.isArray(value)) return parseNameList(value.join(','))
  return []
}

export function effectiveMode(state: PiiShieldState, fallback: PiiShieldMode): PiiShieldMode {
  return state.override ?? fallback
}

export function isRedacting(state: PiiShieldState, fallback: PiiShieldMode): boolean {
  const mode = effectiveMode(state, fallback)
  return mode === 'on' || (mode === 'auto' && state.recorder !== null)
}

/**
 * The AskUserQuestion dialog's questions with each option's `description` and
 * `preview` redacted. The question text and the option labels are left alone:
 * the dialog answers with the label picked, keyed by the question's text, so
 * masking them would change what Claude reads back.
 */
export function redactQuestions(questions: unknown[], opts: RedactOptions): unknown[] {
  return questions.map(question => {
    if (question === null || typeof question !== 'object' || !('options' in question)) return question
    const options = (question as { options: unknown }).options
    if (!Array.isArray(options)) return question
    const redacted = options.map((option: unknown) => {
      if (option === null || typeof option !== 'object') return option
      const out: Record<string, unknown> = { ...(option as Record<string, unknown>) }
      if (typeof out['description'] === 'string') out['description'] = redactText(out['description'], opts)
      if (typeof out['preview'] === 'string') out['preview'] = redactText(out['preview'], opts)
      return out
    })
    return { ...question, options: redacted }
  })
}

/** The first line of every `/redact` answer the status card draws. */
export const CARD_HEAD = 'pii-shield: '
const DISPLAY_ONLY = 'Display only: Claude and the transcript still see the real values.'

/**
 * The `/redact` answer as text, one `Label: value` line per field: what the
 * model reads, what a surface draws if the card cannot be, and what the card
 * (`statusCard`) is drawn from, so a past row keeps the state it reported.
 */
function describe(ctx: Ctx, state: PiiShieldState): string {
  const mode = effectiveMode(state, ctx.defaultMode)
  const source = state.override === null ? 'from settings' : 'set by /redact'
  const isOn = isRedacting(state, ctx.defaultMode)
  let recorder: string
  if (mode !== 'auto') {
    recorder = `not watched (mode ${mode})`
  } else if (state.recorder !== null) {
    recorder = `${state.recorder}, seen this session (stays on until /redact off)`
  } else if (processListArgv(ctx.platform) === null) {
    recorder = 'detection not available on this platform; use /redact on'
  } else if (ctx.timer === undefined) {
    recorder = 'detection stopped; use /redact on before recording'
  } else {
    recorder = 'none seen; watching every 5s'
  }
  const enabled = CATEGORIES.filter(category => ctx.categories[category])
  return [
    `${CARD_HEAD}${isOn ? 'REDACTING' : 'not redacting'}`,
    `Mode: ${mode} (${source})`,
    `Recorder: ${recorder}`,
    `Masking: ${enabled.length === 0 ? 'nothing' : enabled.join(', ')}`,
    DISPLAY_ONLY,
  ].join('\n')
}

/** The fields of a `/redact` answer (`describe`), or null for any other text. */
export function parseStatus(text: string): { isOn: boolean; fields: [string, string][] } | null {
  const [head, ...rest] = text.split('\n')
  if (head === undefined || !head.startsWith(CARD_HEAD)) return null
  const fields: [string, string][] = []
  for (const line of rest) {
    if (line === DISPLAY_ONLY) continue
    const at = line.indexOf(': ')
    if (at <= 0) return null
    fields.push([line.slice(0, at).toLowerCase(), line.slice(at + 2)])
  }
  return { isOn: head.slice(CARD_HEAD.length) === 'REDACTING', fields }
}

/**
 * Every string a tree shows, redacted: Text/Box/Link children, a Button's
 * label, a Markdown's text, a Code's source and path, an Svg's alt. An
 * element with nothing to mask is handed back as it came (same object), so a
 * tree with no personal data reaches the surface untouched. Input and Select
 * values are left alone (masking them would change what the person types),
 * as are a Client's own drawing and an Svg's markup, which no hook can read.
 */
export function redactTree(node: RenderNode, opts: RedactOptions, depth = 0): RenderNode {
  if (typeof node === 'string') return redactText(node, opts)
  if (depth > 64) return node
  switch (node.type) {
    case 'Box':
    case 'Text':
    case 'Link': {
      const children = node.children
      if (children === undefined) return node
      const out = children.map(child => redactTree(child, opts, depth + 1))
      return out.every((child, i) => child === children[i]) ? node : ({ ...node, children: out } as RenderElement)
    }
    case 'Button': {
      const label = redactText(node.props.label, opts)
      return label === node.props.label ? node : { ...node, props: { ...node.props, label } }
    }
    case 'Markdown': {
      const text = redactText(node.props.text, opts)
      return text === node.props.text ? node : { ...node, props: { ...node.props, text } }
    }
    case 'Code': {
      const props = { ...node.props, source: redactText(node.props.source, opts) }
      if (node.props.path !== undefined) props.path = redactText(node.props.path, opts)
      return props.source === node.props.source && props.path === node.props.path ? node : { ...node, props }
    }
    case 'Svg': {
      const alt = redactText(node.props.alt, opts)
      return alt === node.props.alt ? node : { ...node, props: { ...node.props, alt } }
    }
    default:
      return node
  }
}

// ---------------------------------------------------------------------------
// Helpers on $

async function redactOptions($: EngineInterface, ctx: Ctx): Promise<RedactOptions> {
  const found = await read($, identity)
  return { categories: ctx.categories, names: [...ctx.extraNames, ...found] }
}

async function shouldRedact($: EngineInterface, ctx: Ctx): Promise<boolean> {
  const state = await read($, shield)
  ctx.wasRedacting = isRedacting(state, ctx.defaultMode)
  return ctx.wasRedacting
}

/** A `$.ui` call's text, masked while redacting. */
async function maskedText($: EngineInterface, ctx: Ctx, text: string | undefined): Promise<string | undefined> {
  if (text === undefined || !(await shouldRedact($, ctx))) return text
  return redactText(text, await redactOptions($, ctx))
}

async function showStatus($: EngineInterface, ctx: Ctx): Promise<void> {
  const state = await read($, shield)
  $.ui.status(isRedacting(state, ctx.defaultMode) ? STATUS_ON : STATUS_OFF)
}

/** The OS username (env, else `whoami`), the home folder's name, git user.name. */
async function lookUpIdentity($: EngineInterface, cwd: string): Promise<string[]> {
  const found: string[] = []
  const user = (await $.env.get('USER')) ?? (await $.env.get('LOGNAME'))
  const home = await $.env.get('HOME')
  if (user !== undefined) found.push(user)
  if (home !== undefined) {
    const base = home.replace(/\/+$/, '').split('/').pop()
    if (base !== undefined && base.length > 0) found.push(base)
  }
  if (user === undefined) {
    try {
      const who = await $.process.run(['whoami'], { timeoutMs: 3000 })
      if (who.exitCode === 0) found.push(who.stdout.trim())
    } catch {
      // No whoami: nothing to add.
    }
  }
  const names = found.filter(isMaskableUsername)
  try {
    const git = await $.process.run(['git', 'config', 'user.name'], { cwd, timeoutMs: 3000 })
    const name = git.stdout.trim()
    if (git.exitCode === 0 && name.length >= 2) names.push(name)
  } catch {
    // No git: nothing to add.
  }
  return [...new Set(names)]
}

/** `uname -s`, else a guess from the home folder's shape. */
async function detectPlatform($: EngineInterface): Promise<Platform> {
  try {
    const uname = await $.process.run(['uname', '-s'], { timeoutMs: 3000 })
    if (uname.exitCode === 0) return parsePlatform(uname.stdout)
  } catch {
    // Fall through to the guess.
  }
  return platformFromHome(await $.env.get('HOME'))
}

/** One look at the process list, in auto mode, until a recorder is seen. */
async function poll($: EngineInterface, ctx: Ctx): Promise<void> {
  if (ctx.isPolling) return
  const state = await read($, shield)
  if (effectiveMode(state, ctx.defaultMode) !== 'auto' || state.recorder !== null) return
  const argv = processListArgv(ctx.platform)
  if (argv === null) return
  ctx.isPolling = true
  try {
    const ps = await $.process.run(argv, { timeoutMs: PS_TIMEOUT_MS })
    ctx.pollFailures = 0
    const recorder = findRecorder(ps.stdout, ctx.platform)
    if (recorder === null) return
    let isNew = false
    await update($, shield, current => {
      if (effectiveMode(current, ctx.defaultMode) !== 'auto' || current.recorder !== null) return current
      isNew = true
      return { ...current, recorder }
    })
    if (isNew) {
      $.ui.toast(`${recorder} detected: masking personal data on screen. /redact off to stop.`, { timeoutMs: 6000 })
      await showStatus($, ctx)
    }
  } catch (error) {
    ctx.pollFailures += 1
    if (ctx.pollFailures >= MAX_POLL_FAILURES) {
      ctx.timer?.cancel()
      ctx.timer = undefined
      $.ui.log(`pii-shield: recorder detection stopped (${String(error)}). Use /redact on before recording.`, {
        to: 'debug',
      })
    }
  } finally {
    ctx.isPolling = false
  }
}

function startPolling($: EngineInterface, ctx: Ctx): void {
  ctx.timer?.cancel()
  ctx.timer = undefined
  ctx.pollFailures = 0
  if (processListArgv(ctx.platform) === null) return
  ctx.timer = $.clock.every(POLL_MS, () => {
    void poll($, ctx)
  })
}

/** The placeholder drawn in a row's place when redacting it failed. */
function failClosed($: EngineInterface, e: RenderInput) {
  const { Text } = $.ui.resolve(e)
  return <Text dimColor>{BLOCK} pii-shield hid this row (it could not be redacted)</Text>
}

/**
 * Runs async steps one after another, in the order they were queued. A step
 * that throws still lets the next one run.
 */
export function queue(): <T>(step: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve()
  return async step => {
    const before = tail
    let release = () => {}
    tail = new Promise<void>(resolve => {
      release = resolve
    })
    try {
      await before
      return await step()
    } finally {
      release()
    }
  }
}

const CARD_WIDTH = 56

/**
 * `/redact`'s answer as a compact card, Box and Text only so every surface
 * (the phone's included) draws it; null when the row is not a status answer.
 */
function statusCard($: EngineInterface, e: RenderInput<'CommandOutput'>) {
  if (e.props.isErrored) return null
  const status = parseStatus(e.props.text)
  if (status === null) return null
  const { Box, Text } = $.ui.resolve(e)
  const width = Math.max(20, Math.min(CARD_WIDTH, e.viewport?.columns ?? CARD_WIDTH))
  const labelWidth = Math.max(...status.fields.map(([label]) => label.length)) + 1
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={status.isOn ? 'error' : 'subtle'} paddingX={1} width={width}>
      <Text bold color={status.isOn ? 'error' : undefined}>
        {status.isOn ? STATUS_ON : STATUS_OFF}
      </Text>
      {status.fields.map(([label, value]) => (
        <Box flexDirection="row">
          <Text dimColor>{label.padEnd(labelWidth)}</Text>
          <Text wrap="wrap">{value}</Text>
        </Box>
      ))}
      <Text dimColor wrap="wrap">
        {e.surface === 'mobile' && !status.isOn
          ? 'Recording this phone? It is not detected: run /redact on.'
          : 'Display only: Claude and the transcript see real values.'}
      </Text>
    </Box>
  )
}

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    defaultMode: configMode(options),
    categories: configCategories(options),
    extraNames: configNames(options),
    wasRedacting: true,
    platform: 'other',
    pollFailures: 0,
    isPolling: false,
    timer: undefined,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Each step stands alone: one failing must not stop recorder detection.
    try {
      await $.command.register({
        name: 'redact',
        description: 'pii-shield: mask personal data on screen (on, off, auto, status)',
        argumentHint: 'on|off|auto|status',
      })
    } catch (error) {
      $.ui.log(`pii-shield: /redact could not be registered (${String(error)})`, { to: 'debug' })
    }
    try {
      const names = await lookUpIdentity($, e.cwd)
      await update($, identity, () => names)
    } catch (error) {
      $.ui.log(`pii-shield: could not look up your username (${String(error)})`, { to: 'debug' })
    }
    ctx.platform = await detectPlatform($)
    startPolling($, ctx)
    await showStatus($, ctx)
    void poll($, ctx)
    return started
  })

  on('command.run', { command: 'redact' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off' || arg === 'auto') {
      const mode: PiiShieldMode = arg
      await update($, shield, () => ({ override: mode, recorder: null }))
      if (arg === 'auto') {
        if (ctx.timer === undefined) startPolling($, ctx)
        await poll($, ctx)
      }
      await showStatus($, ctx)
      return { text: describe(ctx, await read($, shield)) }
    }
    if (arg === '' || arg === 'status') return { text: describe(ctx, await read($, shield)) }
    return { text: 'Usage: /redact on | off | auto | status' }
  })

  // ---- rows drawn from text -------------------------------------------------

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await shouldRedact($, ctx))) return next(e)
    const opts = await redactOptions($, ctx)
    return next({ ...e, props: { ...e.props, text: redactText(e.props.text, opts) } })
  }).catch(($, e, next) => (next.called || !ctx.wasRedacting ? next(e) : failClosed($, e)))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!(await shouldRedact($, ctx))) return next(e)
    const opts = await redactOptions($, ctx)
    return next({ ...e, props: { ...e.props, text: redactText(e.props.text, opts) } })
  }).catch(($, e, next) => (next.called || !ctx.wasRedacting ? next(e) : failClosed($, e)))

  // `/redact`'s own answer, as a compact card on every surface. Registered
  // before the masking hook below, so it sits outside it: its text holds no
  // personal data (a recorder's name at most).
  on('ui.render', { component: 'CommandOutput', props: { command: 'redact' } }, ($, e, next) => {
    return statusCard($, e) ?? next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (!(await shouldRedact($, ctx))) return next(e)
    const opts = await redactOptions($, ctx)
    return next({ ...e, props: { ...e.props, text: redactText(e.props.text, opts) } })
  }).catch(($, e, next) => (next.called || !ctx.wasRedacting ? next(e) : failClosed($, e)))

  // ---- rows drawn from tool data --------------------------------------------

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await shouldRedact($, ctx))) return next(e)
    const opts = await redactOptions($, ctx)
    const props = { ...e.props, input: redactDeep(e.props.input, opts) }
    if (e.props.output !== undefined) props.output = redactDeep(e.props.output, opts)
    return next({ ...e, props })
  }).catch(($, e, next) => (next.called || !ctx.wasRedacting ? next(e) : failClosed($, e)))

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await shouldRedact($, ctx))) return next(e)
    const opts = await redactOptions($, ctx)
    return next({ ...e, props: { ...e.props, output: redactDeep(e.props.output, opts) } })
  }).catch(($, e, next) => (next.called || !ctx.wasRedacting ? next(e) : failClosed($, e)))

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await shouldRedact($, ctx))) return next(e)
    const opts = await redactOptions($, ctx)
    const calls = e.props.calls.map(call => {
      const out = { ...call, input: redactDeep(call.input, opts) }
      if (call.output !== undefined) out.output = redactDeep(call.output, opts)
      return out
    })
    return next({ ...e, props: { ...e.props, calls } })
  }).catch(($, e, next) => (next.called || !ctx.wasRedacting ? next(e) : failClosed($, e)))

  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    if (!(await shouldRedact($, ctx))) return next(e)
    const opts = await redactOptions($, ctx)
    return next({ ...e, props: { ...e.props, questions: redactQuestions(e.props.questions, opts) } })
  }).catch(($, e, next) => (next.called || !ctx.wasRedacting ? next(e) : failClosed($, e)))

  // The turn's working line: on the desktop it names the step (`Creating
  // notes.md`), which can carry a path. Terminal and desktop only.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!(await shouldRedact($, ctx))) return next(e)
    const opts = await redactOptions($, ctx)
    const message = e.props.message === null ? null : redactText(e.props.message, opts)
    return next({ ...e, props: { ...e.props, word: redactText(e.props.word, opts), message } })
  }).catch(($, e, next) => (next.called || !ctx.wasRedacting ? next(e) : failClosed($, e)))

  // ---- trees other plugins draw ---------------------------------------------
  // A pane (every surface, the phone's included) and the band above the
  // prompt (terminal and desktop): the tree the hooks beneath drew, its text
  // masked. Only plugins whose hooks sit beneath this one in the chain are
  // reached. Here a failure after `next` must not fall back to `next(e)`: that
  // would replay the raw tree, so it fails closed whenever redaction may be on.

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (!(await shouldRedact($, ctx))) return next(e)
    const opts = await redactOptions($, ctx)
    return redactTree(await next(e), opts) as RenderElement
  }).catch(($, e, next) => (ctx.wasRedacting ? failClosed($, e) : next(e)))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await shouldRedact($, ctx))) return next(e)
    const opts = await redactOptions($, ctx)
    return redactTree(await next(e), opts) as RenderElement
  }).catch(($, e, next) => (ctx.wasRedacting ? failClosed($, e) : next(e)))

  // ---- text handed to $.ui by any plugin -------------------------------------
  // Toasts and status entries are drawn on every surface (the phone's status
  // list included). A failure while redaction may be on refuses the call.

  const DENIED = { deny: 'pii-shield could not redact this text' } as const

  // One queue for these calls: a caller's `status('x')` then `status(undefined)`
  // reach the status line in that order, though masking the first takes a
  // state read the second does not need. Each call is handed on (`next`) in
  // its turn; the queue never waits for what it settles to.
  const inOrder = queue()

  on('ui.toast', async ($, e, next) => {
    const { sent } = await inOrder(async () => ({ sent: next({ ...e, text: (await maskedText($, ctx, e.text)) ?? e.text }) }))
    return sent
  }).catch(($, e, next) => (ctx.wasRedacting && !next.called ? DENIED : next(e)))

  on('ui.status', async ($, e, next) => {
    const { sent } = await inOrder(async () => ({ sent: next({ ...e, text: await maskedText($, ctx, e.text) }) }))
    return sent
  }).catch(($, e, next) => (ctx.wasRedacting && !next.called ? DENIED : next(e)))

  on('ui.notice', async ($, e, next) => {
    const { sent } = await inOrder(async () => ({ sent: next({ ...e, text: await maskedText($, ctx, e.text) }) }))
    return sent
  }).catch(($, e, next) => (ctx.wasRedacting && !next.called ? DENIED : next(e)))

  // A line for the transcript; the debug log is a file, not the screen.
  on('ui.log', async ($, e, next) => {
    if (e.to !== 'transcript') return next(e)
    const { sent } = await inOrder(async () => ({ sent: next({ ...e, text: (await maskedText($, ctx, e.text)) ?? e.text }) }))
    return sent
  }).catch(($, e, next) => (ctx.wasRedacting && !next.called ? next({ ...e, to: 'debug' }) : next(e)))

  on('ui.open', async ($, e, next) => {
    if (e.title === undefined || !(await shouldRedact($, ctx))) return next(e)
    return next({ ...e, title: redactText(e.title, await redactOptions($, ctx)) })
  }).catch(($, e, next) => (ctx.wasRedacting && !next.called ? DENIED : next(e)))
}

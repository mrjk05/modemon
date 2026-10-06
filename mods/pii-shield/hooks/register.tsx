// pii-shield: masks personal data and secrets on screen while you record.
//
// Display only: every drawing hook here is a `ui.render` rewrite of the props
// a row is drawn from (`next({ ...e, props })`). What the model reads and what
// the transcript stores are never touched.
//
// Failure policy: FAIL CLOSED. If redacting a row throws or overruns its
// budget while redaction is (or may be) on, the row is replaced by a one-line
// placeholder instead of being drawn unredacted. While redaction is known to
// be off, a failure draws the engine's own row.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderInput } from 'claude-code'

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

function describe(ctx: Ctx, state: PiiShieldState): string {
  const mode = effectiveMode(state, ctx.defaultMode)
  const source = state.override === null ? 'from settings' : 'set by /redact'
  const isOn = isRedacting(state, ctx.defaultMode)
  const lines = [`pii-shield is ${isOn ? 'REDACTING' : 'not redacting'} (mode: ${mode}, ${source}).`]
  if (mode === 'auto') {
    if (state.recorder !== null) {
      lines.push(`Recorder seen this session: ${state.recorder} (stays on until /redact off).`)
    } else if (processListArgv(ctx.platform) === null) {
      lines.push('Recorder detection is not available on this platform; use /redact on.')
    } else if (ctx.timer === undefined) {
      lines.push('Recorder detection has stopped; use /redact on before recording.')
    } else {
      lines.push('Watching for screen recorders every 5s.')
    }
  }
  const enabled = CATEGORIES.filter(category => ctx.categories[category])
  lines.push(`Masking: ${enabled.length === 0 ? 'nothing' : enabled.join(', ')}.`)
  lines.push('Display only: Claude and the transcript still see the real values.')
  return lines.join('\n')
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
}

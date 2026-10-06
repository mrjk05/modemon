// Pure helpers for notify: no `$`, so every one is unit-testable.

export type Kind = 'input' | 'done' | 'error' | 'subagent' | 'test'
export type Platform = 'darwin' | 'linux' | 'other'
export type Backend = 'terminal-notifier' | 'osascript' | 'notify-send'

export type Note = {
  title: string
  body: string
  /** macOS sound name; '' for silent. */
  sound: string
  /** terminal-notifier group: a newer note of the same group replaces the older. */
  group: string
  /** Bundle id to bring forward when the note is clicked (terminal-notifier). */
  activate?: string
}

export type Config = {
  onNeedsInput: boolean
  onTurnDone: boolean
  minTurnSeconds: number
  onError: boolean
  onSubagentDone: boolean
  sound: string
  onlyWhenUnfocused: boolean
}

export const DEFAULTS: Config = {
  onNeedsInput: true,
  onTurnDone: true,
  minTurnSeconds: 30,
  onError: true,
  onSubagentDone: true,
  sound: 'Glass',
  onlyWhenUnfocused: true,
}

type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)

export function readConfig(options: Options | undefined): Config {
  const o = options ?? {}
  const min = o['minTurnSeconds']
  const sound = o['sound']
  return {
    onNeedsInput: bool(o['onNeedsInput'], DEFAULTS.onNeedsInput),
    onTurnDone: bool(o['onTurnDone'], DEFAULTS.onTurnDone),
    minTurnSeconds:
      typeof min === 'number' && Number.isFinite(min) && min >= 0 ? min : DEFAULTS.minTurnSeconds,
    onError: bool(o['onError'], DEFAULTS.onError),
    onSubagentDone: bool(o['onSubagentDone'], DEFAULTS.onSubagentDone),
    sound: typeof sound === 'string' ? sound.trim() : DEFAULTS.sound,
    onlyWhenUnfocused: bool(o['onlyWhenUnfocused'], DEFAULTS.onlyWhenUnfocused),
  }
}

/** `uname -s` output to a platform. */
export function platformFromUname(stdout: string): Platform {
  const s = stdout.trim().toLowerCase()
  if (s.startsWith('darwin')) return 'darwin'
  if (s.startsWith('linux')) return 'linux'
  return 'other'
}

/** The backends to try, in order, on a platform. */
export function backendsFor(platform: Platform): Backend[] {
  if (platform === 'darwin') return ['terminal-notifier', 'osascript']
  if (platform === 'linux') return ['notify-send']
  return []
}

/** One line of plain text: control characters and runs of whitespace become one space, cut to `max`. */
export function clean(text: string, max = 180): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/** Escapes text for the inside of an AppleScript "string literal". */
export function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Escapes the markup notify-send bodies are parsed as (most daemons read a subset of HTML). */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * terminal-notifier reads a value that starts with `-` or `[` as something
 * else; a zero-width space in front keeps it a plain value and draws nothing.
 */
function tnValue(text: string): string {
  return /^[-[]/.test(text) ? '​' + text : text
}

export function terminalNotifierArgv(n: Note): string[] {
  const argv = [
    'terminal-notifier',
    '-title', tnValue(clean(n.title, 80)),
    '-message', tnValue(clean(n.body) || ' '),
    '-group', n.group,
  ]
  if (n.sound !== '') argv.push('-sound', n.sound)
  if (n.activate !== undefined && n.activate !== '') argv.push('-activate', n.activate)
  return argv
}

export function appleScriptFor(n: Note): string {
  const body = escapeAppleScript(clean(n.body))
  const title = escapeAppleScript(clean(n.title, 80))
  let script = `display notification "${body}" with title "${title}"`
  if (n.sound !== '') script += ` sound name "${escapeAppleScript(n.sound)}"`
  return script
}

export function osascriptArgv(n: Note): string[] {
  return ['osascript', '-e', appleScriptFor(n)]
}

export function notifySendArgv(n: Note): string[] {
  return [
    'notify-send',
    '-a', 'Claude Code',
    '--',
    clean(n.title, 80),
    escapeMarkup(clean(n.body)),
  ]
}

export function argvFor(backend: Backend, n: Note): string[] {
  switch (backend) {
    case 'terminal-notifier':
      return terminalNotifierArgv(n)
    case 'osascript':
      return osascriptArgv(n)
    case 'notify-send':
      return notifySendArgv(n)
  }
}

/** TERM_PROGRAM values to the bundle id of the app that sets them. */
export const TERMINAL_BUNDLES: Readonly<Record<string, string>> = {
  Apple_Terminal: 'com.apple.Terminal',
  'iTerm.app': 'com.googlecode.iterm2',
  ghostty: 'com.mitchellh.ghostty',
  vscode: 'com.microsoft.VSCode',
  WezTerm: 'com.github.wez.wezterm',
}

/**
 * The bundle id of the app the session runs in: TERM_PROGRAM's when known,
 * else macOS's own `__CFBundleIdentifier` (set for apps started from the Dock).
 */
export function terminalBundle(
  termProgram: string | undefined,
  cfBundle: string | undefined,
): string | undefined {
  if (termProgram !== undefined) {
    const known = TERMINAL_BUNDLES[termProgram]
    if (known !== undefined) return known
  }
  const b = cfBundle?.trim()
  return b !== undefined && /^[A-Za-z0-9.-]+$/.test(b) ? b : undefined
}

/** The ASN `lsappinfo front` prints, if any. */
export function parseFrontAsn(stdout: string): string | undefined {
  const m = /ASN:[0-9a-fx-]+:?/i.exec(stdout)
  return m?.[0]
}

/** The bundle id in `lsappinfo info -only bundleid <asn>` output. */
export function parseBundleId(stdout: string): string | undefined {
  const m = /"CFBundleIdentifier"\s*=\s*"([^"]+)"/.exec(stdout)
  return m?.[1]
}

/** Last path segment of a directory. */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

export function titleFor(repoName: string | undefined): string {
  const name = repoName?.trim()
  return name ? `Claude Code · ${name}` : 'Claude Code'
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm ? `${h}h ${mm}m` : `${h}h`
}

/** First non-empty line of a text, flattened (markdown markers dropped). */
export function firstLine(text: string | undefined): string {
  if (text === undefined) return ''
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s#>*-]+/, '').replace(/[`*_]/g, '').trim()
    if (line !== '') return line
  }
  return ''
}

export function needsInputBody(notificationType: string, message: string): string {
  const m = message.trim()
  if (m !== '') return m
  if (notificationType === 'permission_prompt') return 'Claude needs your permission'
  if (notificationType === 'idle_prompt') return 'Claude is waiting for your input'
  return 'Claude needs your attention'
}

/** The classic Notification types that mean the person is needed. */
export function isNeedsInput(notificationType: string): boolean {
  return notificationType !== 'auth_success'
}

export function askBody(questions: readonly { question?: unknown }[] | undefined): string {
  const q = questions?.[0]?.question
  return typeof q === 'string' && q.trim() !== '' ? `Question: ${q.trim()}` : 'Claude has a question for you'
}

export function doneBody(durationMs: number, answer: string | undefined): string {
  const head = `Done in ${formatDuration(durationMs)}`
  const line = firstLine(answer)
  return line ? `${head}: ${line}` : head
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
  authentication_failed: 'authentication failed',
  oauth_org_not_allowed: 'organization not allowed',
  account_on_hold: 'account on hold',
  verification_required: 'verification required',
  billing_error: 'billing error',
  rate_limit: 'rate limited',
  overloaded: 'API overloaded',
  invalid_request: 'invalid request',
  model_not_found: 'model not found',
  server_error: 'API server error',
  max_output_tokens: 'hit the output token limit',
  cloud_credential_error: 'cloud credentials error',
  unknown: 'unknown error',
}

export function errorBody(error: string | undefined, details?: string): string {
  const what = (error !== undefined && ERROR_TEXT[error]) || error || 'the turn failed'
  const d = details?.trim()
  return d ? `Error: ${what} (${d})` : `Error: ${what}`
}

export function subagentBody(description: string | undefined, agentType: string | undefined): string {
  const d = description?.trim()
  if (d) return `Agent done: ${d}`
  const t = agentType?.trim()
  return t ? `Agent done: ${t}` : 'A subagent finished'
}

/** At most one notification per key per window. */
export class Throttle {
  private readonly last = new Map<string, number>()
  constructor(readonly windowMs = 5000) {}

  /** True (and records `now`) when `key` last passed more than the window ago. */
  allow(key: string, now: number): boolean {
    const prev = this.last.get(key)
    if (prev !== undefined && now - prev < this.windowMs) return false
    this.last.set(key, now)
    return true
  }

  reset(): void {
    this.last.clear()
  }
}

export type NotifyCommand = 'test' | 'on' | 'off' | 'status' | 'help'

export function parseCommand(args: string): NotifyCommand {
  const word = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (word === '' || word === 'status') return 'status'
  if (word === 'test' || word === 'on' || word === 'off') return word
  return 'help'
}

export const HELP = 'Usage: /notify [test | on | off | status]'

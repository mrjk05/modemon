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
  /** ntfy topic to push to; '' is off. */
  ntfyTopic: string
  /** ntfy server base URL. */
  ntfyServer: string
  /** Skip the phone push while you are evidently at the computer (terminal frontmost). */
  ntfyOnlyWhenAway: boolean
}

export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh'

export const DEFAULTS: Config = {
  onNeedsInput: true,
  onTurnDone: true,
  minTurnSeconds: 30,
  onError: true,
  onSubagentDone: true,
  sound: 'Glass',
  onlyWhenUnfocused: true,
  ntfyTopic: '',
  ntfyServer: DEFAULT_NTFY_SERVER,
  ntfyOnlyWhenAway: true,
}

type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)

export function readConfig(options: Options | undefined): Config {
  const o = options ?? {}
  const min = o['minTurnSeconds']
  const sound = o['sound']
  const topic = o['ntfyTopic']
  const server = o['ntfyServer']
  return {
    onNeedsInput: bool(o['onNeedsInput'], DEFAULTS.onNeedsInput),
    onTurnDone: bool(o['onTurnDone'], DEFAULTS.onTurnDone),
    minTurnSeconds:
      typeof min === 'number' && Number.isFinite(min) && min >= 0 ? min : DEFAULTS.minTurnSeconds,
    onError: bool(o['onError'], DEFAULTS.onError),
    onSubagentDone: bool(o['onSubagentDone'], DEFAULTS.onSubagentDone),
    sound: typeof sound === 'string' ? sound.trim() : DEFAULTS.sound,
    onlyWhenUnfocused: bool(o['onlyWhenUnfocused'], DEFAULTS.onlyWhenUnfocused),
    ntfyTopic: typeof topic === 'string' ? topic.trim() : DEFAULTS.ntfyTopic,
    ntfyServer:
      typeof server === 'string' && server.trim() !== '' ? server.trim() : DEFAULTS.ntfyServer,
    ntfyOnlyWhenAway: bool(o['ntfyOnlyWhenAway'], DEFAULTS.ntfyOnlyWhenAway),
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

// --- ntfy (phone push) ------------------------------------------------------

/** ntfy's own topic rule: 1 to 64 of letters, digits, `-` and `_`. */
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/
/** An http(s) origin with an optional path (a self-hosted server under a prefix). */
const SERVER = /^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i

/** Topics shorter than this are flagged as guessable in `/notify status`. */
export const SHORT_TOPIC = 20

export type NtfyTarget = { url: string; server: string; topic: string } | { error: string }

/** The URL a notification is POSTed to, or why the config cannot make one. */
export function ntfyTarget(server: string, topic: string): NtfyTarget {
  const t = topic.trim()
  if (t === '') return { error: 'off (no ntfyTopic set)' }
  if (!TOPIC.test(t)) return { error: 'ntfyTopic must be 1-64 letters, digits, - or _' }
  const s = (server.trim() || DEFAULT_NTFY_SERVER).replace(/\/+$/, '')
  if (!SERVER.test(s)) return { error: `ntfyServer is not an http(s) URL: ${clean(s, 80)}` }
  return { url: `${s}/${t}`, server: s, topic: t }
}

/** `abcdefghij…` → `ab••••ij`: enough to recognise, not enough to subscribe. */
export function maskTopic(topic: string): string {
  const t = topic.trim()
  if (t.length < 8) return '•'.repeat(Math.max(4, t.length))
  return `${t.slice(0, 2)}••••${t.slice(-2)}`
}

export type NtfyPriority = 'high' | 'default'

export function ntfyPriority(kind: Kind): NtfyPriority {
  return kind === 'input' || kind === 'error' ? 'high' : 'default'
}

/** ntfy emoji short codes (drawn as emoji in the app) per kind. */
export const NTFY_TAGS: Readonly<Record<Kind, readonly string[]>> = {
  input: ['question'],
  done: ['white_check_mark'],
  error: ['warning'],
  subagent: ['robot'],
  test: ['bell'],
}

function utf8(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0xfffd
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: readonly number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += b === undefined ? '=' : B64[(n >> 6) & 63]
    out += c === undefined ? '=' : B64[n & 63]
  }
  return out
}

/** Longest UTF-8 run per encoded word: 45 bytes is 60 base64 chars, 72 with the wrapper (RFC 2047 caps a word at 75). */
const WORD_BYTES = 45

/**
 * A header value safe to send: printable ASCII as is, anything else as RFC 2047
 * `=?UTF-8?B?…?=` encoded words (split on character boundaries, space
 * separated), which ntfy decodes. Control characters are flattened first, so
 * no value can smuggle a CR/LF into the request.
 */
export function headerValue(text: string, max = 80): string {
  const v = clean(text, max)
  if (/^[\x20-\x7e]*$/.test(v) && !v.includes('=?')) return v
  const words: string[] = []
  let run: number[] = []
  for (const ch of v) {
    const bytes = utf8(ch)
    if (run.length + bytes.length > WORD_BYTES) {
      words.push(`=?UTF-8?B?${base64(run)}?=`)
      run = []
    }
    run.push(...bytes)
  }
  if (run.length > 0) words.push(`=?UTF-8?B?${base64(run)}?=`)
  return words.join(' ')
}

export type NtfyRequest = {
  url: string
  init: { method: 'POST'; headers: Record<string, string>; body: string }
}

/** The POST that publishes `note` to the ntfy topic at `url`. */
export function ntfyRequest(url: string, kind: Kind, note: Pick<Note, 'title' | 'body'>): NtfyRequest {
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        Title: headerValue(note.title, 80),
        Priority: ntfyPriority(kind),
        Tags: NTFY_TAGS[kind].join(','),
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: clean(note.body, 1000) || ' ',
    },
  }
}

/**
 * Whether the phone push goes out, given what the desktop side did.
 * With `onlyWhenAway`, it is skipped only while the terminal is the frontmost
 * app (proof that you are at the computer, readable on macOS alone) and the
 * desktop side did not fail. Anywhere focus cannot be read (Linux, a cloud
 * container, an unknown terminal) or no desktop notifier exists, it always goes.
 */
export function shouldPush(
  onlyWhenAway: boolean,
  isFocused: boolean,
  desktop: 'sent' | 'skipped' | 'failed',
): boolean {
  if (!onlyWhenAway) return true
  return !(isFocused && desktop !== 'failed')
}

export type StatusInfo = {
  isMuted: boolean
  platform: Platform
  backend: Backend | undefined
  lastError: string | undefined
  /** Where focus is read from, or why it is not (only shown with onlyWhenUnfocused). */
  focus: string
  lastNtfy: string | undefined
  config: Config
}

const yesNo = (b: boolean): string => (b ? 'on' : 'off')

/**
 * `/notify status` as Markdown: a headline, then one short bullet per fact,
 * which reads the same in a terminal row, the desktop and the phone.
 */
export function statusMarkdown(s: StatusInfo): string {
  const c = s.config
  const tries = backendsFor(s.platform)
  const ntfy = ntfyTarget(c.ntfyServer, c.ntfyTopic)
  const lines = [
    `**notify** · ${s.isMuted ? 'muted for this session' : 'on'}`,
    '',
    `- **Desktop:** ${s.platform}, backend: ${
      s.backend ?? (tries.length > 0 ? `not chosen yet (tries ${tries.join(', ')})` : 'none on this host')
    }`,
  ]
  if (s.lastError !== undefined) lines.push(`- **Last desktop failure:** ${clean(s.lastError, 200)}`)
  if ('error' in ntfy) {
    lines.push(`- **Phone (ntfy):** ${ntfy.error}`)
  } else {
    const short = ntfy.topic.length < SHORT_TOPIC ? ' (short topic: easy to guess, use a longer random one)' : ''
    lines.push(
      `- **Phone (ntfy):** \`${ntfy.server}/${maskTopic(ntfy.topic)}\`${short}`,
      `- **Phone only when away:** ${yesNo(c.ntfyOnlyWhenAway)}`,
    )
    if (s.lastNtfy !== undefined) lines.push(`- **Last push:** ${clean(s.lastNtfy, 200)}`)
  }
  lines.push(
    `- **Triggers:** needs input ${yesNo(c.onNeedsInput)} · turn done (> ${c.minTurnSeconds}s) ${yesNo(
      c.onTurnDone,
    )} · errors ${yesNo(c.onError)} · subagents ${yesNo(c.onSubagentDone)}`,
    `- **Sound:** ${c.sound || '(none)'} · **only when unfocused:** ${yesNo(c.onlyWhenUnfocused)}${
      c.onlyWhenUnfocused ? ` (${s.focus})` : ''
    }`,
  )
  return lines.join('\n')
}

/** True for the text `statusMarkdown` builds (its headline). */
export function isStatusText(text: string): boolean {
  return text.startsWith('**notify** · ')
}

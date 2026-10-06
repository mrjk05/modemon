// Pure helpers for the casual mod: the style prompt, /casual's argument
// parsing and the one-line summaries of tool rows. Nothing here touches `$`.

import type { CasualPrefs, CasualVerbosity } from '../types'

export const SECTION_ID = 'casual:style'
export const STORE_KEY = 'prefs'
export const STATUS_TEXT = '☺ casual'

/** Tools whose rows the person has to read or answer: never folded. */
const KEEP_WHOLE = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'TodoWrite',
  'SendUserMessage',
  'SendUserFile',
])

const SHARED_RULES = [
  'Lead with the outcome: what you did, what you found, or what you need from them. Skip preamble, restating the question, and step-by-step recaps of your work.',
  'Write prose in plain words. No headers, bullet walls or tables unless the person asks for them or a list is genuinely clearer (say, commands they must run in order, or several separate findings).',
  "Don't narrate before tool calls. At most one short line on what you're about to do, and often nothing.",
  'Stay exact. File paths, commands, flags, numbers, versions and error messages are written precisely, in backticks. Casual never means vague.',
  "Never hide or soften a failure. If something broke, a test failed, or you couldn't finish or verify something, say so plainly and early.",
  'Short never overrides safety. Still ask before destructive or irreversible actions, and still mention real caveats, risks and anything the person has to do next, one clear sentence each.',
  'This is how you talk to the person, not how you work: be as thorough as ever in the work itself. When you write for something other than this chat (a subagent report, a commit message, a PR description, code comments, a document or file you were asked to write), follow that context\'s own conventions instead.',
  'If the person asks for more detail, a different format, or a full write-up, do what they ask; their request wins over this style.',
]

/** The system-prompt section casual mode appends, for one verbosity. */
export function stylePrompt(verbosity: CasualVerbosity): string {
  const opening =
    verbosity === 'brief'
      ? [
          '# Reply style: casual, brief',
          'Talk to the person like a senior teammate on Slack who is busy but helpful: short, direct and plain.',
          'Default to 1 or 2 short sentences. No greetings, small talk or sign-offs: just the outcome and what matters. Go longer only when the person asks or the content truly needs it (a plan they must approve, a code snippet, several distinct findings).',
        ]
      : [
          '# Reply style: casual',
          'Talk to the person like a friendly senior teammate on Slack: "hey, so here\'s where we\'re at". Warm, relaxed and to the point; contractions are fine, corporate filler and hype are not, and no emoji unless they use them.',
          'Default to 1 to 4 short sentences. Go longer only when the person asks or the content truly needs it (a plan they must approve, a code snippet, several distinct findings).',
        ]
  const example =
    verbosity === 'brief'
      ? 'Example: "Fixed: the expiry check in `src/auth.ts` was inverted. `npm test` passes, 48/48."'
      : 'Example: instead of a "## Summary" header and five bullets, write "Fixed it: the expiry check in `src/auth.ts` was inverted, so expired tokens got through. `npm test` passes now (48/48). Want me to add a regression test too?"'
  return [...opening, '', ...SHARED_RULES.map(rule => `- ${rule}`), '', example].join('\n')
}

/** Appends the casual section (as `session`), replacing an earlier copy of it. */
export function withSection<S extends { id: string; text: string; scope: 'shared' | 'session' }>(
  sections: readonly S[],
  text: string,
): Array<S | { id: string; text: string; scope: 'session' }> {
  return [...sections.filter(s => s.id !== SECTION_ID), { id: SECTION_ID, text, scope: 'session' }]
}

export type CasualAction =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'verbosity'; verbosity: CasualVerbosity }
  | { kind: 'status' }
  | { kind: 'usage'; arg: string }

/** Reads `/casual`'s arguments; nothing at all means `status`. */
export function parseArgs(args: string): CasualAction {
  const arg = args.trim().toLowerCase()
  switch (arg) {
    case 'on':
      return { kind: 'on' }
    case 'off':
      return { kind: 'off' }
    case 'brief':
    case 'chill':
      return { kind: 'verbosity', verbosity: arg }
    case '':
    case 'status':
      return { kind: 'status' }
    default:
      return { kind: 'usage', arg }
  }
}

/** Applies an action to the prefs; `status` and `usage` leave them as they are. */
export function applyAction(prefs: CasualPrefs, action: CasualAction): CasualPrefs {
  switch (action.kind) {
    case 'on':
      return { ...prefs, isOn: true }
    case 'off':
      return { ...prefs, isOn: false }
    case 'verbosity':
      return { isOn: true, verbosity: action.verbosity }
    default:
      return prefs
  }
}

export function isVerbosity(value: unknown): value is CasualVerbosity {
  return value === 'chill' || value === 'brief'
}

/** A stored value read back, or the default (on) when it is missing or malformed. */
export function toPrefs(value: unknown): CasualPrefs {
  if (typeof value !== 'object' || value === null) return { isOn: true }
  const record = value as Record<string, unknown>
  const isOn = typeof record.isOn === 'boolean' ? record.isOn : true
  return isVerbosity(record.verbosity) ? { isOn, verbosity: record.verbosity } : { isOn }
}

export function effectiveVerbosity(prefs: CasualPrefs, fallback: unknown): CasualVerbosity {
  return prefs.verbosity ?? (isVerbosity(fallback) ? fallback : 'chill')
}

export function describePrefs(prefs: CasualPrefs, verbosity: CasualVerbosity, collapse: boolean): string {
  if (!prefs.isOn) return 'casual is off. Replies use the default style. `/casual on` turns it back on.'
  const folding = collapse ? 'tool rows folded' : 'tool rows left as they are'
  return `casual is on (${verbosity}, ${folding}). \`/casual off\` turns it off.`
}

export const USAGE = 'Usage: `/casual on|off|brief|chill|status`.'

export function shouldFold(tool: string): boolean {
  return !KEEP_WHOLE.has(tool)
}

/** Text cut to `max` characters, an ellipsis at the end when cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return max <= 1 ? '…'.slice(0, max) : `${text.slice(0, max - 1)}…`
}

/** Text cut to `max` characters from the start (`…/src/auth.ts`), for paths. */
export function clipStart(text: string, max: number): string {
  if (text.length <= max) return text
  return max <= 1 ? '…'.slice(0, max) : `…${text.slice(text.length - (max - 1))}`
}

/** The first non-empty line of a text, cut to `max` characters. */
export function firstLine(text: string, max = 80): string {
  return clip(text.split('\n').find(l => l.trim() !== '')?.trim() ?? '', max)
}

/** Columns used when a surface has not measured itself. */
export const DEFAULT_COLUMNS = 100

/** The width a row may use: the viewport's, never below 20 cells. */
export function columnsOf(viewport: { columns: number } | undefined): number {
  const columns = viewport?.columns
  return typeof columns === 'number' && Number.isFinite(columns) ? Math.max(20, Math.floor(columns)) : DEFAULT_COLUMNS
}

function field(input: unknown, name: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function lineCount(text: string): number {
  const trimmed = text.replace(/\n+$/, '')
  return trimmed === '' ? 0 : trimmed.split('\n').length
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

const PATH_FIELDS = new Set(['file_path', 'notebook_path', 'path'])
const NAMED_FIELDS = ['command', 'file_path', 'notebook_path', 'path', 'url', 'query', 'description', 'skill']

/** What the call was about, uncut: its first line, and whether it is a path. */
export function rawTarget(input: unknown): { text: string; isPath: boolean } {
  const pattern = field(input, 'pattern')
  if (pattern !== undefined) return { text: `"${firstLine(pattern, 1_000)}"`, isPath: false }
  for (const name of NAMED_FIELDS) {
    const value = field(input, name)
    if (value !== undefined) return { text: firstLine(value, 1_000), isPath: PATH_FIELDS.has(name) }
  }
  if (typeof input === 'object' && input !== null) {
    const first = Object.values(input).find((v): v is string => typeof v === 'string' && v !== '')
    if (first !== undefined) return { text: firstLine(first, 1_000), isPath: false }
  }
  return { text: '', isPath: false }
}

/** Cuts a target to `max`: a path keeps its end (`…/src/auth.ts`), anything else its start. */
export function clipTarget(target: { text: string; isPath: boolean }, max: number): string {
  return target.isPath ? clipStart(target.text, max) : clip(target.text, max)
}

/** What the call was about, in a few words: `npm test`, `src/a.ts`, `"TODO"`. */
export function callTarget(input: unknown): string {
  const target = rawTarget(input)
  return clipTarget(target, target.text.startsWith('"') ? 50 : 70)
}

/** A few words on how the call came out, from its stored result; '' when unknown. */
export function outcome(output: unknown): string {
  if (typeof output === 'string') return output.trim() === '' ? 'no output' : plural(lineCount(output), 'line')
  if (typeof output !== 'object' || output === null) return ''
  const o = output as Record<string, unknown>
  if (typeof o.stdout === 'string') {
    const text = `${o.stdout}${typeof o.stderr === 'string' && o.stderr !== '' ? `\n${o.stderr}` : ''}`
    if (typeof o.backgroundTaskId === 'string') return 'in background'
    return text.trim() === '' ? 'no output' : plural(lineCount(text), 'line')
  }
  if (Array.isArray(o.structuredPatch)) {
    let added = 0
    let removed = 0
    for (const hunk of o.structuredPatch as unknown[]) {
      const lines = (hunk as { lines?: unknown }).lines
      if (!Array.isArray(lines)) continue
      for (const line of lines) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) added += 1
        else if (line.startsWith('-')) removed += 1
      }
    }
    return `+${added} −${removed}`
  }
  if (typeof o.file === 'object' && o.file !== null) {
    const numLines = (o.file as Record<string, unknown>).numLines
    if (typeof numLines === 'number') return plural(numLines, 'line')
  }
  if (typeof o.numFiles === 'number') {
    if (typeof o.numMatches === 'number') return plural(o.numMatches, 'match')
    if (typeof o.numLines === 'number' && o.numLines > 0) return plural(o.numLines, 'line')
    return plural(o.numFiles, 'file')
  }
  return ''
}

/** The text of an errored call, as the model read it, on one line. */
export function errorText(output: unknown): string {
  if (typeof output === 'string') return firstLine(output.replace(/<\/?tool_use_error>/g, ''), 100)
  if (typeof output === 'object' && output !== null) {
    const stderr = field(output, 'stderr')
    if (stderr !== undefined) return firstLine(stderr, 100)
    const stdout = field(output, 'stdout')
    if (stdout !== undefined) return firstLine(stdout, 100)
  }
  return 'failed'
}

export type CallLike = {
  tool: string
  input: unknown
  isRunning: boolean
  isErrored: boolean
  isInterrupted: boolean
  output?: unknown
}

/** The one-liner of a finished tool call: `Bash npm test · 12 lines`. */
export function callLine(call: CallLike): string {
  const target = callTarget(call.input)
  const head = target === '' ? call.tool : `${call.tool} ${target}`
  if (call.isInterrupted) return `${head} · interrupted`
  if (call.isErrored) return head
  const tail = outcome(call.output)
  return tail === '' ? head : `${head} · ${tail}`
}

/** `Read ×2, Grep, Edit`, in the order each tool first appears. */
export function toolTally(tools: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  return [...counts].map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool)).join(', ')
}

/** The ToolGroup one-liner: `ran 4 tools (Read ×2, Grep, Edit)`. */
export function groupLine(calls: readonly CallLike[]): string {
  const running = calls.some(c => c.isRunning)
  const verb = running ? 'running' : 'ran'
  return `${verb} ${plural(calls.length, 'tool')} (${toolTally(calls.map(c => c.tool))})${running ? '…' : ''}`
}

/** The red tail of a group with failed calls: `1 failed: Grep "foo"`. */
export function groupErrors(calls: readonly CallLike[]): string | undefined {
  const failed = calls.filter(c => c.isErrored && !c.isInterrupted)
  if (failed.length === 0) return undefined
  const named = failed.slice(0, 2).map(c => {
    const target = callTarget(c.input)
    return target === '' ? c.tool : `${c.tool} ${firstLine(target, 40)}`
  })
  const more = failed.length > 2 ? `, +${failed.length - 2} more` : ''
  return `${failed.length} failed: ${named.join(', ')}${more}`
}

/**
 * `callLine` sized to `width` cells. The target gives way first (a path keeps
 * its file name), then the outcome; the tool's name is always kept.
 */
export function fitCallLine(call: CallLike, width: number): string {
  const full = callLine(call)
  if (full.length <= width) return full
  const target = rawTarget(call.input)
  const tail = call.isInterrupted ? 'interrupted' : call.isErrored ? '' : outcome(call.output)
  const tailText = tail === '' ? '' : ` · ${tail}`
  for (const withTail of [tailText, '']) {
    const room = width - call.tool.length - 1 - withTail.length
    if (target.text !== '' && room >= 8) return `${call.tool} ${clipTarget(target, room)}${withTail}`
  }
  return clip(target.text === '' ? `${call.tool}${tailText}` : `${call.tool} ${target.text}`, width)
}

/**
 * `groupLine` sized to `width` cells: the tally loses tools from its end
 * (`ran 9 tools (Read ×4, Grep, …)`), then goes; the count is always kept.
 */
export function fitGroupLine(calls: readonly CallLike[], width: number): string {
  const full = groupLine(calls)
  if (full.length <= width) return full
  const running = calls.some(c => c.isRunning)
  const head = `${running ? 'running' : 'ran'} ${plural(calls.length, 'tool')}`
  const dots = running ? '…' : ''
  const parts = toolTally(calls.map(c => c.tool)).split(', ')
  for (let keep = parts.length - 1; keep >= 1; keep -= 1) {
    const line = `${head} (${parts.slice(0, keep).join(', ')}, …)${dots}`
    if (line.length <= width) return line
  }
  return clip(`${head}${dots}`, width)
}

/** What a `/casual` answer row says, read back from `describePrefs`'s text. */
export type DescribedPrefs = { isOn: false } | { isOn: true; verbosity: CasualVerbosity; isFolding: boolean }

/** Reads `describePrefs`'s text back; undefined for anything else (usage, errors). */
export function parseDescribed(text: string): DescribedPrefs | undefined {
  if (text.startsWith('casual is off.')) return { isOn: false }
  const on = /^casual is on \((chill|brief), (tool rows folded|tool rows left as they are)\)\./.exec(text)
  if (on === null || !isVerbosity(on[1])) return undefined
  return { isOn: true, verbosity: on[1], isFolding: on[2] === 'tool rows folded' }
}

/** The `/casual` card's rows: label, value, hint; each short enough for a phone. */
export function cardRows(state: DescribedPrefs): { rows: Array<[string, string]>; hint: string } {
  if (!state.isOn) return { rows: [['style', 'default']], hint: '/casual on to turn it back on' }
  return {
    rows: [
      ['style', state.verbosity === 'brief' ? 'brief · 1-2 sentences' : 'chill · 1-4 sentences'],
      ['tools', state.isFolding ? 'folded' : 'shown in full'],
    ],
    hint: '/casual off · brief · chill',
  }
}

// Pure helpers for question-log: the question detector, AskUserQuestion
// answer formatting, and small text utilities. No `$`, so unit-testable.

import type { QuestionLogEntry, QuestionLogQuestion } from '../types'

export type Detection = { isQuestion: boolean; questions: string[] }

const MAX_QUESTIONS = 4
const MAX_QUESTION_CHARS = 300

/** Trailing sentences after the last question that still leave it a question ("Let me know."). */
const CLOSER =
  /^(let me know|thanks|thank you|happy to|i can|i'?ll|either way|just say|no rush|cheers|or (?:i|we) can)\b/i

/** What stands in for a code block, a block quote or a table. */
const PLACEHOLDER = '[omitted]'

/** Lines that are list items: `- x`, `* x`, `+ x`, `1. x`, `1) x`. */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/

/** A quotation with its words kept: a mark that ended it ends the sentence outside, as a full stop. */
function quote(open: string, quoted: string, close: string): string {
  return `${open}${unpunctuate(quoted)}${close}${/[.!?]\s*$/.test(quoted) ? '.' : ''}`
}

/**
 * Removes what must never count as the reply asking: fenced code blocks,
 * block quotes, tables, inline code, quoted text, links' targets and URLs.
 */
export function stripNonProse(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      if (opener !== null && opener[1] !== undefined && opener[1][0] === fence[0] && opener[1].length >= fence.length) {
        fence = null
      }
      continue
    }
    if (opener !== null && opener[1] !== undefined) {
      // A placeholder line, so a reply ending on code or a quote ends on no question.
      fence = opener[1]
      kept.push(PLACEHOLDER)
      continue
    }
    if (/^\s*>/.test(line) || /^\s*\|/.test(line)) {
      if (kept[kept.length - 1] !== PLACEHOLDER) kept.push(PLACEHOLDER)
      continue
    }
    kept.push(line)
  }
  return kept
    .join('\n')
    .replace(/`([^`\n]*)`/g, (_, code: string) => unpunctuate(code))
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/"([^"\n]*)"/g, (_, quoted: string) => quote('"', quoted, '"'))
    .replace(/\u201c([^\u201d\n]*)\u201d/g, (_, quoted: string) => quote('\u201c', quoted, '\u201d'))
    .replace(/(^|[\s(])'([^'\n]{2,})'(?=[\s.,;:!?)]|$)/g, (_, lead: string, quoted: string) => lead + quote("'", quoted, "'"))
}

/** Quoted or code text keeps its words but loses the marks that end a sentence. */
function unpunctuate(text: string): string {
  return text.replace(/[?!.]+/g, '')
}

/** Splits text into paragraphs (blank-line separated), each trimmed, empties dropped. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
}

function isHeadingLine(line: string): boolean {
  const t = line.trim()
  if (/^#{1,6}\s/.test(t)) return true
  // A line that is nothing but bold or italic text reads as a heading.
  return /^(\*\*|__)[^*_]+(\*\*|__):?$/.test(t)
}

function cleanSentence(s: string): string {
  return s
    .replace(LIST_ITEM, '')
    .replace(/[*_]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Splits prose into sentences on `.`, `!` or `?` followed by space, keeping the mark. */
export function sentences(text: string): string[] {
  const out: string[] = []
  const re = /[^.!?]*(?:[.!?]+["')\]*_]*|$)/g
  for (const m of text.matchAll(re)) {
    const s = m[0].trim()
    if (s.length > 0) out.push(s)
  }
  return out
}

function isQuestionSentence(s: string): boolean {
  return /\?["')\]*_]*$/.test(s.trim())
}

/**
 * The block of the reply the detector reads: its final paragraph, or, when
 * that is a list, the list together with the paragraph that introduces it.
 * Headings close no block: a reply ending on a heading asks nothing.
 */
function finalBlock(prose: string): string[] | null {
  const paras = paragraphs(prose)
  const last = paras[paras.length - 1]
  if (last === undefined) return null
  const lastLines = last.split('\n').filter(l => l.trim().length > 0)
  if (lastLines.length > 0 && lastLines.every(isHeadingLine)) return null
  const isList = lastLines.length > 0 && lastLines.every(l => LIST_ITEM.test(l) || /^\s{2,}\S/.test(l))
  const block = [...lastLines]
  if (isList) {
    const intro = paras[paras.length - 2]
    if (intro !== undefined) {
      const introLines = intro.split('\n').filter(l => l.trim().length > 0 && !isHeadingLine(l))
      block.unshift(...introLines)
    }
  }
  return block.filter(l => !isHeadingLine(l))
}

/**
 * Whether an assistant reply's final paragraph asks the user something, and
 * the question sentence(s) it asks.
 *
 * Only the end of the reply counts (a rhetorical "Why does this fail?" mid
 * reply or as a heading is ignored); code fences, block quotes, inline code
 * and quoted text never count; the reply must end on the question, or on a
 * short closer after it ("Let me know."), and a list of questions at the end
 * counts with its introduction.
 */
export function detectQuestion(text: string): Detection {
  const none: Detection = { isQuestion: false, questions: [] }
  const block = finalBlock(stripNonProse(text))
  if (block === null || block.length === 0) return none

  const found: string[] = []
  let lastIsQuestion = false
  let trailing: string[] = []
  for (const line of block) {
    const parts = sentences(cleanSentence(line))
    for (const part of parts) {
      if (isQuestionSentence(part)) {
        found.push(part)
        trailing = []
        lastIsQuestion = true
      } else {
        trailing.push(part)
        lastIsQuestion = false
      }
    }
  }
  if (found.length === 0) return none

  if (!lastIsQuestion) {
    const lastQuestionIndex = block.findIndex(l => sentences(cleanSentence(l)).some(isQuestionSentence))
    const after = block.slice(lastQuestionIndex + 1)
    const afterIsOptions = after.length > 0 && after.every(l => LIST_ITEM.test(l))
    const isCloser = trailing.length <= 2 && trailing.every(s => CLOSER.test(s) || s.length <= 3)
    const questionIntroducesOptions = afterIsOptions && after.length <= 8
    if (!isCloser && !questionIntroducesOptions) return none
  }

  const questions = found
    .map(q => (q.length > MAX_QUESTION_CHARS ? `${q.slice(0, MAX_QUESTION_CHARS - 1)}…` : q))
    .slice(-MAX_QUESTIONS)
  return { isQuestion: true, questions }
}

/** Collapses whitespace and trims, so two drawings of one text compare equal. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** FNV-1a over the normalized text, as 8 hex digits: a cheap key for a reply's text. */
export function textHash(text: string): string {
  const s = normalize(text)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** The first `max` characters of a reply, on one line, with an ellipsis when cut. */
export function snippet(text: string, max = 200): string {
  const s = normalize(text)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** The shape of one AskUserQuestion question this module reads. */
export type AskQuestionInput = {
  question: string
  header?: string
  options?: ReadonlyArray<{ label: string }>
  multiSelect?: boolean
}

/** AskUserQuestion's questions as log questions. */
export function askQuestions(input: ReadonlyArray<AskQuestionInput>): QuestionLogQuestion[] {
  return input.map(q => {
    const out: QuestionLogQuestion = { text: q.question }
    if (q.header !== undefined && q.header.length > 0) out.header = q.header
    const labels = (q.options ?? []).map(o => o.label)
    if (labels.length > 0) out.options = labels
    return out
  })
}

/**
 * One question's answer as the log shows it: the chosen label, the chosen
 * labels of a multi-select joined by ", ", and text typed under "Other" as
 * `Other: "..."`.
 */
export function formatOneAnswer(raw: string, labels: readonly string[], isMulti: boolean): string {
  const value = raw.trim()
  if (value.length === 0) return '(no answer)'
  if (labels.includes(value)) return value
  if (!isMulti) return `Other: "${value}"`
  const tokens = value.split(/,\s*/)
  const chosen: string[] = []
  const rest: string[] = []
  for (const token of tokens) {
    if (labels.includes(token.trim())) chosen.push(token.trim())
    else rest.push(token)
  }
  const other = rest.join(', ').trim()
  if (other.length > 0) chosen.push(`Other: "${other}"`)
  return chosen.join(', ')
}

/**
 * The answer string of an AskUserQuestion call from its result's `answers`
 * (question text to answer) and `response` (free text typed instead).
 */
export function formatAskAnswer(
  questions: ReadonlyArray<AskQuestionInput>,
  answers: Readonly<Record<string, unknown>> | undefined,
  response?: string,
): string {
  const parts: string[] = []
  for (const q of questions) {
    const raw = answers?.[q.question]
    const labels = (q.options ?? []).map(o => o.label)
    const formatted =
      typeof raw === 'string'
        ? formatOneAnswer(raw, labels, q.multiSelect === true)
        : Array.isArray(raw)
          ? formatOneAnswer(raw.filter(x => typeof x === 'string').join(', '), labels, true)
          : '(no answer)'
    parts.push(questions.length > 1 ? `${q.header || q.question}: ${formatted}` : formatted)
  }
  const anyAnswered = parts.some(p => !p.endsWith('(no answer)'))
  if (!anyAnswered && response !== undefined && response.trim().length > 0) {
    return `Other: "${snippet(response)}"`
  }
  return parts.join('; ')
}

/** "just now", "42s ago", "5m ago", "3h ago", "2d ago". */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** How many entries still wait for an answer. */
export function openCount(log: readonly QuestionLogEntry[]): number {
  return log.filter(entry => entry.answer === undefined).length
}

/** The status line text: `? N open`, or undefined (cleared) at none. */
export function statusText(log: readonly QuestionLogEntry[]): string | undefined {
  const n = openCount(log)
  return n > 0 ? `? ${n} open` : undefined
}

/** Marks every open detected question answered by a prompt's text. */
export function answerDetected(
  log: readonly QuestionLogEntry[],
  promptText: string,
  now: number,
): QuestionLogEntry[] {
  const answer = snippet(promptText, 200)
  return log.map(entry =>
    entry.kind === 'detected' && entry.answer === undefined ? { ...entry, answer, answeredAt: now } : entry,
  )
}

/** Whether a drawn AssistantMessage row is a logged detected question. */
export function findFlagged(
  log: readonly QuestionLogEntry[],
  requestId: string,
  text: string,
): QuestionLogEntry | undefined {
  let hash: string | undefined
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    if (entry === undefined || entry.kind !== 'detected') continue
    if (entry.messageId !== undefined && entry.messageId === requestId) return entry
    if (entry.textHash !== undefined) {
      hash ??= textHash(text)
      if (entry.textHash === hash) return entry
    }
  }
  return undefined
}

/** How many entries the inline log (`/questions` where no pane is drawn) shows at most. */
export const INLINE_CAP = 20

/** The first line of `/questions`' text when the pane could not be placed: the inline log follows. */
export const INLINE_HEAD = 'Question log (no pane here, shown inline):'

/**
 * What the inline log shows: of the last `cap` entries, the open ones first
 * (oldest first, the order they were asked), then the answered ones newest
 * first; `hidden` counts the older entries left out.
 */
export function inlineSelection(
  log: readonly QuestionLogEntry[],
  cap = INLINE_CAP,
): { open: QuestionLogEntry[]; answered: QuestionLogEntry[]; hidden: number; openTotal: number } {
  const recent = log.slice(-cap)
  const open = recent.filter(entry => entry.answer === undefined)
  const answered = recent.filter(entry => entry.answer !== undefined).reverse()
  return { open, answered, hidden: log.length - recent.length, openTotal: openCount(log) }
}

/** One entry's questions on one line: `[Header] text` joined by ` · `. */
export function questionLine(entry: QuestionLogEntry, max = 200): string {
  const text = entry.questions
    .map(question => `${question.header !== undefined ? `[${question.header}] ` : ''}${question.text}`)
    .join(' · ')
  return snippet(text, max)
}

/** The inline log's summary line: `3 questions · 1 open`. */
export function summaryLine(log: readonly QuestionLogEntry[]): string {
  const open = openCount(log)
  return `${log.length} question${log.length === 1 ? '' : 's'}${open > 0 ? ` · ${open} open` : ''}`
}

/** Escapes what markdown would read as formatting in a logged text. */
function mdEscape(text: string): string {
  return text.replace(/([\\`*_[\]<>#|])/g, '\\$1')
}

/**
 * The inline log as markdown: the `/questions` output text where no pane is
 * drawn, which any surface (and the transcript) shows even when no render
 * hook draws it as a tree.
 */
export function inlineMarkdown(log: readonly QuestionLogEntry[], now: number, cap = INLINE_CAP): string {
  if (log.length === 0) return `${INLINE_HEAD}\n\nNo questions yet.`
  const { open, answered, hidden } = inlineSelection(log, cap)
  const lines = [INLINE_HEAD, '', `**${summaryLine(log)}**`, '']
  for (const entry of open) lines.push(`- ❓ ${mdEscape(questionLine(entry))} _(${relativeTime(entry.at, now)})_`)
  for (const entry of answered) {
    lines.push(`- ✓ ${mdEscape(questionLine(entry))} _(${relativeTime(entry.at, now)})_`)
    lines.push(`  ↳ ${mdEscape(snippet(entry.answer ?? '', 120))}`)
  }
  if (hidden > 0) lines.push('', `_${hidden} older not shown_`)
  return lines.join('\n')
}

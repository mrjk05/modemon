import type { ChecklistItem, ChecklistStatus } from '../types'

export type { ChecklistItem, ChecklistStatus }

/** What every list operation answers: the new list, the items it touched, and an error when it did nothing. */
export type OpResult = {
  items: ChecklistItem[]
  changed: ChecklistItem[]
  error?: string
}

export type Progress = {
  done: number
  total: number
  /** The first item being worked on, else the first todo; undefined when nothing is open. */
  next: ChecklistItem | undefined
}

export const MAX_TEXT = 200

/** One line, trimmed, capped. */
export function cleanText(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one
}

export function nextId(items: readonly ChecklistItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

/** Accepts only well-formed items, so a damaged store entry cannot break drawing. */
export function sanitize(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) return []
  const out: ChecklistItem[] = []
  const seen = new Set<number>()
  for (const raw of value as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const id = r.id
    const text = r.text
    const status = r.status
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || seen.has(id)) continue
    if (typeof text !== 'string' || text.trim() === '') continue
    if (status !== 'todo' && status !== 'doing' && status !== 'done') continue
    seen.add(id)
    const item: ChecklistItem = {
      id,
      text: cleanText(text),
      status,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    }
    if (status === 'done' && typeof r.doneAt === 'number') item.doneAt = r.doneAt
    out.push(item)
  }
  return out
}

export function add(items: readonly ChecklistItem[], texts: readonly string[], now: number): OpResult {
  const cleaned = texts.map(cleanText).filter(text => text !== '')
  if (cleaned.length === 0) return { items: [...items], changed: [], error: 'Nothing to add: give the item text.' }
  let id = nextId(items)
  const added = cleaned.map(text => ({ id: id++, text, status: 'todo' as const, createdAt: now }))
  return { items: [...items, ...added], changed: added }
}

function setStatus(
  items: readonly ChecklistItem[],
  ids: readonly number[],
  status: ChecklistStatus,
  now: number,
): OpResult {
  if (ids.length === 0) return { items: [...items], changed: [], error: 'Give at least one item number.' }
  const missing = ids.filter(id => !items.some(item => item.id === id))
  if (missing.length > 0) {
    return { items: [...items], changed: [], error: `No item ${missing.map(n => `#${n}`).join(', ')}.` }
  }
  const wanted = new Set(ids)
  const changed: ChecklistItem[] = []
  const next = items.map(item => {
    if (!wanted.has(item.id)) return item
    const updated: ChecklistItem = { id: item.id, text: item.text, status, createdAt: item.createdAt }
    if (status === 'done') updated.doneAt = item.status === 'done' && item.doneAt !== undefined ? item.doneAt : now
    changed.push(updated)
    return updated
  })
  return { items: next, changed }
}

/** Marks items as being worked on. */
export function start(items: readonly ChecklistItem[], ids: readonly number[], now: number): OpResult {
  return setStatus(items, ids, 'doing', now)
}

export function done(items: readonly ChecklistItem[], ids: readonly number[], now: number): OpResult {
  return setStatus(items, ids, 'done', now)
}

/** Back to todo. */
export function undo(items: readonly ChecklistItem[], ids: readonly number[], now: number): OpResult {
  return setStatus(items, ids, 'todo', now)
}

export function remove(items: readonly ChecklistItem[], ids: readonly number[]): OpResult {
  if (ids.length === 0) return { items: [...items], changed: [], error: 'Give at least one item number.' }
  const missing = ids.filter(id => !items.some(item => item.id === id))
  if (missing.length > 0) {
    return { items: [...items], changed: [], error: `No item ${missing.map(n => `#${n}`).join(', ')}.` }
  }
  const wanted = new Set(ids)
  return {
    items: items.filter(item => !wanted.has(item.id)),
    changed: items.filter(item => wanted.has(item.id)),
  }
}

export function clearDone(items: readonly ChecklistItem[]): OpResult {
  return {
    items: items.filter(item => item.status !== 'done'),
    changed: items.filter(item => item.status === 'done'),
  }
}

export function progress(items: readonly ChecklistItem[]): Progress {
  const doneCount = items.filter(item => item.status === 'done').length
  const next = items.find(item => item.status === 'doing') ?? items.find(item => item.status === 'todo')
  return { done: doneCount, total: items.length, next }
}

export function openItems(items: readonly ChecklistItem[]): ChecklistItem[] {
  return items.filter(item => item.status !== 'done')
}

/** `▕██████░░░░▏` */
export function bar(doneCount: number, total: number, width = 10): string {
  const filled = total === 0 ? 0 : Math.round((doneCount / total) * width)
  return `▕${'█'.repeat(filled)}${'░'.repeat(width - filled)}▏`
}

/** `☑ 3/7 ▕██████░░░░▏`; the caller adds `next: ...`. */
export function bandHead(items: readonly ChecklistItem[]): string {
  const p = progress(items)
  return `☑ ${p.done}/${p.total} ${bar(p.done, p.total)}`
}

/** The whole band as one line, or undefined when the list is empty. */
export function bandText(items: readonly ChecklistItem[]): string | undefined {
  if (items.length === 0) return undefined
  const p = progress(items)
  return `${bandHead(items)} ${p.next === undefined ? 'all done' : `next: ${p.next.text}`}`
}

export function mark(status: ChecklistStatus): string {
  return status === 'done' ? '[x]' : status === 'doing' ? '[>]' : '[ ]'
}

/** Compact text for the model and the command: a header line, then one line per item. */
export function formatList(items: readonly ChecklistItem[]): string {
  if (items.length === 0) return 'Checklist is empty.'
  const p = progress(items)
  const lines = items.map(item => `${mark(item.status)} #${item.id} ${item.text}`)
  return [`Checklist ${p.done}/${p.total} done ([ ] todo, [>] doing, [x] done):`, ...lines].join('\n')
}

/** The keep-going section of the system prompt; undefined when nothing is open. */
export function nudgeText(items: readonly ChecklistItem[], toolName: string, maxListed = 12): string | undefined {
  const open = openItems(items)
  if (open.length === 0) return undefined
  const listed = open.slice(0, maxListed).map(item => `- #${item.id}${item.status === 'doing' ? ' (doing)' : ''} ${item.text}`)
  if (open.length > maxListed) listed.push(`- ... and ${open.length - maxListed} more (action "list")`)
  return [
    '# Checklist',
    `This repo has a persistent checklist the user shares with you (${open.length} open of ${items.length}):`,
    ...listed,
    `Unless the user asks for something else, keep working through these in order with the ${toolName} tool: "start" an item when you begin it, "done" as soon as it is finished (before moving on), and "add" any follow-up work you discover. Do not mark an item done that you did not finish.`,
  ].join('\n')
}

/** Item numbers out of `3`, `#3`, `3,4 5`. */
export function parseIds(text: string): number[] | undefined {
  const parts = text.split(/[\s,]+/).filter(part => part !== '')
  if (parts.length === 0) return undefined
  const ids: number[] = []
  for (const part of parts) {
    const m = /^#?(\d+)$/.exec(part)
    if (m === null || m[1] === undefined) return undefined
    ids.push(Number(m[1]))
  }
  return ids
}

export type Command =
  | { kind: 'toggle' }
  | { kind: 'list' }
  | { kind: 'add'; texts: string[] }
  | { kind: 'start' | 'done' | 'undo' | 'rm'; ids: number[] }
  | { kind: 'clear' }
  | { kind: 'error'; message: string }

export const USAGE = 'Usage: /checklist [add <text> | start <n> | done <n> | undo <n> | rm <n> | clear | list]'

const VERBS: Record<string, 'start' | 'done' | 'undo' | 'rm'> = {
  start: 'start',
  doing: 'start',
  done: 'done',
  check: 'done',
  tick: 'done',
  undo: 'undo',
  uncheck: 'undo',
  rm: 'rm',
  remove: 'rm',
  del: 'rm',
  delete: 'rm',
}

/** Parses what follows `/checklist`. */
export function parseCommand(args: string): Command {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'toggle' }
  const m = /^(\S+)\s*([\s\S]*)$/.exec(trimmed)
  const verb = (m?.[1] ?? '').toLowerCase()
  const rest = (m?.[2] ?? '').trim()
  if (verb === 'add') {
    if (rest === '') return { kind: 'error', message: 'Usage: /checklist add <text>' }
    return { kind: 'add', texts: [rest] }
  }
  if (verb === 'clear') return { kind: 'clear' }
  if (verb === 'list' || verb === 'ls' || verb === 'show') return { kind: 'list' }
  const kind = VERBS[verb]
  if (kind !== undefined) {
    const ids = parseIds(rest)
    if (ids === undefined) return { kind: 'error', message: `Usage: /checklist ${verb} <n> (the item number from the list)` }
    return { kind, ids }
  }
  return { kind: 'error', message: USAGE }
}

export const ACTIONS = ['list', 'add', 'start', 'done', 'remove', 'clear-done'] as const
export type ToolAction = (typeof ACTIONS)[number]

export type ToolRequest =
  | { action: 'list' | 'clear-done' }
  | { action: 'add'; texts: string[] }
  | { action: 'start' | 'done' | 'remove'; ids: number[] }
  | { action: 'error'; message: string }

function toIds(value: unknown): number[] {
  const list = Array.isArray(value) ? (value as unknown[]) : value === undefined ? [] : [value]
  const ids: number[] = []
  for (const one of list) {
    if (typeof one === 'number' && Number.isInteger(one)) ids.push(one)
    else if (typeof one === 'string') ids.push(...(parseIds(one) ?? []))
  }
  return ids
}

function toTexts(value: unknown): string[] {
  const list = Array.isArray(value) ? (value as unknown[]) : value === undefined ? [] : [value]
  return list.filter((one): one is string => typeof one === 'string')
}

/** Reads the model's tool input leniently: `items`/`ids` arrays, or a single `text`/`id`. */
export function parseToolInput(input: Readonly<Record<string, unknown>>): ToolRequest {
  const action = input.action
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return { action: 'error', message: `"action" must be one of ${ACTIONS.join(', ')}.` }
  }
  switch (action as ToolAction) {
    case 'list':
      return { action: 'list' }
    case 'clear-done':
      return { action: 'clear-done' }
    case 'add': {
      const texts = [...toTexts(input.items), ...toTexts(input.text)]
      if (texts.length === 0) return { action: 'error', message: '"add" needs "items": an array of item texts.' }
      return { action: 'add', texts }
    }
    default: {
      const ids = [...toIds(input.ids), ...toIds(input.id)]
      if (ids.length === 0) return { action: 'error', message: `"${action}" needs "ids": the item numbers from the list.` }
      return { action: action as 'start' | 'done' | 'remove', ids }
    }
  }
}

export const STATUS_NEXT_MAX = 40

/** The status line, `☑ 3/7 · next: Write tests`; undefined (clears it) when the list is empty. */
export function statusText(items: readonly ChecklistItem[], maxNext = STATUS_NEXT_MAX): string | undefined {
  if (items.length === 0) return undefined
  const p = progress(items)
  if (p.next === undefined) return `☑ ${p.done}/${p.total} · all done`
  const text = p.next.text.length > maxNext ? `${p.next.text.slice(0, maxNext - 1)}…` : p.next.text
  return `☑ ${p.done}/${p.total} · next: ${text}`
}

/** Cuts `text` to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  if (max < 2) return text.slice(0, Math.max(max, 0))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

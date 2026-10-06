import type { ContextCategory, SessionContextUsage } from 'claude-code'

import type { ContextBarSegment, ContextBarSnapshot } from '../types'

/** One character cell of a drawn row. */
export type Cell = { ch: string; color?: string; bold?: boolean; dim?: boolean }

/** Consecutive cells of one style, drawn as one Text. */
export type Run = { text: string; color?: string; bold?: boolean; dim?: boolean }

export type Zone = 'active' | 'passive'

export type LegendItem = { glyph: string; color: string; label: string }

export const HALF = 50
export const WARNING = 'Past 50%, consider /compact or a fresh session'

const GLYPH = { used: '█', free: '░', buffer: '▒' } as const
const DIVIDER: Cell = { ch: '┃', color: 'text', bold: true }
const COMPACT_MARK: Cell = { ch: '╎', color: 'error', bold: true }

/** 850, 8.5k, 142k, 1.2M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${trim(n / 1000)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${trim(n / 1_000_000)}M`
}

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '')
}

/** Used categories in the engine's order, then free space, then the compaction buffer. */
export function orderSegments(categories: readonly ContextCategory[]): ContextBarSegment[] {
  const shown = categories.filter(c => c.kind !== 'deferred' && c.tokens > 0)
  const pick = (kind: ContextBarSegment['kind']) =>
    shown
      .filter(c => c.kind === kind)
      .map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind }))

  return [...pick('used'), ...pick('free'), ...pick('buffer')]
}

/** Reduces `$.session.usage({ breakdown })`'s context to what the band draws. */
export function toSnapshot(context: SessionContextUsage): ContextBarSnapshot {
  const b = context.breakdown

  return {
    tokens: context.tokens ?? null,
    percent: context.percent ?? null,
    window: context.window,
    scale: b?.rawMaxTokens || context.window,
    estimatedTokens: b?.totalTokens ?? null,
    autoCompactAt: b?.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null,
    segments: b ? orderSegments(b.categories) : [],
  }
}

/** The fill to judge zones by: exact when a response reported it, else the estimate. */
export function fillPercent(s: ContextBarSnapshot): number | null {
  if (s.percent !== null) return s.percent
  if (s.estimatedTokens === null || s.scale <= 0) return null

  return Math.round((s.estimatedTokens / s.scale) * 100)
}

export function zoneOf(percent: number): Zone {
  return percent < HALF ? 'active' : 'passive'
}

export function zoneColor(percent: number): string {
  if (percent < HALF) return 'success'
  if (percent < 80) return 'warning'

  return 'error'
}

export function shouldWarn(percent: number | null, hasWarned: boolean): boolean {
  return percent !== null && percent >= HALF && !hasWarned
}

export function statusText(s: ContextBarSnapshot | null): string {
  return s?.percent != null ? `ctx ${s.percent}%` : 'ctx --'
}

/** 🟢 under 50%, 🟡 under 80%, 🔴 from there; ⚪ before the first response. */
export function zoneEmoji(percent: number | null): string {
  if (percent === null) return '⚪'
  if (percent < HALF) return '🟢'
  if (percent < 80) return '🟡'

  return '🔴'
}

/** The status entry for surfaces without the band (mobile): `🟡 ctx 71% · passive`. */
export function richStatusText(s: ContextBarSnapshot | null): string {
  const percent = s?.percent ?? null
  if (percent === null) return `${zoneEmoji(null)} ctx --`

  return `${zoneEmoji(percent)} ctx ${percent}% · ${zoneOf(percent)}`
}

/** What `/context-bar <args>` asks for. */
export type CommandAction = 'show' | 'on' | 'off' | 'toggle' | 'unknown'

export function parseCommand(args: string): CommandAction {
  const arg = args.trim().toLowerCase()
  if (arg === '' || arg === 'show' || arg === 'card') return 'show'
  if (arg === 'on' || arg === 'off' || arg === 'toggle') return arg

  return 'unknown'
}

/** The biggest content categories, largest first (free space and the buffer left out). */
export function topCategories(s: ContextBarSnapshot, count: number): ContextBarSegment[] {
  return s.segments
    .filter(seg => seg.kind === 'used')
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, count)
}

/** A category's share of the window, as a whole percentage. */
export function shareOf(s: ContextBarSnapshot, tokens: number): number {
  return s.scale > 0 ? Math.round((tokens / s.scale) * 100) : 0
}

/** The card as plain text: what the model reads from the command's row. */
export function cardText(s: ContextBarSnapshot | null): string {
  if (s === null) return 'Context: not measured yet.'
  const head = headlineRuns(s)
    .map(r => r.text)
    .join('')
  const top = topCategories(s, 4).map(seg => `${seg.name} ${formatTokens(seg.tokens)}`)

  return top.length > 0 ? `Context: ${head}. Largest (estimated): ${top.join(', ')}.` : `Context: ${head}.`
}

/**
 * Splits `cells` across `weights` by largest remainder, then gives every
 * positive weight at least one cell, taken from the widest share.
 */
export function apportion(weights: readonly number[], cells: number): number[] {
  const clean = weights.map(w => (Number.isFinite(w) && w > 0 ? w : 0))
  const total = clean.reduce((a, b) => a + b, 0)
  if (total <= 0 || cells <= 0) return clean.map(() => 0)

  const exact = clean.map(w => (w / total) * cells)
  const out = exact.map(Math.floor)
  let left = cells - out.reduce((a, b) => a + b, 0)
  const byRemainder = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r)
  for (const { i } of byRemainder) {
    if (left <= 0) break
    out[i] = (out[i] ?? 0) + 1
    left -= 1
  }

  clean.forEach((w, i) => {
    if (w === 0 || out[i] !== 0) return
    const widest = out.reduce((best, n, j) => (n > (out[best] ?? 0) ? j : best), 0)
    if ((out[widest] ?? 0) > 1) {
      out[widest] = (out[widest] ?? 0) - 1
      out[i] = 1
    }
  })

  return out
}

/** The cell a fraction of the bar lands on. */
export function markerIndex(fraction: number, width: number): number {
  return Math.min(width - 1, Math.max(0, Math.round(fraction * width)))
}

export function halfIndex(width: number): number {
  return Math.floor(width / 2)
}

export function compactIndex(s: ContextBarSnapshot, width: number): number | null {
  if (s.autoCompactAt === null || s.scale <= 0) return null

  return markerIndex(s.autoCompactAt / s.scale, width)
}

/** The segments to draw: the breakdown's, or a plain used/free split when there is none. */
function drawnSegments(s: ContextBarSnapshot): ContextBarSegment[] {
  if (s.segments.length > 0) return s.segments
  if (s.tokens === null) return [{ name: 'Free space', tokens: s.scale, color: 'inactive', kind: 'free' }]

  return [
    { name: 'Used', tokens: s.tokens, color: 'claude', kind: 'used' },
    { name: 'Free space', tokens: Math.max(0, s.window - s.tokens), color: 'inactive', kind: 'free' },
  ]
}

/** The bar: one cell per column, coloured by category, with the 50% and auto-compact marks. */
export function barCells(s: ContextBarSnapshot, width: number): Cell[] {
  const segments = drawnSegments(s)
  const shares = apportion(
    segments.map(seg => seg.tokens),
    width,
  )
  const cells: Cell[] = []
  segments.forEach((seg, i) => {
    for (let n = 0; n < (shares[i] ?? 0); n++) cells.push({ ch: GLYPH[seg.kind], color: seg.color })
  })
  while (cells.length < width) cells.push({ ch: GLYPH.free, color: 'inactive' })

  const compact = compactIndex(s, width)
  if (compact !== null) cells[compact] = COMPACT_MARK
  cells[halfIndex(width)] = DIVIDER

  return cells.slice(0, width)
}

/** Writes `text` at `start` if every cell it needs, and one on each side, is blank. */
function place(cells: Cell[], start: number, text: string, style: Omit<Cell, 'ch'>): boolean {
  const end = start + text.length
  if (start < 0 || end > cells.length) return false
  for (let i = Math.max(0, start - 1); i < Math.min(cells.length, end + 1); i++) {
    if (cells[i]?.ch !== ' ') return false
  }
  ;[...text].forEach((ch, i) => (cells[start + i] = { ch, ...style }))

  return true
}

/** The row under the bar: ACTIVE and PASSIVE centred in their halves, and the auto-compact label. */
export function labelCells(s: ContextBarSnapshot, width: number): Cell[] {
  const cells: Cell[] = Array.from({ length: width }, () => ({ ch: ' ' }))
  const mid = halfIndex(width)
  const percent = fillPercent(s)
  const zone = percent === null ? null : zoneOf(percent)
  const style = (z: Zone, color: string) => (zone === z ? { color, bold: true } : { color, dim: true })

  cells[mid] = DIVIDER
  const active = width >= 40 ? 'ACTIVE' : 'A'
  const passive = width >= 40 ? 'PASSIVE' : 'P'
  place(cells, Math.floor((mid - active.length) / 2), active, style('active', 'success'))

  const rightStart = mid + 1 + Math.floor((width - mid - 1 - passive.length) / 2)
  if (!place(cells, rightStart, passive, style('passive', 'warning'))) {
    place(cells, mid + 2, passive, style('passive', 'warning'))
  }

  const compact = compactIndex(s, width)
  if (compact !== null && compact !== mid) {
    // The label right of its mark, else left of it, else the bare arrow.
    const mark = { color: 'error' }
    if (!place(cells, compact, '▲ auto-compact', mark) && !place(cells, compact - 13, 'auto-compact ▲', mark)) {
      place(cells, compact, '▲', mark)
    }
  }

  return cells
}

/** Merges consecutive cells of the same style. */
export function toRuns(cells: readonly Cell[]): Run[] {
  const runs: Run[] = []
  for (const { ch, ...style } of cells) {
    const last = runs[runs.length - 1]
    if (last && last.color === style.color && last.bold === style.bold && last.dim === style.dim) {
      last.text += ch
    } else {
      runs.push({ text: ch, ...style })
    }
  }

  return runs
}

/** `142k / 200k · 71% · passive`, or the estimate before the first response. */
export function headlineRuns(s: ContextBarSnapshot): Run[] {
  const sep: Run = { text: ' · ', dim: true }
  if (s.tokens !== null && s.percent !== null) {
    const color = zoneColor(s.percent)

    return [
      { text: `${formatTokens(s.tokens)} / ${formatTokens(s.window)}`, bold: true },
      sep,
      { text: `${s.percent}%`, color, bold: true },
      sep,
      { text: zoneOf(s.percent), color },
    ]
  }
  if (s.estimatedTokens !== null) {
    return [
      { text: `~${formatTokens(s.estimatedTokens)} / ${formatTokens(s.window)}`, bold: true },
      sep,
      { text: 'estimate, no response yet', dim: true },
    ]
  }

  return [{ text: 'waiting for the first response', dim: true }]
}

export function legendItems(s: ContextBarSnapshot): LegendItem[] {
  return s.segments.map(seg => ({
    glyph: GLYPH[seg.kind],
    color: seg.color,
    label: `${seg.name} ${formatTokens(seg.tokens)}`,
  }))
}

/** Packs legend items into lines of at most `width` cells, two spaces apart. */
export function packLegend(items: readonly LegendItem[], width: number): LegendItem[][] {
  const lines: LegendItem[][] = []
  let line: LegendItem[] = []
  let used = 0
  for (const item of items) {
    const size = item.label.length + 2
    if (line.length > 0 && used + 2 + size > width) {
      lines.push(line)
      line = []
      used = 0
    }
    used += (line.length > 0 ? 2 : 0) + size
    line.push(item)
  }
  if (line.length > 0) lines.push(line)

  return lines
}

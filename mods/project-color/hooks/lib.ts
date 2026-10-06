import type { ProjectColorSwatch } from '../types'

/** One palette entry before its text colour is worked out. */
type Entry = { name: string; hex: string; emoji: string }

/**
 * Twelve mid-tone colours: each is light enough to stand out on a dark
 * terminal and saturated enough to stand out on a light one.
 */
const ENTRIES: readonly Entry[] = [
  { name: 'purple', hex: '#8B5CF6', emoji: '🟣' },
  { name: 'blue', hex: '#3B82F6', emoji: '🔵' },
  { name: 'teal', hex: '#0D9488', emoji: '🟢' },
  { name: 'green', hex: '#22C55E', emoji: '🟢' },
  { name: 'lime', hex: '#84CC16', emoji: '🟢' },
  { name: 'yellow', hex: '#EAB308', emoji: '🟡' },
  { name: 'amber', hex: '#B45309', emoji: '🟤' },
  { name: 'orange', hex: '#F97316', emoji: '🟠' },
  { name: 'red', hex: '#DC2626', emoji: '🔴' },
  { name: 'pink', hex: '#EC4899', emoji: '🔴' },
  { name: 'magenta', hex: '#C026D3', emoji: '🟣' },
  { name: 'slate', hex: '#64748B', emoji: '⚫' },
]

export const BLACK = '#000000'
export const WHITE = '#FFFFFF'

/** `#RRGGBB` to its three channels, 0 to 255. */
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map(c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Black or white, whichever has the better contrast on `hex`. */
export function textOn(hex: string): string {
  return contrast(hex, BLACK) >= contrast(hex, WHITE) ? BLACK : WHITE
}

export const PALETTE: readonly ProjectColorSwatch[] = ENTRIES.map(e => ({ ...e, fg: textOn(e.hex) }))

/** 32-bit FNV-1a over the string's UTF-16 code units: stable across runs and machines. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** The palette colour a project gets when nothing is pinned. */
export function autoSwatch(project: string): ProjectColorSwatch {
  return PALETTE[fnv1a(project) % PALETTE.length] as ProjectColorSwatch
}

/** `#abc`, `#aabbcc` or `aabbcc` as `#AABBCC`; null when it is not a hex colour. */
export function parseHex(input: string): string | null {
  const text = input.trim()
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text) ?? /^([0-9a-f]{6})$/i.exec(text)
  const digits = m?.[1]
  if (digits === undefined) return null
  const full = digits.length === 3 ? [...digits].map(d => d + d).join('') : digits
  return `#${full.toUpperCase()}`
}

/** The palette entry named `name` (any case), if any. */
export function byName(name: string): ProjectColorSwatch | undefined {
  const key = name.trim().toLowerCase()
  return PALETTE.find(s => s.name === key)
}

/** The palette entry closest to `hex` by RGB distance. */
export function nearest(hex: string): ProjectColorSwatch {
  const [r, g, b] = rgb(hex)
  let best = PALETTE[0] as ProjectColorSwatch
  let bestDistance = Infinity
  for (const s of PALETTE) {
    const [sr, sg, sb] = rgb(s.hex)
    const d = (r - sr) ** 2 + (g - sg) ** 2 + (b - sb) ** 2
    if (d < bestDistance) [best, bestDistance] = [s, d]
  }
  return best
}

/** A custom hex as a swatch: its own text colour, the nearest palette emoji. */
export function customSwatch(hex: string): ProjectColorSwatch {
  return { name: 'custom', hex, fg: textOn(hex), emoji: nearest(hex).emoji }
}

/** The colour a project draws in: its pinned override when valid, else its auto colour. */
export function resolveSwatch(project: string, override: string | null): ProjectColorSwatch {
  if (override !== null) {
    const named = byName(override)
    if (named !== undefined) return named
    const hex = parseHex(override)
    if (hex !== null) return customSwatch(hex)
  }
  return autoSwatch(project)
}

export type ColorArg =
  | { kind: 'show' }
  | { kind: 'auto' }
  | { kind: 'set'; override: string }
  | { kind: 'error'; message: string }

/** What `/color <args>` asks for. */
export function parseArg(args: string): ColorArg {
  const text = args.trim()
  if (text === '' || /^(list|show|palette)$/i.test(text)) return { kind: 'show' }
  if (/^(auto|reset|clear)$/i.test(text)) return { kind: 'auto' }
  const named = byName(text)
  if (named !== undefined) return { kind: 'set', override: named.name }
  const hex = parseHex(text)
  if (hex !== null) return { kind: 'set', override: hex }
  return {
    kind: 'error',
    message: `"${text}" is not a palette colour or a hex colour (#RGB or #RRGGBB). Colours: ${PALETTE.map(s => s.name).join(', ')}.`,
  }
}

/** The last path segment, trailing slashes ignored; `/` for the root. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(p => p !== '')
  return parts.at(-1) ?? '/'
}

/** The branch a `.git/HEAD` names, or a short commit when detached; null when unreadable. */
export function branchFromHead(head: string): string | null {
  const text = head.trim()
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text)
  if (ref?.[1] !== undefined) return ref[1]
  if (/^[0-9a-f]{7,64}$/i.test(text)) return text.slice(0, 7)
  return null
}

/** The git directory a worktree's `.git` file points at (`gitdir: <path>`), resolved against `root`. */
export function gitdirFromFile(text: string, root: string): string | null {
  const m = /^gitdir:\s*(.+)$/m.exec(text.trim())
  const dir = m?.[1]?.trim()
  if (dir === undefined || dir === '') return null
  return dir.startsWith('/') || /^[a-z]:[\\/]/i.test(dir) ? dir : `${root.replace(/[\\/]+$/, '')}/${dir}`
}

/** The status line: `🟣 modemon`. */
export function statusText(project: string, swatch: ProjectColorSwatch): string {
  return `${swatch.emoji} ${project}`
}

export type StripeParts = { left: string; fill: string; right: string }

/**
 * The stripe's one row as three runs exactly `width` cells wide: the project
 * on the left (cut to fit), the hint on the right when it fits, spaces between.
 */
export function stripeParts(project: string, hint: string | null, width: number): StripeParts {
  const room = Math.max(0, width)
  let left = ` ▌ ${project} `
  if (left.length > room) left = room <= 4 ? left.slice(0, room) : `${left.slice(0, room - 2)}… `
  const right = hint !== null && hint !== '' ? ` ${hint} ` : ''
  const showRight = right !== '' && left.length + right.length + 2 <= room
  const used = left.length + (showRight ? right.length : 0)
  return { left, fill: ' '.repeat(Math.max(0, room - used)), right: showRight ? right : '' }
}

/** Where the colour came from, as the command says it. */
export function sourceOf(override: string | null): 'auto' | 'pinned' {
  return override === null ? 'auto' : 'pinned'
}

/**
 * The command's text: what the model reads and what a surface without the
 * tree shows. Its first line is the one `parseSummary` reads back.
 */
export function commandText(
  project: string,
  swatch: ProjectColorSwatch,
  override: string | null,
  note?: string,
): string {
  const lines = [
    `${project}: ${swatch.name} ${swatch.hex} (${sourceOf(override)})`,
    ...(note !== undefined ? [note] : []),
    `Palette: ${PALETTE.map(s => s.name).join(', ')}.`,
    'Use /color <name|#hex> to pin a colour for this repo, /color auto to go back to the automatic one.',
  ]
  return lines.join('\n')
}

export type Summary = { project: string; name: string; hex: string; source: 'auto' | 'pinned' }

/** Reads back `commandText`'s first line; null for any other text (an error, say). */
export function parseSummary(text: string): Summary | null {
  const first = text.split('\n')[0] ?? ''
  const m = /^(.+): ([a-z]+) (#[0-9A-F]{6}) \((auto|pinned)\)$/.exec(first)
  if (m === null) return null
  const [, project, name, hex, source] = m as unknown as [string, string, string, string, 'auto' | 'pinned']
  return { project, name, hex, source }
}

/** Palette swatches packed into rows no wider than `width` (each item `swatchWidth` cells plus its name). */
export function packPalette(width: number, swatchWidth = 3): ProjectColorSwatch[][] {
  const rows: ProjectColorSwatch[][] = []
  let row: ProjectColorSwatch[] = []
  let used = 0
  for (const s of PALETTE) {
    const size = swatchWidth + 1 + s.name.length + 2
    if (row.length > 0 && used + size > width) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push(s)
    used += size
  }
  if (row.length > 0) rows.push(row)
  return rows
}

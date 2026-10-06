import { describe, expect, test } from 'claude-code/testing'

import {
  apportion,
  barCells,
  compactIndex,
  formatTokens,
  halfIndex,
  headlineRuns,
  labelCells,
  legendItems,
  packLegend,
  shouldWarn,
  statusText,
  toRuns,
  toSnapshot,
  zoneOf,
} from '../hooks/lib'
import { usageAt } from './fixtures'

const text = (cells: { ch: string }[]) => cells.map(c => c.ch).join('')

describe('formatTokens', () => {
  test('scales units', () => {
    expect(formatTokens(850)).toBe('850')
    expect(formatTokens(8_500)).toBe('8.5k')
    expect(formatTokens(142_400)).toBe('142k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })
})

describe('apportion', () => {
  test('fills exactly the cells asked for', () => {
    const shares = apportion([3, 12, 125, 27, 33], 80)
    expect(shares.reduce((a, b) => a + b, 0)).toBe(80)
  })

  test('gives every non-zero weight at least one cell', () => {
    const shares = apportion([1, 1000, 0], 10)
    expect(shares).toEqual([1, 9, 0])
  })

  test('answers zeros for nothing to split', () => {
    expect(apportion([0, 0], 10)).toEqual([0, 0])
    expect(apportion([5], 0)).toEqual([0])
  })
})

describe('toSnapshot', () => {
  test('orders used, free, buffer and drops deferred rows', () => {
    const s = toSnapshot(usageAt(142_000).context)
    expect(s.segments.map(seg => seg.kind)).toEqual(['used', 'used', 'used', 'used', 'free', 'buffer'])
    expect(s.segments.some(seg => seg.name === 'MCP tools')).toBe(false)
    expect(s.tokens).toBe(142_000)
    expect(s.percent).toBe(71)
    expect(s.autoCompactAt).toBe(167_000)
  })

  test('keeps the estimate before the first response', () => {
    const s = toSnapshot(usageAt(null).context)
    expect(s.tokens).toBeNull()
    expect(s.percent).toBeNull()
    expect(s.estimatedTokens).toBe(17_000)
  })
})

describe('bar', () => {
  const s = toSnapshot(usageAt(142_000).context)

  test('is exactly as wide as the band, with the 50% divider in the middle', () => {
    for (const width of [24, 61, 80, 157]) {
      const cells = barCells(s, width)
      expect(cells).toHaveLength(width)
      expect(cells[halfIndex(width)]?.ch).toBe('┃')
    }
  })

  test('marks the auto-compact threshold', () => {
    const cells = barCells(s, 100)
    const at = compactIndex(s, 100)
    expect(at).toBe(84)
    expect(cells[at ?? -1]?.ch).toBe('╎')
  })

  test('labels ACTIVE, PASSIVE and the auto-compact mark', () => {
    const row = text(labelCells(s, 100))
    expect(row).toHaveLength(100)
    expect(row.indexOf('ACTIVE')).toBeLessThan(50)
    expect(row.indexOf('PASSIVE')).toBeGreaterThan(50)
    expect(row).toContain('▲')
  })

  test('merges cells of one style into runs', () => {
    const runs = toRuns(barCells(s, 80))
    expect(runs.map(r => r.text).join('')).toHaveLength(80)
    expect(runs.length).toBeLessThan(20)
  })
})

describe('headline and status', () => {
  test('reads tokens / window · percent · zone', () => {
    const runs = headlineRuns(toSnapshot(usageAt(142_000).context))
    expect(runs.map(r => r.text).join('')).toBe('142k / 200k · 71% · passive')
    expect(statusText(toSnapshot(usageAt(142_000).context))).toBe('ctx 71%')
  })

  test('says it is an estimate before the first response', () => {
    const s = toSnapshot(usageAt(null).context)
    expect(headlineRuns(s).map(r => r.text).join('')).toContain('~17k / 200k')
    expect(statusText(s)).toBe('ctx --')
    expect(statusText(null)).toBe('ctx --')
  })

  test('zones and warnings flip at 50%', () => {
    expect(zoneOf(49)).toBe('active')
    expect(zoneOf(50)).toBe('passive')
    expect(shouldWarn(50, false)).toBe(true)
    expect(shouldWarn(50, true)).toBe(false)
    expect(shouldWarn(49, false)).toBe(false)
    expect(shouldWarn(null, false)).toBe(false)
  })
})

test('legend packs into lines no wider than the band', () => {
  const items = legendItems(toSnapshot(usageAt(142_000).context))
  for (const width of [30, 60, 120]) {
    for (const line of packLegend(items, width)) {
      const size = line.reduce((sum, item) => sum + item.label.length + 2, 0) + 2 * (line.length - 1)
      expect(size <= width || line.length === 1).toBe(true)
    }
  }
})

import { describe, expect, test } from 'claude-code/testing'

import {
  BLACK,
  PALETTE,
  WHITE,
  autoSwatch,
  basename,
  branchFromHead,
  commandText,
  contrast,
  fnv1a,
  gitdirFromFile,
  nearest,
  packPalette,
  parseArg,
  parseHex,
  parseSummary,
  resolveSwatch,
  rgb,
  statusText,
  stripeParts,
  textOn,
} from '../hooks/lib'

describe('hash', () => {
  test('is 32-bit FNV-1a', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(fnv1a('foobar')).toBe(0xbf9cf968)
  })

  test('picks the same colour for the same name, every time', () => {
    for (const name of ['modemon', 'context-bar', 'my-app', 'x']) {
      const first = autoSwatch(name)
      for (let i = 0; i < 5; i++) expect(autoSwatch(name)).toEqual(first)
    }
    expect(autoSwatch('modemon').name).toBe(PALETTE[fnv1a('modemon') % 12]?.name)
  })

  test('spreads names over the palette', () => {
    const used = new Set<string>()
    for (let i = 0; i < 200; i++) used.add(autoSwatch(`project-${i}`).name)
    expect(used.size).toBe(12)
  })
})

describe('palette', () => {
  test('has 12 named, distinct colours with an emoji each', () => {
    expect(PALETTE).toHaveLength(12)
    expect(PALETTE.map(s => s.name)).toEqual([
      'purple',
      'blue',
      'teal',
      'green',
      'lime',
      'yellow',
      'amber',
      'orange',
      'red',
      'pink',
      'magenta',
      'slate',
    ])
    expect(new Set(PALETTE.map(s => s.hex)).size).toBe(12)
    for (const s of PALETTE) {
      expect(s.hex).toMatch(/^#[0-9A-F]{6}$/)
      expect(s.emoji).toMatch(/^(🟣|🔵|🟢|🟡|🟠|🔴|🟤|⚫|⚪)$/)
    }
  })

  test('colours are far enough apart to tell from each other', () => {
    for (const a of PALETTE) {
      for (const b of PALETTE) {
        if (a === b) continue
        const [r1, g1, b1] = rgb(a.hex)
        const [r2, g2, b2] = rgb(b.hex)
        expect(Math.hypot(r1 - r2, g1 - g2, b1 - b2)).toBeGreaterThan(60)
      }
    }
  })

  test('each text colour has at least 4.5:1 contrast on its swatch', () => {
    for (const s of PALETTE) {
      expect([BLACK, WHITE]).toContain(s.fg)
      expect(s.fg).toBe(textOn(s.hex))
      expect(contrast(s.hex, s.fg)).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('every swatch stands out on a dark and on a light terminal', () => {
    for (const s of PALETTE) {
      expect(contrast(s.hex, '#1E1E1E')).toBeGreaterThanOrEqual(1.8)
      expect(contrast(s.hex, '#FFFFFF')).toBeGreaterThanOrEqual(1.8)
    }
  })

  test('picks black on light colours and white on dark ones', () => {
    expect(textOn('#FFFF00')).toBe(BLACK)
    expect(textOn('#000080')).toBe(WHITE)
    expect(Math.round(contrast(BLACK, WHITE))).toBe(21)
  })
})

describe('hex parsing', () => {
  test('accepts #RGB, #RRGGBB and bare RRGGBB', () => {
    expect(parseHex('#abc')).toBe('#AABBCC')
    expect(parseHex('#12ab34')).toBe('#12AB34')
    expect(parseHex('  #FF0000 ')).toBe('#FF0000')
    expect(parseHex('12ab34')).toBe('#12AB34')
  })

  test('refuses anything else', () => {
    for (const bad of ['', '#', '#ab', '#abcd', '#12345', '#1234567', '#ggg', 'abc', 'red', '#12 34 56']) {
      expect(parseHex(bad)).toBeNull()
    }
  })
})

describe('/color arguments', () => {
  test('reads show, auto, names and hex', () => {
    expect(parseArg('')).toEqual({ kind: 'show' })
    expect(parseArg('  list ')).toEqual({ kind: 'show' })
    expect(parseArg('auto')).toEqual({ kind: 'auto' })
    expect(parseArg('Reset')).toEqual({ kind: 'auto' })
    expect(parseArg('Teal')).toEqual({ kind: 'set', override: 'teal' })
    expect(parseArg('#0af')).toEqual({ kind: 'set', override: '#00AAFF' })
  })

  test('explains a bad colour', () => {
    const arg = parseArg('#zzz')
    expect(arg.kind).toBe('error')
    if (arg.kind === 'error') expect(arg.message).toContain('purple')
  })

  test('an override wins over the automatic colour; a broken one falls back', () => {
    expect(resolveSwatch('modemon', 'red').hex).toBe('#DC2626')
    const custom = resolveSwatch('modemon', '#FFEE00')
    expect(custom).toMatchObject({ name: 'custom', hex: '#FFEE00', fg: BLACK, emoji: nearest('#FFEE00').emoji })
    expect(resolveSwatch('modemon', 'nonsense')).toEqual(autoSwatch('modemon'))
    expect(resolveSwatch('modemon', null)).toEqual(autoSwatch('modemon'))
  })

  test('the command text round-trips through its summary line', () => {
    const swatch = resolveSwatch('my: app', '#123456')
    const text = commandText('my: app', swatch, '#123456', 'Pinned.')
    expect(parseSummary(text)).toEqual({ project: 'my: app', name: 'custom', hex: '#123456', source: 'pinned' })
    expect(parseSummary('"x" is not a palette colour')).toBeNull()
  })
})

describe('identity and layout', () => {
  test('basename and branch', () => {
    expect(basename('/home/user/modemon')).toBe('modemon')
    expect(basename('/home/user/modemon/')).toBe('modemon')
    expect(basename('C:\\src\\app')).toBe('app')
    expect(basename('/')).toBe('/')
    expect(branchFromHead('ref: refs/heads/feature/x\n')).toBe('feature/x')
    expect(branchFromHead('0123456789abcdef0123456789abcdef01234567')).toBe('0123456')
    expect(branchFromHead('garbage')).toBeNull()
    expect(gitdirFromFile('gitdir: /r/.git/worktrees/w\n', '/w')).toBe('/r/.git/worktrees/w')
    expect(gitdirFromFile('gitdir: ../r/.git/worktrees/w', '/x/w')).toBe('/x/w/../r/.git/worktrees/w')
  })

  test('status line is emoji and name', () => {
    expect(statusText('modemon', resolveSwatch('modemon', 'purple'))).toBe('🟣 modemon')
  })

  test('the stripe fills its width exactly, the hint only where it fits', () => {
    for (const width of [1, 5, 12, 20, 40, 120]) {
      const p = stripeParts('modemon', 'main', width)
      expect((p.left + p.fill + p.right).length).toBe(width)
    }
    expect(stripeParts('modemon', 'main', 80).right).toBe(' main ')
    expect(stripeParts('modemon', 'main', 12).right).toBe('')
    expect(stripeParts('a-very-long-project-name', null, 12).left).toBe(' ▌ a-very-… ')
  })

  test('the palette packs into rows no wider than asked', () => {
    for (const width of [20, 40, 80]) {
      const rows = packPalette(width)
      expect(rows.flat()).toHaveLength(12)
      for (const row of rows) {
        const size = row.reduce((n, s) => n + 3 + 1 + s.name.length + 2, 0)
        expect(size <= width || row.length === 1).toBe(true)
      }
    }
  })
})

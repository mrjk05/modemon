import { describe, expect, test } from 'claude-code/testing'

import type { Decision, DecisionEntry } from '../types'
import {
  dirSegments,
  fileName,
  formatList,
  guideText,
  INDEX_MARKER,
  isDecisionFile,
  nextId,
  parseAlternatives,
  parseDecide,
  parseDecision,
  parseDecisionsArgs,
  parseToolInput,
  renderIndex,
  search,
  serializeDecision,
  slugify,
} from '../hooks/lib'

const base = (over: Partial<Decision> = {}): Decision => ({
  id: 7,
  title: 'Use SQLite for the local cache',
  status: 'accepted',
  date: '2026-10-06',
  deciders: ['user', 'claude'],
  supersedes: [3],
  supersededBy: [],
  tags: ['storage', 'cache'],
  files: ['src/cache.ts'],
  context: 'We need an embedded store.\n\nIt must survive restarts.',
  decision: 'Use SQLite via `better-sqlite3`.',
  alternatives: ['LevelDB: no SQL, harder to inspect.', 'Plain JSON files: no concurrent writers.\n\nAlso slow past 10k rows.'],
  consequences: '- One native dependency.\n- Migrations needed.',
  preamble: '',
  extraSections: [],
  extraMeta: [],
  ...over,
})

const entry = (d: Decision): DecisionEntry => ({ ...d, file: fileName(d.id, d.title), path: `docs/decisions/${fileName(d.id, d.title)}` })

describe('parser and serializer', () => {
  test('a record round-trips exactly, and the serializer is deterministic', () => {
    const d = base()
    const text = serializeDecision(d)
    expect(text.startsWith('---\nid: 7\ntitle: Use SQLite for the local cache\nstatus: accepted\ndate: 2026-10-06\n')).toBe(true)
    expect(text).toContain('deciders: [user, claude]\nsupersedes: [3]\nsuperseded-by: []\ntags: [storage, cache]\nfiles: [src/cache.ts]\n---\n')
    expect(text).toContain('# 7. Use SQLite for the local cache\n\n## Context\n\nWe need an embedded store.')
    expect(text).toContain('## Alternatives considered\n\n- LevelDB: no SQL, harder to inspect.\n- Plain JSON files: no concurrent writers.\n\n  Also slow past 10k rows.\n')
    expect(parseDecision(text)).toEqual(d)
    expect(serializeDecision(parseDecision(text))).toBe(text)
  })

  test('awkward values are quoted and come back the same', () => {
    const d = base({ title: 'API: use "REST" # not gRPC', tags: ['a, b', 'yes', 'c++'], files: ['dir with space/x.ts', '-flag'], deciders: [] })
    const text = serializeDecision(d)
    expect(text).toContain('title: "API: use \\"REST\\" # not gRPC"')
    expect(parseDecision(text)).toEqual(d)
  })

  test('hand-edited files: CRLF, block lists, MADR headings, missing sections, unknown keys', () => {
    const source = [
      '---',
      'title: \'Adopt pnpm\'',
      'Status: Approved',
      'date: 2025-01-02',
      'deciders:',
      '  - alice',
      '  - bob',
      'superseded_by: "#12"',
      'tags: build, tooling',
      'owner: platform-team',
      '---',
      '',
      '# ADR-4: Adopt pnpm',
      '',
      'Some intro text.',
      '',
      '## Context and Problem Statement',
      'npm installs are slow.',
      '',
      '```md',
      '## not a heading',
      '```',
      '## Considered Options',
      '* npm',
      '* yarn',
      '  (berry)',
      '## Notes',
      'Ask Bob.',
    ].join('\r\n')
    const d = parseDecision(source, '0004-adopt-pnpm.md')
    expect(d.id).toBe(4)
    expect(d.title).toBe('Adopt pnpm')
    expect(d.status).toBe('accepted')
    expect(d.deciders).toEqual(['alice', 'bob'])
    expect(d.supersededBy).toEqual([12])
    expect(d.tags).toEqual(['build', 'tooling'])
    expect(d.preamble).toBe('Some intro text.')
    expect(d.context).toBe('npm installs are slow.\n\n```md\n## not a heading\n```')
    expect(d.decision).toBe('')
    expect(d.consequences).toBe('')
    expect(d.alternatives).toEqual(['npm', 'yarn\n(berry)'])
    expect(d.extraSections).toEqual([{ heading: 'Notes', body: 'Ask Bob.' }])
    expect(d.extraMeta).toEqual([['owner', 'platform-team']])
    // Normalized once, it is then stable.
    const once = serializeDecision(d)
    expect(once).not.toContain('\r')
    expect(once).toContain('owner: platform-team')
    expect(once).toContain('## Notes\n\nAsk Bob.')
    expect(parseDecision(once)).toEqual(d)
    expect(serializeDecision(parseDecision(once))).toBe(once)
  })

  test('no front matter: id and title come from the heading or the file name', () => {
    expect(parseDecision('# 12. Split the monolith\n\n## Decision\n\nDo it.\n')).toMatchObject({ id: 12, title: 'Split the monolith', decision: 'Do it.', status: 'proposed' })
    expect(parseDecision('Just text.', '0009-move-to-k8s.md')).toMatchObject({ id: 9, title: 'move to k8s', preamble: 'Just text.' })
    expect(parseDecision('---\nstatus: bogus\n---\n', '0002-x.md').status).toBe('proposed')
  })

  test('alternatives that are prose stay one item', () => {
    expect(parseAlternatives('We looked at nothing else.\nReally.')).toEqual(['We looked at nothing else.\nReally.'])
    expect(parseAlternatives('1. One\n2. Two')).toEqual(['One', 'Two'])
  })
})

describe('naming and numbering', () => {
  test('slugs are sanitised', () => {
    expect(slugify('Use SQLite for the local cache!')).toBe('use-sqlite-for-the-local-cache')
    expect(slugify('Ünïcödé — café ../../etc/passwd')).toBe('unicode-cafe-etc-passwd')
    expect(slugify('???')).toBe('decision')
    expect(slugify('a'.repeat(30) + ' ' + 'b'.repeat(40)).length).toBeLessThanOrEqual(60)
    expect(fileName(7, 'Hello/World')).toBe('0007-hello-world.md')
    expect(fileName(12345, 'x')).toBe('12345-x.md')
  })

  test('numbering is the highest id or file number plus one', () => {
    expect(nextId([])).toBe(1)
    expect(nextId([{ id: 2 }, { id: 9 }], ['0003-a.md'])).toBe(10)
    expect(nextId([{ id: 2 }], ['0041-hand-made.md'])).toBe(42)
  })

  test('only NNNN-*.md files are records, never the index or odd names', () => {
    expect(isDecisionFile('0001-a.md')).toBe(true)
    expect(isDecisionFile('README.md')).toBe(false)
    expect(isDecisionFile('notes.md')).toBe(false)
    expect(isDecisionFile('0001-a.txt')).toBe(false)
  })

  test('the folder option must stay inside the repository', () => {
    expect(dirSegments('docs/decisions')).toEqual({ segments: ['docs', 'decisions'] })
    expect(dirSegments('./adr/')).toEqual({ segments: ['adr'] })
    for (const bad of ['../outside', 'docs/../../x', '/etc', 'C:\\adr', '~/adr', '', '.']) expect('error' in dirSegments(bad)).toBe(true)
  })
})

describe('commands and tool input', () => {
  test('/decide accepts an em dash, -- or : between title and why', () => {
    expect(parseDecide('Use Postgres — we need transactions')).toEqual({ title: 'Use Postgres', why: 'we need transactions' })
    expect(parseDecide('Use Postgres -- we need transactions')).toEqual({ title: 'Use Postgres', why: 'we need transactions' })
    expect(parseDecide('Use Postgres: we need transactions')).toEqual({ title: 'Use Postgres', why: 'we need transactions' })
    expect(parseDecide('Drop IE11 support — usage is 0.1%: not worth it')).toEqual({ title: 'Drop IE11 support', why: 'usage is 0.1%: not worth it' })
    expect(parseDecide('Just a title')).toEqual({ title: 'Just a title', why: '' })
    expect('error' in parseDecide('  ')).toBe(true)
  })

  test('/decisions arguments', () => {
    expect(parseDecisionsArgs('')).toEqual({ kind: 'list' })
    expect(parseDecisionsArgs('#3')).toEqual({ kind: 'show', id: 3 })
    expect(parseDecisionsArgs('search sqlite cache')).toEqual({ kind: 'search', query: 'sqlite cache' })
    expect(parseDecisionsArgs('bogus').kind).toBe('error')
  })

  test('tool input is validated', () => {
    expect(parseToolInput({ action: 'record', title: 'X' }).action).toBe('error')
    expect(parseToolInput({ action: 'record', title: 'X', decision: 'Y', status: 'superseded' }).action).toBe('error')
    expect(parseToolInput({ action: 'record', title: 'X', decision: 'Y', supersedes: 3 })).toMatchObject({ status: 'accepted', supersedes: [3], deciders: ['user', 'claude'] })
    expect(parseToolInput({ action: 'supersede', id: 2, by: 2 }).action).toBe('error')
    expect(parseToolInput({ action: 'set-status', id: 2, status: 'nope' }).action).toBe('error')
    expect(parseToolInput({ action: 'zap' }).action).toBe('error')
  })
})

describe('index, listing and search', () => {
  const all = [
    entry(base({ id: 1, title: 'Use REST for the public API', tags: ['api'], context: 'Clients are browsers.', status: 'superseded', supersededBy: [3], supersedes: [] })),
    entry(base({ id: 2, title: 'Pick a cache', tags: ['storage'], context: 'The API is slow, so we cache responses.', supersedes: [] })),
    entry(base({ id: 3, title: 'Use GraphQL | gateway', tags: ['api'], context: 'Many clients.', supersedes: [1] })),
  ]

  test('the index is a table of every record', () => {
    const index = renderIndex(all)
    expect(index).toContain(INDEX_MARKER)
    expect(index).toContain('| # | Title | Status | Date |')
    expect(index).toContain('| 0001 | [Use REST for the public API](0001-use-rest-for-the-public-api.md) | superseded (by #3) | 2026-10-06 |')
    expect(index).toContain('Use GraphQL \\| gateway')
  })

  test('list is newest first, filters by status and tag, and shows paths', () => {
    const text = formatList(all, 'docs/decisions')
    const lines = text.split('\n')
    expect(lines[1]).toMatch(/^#3 accepted/)
    expect(lines[3]).toContain('→ #3')
    expect(lines[3]).toContain('(docs/decisions/0001-use-rest-for-the-public-api.md)')
    expect(formatList(all, 'docs/decisions', { tag: 'API', status: 'accepted' }).split('\n')).toHaveLength(2)
  })

  test('search ranks title matches above body matches and returns snippets', () => {
    const hits = search(all, 'api')
    expect(hits.map(h => h.entry.id)).toEqual([1, 3, 2])
    expect(hits[2]?.snippet).toContain('API is slow')
    expect(search(all, 'nothing-here')).toEqual([])
  })

  test('the prompt guide is short and names the folder and tool', () => {
    const text = guideText('docs/decisions', 'mcp__decision-log__decision')
    expect(text.split(/\s+/).length).toBeLessThan(120)
    expect(text).toContain('docs/decisions/')
    expect(text).toContain('supersede')
  })
})

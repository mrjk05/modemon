import { describe, expect, test } from 'claude-code/testing'

import {
  add,
  bandText,
  bar,
  clearDone,
  done,
  formatList,
  nudgeText,
  parseCommand,
  parseToolInput,
  progress,
  remove,
  sanitize,
  start,
  undo,
} from '../hooks/lib'

const seed = () => add([], ['Write tests', 'Fix bug', 'Ship it'], 100).items

describe('list operations', () => {
  test('add numbers items and supports several at once', () => {
    const { items, changed } = add([], ['  one ', 'two', ''], 5)
    expect(items).toEqual([
      { id: 1, text: 'one', status: 'todo', createdAt: 5 },
      { id: 2, text: 'two', status: 'todo', createdAt: 5 },
    ])
    expect(changed).toHaveLength(2)
    expect(add(items, ['three'], 6).items.at(-1)?.id).toBe(3)
    expect(add(items, ['   '], 6).error).toBeDefined()
  })

  test('start, done and undo change status and doneAt', () => {
    let items = start(seed(), [2], 200).items
    expect(items[1]?.status).toBe('doing')
    items = done(items, [1, 2], 300).items
    expect(items[0]).toEqual({ id: 1, text: 'Write tests', status: 'done', createdAt: 100, doneAt: 300 })
    expect(done(items, [1], 400).items[0]?.doneAt).toBe(300)
    items = undo(items, [1], 500).items
    expect(items[0]).toEqual({ id: 1, text: 'Write tests', status: 'todo', createdAt: 100 })
  })

  test('unknown ids are an error and change nothing', () => {
    const items = seed()
    const result = done(items, [9], 1)
    expect(result.error).toContain('#9')
    expect(result.items).toEqual(items)
    expect(remove(items, [7]).error).toBeDefined()
    expect(start(items, [], 1).error).toBeDefined()
  })

  test('remove and clearDone keep ids stable', () => {
    let items = remove(seed(), [1]).items
    expect(items.map(i => i.id)).toEqual([2, 3])
    items = done(items, [3], 1).items
    const cleared = clearDone(items)
    expect(cleared.items.map(i => i.id)).toEqual([2])
    expect(cleared.changed.map(i => i.id)).toEqual([3])
    expect(add(cleared.items, ['new'], 2).items.at(-1)?.id).toBe(3)
  })

  test('progress prefers the item in progress, then the first todo', () => {
    expect(progress([])).toEqual({ done: 0, total: 0, next: undefined })
    let items = done(seed(), [1], 1).items
    expect(progress(items).next?.id).toBe(2)
    items = start(items, [3], 1).items
    expect(progress(items)).toMatchObject({ done: 1, total: 3, next: { id: 3 } })
    expect(progress(done(items, [2, 3], 1).items).next).toBeUndefined()
  })

  test('sanitize drops damaged entries', () => {
    expect(sanitize('nope')).toEqual([])
    expect(
      sanitize([
        { id: 1, text: 'ok', status: 'todo', createdAt: 1 },
        { id: 1, text: 'dup', status: 'todo', createdAt: 1 },
        { id: 2, text: '', status: 'todo' },
        { id: 3, text: 'bad', status: 'maybe' },
        { id: 4, text: 'done', status: 'done', createdAt: 1, doneAt: 2 },
      ]),
    ).toEqual([
      { id: 1, text: 'ok', status: 'todo', createdAt: 1 },
      { id: 4, text: 'done', status: 'done', createdAt: 1, doneAt: 2 },
    ])
  })
})

describe('text', () => {
  test('bar and band', () => {
    expect(bar(3, 7)).toBe('▕████░░░░░░▏')
    expect(bar(0, 0)).toBe('▕░░░░░░░░░░▏')
    expect(bar(5, 5)).toBe('▕██████████▏')
    expect(bandText([])).toBeUndefined()
    const items = done(seed(), [1], 1).items
    expect(bandText(items)).toBe('☑ 1/3 ▕███░░░░░░░▏ next: Fix bug')
    expect(bandText(done(items, [2, 3], 1).items)).toContain('all done')
  })

  test('formatList is compact', () => {
    expect(formatList([])).toBe('Checklist is empty.')
    const items = start(done(seed(), [1], 1).items, [2], 1).items
    expect(formatList(items)).toBe(
      [
        'Checklist 1/3 done ([ ] todo, [>] doing, [x] done):',
        '[x] #1 Write tests',
        '[>] #2 Fix bug',
        '[ ] #3 Ship it',
      ].join('\n'),
    )
  })

  test('nudge lists open items only, and nothing when all are done', () => {
    const items = start(done(seed(), [1], 1).items, [2], 1).items
    const text = nudgeText(items, 'mcp__checklist__checklist') ?? ''
    expect(text).toContain('- #2 (doing) Fix bug')
    expect(text).toContain('- #3 Ship it')
    expect(text).not.toContain('Write tests')
    expect(text).toContain('mcp__checklist__checklist')
    expect(nudgeText(done(items, [2, 3], 1).items, 'x')).toBeUndefined()
    const many = add([], Array.from({ length: 15 }, (_, i) => `item ${i + 1}`), 1).items
    expect(nudgeText(many, 'x', 12)).toContain('and 3 more')
  })
})

describe('parsing', () => {
  test('/checklist arguments', () => {
    expect(parseCommand('')).toEqual({ kind: 'toggle' })
    expect(parseCommand('  ')).toEqual({ kind: 'toggle' })
    expect(parseCommand('add Write the README')).toEqual({ kind: 'add', texts: ['Write the README'] })
    expect(parseCommand('done 3')).toEqual({ kind: 'done', ids: [3] })
    expect(parseCommand('done #2, 4')).toEqual({ kind: 'done', ids: [2, 4] })
    expect(parseCommand('undo 1')).toEqual({ kind: 'undo', ids: [1] })
    expect(parseCommand('rm 2')).toEqual({ kind: 'rm', ids: [2] })
    expect(parseCommand('start 2')).toEqual({ kind: 'start', ids: [2] })
    expect(parseCommand('clear')).toEqual({ kind: 'clear' })
    expect(parseCommand('list')).toEqual({ kind: 'list' })
    expect(parseCommand('add').kind).toBe('error')
    expect(parseCommand('done x').kind).toBe('error')
    expect(parseCommand('frobnicate').kind).toBe('error')
  })

  test('tool input', () => {
    expect(parseToolInput({ action: 'list' })).toEqual({ action: 'list' })
    expect(parseToolInput({ action: 'add', items: ['a', 'b'] })).toEqual({ action: 'add', texts: ['a', 'b'] })
    expect(parseToolInput({ action: 'add', text: 'a' })).toEqual({ action: 'add', texts: ['a'] })
    expect(parseToolInput({ action: 'done', ids: [1, '#2'] })).toEqual({ action: 'done', ids: [1, 2] })
    expect(parseToolInput({ action: 'remove', id: 4 })).toEqual({ action: 'remove', ids: [4] })
    expect(parseToolInput({ action: 'clear-done' })).toEqual({ action: 'clear-done' })
    expect(parseToolInput({ action: 'done' }).action).toBe('error')
    expect(parseToolInput({ action: 'add', items: [] }).action).toBe('error')
    expect(parseToolInput({ action: 'explode' }).action).toBe('error')
  })
})

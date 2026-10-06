import { describe, expect, test } from 'claude-code/testing'

import {
  countByStatus,
  describeTool,
  elapsedOf,
  formatClock,
  formatElapsed,
  inlineDeckText,
  newestRunning,
  headerText,
  orderCards,
  parseCommand,
  shortModel,
  shortPath,
  statusText,
  summarizePrompt,
  truncate,
} from '../hooks/lib'
import type { AgentDeckCard } from '../types'

function card(fields: Partial<AgentDeckCard> & Pick<AgentDeckCard, 'key' | 'status'>): AgentDeckCard {
  return { type: 'Explore', title: 'Task', summary: '', startedAt: 0, toolCount: 0, ...fields }
}

describe('formatElapsed', () => {
  test('seconds, minutes and hours', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(999)).toBe('0s')
    expect(formatElapsed(42_000)).toBe('42s')
    expect(formatElapsed(187_000)).toBe('3m 07s')
    expect(formatElapsed(3_720_000)).toBe('1h 02m')
    expect(formatElapsed(-5)).toBe('0s')
  })
})

describe('summarizePrompt', () => {
  test('folds lines and markdown markers into one line', () => {
    expect(summarizePrompt('# Task\n\n- find the auth middleware\n- report back')).toBe(
      'Task find the auth middleware report back',
    )
  })
  test('cuts long prompts at a word with an ellipsis', () => {
    const long = 'Look through every file in the repository for places where the JWT token is verified and list them'
    const short = summarizePrompt(long, 40)
    expect(short.length).toBeLessThanOrEqual(40)
    expect(short.endsWith('…')).toBe(true)
    expect(short.startsWith('Look through every file')).toBe(true)
  })
  test('drops code fences', () => {
    expect(summarizePrompt('Run this:\n```\nnpm test\n```')).toBe('Run this: npm test')
  })
})

describe('describeTool', () => {
  test('search tools show their pattern', () => {
    expect(describeTool('Grep', { pattern: 'foo' })).toBe('Grep "foo"')
    expect(describeTool('Glob', { pattern: '**/*.ts' })).toBe('Glob "**/*.ts"')
  })
  test('file tools show the path, relative to cwd', () => {
    expect(describeTool('Edit', { file_path: '/repo/src/x.ts' }, '/repo')).toBe('Edit src/x.ts')
    expect(describeTool('Read', { file_path: '/a/b/c/d/e.ts' })).toBe('Read …/c/d/e.ts')
  })
  test('other tools', () => {
    expect(describeTool('Bash', { command: 'npm test\nnpm run lint' })).toBe('Bash npm test')
    expect(describeTool('WebFetch', { url: 'https://example.com/a?b=1' })).toBe('WebFetch example.com')
    expect(describeTool('WebSearch', { query: 'ink flexbox' })).toBe('WebSearch "ink flexbox"')
    expect(describeTool('Agent', { description: 'Review diff' })).toBe('Agent "Review diff"')
    expect(describeTool('mcp__github__get_file', {})).toBe('github get_file')
    expect(describeTool('TodoWrite', { todos: [] })).toBe('TodoWrite')
  })
  test('is cut to max', () => {
    expect(describeTool('Bash', { command: 'x'.repeat(200) }, undefined, 20).length).toBe(20)
  })
})

describe('small helpers', () => {
  test('truncate', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('hello world', 6)).toBe('hello…')
    expect(truncate('abc', 0)).toBe('')
  })
  test('shortPath', () => {
    expect(shortPath('/repo/a.ts', '/repo/')).toBe('a.ts')
    expect(shortPath('src/a.ts')).toBe('src/a.ts')
  })
  test('shortModel', () => {
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
    expect(shortModel('claude-opus-5-5[1m]')).toBe('opus 5.5')
    expect(shortModel('claude-3-5-sonnet-20241022')).toBe('sonnet 3.5')
    expect(shortModel('haiku')).toBe('haiku')
    expect(shortModel(undefined)).toBeUndefined()
  })
  test('parseCommand', () => {
    expect(parseCommand('')).toBe('toggle')
    expect(parseCommand(' Clear ')).toBe('clear')
    expect(parseCommand('open')).toBe('open')
    expect(parseCommand('nope')).toBe('help')
  })
})

describe('cards', () => {
  const cards = [
    card({ key: 'a', status: 'done', startedAt: 0, endedAt: 5_000 }),
    card({ key: 'b', status: 'running', startedAt: 1_000 }),
    card({ key: 'c', status: 'failed', startedAt: 0, endedAt: 9_000 }),
    card({ key: 'd', status: 'running', startedAt: 500 }),
  ]
  test('counts, status line and header', () => {
    expect(countByStatus(cards)).toEqual({ running: 2, done: 1, failed: 1 })
    expect(statusText(cards)).toBe('⚙ 2 agents running')
    expect(statusText(cards.slice(0, 2))).toBe('⚙ 1 agent running')
    expect(statusText([cards[0] as AgentDeckCard])).toBeUndefined()
    expect(newestRunning(cards)?.key).toBe('b')
    expect(statusText(cards, true)).toBe(`⚙ 2 · ${(cards[1] as AgentDeckCard).title}`)
    expect(statusText([cards[0] as AgentDeckCard], true)).toBeUndefined()
    expect(headerText(cards)).toBe('2 running · 1 done · 1 failed')
    expect(headerText([])).toBe('No subagents yet')
  })
  test('running first, then the latest finished', () => {
    expect(orderCards(cards).map(one => one.key)).toEqual(['b', 'd', 'c', 'a'])
  })
  test('elapsed ticks while running and stops once finished', () => {
    expect(elapsedOf(cards[1] as AgentDeckCard, 4_000)).toBe(3_000)
    expect(elapsedOf(cards[0] as AgentDeckCard, 60_000)).toBe(5_000)
  })
})

describe('inline deck', () => {
  test('a stamped markdown snapshot, running first', () => {
    const at = new Date(2026, 0, 1, 9, 5, 7).getTime()
    const text = inlineDeckText(
      [
        card({ key: 'x', status: 'done', title: 'Old', startedAt: at - 9_000, endedAt: at - 4_000, lastTool: 'Read a.ts' }),
        card({ key: 'y', status: 'running', title: 'New', model: 'claude-haiku-4-5', startedAt: at - 3_000, currentTool: 'Grep "x"' }),
      ],
      at,
    )
    expect(formatClock(at)).toBe('09:05:07')
    expect(text.split('\n')).toEqual([
      'Agent deck · 1 running · 1 done · as of 09:05:07',
      '- ● **New** · haiku 4.5 · Explore · 3s · ▸ Grep "x"',
      '- ✓ **Old** · Explore · 5s · last Read a.ts',
    ])
  })
})

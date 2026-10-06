import { describe, expect, test } from 'claude-code/testing'

import {
  answerDetected,
  detectQuestion,
  formatAskAnswer,
  formatOneAnswer,
  relativeTime,
  statusText,
} from '../hooks/lib'
import type { QuestionLogEntry } from '../types'

describe('detectQuestion: asks', () => {
  const asks: Array<[string, string, string[]]> = [
    ['a plain closing question', 'I fixed the path.\n\nShould I also add a test for it?', ['Should I also add a test for it?']],
    ['a question in the last sentence of a paragraph', 'Done. The build passes now. Want me to push it?', ['Want me to push it?']],
    ['a question followed by a short closer', 'I can do either. Which do you prefer? Let me know.', ['Which do you prefer?']],
    ['a question introducing options', 'Two ways to go:\n\nWhich would you like?\n- Keep the cache\n- Drop it', ['Which would you like?']],
    ['a question quoting text', 'You said "ship it." Did you mean today?', ['Did you mean today?']],
    ['a numbered list of questions', 'Before I start:\n\n1. Should the API be public?\n2. Do you want tests too?', ['Should the API be public?', 'Do you want tests too?']],
    ['a bold question', 'All set.\n\n**Do you want me to deploy?**\nIt takes a minute.\n\nOr shall I wait?', ['Or shall I wait?']],
    ['a question with inline code', 'Should I rename `foo?` to `bar`?', ['Should I rename foo to bar?']],
  ]
  for (const [name, text, questions] of asks) {
    test(name, () => {
      const found = detectQuestion(text)
      expect(found.isQuestion).toBe(true)
      expect(found.questions).toEqual(questions)
    })
  }
})

describe('detectQuestion: does not ask', () => {
  const quiet: Array<[string, string]> = [
    ['a reply with no question', 'I fixed the path and the tests pass.'],
    ['a rhetorical heading mid text', '## Why does this fail?\n\nThe path was relative. I made it absolute and the tests pass.'],
    ['a rhetorical question answered in the same paragraph', 'Why does this fail? Because the path is relative, so I made it absolute.'],
    ['a question earlier in the reply only', 'Should we cache it? I checked: no.\n\nI removed the cache and the tests pass.'],
    ['a question inside a code fence', 'Here is the check:\n\n```js\nconst ok = isReady() ? go() : wait()\nwhy?\n```'],
    ['a reply ending on a code block after a question', 'Is this what you meant?\n\n```\nnpm test\n```'],
    ['a quoted question', 'The error said "is the file missing?" and it was.'],
    ['a block quote', 'You wrote:\n\n> can we ship this today?'],
    ['a question in a URL', 'Docs are at https://example.com/search?q=hooks'],
    ['a reply ending on a heading', 'Notes below.\n\n## What next?'],
    ['a question in inline code', 'I added a guard: `if (ready?)` now returns early.'],
    ['an empty reply', ''],
  ]
  for (const [name, text] of quiet) {
    test(name, () => {
      const found = detectQuestion(text)
      expect(found.isQuestion).toBe(false)
      expect(found.questions).toHaveLength(0)
    })
  }
})

describe('answers', () => {
  const QUESTIONS = [
    {
      question: 'Which auth method?',
      header: 'Auth',
      multiSelect: false,
      options: [{ label: 'OAuth' }, { label: 'API key' }],
    },
    {
      question: 'Which signals?',
      header: 'Signals',
      multiSelect: true,
      options: [{ label: 'Logs' }, { label: 'Metrics' }, { label: 'Traces' }],
    },
  ]

  test('formats single, multi-select and Other answers', () => {
    expect(formatOneAnswer('OAuth', ['OAuth', 'API key'], false)).toBe('OAuth')
    expect(formatOneAnswer('magic links', ['OAuth', 'API key'], false)).toBe('Other: "magic links"')
    expect(formatOneAnswer('Logs, Traces', ['Logs', 'Metrics', 'Traces'], true)).toBe('Logs, Traces')
    expect(formatOneAnswer('Logs, profiles, maybe', ['Logs', 'Metrics'], true)).toBe('Logs, Other: "profiles, maybe"')
    expect(formatOneAnswer('  ', ['Logs'], true)).toBe('(no answer)')
  })

  test('joins several questions by header', () => {
    const answer = formatAskAnswer(QUESTIONS, { 'Which auth method?': 'API key', 'Which signals?': 'Logs, Metrics' })
    expect(answer).toBe('Auth: API key; Signals: Logs, Metrics')
  })

  test('falls back to free text typed instead of the options', () => {
    expect(formatAskAnswer(QUESTIONS.slice(0, 1), {}, 'neither, use SSO')).toBe('Other: "neither, use SSO"')
  })

  test('answers open detected questions with the first 200 characters', () => {
    const log: QuestionLogEntry[] = [
      { id: 'a', kind: 'ask', at: 0, questions: [{ text: 'Q?' }] },
      { id: 'd', kind: 'detected', at: 0, questions: [{ text: 'Ship it?' }] },
    ]
    const answered = answerDetected(log, 'x'.repeat(500), 42)
    expect(answered[0]?.answer).toBeUndefined()
    expect(answered[1]?.answer).toHaveLength(200)
    expect(answered[1]?.answeredAt).toBe(42)
    expect(statusText(log)).toBe('? 2 open')
    expect(statusText(answered)).toBe('? 1 open')
    expect(statusText([])).toBeUndefined()
  })

  test('relative times', () => {
    expect(relativeTime(0, 3_000)).toBe('just now')
    expect(relativeTime(0, 42_000)).toBe('42s ago')
    expect(relativeTime(0, 5 * 60_000)).toBe('5m ago')
    expect(relativeTime(0, 3 * 3_600_000)).toBe('3h ago')
    expect(relativeTime(0, 50 * 3_600_000)).toBe('2d ago')
  })
})

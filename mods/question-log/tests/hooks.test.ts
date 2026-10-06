import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin, TestOptions } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf } from 'claude-code'

import type { QuestionLogEntry } from '../types'

const PLUGIN = 'question-log'

/** Reads the plugin's log for the test: the test's `$` has no state noun, a plugin's has. */
const PROBE: Plugin = {
  name: 'probe',
  register(on) {
    on('command.run', { command: 'probe-log' }, async $ => {
      const { value } = await $.state.get({ plugin: 'question-log', key: 'log' } as const)
      return { text: JSON.stringify(value ?? []) }
    })
  },
}

function withProbe(options: TestOptions = {}): TestOptions {
  return { ...options, plugins: [PROBE] }
}

async function readLog($: Engine): Promise<QuestionLogEntry[]> {
  const ran = await $.command.run({
    command: 'probe-log',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  return JSON.parse(ran.text ?? '[]') as QuestionLogEntry[]
}
const SURFACES = ['terminal', 'desktop', 'mobile'] as const

const REPLY = 'I fixed the relative path and the suite passes.\n\nShould I also add a regression test?'

const PANE: RenderPropsOf['Pane'] = {
  title: 'Questions',
  isFocused: false,
  bodyColumns: 72,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

/** The engine beneath the plugin: a clock, the status line, and the bottoms of the events these tests raise. */
function world(on: On) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const statuses: Array<string | undefined> = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  return { clock, statuses }
}

async function endTurn($: Engine, answer: string, turnId: string) {
  await $.turn.complete({ answer, durationMs: 1200, isAborted: false, turnId, reason: 'answer' })
}

test('captures an AskUserQuestion call and its answers', withProbe(), async ($, on) => {
  world(on)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({
    result: {
      questions: e.questions,
      answers: { 'Which auth method?': 'magic links', 'Which signals?': 'Logs, Traces' },
    },
  }))

  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which auth method?',
        header: 'Auth',
        multiSelect: false,
        options: [
          { label: 'OAuth', description: 'Sign in with a provider' },
          { label: 'API key', description: 'A static key' },
        ],
      },
      {
        question: 'Which signals?',
        header: 'Signals',
        multiSelect: true,
        options: [
          { label: 'Logs', description: 'Text logs' },
          { label: 'Metrics', description: 'Counters' },
          { label: 'Traces', description: 'Spans' },
        ],
      },
    ],
  })

  const value = await readLog($)
  expect(value).toHaveLength(1)
  expect(value[0]).toMatchObject({
    kind: 'ask',
    questions: [
      { header: 'Auth', text: 'Which auth method?', options: ['OAuth', 'API key'] },
      { header: 'Signals', text: 'Which signals?', options: ['Logs', 'Metrics', 'Traces'] },
    ],
    answer: 'Auth: Other: "magic links"; Signals: Logs, Traces',
  })
  expect(value[0]?.answeredAt).toBeDefined()
})

test('a dismissed AskUserQuestion is logged as dismissed', withProbe(), async ($, on) => {
  world(on)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Go?',
        header: 'Go',
        multiSelect: false,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
      },
    ],
  })
  const value = await readLog($)
  expect(value[0]?.answer).toBe('(dismissed)')
})

test('a detected question is answered by the next prompt', withProbe(), async ($, on) => {
  const { statuses } = world(on)
  await endTurn($, 'All done, the tests pass.', 't0')
  expect(await readLog($)).toHaveLength(0)

  await endTurn($, REPLY, 't1')
  let value = await readLog($)
  expect(value).toHaveLength(1)
  expect(value[0]).toMatchObject({
    kind: 'detected',
    questions: [{ text: 'Should I also add a regression test?' }],
  })
  expect(value[0]?.answer).toBeUndefined()
  expect(statuses[statuses.length - 1]).toBe('? 1 open')

  // A slash command and a plugin's prompt answer nothing.
  await $.prompt.submit({ text: '/questions', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'tick', wait: false, origin: { kind: 'plugin', name: 'other' } })
  expect((await readLog($))[0]?.answer).toBeUndefined()

  const reply = `Yes please. ${'Cover the windows paths too. '.repeat(20)}`
  await $.prompt.submit({ text: reply, wait: false, origin: { kind: 'composer' } })
  value = await readLog($)
  expect(value[0]?.answer).toStartWith('Yes please. Cover the windows paths too.')
  expect(value[0]?.answer?.length).toBe(200)
  expect(value[0]?.answeredAt).toBeDefined()
  expect(statuses.length).toBeGreaterThan(1)
  expect(statuses[statuses.length - 1]).toBeUndefined()
})

test('subagent and aborted turns log nothing', withProbe(), async ($, on) => {
  world(on)
  await $.turn.complete({ answer: REPLY, durationMs: 5, isAborted: false, turnId: 's', reason: 'answer', agentId: 'agent-1' })
  await $.turn.complete({ answer: REPLY, durationMs: 5, isAborted: true, turnId: 'a', reason: 'aborted' })
  expect(await readLog($)).toHaveLength(0)
})

test('detectQuestions off logs nothing', withProbe({ options: { detectQuestions: false } }), async ($, on) => {
  world(on)
  await endTurn($, REPLY, 't1')
  expect(await readLog($)).toHaveLength(0)
})

test('highlights a flagged reply on every surface', async ($, on) => {
  world(on)
  await endTurn($, REPLY, 't1')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AssistantMessage',
      props: { text: REPLY, isFirstOfReply: true },
    })
    const box = await ui.find({ type: 'Box' })
    expect(box?.props.borderStyle).toBe('round')
    expect(box?.props.borderColor).toBe('yellow')
    expect(await ui.find({ type: 'Text', text: '? Question for you' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: 'regression test?' })).toBeDefined()
    await ui.unmount()
  }

  await $.prompt.submit({ text: 'yes', wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: REPLY, isFirstOfReply: true },
  })
  expect((await ui.find({ type: 'Box' }))?.props.borderColor).toBe('magenta')
  expect(await ui.find({ type: 'Text', text: 'answered' })).toBeDefined()
  await ui.unmount()
})

test('passes through replies that are not flagged, and with highlight off', { options: { highlight: false } }, async ($, on) => {
  world(on)
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, e.props.text) as RenderElement
  })
  await endTurn($, REPLY, 't1')
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: REPLY, isFirstOfReply: true },
  })
  expect(await ui.find({ type: 'Box' })).toBeUndefined()
  await ui.unmount()
})

test('passes through an unflagged reply', async ($, on) => {
  world(on)
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, e.props.text) as RenderElement
  })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: 'Why does this fail? Because the path is relative.', isFirstOfReply: true },
  })
  expect(await ui.find({ type: 'Box' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Because' })).toBeDefined()
  await ui.unmount()
})

test('the pane lists questions and answers on every surface', async ($, on) => {
  const { clock } = world(on)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({
    result: { questions: [], answers: { 'Which database?': 'Postgres' } },
  }))
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which database?',
        header: 'DB',
        multiSelect: false,
        options: [
          { label: 'Postgres', description: '' },
          { label: 'SQLite', description: '' },
        ],
      },
    ],
  })
  await clock.advance(5 * 60_000)
  await endTurn($, REPLY, 't1')
  await clock.advance(2 * 60_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'question-log', props: PANE })
    expect(await ui.find({ type: 'Text', text: '2 questions · 1 open' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '[DB] Which database?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'options: Postgres · SQLite' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '↳ Postgres' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '7m ago' })).toBeDefined()
    const open = await ui.find({ type: 'Text', text: 'Should I also add a regression test?' })
    expect(open?.props.color).toBe('yellow')
    // Newest at the bottom: the detected question follows the AskUserQuestion one.
    const all = await ui.findAll({ type: 'Text', text: /Which database\?|regression test\?/ })
    expect(all.map(one => one.text)).toEqual(['[DB] Which database?', 'Should I also add a regression test?'])
    await ui.unmount()
  }
})

test('the pane says when there is nothing yet', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'question-log', props: PANE })
    expect(await ui.find({ type: 'Text', text: 'No questions yet' })).toBeDefined()
    await ui.unmount()
  }
})

test('/questions toggles the pane and /questions clear empties the log', withProbe(), async ($, on) => {
  world(on)
  let isUp = false
  on('ui.panes', () => ({ value: isUp ? [{ id: 'question-log', title: 'Questions', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.open', () => ((isUp = true), { value: { isPlaced: true as const } }))
  on('ui.close', () => ((isUp = false), { value: undefined }))
  const run = (args: string) =>
    $.command.run({
      command: 'questions',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })

  expect((await run('')).text).toBe('Question log opened.')
  expect(isUp).toBe(true)
  expect((await run('')).text).toBe('Question log closed.')
  expect(isUp).toBe(false)

  await endTurn($, REPLY, 't1')
  expect(await readLog($)).toHaveLength(1)
  expect((await run('clear')).text).toBe('Question log cleared.')
  expect(await readLog($)).toHaveLength(0)
  expect((await run('bogus')).text).toBe('Usage: /questions [clear]')
})

/** Opens the pane undrawn, as a session whose surfaces place no panes answers. */
function noPanes(on: On) {
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'the attached surfaces place no panes' } }))
  on('ui.close', () => ({ value: undefined }))
}

async function seedLog($: Engine, on: On, clock: { advance: (ms: number) => Promise<unknown> }) {
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({
    result: { questions: [], answers: { 'Which database?': 'Postgres' } },
  }))
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which database?',
        header: 'DB',
        multiSelect: false,
        options: [
          { label: 'Postgres', description: '' },
          { label: 'SQLite', description: '' },
        ],
      },
    ],
  })
  await clock.advance(5 * 60_000)
  await endTurn($, REPLY, 't1')
}

test('/questions answers inline when the pane cannot be placed', async ($, on) => {
  const { clock } = world(on)
  noPanes(on)
  await seedLog($, on, clock)
  const ran = await $.command.run({
    command: 'questions',
    args: '',
    origin: { kind: 'bridge' },
    presentation: { isFullscreen: false, columns: 40 },
  })
  expect(ran.text).toStartWith('Question log (no pane here, shown inline):')
  expect(ran.text).toContain('2 questions · 1 open')
  // Open first, then the answered one with its answer.
  const text = ran.text ?? ''
  expect(text.indexOf('regression test?')).toBeLessThan(text.indexOf('Which database?'))
  expect(text).toContain('↳ Postgres')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'CommandOutput',
      props: { command: 'questions', args: '', text, isErrored: false },
      viewport: { columns: 40, rows: 30, isFullscreen: false },
    })
    expect(await ui.find({ type: 'Text', text: '2 questions · 1 open' })).toBeDefined()
    const rows = await ui.findAll({ type: 'Text', text: /^(\[DB\] Which database\?|Should I also add a regression test\?)$/ })
    expect(rows.map(one => one.text)).toEqual(['Should I also add a regression test?', '[DB] Which database?'])
    expect((await ui.find({ type: 'Text', text: /^Should I also add a regression test\?$/ }))?.props.color).toBe('yellow')
    expect(await ui.find({ type: 'Text', text: '↳ Postgres' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the inline log keeps open questions first and caps the list', async ($, on) => {
  world(on)
  noPanes(on)
  for (let i = 0; i < 25; i++) {
    await endTurn($, `Step ${i} done.\n\nShall I go on with step ${i + 1}?`, `t${i}`)
    if (i < 24) await $.prompt.submit({ text: `yes ${i}`, wait: false, origin: { kind: 'composer' } })
  }
  const ran = await $.command.run({
    command: 'questions',
    args: '',
    origin: { kind: 'bridge' },
    presentation: { isFullscreen: false, columns: 40 },
  })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'mobile',
    component: 'CommandOutput',
    props: { command: 'questions', args: '', text: ran.text ?? '', isErrored: false },
    viewport: { columns: 40, rows: 30, isFullscreen: false },
  })
  expect(await ui.find({ type: 'Text', text: '25 questions · 1 open' })).toBeDefined()
  const rows = await ui.findAll({ type: 'Text', text: /^Shall I go on/ })
  expect(rows).toHaveLength(20)
  expect(rows[0]?.text).toBe('Shall I go on with step 25?')
  expect(rows[1]?.text).toBe('Shall I go on with step 24?')
  expect(await ui.find({ type: 'Text', text: '5 older not shown' })).toBeDefined()
  await ui.unmount()
})

test('mobile draws /questions inline even where a pane opened elsewhere', async ($, on) => {
  const { clock } = world(on)
  on('ui.render', { component: 'CommandOutput' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, e.props.text) as RenderElement
  })
  await seedLog($, on, clock)
  const props: RenderPropsOf['CommandOutput'] = {
    command: 'questions',
    args: '',
    text: 'Question log opened.',
    isErrored: false,
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'CommandOutput', props })
    expect(await ui.find({ type: 'Text', text: 'Question log opened.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 questions' })).toBeUndefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'mobile', component: 'CommandOutput', props })
  expect(await ui.find({ type: 'Text', text: '2 questions · 1 open' })).toBeDefined()
  await ui.unmount()

  // `/questions clear` and other commands' rows pass through on every surface.
  for (const surface of SURFACES) {
    const cleared = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'CommandOutput',
      props: { ...props, args: 'clear', text: 'Question log cleared.' },
    })
    expect(await cleared.find({ type: 'Text', text: 'Question log cleared.' })).toBeDefined()
    await cleared.unmount()
    const other = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'CommandOutput',
      props: { ...props, command: 'cost', text: 'Total cost: $0.12' },
    })
    expect(await other.find({ type: 'Text', text: 'Total cost' })).toBeDefined()
    await other.unmount()
  }
})

test('the status line counts open questions for every surface', async ($, on) => {
  const { statuses } = world(on)
  await endTurn($, REPLY, 't1')
  await endTurn($, 'Done.\n\nWant me to push the branch?', 't2')
  expect(statuses[statuses.length - 1]).toBe('? 2 open')
})

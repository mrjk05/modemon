import { expect, mock, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const PANE = 'agent-deck'
const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Agents',
  isFocused: false,
  bodyColumns: 56,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const VIEWPORT = { columns: 160, rows: 40, isFullscreen: true }

test('an Agent tool call draws a running card that ticks, then finishes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'Agent' }, () => ({
    result: {
      status: 'async_launched' as const,
      agentId: 'agent-1',
      description: 'Find auth middleware',
      prompt: 'Look for where the JWT is verified.',
      outputFile: '/tmp/agent-1.out',
      resolvedModel: 'claude-haiku-4-5-20251001',
    },
  }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  await $.tool.call({
    tool: 'Agent',
    description: 'Find auth middleware',
    prompt: 'Look for where the JWT is verified.\nReport file and line.',
    subagent_type: 'Explore',
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'agent-deck',
      surface,
      component: 'Pane',
      requestId: PANE,
      props: PANE_PROPS,
      viewport: VIEWPORT,
    })
    expect(await ui.find({ type: 'Text', text: /Find auth middleware/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Explore · haiku 4\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Look for where the JWT is verified\. Report/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^0s$/ })).toBeDefined()
    await ui.unmount()
  }

  await clock.advance(3_000)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'agent-deck', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS, viewport: VIEWPORT })
    expect(await ui.find({ type: 'Text', text: /^3s$/ })).toBeDefined()
    await ui.unmount()
  }

  expect(statuses).toContain('⚙ 1 agent running')

  await $.turn.complete({
    answer: 'Found it in src/auth.ts:12',
    durationMs: 3_000,
    isAborted: false,
    turnId: 'turn-1',
    agentId: 'agent-1',
    reason: 'answer',
  })
  await clock.advance(10_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'agent-deck', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS, viewport: VIEWPORT })
    expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^3s$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/agents clear/ })).toBeDefined()
    await ui.unmount()
  }
  expect(statuses.at(-1)).toBeUndefined()
})

test('a failed foreground Agent call shows a failed card', async ($, on) => {
  mock.clock(on, { now: 5_000 })
  on('tool.call', { tool: 'Agent' }, () => ({ deny: 'Agents are off here.' }))

  await $.tool.call({ tool: 'Agent', description: 'Write tests', prompt: 'Add unit tests for lib.ts' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'agent-deck', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS, viewport: VIEWPORT })
    expect(await ui.find({ type: 'Text', text: /Write tests/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 failed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Agents are off here\./ })).toBeDefined()
    await ui.unmount()
  }
})

test('an empty deck says how cards appear', async ($, on) => {
  mock.clock(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'agent-deck', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS, viewport: VIEWPORT })
    expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
    await ui.unmount()
  }
})

test('agent.spawn links the model, auto-opens docked, and /agents clear removes finished cards', async ($, on) => {
  mock.clock(on, { now: 0 })
  const opened: string[] = []
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-7' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: e.props.word })
  })

  // The spinner draws while a turn runs: the deck learns the layout docks panes.
  await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'terminal',
    component: 'Spinner',
    props: { word: 'Working', message: null, suffix: '…', mode: 'tool-use' },
    viewport: VIEWPORT,
  })

  await $.agent.spawn({
    tool_use_id: 'toolu_spawn_1',
    prompt: 'Review the diff for bugs',
    description: 'Review diff',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  expect(opened).toEqual([PANE])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'agent-deck', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS, viewport: VIEWPORT })
    expect(await ui.find({ type: 'Text', text: /Review diff/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /general-purpose · opus 5\.5/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't', agentId: 'agent-7', reason: 'aborted' })
  const cleared = await $.command.run({
    command: 'agents',
    args: 'clear',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(cleared.text).toBe('Cleared 1 finished agent.')

  const ui = await $.ui.mount({ plugin: 'agent-deck', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS, viewport: VIEWPORT })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
})

test('does not open by itself on the main screen, where a pane is no sidebar', async ($, on) => {
  mock.clock(on, { now: 0 })
  const opened: string[] = []
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-9' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: e.props.word })
  })
  await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'terminal',
    component: 'Spinner',
    props: { word: 'Working', message: null, suffix: '…', mode: 'tool-use' },
    viewport: { columns: 200, rows: 40, isFullscreen: false },
  })
  await $.agent.spawn({
    tool_use_id: 'toolu_spawn_2',
    prompt: 'Summarise the README',
    description: 'Summarise README',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  expect(opened).toEqual([])
})

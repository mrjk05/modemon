import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__checklist__checklist'
const ROOT = '/work/repo'
/** Surfaces that raise AbovePrompt (the band). */
const SURFACES = ['terminal', 'desktop'] as const
/** Surfaces that raise Pane and CommandOutput. */
const ALL_SURFACES = ['terminal', 'desktop', 'mobile'] as const

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE_PROPS = {
  title: 'Checklist',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

/** The world beneath the plugin: a store in memory (returned, to inspect), a clock, and a repo. */
function world(on: On, entries: Record<string, unknown> = {}, statuses: (string | undefined)[] = []): Map<string, unknown> {
  const store = new Map<string, unknown>(Object.entries(entries))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  mock.clock(on, { now: 1_000 })
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: `${ROOT}/sub` }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__checklist__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  return store
}

/** Every string drawn anywhere in a tree, in order. */
function textsOf(tree: unknown): string[] {
  if (typeof tree === 'string') return tree === '' ? [] : [tree]
  if (typeof tree === 'number') return [String(tree)]
  if (Array.isArray(tree)) return tree.flatMap(textsOf)
  if (tree === null || typeof tree !== 'object') return []
  const el = tree as { children?: unknown; props?: { children?: unknown; label?: unknown } }
  const label = el.props?.label
  return [...(typeof label === 'string' ? [label] : []), ...textsOf(el.children ?? el.props?.children)]
}

const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

const startSession = ($: { session: { start: (e: { cwd: string; surface: 'terminal'; isInteractive: boolean }) => Promise<unknown> } }) =>
  $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

test('the tool adds, starts and finishes items and persists them per repo root', async ($, on) => {
  const store = world(on)
  await startSession($)

  const added = await $.tool.call({ tool: TOOL, action: 'add', items: ['Write tests', 'Fix bug', 'Ship it'] })
  expect(added.deny).toBeUndefined()
  expect(added.result).toBe(
    ['Checklist 0/3 done ([ ] todo, [>] doing, [x] done):', '[ ] #1 Write tests', '[ ] #2 Fix bug', '[ ] #3 Ship it'].join('\n'),
  )

  await $.tool.call({ tool: TOOL, action: 'start', ids: [1] })
  const finished = await $.tool.call({ tool: TOOL, action: 'done', ids: [1] })
  expect(String(finished.result)).toContain('[x] #1 Write tests')
  expect(String(finished.result)).toContain('Checklist 1/3 done')

  const stored = store.get(`list:${ROOT}`) as { id: number; status: string; doneAt?: number }[]
  expect(stored).toHaveLength(3)
  expect(stored[0]).toMatchObject({ id: 1, status: 'done', doneAt: 1_000 })

  const removed = await $.tool.call({ tool: TOOL, action: 'remove', ids: [3] })
  expect(String(removed.result)).not.toContain('Ship it')
  const cleared = await $.tool.call({ tool: TOOL, action: 'clear-done' })
  expect(cleared.result).toBe(['Checklist 0/1 done ([ ] todo, [>] doing, [x] done):', '[ ] #2 Fix bug'].join('\n'))
})

test('a bad tool call is refused with the reason and changes nothing', async ($, on) => {
  world(on)
  await startSession($)
  await $.tool.call({ tool: TOOL, action: 'add', items: ['One'] })
  const bad = await $.tool.call({ tool: TOOL, action: 'done', ids: [42] })
  expect(bad.isError === true || bad.deny !== undefined).toBe(true)
  const listed = await $.tool.call({ tool: TOOL, action: 'list' })
  expect(listed.result).toBe(['Checklist 0/1 done ([ ] todo, [>] doing, [x] done):', '[ ] #1 One'].join('\n'))
})

test('the tool needs no permission prompt', async ($, on) => {
  world(on)
  await startSession($)
  const { decision } = await $.tool.check({ tool: TOOL, input: { action: 'list' } })
  expect(decision).toBe('allow')
})

test('the list loads from the store at session start', async ($, on) => {
  world(on, {
    [`list:${ROOT}`]: [
      { id: 4, text: 'Old item', status: 'todo', createdAt: 1 },
      { id: 'junk' },
    ],
  })
  await startSession($)
  const listed = await $.tool.call({ tool: TOOL, action: 'list' })
  expect(listed.result).toBe(['Checklist 0/1 done ([ ] todo, [>] doing, [x] done):', '[ ] #4 Old item'].join('\n'))
})

test('/checklist add, done, undo, rm and clear', async ($, on) => {
  world(on)
  await startSession($)
  const run = (args: string) => $.command.run({ command: 'checklist', args, ...COMMAND })

  expect((await run('add Write the README')).text).toContain('Added: #1 Write the README')
  await run('add Publish')
  const doneOut = await run('done 1')
  expect(doneOut.text).toContain('Done: #1 Write the README')
  expect(doneOut.text).toContain('☑ 1/2')
  expect((await run('undo 1')).text).toContain('Reopened: #1')
  expect((await run('done 9')).text).toContain('No item #9')
  expect((await run('rm 2')).text).toContain('Removed: #2 Publish')
  await run('done 1')
  expect((await run('clear')).text).toContain('Cleared 1 done item')
  expect((await run('list')).text).toBe('Checklist is empty.')
  expect((await run('bogus')).text).toContain('Usage')
})

test('/checklist with no arguments toggles the pane', async ($, on) => {
  world(on)
  const panes = new Set<string>()
  on('ui.open', (_$, e) => {
    panes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: 'Checklist', isShown: true, isFocused: false, isPlaced: true })),
  }))
  await startSession($)
  expect((await $.command.run({ command: 'checklist', args: '', ...COMMAND })).text).toContain('opened')
  expect(panes.has('checklist')).toBe(true)
  expect((await $.command.run({ command: 'checklist', args: '', ...COMMAND })).text).toContain('closed')
  expect(panes.has('checklist')).toBe(false)
})

test('the band shows progress and the next item on terminal and desktop', async ($, on) => {
  world(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await startSession($)

  for (const surface of SURFACES) {
    const empty = await $.ui.mount({ plugin: 'checklist', surface, ...BAND })
    expect(await empty.find({ type: 'Text', text: /☑/ })).toBeUndefined()
    expect(await empty.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await empty.unmount()
  }

  await $.tool.call({ tool: TOOL, action: 'add', items: ['a', 'b', 'c', 'd', 'e', 'f', 'Write tests'] })
  await $.tool.call({ tool: TOOL, action: 'done', ids: [1, 2, 3, 4] })
  await $.tool.call({ tool: TOOL, action: 'remove', ids: [5, 6] })
  await $.tool.call({ tool: TOOL, action: 'add', items: ['x', 'y', 'z'] })
  await $.tool.call({ tool: TOOL, action: 'done', ids: [8, 9] })

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'checklist', surface, ...BAND })
    const texts = (await band.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts.slice(0, 2)).toEqual(['☑ 6/8 ▕████████░░▏ ', 'next: Write tests'])
    await band.unmount()
  }
})

test('the pane lists items and its buttons tick and remove them', async ($, on) => {
  const store = world(on)
  await startSession($)
  await $.tool.call({ tool: TOOL, action: 'add', items: ['First', 'Second'] })

  for (const surface of ALL_SURFACES) {
    const pane = await $.ui.mount({ plugin: 'checklist', surface, component: 'Pane', requestId: 'checklist', props: PANE_PROPS })
    expect((await pane.find({ type: 'Text', text: /☑ \d\/\d/ }))?.text).toContain('0/2')
    await pane.press({ key: 'tick-1' })
    expect((await pane.find({ type: 'Text', text: /☑ \d\/\d/ }))?.text).toContain('1/2')
    expect((await pane.find({ key: 'tick-1' }))?.props.label).toBe('☑')
    await pane.press({ key: 'tick-1' })
    expect((await pane.find({ type: 'Text', text: /☑ \d\/\d/ }))?.text).toContain('0/2')
    await pane.unmount()
  }

  const pane = await $.ui.mount({ plugin: 'checklist', surface: 'terminal', component: 'Pane', requestId: 'checklist', props: PANE_PROPS })
  await pane.press({ key: 'tick-2' })
  await pane.press({ key: 'clear-done' })
  expect(await pane.find({ key: 'row-2' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'Second' })).toBeUndefined()
  await pane.press({ key: 'rm-1' })
  expect(await pane.find({ key: 'empty' })).toBeDefined()
  expect(store.get(`list:${ROOT}`)).toEqual([])
})

test('the system prompt gets a checklist section only while items are open', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  await startSession($)
  const compose = () =>
    $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

  expect((await compose()).sections.map(s => s.id)).toEqual(['intro'])
  await $.tool.call({ tool: TOOL, action: 'add', items: ['Write tests'] })
  const section = (await compose()).sections.find(s => s.id === 'checklist:open-items')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('#1 Write tests')
  expect(section?.text).toContain(TOOL)
  await $.tool.call({ tool: TOOL, action: 'done', ids: [1] })
  expect((await compose()).sections.map(s => s.id)).toEqual(['intro'])
})

test('the band shares the row: what the hooks beneath draw is stacked under it', async ($, on) => {
  world(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="other-band">
        <Text>ctx 42%</Text>
      </Box>
    )
  })
  await startSession($)
  await $.tool.call({ tool: TOOL, action: 'add', items: ['Write tests'] })

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'checklist', surface, ...BAND })
    const texts = textsOf(await band.drawn())
    const mine = texts.findIndex(text => text.startsWith('☑ 0/1'))
    const theirs = texts.indexOf('ctx 42%')
    expect(mine).toBeGreaterThanOrEqual(0)
    expect(theirs).toBeGreaterThan(mine)
    await band.unmount()
  }
})

test('the band draws alone when nothing beneath draws', async ($, on) => {
  world(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await startSession($)
  await $.tool.call({ tool: TOOL, action: 'add', items: ['Write tests'] })
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'checklist', surface, ...BAND })
    expect(await band.drawn()).toMatchObject({ type: 'Box', props: { key: 'checklist-band' } })
    await band.unmount()
  }
})

test('the status line shows progress and the next item, and clears when the list empties', async ($, on) => {
  const statuses: (string | undefined)[] = []
  world(on, {}, statuses)
  await startSession($)
  expect(statuses.at(-1)).toBeUndefined()
  await $.tool.call({ tool: TOOL, action: 'add', items: ['Write tests', 'Ship it', 'Party'] })
  expect(statuses.at(-1)).toBe('☑ 0/3 · next: Write tests')
  await $.tool.call({ tool: TOOL, action: 'done', ids: [1] })
  expect(statuses.at(-1)).toBe('☑ 1/3 · next: Ship it')
  await $.tool.call({ tool: TOOL, action: 'done', ids: [2, 3] })
  expect(statuses.at(-1)).toBe('☑ 3/3 · all done')
  await $.tool.call({ tool: TOOL, action: 'clear-done' })
  expect(statuses.at(-1)).toBeUndefined()
})

const commandRow = (args: string, text: string) =>
  ({
    component: 'CommandOutput',
    props: { command: 'checklist', args, text, isErrored: false },
    viewport: { columns: 40, rows: 30 },
  }) as const

test('/checklist draws the list inline with tappable ticks on mobile', async ($, on) => {
  const store = world(on)
  await startSession($)
  await $.tool.call({ tool: TOOL, action: 'add', items: ['First', 'Second'] })

  const row = await $.ui.mount({ plugin: 'checklist', surface: 'mobile', ...commandRow('', 'Checklist pane closed.') })
  expect((await row.find({ type: 'Text', text: /☑ \d\/\d/ }))?.text).toContain('0/2')
  await row.press({ key: 'tick-2' })
  expect((await row.find({ key: 'tick-2' }))?.props.label).toBe('☑')
  expect((await row.find({ type: 'Text', text: /☑ \d\/\d/ }))?.text).toContain('1/2')
  const stored = store.get(`list:${ROOT}`) as { id: number; status: string }[]
  expect(stored.find(item => item.id === 2)?.status).toBe('done')
  await row.unmount()
})

test('/checklist output: inline list when the pane is not placed or for list, the plain row otherwise', async ($, on) => {
  world(on)
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'no surface places panes' } }))
  on('ui.render', { component: 'CommandOutput' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine-row">{e.props.text}</Text>
  })
  await startSession($)
  await $.tool.call({ tool: TOOL, action: 'add', items: ['First'] })

  const answer = await $.command.run({ command: 'checklist', args: '', ...COMMAND })
  expect(answer.text).toContain('[ ] #1 First')

  for (const surface of ALL_SURFACES) {
    const waiting = await $.ui.mount({ plugin: 'checklist', surface, ...commandRow('', String(answer.text)) })
    expect(await waiting.find({ key: 'tick-1' })).toBeDefined()
    await waiting.unmount()

    const listed = await $.ui.mount({ plugin: 'checklist', surface, ...commandRow('list', 'whatever') })
    expect(await listed.find({ key: 'tick-1' })).toBeDefined()
    await listed.unmount()

    const added = await $.ui.mount({ plugin: 'checklist', surface, ...commandRow('add x', 'Added: #2 x') })
    expect(await added.find({ key: 'tick-1' })).toBeUndefined()
    await added.unmount()
  }

  for (const surface of SURFACES) {
    const opened = await $.ui.mount({ plugin: 'checklist', surface, ...commandRow('', 'Checklist pane opened.') })
    expect(await opened.find({ key: 'tick-1' })).toBeUndefined()
    await opened.unmount()
  }
})

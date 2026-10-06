import type { CommandRunInput, On, RenderElement, RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { autoSwatch, byName } from '../hooks/lib'

const PLUGIN = 'project-color'
const ROOT = '/work/modemon'
const BAND_SURFACES = ['terminal', 'desktop'] as const
const ALL_SURFACES = ['terminal', 'desktop', 'mobile'] as const
const AUTO = autoSwatch('modemon')
const RED = byName('red')!

/** The band's props as a terminal `columns` wide measures them. */
function bandProps(
  columns: number,
  opts: { hasSurvey?: boolean; maxRows?: number } = {},
): RenderPropsOf['AbovePrompt'] {
  const maxRows = opts.maxRows ?? 10
  return {
    hasSurvey: opts.hasSurvey ?? false,
    isWorking: false,
    maxRows,
    bodyColumns: columns,
    scroll: { offset: 0, bodyRows: maxRows },
    view: {},
  }
}

/** `/<command> <args>` typed at the prompt. */
function command(args: string, name = 'color'): CommandRunInput {
  return { command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }
}

/** The world beneath the plugin: a store (returned to inspect), a repo on a branch, the status line. */
function world(on: On, entries: Record<string, unknown> = {}, engineDraws = true) {
  const store = new Map<string, unknown>(Object.entries(entries))
  const status: (string | undefined)[] = []
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: `${ROOT}/sub` }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.read', (_$, e) => {
    if (e.path === `${ROOT}/.git/HEAD`) return { value: 'ref: refs/heads/feature/x\n' }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('ui.status', (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  // The engine's own drawing (an empty band, the plain command row): what `next(e)` resolves to.
  if (engineDraws) on('ui.render', () => ({ type: 'engine', ref: 0 }) as RenderElement)
  return { store, status }
}

type Start = {
  session: { start: (e: { cwd: string; surface: 'terminal' | 'mobile'; isInteractive: boolean }) => Promise<unknown> }
}
const start = ($: Start, surface: 'terminal' | 'mobile' = 'terminal') =>
  $.session.start({ cwd: `${ROOT}/sub`, surface, isInteractive: true })

/** The band's stripe Text holding the project name. */
async function stripeOf(ui: {
  find: (q: { type: string; text: RegExp }) => Promise<{ props: Record<string, unknown> } | undefined>
}) {
  return ui.find({ type: 'Text', text: / ▌ modemon / })
}

test('the stripe is drawn full width in the auto colour, with the branch, on terminal and desktop', async ($, on) => {
  world(on)
  await start($)

  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(80) })
    const name = await stripeOf(ui)
    expect(name).toBeDefined()
    expect(name?.props['backgroundColor']).toBe(AUTO.hex)
    expect(name?.props['color']).toBe(AUTO.fg)
    expect(name?.props['bold']).toBe(true)
    const branch = await ui.find({ type: 'Text', text: / feature\/x / })
    expect(branch?.props['dimColor']).toBe(true)
    // Every cell of the row is painted: the runs add up to the band's width.
    const painted = await ui.findAll({ type: 'Text' })
    const row = painted.filter(t => t.props['backgroundColor'] === AUTO.hex)
    expect(row.map(t => t.text).join('').length).toBe(80)
    await ui.unmount()
  }
})

test('the stripe composes with a band drawn beneath it: ours on top, theirs below', async ($, on) => {
  world(on, {}, false)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return h(Box, { flexDirection: 'column' }, h(Text, {}, 'other band')) as RenderElement
  })
  await start($)

  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(60) })
    expect(await stripeOf(ui)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'other band' })).toBeDefined()
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const ours = texts.findIndex(t => t.includes('modemon'))
    const theirs = texts.findIndex(t => t.includes('other band'))
    expect(ours).toBeGreaterThanOrEqual(0)
    expect(ours).toBeLessThan(theirs)
    await ui.unmount()
  }
})

test('the stripe yields to a survey and to its setting', async ($, on) => {
  world(on)
  await start($)
  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AbovePrompt',
      props: bandProps(80, { hasSurvey: true }),
    })
    expect(await stripeOf(ui)).toBeUndefined()
    await ui.unmount()
  }
})

test('stripe off draws nothing of ours', { options: { stripe: false } }, async ($, on) => {
  world(on)
  await start($)
  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(80) })
    expect(await stripeOf(ui)).toBeUndefined()
    await ui.unmount()
  }
})

test('thickness 2 adds a second painted row', { options: { thickness: '2' } }, async ($, on) => {
  world(on)
  await start($)
  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(30) })
    const painted = (await ui.findAll({ type: 'Text' })).filter(t => t.props['backgroundColor'] === AUTO.hex)
    expect(painted.map(t => t.text).join('').length).toBe(60)
    await ui.unmount()
  }
})

test('/color <name> persists the override per repo root and recolours stripe and status', async ($, on) => {
  const { store, status } = world(on)
  await start($)
  expect(status.at(-1)).toBe(`${AUTO.emoji} modemon`)

  const pinned = await $.command.run(command('red'))
  expect(pinned.text).toContain('modemon: red #DC2626 (pinned)')
  expect(store.get(`override:${ROOT}`)).toBe('red')
  expect(status.at(-1)).toBe('🔴 modemon')

  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(80) })
    expect((await stripeOf(ui))?.props['backgroundColor']).toBe(RED.hex)
    await ui.unmount()
  }

  const custom = await $.command.run(command('#0af', 'project-color'))
  expect(custom.text).toContain('modemon: custom #00AAFF (pinned)')
  expect(store.get(`override:${ROOT}`)).toBe('#00AAFF')

  const bad = await $.command.run(command('#12345'))
  expect(bad.text).toContain('not a palette colour')
  expect(store.get(`override:${ROOT}`)).toBe('#00AAFF')

  const auto = await $.command.run(command('auto'))
  expect(auto.text).toContain(`modemon: ${AUTO.name} ${AUTO.hex} (auto)`)
  expect(store.has(`override:${ROOT}`)).toBe(false)
  expect(status.at(-1)).toBe(`${AUTO.emoji} modemon`)
})

test('a pinned colour is loaded from the store at session start', async ($, on) => {
  world(on, { [`override:${ROOT}`]: 'teal' })
  await start($)
  const shown = await $.command.run(command(''))
  expect(shown.text).toContain('modemon: teal')
  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(80) })
    expect((await stripeOf(ui))?.props['backgroundColor']).toBe(byName('teal')?.hex)
    await ui.unmount()
  }
})

test('/color output draws the colour and the palette as a tree on terminal, desktop and mobile', async ($, on) => {
  world(on)
  await start($)
  await $.command.run(command('magenta'))
  const { text = '' } = await $.command.run(command(''))

  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'CommandOutput',
      props: { command: 'color', args: '', text, isErrored: false },
      viewport: { columns: surface === 'mobile' ? 36 : 100, rows: 40 },
    })
    const head = await ui.find({ type: 'Text', text: / ▌ modemon / })
    expect(head?.props['backgroundColor']).toBe(byName('magenta')?.hex)
    expect(await ui.find({ type: 'Text', text: / magenta/ })).toBeDefined()
    const swatches = (await ui.findAll({ type: 'Text' })).filter(
      t => / {3}| ● /.test(t.text) && t.props['backgroundColor'],
    )
    expect(swatches).toHaveLength(12)
    expect(swatches.filter(t => t.text === ' ● ')).toHaveLength(1)
    await ui.unmount()
  }
})

test('an error row is left to the engine on every surface', async ($, on) => {
  world(on)
  await start($)
  const { text = '' } = await $.command.run(command('nope'))
  for (const surface of ALL_SURFACES) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'CommandOutput',
      props: { command: 'color', args: 'nope', text, isErrored: false },
    })
    expect(await ui.find({ type: 'Text', text: / ▌ / })).toBeUndefined()
    await ui.unmount()
  }
})

test('on the phone the status line carries the colour', async ($, on) => {
  const { status } = world(on, { [`override:${ROOT}`]: 'purple' })
  await start($, 'mobile')
  expect(status.at(-1)).toBe('🟣 modemon')
})

test('status line off leaves it alone', { options: { statusLine: false } }, async ($, on) => {
  const { status } = world(on)
  await start($)
  await $.command.run(command('red'))
  expect(status).toEqual([])
})

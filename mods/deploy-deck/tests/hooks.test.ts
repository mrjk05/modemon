import type { CommandRunInput, On, RenderElement, RenderPropsOf, RenderSurface } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import * as RN from './fixtures/render'
import * as F from './fixtures/repos'
import * as VC from './fixtures/vercel'

const PLUGIN = 'deploy-deck'
const ROOT = '/work/shop'
const T10 = Date.parse('2026-10-06T10:00:00Z')
const VERCEL_TOKEN = 'vcp_9Zk3LmQ8xR2tW7yB4nH6jF1sD5gA0cE'
const RENDER_TOKEN = 'rnd_Sx81kLmQ0pZt4Wv7Yb2Nc5Hd'
const VERCEL = { options: { vercelToken: VERCEL_TOKEN, useCli: false } }
const ALL_SURFACES = ['terminal', 'desktop', 'mobile'] as const
const BAND_SURFACES = ['terminal', 'desktop'] as const

type Answer = { status: number; body: unknown; headers?: Record<string, string> }

/** The world beneath the plugin: repo files, a store, the network, the screen. */
function world(on: On, files: Record<string, string>, net: (url: string) => Answer, surfaces: RenderSurface[] = ['terminal']) {
  const calls: { url: string; method: string | undefined; auth: string | undefined }[] = []
  const toasts: string[] = []
  const status: (string | undefined)[] = []
  const opened: string[] = []
  const placed = { now: true }
  mock.store(on)
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: [...surfaces] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.exists', (_$, e) => ({ value: files[e.path] !== undefined }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('http.fetch', (_$, e) => {
    calls.push({ url: e.url, method: e.init?.method, auth: e.init?.headers?.['Authorization'] })
    const answer = net(e.url)
    return {
      value: {
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        headers: answer.headers ?? {},
        text: JSON.stringify(answer.body),
      },
    }
  })
  on('process.run', () => {
    throw new Error('no host commands in this test')
  })
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', (_$, e) => (status.push(e.text), { value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: placed.now ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'no attached surface places panes' } }
  })
  return { calls, toasts, status, opened, placed }
}

function start($: { session: { start: (e: { cwd: string; surface: 'terminal' | 'mobile'; isInteractive: boolean }) => Promise<unknown> } }) {
  return $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

function command(args: string, kind: 'composer' | 'bridge' = 'composer'): CommandRunInput {
  return { command: 'deploys', args, origin: { kind }, presentation: { isFullscreen: true, columns: 160 } }
}

function bandProps(columns: number, maxRows = 6): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows, bodyColumns: columns, scroll: { offset: 0, bodyRows: maxRows }, view: {} }
}

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Deploys',
  isFocused: false,
  bodyColumns: 64,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

/** Another band mod beneath this one. */
function otherBand(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine band') as RenderElement
  })
}

const VERCEL_FILES = { [`${ROOT}/.vercel/project.json`]: F.VERCEL_PROJECT_JSON }

describe('poller', () => {
  test('a deploy goes building → live: one toast, then polling slows down', VERCEL, async ($, on) => {
    const clock = mock.clock(on, { now: T10 + 20_000 })
    let body: unknown = VC.DEPLOYMENTS
    const fake = world(on, VERCEL_FILES, () => ({ status: 200, body }))

    await start($)
    await clock.settle()
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toEqual({
      url: 'https://api.vercel.com/v7/deployments?projectId=prj_Qm8kd7Vf2LpXr0aNc3TyEw9H&limit=10&teamId=team_9aB8cD7eF6gH5iJ4kL3mN2oP',
      method: 'GET',
      auth: `Bearer ${VERCEL_TOKEN}`,
    })
    expect(fake.status.at(-1)).toBe('🚀 vercel building 0:17')
    expect(fake.toasts).toEqual([])

    // Fast while building: the next read is 10s later.
    await clock.advance(10_000)
    expect(fake.calls).toHaveLength(2)
    expect(fake.status.at(-1)).toBe('🚀 vercel building 0:27')

    body = VC.readyLater()
    await clock.advance(10_000)
    expect(fake.calls).toHaveLength(3)
    expect(fake.toasts).toEqual(['✓ vercel production live · a1b2c3d'])
    expect(fake.status.at(-1)).toBe('✓ prod live a1b2c3d')

    // Idle now: nothing for the next 110s, then a read at 120s, and no second toast.
    await clock.advance(110_000)
    expect(fake.calls).toHaveLength(3)
    await clock.advance(10_000)
    expect(fake.calls).toHaveLength(4)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.calls.every(call => call.method === 'GET')).toBe(true)

    const status = await $.command.run(command('status'))
    expect(status.text).toContain('Polling every 120s')
  })

  test('a rate limit backs the provider off, honouring Retry-After', VERCEL, async ($, on) => {
    const clock = mock.clock(on, { now: T10 + 20_000 })
    let limited = true
    const fake = world(on, VERCEL_FILES, () =>
      limited ? { status: 429, body: { error: { message: 'Too many requests' } }, headers: { 'retry-after': '300' } } : { status: 200, body: VC.DEPLOYMENTS },
    )
    await start($)
    await clock.settle()
    expect(fake.calls).toHaveLength(1)
    // Idle (nothing read yet) polls every 120s, but the provider rests 300s.
    await clock.advance(240_000)
    expect(fake.calls).toHaveLength(1)
    const status = await $.command.run(command('status'))
    expect(status.text).toMatch(/backing off \d+:\d\d \(rate\)/)
    expect(status.text).toContain('vercel: rate limited (HTTP 429)')
    limited = false
    await clock.advance(120_000)
    expect(fake.calls).toHaveLength(2)
    // /deploys refresh clears the backoff and reads at once.
    const refreshed = await $.command.run(command('refresh'))
    expect(refreshed.text).toBe('Refreshed 1 target: 1 in flight.')
    expect(fake.calls).toHaveLength(3)
  })

  test('a 401 never puts the token on screen', VERCEL, async ($, on) => {
    const clock = mock.clock(on, { now: T10 })
    const fake = world(on, VERCEL_FILES, () => ({ status: 401, body: { error: { code: 'forbidden', message: `Token ${VERCEL_TOKEN} is not valid` } } }))
    await start($)
    await clock.settle()
    const status = await $.command.run(command('status'))
    expect(status.text).toContain('vercel: not authorized (HTTP 401)')
    expect(status.text).toContain('vercelToken set')
    expect(status.text).not.toContain(VERCEL_TOKEN)
    const opened = await $.command.run(command(''))
    expect(opened.text).toBe('Deploys panel opened.')
    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PANE_PROPS, viewport: { columns: 120, rows: 40, isFullscreen: true } })
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
      expect(texts).toContain('not authorized')
      expect(texts).not.toContain(VERCEL_TOKEN)
      await ui.unmount()
    }
    expect(fake.status.every(text => text === undefined || !text.includes(VERCEL_TOKEN))).toBe(true)
  })
})

describe('band', () => {
  test('one row per in-flight deploy with its pipeline, above the other bands', VERCEL, async ($, on) => {
    const clock = mock.clock(on, { now: T10 + 72_000 + 3_000 })
    world(on, VERCEL_FILES, () => ({ status: 200, body: VC.DEPLOYMENTS }))
    otherBand(on)
    await start($)
    await clock.settle()

    for (const surface of BAND_SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(100) })
      expect(await ui.find({ type: 'Text', text: /^vercel · shop-web · production\s+$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '◉ building' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '○ deploying' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1:12$/ })).toBeDefined()
      const building = await ui.find({ type: 'Text', text: '◉ building' })
      expect(building?.props['color']).toBe('claude')
      // The failed preview and older deploys are not in flight: no rows.
      expect(await ui.find({ type: 'Text', text: /✗/ })).toBeUndefined()
      // Composition: the band beneath is stacked under ours.
      const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
      expect(all.at(-1)).toBe('engine band')
      await ui.unmount()
    }

    // Narrow: glyph pipeline with the stage word; very narrow: just the word.
    for (const surface of BAND_SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(48) })
      expect(await ui.find({ type: 'Text', text: ' building' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '◉ building' })).toBeUndefined()
      await ui.unmount()
      const tiny = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(24) })
      expect(await tiny.find({ type: 'Text', text: '◉ building' })).toBeDefined()
      await tiny.unmount()
    }
  })

  test('a finish stays a minute, then the band gives way to the one beneath', VERCEL, async ($, on) => {
    const clock = mock.clock(on, { now: T10 + 20_000 })
    let body: unknown = VC.DEPLOYMENTS
    world(on, VERCEL_FILES, () => ({ status: 200, body }))
    otherBand(on)
    await start($)
    await clock.settle()
    body = VC.readyLater()
    await clock.advance(10_000)

    for (const surface of BAND_SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(100) })
      expect(await ui.find({ type: 'Text', text: '✓ live' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
      await ui.unmount()
    }
    await clock.advance(120_000)
    for (const surface of BAND_SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(100) })
      expect(await ui.find({ type: 'Text', text: '✓ live' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('/deploys', () => {
  const BOTH = { options: { vercelToken: VERCEL_TOKEN, renderToken: RENDER_TOKEN, useCli: false, targets: 'render:shop-api' } }
  const route = (url: string): Answer => {
    if (url.startsWith('https://api.vercel.com/')) return { status: 200, body: VC.DEPLOYMENTS }
    if (url.startsWith('https://api.render.com/v1/services?name=shop-api')) return { status: 200, body: RN.SERVICES }
    if (url.startsWith('https://api.render.com/v1/services/srv-cq5n2lbv2p9c73a0kk0g/deploys')) return { status: 200, body: RN.DEPLOYS }
    return { status: 404, body: { message: 'Not Found' } }
  }

  test('the pane groups each target with its latest three deploys and links', BOTH, async ($, on) => {
    const clock = mock.clock(on, { now: T10 + 60_000 })
    const fake = world(on, VERCEL_FILES, route)
    await start($)
    await clock.settle()
    const opened = await $.command.run(command(''))
    expect(opened.text).toBe('Deploys panel opened.')
    expect(fake.opened).toEqual([PLUGIN])

    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PANE_PROPS, viewport: { columns: 140, rows: 40, isFullscreen: true } })
      expect(await ui.find({ type: 'Text', text: 'Deploys' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^render · shop-api/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^vercel · prj_Qm8kd7Vf2LpXr0aNc3TyEw9H/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '◉ building' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /production · a1b2c3d · main · 0:57/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✗ deploy failed' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✗ build failed' })).toBeDefined()
      // Latest three per target: the Vercel canceled one (4th) is left out.
      expect(await ui.find({ type: 'Text', text: '⊘ canceled' })).toBeUndefined()
      const links = await ui.findAll({ type: 'Link' })
      expect(links.map(link => link.props['href'])).toContain('https://vercel.com/acme/shop-web/8rTqJx3kQhG2bVnM5yLzP1aW')
      expect(links.map(link => link.props['href'])).toContain('https://shop-api.onrender.com')
      expect(links.every(link => link.props['label'] === 'open' || link.props['label'] === 'logs')).toBe(true)
      await ui.unmount()
    }
  })

  test('from the phone it answers inline, drawn as a card with links (mobile fallback)', BOTH, async ($, on) => {
    const clock = mock.clock(on, { now: T10 + 60_000 })
    const fake = world(on, VERCEL_FILES, route, ['mobile'])
    await start($)
    await clock.settle()
    const ran = await $.command.run(command('', 'bridge'))
    const text = ran.text ?? ''
    expect(fake.opened).toEqual([])
    expect(text.startsWith('Deploys · 2 targets')).toBe(true)
    expect(text).toContain('◉ **building** · production · `a1b2c3d` · main · 0:57 · [open](https://shop-web-9jaeg38me-acme.vercel.app)')
    // The status line is the phone's always-on view.
    expect(fake.status.at(-1)).toBe('🚀 vercel building 0:57 +1')

    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'CommandOutput',
        props: { command: 'deploys', args: '', text, isErrored: false },
        viewport: { columns: 44, rows: 60 },
      })
      expect(await ui.find({ type: 'Text', text: 'Deploys · 2 targets' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'render · shop-api' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '◉ building' })).toBeDefined()
      expect((await ui.findAll({ type: 'Link' })).length).toBeGreaterThan(3)
      await ui.unmount()
    }
  })

  test('where no pane can be placed, it answers inline too', BOTH, async ($, on) => {
    const clock = mock.clock(on, { now: T10 + 60_000 })
    const fake = world(on, VERCEL_FILES, route)
    fake.placed.now = false
    await start($)
    await clock.settle()
    const ran = await $.command.run(command(''))
    expect((ran.text ?? '').startsWith('Deploys · 2 targets')).toBe(true)
  })

  test('add and remove targets, kept per repo', VERCEL, async ($, on) => {
    const clock = mock.clock(on, { now: T10 })
    const fake = world(on, {}, url => (url.includes('vercel.com') ? { status: 200, body: { deployments: [] } } : { status: 404, body: {} }))
    await start($)
    await clock.settle()
    expect(fake.calls).toHaveLength(0)
    expect((await $.command.run(command('add vercel:marketing'))).text).toBe('Tracking vercel:marketing.')
    expect(fake.calls.at(-1)?.url).toBe('https://api.vercel.com/v7/deployments?projectId=marketing&limit=10')
    const added = await $.command.run(command('add render:srv-abc'))
    expect(added.text).toContain('It needs credentials')
    expect(added.text).toContain('renderToken')
    expect((await $.command.run(command('add heroku:x'))).text).toMatch(/unknown provider/)
    expect((await $.command.run(command('remove vercel:marketing'))).text).toBe('Stopped tracking vercel:marketing.')
    expect((await $.command.run(command('remove vercel:marketing'))).text).toBe('Not tracking vercel:marketing.')
    const status = await $.command.run(command('status'))
    expect(status.text).toContain('render:srv-abc (added)')
    expect(status.text).toContain('**render**: no credentials · not configured')
  })

  test('with nothing configured, /deploys explains tokens and scopes', async ($, on) => {
    const clock = mock.clock(on, { now: T10 })
    const fake = world(on, {}, () => ({ status: 500, body: {} }))
    await start($)
    await clock.settle()
    const ran = await $.command.run(command(''))
    const text = ran.text ?? ''
    expect(fake.opened).toEqual([])
    expect(text.startsWith('Deploys · nothing to track yet')).toBe(true)
    expect(text).toContain('pluginConfigs')
    expect(text).toContain('Actions, Deployments and Metadata')
    expect(text).toContain('Cloudflare Pages: Read and Workers Scripts: Read')
    expect(text).toContain('renderToken')
    expect(fake.calls).toHaveLength(0)
    expect(fake.status.at(-1)).toBeUndefined()

    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'CommandOutput',
        props: { command: 'deploys', args: '', text, isErrored: false },
        viewport: { columns: 44, rows: 60 },
      })
      expect(await ui.find({ type: 'Text', text: 'Deploys · nothing to track yet' })).toBeDefined()
      expect(await ui.find({ type: 'Markdown' })).toBeDefined()
      await ui.unmount()
    }
  })

  test("another command's output and an error row are left alone", async ($, on) => {
    on('ui.render', { component: 'CommandOutput' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, {}, `engine: ${e.props.text}`) as RenderElement
    })
    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'CommandOutput',
        props: { command: 'deploys', args: 'status', text: '**Deploy deck status**', isErrored: false },
        viewport: { columns: 44, rows: 60 },
      })
      expect(await ui.find({ type: 'Text', text: /^engine: / })).toBeDefined()
      await ui.unmount()
    }
  })
})

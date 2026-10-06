import type { CommandRunInput, On, RenderElement, SessionMessage, SessionUsage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { WARNING } from '../hooks/lib'
import { bandProps, usageAt } from './fixtures'

const SURFACES = ['terminal', 'desktop'] as const
const PLUGIN = 'context-bar'
const SUMMARY: SessionMessage = { role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }

/** `/context-bar <args>` as typed at the terminal's prompt. */
function command(args: string): CommandRunInput {
  return { command: PLUGIN, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }
}

/** Stands in for the engine beneath the plugin; `usage.now` is what the next measurement reads. */
function engine(on: On) {
  const usage: { now: SessionUsage } = { now: usageAt(142_000) }
  const toasts: string[] = []
  const status: (string | undefined)[] = []
  on('session.usage', () => ({ value: usage.now }))
  on('session.surfaces', () => ({ value: ['terminal'] as const }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.compact', () => ({ messages: [SUMMARY] }))
  on('classic.SessionStart', () => ({}))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', ($, e) => (status.push(e.text), { value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine band') as RenderElement
  })

  return { usage, toasts, status }
}

test('draws the segmented bar on terminal and desktop', async ($, on) => {
  const fake = engine(on)
  await $.session.measure({ context: fake.usage.now.context, rateLimits: [], changed: ['context'] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(100) })
    expect(await ui.find({ type: 'Text', text: '142k / 200k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'passive' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ACTIVE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /PASSIVE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /auto-compact/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Messages 125k/ })).toBeDefined()
    // Every cell of the bar row is accounted for: the divider and the coloured runs.
    const bar = await ui.findAll({ type: 'Text', text: /[█░▒┃╎]/ })
    expect(bar.map(t => t.text).join('')).toContain('┃')
    await ui.unmount()
  }
})

test('narrow bands fall back to one line', async ($, on) => {
  const fake = engine(on)
  await $.session.measure({ context: fake.usage.now.context, rateLimits: [], changed: ['context'] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(20) })
    expect(await ui.find({ type: 'Text', text: '71%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ACTIVE/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a short, mid-width band drops the legend and the estimate note', async ($, on) => {
  const fake = engine(on)
  await $.session.measure({ context: fake.usage.now.context, rateLimits: [], changed: ['context'] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(40, 2) })
    expect(await ui.find({ type: 'Text', text: '142k / 200k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /split estimated/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /PASSIVE/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Messages/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('before the first response it shows the estimate', async ($, on) => {
  const fake = engine(on)
  fake.usage.now = usageAt(null)
  await $.session.measure({ context: fake.usage.now.context, rateLimits: [], changed: ['context'] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(80) })
    expect(await ui.find({ type: 'Text', text: /~17k \/ 200k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no response yet/ })).toBeDefined()
    await ui.unmount()
  }
  expect(fake.toasts).toEqual([])
})

test('toasts once past 50%, again only after a compaction or clear', async ($, on) => {
  const fake = engine(on)
  const measure = () => $.session.measure({ context: fake.usage.now.context, rateLimits: [], changed: ['context'] })

  fake.usage.now = usageAt(60_000)
  await measure()
  expect(fake.toasts).toEqual([])

  fake.usage.now = usageAt(110_000)
  await measure()
  fake.usage.now = usageAt(150_000)
  await measure()
  expect(fake.toasts).toEqual([WARNING])

  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  fake.usage.now = usageAt(120_000)
  await measure()
  expect(fake.toasts).toEqual([WARNING, WARNING])

  await $.classic.SessionStart({ source: 'clear' })
  await measure()
  expect(fake.toasts).toEqual([WARNING, WARNING, WARNING])
})

test('/context-bar toggles the band and the status line takes over', async ($, on) => {
  const fake = engine(on)
  await $.session.measure({ context: fake.usage.now.context, rateLimits: [], changed: ['context'] })
  expect(fake.status.at(-1)).toBeUndefined()

  const off = await $.command.run(command(''))
  expect(off.text).toBe('Context bar hidden.')
  expect(fake.status.at(-1)).toBe('ctx 71%')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(100) })
    expect(await ui.find({ type: 'Text', text: /PASSIVE/ })).toBeUndefined()
    await ui.unmount()
  }

  const on_ = await $.command.run(command('on'))
  expect(on_.text).toBe('Context bar shown.')
  expect(fake.status.at(-1)).toBeUndefined()
})

test('statusLine "always" pins the percentage with the band shown', { options: { statusLine: 'always' } }, async ($, on) => {
  const fake = engine(on)
  await $.session.measure({ context: fake.usage.now.context, rateLimits: [], changed: ['context'] })
  expect(fake.status.at(-1)).toBe('ctx 71%')
})

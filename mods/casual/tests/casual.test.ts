import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, PromptComposeInput, RenderPropsOf } from 'claude-code'

import {
  SECTION_ID,
  applyAction,
  callLine,
  clipStart,
  fitCallLine,
  fitGroupLine,
  groupErrors,
  groupLine,
  outcome,
  parseArgs,
  parseDescribed,
  stylePrompt,
  toPrefs,
} from '../hooks/lib'

const SURFACES = ['terminal', 'desktop', 'mobile'] as const

/** A phone held upright: 40 cells across. */
const PHONE = { columns: 40, rows: 30, isFullscreen: false }

/** What the plugin wrote beneath it: its store and its status line. */
type Seen = { store: Record<string, unknown>; status: Array<string | undefined> }

/** The engine beneath the plugin: a store, a session, a base prompt and its own rows. */
function engine(on: On, stored?: Record<string, unknown>): Seen {
  const seen: Seen = { store: {}, status: [] }
  // The store, in memory (mock.store's, but one the test can read back).
  Object.assign(seen.store, stored)
  on('store.get', (_$, e) => ({ value: seen.store[e.key] }))
  on('store.set', (_$, e) => {
    seen.store[e.key] = JSON.parse(JSON.stringify(e.value)) as unknown
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }],
  }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: `ENGINE ${e.component}` })
  })
  return seen
}

const COMPOSE: PromptComposeInput = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
}

const PRESENTATION = { isFullscreen: false, columns: 100 }

function casual(args: string): CommandRunInput {
  return { command: 'casual', args, origin: { kind: 'composer' }, presentation: PRESENTATION }
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const TOOL_USE: RenderPropsOf['ToolUse'] = {
  tool_use_id: 'toolu_1',
  tool: 'Bash',
  input: { command: 'npm test' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { stdout: 'ok\npassed 48\n', stderr: '', interrupted: false },
}

const GROUP: RenderPropsOf['ToolGroup'] = {
  isActive: false,
  isExpanded: false,
  calls: [
    { tool: 'Read', input: { file_path: '/repo/a.ts' }, isRunning: false, isErrored: false, isInterrupted: false },
    { tool: 'Read', input: { file_path: '/repo/b.ts' }, isRunning: false, isErrored: false, isInterrupted: false },
    { tool: 'Grep', input: { pattern: 'foo' }, isRunning: false, isErrored: true, isInterrupted: false, output: 'bad regex' },
    { tool: 'Edit', input: { file_path: '/repo/a.ts' }, isRunning: false, isErrored: false, isInterrupted: false },
  ],
}

async function sectionIds($: Engine) {
  return (await $.prompt.compose(COMPOSE)).sections.map(s => s.id)
}

describe('prompt.compose', () => {
  test('adds the casual section when on (the default)', async ($, on) => {
    engine(on)
    const { sections } = await $.prompt.compose(COMPOSE)
    expect(sections.map(s => s.id)).toEqual(['intro', SECTION_ID])
    const added = sections.find(s => s.id === SECTION_ID)
    expect(added?.scope).toBe('session')
    expect(added?.text).toContain('1 to 4 short sentences')
  })

  test('leaves the prompt alone when off', async ($, on) => {
    engine(on, { prefs: { isOn: false } })
    expect(await sectionIds($)).toEqual(['intro'])
  })

  test('uses the brief prompt from the verbosity option', { options: { verbosity: 'brief' } }, async ($, on) => {
    engine(on)
    const { sections } = await $.prompt.compose(COMPOSE)
    expect(sections.find(s => s.id === SECTION_ID)?.text).toContain('1 or 2 short sentences')
  })
})

describe('/casual', () => {
  test('toggles, switches verbosity and persists in the store', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    expect(seen.status).toEqual(['☺ casual'])

    const off = await $.command.run(casual('off'))
    expect(off.text).toContain('casual is off')
    expect(await sectionIds($)).toEqual(['intro'])
    expect(seen.store.prefs).toEqual({ isOn: false })
    expect(seen.status.at(-1)).toBeUndefined()

    const brief = await $.command.run(casual('brief'))
    expect(brief.text).toContain('casual is on (brief')
    const { sections } = await $.prompt.compose(COMPOSE)
    expect(sections.find(s => s.id === SECTION_ID)?.text).toContain('1 or 2 short sentences')

    const status = await $.command.run(casual('status'))
    expect(status.text).toContain('casual is on (brief')

    await $.command.run(casual('chill'))
    expect(seen.store.prefs).toEqual({ isOn: true, verbosity: 'chill' })
    expect(seen.status.at(-1)).toBe('☺ casual')

    const bad = await $.command.run(casual('loud'))
    expect(bad.text).toContain('Usage')
  })

  test('shows the ☺ casual status when the session starts on the phone', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ ...START, surface: 'mobile' })
    expect(seen.status).toEqual(['☺ casual'])
  })

  test('/casual status draws a compact card on every surface', async ($, on) => {
    engine(on)
    const { text } = await $.command.run(casual('brief'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'casual',
        surface,
        component: 'CommandOutput',
        viewport: PHONE,
        props: { command: 'casual', args: 'status', text: text ?? '', isErrored: false },
      })
      expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { borderStyle: 'round' } })
      expect(await ui.find({ type: 'Text', text: '☺ casual' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: 'on' }))?.props.color).toBe('success')
      expect(await ui.find({ type: 'Text', text: /brief · 1-2 sentences/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'folded' })).toBeDefined()
      for (const t of await ui.findAll({ type: 'Text' })) expect(t.text.length).toBeLessThanOrEqual(36)
      expect(await ui.find({ text: /ENGINE/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the card says off, and a usage line is left to the engine', async ($, on) => {
    engine(on)
    const off = await $.command.run(casual('off'))
    const bad = await $.command.run(casual('loud'))
    for (const surface of SURFACES) {
      const card = await $.ui.mount({
        plugin: 'casual',
        surface,
        component: 'CommandOutput',
        props: { command: 'casual', args: 'off', text: off.text ?? '', isErrored: false },
      })
      expect((await card.find({ type: 'Text', text: 'off' }))?.props.dimColor).toBe(true)
      expect(await card.find({ type: 'Text', text: /\/casual on/ })).toBeDefined()
      const usage = await $.ui.mount({
        plugin: 'casual',
        surface,
        component: 'CommandOutput',
        props: { command: 'casual', args: 'loud', text: bad.text ?? '', isErrored: false },
      })
      expect(await usage.find({ text: 'ENGINE CommandOutput' })).toBeDefined()
      await card.unmount()
      await usage.unmount()
    }
  })

  test('starts from what the store kept', async ($, on) => {
    const seen = engine(on, { prefs: { isOn: false } })
    await $.session.start(START)
    expect(seen.status).toEqual([undefined])
    const status = await $.command.run(casual(''))
    expect(status.text).toContain('casual is off')
  })
})

describe('collapsed tool rows', () => {
  test('a finished ToolUse is one dim line on every surface', async ($, on) => {
    engine(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'casual', surface, component: 'ToolUse', props: TOOL_USE })
      expect((await ui.find({ type: 'Text', text: /Bash npm test · 2 lines/ }))?.props.dimColor).toBe(true)
      expect(await ui.find({ text: /ENGINE/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a successful ToolResult is hidden (its row already says how it went)', async ($, on) => {
    engine(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'casual',
        surface,
        component: 'ToolResult',
        props: { tool_use_id: 'toolu_1', tool: 'Bash', output: TOOL_USE.output, isErrored: false },
      })
      expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { display: 'none' } })
      await ui.unmount()
    }
  })

  test('a failed ToolUse stays visible in red', async ($, on) => {
    engine(on)
    for (const surface of SURFACES) {
      const props = { ...TOOL_USE, isErrored: true, output: 'Exit code 1\nnpm ERR! missing script' }
      const ui = await $.ui.mount({ plugin: 'casual', surface, component: 'ToolUse', props })
      expect((await ui.find({ type: 'Text', text: /✗ Bash npm test/ }))?.props.color).toBe('error')
      const result = await $.ui.mount({
        plugin: 'casual',
        surface,
        component: 'ToolResult',
        props: { tool_use_id: 'toolu_1', tool: 'Bash', output: props.output, isErrored: true },
      })
      expect((await result.find({ type: 'Text', text: /Exit code 1/ }))?.props.color).toBe('error')
      await ui.unmount()
      await result.unmount()
    }
  })

  test('a running ToolUse and an AskUserQuestion row are left to the engine', async ($, on) => {
    engine(on)
    for (const surface of SURFACES) {
      const running = await $.ui.mount({
        plugin: 'casual',
        surface,
        component: 'ToolUse',
        props: { ...TOOL_USE, isRunning: true, output: undefined },
      })
      expect(await running.find({ text: 'ENGINE ToolUse' })).toBeDefined()
      const ask = await $.ui.mount({
        plugin: 'casual',
        surface,
        component: 'ToolUse',
        props: { ...TOOL_USE, tool: 'AskUserQuestion', input: { questions: [] } },
      })
      expect(await ask.find({ text: 'ENGINE ToolUse' })).toBeDefined()
      await running.unmount()
      await ask.unmount()
    }
  })

  test('a ToolGroup folds into one line, with failures in red', async ($, on) => {
    engine(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'casual', surface, component: 'ToolGroup', props: GROUP })
      expect(await ui.find({ type: 'Text', text: '· ran 4 tools (Read ×2, Grep, Edit)' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /1 failed: Grep "foo"/ }))?.props.color).toBe('error')
      await ui.unmount()
    }
  })

  test('an expanded ToolGroup (ctrl+o) is untouched', async ($, on) => {
    engine(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'casual',
        surface,
        component: 'ToolGroup',
        props: { ...GROUP, isExpanded: true },
      })
      expect(await ui.find({ text: 'ENGINE ToolGroup' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('rows fit a 40-column phone: paths keep their file name', async ($, on) => {
    engine(on)
    const longPath = '/Users/someone/projects/modemon/mods/casual/hooks/register.tsx'
    const read = {
      ...TOOL_USE,
      tool: 'Read',
      input: { file_path: longPath },
      output: { type: 'text', file: { filePath: longPath, numLines: 146 } },
    }
    const bash = { ...TOOL_USE, input: { command: `npm run build -- --filter casual --verbose --no-cache ${'x'.repeat(40)}` } }
    const wide = { ...GROUP, calls: [...GROUP.calls, ...GROUP.calls.map(c => ({ ...c, tool: `${c.tool}Notebook` }))] }
    for (const surface of SURFACES) {
      const r = await $.ui.mount({ plugin: 'casual', surface, component: 'ToolUse', viewport: PHONE, props: read })
      const rText = (await r.find({ type: 'Text', text: /Read/ }))?.text ?? ''
      expect(rText.length).toBeLessThanOrEqual(38)
      expect(rText).toMatch(/^· Read …\S*register\.tsx · 146 lines$/)

      const b = await $.ui.mount({ plugin: 'casual', surface, component: 'ToolUse', viewport: PHONE, props: bash })
      const bText = (await b.find({ type: 'Text', text: /Bash/ }))?.text ?? ''
      expect(bText.length).toBeLessThanOrEqual(38)
      expect(bText).toMatch(/^· Bash npm run build.*… · 2 lines$/)

      const g = await $.ui.mount({ plugin: 'casual', surface, component: 'ToolGroup', viewport: PHONE, props: wide })
      expect(await g.drawn()).toMatchObject({ type: 'Box', props: { flexDirection: 'column' } })
      const lines = await g.findAll({ type: 'Text' })
      expect(lines.map(l => l.text)).toEqual([
        expect.stringMatching(/^· ran 8 tools \(Read ×2, .*…\)$/),
        expect.stringMatching(/^  ✗ 2 failed: Grep "foo", GrepNote/),
      ])
      for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(38)
      for (const ui of [r, b, g]) await ui.unmount()
    }
  })

  test('a row that says it is expanded is untouched', async ($, on) => {
    engine(on)
    for (const surface of SURFACES) {
      const props = { ...TOOL_USE, isExpanded: true } as RenderPropsOf['ToolUse']
      const ui = await $.ui.mount({ plugin: 'casual', surface, component: 'ToolUse', props })
      expect(await ui.find({ text: 'ENGINE ToolUse' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('nothing is folded while casual is off', async ($, on) => {
    engine(on, { prefs: { isOn: false } })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'casual', surface, component: 'ToolGroup', props: GROUP })
      expect(await ui.find({ text: 'ENGINE ToolGroup' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('nothing is folded with collapseTools off', { options: { collapseTools: false } }, async ($, on) => {
    engine(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'casual', surface, component: 'ToolUse', props: TOOL_USE })
      expect(await ui.find({ text: 'ENGINE ToolUse' })).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('helpers', () => {
  test('parses /casual arguments', () => {
    expect(parseArgs('')).toEqual({ kind: 'status' })
    expect(parseArgs(' OFF ')).toEqual({ kind: 'off' })
    expect(parseArgs('brief')).toEqual({ kind: 'verbosity', verbosity: 'brief' })
    expect(parseArgs('loud')).toEqual({ kind: 'usage', arg: 'loud' })
    expect(applyAction({ isOn: false }, { kind: 'verbosity', verbosity: 'brief' })).toEqual({
      isOn: true,
      verbosity: 'brief',
    })
    expect(toPrefs(undefined)).toEqual({ isOn: true })
    expect(toPrefs({ isOn: false, verbosity: 'loud' })).toEqual({ isOn: false })
  })

  test('summarizes calls and groups', () => {
    expect(callLine(TOOL_USE)).toBe('Bash npm test · 2 lines')
    expect(
      outcome({ structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c', ' d'] }] }),
    ).toBe('+2 −1')
    expect(groupLine(GROUP.calls)).toBe('ran 4 tools (Read ×2, Grep, Edit)')
    expect(groupErrors(GROUP.calls)).toBe('1 failed: Grep "foo"')
  })

  test('fits lines to a width', () => {
    expect(fitCallLine(TOOL_USE, 100)).toBe('Bash npm test · 2 lines')
    expect(fitCallLine({ ...TOOL_USE, input: { file_path: '/a/b/c/d/e/f/g/file.ts' } }, 24)).toBe('Bash …/file.ts · 2 lines')
    expect(fitCallLine({ ...TOOL_USE, input: {} }, 10)).toBe('Bash · 2 …')
    expect(fitGroupLine(GROUP.calls, 100)).toBe('ran 4 tools (Read ×2, Grep, Edit)')
    expect(fitGroupLine(GROUP.calls, 30)).toBe('ran 4 tools (Read ×2, Grep, …)')
    expect(fitGroupLine(GROUP.calls, 12)).toBe('ran 4 tools')
    expect(clipStart('abcdef', 4)).toBe('…def')
    expect(parseDescribed('casual is on (brief, tool rows folded). x')).toEqual({ isOn: true, verbosity: 'brief', isFolding: true })
    expect(parseDescribed('Unknown option')).toBeUndefined()
  })

  test('the style prompt keeps safety and precision', () => {
    for (const verbosity of ['chill', 'brief'] as const) {
      const text = stylePrompt(verbosity)
      expect(text).toContain('Never hide or soften a failure')
      expect(text).toContain('Still ask before destructive or irreversible actions')
      expect(text).toContain('in backticks')
    }
  })
})

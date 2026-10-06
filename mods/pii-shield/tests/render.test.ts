import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, Register, RenderComponent, RenderElement, RenderPropsOf } from 'claude-code'

import { BLOCK, mask } from '../hooks/redact'

const ON = { options: { mode: 'on', names: 'Jin Song' } }
const ENGINE = { type: 'engine', ref: 0 } as const

/** The surfaces that raise the transcript rows, `CommandOutput` and `Pane`. */
const SURFACES = ['terminal', 'desktop', 'mobile'] as const
/** The surfaces that raise `Spinner` and `AbovePrompt`. */
const BAND_SURFACES = ['terminal', 'desktop'] as const

type Seen = { [C in RenderComponent]?: RenderPropsOf[C] }

/** Sits beneath the plugin as the engine's own components: keeps the props each was handed. */
function captureRender(on: On): Seen {
  const seen: Seen = {}
  on('ui.render', ($, e) => {
    ;(seen as Record<string, unknown>)[e.component] = e.props
    return ENGINE
  })
  return seen
}

/** Forgets what `captureRender` saw, so each surface's pass reads its own. */
function reset(seen: Seen): void {
  for (const key of Object.keys(seen)) delete (seen as Record<string, unknown>)[key]
}

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const PANE = {
  title: 'notes',
  isFocused: false,
  bodyColumns: 40,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

/** Another plugin's tree, full of personal data, as a pane or band would draw it. */
const OTHER_TREE: RenderElement = {
  type: 'Box',
  props: { flexDirection: 'column' },
  children: [
    { type: 'Text', children: ['mail jin@agentsy.ai'] },
    { type: 'Text', props: { dimColor: true }, children: ['nothing to hide'] },
    { type: 'Markdown', props: { text: '**key** sk-ant-api03-abcDEF123456789_xyz-QWERTY' } },
    { type: 'Code', props: { source: 'API_KEY=abc123', path: '/Users/jins/app/.env' } },
  ],
}

describe('ui.render rewrites, on every surface', () => {
  test('AssistantMessage text is masked, other props kept', ON, async ($, on) => {
    const seen = captureRender(on)
    for (const surface of SURFACES) {
      reset(seen)
      await $.ui.render({
        surface,
        component: 'AssistantMessage',
        requestId: `msg_1_${surface}`,
        props: {
          text: 'Hi Jin Song, your key is sk-ant-api03-abcDEF123456789_xyz-QWERTY and mail is jin@agentsy.ai.',
          isFirstOfReply: true,
          onScreen: null,
        },
      })
      expect(seen.AssistantMessage?.text).toBe(`Hi ${BLOCK}, your key is ${mask('key')} and mail is ${mask('email')}.`)
      expect(seen.AssistantMessage?.isFirstOfReply).toBe(true)
      expect(seen.AssistantMessage?.onScreen).toBeNull()
      expect(Object.keys(seen.AssistantMessage ?? {}).sort()).toEqual(['isFirstOfReply', 'onScreen', 'text'])
    }
  })

  test('UserMessage and CommandOutput text are masked', ON, async ($, on) => {
    const seen = captureRender(on)
    for (const surface of SURFACES) {
      reset(seen)
      await $.ui.render({
        surface,
        component: 'UserMessage',
        requestId: `msg_2_${surface}`,
        props: { text: 'my card is 4111 1111 1111 1111', origin: { kind: 'composer' }, isExpanded: false },
      })
      expect(seen.UserMessage?.text).toBe(`my card is ${mask('card')}`)
      expect(seen.UserMessage?.origin).toEqual({ kind: 'composer' })

      // Another command's output (a built-in's or another plugin's).
      await $.ui.render({
        surface,
        component: 'CommandOutput',
        requestId: `msg_3_${surface}`,
        props: { command: 'status', args: '', text: 'Login: jin@agentsy.ai', isErrored: false },
      })
      expect(seen.CommandOutput?.text).toBe(`Login: ${mask('email')}`)
      expect(seen.CommandOutput?.command).toBe('status')
    }
  })

  test('ToolUse input and output are masked deep, shape kept', ON, async ($, on) => {
    const seen = captureRender(on)
    for (const surface of SURFACES) {
      reset(seen)
      await $.ui.render({
        surface,
        component: 'ToolUse',
        requestId: `toolu_1_${surface}`,
        props: {
          tool_use_id: 'toolu_1',
          tool: 'Bash',
          input: { command: 'curl -H "Authorization: Bearer abcdef1234567890xyz" http://10.0.0.5/', timeout: 1000 },
          isRunning: false,
          isErrored: false,
          isInterrupted: false,
          output: { stdout: 'ok from /Users/jins/app', stderr: '', interrupted: false },
        },
      })
      const input = seen.ToolUse?.input as { command: string; timeout: number }
      expect(input.command).toBe(`curl -H "Authorization: Bearer ${mask('token')}" http://${mask('ip')}/`)
      expect(input.timeout).toBe(1000)
      expect(seen.ToolUse?.output).toEqual({ stdout: `ok from /Users/${BLOCK}/app`, stderr: '', interrupted: false })
      expect(seen.ToolUse?.tool_use_id).toBe('toolu_1')
    }
  })

  test('a running ToolUse gets no output field added', ON, async ($, on) => {
    const seen = captureRender(on)
    for (const surface of SURFACES) {
      reset(seen)
      await $.ui.render({
        surface,
        component: 'ToolUse',
        requestId: `toolu_2_${surface}`,
        props: {
          tool_use_id: 'toolu_2',
          tool: 'Read',
          input: { file_path: '/home/jins/.env' },
          isRunning: true,
          isErrored: false,
          isInterrupted: false,
        },
      })
      expect(seen.ToolUse?.input).toEqual({ file_path: `/home/${BLOCK}/.env` })
      expect(Object.keys(seen.ToolUse ?? {})).not.toContain('output')
    }
  })

  test('ToolResult and ToolGroup are masked', ON, async ($, on) => {
    const seen = captureRender(on)
    for (const surface of SURFACES) {
      reset(seen)
      await $.ui.render({
        surface,
        component: 'ToolResult',
        requestId: `toolu_3_${surface}`,
        props: {
          tool_use_id: 'toolu_3',
          tool: 'Read',
          output: { type: 'text', file: { filePath: '/x/.env', content: 'API_KEY=abc123\nOK=1', numLines: 2 } },
          isErrored: false,
        },
      })
      expect(seen.ToolResult?.output).toEqual({
        type: 'text',
        file: { filePath: '/x/.env', content: `API_KEY=${mask('secret')}\nOK=1`, numLines: 2 },
      })

      await $.ui.render({
        surface,
        component: 'ToolGroup',
        requestId: `group_1_${surface}`,
        props: {
          calls: [
            { tool: 'Grep', input: { pattern: 'jin@agentsy.ai' }, isRunning: false, isErrored: false, isInterrupted: false },
            {
              tool: 'Read',
              input: { file_path: '/Users/jins/notes.md' },
              isRunning: false,
              isErrored: false,
              isInterrupted: false,
              output: 'phone +44 20 7946 0958',
            },
          ],
          isActive: false,
          isExpanded: false,
        },
      })
      const calls = seen.ToolGroup?.calls ?? []
      expect(calls[0]?.input).toEqual({ pattern: mask('email') })
      expect(Object.keys(calls[0] ?? {})).not.toContain('output')
      expect(calls[1]?.input).toEqual({ file_path: `/Users/${BLOCK}/notes.md` })
      expect(calls[1]?.output).toBe(`phone ${mask('phone')}`)
    }
  })

  test('AskUserQuestion keeps question text and labels, masks descriptions', ON, async ($, on) => {
    const seen = captureRender(on)
    for (const surface of SURFACES) {
      reset(seen)
      await $.ui.render({
        surface,
        component: 'AskUserQuestion',
        requestId: `toolu_4_${surface}`,
        props: {
          tool: 'AskUserQuestion',
          questions: [
            {
              question: 'Email jin@agentsy.ai?',
              header: 'Send',
              multiSelect: false,
              options: [
                { label: 'Yes', description: 'Send to jin@agentsy.ai' },
                { label: 'No', description: 'Skip' },
              ],
            },
          ],
        },
      })
      expect(seen.AskUserQuestion?.questions).toEqual([
        {
          question: 'Email jin@agentsy.ai?',
          header: 'Send',
          multiSelect: false,
          options: [
            { label: 'Yes', description: `Send to ${mask('email')}` },
            { label: 'No', description: 'Skip' },
          ],
        },
      ])
    }
  })

  test('Spinner word and message are masked (terminal and desktop)', ON, async ($, on) => {
    const seen = captureRender(on)
    for (const surface of BAND_SURFACES) {
      reset(seen)
      await $.ui.render({
        surface,
        component: 'Spinner',
        requestId: `spin_${surface}`,
        props: { word: 'Creating /Users/jins/notes.md', message: 'Mailing jin@agentsy.ai', suffix: '…', mode: 'tool-use' },
      })
      expect(seen.Spinner?.word).toBe(`Creating /Users/${BLOCK}/notes.md`)
      expect(seen.Spinner?.message).toBe(`Mailing ${mask('email')}`)
      expect(seen.Spinner?.mode).toBe('tool-use')
    }
  })

  test('auto mode with no recorder seen draws the real values', async ($, on) => {
    const seen = captureRender(on)
    for (const surface of SURFACES) {
      await $.ui.render({
        surface,
        component: 'AssistantMessage',
        requestId: `msg_4_${surface}`,
        props: { text: 'mail jin@agentsy.ai', isFirstOfReply: true },
      })
      expect(seen.AssistantMessage?.text).toBe('mail jin@agentsy.ai')
    }
  })

  test('off mode draws the real values', { options: { mode: 'off' } }, async ($, on) => {
    const seen = captureRender(on)
    for (const surface of SURFACES) {
      await $.ui.render({
        surface,
        component: 'AssistantMessage',
        requestId: `msg_5_${surface}`,
        props: { text: 'mail jin@agentsy.ai', isFirstOfReply: true },
      })
      expect(seen.AssistantMessage?.text).toBe('mail jin@agentsy.ai')
    }
  })

  test('category toggles reach the renderer', { options: { mode: 'on', maskContact: false } }, async ($, on) => {
    const seen = captureRender(on)
    for (const surface of SURFACES) {
      await $.ui.render({
        surface,
        component: 'AssistantMessage',
        requestId: `msg_6_${surface}`,
        props: { text: 'mail jin@agentsy.ai from 10.1.2.3', isFirstOfReply: true },
      })
      expect(seen.AssistantMessage?.text).toBe(`mail jin@agentsy.ai from ${mask('ip')}`)
    }
  })
})

/** Another plugin that shows personal data through `$.ui` when `/chatty` runs. */
const CHATTY_ON = {
  ...ON,
  plugins: [
    {
      name: 'chatty',
      register: ((on: On) => {
        on('command.run', { command: 'chatty' }, async $ => {
          $.ui.toast('Sent to jin@agentsy.ai')
          $.ui.status('deploy 10.1.2.3')
          $.ui.status(undefined)
          await $.ui.open({ id: 'mail', title: 'Inbox of Jin Song' })
          return { text: 'ok' }
        })
      }) as Register,
    },
  ],
}

/** Sits beneath the plugins as the engine's toast, status line and pane opener. */
function listen(on: On) {
  const said = { toasts: [] as string[], statuses: [] as (string | undefined)[], titles: [] as (string | undefined)[] }
  on('ui.toast', ($, e) => {
    said.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    said.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    said.titles.push(e.title)
    return { value: { isPlaced: true } }
  })
  return said
}

describe("other plugins' panes, band and $.ui text", () => {
  test("a pane another plugin draws is masked on every surface, the phone's included", ON, async ($, on) => {
    on('ui.render', { component: 'Pane' }, () => OTHER_TREE)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'pii-shield', surface, component: 'Pane', props: PANE })
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).not.toContain('jin@agentsy.ai')
      expect(drawn).not.toContain('sk-ant-api03')
      expect(drawn).not.toContain('abc123')
      expect(drawn).not.toContain('/Users/jins/')
      expect((await ui.find({ type: 'Text', text: /mail/ }))?.text).toBe(`mail ${mask('email')}`)
      expect((await ui.find({ type: 'Text', text: /nothing/ }))?.text).toBe('nothing to hide')
      await ui.unmount()
    }
  })

  test('a pane with nothing to mask is handed on as drawn', ON, async ($, on) => {
    const clean: RenderElement = { type: 'Text', props: { bold: true }, children: ['3 notes'] }
    on('ui.render', { component: 'Pane' }, () => clean)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'pii-shield', surface, component: 'Pane', props: PANE })
      expect(await ui.drawn()).toEqual(clean)
      await ui.unmount()
    }
  })

  test('the band above the prompt is masked (terminal and desktop)', ON, async ($, on) => {
    on('ui.render', { component: 'AbovePrompt' }, () => OTHER_TREE)
    for (const surface of BAND_SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'pii-shield',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: PANE.scroll, view: {} },
      })
      expect(JSON.stringify(await ui.drawn())).not.toContain('jin@agentsy.ai')
      await ui.unmount()
    }
  })

  test("another plugin's toasts, status entries and pane titles are masked", CHATTY_ON, async ($, on) => {
    const said = listen(on)
    await $.command.run({ ...RUN, command: 'chatty', args: '' })
    expect(said.toasts).toEqual([`Sent to ${mask('email')}`])
    expect(said.statuses).toEqual([`deploy ${mask('ip')}`, undefined])
    expect(said.titles).toEqual([`Inbox of ${BLOCK}`])
  })

  test('$.ui text passes untouched while not redacting', { ...CHATTY_ON, options: { mode: 'off' } }, async ($, on) => {
    const said = listen(on)
    await $.command.run({ ...RUN, command: 'chatty', args: '' })
    expect(said.toasts).toEqual(['Sent to jin@agentsy.ai'])
    expect(said.statuses).toEqual(['deploy 10.1.2.3', undefined])
    expect(said.titles).toEqual(['Inbox of Jin Song'])
  })
})

describe('failure policy', () => {
  test('a row that cannot be redacted is hidden, not drawn raw (fail closed), on every surface', ON, async ($, on) => {
    const seen = captureRender(on)
    on('state.get', () => ({ deny: 'state is unavailable' }))
    for (const surface of SURFACES) {
      const drawn = await $.ui.render({
        surface,
        component: 'AssistantMessage',
        requestId: `msg_9_${surface}`,
        props: { text: 'mail jin@agentsy.ai', isFirstOfReply: true },
      })
      // The engine's component never received the raw text...
      expect(seen.AssistantMessage).toBeUndefined()
      // ...and the plugin's placeholder was drawn in its place.
      expect(JSON.stringify(drawn)).toContain('pii-shield hid this row')
      expect(JSON.stringify(drawn)).not.toContain('jin@agentsy.ai')
    }
  })

  test("the placeholder is a tree the phone can draw (a pane that can't be redacted)", ON, async ($, on) => {
    on('ui.render', { component: 'Pane' }, () => OTHER_TREE)
    on('state.get', () => ({ deny: 'state is unavailable' }))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'pii-shield', surface, component: 'Pane', props: PANE })
      expect((await ui.find({ type: 'Text', text: /pii-shield hid this row/ }))?.text).toContain(BLOCK)
      expect(JSON.stringify(await ui.drawn())).not.toContain('jin@agentsy.ai')
      await ui.unmount()
    }
  })
})

describe('/redact and auto-detection', () => {
  test('/redact on, status, off', async ($, on) => {
    const statuses: (string | undefined)[] = []
    on('ui.status', ($, e) => {
      statuses.push(e.text)
      return { value: undefined }
    })
    const seen = captureRender(on)
    const draw = () =>
      $.ui.render({
        surface: 'mobile',
        component: 'AssistantMessage',
        requestId: 'msg_7',
        props: { text: 'mail jin@agentsy.ai', isFirstOfReply: true },
      })

    const turnedOn = await $.command.run({ ...RUN, command: 'redact', args: 'on' })
    expect(turnedOn.text).toContain('pii-shield: REDACTING')
    expect(statuses[statuses.length - 1]).toBe('● REDACTING')
    await draw()
    expect(seen.AssistantMessage?.text).toBe(`mail ${mask('email')}`)

    const status = await $.command.run({ ...RUN, command: 'redact', args: 'status' })
    expect(status.text).toContain('Mode: on (set by /redact)')

    await $.command.run({ ...RUN, command: 'redact', args: 'off' })
    expect(statuses[statuses.length - 1]).toBe('○ pii-shield')
    await draw()
    expect(seen.AssistantMessage?.text).toBe('mail jin@agentsy.ai')

    const usage = await $.command.run({ ...RUN, command: 'redact', args: 'sideways' })
    expect(usage.text).toContain('Usage')
  })

  test('/redact status draws as a compact card on every surface (the mobile fallback)', ON, async ($, on) => {
    const answer = await $.command.run({ ...RUN, command: 'redact', args: 'status' })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'pii-shield',
        surface,
        component: 'CommandOutput',
        viewport: { columns: surface === 'mobile' ? 34 : 100, rows: 40, isFullscreen: false },
        props: { command: 'redact', args: 'status', text: answer.text ?? '', isErrored: false },
      })
      const card = await ui.drawn()
      expect(card).toMatchObject({ type: 'Box', props: { borderStyle: 'round' } })
      expect((card as { props: { width: number } }).props.width).toBeLessThanOrEqual(surface === 'mobile' ? 34 : 56)
      expect(await ui.find({ type: 'Text', text: '● REDACTING' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'on (from settings)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'not watched (mode on)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /contact, network, financial, secrets, names, paths/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('on the phone, a card that is not redacting says phone recording is not detected', async $ => {
    const answer = await $.command.run({ ...RUN, command: 'redact', args: 'status' })
    const ui = await $.ui.mount({
      plugin: 'pii-shield',
      surface: 'mobile',
      component: 'CommandOutput',
      props: { command: 'redact', args: '', text: answer.text ?? '', isErrored: false },
    })
    expect(await ui.find({ type: 'Text', text: '○ pii-shield' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Recording this phone\? It is not detected/ })).toBeDefined()
    await ui.unmount()
  })

  test('/redact usage and other text draws as the engine row', async ($, on) => {
    captureRender(on)
    const ui = await $.ui.mount({
      plugin: 'pii-shield',
      surface: 'mobile',
      component: 'CommandOutput',
      props: { command: 'redact', args: 'x', text: 'Usage: /redact on | off | auto | status', isErrored: false },
    })
    expect(await ui.drawn()).toMatchObject({ type: 'engine' })
    await ui.unmount()
  })

  test('auto mode turns on when a recorder appears, and stays on (mobile session)', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { USER: 'jins', HOME: '/home/jins' })
    let isRecording = false
    const toasts: string[] = []
    const statuses: (string | undefined)[] = []
    on('process.run', ($, e) => {
      const [cmd, ...rest] = e.argv
      const ok = (stdout: string) => ({
        value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      })
      if (cmd === 'uname') return ok('Linux\n')
      if (cmd === 'git') return ok('Jin Song\n')
      if (cmd === 'ps') {
        expect(rest).toEqual(['-eo', 'comm='])
        return ok(isRecording ? 'systemd\nbash\nobs\n' : 'systemd\nbash\n')
      }
      return { deny: `unexpected ${cmd}` }
    })
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.status', ($, e) => {
      statuses.push(e.text)
      return { value: undefined }
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    const seen = captureRender(on)
    const draw = async () => {
      const out: (string | undefined)[] = []
      for (const surface of SURFACES) {
        await $.ui.render({
          surface,
          component: 'AssistantMessage',
          requestId: `msg_8_${surface}`,
          props: { text: 'jins (Jin Song) at /home/jins', isFirstOfReply: true },
        })
        out.push(seen.AssistantMessage?.text)
      }
      return out
    }
    const masked = `${BLOCK} (${BLOCK}) at /home/${BLOCK}`
    const raw = 'jins (Jin Song) at /home/jins'

    // The detector runs where the session runs, whichever surface watches it.
    await $.session.start({ cwd: '/home/jins/app', surface: 'mobile', isInteractive: true })
    await clock.settle()
    expect(statuses[statuses.length - 1]).toBe('○ pii-shield')
    expect(await draw()).toEqual([raw, raw, raw])

    isRecording = true
    await clock.advance(5000)
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain('OBS detected')
    expect(statuses[statuses.length - 1]).toBe('● REDACTING')
    // The OS username and git user.name were picked up at session start.
    expect(await draw()).toEqual([masked, masked, masked])

    // Sticky: the recorder quits, redaction stays on, no second toast.
    isRecording = false
    await clock.advance(15000)
    expect(await draw()).toEqual([masked, masked, masked])
    expect(toasts.length).toBe(1)

    const status = await $.command.run({ ...RUN, command: 'redact', args: 'status' })
    expect(status.text).toContain('Recorder: OBS, seen this session')

    // Only /redact off turns it off.
    await $.command.run({ ...RUN, command: 'redact', args: 'off' })
    expect(await draw()).toEqual([raw, raw, raw])
  })
})

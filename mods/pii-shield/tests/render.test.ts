import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderComponent, RenderPropsOf } from 'claude-code'

import { BLOCK, mask } from '../hooks/redact'

const ON = { options: { mode: 'on', names: 'Jin Song' } }
const ENGINE = { type: 'engine', ref: 0 } as const

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

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

describe('ui.render rewrites', () => {
  test('AssistantMessage text is masked, other props kept', ON, async ($, on) => {
    const seen = captureRender(on)
    await $.ui.render({
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'msg_1',
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
  })

  test('UserMessage and CommandOutput text are masked', ON, async ($, on) => {
    const seen = captureRender(on)
    await $.ui.render({
      surface: 'desktop',
      component: 'UserMessage',
      requestId: 'msg_2',
      props: { text: 'my card is 4111 1111 1111 1111', origin: { kind: 'composer' }, isExpanded: false },
    })
    expect(seen.UserMessage?.text).toBe(`my card is ${mask('card')}`)
    expect(seen.UserMessage?.origin).toEqual({ kind: 'composer' })

    await $.ui.render({
      surface: 'terminal',
      component: 'CommandOutput',
      requestId: 'msg_3',
      props: { command: 'status', args: '', text: 'Login: jin@agentsy.ai', isErrored: false },
    })
    expect(seen.CommandOutput?.text).toBe(`Login: ${mask('email')}`)
    expect(seen.CommandOutput?.command).toBe('status')
  })

  test('ToolUse input and output are masked deep, shape kept', ON, async ($, on) => {
    const seen = captureRender(on)
    await $.ui.render({
      surface: 'terminal',
      component: 'ToolUse',
      requestId: 'toolu_1',
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
  })

  test('a running ToolUse gets no output field added', ON, async ($, on) => {
    const seen = captureRender(on)
    await $.ui.render({
      surface: 'terminal',
      component: 'ToolUse',
      requestId: 'toolu_2',
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
  })

  test('ToolResult and ToolGroup are masked', ON, async ($, on) => {
    const seen = captureRender(on)
    await $.ui.render({
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'toolu_3',
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
      surface: 'terminal',
      component: 'ToolGroup',
      requestId: 'group_1',
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
  })

  test('AskUserQuestion keeps question text and labels, masks descriptions', ON, async ($, on) => {
    const seen = captureRender(on)
    await $.ui.render({
      surface: 'terminal',
      component: 'AskUserQuestion',
      requestId: 'toolu_4',
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
  })

  test('auto mode with no recorder seen draws the real values', async ($, on) => {
    const seen = captureRender(on)
    await $.ui.render({
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'msg_4',
      props: { text: 'mail jin@agentsy.ai', isFirstOfReply: true },
    })
    expect(seen.AssistantMessage?.text).toBe('mail jin@agentsy.ai')
  })

  test('off mode draws the real values', { options: { mode: 'off' } }, async ($, on) => {
    const seen = captureRender(on)
    await $.ui.render({
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'msg_5',
      props: { text: 'mail jin@agentsy.ai', isFirstOfReply: true },
    })
    expect(seen.AssistantMessage?.text).toBe('mail jin@agentsy.ai')
  })

  test('category toggles reach the renderer', { options: { mode: 'on', maskContact: false } }, async ($, on) => {
    const seen = captureRender(on)
    await $.ui.render({
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'msg_6',
      props: { text: 'mail jin@agentsy.ai from 10.1.2.3', isFirstOfReply: true },
    })
    expect(seen.AssistantMessage?.text).toBe(`mail jin@agentsy.ai from ${mask('ip')}`)
  })
})

describe('failure policy', () => {
  test('a row that cannot be redacted is hidden, not drawn raw (fail closed)', ON, async ($, on) => {
    const seen = captureRender(on)
    on('state.get', () => ({ deny: 'state is unavailable' }))
    const drawn = await $.ui.render({
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'msg_9',
      props: { text: 'mail jin@agentsy.ai', isFirstOfReply: true },
    })
    // The engine's component never received the raw text...
    expect(seen.AssistantMessage).toBeUndefined()
    // ...and the plugin's placeholder was drawn in its place.
    expect(JSON.stringify(drawn)).toContain('pii-shield hid this row')
    expect(JSON.stringify(drawn)).not.toContain('jin@agentsy.ai')
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
        surface: 'terminal',
        component: 'AssistantMessage',
        requestId: 'msg_7',
        props: { text: 'mail jin@agentsy.ai', isFirstOfReply: true },
      })

    const turnedOn = await $.command.run({ ...RUN, command: 'redact', args: 'on' })
    expect(turnedOn.text).toContain('REDACTING')
    expect(statuses[statuses.length - 1]).toBe('● REDACTING')
    await draw()
    expect(seen.AssistantMessage?.text).toBe(`mail ${mask('email')}`)

    const status = await $.command.run({ ...RUN, command: 'redact', args: 'status' })
    expect(status.text).toContain('mode: on, set by /redact')

    await $.command.run({ ...RUN, command: 'redact', args: 'off' })
    expect(statuses[statuses.length - 1]).toBe('○ pii-shield')
    await draw()
    expect(seen.AssistantMessage?.text).toBe('mail jin@agentsy.ai')

    const usage = await $.command.run({ ...RUN, command: 'redact', args: 'sideways' })
    expect(usage.text).toContain('Usage')
  })

  test('auto mode turns on when a recorder appears, and stays on', async ($, on) => {
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
    const draw = () =>
      $.ui.render({
        surface: 'terminal',
        component: 'AssistantMessage',
        requestId: 'msg_8',
        props: { text: 'jins (Jin Song) at /home/jins', isFirstOfReply: true },
      })

    await $.session.start({ cwd: '/home/jins/app', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(statuses[statuses.length - 1]).toBe('○ pii-shield')
    await draw()
    expect(seen.AssistantMessage?.text).toBe('jins (Jin Song) at /home/jins')

    isRecording = true
    await clock.advance(5000)
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain('OBS detected')
    expect(statuses[statuses.length - 1]).toBe('● REDACTING')
    await draw()
    // The OS username and git user.name were picked up at session start.
    expect(seen.AssistantMessage?.text).toBe(`${BLOCK} (${BLOCK}) at /home/${BLOCK}`)

    // Sticky: the recorder quits, redaction stays on, no second toast.
    isRecording = false
    await clock.advance(15000)
    await draw()
    expect(seen.AssistantMessage?.text).toBe(`${BLOCK} (${BLOCK}) at /home/${BLOCK}`)
    expect(toasts.length).toBe(1)

    const status = await $.command.run({ ...RUN, command: 'redact', args: 'status' })
    expect(status.text).toContain('Recorder seen this session: OBS')

    // Only /redact off turns it off.
    await $.command.run({ ...RUN, command: 'redact', args: 'off' })
    await draw()
    expect(seen.AssistantMessage?.text).toBe('jins (Jin Song) at /home/jins')
  })
})

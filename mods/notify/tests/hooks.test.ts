import type { HttpInit, On, ProcessRunResult } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

type Host = {
  /** `uname -s` output; 'Darwin' or 'Linux'. */
  os: 'Darwin' | 'Linux'
  /** Binaries that cannot start on this host. */
  missing?: readonly string[]
  /** The bundle id `lsappinfo` says is frontmost. */
  front?: string
}

const ok = (stdout = ''): { value: ProcessRunResult } => ({ value: {
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
} })

/** Answers `$.process.run` beneath the plugin and records each argv it was asked to run. */
function fakeHost(on: On, host: Host): string[][] {
  const calls: string[][] = []
  engineBottom(on)
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const bin = argv[0] ?? ''
    if (host.missing?.includes(bin)) throw new Error(`spawn ${bin} ENOENT`)
    if (bin === 'uname') return ok(`${host.os}\n`)
    if (bin === 'lsappinfo' && argv[1] === 'front') return ok('ASN:0x0-0x1d01d:\n')
    if (bin === 'lsappinfo') return ok(`"CFBundleIdentifier"="${host.front ?? 'com.apple.finder'}"\n`)
    return ok()
  })
  return calls
}

/** What the engine answers beneath the plugins for the events these tests raise. */
function engineBottom(on: On): void {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Notification', () => ({}))
  on('classic.StopFailure', () => ({}))
  on('classic.SubagentStop', () => ({}))
}

/** `/notify <args>` as the person typing it at the prompt. */
const slash = (args: string) => ({
  command: 'notify',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const notifications = (calls: string[][]): string[][] =>
  calls.filter(a => ['terminal-notifier', 'osascript', 'notify-send'].includes(a[0] ?? ''))

const complete = (turnId: string, durationMs: number) => ({
  answer: 'Refactored the parser.\n\nDetails…',
  durationMs,
  isAborted: false,
  turnId,
  reason: 'answer' as const,
})

describe('turn done', () => {
  test('a long turn on macOS sends one terminal-notifier notification', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.env(on, { TERM_PROGRAM: 'iTerm.app' })
    const calls = fakeHost(on, { os: 'Darwin' })

    await $.turn.start({ text: 'refactor it', turnId: 't1' })
    await clock.advance(45_000)
    await $.turn.complete(complete('t1', 45_000))
    await clock.settle()
    await clock.settle()

    const sent = notifications(calls)
    expect(sent).toHaveLength(1)
    const argv = sent[0] ?? []
    expect(argv[0]).toBe('terminal-notifier')
    expect(argv[argv.indexOf('-title') + 1]).toStartWith('Claude Code')
    expect(argv[argv.indexOf('-message') + 1]).toBe('Done in 45s: Refactored the parser.')
    expect(argv[argv.indexOf('-sound') + 1]).toBe('Glass')
    expect(argv[argv.indexOf('-activate') + 1]).toBe('com.googlecode.iterm2')
    expect(argv[argv.indexOf('-group') + 1]).toStartWith('claude-code-')
  })

  test('a short turn sends nothing', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    const calls = fakeHost(on, { os: 'Darwin' })

    await $.turn.start({ text: 'hi', turnId: 't1' })
    await clock.advance(5_000)
    await $.turn.complete(complete('t1', 5_000))
    await clock.settle()

    expect(notifications(calls)).toHaveLength(0)
  })

  test('no notification while the terminal is frontmost', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { TERM_PROGRAM: 'Apple_Terminal' })
    const calls = fakeHost(on, { os: 'Darwin', front: 'com.apple.Terminal' })

    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(60_000)
    await $.turn.complete(complete('t1', 60_000))
    await clock.settle()
    await clock.settle()

    expect(calls.some(a => a[0] === 'lsappinfo')).toBe(true)
    expect(notifications(calls)).toHaveLength(0)
  })
})

test('shorter minTurnSeconds lets a 5s turn notify', { options: { minTurnSeconds: 2 } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const calls = fakeHost(on, { os: 'Linux' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(5_000)
  await $.turn.complete(complete('t1', 5_000))
  await clock.settle()
  await clock.settle()
  const sent = notifications(calls)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.slice(0, 4)).toEqual(['notify-send', '-a', 'Claude Code', '--'])
})

describe('delivery', () => {
  test('falls back to osascript when terminal-notifier is missing, then caches it', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    const calls = fakeHost(on, { os: 'Darwin', missing: ['terminal-notifier'] })

    await $.classic.Notification({ message: 'Claude needs your permission to use "Bash"', notification_type: 'permission_prompt' })
    await clock.settle()
    await clock.settle()

    expect(calls.filter(a => a[0] === 'terminal-notifier')).toHaveLength(1)
    const script = calls.find(a => a[0] === 'osascript')
    expect(script?.[2]).toBe(
      'display notification "Claude needs your permission to use \\"Bash\\"" with title "' +
        (script?.[2]?.match(/with title "([^"]*)"/)?.[1] ?? '') +
        '" sound name "Glass"',
    )

    await clock.advance(6_000)
    await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
    await clock.settle()
    await clock.settle()

    // the second goes straight to the cached backend
    expect(calls.filter(a => a[0] === 'terminal-notifier')).toHaveLength(1)
    expect(calls.filter(a => a[0] === 'osascript')).toHaveLength(2)
  })

  test('no notifier on the host never breaks the hook', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    fakeHost(on, { os: 'Linux', missing: ['notify-send'] })

    await expect($.classic.StopFailure({ error: 'rate_limit' })).resolves.toEqual({})
    await clock.settle()
  })
})

describe('needs input', () => {
  test('throttles to one notification per kind per 5 seconds', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    const calls = fakeHost(on, { os: 'Linux' })
    on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { questions: [], answers: {} } as never }))

    await $.classic.Notification({ message: 'Permission needed', notification_type: 'permission_prompt' })
    await $.tool.call({
      tool: 'AskUserQuestion',
      questions: [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] }],
    })
    await clock.settle()
    await clock.settle()
    expect(notifications(calls)).toHaveLength(1)

    await clock.advance(5_000)
    await $.tool.call({
      tool: 'AskUserQuestion',
      questions: [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] }],
    })
    await clock.settle()
    await clock.settle()
    const sent = notifications(calls)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.at(-1)).toBe('Question: Which DB?')
  })
})

describe('subagents and errors', () => {
  test('SubagentStop names the agent from $.agent.list or its type', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    const calls = fakeHost(on, { os: 'Linux' })

    await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'a1', agent_transcript_path: '', agent_type: 'Explore' })
    await clock.settle()
    await clock.settle()
    const body = notifications(calls)[0]?.at(-1)
    expect(body).toStartWith('Agent done: ')
  })

  test('a failed turn and its StopFailure make one error notification', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    const calls = fakeHost(on, { os: 'Linux' })

    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'error' })
    await $.classic.StopFailure({ error: 'overloaded' })
    await clock.settle()
    await clock.settle()
    const sent = notifications(calls)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.at(-1)).toStartWith('Error:')
  })
})

describe('/notify', () => {
  test('off mutes the session, on unmutes, test always sends', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    const calls = fakeHost(on, { os: 'Linux' })

    expect((await $.command.run(slash('off'))).text).toContain('muted')
    await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' })
    await clock.settle()
    expect(notifications(calls)).toHaveLength(0)

    const tested = await $.command.run(slash('test'))
    expect(tested.text).toContain('via notify-send')
    expect(notifications(calls)).toHaveLength(1)

    const status = await $.command.run(slash('status'))
    expect(status.text).toContain('muted for this session')
    expect(status.text).toContain('backend: notify-send')

    await $.command.run(slash('on'))
    await $.classic.Notification({ message: 'y', notification_type: 'permission_prompt' })
    await clock.settle()
    await clock.settle()
    expect(notifications(calls)).toHaveLength(2)
  })
})

// --- ntfy (phone push) --------------------------------------------------------

const TOPIC = 'claude-x7Hq9vR2mK4pL8sT'
const NTFY = { options: { ntfyTopic: TOPIC } }

type Fetched = { url: string; init: HttpInit | undefined }

/** Answers `$.http.fetch` beneath the plugin: 200, a status, or a thrown network error. */
function fakeNet(on: On, answer: number | 'throw' = 200): Fetched[] {
  const calls: Fetched[] = []
  on('http.fetch', ($, e) => {
    calls.push({ url: e.url, init: e.init })
    if (answer === 'throw') return { deny: 'getaddrinfo ENOTFOUND ntfy.sh' }
    return { value: { status: answer, ok: answer >= 200 && answer < 300, headers: {}, text: answer >= 300 ? 'nope' : '{}' } }
  })
  return calls
}

describe('ntfy', () => {
  test('cloud session (Linux, no notifier) still pushes to the phone', NTFY, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    const calls = fakeHost(on, { os: 'Linux', missing: ['notify-send'] })
    const net = fakeNet(on)
    // a repo name with a non-ASCII letter, as a cloud checkout may have
    on('session.repo', () => ({ value: null }))
    on('session.cwd', () => ({ value: '/home/user/café' }))

    await $.classic.Notification({ message: 'Claude needs your permission to use "Bash"', notification_type: 'permission_prompt' })
    await clock.settle()
    await clock.settle()

    expect(calls.filter(a => a[0] === 'notify-send')).toHaveLength(1) // tried, failed
    expect(net).toHaveLength(1)
    const req = net[0]
    expect(req?.url).toBe(`https://ntfy.sh/${TOPIC}`)
    expect(req?.init?.method).toBe('POST')
    expect(req?.init?.headers?.['Priority']).toBe('high')
    expect(req?.init?.headers?.['Tags']).toBe('question')
    // "Claude Code · café" is not ASCII, so the title goes RFC 2047 encoded
    expect(req?.init?.headers?.['Title']).toBe('=?UTF-8?B?Q2xhdWRlIENvZGUgwrcgY2Fmw6k=?=')
    expect(req?.init?.body).toBe('Claude needs your permission to use "Bash"')

    const status = await $.command.run(slash('status'))
    expect(status.text).toContain('backend: not chosen yet')
    expect(status.text).toContain('Last push:** delivered (HTTP 200)')
  })

  test('a long turn pushes with default priority and a check tag', { options: { ntfyTopic: TOPIC, ntfyServer: 'https://push.example.com/' } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    fakeHost(on, { os: 'Linux' })
    const net = fakeNet(on)

    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(45_000)
    await $.turn.complete(complete('t1', 45_000))
    await clock.settle()
    await clock.settle()

    expect(net).toHaveLength(1)
    expect(net[0]?.url).toBe(`https://push.example.com/${TOPIC}`)
    expect(net[0]?.init?.headers).toMatchObject({ Priority: 'default', Tags: 'white_check_mark' })
    expect(net[0]?.init?.body).toBe('Done in 45s: Refactored the parser.')
  })

  test('ntfy failing never stops the desktop notification, and vice versa', NTFY, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    const calls = fakeHost(on, { os: 'Linux' })
    const net = fakeNet(on, 'throw')

    await expect($.classic.StopFailure({ error: 'overloaded' })).resolves.toEqual({})
    await clock.settle()
    await clock.settle()
    expect(notifications(calls)).toHaveLength(1)
    expect(net).toHaveLength(1)
    expect(net[0]?.init?.headers).toMatchObject({ Priority: 'high', Tags: 'warning' })

    const status = await $.command.run(slash('status'))
    expect(status.text).toContain('Last push:** failed')
    expect(status.text).toContain('getaddrinfo ENOTFOUND')
  })

  test('without a topic nothing is fetched', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    fakeHost(on, { os: 'Linux' })
    const net = fakeNet(on)
    await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' })
    await clock.settle()
    await clock.settle()
    expect(net).toHaveLength(0)
  })

  test('focused terminal on macOS: no desktop note and no phone push', NTFY, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { TERM_PROGRAM: 'Apple_Terminal' })
    const calls = fakeHost(on, { os: 'Darwin', front: 'com.apple.Terminal' })
    const net = fakeNet(on)
    await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' })
    await clock.settle()
    await clock.settle()
    expect(notifications(calls)).toHaveLength(0)
    expect(net).toHaveLength(0)
  })

  test('ntfyOnlyWhenAway off: the phone gets it even while the terminal is focused', { options: { ntfyTopic: TOPIC, ntfyOnlyWhenAway: false } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { TERM_PROGRAM: 'Apple_Terminal' })
    const calls = fakeHost(on, { os: 'Darwin', front: 'com.apple.Terminal' })
    const net = fakeNet(on)
    await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' })
    await clock.settle()
    await clock.settle()
    expect(notifications(calls)).toHaveLength(0)
    expect(net).toHaveLength(1)
  })

  test('unfocused on macOS: desktop and phone both', NTFY, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { TERM_PROGRAM: 'Apple_Terminal' })
    const calls = fakeHost(on, { os: 'Darwin', front: 'com.apple.finder' })
    const net = fakeNet(on)
    await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' })
    await clock.settle()
    await clock.settle()
    expect(notifications(calls)).toHaveLength(1)
    expect(net).toHaveLength(1)
  })

  test('/notify test sends to both and reports each', NTFY, async ($, on) => {
    mock.clock(on)
    mock.env(on, {})
    const calls = fakeHost(on, { os: 'Linux' })
    const net = fakeNet(on)
    const r = await $.command.run(slash('test'))
    expect(r.text).toContain('desktop sent via notify-send')
    expect(r.text).toContain('phone push sent via ntfy (HTTP 200)')
    expect(notifications(calls)).toHaveLength(1)
    expect(net).toHaveLength(1)
    expect(net[0]?.init?.headers?.['Tags']).toBe('bell')
  })

  test('/notify test reports a rejected push', NTFY, async ($, on) => {
    mock.clock(on)
    mock.env(on, {})
    fakeHost(on, { os: 'Linux', missing: ['notify-send'] })
    fakeNet(on, 403)
    const r = await $.command.run(slash('test'))
    expect(r.text).toContain('desktop could not send')
    expect(r.text).toContain('phone push failed (HTTP 403: nope)')
  })
})

describe('/notify status output', () => {
  test('masks the topic and draws as a card on every surface, compact on mobile', NTFY, async ($, on) => {
    mock.clock(on)
    mock.env(on, {})
    fakeHost(on, { os: 'Linux' })
    fakeNet(on)

    const text = (await $.command.run(slash('status'))).text ?? ''
    expect(text).not.toContain(TOPIC)
    expect(text).toContain('`https://ntfy.sh/cl••••sT`')

    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({
        plugin: 'notify',
        surface,
        component: 'CommandOutput',
        props: { command: 'notify', args: 'status', text, isErrored: false },
        viewport: { columns: surface === 'mobile' ? 40 : 100, rows: 40, isFullscreen: false },
      })
      const head = await ui.find({ type: 'Text', text: /notify · on/ })
      expect(head?.text).toBe('🔔 notify · on')
      const md = await ui.find({ type: 'Markdown' })
      expect(md?.text).toContain('cl••••sT')
      expect(md?.text).not.toContain(TOPIC)
      const root = await ui.drawn()
      expect(root.type).toBe('Box')
      const rootProps: Record<string, unknown> = ('props' in root ? root.props : undefined) ?? {}
      expect(rootProps['borderStyle']).toBe(surface === 'mobile' ? undefined : 'round')
      await ui.unmount()
    }
  })

  test('other /notify rows are left to the engine', async ($, on) => {
    mock.clock(on)
    mock.env(on, {})
    let reached = 0
    on('ui.render', () => {
      reached += 1
      return { type: 'engine', ref: 0 } as const
    })
    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({
        plugin: 'notify',
        surface,
        component: 'CommandOutput',
        props: { command: 'notify', args: 'on', text: 'notify: on.', isErrored: false },
      })
      expect(await ui.find({ type: 'Markdown', text: /cl••••/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /🔔/ })).toBeUndefined()
      await ui.unmount()
    }
    expect(reached).toBe(3)
  })
})

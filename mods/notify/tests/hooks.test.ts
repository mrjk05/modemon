import type { On, ProcessRunResult } from 'claude-code'
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

import type { EngineInterface, Register } from 'claude-code'

import {
  HELP,
  Throttle,
  argvFor,
  askBody,
  backendsFor,
  baseName,
  doneBody,
  errorBody,
  isNeedsInput,
  isStatusText,
  needsInputBody,
  ntfyRequest,
  ntfyTarget,
  parseBundleId,
  parseCommand,
  parseFrontAsn,
  platformFromUname,
  readConfig,
  shouldPush,
  statusMarkdown,
  subagentBody,
  terminalBundle,
  titleFor,
} from './lib'
import type { Backend, Config, Kind, Note, Platform } from './lib'

type $ = EngineInterface

const muted = { plugin: 'notify', key: 'muted' } as const

const RUN_TIMEOUT_MS = 5000

// Per load: lost on a hot reload, which only means probing again.
let config: Config = readConfig(undefined)
const throttle = new Throttle(5000)
const turnStarts = new Map<string, number>()
const agentDescriptions = new Map<string, string>()
const agentsNotified = new Set<string>()
let platform: Platform | undefined
let backend: Backend | undefined
let lastError: string | undefined
let lastNtfy: string | undefined
let bundle: { id: string | undefined } | undefined

async function getPlatform($: $): Promise<Platform> {
  if (platform !== undefined) return platform
  try {
    const r = await $.process.run(['uname', '-s'], { timeoutMs: RUN_TIMEOUT_MS })
    platform = r.exitCode === 0 ? platformFromUname(r.stdout) : 'other'
  } catch {
    platform = 'other' // no uname: Windows or a locked-down host
  }
  return platform
}

async function getBundle($: $): Promise<string | undefined> {
  if (bundle !== undefined) return bundle.id
  const termProgram = await $.env.get('TERM_PROGRAM')
  const cfBundle = await $.env.get('__CFBundleIdentifier')
  bundle = { id: terminalBundle(termProgram, cfBundle) }
  return bundle.id
}

/** macOS only: is the app the session runs in the frontmost app? */
async function isTerminalFrontmost($: $): Promise<boolean> {
  if ((await getPlatform($)) !== 'darwin') return false
  const mine = await getBundle($)
  if (mine === undefined) return false
  try {
    const front = await $.process.run(['lsappinfo', 'front'], { timeoutMs: RUN_TIMEOUT_MS })
    const asn = parseFrontAsn(front.stdout)
    if (asn === undefined) return false
    const info = await $.process.run(['lsappinfo', 'info', '-only', 'bundleid', asn], {
      timeoutMs: RUN_TIMEOUT_MS,
    })
    return parseBundleId(info.stdout) === mine
  } catch {
    return false
  }
}

async function buildNote($: $, body: string): Promise<Note> {
  let repoName: string | undefined
  try {
    const repo = await $.session.repo()
    repoName = baseName(repo !== null ? repo.root : await $.session.cwd())
  } catch {
    repoName = undefined
  }
  let sessionId = 'session'
  try {
    sessionId = await $.session.id()
  } catch {
    // keep the generic group
  }
  const activate = (await getPlatform($)) === 'darwin' ? await getBundle($) : undefined
  return {
    title: titleFor(repoName),
    body,
    sound: config.sound,
    group: `claude-code-${sessionId}`,
    ...(activate !== undefined ? { activate } : {}),
  }
}

type Sent = { isSent: true; backend: Backend } | { isSent: false; reason: string }

/** Tries the cached backend first, then the platform's others, caching the one that works. */
async function send($: $, note: Note): Promise<Sent> {
  const all = backendsFor(await getPlatform($))
  if (all.length === 0) return { isSent: false, reason: `no notifier for this platform (${platform})` }
  const order = backend !== undefined ? [backend, ...all.filter(b => b !== backend)] : all
  for (const b of order) {
    try {
      const r = await $.process.run(argvFor(b, note), { timeoutMs: RUN_TIMEOUT_MS })
      if (r.exitCode === 0) {
        backend = b
        lastError = undefined
        return { isSent: true, backend: b }
      }
      lastError = `${b} exited ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 200)}` : ''}`
    } catch (err) {
      lastError = `${b} could not run: ${err instanceof Error ? err.message : String(err)}`
    }
    if (backend === b) backend = undefined
  }
  return { isSent: false, reason: lastError ?? 'no notifier worked' }
}

type Pushed = { isSent: true; status: number } | { isSent: false; reason: string }

/** POSTs the note to the configured ntfy topic through `$.http.fetch`. Never throws. */
async function push($: $, kind: Kind, note: Note): Promise<Pushed> {
  const target = ntfyTarget(config.ntfyServer, config.ntfyTopic)
  if ('error' in target) return { isSent: false, reason: target.error }
  const req = ntfyRequest(target.url, kind, note)
  try {
    const r = await $.http.fetch(req.url, req.init)
    if (r.ok) {
      lastNtfy = `delivered (HTTP ${r.status})`
      return { isSent: true, status: r.status }
    }
    const why = `HTTP ${r.status}${r.text.trim() ? `: ${r.text.trim().slice(0, 160)}` : ''}`
    lastNtfy = `failed, ${why}`
    return { isSent: false, reason: why }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    lastNtfy = `failed, ${why}`
    return { isSent: false, reason: why }
  }
}

const hasNtfy = (): boolean => config.ntfyTopic !== ''

async function isMuted($: $): Promise<boolean> {
  try {
    const { value } = await $.state.get(muted)
    return value === true
  } catch {
    return false
  }
}

/**
 * Decides now (mute, throttle) and delivers off the hook's path, on a timer,
 * so neither the turn nor a gating site waits on a child process.
 */
async function notify($: $, kind: Kind, body: string): Promise<void> {
  if (await isMuted($)) return
  if (!throttle.allow(kind, await $.clock.now())) return
  $.clock.after(0, () => {
    void deliver($, kind, body).catch(() => undefined)
  })
}

/**
 * Desktop first, then the phone; each in its own try, so one failing never
 * stops the other. See `shouldPush` for when the phone push is skipped.
 */
async function deliver($: $, kind: Kind, body: string): Promise<void> {
  const note = await buildNote($, body)
  const needsFocus = config.onlyWhenUnfocused || (hasNtfy() && config.ntfyOnlyWhenAway)
  let isFocused = false
  if (needsFocus) {
    try {
      isFocused = await isTerminalFrontmost($)
    } catch {
      isFocused = false
    }
  }
  let desktop: 'sent' | 'skipped' | 'failed'
  if (config.onlyWhenUnfocused && isFocused) {
    desktop = 'skipped'
  } else {
    try {
      desktop = (await send($, note)).isSent ? 'sent' : 'failed'
    } catch {
      desktop = 'failed'
    }
  }
  if (hasNtfy() && shouldPush(config.ntfyOnlyWhenAway, isFocused, desktop)) await push($, kind, note)
}

/** Runs `fn`, swallowing anything it throws: a notification never breaks a hook. */
async function quietly(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch {
    // a failed notification is not the session's problem
  }
}

async function subagentDone($: $, agentId: string, agentType: string | undefined): Promise<void> {
  if (!config.onSubagentDone || agentsNotified.has(agentId)) return
  agentsNotified.add(agentId)
  let description = agentDescriptions.get(agentId)
  if (description === undefined) {
    try {
      description = (await $.agent.list()).find(a => a.id === agentId)?.description
    } catch {
      description = undefined
    }
  }
  await notify($, 'subagent', subagentBody(description, agentType))
}

export const register: Register = (on, options) => {
  config = readConfig(options)
  throttle.reset()
  turnStarts.clear()
  agentDescriptions.clear()
  agentsNotified.clear()
  platform = undefined
  backend = undefined
  lastError = undefined
  lastNtfy = undefined
  bundle = undefined

  // --- commands -----------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await quietly(async () => {
      await $.command.register({
        name: 'notify',
        description: 'Desktop and phone (ntfy) notifications: test, on, off, status.',
        argumentHint: '[test|on|off|status]',
        immediate: true,
      })
    })
    return next(e)
  })

  on('command.run', { command: 'notify' }, async ($, e) => {
    const cmd = parseCommand(e.args)
    if (cmd === 'help') return { text: HELP }
    if (cmd === 'on' || cmd === 'off') {
      await $.state.set(muted, cmd === 'off')
      return { text: cmd === 'off' ? 'notify: muted for this session.' : 'notify: on.' }
    }
    if (cmd === 'test') {
      const note = await buildNote($, 'Test notification: notify is working.')
      let desktop: string
      try {
        const sent = await send($, note)
        desktop = sent.isSent ? `sent via ${sent.backend}` : `could not send (${sent.reason})`
      } catch (err) {
        desktop = `could not send (${err instanceof Error ? err.message : String(err)})`
      }
      const lines = [`notify: desktop ${desktop}.`]
      if (hasNtfy()) {
        const pushed = await push($, 'test', note)
        lines.push(
          pushed.isSent
            ? `notify: phone push sent via ntfy (HTTP ${pushed.status}).`
            : `notify: phone push failed (${pushed.reason}).`,
        )
      } else {
        lines.push('notify: phone push off (set ntfyTopic to turn it on).')
      }
      return { text: lines.join('\n') }
    }
    const p = await getPlatform($)
    const front = p === 'darwin' ? await getBundle($) : undefined
    const focus =
      p === 'darwin'
        ? front !== undefined
          ? `terminal ${front}`
          : 'terminal app unknown, always notifies'
        : 'focus not readable here, always notifies'
    const text = statusMarkdown({
      isMuted: await isMuted($),
      platform: p,
      backend,
      lastError,
      focus,
      lastNtfy,
      config,
    })
    return { text }
  })

  // Status drawn as a card: a coloured headline over the Markdown bullets.
  // Mobile and narrow rows get no border, so the text keeps the full width.
  on('ui.render', { component: 'CommandOutput', props: { command: 'notify' } }, async ($, e, next) => {
    if (e.props.isErrored || !isStatusText(e.props.text)) return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const [headline = '', ...rest] = e.props.text.split('\n')
    const isMutedRow = headline.includes('muted')
    const columns = e.viewport?.columns ?? 80
    const isCompact = e.surface === 'mobile' || columns < 60
    const title = headline.replace(/\*\*/g, '')
    const body = rest.join('\n').trim()
    return isCompact ? (
      <Box flexDirection="column">
        <Text bold color={isMutedRow ? 'yellow' : 'green'}>
          {`🔔 ${title}`}
        </Text>
        <Markdown text={body} />
      </Box>
    ) : (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={isMutedRow ? 'yellow' : 'green'}
        paddingX={1}
        width={Math.min(columns, 100)}
      >
        <Text bold color={isMutedRow ? 'yellow' : 'green'}>
          {`🔔 ${title}`}
        </Text>
        <Markdown text={body} />
      </Box>
    )
  })

  // --- needs input --------------------------------------------------------

  on('classic.Notification', async ($, e, next) => {
    if (config.onNeedsInput && e.agent_id === undefined && isNeedsInput(e.notification_type)) {
      await quietly(() => notify($, 'input', needsInputBody(e.notification_type, e.message)))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (config.onNeedsInput) {
      await quietly(() => notify($, 'input', askBody(e.questions)))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // --- turn done / failed -------------------------------------------------

  on('turn.start', async ($, e, next) => {
    await quietly(async () => {
      turnStarts.set(e.turnId, await $.clock.now())
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await quietly(async () => {
      const started = turnStarts.get(e.turnId)
      turnStarts.delete(e.turnId)
      if (e.agentId !== undefined || e.isAborted) return
      if (e.reason === 'error' || e.reason === 'refusal') {
        if (!config.onError) return
        const body =
          e.reason === 'refusal'
            ? `Turn ended: the model declined${e.refusal.explanation ? ` (${e.refusal.explanation})` : ''}`
            : 'Error: the turn failed on an API error'
        await notify($, 'error', body)
        return
      }
      if (!config.onTurnDone) return
      const ms = started !== undefined ? (await $.clock.now()) - started : e.durationMs
      if (ms > config.minTurnSeconds * 1000) await notify($, 'done', doneBody(ms, e.answer))
    })
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    if (config.onError && e.agent_id === undefined) {
      await quietly(() => notify($, 'error', errorBody(e.error, e.error_details)))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // --- subagents ----------------------------------------------------------

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    await quietly(async () => {
      if (ran.deny !== undefined || ran.isError === true) return
      const result: unknown = ran.result
      if (typeof result !== 'object' || result === null) return
      const r = result as { agentId?: unknown; totalDurationMs?: unknown; agentType?: unknown }
      if (typeof r.agentId !== 'string') return
      agentDescriptions.set(r.agentId, e.description)
      // A foreground agent's result arrives when it has finished.
      if (typeof r.totalDurationMs === 'number') {
        await subagentDone($, r.agentId, typeof r.agentType === 'string' ? r.agentType : undefined)
      }
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    await quietly(() => subagentDone($, e.agent_id, e.agent_type))
    return next(e)
  }).catch(($, e, next) => next(e))
}

// deploy-deck: live deploys from GitHub, Vercel, Cloudflare and Render.
//
// - A band above the prompt while anything is in flight (and a minute after
//   it finishes): one row per deploy, a coloured stage pipeline and elapsed
//   time, stacked over the other band mods' rows via next(e).
// - `/deploys`: a pane (terminal, desktop) or an inline card (mobile, or
//   wherever the pane cannot be placed) with each target's latest deploys.
// - A toast when a deploy goes live or fails, once per deploy, and a status
//   line naming the most important current item (the phone's fallback).
//
// The polling lives in ./tracker, the providers in ./providers, the pure
// helpers in ./lib. No token is ever drawn, logged or put in a message.

import { atom, read, update } from 'claude-code'
import type {
  CommandRunInput,
  CommandRunResult,
  EngineInterface,
  PluginOptions,
  Register,
  RenderElement,
  RenderNode,
  RenderSurface,
  Timer,
} from 'claude-code'

import type {
  DeployDeckBackoff,
  DeployDeckDeploy,
  DeployDeckFeed,
  DeployDeckProvider,
  DeployDeckTarget,
} from '../types'
import { detectTargets } from './detect'
import type { Run } from './lib'
import {
  INLINE_HEAD,
  PROVIDERS,
  PROVIDER_OF,
  SETUP_HELP,
  STATUS_LINGER_MS,
  allDeploys,
  authLabel,
  backoffDelay,
  bandDeploys,
  deployLabel,
  elapsedOf,
  finishedSince,
  formatAge,
  formatElapsed,
  inlineText,
  isActive,
  isTerminal,
  mergeTargets,
  parseCommand,
  parseTargetSpec,
  parseTargets,
  pipeline,
  pollInterval,
  runsText,
  setupText,
  stageColor,
  stageGlyph,
  stageWord,
  statusText,
  targetKey,
  targetLabel,
  toastText,
  truncate,
  versionLabel,
} from './lib'
import type { Client } from './net'
import { ProviderError, redact } from './net'
import type { Config } from './tracker'
import { MISSING, authOf, quietly, readTarget, secretsOf } from './tracker'

type Engine = EngineInterface

const PANE = 'deploy-deck'
const TITLE = 'Deploys'
const COMMAND = 'deploys'

// --- The tracker: targets, polling, backoff, toasts ---------------------------
//
// Everything a drawing reads lives in `$.state`. The timer's handle, its
// period and the in-flight flag are module-level on purpose: a hot reload
// drops the timers, and `ensureRunning` re-arms from the next event.

const targetsAtom = atom({ plugin: 'deploy-deck', key: 'targets' } as const, [] as DeployDeckTarget[])
const feedsAtom = atom({ plugin: 'deploy-deck', key: 'feeds' } as const, {} as Record<string, DeployDeckFeed>)
const nowAtom = atom({ plugin: 'deploy-deck', key: 'now' } as const, 0)
const announcedAtom = atom({ plugin: 'deploy-deck', key: 'announced' } as const, [] as string[])
const finishedAtom = atom({ plugin: 'deploy-deck', key: 'finished' } as const, {} as Record<string, number>)
const backoffAtom = atom(
  { plugin: 'deploy-deck', key: 'backoff' } as const,
  {} as Partial<Record<DeployDeckProvider, DeployDeckBackoff>>,
)
const intervalAtom = atom({ plugin: 'deploy-deck', key: 'intervalMs' } as const, 0)
const readyAtom = atom({ plugin: 'deploy-deck', key: 'isReady' } as const, false)

/** The polling timer and its period (runtime handles, see the header). */
let timer: Timer | undefined
let timerMs = 0
let isPolling = false

const STORE_PREFIX = 'targets:'

type Edits = { added: string[]; removed: string[] }

async function rootOf($: Engine): Promise<{ root: string; remote: string | null }> {
  const repo = await $.session.repo().catch(() => null)
  if (repo !== null) return { root: repo.root, remote: repo.remote }
  return { root: await $.session.root(), remote: null }
}

async function readEdits($: Engine): Promise<Edits> {
  const { root } = await rootOf($)
  const stored = (await $.store.get(STORE_PREFIX + root).catch(() => undefined)) as Partial<Edits> | undefined
  return {
    added: Array.isArray(stored?.added) ? stored.added.filter((s): s is string => typeof s === 'string') : [],
    removed: Array.isArray(stored?.removed) ? stored.removed.filter((s): s is string => typeof s === 'string') : [],
  }
}

async function writeEdits($: Engine, edits: Edits): Promise<void> {
  const { root } = await rootOf($)
  await $.store.set(STORE_PREFIX + root, edits)
}

/** Detected + pinned + added, minus removed; keeps meta learned earlier. */
async function resolveTargets($: Engine, cfg: Config): Promise<DeployDeckTarget[]> {
  const { root, remote } = await rootOf($)
  const detected = cfg.autoDetect
    ? await detectTargets(root, remote, async path => {
        try {
          if (!(await $.fs.exists(path))) return undefined
          return await $.fs.read(path)
        } catch {
          return undefined
        }
      })
    : []
  const pinned = parseTargets(cfg.targets, 'pinned').targets
  const edits = await readEdits($)
  const added = edits.added
    .map(spec => parseTargetSpec(spec, 'added'))
    .filter((t): t is DeployDeckTarget => typeof t !== 'string')
  const before = new Map((await read($, targetsAtom)).map(t => [targetKey(t), t]))
  const merged = mergeTargets([added, pinned, detected], edits.removed).map(target => {
    const known = before.get(targetKey(target))
    return known?.meta !== undefined ? { ...target, meta: { ...target.meta, ...known.meta } } : target
  })
  await update($, targetsAtom, () => merged)
  await update($, feedsAtom, feeds => {
    const next: Record<string, DeployDeckFeed> = {}
    for (const target of merged) {
      const key = targetKey(target)
      const auth = authOf(PROVIDER_OF[target.kind], cfg)
      const old = feeds[key]
      next[key] = old !== undefined ? { ...old, target, auth } : { target, deploys: [], auth, primed: false }
    }
    return next
  })
  await update($, readyAtom, () => true)
  return merged
}

/**
 * Reads every target due (all of them with `force`), records what changed,
 * toasts finished deploys once, then re-arms the timer at the right speed.
 */
async function pollOnce($: Engine, cfg: Config, force = false): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    if (!(await read($, readyAtom))) await resolveTargets($, cfg)
    const now = await $.clock.now()
    const targets = await read($, targetsAtom)
    const secrets = secretsOf(cfg)
    const toToast: DeployDeckDeploy[] = []
    const finishedNow: string[] = []
    for (const target of targets) {
      const provider = PROVIDER_OF[target.kind]
      const key = targetKey(target)
      const auth = authOf(provider, cfg)
      if (auth === 'none') {
        await update($, feedsAtom, feeds => ({
          ...feeds,
          [key]: { ...(feeds[key] ?? { target, deploys: [], primed: false }), target, auth, error: MISSING[provider] },
        }))
        continue
      }
      const rest = (await read($, backoffAtom))[provider]
      if (!force && rest !== undefined && rest.until > now) continue
      const client: Client = {
        provider,
        fetch: (url, init) => $.http.fetch(url, init),
        run: argv => $.process.run(argv, { timeoutMs: 20_000 }),
        secrets,
        now,
      }
      const token = cfg.tokens[provider]
      if (auth === 'token' && token !== undefined) client.token = token
      try {
        const got = await readTarget(client, target, cfg)
        const previous = (await read($, feedsAtom))[key]
        for (const deploy of finishedSince(previous, got.deploys)) {
          finishedNow.push(deploy.key)
          if (deploy.stage === 'live' || deploy.stage === 'failed') toToast.push(deploy)
        }
        const learned = got.meta
        const nextTarget = learned !== undefined ? { ...target, meta: { ...target.meta, ...learned } } : target
        if (learned !== undefined) {
          await update($, targetsAtom, list => list.map(t => (targetKey(t) === key ? nextTarget : t)))
        }
        await update($, feedsAtom, feeds => ({
          ...feeds,
          [key]: { target: nextTarget, deploys: got.deploys.slice(0, 10), auth, checkedAt: now, primed: true },
        }))
        await update($, backoffAtom, all => {
          const copy = { ...all }
          delete copy[provider]
          return copy
        })
      } catch (error) {
        const failure =
          error instanceof ProviderError
            ? error
            : new ProviderError(provider, 'parse', `${provider}: ${redact(error instanceof Error ? error.message : String(error), secrets).slice(0, 120)}`)
        const failures = (rest?.failures ?? 0) + 1
        const until = now + backoffDelay(failure.kind, failures, failure.retryAfterMs)
        await update($, backoffAtom, all => ({ ...all, [provider]: { until, failures, reason: failure.kind } }))
        await update($, feedsAtom, feeds => ({
          ...feeds,
          [key]: { ...(feeds[key] ?? { target, deploys: [], primed: false }), target, auth, error: failure.message, checkedAt: now },
        }))
      }
    }
    await update($, nowAtom, () => now)
    await update($, finishedAtom, seen => {
      const kept: Record<string, number> = {}
      for (const [key, at] of Object.entries(seen)) if (now - at < STATUS_LINGER_MS) kept[key] = at
      for (const key of finishedNow) kept[key] ??= now
      return kept
    })
    const announced = new Set(await read($, announcedAtom))
    const fresh = toToast.filter(deploy => !announced.has(deploy.key))
    if (fresh.length > 0) {
      await update($, announcedAtom, list => [...list, ...fresh.map(d => d.key)].slice(-500))
      if (cfg.toasts) for (const deploy of fresh) $.ui.toast(toastText(deploy), { timeoutMs: 8000 })
    }
  } finally {
    isPolling = false
  }
  await settle($, cfg)
}

/** Status line and timer follow the state. */
async function settle($: Engine, cfg: Config): Promise<void> {
  const feeds = await read($, feedsAtom)
  const now = await read($, nowAtom)
  if (cfg.statusLine) $.ui.status(statusText(feeds, await read($, finishedAtom), now))
  const targets = await read($, targetsAtom)
  const isAnyActive = allDeploys(feeds).some(deploy => isActive(deploy, now))
  const want = targets.length === 0 ? 0 : pollInterval(isAnyActive, cfg.fastMs, cfg.slowMs)
  if (want !== timerMs || (want > 0 && timer === undefined)) {
    timer?.cancel()
    timer = undefined
    timerMs = want
    if (want > 0) timer = $.clock.every(want, () => void quietly(() => pollOnce($, cfg)))
  }
  if ((await read($, intervalAtom)) !== want) await update($, intervalAtom, () => want)
}

/** Re-arms after a hot reload (the timers went with the old module). */
async function ensureRunning($: Engine, cfg: Config): Promise<void> {
  if (timer !== undefined) return
  if (!(await read($, readyAtom))) {
    await resolveTargets($, cfg)
    void quietly(() => pollOnce($, cfg))
    return
  }
  await settle($, cfg)
}

/** Stops polling (tests, and a session's end). */
function stop(): void {
  timer?.cancel()
  timer = undefined
  timerMs = 0
}


function configOf(options: PluginOptions): Config {
  const text = (key: string): string => {
    const value = options[key]
    return typeof value === 'string' ? value.trim() : ''
  }
  const seconds = (key: string, fallback: number, min: number): number => {
    const value = options[key]
    return (typeof value === 'number' && Number.isFinite(value) ? Math.max(min, value) : fallback) * 1000
  }
  const tokens: Partial<Record<DeployDeckProvider, string>> = {}
  const pairs: [DeployDeckProvider, string][] = [
    ['github', 'githubToken'],
    ['vercel', 'vercelToken'],
    ['cloudflare', 'cloudflareToken'],
    ['render', 'renderToken'],
  ]
  for (const [provider, key] of pairs) {
    const token = text(key)
    if (token !== '') tokens[provider] = token
  }
  return {
    tokens,
    vercelTeamId: text('vercelTeamId'),
    cloudflareAccountId: text('cloudflareAccountId'),
    targets: text('targets'),
    autoDetect: options['autoDetect'] !== false,
    useCli: options['useCli'] !== false,
    fastMs: seconds('fastSeconds', 10, 5),
    slowMs: seconds('slowSeconds', 120, 30),
    band: options['band'] !== false,
    toasts: options['toasts'] !== false,
    statusLine: options['statusLine'] !== false,
  }
}

/** Links separated by ` · `, as children of one Text. */
function joinLinks(links: readonly RenderElement[]): RenderNode[] {
  return links.flatMap((link, index) => (index === 0 ? [link] : [' · ', link]))
}

/** True when `node` would draw nothing (the engine's own empty band included). */
function drawsNothing(node: RenderNode | undefined | null): boolean {
  if (node === undefined || node === null) return true
  if (typeof node === 'string') return node === ''
  if (node.type === 'engine') return true
  if (node.type === 'Box' || node.type === 'Text') return (node.children ?? []).every(drawsNothing)
  return false
}

async function surfacesOf($: Engine): Promise<readonly RenderSurface[]> {
  try {
    return await $.session.surfaces()
  } catch {
    return []
  }
}

function isUnconfigured(targets: readonly DeployDeckTarget[], cfg: Config): boolean {
  return targets.length === 0 || targets.every(target => authOf(PROVIDER_OF[target.kind], cfg) === 'none')
}

async function inline($: Engine, cfg: Config): Promise<CommandRunResult> {
  const targets = await read($, targetsAtom)
  const feeds = await read($, feedsAtom)
  const now = await $.clock.now()
  const text = inlineText(targets, feeds, now)
  return { text: isUnconfigured(targets, cfg) && targets.length > 0 ? `${text}\n\n${setupText()}` : text }
}

function intervalWords(ms: number): string {
  return ms === 0 ? 'stopped (no targets)' : `every ${Math.round(ms / 1000)}s`
}

async function statusReport($: Engine, cfg: Config): Promise<string> {
  const targets = await read($, targetsAtom)
  const feeds = await read($, feedsAtom)
  const backoff = await read($, backoffAtom)
  const now = await $.clock.now()
  const lines = ['**Deploy deck status**', '']
  for (const provider of PROVIDERS) {
    const auth = authOf(provider, cfg)
    const mine = targets.filter(target => PROVIDER_OF[target.kind] === provider)
    const source =
      auth === 'token'
        ? `${provider}Token set`
        : auth === 'cli'
          ? 'gh CLI (no githubToken)'
          : 'not configured'
    const rest = backoff[provider]
    const resting = rest !== undefined && rest.until > now ? ` · backing off ${formatElapsed(rest.until - now)} (${rest.reason})` : ''
    const list =
      mine.length === 0
        ? 'no targets'
        : mine.map(target => `${targetLabel(target)} (${target.source})`).join(', ')
    lines.push(`- **${provider}**: ${authLabel(auth, provider)} · ${source}${resting} · ${list}`)
    for (const target of mine) {
      const error = feeds[targetKey(target)]?.error
      if (error !== undefined) lines.push(`  - ⚠ ${error}`)
    }
  }
  lines.push('', `Polling ${intervalWords(await read($, intervalAtom))}.`)
  if (isUnconfigured(targets, cfg)) lines.push('', setupText())
  return lines.join('\n')
}

async function runCommand($: Engine, cfg: Config, e: CommandRunInput): Promise<CommandRunResult> {
  const command = parseCommand(e.args)
  await ensureRunning($, cfg)
  switch (command.verb) {
    case 'help':
      return {
        text: `Usage: /${COMMAND} opens the deploys panel; /${COMMAND} refresh | add <provider:id> | remove <provider:id> | status | close.`,
      }
    case 'status':
      return { text: await statusReport($, cfg) }
    case 'refresh': {
      await update($, backoffAtom, () => ({}))
      await resolveTargets($, cfg)
      await pollOnce($, cfg, true)
      const feeds = await read($, feedsAtom)
      const now = await read($, nowAtom)
      const list = Object.values(feeds)
      const active = list.flatMap(feed => feed.deploys).filter(deploy => isActive(deploy, now)).length
      const errors = list.filter(feed => feed.error !== undefined).length
      return {
        text:
          list.length === 0
            ? `Nothing to refresh: no targets.\n\n${setupText()}`
            : `Refreshed ${list.length} target${list.length === 1 ? '' : 's'}: ${active} in flight${errors > 0 ? `, ${errors} with errors (see /${COMMAND} status)` : ''}.`,
      }
    }
    case 'add':
    case 'remove': {
      const parsed = parseTargetSpec(command.spec, 'added')
      if (typeof parsed === 'string') return { text: `deploy-deck: ${parsed}.` }
      const spec = targetLabel(parsed)
      const edits = await readEdits($)
      if (command.verb === 'add') {
        await writeEdits($, {
          added: [...edits.added.filter(s => s !== spec), spec],
          removed: edits.removed.filter(s => s !== spec),
        })
      } else {
        const isKnown = (await read($, targetsAtom)).some(target => targetKey(target) === spec)
        if (!isKnown) return { text: `Not tracking ${spec}.` }
        await writeEdits($, {
          added: edits.added.filter(s => s !== spec),
          removed: [...edits.removed.filter(s => s !== spec), spec],
        })
      }
      await resolveTargets($, cfg)
      if (command.verb === 'add') await pollOnce($, cfg, true)
      else await settle($, cfg)
      const provider = PROVIDER_OF[parsed.kind]
      const hint = command.verb === 'add' && authOf(provider, cfg) === 'none' ? ` It needs credentials: ${SETUP_HELP[provider]}` : ''
      return { text: command.verb === 'add' ? `Tracking ${spec}.${hint}` : `Stopped tracking ${spec}.` }
    }
    case 'close': {
      const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
      if (isUp) await $.ui.close({ id: PANE })
      return { text: 'Deploys panel closed.' }
    }
    case 'open': {
      const targets = await read($, targetsAtom)
      if (isUnconfigured(targets, cfg)) return inline($, cfg)
      const surfaces = await surfacesOf($)
      const isPhoneOnly = surfaces.length > 0 && surfaces.every(surface => surface === 'mobile')
      const isFromPhone = isPhoneOnly || (e.origin.kind === 'bridge' && surfaces.includes('mobile'))
      if (isFromPhone) return inline($, cfg)
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      if (opened.isPlaced) return { text: 'Deploys panel opened.' }
      return inline($, cfg)
    }
  }
}

export const register: Register = (on, options: PluginOptions) => {
  const cfg = configOf(options)

  on('session.start', async ($, e, next) => {
    await quietly(() =>
      $.command.register({
        name: COMMAND,
        description: 'Deploys panel: latest deploys per target; refresh | add <provider:id> | remove <provider:id> | status',
        argumentHint: '[refresh|add <provider:id>|remove <provider:id>|status|close]',
      }),
    )
    stop()
    await quietly(() => resolveTargets($, cfg))
    // The first read runs in the background: the session never waits on a provider.
    void quietly(() => pollOnce($, cfg))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stop()
    return next(e)
  })

  // Timers die with a hot reload: any turn re-arms them.
  on('prompt.submit', async ($, e, next) => {
    await quietly(() => ensureRunning($, cfg))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, ($, e) => runCommand($, cfg, e)).catch(($, e, next) =>
    next.called ? next(e) : { text: 'deploy-deck: the command failed.' },
  )

  // --- The band ---------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const feeds = await read($, feedsAtom)
    const finished = await read($, finishedAtom)
    const now = await read($, nowAtom)
    const shown = cfg.band && !e.props.hasSurvey ? bandDeploys(feeds, finished, now) : []
    const below = await next(e)
    if (shown.length === 0) return below

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(10, e.props.bodyColumns)
    const room = Math.max(1, e.props.maxRows - (drawsNothing(below) ? 0 : 1))
    const visible = shown.length > room ? shown.slice(0, Math.max(0, room - 1)) : shown
    const hidden = shown.length - visible.length
    const styled = (run: Run) => (
      <Text color={run.color} dimColor={run.dim} bold={run.bold}>
        {run.text}
      </Text>
    )

    const rows = visible.map(deploy => {
      const elapsed = formatElapsed(elapsedOf(deploy, now))
      const label = deployLabel(deploy)
      const full = pipeline(deploy, false)
      const compact = pipeline(deploy, true)
      const fullLen = runsText(full).length
      const word = stageWord(deploy)
      let runs: Run[]
      if (width >= fullLen + elapsed.length + 14) runs = full
      else if (width >= runsText(compact).length + word.length + elapsed.length + 12) {
        runs = [...compact, { text: ` ${word}`, color: stageColor(deploy.stage), bold: true }]
      } else runs = [{ text: `${stageGlyph(deploy.stage)} ${word}`, color: stageColor(deploy.stage), bold: true }]
      const used = runsText(runs).length + elapsed.length + 2
      const labelRoom = Math.max(0, width - used - 1)
      return (
        <Box key={`band:${deploy.key}`} flexDirection="row">
          <Text bold={isActive(deploy, now)} dimColor={!isActive(deploy, now)} wrap="truncate">
            {truncate(label, labelRoom).padEnd(labelRoom)}{' '}
          </Text>
          {runs.map(styled)}
          <Text dimColor>
            {'  '}
            {elapsed}
          </Text>
        </Box>
      )
    })
    if (hidden > 0) {
      rows.push(
        <Text key="band:more" dimColor>
          {truncate(`+${hidden} more · /${COMMAND}`, width)}
        </Text>,
      )
    }
    const mine = (
      <Box key="deploy-deck" flexDirection="column">
        {rows}
      </Box>
    )
    if (drawsNothing(below)) return mine
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })

  // --- The pane ---------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const targets = await read($, targetsAtom)
    const feeds = await read($, feedsAtom)
    const now = await read($, nowAtom)
    const interval = await read($, intervalAtom)
    const width = Math.max(20, e.props.bodyColumns)
    const isDesktop = e.surface === 'desktop'
    const inner = isDesktop ? width - 4 : width

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Deploys</Text>
        <Text dimColor>{truncate(`${interval === 0 ? 'stopped' : `every ${Math.round(interval / 1000)}s`}`, Math.max(0, width - 9))}</Text>
      </Box>
    )
    if (isUnconfigured(targets, cfg)) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text wrap="wrap">{targets.length === 0 ? 'No deploy targets found in this repo.' : 'No credentials for the detected targets.'}</Text>
          <Text wrap="wrap" dimColor>
            {setupText().replace(/`/g, '')}
          </Text>
        </Box>
      )
    }
    const groups = targets.map(target =>
      group({ key: `group:${targetKey(target)}`, target, feed: feeds[targetKey(target)], now, inner, isDesktop }),
    )
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {groups}
        <Text dimColor wrap="truncate">
          {truncate(`/${COMMAND} refresh · add · remove · status`, width)}
        </Text>
      </Box>
    )

    function group(props: { key: string; target: DeployDeckTarget; feed: DeployDeckFeed | undefined; now: number; inner: number; isDesktop: boolean }) {
      const { target, feed } = props
      const provider = PROVIDER_OF[target.kind]
      const kind = target.kind.startsWith('cloudflare-') ? ` (${target.kind.slice(11)})` : ''
      const auth = feed === undefined ? '' : authLabel(feed.auth, provider)
      const title = `${provider} · ${target.id}${kind}`
      const body = (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold wrap="truncate">
              {truncate(title, Math.max(4, props.inner - auth.length - 1))}
            </Text>
            <Text dimColor>{auth}</Text>
          </Box>
          {feed?.error !== undefined && (
            <Text color="warning" wrap="wrap">
              ⚠ {feed.error}
            </Text>
          )}
          {(feed === undefined || feed.deploys.length === 0) && feed?.error === undefined && (
            <Text dimColor>{feed?.checkedAt === undefined ? 'not read yet' : 'no deploys'}</Text>
          )}
          {(feed?.deploys ?? []).slice(0, 3).map(deploy => deployRow(deploy, props.now, props.inner))}
        </Box>
      )
      return props.isDesktop ? (
        <Box key={props.key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          {body}
        </Box>
      ) : (
        <Box key={props.key} flexDirection="column">
          {body}
        </Box>
      )
    }

    function deployRow(deploy: DeployDeckDeploy, at: number, room: number): RenderElement {
      const age = isTerminal(deploy.stage)
        ? formatAge(at - (deploy.finishedAt ?? deploy.startedAt))
        : formatElapsed(elapsedOf(deploy, at))
      const head = `${stageGlyph(deploy.stage)} ${stageWord(deploy)}`
      const facts = [deploy.env, versionLabel(deploy), deploy.branch, age].filter(
        (part): part is string => part !== undefined && part !== '',
      )
      const rest = truncate(`  ${facts.join(' · ')}`, Math.max(0, room - head.length))
      const links: RenderElement[] = []
      if (deploy.url !== undefined) links.push(<Link key={`url:${deploy.key}`} href={deploy.url} label="open" />)
      if (deploy.logsUrl !== undefined) links.push(<Link key={`logs:${deploy.key}`} href={deploy.logsUrl} label="logs" />)
      return (
        <Box key={`row:${deploy.key}`} flexDirection="column">
          <Text wrap="truncate">
            <Text color={stageColor(deploy.stage)} bold={!isTerminal(deploy.stage)}>
              {head}
            </Text>
            <Text dimColor={isTerminal(deploy.stage)}>{rest}</Text>
          </Text>
          {(deploy.message !== undefined || links.length > 0) && (
            <Text wrap="truncate">
              {'  '}
              {joinLinks(links)}
              {deploy.message !== undefined && (
                <Text dimColor>
                  {links.length > 0 ? '  ' : ''}
                  {truncate(deploy.message, Math.max(0, room - 4 - links.length * 7))}
                </Text>
              )}
            </Text>
          )}
        </Box>
      )
    }
  })

  // --- The inline card (mobile, or no pane placed) ---------------------------

  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND } }, async ($, e, next) => {
    if (e.props.isErrored || !e.props.text.startsWith(INLINE_HEAD)) return next(e)
    const { Box, Text, Link, Markdown } = $.ui.resolve(e)
    const targets = await read($, targetsAtom)
    const feeds = await read($, feedsAtom)
    const now = await read($, nowAtom)
    const width = Math.max(20, Math.min(e.viewport?.columns ?? 48, 80))
    if (isUnconfigured(targets, cfg)) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{targets.length === 0 ? 'Deploys · nothing to track yet' : 'Deploys · credentials needed'}</Text>
          <Markdown text={setupText()} />
        </Box>
      )
    }
    const groups = targets.map(target => {
      const feed = feeds[targetKey(target)]
      const provider = PROVIDER_OF[target.kind]
      return (
        <Box key={`inline:${targetKey(target)}`} flexDirection="column">
          <Text bold wrap="truncate">
            {truncate(`${provider} · ${target.id}`, width)}
          </Text>
          {feed?.error !== undefined && (
            <Text color="warning" wrap="wrap">
              ⚠ {feed.error}
            </Text>
          )}
          {(feed === undefined || feed.deploys.length === 0) && feed?.error === undefined && (
            <Text dimColor>{feed?.checkedAt === undefined ? 'not read yet' : 'no deploys'}</Text>
          )}
          {(feed?.deploys ?? []).slice(0, 3).map(deploy => {
            const age = isTerminal(deploy.stage)
              ? formatAge(now - (deploy.finishedAt ?? deploy.startedAt))
              : formatElapsed(elapsedOf(deploy, now))
            const facts = [deploy.env, versionLabel(deploy), deploy.branch, age].filter(
              (part): part is string => part !== undefined && part !== '',
            )
            return (
              <Box key={`inline-row:${deploy.key}`} flexDirection="column">
                <Text wrap="truncate">
                  <Text color={stageColor(deploy.stage)}>
                    {stageGlyph(deploy.stage)} {stageWord(deploy)}
                  </Text>
                  <Text dimColor>{truncate(` · ${facts.join(' · ')}`, Math.max(0, width - stageWord(deploy).length - 2))}</Text>
                </Text>
                {(deploy.url !== undefined || deploy.logsUrl !== undefined) && (
                  <Text>
                    {'  '}
                    {joinLinks([
                      ...(deploy.url !== undefined ? [<Link key={`url:${deploy.key}`} href={deploy.url} label="open" />] : []),
                      ...(deploy.logsUrl !== undefined ? [<Link key={`logs:${deploy.key}`} href={deploy.logsUrl} label="logs" />] : []),
                    ])}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
      )
    })
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold wrap="truncate">
          {truncate(`Deploys · ${targets.length} target${targets.length === 1 ? '' : 's'}`, width)}
        </Text>
        {groups}
      </Box>
    )
  })
}

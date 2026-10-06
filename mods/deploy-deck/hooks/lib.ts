// deploy-deck's pure helpers: target specs, the stage pipeline, formatting,
// what the band, status line and toasts say, transitions and backoff.

import type {
  DeployDeckAuth,
  DeployDeckDeploy,
  DeployDeckFeed,
  DeployDeckProvider,
  DeployDeckStage,
  DeployDeckStep,
  DeployDeckTarget,
  DeployDeckTargetKind,
} from '../types'

export const PROVIDER_OF: Record<DeployDeckTargetKind, DeployDeckProvider> = {
  github: 'github',
  vercel: 'vercel',
  'cloudflare-pages': 'cloudflare',
  'cloudflare-workers': 'cloudflare',
  render: 'render',
}

export const PROVIDERS: readonly DeployDeckProvider[] = ['github', 'vercel', 'cloudflare', 'render']

/** How long the band keeps a finished deploy. */
export const BAND_LINGER_MS = 60_000
/** How long the status line keeps a finished deploy. */
export const STATUS_LINGER_MS = 10 * 60_000
/** An in-flight deploy older than this is stale (a stuck provider record), not active. */
export const STALE_MS = 6 * 60 * 60_000
/** The inline card's first words, which tell its CommandOutput row apart. */
export const INLINE_HEAD = 'Deploys ·'

export function targetKey(target: Pick<DeployDeckTarget, 'kind' | 'id'>): string {
  return `${target.kind}:${target.id}`
}

export function deployKey(target: Pick<DeployDeckTarget, 'kind' | 'id'>, id: string): string {
  return `${target.kind}:${target.id}:${id}`
}

export function shortSha(sha: string | undefined): string | undefined {
  return sha === undefined ? undefined : sha.slice(0, 7)
}

/** A tag-looking ref (`v1.4.2`, `refs/tags/1.2`) as a version; branches and shas are not. */
export function versionFromRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined
  const bare = ref.replace(/^refs\/tags\//, '')
  return /^v?\d+(\.\d+)+([-+.][\w.-]+)?$/.test(bare) || ref.startsWith('refs/tags/') ? bare : undefined
}

/** What the version column shows: the tag or version, else the short sha. */
export function versionLabel(deploy: DeployDeckDeploy): string {
  return deploy.version ?? shortSha(deploy.commit) ?? '—'
}

// --- Target specs -------------------------------------------------------------

const KIND_ALIASES: Record<string, DeployDeckTargetKind> = {
  github: 'github',
  gh: 'github',
  vercel: 'vercel',
  cloudflare: 'cloudflare-pages',
  'cloudflare-pages': 'cloudflare-pages',
  pages: 'cloudflare-pages',
  'cf-pages': 'cloudflare-pages',
  'cloudflare-workers': 'cloudflare-workers',
  workers: 'cloudflare-workers',
  worker: 'cloudflare-workers',
  'cf-workers': 'cloudflare-workers',
  render: 'render',
}

/** `vercel:my-app` → a target; a string says what is wrong. */
export function parseTargetSpec(spec: string, source: DeployDeckTarget['source']): DeployDeckTarget | string {
  const text = spec.trim()
  const colon = text.indexOf(':')
  if (colon <= 0 || colon === text.length - 1) return `"${text}" is not provider:id (e.g. vercel:my-app)`
  const kind = KIND_ALIASES[text.slice(0, colon).toLowerCase()]
  const id = text.slice(colon + 1).trim()
  if (kind === undefined) return `unknown provider "${text.slice(0, colon)}" (github, vercel, cloudflare-pages, cloudflare-workers, render)`
  if (!/^[\w.\-/@]+$/.test(id)) return `"${id}" is not a valid id`
  if (kind === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(id)) return `github targets are owner/repo, not "${id}"`
  return { kind, id, source }
}

/** The settings' comma- or space-separated list. */
export function parseTargets(list: string, source: DeployDeckTarget['source']): { targets: DeployDeckTarget[]; errors: string[] } {
  const targets: DeployDeckTarget[] = []
  const errors: string[] = []
  for (const spec of list.split(/[,\s]+/).filter(part => part.length > 0)) {
    const parsed = parseTargetSpec(spec, source)
    if (typeof parsed === 'string') errors.push(parsed)
    else targets.push(parsed)
  }
  return { targets, errors }
}

/** Unites target lists, the first one listed winning, minus the removed keys. */
export function mergeTargets(lists: readonly (readonly DeployDeckTarget[])[], removed: readonly string[]): DeployDeckTarget[] {
  const seen = new Set<string>(removed)
  const out: DeployDeckTarget[] = []
  for (const list of lists) {
    for (const target of list) {
      const key = targetKey(target)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(target)
    }
  }
  return out
}

// --- Commands -----------------------------------------------------------------

export type DeckCommand =
  | { verb: 'open' | 'close' | 'refresh' | 'status' | 'help' }
  | { verb: 'add' | 'remove'; spec: string }

export function parseCommand(args: string): DeckCommand {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  const verb = first.toLowerCase()
  const spec = rest.join(' ').trim()
  if (verb === '' || verb === 'open' || verb === 'show') return { verb: 'open' }
  if (verb === 'close' || verb === 'hide') return { verb: 'close' }
  if (verb === 'refresh' || verb === 'poll') return { verb: 'refresh' }
  if (verb === 'status') return { verb: 'status' }
  if ((verb === 'add' || verb === 'remove' || verb === 'rm') && spec.length > 0) {
    return { verb: verb === 'add' ? 'add' : 'remove', spec }
  }
  return { verb: 'help' }
}

// --- Stages -------------------------------------------------------------------

export const STEPS: readonly DeployDeckStep[] = ['queued', 'building', 'deploying']

export function isTerminal(stage: DeployDeckStage): boolean {
  return stage === 'live' || stage === 'failed' || stage === 'canceled'
}

/** In flight and not stale. */
export function isActive(deploy: DeployDeckDeploy, now: number): boolean {
  return !isTerminal(deploy.stage) && now - deploy.startedAt < STALE_MS
}

/** `building`, `build failed`, `live`. */
export function stageWord(deploy: Pick<DeployDeckDeploy, 'stage' | 'failedAt'>): string {
  if (deploy.stage !== 'failed') return deploy.stage
  if (deploy.failedAt === 'building') return 'build failed'
  if (deploy.failedAt === 'deploying') return 'deploy failed'
  return 'failed'
}

export function stageGlyph(stage: DeployDeckStage): string {
  switch (stage) {
    case 'live':
      return '✓'
    case 'failed':
      return '✗'
    case 'canceled':
      return '⊘'
    case 'queued':
      return '◌'
    default:
      return '◉'
  }
}

export function stageColor(stage: DeployDeckStage): string {
  switch (stage) {
    case 'live':
      return 'success'
    case 'failed':
      return 'error'
    case 'canceled':
      return 'inactive'
    case 'queued':
      return 'warning'
    default:
      return 'claude'
  }
}

/** A styled piece of text. */
export type Run = { text: string; color?: string; dim?: boolean; bold?: boolean }

/**
 * The pipeline `● queued ━ ◉ building ━ ○ deploying ━ ○ live` as styled runs;
 * `compact` drops the labels (`●━◉━○━○`).
 */
export function pipeline(deploy: Pick<DeployDeckDeploy, 'stage' | 'failedAt'>, compact: boolean): Run[] {
  const names = [...STEPS, 'live'] as const
  const sep: Run = { text: compact ? '━' : ' ━ ', dim: true }
  const at =
    deploy.stage === 'failed'
      ? STEPS.indexOf(deploy.failedAt ?? 'building')
      : deploy.stage === 'canceled'
        ? -1
        : names.indexOf(deploy.stage as (typeof names)[number])
  const runs: Run[] = []
  names.forEach((name, index) => {
    if (index > 0) runs.push(sep)
    let glyph = '○'
    let color: string | undefined
    let dim = true
    let bold = false
    let label: string = name
    if (deploy.stage === 'canceled') {
      if (name === 'live') {
        glyph = '⊘'
        label = 'canceled'
        color = 'inactive'
        dim = false
      }
    } else if (index < at || (deploy.stage === 'live' && index <= at)) {
      glyph = name === 'live' ? '✓' : '●'
      color = 'success'
      dim = false
      bold = name === 'live'
    } else if (index === at) {
      if (deploy.stage === 'failed') {
        glyph = '✗'
        color = 'error'
      } else {
        glyph = '◉'
        color = 'claude'
      }
      dim = false
      bold = true
    }
    const run: Run = { text: compact ? glyph : `${glyph} ${label}` }
    if (color !== undefined) run.color = color
    if (dim) run.dim = true
    if (bold) run.bold = true
    runs.push(run)
  })
  return runs
}

export function runsText(runs: readonly Run[]): string {
  return runs.map(run => run.text).join('')
}

// --- Time ---------------------------------------------------------------------

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** How long a deploy ran (finished) or has been running. */
export function elapsedOf(deploy: DeployDeckDeploy, now: number): number {
  const end = isTerminal(deploy.stage) ? (deploy.finishedAt ?? now) : now
  return Math.max(0, end - deploy.startedAt)
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  return max === 1 ? '…' : `${text.slice(0, max - 1)}…`
}

// --- What the band, the status line and toasts say ------------------------------

export function allDeploys(feeds: Readonly<Record<string, DeployDeckFeed>>): DeployDeckDeploy[] {
  return Object.values(feeds).flatMap(feed => feed.deploys)
}

/** The band's deploys: everything in flight, plus what finished within the last minute. */
export function bandDeploys(
  feeds: Readonly<Record<string, DeployDeckFeed>>,
  finished: Readonly<Record<string, number>>,
  now: number,
): DeployDeckDeploy[] {
  const shown = allDeploys(feeds).filter(deploy => {
    if (isActive(deploy, now)) return true
    const at = finished[deploy.key]
    return isTerminal(deploy.stage) && at !== undefined && now - at < BAND_LINGER_MS
  })
  return shown.sort((a, b) => {
    const activeFirst = Number(isActive(b, now)) - Number(isActive(a, now))
    return activeFirst !== 0 ? activeFirst : b.startedAt - a.startedAt
  })
}

/** `vercel · my-app · production` */
export function deployLabel(deploy: DeployDeckDeploy): string {
  return [deploy.provider, deploy.project, deploy.env].filter((part): part is string => part !== undefined && part !== '').join(' · ')
}

function envShort(env: string | undefined): string | undefined {
  if (env === undefined) return undefined
  return env === 'production' ? 'prod' : env
}

function priority(deploy: DeployDeckDeploy): number {
  return deploy.env === 'production' || deploy.env === 'prod' ? 1 : 0
}

/** The status line: the most important current item, or undefined. */
export function statusText(
  feeds: Readonly<Record<string, DeployDeckFeed>>,
  finished: Readonly<Record<string, number>>,
  now: number,
): string | undefined {
  const all = allDeploys(feeds)
  const active = all
    .filter(deploy => isActive(deploy, now))
    .sort((a, b) => priority(b) - priority(a) || b.startedAt - a.startedAt)
  const top = active[0]
  if (top !== undefined) {
    const more = active.length > 1 ? ` +${active.length - 1}` : ''
    return `🚀 ${top.provider} ${stageWord(top)} ${formatElapsed(elapsedOf(top, now))}${more}`
  }
  const recent = all
    .filter(deploy => (deploy.stage === 'live' || deploy.stage === 'failed') && finished[deploy.key] !== undefined)
    .filter(deploy => now - (finished[deploy.key] ?? 0) < STATUS_LINGER_MS)
    .sort((a, b) => Number(b.stage === 'failed') - Number(a.stage === 'failed') || (finished[b.key] ?? 0) - (finished[a.key] ?? 0))
  const last = recent[0]
  if (last === undefined) return undefined
  if (last.stage === 'failed') return `✗ ${last.provider} ${stageWord(last)}`
  const env = envShort(last.env)
  return `✓ ${env ?? last.provider} live ${versionLabel(last)}`
}

/** `✓ vercel production live · abc1234` / `✗ render build failed · abc1234` */
export function toastText(deploy: DeployDeckDeploy): string {
  const glyph = deploy.stage === 'live' ? '✓' : '✗'
  const env = deploy.env !== undefined ? ` ${deploy.env}` : ''
  const version = versionLabel(deploy)
  return `${glyph} ${deploy.provider}${env} ${stageWord(deploy)}${version === '—' ? '' : ` · ${version}`}`
}

// --- Transitions --------------------------------------------------------------

/** Grace for a deploy that started and finished between two reads. */
const BETWEEN_READS_SLACK_MS = 60_000

/**
 * The deploys of a new read that finished since the previous one: those seen
 * in flight before, and (once the feed is primed) new ones that finished
 * after the previous read. The first read of a target announces nothing.
 */
export function finishedSince(previous: DeployDeckFeed | undefined, deploys: readonly DeployDeckDeploy[]): DeployDeckDeploy[] {
  if (previous === undefined || !previous.primed) return []
  const before = new Map(previous.deploys.map(deploy => [deploy.key, deploy]))
  const since = (previous.checkedAt ?? 0) - BETWEEN_READS_SLACK_MS
  return deploys.filter(deploy => {
    if (!isTerminal(deploy.stage)) return false
    const was = before.get(deploy.key)
    if (was !== undefined) return !isTerminal(was.stage)
    return (deploy.finishedAt ?? deploy.startedAt) >= since
  })
}

// --- Polling and backoff ------------------------------------------------------

export function pollInterval(isAnyActive: boolean, fastMs: number, slowMs: number): number {
  return isAnyActive ? fastMs : slowMs
}

const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 15 * 60_000
const AUTH_PAUSE_MS = 10 * 60_000

/** How long a provider rests after a failure of `kind`, its `failures`th in a row. */
export function backoffDelay(kind: string, failures: number, retryAfterMs: number | undefined): number {
  if (kind === 'auth' || kind === 'notfound' || kind === 'config') return Math.max(AUTH_PAUSE_MS, retryAfterMs ?? 0)
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))
  return Math.max(exp, retryAfterMs ?? 0)
}

// --- Help and reports ---------------------------------------------------------

export const SETUP_HELP: Record<DeployDeckProvider, string> = {
  github:
    'GitHub: `githubToken`, a fine-grained token (github.com/settings/personal-access-tokens) with read-only Actions, Deployments and Metadata on the repo. Or leave it empty and log in with `gh auth login`.',
  vercel:
    '`vercelToken` from vercel.com/account/tokens, scoped to the team that owns the project (Vercel has no read-only scope; deploy-deck only sends GETs). Set `vercelTeamId` unless `.vercel/project.json` names the team.',
  cloudflare:
    '`cloudflareToken`, an account API token (dash.cloudflare.com/profile/api-tokens) with Account › Cloudflare Pages: Read and Workers Scripts: Read, plus `cloudflareAccountId` (or `account_id` in wrangler.toml).',
  render:
    '`renderToken`, an API key from dashboard.render.com › Account settings › API keys (Render keys are account-wide; deploy-deck only sends GETs).',
}

export function setupText(): string {
  return [
    'Set tokens with `/plugin` › deploy-deck › configure (tokens are kept in secure storage), or in settings.json under `pluginConfigs["deploy-deck"].options`. Each needs read access only:',
    ...PROVIDERS.map(provider => `- ${SETUP_HELP[provider]}`),
    'Targets are detected from the repo (git remote, .vercel/project.json, wrangler.toml/jsonc, render.yaml) or added with `/deploys add vercel:my-app`.',
  ].join('\n')
}

export function authLabel(auth: DeployDeckAuth, provider: DeployDeckProvider): string {
  if (auth === 'token') return 'token'
  if (auth === 'cli') return provider === 'github' ? 'gh CLI' : 'CLI'
  return 'no credentials'
}

/** One target as `vercel:my-app`. */
export function targetLabel(target: DeployDeckTarget): string {
  return `${target.kind}:${target.id}`
}

/** One deploy as a markdown line for the inline card and the model. */
export function deployLine(deploy: DeployDeckDeploy, now: number): string {
  const parts = [
    `${stageGlyph(deploy.stage)} **${stageWord(deploy)}**`,
    deploy.env,
    `\`${versionLabel(deploy)}\``,
    deploy.branch,
    isTerminal(deploy.stage) ? formatAge(now - (deploy.finishedAt ?? deploy.startedAt)) : formatElapsed(elapsedOf(deploy, now)),
  ].filter((part): part is string => part !== undefined && part !== '')
  const links = [
    deploy.url !== undefined ? `[open](${deploy.url})` : undefined,
    deploy.logsUrl !== undefined ? `[logs](${deploy.logsUrl})` : undefined,
  ].filter((part): part is string => part !== undefined)
  return parts.join(' · ') + (links.length > 0 ? ` · ${links.join(' ')}` : '')
}

/** The deck as markdown: the inline card's text, and what the model reads. */
export function inlineText(targets: readonly DeployDeckTarget[], feeds: Readonly<Record<string, DeployDeckFeed>>, now: number): string {
  if (targets.length === 0) return `${INLINE_HEAD} nothing to track yet\n\n${setupText()}`
  const lines: string[] = [`${INLINE_HEAD} ${targets.length} target${targets.length === 1 ? '' : 's'}`]
  for (const target of targets) {
    const feed = feeds[targetKey(target)]
    lines.push('', `**${PROVIDER_OF[target.kind]} · ${target.id}**${target.kind.startsWith('cloudflare') ? ` (${target.kind.slice(11)})` : ''}`)
    if (feed?.error !== undefined) lines.push(`- ⚠ ${feed.error}`)
    if (feed === undefined || (feed.deploys.length === 0 && feed.error === undefined)) {
      lines.push(feed?.checkedAt === undefined ? '- not read yet' : '- no deploys')
      continue
    }
    for (const deploy of feed.deploys.slice(0, 3)) lines.push(`- ${deployLine(deploy, now)}`)
  }
  return lines.join('\n')
}

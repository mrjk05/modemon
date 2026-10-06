// Cloudflare: Pages deployments (with their stages) and Workers deployments
// (with the versions they serve).
//
// REST (Authorization: Bearer <API token>):
//   GET /client/v4/accounts/{acct}/pages/projects/{name}/deployments
//     result[]: id, short_id, url, environment, created_on, latest_stage
//     { name: queued|initialize|clone_repo|build|deploy,
//       status: idle|active|success|failure|canceled|skipped, started_on, ended_on },
//     deployment_trigger.metadata { branch, commit_hash, commit_message }
//   GET /client/v4/accounts/{acct}/workers/scripts/{name}/deployments
//     result.deployments[]: id, created_on, source, strategy, author_email,
//     annotations { workers/message, workers/triggered_by },
//     versions[] { version_id, percentage }
//   GET /client/v4/accounts/{acct}/workers/scripts/{name}/versions
//     result.items[]: id, number, metadata { created_on, source },
//     annotations { workers/tag, workers/message }
// No CLI fallback: wrangler prints no stable JSON for these, so a token is needed.

import type { DeployDeckDeploy, DeployDeckStage, DeployDeckStep, DeployDeckTarget } from '../../types'
import { deployKey } from '../lib'
import type { Client, Json } from '../net'
import { arr, getJson, num, obj, str, time } from '../net'

const API = 'https://api.cloudflare.com/client/v4'
const DASH = 'https://dash.cloudflare.com'

/** The step a Pages stage name belongs to. */
function stepOf(name: string | undefined): DeployDeckStep {
  if (name === 'deploy') return 'deploying'
  if (name === 'queued' || name === undefined) return 'queued'
  return 'building' // initialize, clone_repo, build
}

/** A Pages `latest_stage` on the one pipeline. */
export function pagesStage(name: string | undefined, status: string | undefined): { stage: DeployDeckStage; failedAt?: DeployDeckStep; note?: string } {
  const step = stepOf(name)
  switch (status) {
    case 'failure':
      return { stage: 'failed', failedAt: step }
    case 'canceled':
      return { stage: 'canceled' }
    case 'skipped':
      return { stage: 'canceled', note: 'skipped' }
    case 'success':
      // The stage finished; until the next one reports, the deploy stands at the next step.
      if (name === 'deploy') return { stage: 'live' }
      if (name === 'build') return { stage: 'deploying' }
      if (name === 'queued') return { stage: 'building' }
      return { stage: 'building' }
    default:
      // idle, active
      return { stage: step }
  }
}

export function normalizePages(item: unknown, target: DeployDeckTarget, accountId: string): DeployDeckDeploy | undefined {
  const d = obj(item)
  const id = str(d, 'id')
  if (d === undefined || id === undefined) return undefined
  const latest = obj(d['latest_stage'])
  const { stage, failedAt, note } = pagesStage(str(latest, 'name'), str(latest, 'status'))
  const meta = obj(obj(d['deployment_trigger'])?.['metadata'])
  const deploy: DeployDeckDeploy = {
    key: deployKey(target, id),
    provider: 'cloudflare',
    kind: 'cloudflare-pages',
    id,
    project: str(d, 'project_name') ?? target.id,
    env: str(d, 'environment') ?? 'preview',
    stage,
    startedAt: time(d['created_on']) ?? 0,
  }
  const sha = str(meta, 'commit_hash')
  if (sha !== undefined) deploy.commit = sha
  const branch = str(meta, 'branch')
  if (branch !== undefined) deploy.branch = branch
  const message = str(meta, 'commit_message')
  if (message !== undefined) deploy.message = message.split('\n')[0] ?? message
  if (failedAt !== undefined) deploy.failedAt = failedAt
  if (note !== undefined) deploy.note = note
  if (stage === 'live' || stage === 'failed' || stage === 'canceled') {
    const done = time(latest?.['ended_on']) ?? time(d['modified_on'])
    if (done !== undefined) deploy.finishedAt = done
  }
  const url = str(d, 'url')
  if (url !== undefined) deploy.url = url
  if (accountId !== '') deploy.logsUrl = `${DASH}/${accountId}/pages/view/${target.id}/${id}`
  return deploy
}

/** `GET …/pages/projects/{name}/deployments` → Deploys, newest first. */
export function parsePages(body: unknown, target: DeployDeckTarget, accountId: string): DeployDeckDeploy[] {
  return arr(obj(body)?.['result'])
    .map(item => normalizePages(item, target, accountId))
    .filter((d): d is DeployDeckDeploy => d !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt)
}

type VersionInfo = { number?: number; tag?: string; message?: string }

/** `GET …/workers/scripts/{name}/versions` → version id → number and tag. */
export function parseWorkerVersions(body: unknown): Record<string, VersionInfo> {
  const result = obj(body)?.['result']
  const items = Array.isArray(result) ? result : arr(obj(result)?.['items'])
  const out: Record<string, VersionInfo> = {}
  for (const item of items) {
    const v = obj(item)
    const id = str(v, 'id')
    if (v === undefined || id === undefined) continue
    const annotations = obj(v['annotations']) ?? obj(obj(v['metadata'])?.['annotations'])
    const info: VersionInfo = {}
    const n = num(v, 'number')
    if (n !== undefined) info.number = n
    const tag = str(annotations, 'workers/tag')
    if (tag !== undefined) info.tag = tag
    const message = str(annotations, 'workers/message')
    if (message !== undefined) info.message = message
    out[id] = info
  }
  return out
}

/** One Workers deployment: atomic, so it is live from the moment it exists. */
export function normalizeWorker(
  item: unknown,
  target: DeployDeckTarget,
  accountId: string,
  versions: Record<string, VersionInfo>,
  isCurrent: boolean,
): DeployDeckDeploy | undefined {
  const d = obj(item)
  const id = str(d, 'id')
  if (d === undefined || id === undefined) return undefined
  const served = arr(d['versions']).map(obj).filter((v): v is Json => v !== undefined)
  const main = [...served].sort((a, b) => (num(b, 'percentage') ?? 0) - (num(a, 'percentage') ?? 0))[0]
  const versionId = str(main, 'version_id')
  const info = versionId === undefined ? undefined : versions[versionId]
  const created = time(d['created_on']) ?? 0
  const annotations = obj(d['annotations'])
  const deploy: DeployDeckDeploy = {
    key: deployKey(target, id),
    provider: 'cloudflare',
    kind: 'cloudflare-workers',
    id,
    project: target.id,
    env: 'production',
    stage: 'live',
    startedAt: created,
    finishedAt: created,
  }
  const version = info?.tag ?? (info?.number !== undefined ? `#${info.number}` : versionId?.slice(0, 8))
  if (version !== undefined) deploy.version = version
  const message = str(annotations, 'workers/message') ?? info?.message
  if (message !== undefined) deploy.message = message
  const notes: string[] = []
  if (served.length > 1) notes.push(served.map(v => `${num(v, 'percentage') ?? 0}%`).join('/') + ' split')
  if (!isCurrent) notes.push('superseded')
  if (notes.length > 0) deploy.note = notes.join(', ')
  if (accountId !== '') deploy.logsUrl = `${DASH}/${accountId}/workers/services/view/${target.id}/production/deployments`
  return deploy
}

/** `GET …/workers/scripts/{name}/deployments` (+ versions) → Deploys, newest first. */
export function parseWorkers(body: unknown, target: DeployDeckTarget, accountId: string, versions: Record<string, VersionInfo>): DeployDeckDeploy[] {
  const result = obj(obj(body)?.['result'])
  const list = arr(result?.['deployments'])
  const sorted = [...list].sort((a, b) => (time(obj(b)?.['created_on']) ?? 0) - (time(obj(a)?.['created_on']) ?? 0))
  return sorted
    .map((item, index) => normalizeWorker(item, target, accountId, versions, index === 0))
    .filter((d): d is DeployDeckDeploy => d !== undefined)
}

export async function listCloudflare(client: Client, target: DeployDeckTarget, accountId: string): Promise<DeployDeckDeploy[]> {
  const acct = encodeURIComponent(accountId)
  const name = encodeURIComponent(target.id)
  if (target.kind === 'cloudflare-pages') {
    return parsePages(await getJson(client, `${API}/accounts/${acct}/pages/projects/${name}/deployments?per_page=10`), target, accountId)
  }
  const deployments = await getJson(client, `${API}/accounts/${acct}/workers/scripts/${name}/deployments`)
  const versions = parseWorkerVersions(await getJson(client, `${API}/accounts/${acct}/workers/scripts/${name}/versions?per_page=20`))
  return parseWorkers(deployments, target, accountId, versions).slice(0, 10)
}

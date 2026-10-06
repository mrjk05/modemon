// GitHub: Actions workflow runs and Deployments (with their latest status).
//
// REST: GET /repos/{owner}/{repo}/actions/runs?per_page=
//       GET /repos/{owner}/{repo}/deployments?per_page=
//       GET /repos/{owner}/{repo}/deployments/{id}/statuses?per_page=1
// Headers: Authorization: Bearer <token>, Accept: application/vnd.github+json,
// X-GitHub-Api-Version: 2022-11-28. Without a token: `gh api <path>`.

import type { DeployDeckDeploy, DeployDeckStage, DeployDeckStep, DeployDeckTarget } from '../../types'
import { deployKey, versionFromRef } from '../lib'
import type { Client } from '../net'
import { arr, cliJson, getJson, num, obj, str, time } from '../net'

const API = 'https://api.github.com'
const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
const RUNS = 8
const DEPLOYMENTS = 3

/** A workflow run's `status` / `conclusion` on the one pipeline. */
export function runStage(status: string | undefined, conclusion: string | undefined): { stage: DeployDeckStage; failedAt?: DeployDeckStep; note?: string } {
  if (status !== 'completed') {
    if (status === 'in_progress') return { stage: 'building' }
    // queued, requested, waiting, pending
    return status === 'waiting' ? { stage: 'queued', note: 'waiting for approval' } : { stage: 'queued' }
  }
  switch (conclusion) {
    case 'success':
    case 'neutral':
      return { stage: 'live' }
    case 'cancelled':
    case 'skipped':
    case 'stale':
      return { stage: 'canceled', note: conclusion === 'cancelled' ? undefined : conclusion }
    case 'action_required':
      return { stage: 'failed', failedAt: 'queued', note: 'action required' }
    case 'startup_failure':
      return { stage: 'failed', failedAt: 'queued', note: 'startup failure' }
    case 'timed_out':
      return { stage: 'failed', failedAt: 'building', note: 'timed out' }
    default:
      return { stage: 'failed', failedAt: 'building' }
  }
}

/** One `workflow_runs[]` entry as a Deploy. */
export function normalizeRun(run: unknown, target: DeployDeckTarget): DeployDeckDeploy | undefined {
  const r = obj(run)
  const id = num(r, 'id')
  if (r === undefined || id === undefined) return undefined
  const { stage, failedAt, note } = runStage(str(r, 'status'), str(r, 'conclusion') ?? undefined)
  const startedAt = time(r['run_started_at']) ?? time(r['created_at']) ?? 0
  const sha = str(r, 'head_sha')
  const commit = obj(r['head_commit'])
  const deploy: DeployDeckDeploy = {
    key: deployKey(target, `run-${id}`),
    provider: 'github',
    kind: 'github',
    id: String(id),
    project: target.id,
    env: str(r, 'name') ?? 'workflow',
    stage,
    startedAt,
  }
  if (sha !== undefined) deploy.commit = sha
  const branch = str(r, 'head_branch')
  if (branch !== undefined) deploy.branch = branch
  const message = str(commit, 'message')
  if (message !== undefined) deploy.message = message.split('\n')[0] ?? message
  if (failedAt !== undefined) deploy.failedAt = failedAt
  if (note !== undefined) deploy.note = note
  if (stage === 'live' || stage === 'failed' || stage === 'canceled') {
    const done = time(r['updated_at'])
    if (done !== undefined) deploy.finishedAt = done
  }
  const html = str(r, 'html_url')
  if (html !== undefined) deploy.logsUrl = html
  return deploy
}

/** `GET …/actions/runs` → Deploys, newest first. */
export function parseRuns(body: unknown, target: DeployDeckTarget): DeployDeckDeploy[] {
  return arr(obj(body)?.['workflow_runs'])
    .map(run => normalizeRun(run, target))
    .filter((d): d is DeployDeckDeploy => d !== undefined)
}

/** A deployment status `state` on the one pipeline. */
export function deploymentStage(state: string | undefined): { stage: DeployDeckStage; failedAt?: DeployDeckStep; note?: string } {
  switch (state) {
    case 'success':
      return { stage: 'live' }
    case 'inactive':
      return { stage: 'live', note: 'superseded' }
    case 'in_progress':
      return { stage: 'deploying' }
    case 'failure':
    case 'error':
      return { stage: 'failed', failedAt: 'deploying' }
    default:
      // queued, pending, or no status yet
      return { stage: 'queued' }
  }
}

/** One deployment plus its latest status (statuses come newest first). */
export function normalizeDeployment(deployment: unknown, statuses: unknown, target: DeployDeckTarget): DeployDeckDeploy | undefined {
  const d = obj(deployment)
  const id = num(d, 'id')
  if (d === undefined || id === undefined) return undefined
  const latest = obj(arr(statuses)[0])
  const { stage, failedAt, note } = deploymentStage(str(latest, 'state'))
  const ref = str(d, 'ref')
  const sha = str(d, 'sha')
  const deploy: DeployDeckDeploy = {
    key: deployKey(target, `deployment-${id}`),
    provider: 'github',
    kind: 'github',
    id: String(id),
    project: target.id,
    env: str(d, 'environment') ?? 'deployment',
    stage,
    startedAt: time(d['created_at']) ?? 0,
  }
  if (sha !== undefined) deploy.commit = sha
  const version = versionFromRef(ref)
  if (version !== undefined) deploy.version = version
  else if (ref !== undefined && !/^[0-9a-f]{40}$/.test(ref)) deploy.branch = ref
  const description = str(d, 'description')
  if (description !== undefined) deploy.message = description
  if (failedAt !== undefined) deploy.failedAt = failedAt
  if (note !== undefined) deploy.note = note
  if (stage === 'live' || stage === 'failed' || stage === 'canceled') {
    const done = time(latest?.['created_at'])
    if (done !== undefined) deploy.finishedAt = done
  }
  const url = str(latest, 'environment_url')
  if (url !== undefined) deploy.url = url
  const logs = str(latest, 'log_url') ?? str(latest, 'target_url')
  if (logs !== undefined) deploy.logsUrl = logs
  return deploy
}

async function get(client: Client, path: string): Promise<unknown> {
  if (client.token !== undefined) return getJson(client, `${API}${path}`, HEADERS)
  return cliJson(client, ['gh', 'api', '-H', `Accept: ${HEADERS.Accept}`, '-H', `X-GitHub-Api-Version: ${HEADERS['X-GitHub-Api-Version']}`, path])
}

/** Reads a repo's latest workflow runs and deployments, merged newest first. */
export async function listGithub(client: Client, target: DeployDeckTarget): Promise<DeployDeckDeploy[]> {
  const repo = target.id
  const runs = parseRuns(await get(client, `/repos/${repo}/actions/runs?per_page=${RUNS}`), target)
  const deployments = arr(await get(client, `/repos/${repo}/deployments?per_page=${DEPLOYMENTS}`)).slice(0, DEPLOYMENTS)
  const read: DeployDeckDeploy[] = []
  for (const one of deployments) {
    const id = num(obj(one), 'id')
    if (id === undefined) continue
    const statuses = await get(client, `/repos/${repo}/deployments/${id}/statuses?per_page=1`)
    const deploy = normalizeDeployment(one, statuses, target)
    if (deploy !== undefined) read.push(deploy)
  }
  return [...runs, ...read].sort((a, b) => b.startedAt - a.startedAt)
}

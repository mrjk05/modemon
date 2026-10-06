// Vercel: a project's deployments, preview and production.
//
// REST: GET https://api.vercel.com/v7/deployments?projectId=&limit=&teamId=
// (v6 answers the same shape). Header: Authorization: Bearer <token>.
// States (readyState / state): QUEUED, INITIALIZING, BUILDING, READY, ERROR,
// CANCELED, BLOCKED, DELETED. meta.githubCommitSha / Ref / Message.
// No CLI fallback: `vercel ls` prints no JSON, so Vercel needs a token.

import type { DeployDeckDeploy, DeployDeckStage, DeployDeckStep, DeployDeckTarget } from '../../types'
import { deployKey } from '../lib'
import type { Client } from '../net'
import { arr, getJson, obj, str, time } from '../net'

const API = 'https://api.vercel.com'
const LIMIT = 10

export function vercelStage(state: string | undefined): { stage: DeployDeckStage; failedAt?: DeployDeckStep; note?: string } {
  switch (state) {
    case 'QUEUED':
      return { stage: 'queued' }
    case 'INITIALIZING':
    case 'BUILDING':
      return { stage: 'building' }
    case 'READY':
      return { stage: 'live' }
    case 'ERROR':
      return { stage: 'failed', failedAt: 'building' }
    case 'BLOCKED':
      return { stage: 'failed', failedAt: 'queued', note: 'blocked' }
    case 'CANCELED':
      return { stage: 'canceled' }
    case 'DELETED':
      return { stage: 'canceled', note: 'deleted' }
    default:
      return { stage: 'queued' }
  }
}

export function normalizeVercel(item: unknown, target: DeployDeckTarget): DeployDeckDeploy | undefined {
  const d = obj(item)
  const uid = str(d, 'uid') ?? str(d, 'id')
  if (d === undefined || uid === undefined) return undefined
  const { stage, failedAt, note } = vercelStage(str(d, 'readyState') ?? str(d, 'state'))
  const meta = obj(d['meta'])
  const deploy: DeployDeckDeploy = {
    key: deployKey(target, uid),
    provider: 'vercel',
    kind: 'vercel',
    id: uid,
    project: str(d, 'name') ?? target.id,
    env: str(d, 'target') ?? 'preview',
    stage,
    startedAt: time(d['buildingAt']) ?? time(d['createdAt']) ?? time(d['created']) ?? 0,
  }
  const sha = str(meta, 'githubCommitSha') ?? str(meta, 'gitlabCommitSha') ?? str(meta, 'bitbucketCommitSha')
  if (sha !== undefined) deploy.commit = sha
  const branch = str(meta, 'githubCommitRef') ?? str(meta, 'gitlabCommitRef') ?? str(meta, 'bitbucketCommitRef')
  if (branch !== undefined) deploy.branch = branch
  const message = str(meta, 'githubCommitMessage') ?? str(meta, 'gitlabCommitMessage') ?? str(meta, 'bitbucketCommitMessage')
  if (message !== undefined) deploy.message = message.split('\n')[0] ?? message
  if (failedAt !== undefined) deploy.failedAt = failedAt
  const error = str(d, 'errorCode')
  if (note !== undefined || error !== undefined) deploy.note = note ?? error
  if (stage === 'live' || stage === 'failed' || stage === 'canceled') {
    const done = time(d['ready'])
    if (done !== undefined) deploy.finishedAt = done
  }
  const url = str(d, 'url')
  if (url !== undefined) deploy.url = url.startsWith('http') ? url : `https://${url}`
  const logs = str(d, 'inspectorUrl')
  if (logs !== undefined) deploy.logsUrl = logs
  return deploy
}

/** `GET /v7/deployments` → Deploys, newest first. */
export function parseVercel(body: unknown, target: DeployDeckTarget): DeployDeckDeploy[] {
  return arr(obj(body)?.['deployments'])
    .map(item => normalizeVercel(item, target))
    .filter((d): d is DeployDeckDeploy => d !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** The request URL for a project (id or name) and optional team. */
export function vercelUrl(projectId: string, teamId: string | undefined): string {
  const team = teamId !== undefined && teamId !== '' ? `&teamId=${encodeURIComponent(teamId)}` : ''
  return `${API}/v7/deployments?projectId=${encodeURIComponent(projectId)}&limit=${LIMIT}${team}`
}

export async function listVercel(client: Client, target: DeployDeckTarget, teamId: string | undefined): Promise<DeployDeckDeploy[]> {
  return parseVercel(await getJson(client, vercelUrl(target.id, teamId)), target)
}

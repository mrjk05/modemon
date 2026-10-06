// Render: a service's deploys.
//
// REST (Authorization: Bearer <API key>):
//   GET https://api.render.com/v1/services/{id}/deploys?limit=
//     [{ deploy: { id, status, commit { id, message }, trigger, createdAt,
//        startedAt, finishedAt }, cursor }]
//   GET https://api.render.com/v1/services?name=&limit=   (name → id)
//     [{ service: { id, name, type, branch, dashboardUrl, serviceDetails { url } }, cursor }]
//   GET https://api.render.com/v1/services/{id}            (one service)
// Statuses: created, queued, build_in_progress, update_in_progress, live,
// deactivated, build_failed, update_failed, canceled, pre_deploy_in_progress,
// pre_deploy_failed. No CLI fallback: Render needs an API key.

import type { DeployDeckDeploy, DeployDeckStage, DeployDeckStep, DeployDeckTarget } from '../../types'
import { deployKey } from '../lib'
import type { Client } from '../net'
import { ProviderError, arr, getJson, obj, str, time } from '../net'

const API = 'https://api.render.com/v1'
const LIMIT = 10

export function renderStage(status: string | undefined): { stage: DeployDeckStage; failedAt?: DeployDeckStep; note?: string } {
  switch (status) {
    case 'build_in_progress':
      return { stage: 'building' }
    case 'pre_deploy_in_progress':
    case 'update_in_progress':
      return { stage: 'deploying' }
    case 'live':
      return { stage: 'live' }
    case 'deactivated':
      return { stage: 'live', note: 'superseded' }
    case 'build_failed':
      return { stage: 'failed', failedAt: 'building' }
    case 'pre_deploy_failed':
      return { stage: 'failed', failedAt: 'deploying', note: 'pre-deploy failed' }
    case 'update_failed':
      return { stage: 'failed', failedAt: 'deploying' }
    case 'canceled':
      return { stage: 'canceled' }
    default:
      // created, queued
      return { stage: 'queued' }
  }
}

/** Facts about the service a deploy row carries. */
export type RenderService = { id: string; name?: string; branch?: string; dashboardUrl?: string; url?: string }

export function normalizeRender(item: unknown, target: DeployDeckTarget, service: RenderService): DeployDeckDeploy | undefined {
  const wrapped = obj(item)
  const d = obj(wrapped?.['deploy']) ?? wrapped
  const id = str(d, 'id')
  if (d === undefined || id === undefined) return undefined
  const { stage, failedAt, note } = renderStage(str(d, 'status'))
  const commit = obj(d['commit'])
  const image = obj(d['image'])
  const deploy: DeployDeckDeploy = {
    key: deployKey(target, id),
    provider: 'render',
    kind: 'render',
    id,
    project: service.name ?? target.id,
    stage,
    startedAt: time(d['startedAt']) ?? time(d['createdAt']) ?? 0,
  }
  const sha = str(commit, 'id') ?? str(image, 'sha')
  if (sha !== undefined) deploy.commit = sha
  if (service.branch !== undefined) deploy.branch = service.branch
  const message = str(commit, 'message')
  if (message !== undefined) deploy.message = message.split('\n')[0] ?? message
  if (failedAt !== undefined) deploy.failedAt = failedAt
  if (note !== undefined) deploy.note = note
  if (stage === 'live' || stage === 'failed' || stage === 'canceled') {
    const done = time(d['finishedAt']) ?? time(d['updatedAt'])
    if (done !== undefined) deploy.finishedAt = done
  }
  if (service.url !== undefined) deploy.url = service.url
  if (service.dashboardUrl !== undefined) deploy.logsUrl = `${service.dashboardUrl}/deploys/${id}`
  return deploy
}

/** `GET /v1/services/{id}/deploys` → Deploys, newest first. */
export function parseRender(body: unknown, target: DeployDeckTarget, service: RenderService): DeployDeckDeploy[] {
  return arr(body)
    .map(item => normalizeRender(item, target, service))
    .filter((d): d is DeployDeckDeploy => d !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** One service object (bare, or wrapped as `{ service }`). */
export function parseRenderService(body: unknown): RenderService | undefined {
  const wrapped = obj(body)
  const s = obj(wrapped?.['service']) ?? wrapped
  const id = str(s, 'id')
  if (s === undefined || id === undefined) return undefined
  const service: RenderService = { id }
  const name = str(s, 'name')
  if (name !== undefined) service.name = name
  const branch = str(s, 'branch')
  if (branch !== undefined) service.branch = branch
  const dashboardUrl = str(s, 'dashboardUrl')
  if (dashboardUrl !== undefined) service.dashboardUrl = dashboardUrl
  const url = str(obj(s['serviceDetails']), 'url')
  if (url !== undefined) service.url = url
  return service
}

/** `GET /v1/services?name=` → the service of exactly that name. */
export function pickRenderService(body: unknown, name: string): RenderService | undefined {
  return arr(body)
    .map(parseRenderService)
    .find((s): s is RenderService => s !== undefined && s.name === name)
}

/** A target's service: by id (`srv-…`) or looked up by name; meta caches what was learned. */
export async function resolveRender(client: Client, target: DeployDeckTarget): Promise<RenderService> {
  const meta = target.meta ?? {}
  const known = meta['serviceId']
  if (known !== undefined) {
    const service: RenderService = { id: known }
    if (meta['name'] !== undefined) service.name = meta['name']
    if (meta['branch'] !== undefined) service.branch = meta['branch']
    if (meta['dashboardUrl'] !== undefined) service.dashboardUrl = meta['dashboardUrl']
    if (meta['url'] !== undefined) service.url = meta['url']
    return service
  }
  if (/^srv-[a-z0-9]+$/i.test(target.id)) {
    return parseRenderService(await getJson(client, `${API}/services/${encodeURIComponent(target.id)}`)) ?? { id: target.id }
  }
  const found = pickRenderService(await getJson(client, `${API}/services?name=${encodeURIComponent(target.id)}&limit=20`), target.id)
  if (found === undefined) throw new ProviderError('render', 'notfound', `render: no service named "${target.id}" for this API key`)
  return found
}

/** Meta to cache on the target once its service is known. */
export function renderMeta(service: RenderService): Record<string, string> {
  const meta: Record<string, string> = { serviceId: service.id }
  if (service.name !== undefined) meta['name'] = service.name
  if (service.branch !== undefined) meta['branch'] = service.branch
  if (service.dashboardUrl !== undefined) meta['dashboardUrl'] = service.dashboardUrl
  if (service.url !== undefined) meta['url'] = service.url
  return meta
}

export async function listRender(client: Client, target: DeployDeckTarget): Promise<{ deploys: DeployDeckDeploy[]; meta: Record<string, string> }> {
  const service = await resolveRender(client, target)
  const body = await getJson(client, `${API}/services/${encodeURIComponent(service.id)}/deploys?limit=${LIMIT}`)
  return { deploys: parseRender(body, target, service), meta: renderMeta(service) }
}

import { describe, expect, test } from 'claude-code/testing'

import type { DeployDeckTarget } from '../types'
import type { Client } from '../hooks/net'
import { listCloudflare, pagesStage, parsePages, parseWorkerVersions, parseWorkers } from '../hooks/providers/cloudflare'
import { deploymentStage, listGithub, normalizeDeployment, parseRuns, runStage } from '../hooks/providers/github'
import { listRender, parseRender, parseRenderService, pickRenderService, renderStage } from '../hooks/providers/render'
import { parseVercel, vercelStage, vercelUrl } from '../hooks/providers/vercel'
import * as CF from './fixtures/cloudflare'
import * as GH from './fixtures/github'
import * as RN from './fixtures/render'
import * as VC from './fixtures/vercel'

const T10 = Date.parse('2026-10-06T10:00:00Z')

function fakeClient(provider: Client['provider'], answers: Record<string, unknown>, calls: string[] = []): Client {
  return {
    provider,
    token: 'tok_secret_value_123456',
    secrets: ['tok_secret_value_123456'],
    now: T10,
    fetch: async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const hit = Object.entries(answers).find(([prefix]) => url.startsWith(prefix))
      if (hit === undefined) return { status: 404, ok: false, headers: {}, text: '{"message":"Not Found"}' }
      return { status: 200, ok: true, headers: {}, text: JSON.stringify(hit[1]) }
    },
  }
}

describe('github', () => {
  const target: DeployDeckTarget = { kind: 'github', id: 'acme/shop', source: 'detected' }

  test('workflow runs normalise onto the pipeline', () => {
    const deploys = parseRuns(GH.RUNS, target)
    expect(deploys).toHaveLength(4)
    const [running, failed, live, queued] = deploys
    expect(running).toMatchObject({
      provider: 'github',
      env: 'Deploy',
      stage: 'building',
      branch: 'main',
      commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      message: 'Fix checkout rounding',
      startedAt: Date.parse('2026-10-06T10:00:05Z'),
      logsUrl: 'https://github.com/acme/shop/actions/runs/11223344556',
    })
    expect(running?.finishedAt).toBeUndefined()
    expect(failed).toMatchObject({ stage: 'failed', failedAt: 'building', branch: 'feature/cart', finishedAt: Date.parse('2026-10-06T09:46:30Z') })
    expect(live).toMatchObject({ stage: 'live', env: 'Deploy' })
    expect(queued).toMatchObject({ stage: 'queued', env: 'Nightly', startedAt: Date.parse('2026-10-06T10:01:00Z') })
    expect(new Set(deploys.map(d => d.key)).size).toBe(4)
  })

  test('run status and conclusion map', () => {
    expect(runStage('waiting', undefined)).toEqual({ stage: 'queued', note: 'waiting for approval' })
    expect(runStage('completed', 'cancelled').stage).toBe('canceled')
    expect(runStage('completed', 'timed_out')).toEqual({ stage: 'failed', failedAt: 'building', note: 'timed out' })
    expect(runStage('completed', 'startup_failure').failedAt).toBe('queued')
  })

  test('deployments take their latest status; a tag ref is the version', () => {
    const prod = normalizeDeployment(GH.DEPLOYMENTS[0], GH.STATUSES_SUCCESS, target)
    expect(prod).toMatchObject({
      env: 'production',
      version: 'v1.4.2',
      stage: 'live',
      url: 'https://shop.acme.dev',
      logsUrl: 'https://github.com/acme/shop/actions/runs/11223343999/job/3100',
      finishedAt: Date.parse('2026-10-06T08:03:00Z'),
    })
    expect(prod?.branch).toBeUndefined()
    const staging = normalizeDeployment(GH.DEPLOYMENTS[1], GH.STATUSES_IN_PROGRESS, target)
    expect(staging).toMatchObject({ env: 'staging', branch: 'main', stage: 'deploying' })
    expect(staging?.url).toBeUndefined()
    expect(normalizeDeployment(GH.DEPLOYMENTS[1], [], target)?.stage).toBe('queued')
    expect(deploymentStage('inactive')).toEqual({ stage: 'live', note: 'superseded' })
    expect(deploymentStage('error')).toEqual({ stage: 'failed', failedAt: 'deploying' })
  })

  test('list merges runs and deployments over GET with the GitHub headers', async () => {
    const calls: string[] = []
    const headers: Record<string, string>[] = []
    const client = fakeClient(
      'github',
      {
        'https://api.github.com/repos/acme/shop/actions/runs': GH.RUNS,
        'https://api.github.com/repos/acme/shop/deployments/1890001/statuses': GH.STATUSES_SUCCESS,
        'https://api.github.com/repos/acme/shop/deployments/1890002/statuses': GH.STATUSES_IN_PROGRESS,
        'https://api.github.com/repos/acme/shop/deployments': GH.DEPLOYMENTS,
      },
      calls,
    )
    const fetch = client.fetch
    client.fetch = async (url, init) => {
      headers.push(init?.headers ?? {})
      return fetch(url, init)
    }
    const deploys = await listGithub(client, target)
    expect(deploys).toHaveLength(6)
    expect(deploys.map(d => d.startedAt)).toEqual([...deploys.map(d => d.startedAt)].sort((a, b) => b - a))
    expect(calls.every(call => call.startsWith('GET '))).toBe(true)
    expect(calls[0]).toBe('GET https://api.github.com/repos/acme/shop/actions/runs?per_page=8')
    expect(headers[0]?.['Accept']).toBe('application/vnd.github+json')
    expect(headers[0]?.['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(headers[0]?.['Authorization']).toBe('Bearer tok_secret_value_123456')
    expect(headers[0]?.['User-Agent']).toContain('deploy-deck')
  })

  test('without a token it reads through `gh api`', async () => {
    const argvs: (readonly string[])[] = []
    const client: Client = {
      provider: 'github',
      secrets: [],
      now: T10,
      fetch: async () => {
        throw new Error('no network in this test')
      },
      run: async argv => {
        argvs.push(argv)
        const path = argv[argv.length - 1] ?? ''
        const body = path.includes('/actions/runs') ? GH.RUNS : path.includes('/statuses') ? GH.STATUSES_SUCCESS : GH.DEPLOYMENTS
        return { exitCode: 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    }
    const deploys = await listGithub(client, target)
    expect(deploys.length).toBeGreaterThan(0)
    expect(argvs[0]?.slice(0, 2)).toEqual(['gh', 'api'])
    expect(argvs[0]?.at(-1)).toBe('/repos/acme/shop/actions/runs?per_page=8')
    expect(argvs.every(argv => !argv.includes('-X') && !argv.includes('--method'))).toBe(true)
  })
})

describe('vercel', () => {
  const target: DeployDeckTarget = { kind: 'vercel', id: 'prj_Qm8kd7Vf2LpXr0aNc3TyEw9H', source: 'detected' }

  test('deployments normalise with commit meta, url and inspector', () => {
    const deploys = parseVercel(VC.DEPLOYMENTS, target)
    expect(deploys).toHaveLength(4)
    expect(deploys[0]).toMatchObject({
      provider: 'vercel',
      project: 'shop-web',
      env: 'production',
      stage: 'building',
      commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      branch: 'main',
      message: 'Fix checkout rounding',
      startedAt: T10 + 3000,
      url: 'https://shop-web-9jaeg38me-acme.vercel.app',
      logsUrl: 'https://vercel.com/acme/shop-web/8rTqJx3kQhG2bVnM5yLzP1aW',
    })
    expect(deploys[1]).toMatchObject({ env: 'preview', stage: 'failed', failedAt: 'building', note: 'BUILD_FAILED', branch: 'feature/cart' })
    expect(deploys[2]).toMatchObject({ stage: 'live', finishedAt: 1791194460000 })
    expect(deploys[3]).toMatchObject({ stage: 'canceled' })
    expect(deploys[3]?.logsUrl).toBeUndefined()
  })

  test('states map, and the URL carries project and team', () => {
    expect(vercelStage('INITIALIZING').stage).toBe('building')
    expect(vercelStage('QUEUED').stage).toBe('queued')
    expect(vercelStage('BLOCKED')).toEqual({ stage: 'failed', failedAt: 'queued', note: 'blocked' })
    expect(vercelUrl('prj_1', 'team_2')).toBe('https://api.vercel.com/v7/deployments?projectId=prj_1&limit=10&teamId=team_2')
    expect(vercelUrl('my app', undefined)).toBe('https://api.vercel.com/v7/deployments?projectId=my%20app&limit=10')
  })
})

describe('cloudflare', () => {
  const pages: DeployDeckTarget = { kind: 'cloudflare-pages', id: 'docs-site', source: 'detected' }
  const worker: DeployDeckTarget = { kind: 'cloudflare-workers', id: 'edge-api', source: 'pinned' }
  const ACCT = '023e105f4ecef8ad9ca31a8372d0c353'

  test('pages deployments follow latest_stage', () => {
    const deploys = parsePages(CF.PAGES, pages, ACCT)
    expect(deploys).toHaveLength(3)
    expect(deploys[0]).toMatchObject({
      kind: 'cloudflare-pages',
      env: 'production',
      stage: 'building',
      branch: 'main',
      commit: 'ad9ccd918a81025731e10e40267e11273a263421',
      url: 'https://f64788e9.docs-site.pages.dev',
      logsUrl: `https://dash.cloudflare.com/${ACCT}/pages/view/docs-site/f64788e9-fccd-4d4a-a28a-cb84f88f6f20`,
    })
    expect(deploys[1]).toMatchObject({ env: 'preview', stage: 'failed', failedAt: 'building', finishedAt: Date.parse('2026-10-06T09:02:00Z') })
    expect(deploys[2]).toMatchObject({ stage: 'live' })
    expect(deploys[2]?.message).toBeUndefined()
  })

  test('pages stages map onto the pipeline', () => {
    expect(pagesStage('queued', 'active').stage).toBe('queued')
    expect(pagesStage('clone_repo', 'active').stage).toBe('building')
    expect(pagesStage('build', 'success').stage).toBe('deploying')
    expect(pagesStage('deploy', 'active').stage).toBe('deploying')
    expect(pagesStage('deploy', 'failure')).toEqual({ stage: 'failed', failedAt: 'deploying' })
    expect(pagesStage('deploy', 'success').stage).toBe('live')
    expect(pagesStage('build', 'canceled').stage).toBe('canceled')
  })

  test('workers deployments carry their version tag and traffic split', () => {
    const versions = parseWorkerVersions(CF.WORKER_VERSIONS)
    expect(versions['9b1d6c1e-0000-4000-8000-000000000001']).toEqual({ number: 41 })
    const deploys = parseWorkers(CF.WORKER_DEPLOYMENTS, worker, ACCT, versions)
    expect(deploys).toHaveLength(2)
    expect(deploys[0]).toMatchObject({
      kind: 'cloudflare-workers',
      stage: 'live',
      version: 'v2.0.0',
      message: 'Roll out v2 router',
      note: '90%/10% split',
      logsUrl: `https://dash.cloudflare.com/${ACCT}/workers/services/view/edge-api/production/deployments`,
    })
    expect(deploys[1]).toMatchObject({ version: '#41', note: 'superseded' })
  })

  test('list reads the right endpoints', async () => {
    const calls: string[] = []
    const client = fakeClient(
      'cloudflare',
      {
        [`https://api.cloudflare.com/client/v4/accounts/${ACCT}/pages/projects/docs-site/deployments`]: CF.PAGES,
        [`https://api.cloudflare.com/client/v4/accounts/${ACCT}/workers/scripts/edge-api/deployments`]: CF.WORKER_DEPLOYMENTS,
        [`https://api.cloudflare.com/client/v4/accounts/${ACCT}/workers/scripts/edge-api/versions`]: CF.WORKER_VERSIONS,
      },
      calls,
    )
    expect(await listCloudflare(client, pages, ACCT)).toHaveLength(3)
    expect((await listCloudflare(client, worker, ACCT))[0]?.version).toBe('v2.0.0')
    expect(calls).toHaveLength(3)
    expect(calls.every(call => call.startsWith('GET '))).toBe(true)
  })
})

describe('render', () => {
  const target: DeployDeckTarget = { kind: 'render', id: 'shop-api', source: 'detected' }

  test('deploys normalise, wrapped as { deploy, cursor }', () => {
    const service = parseRenderService(RN.SERVICES[0])
    expect(service).toEqual({
      id: 'srv-cq5n2lbv2p9c73a0kk0g',
      name: 'shop-api',
      branch: 'main',
      dashboardUrl: 'https://dashboard.render.com/web/srv-cq5n2lbv2p9c73a0kk0g',
      url: 'https://shop-api.onrender.com',
    })
    const deploys = parseRender(RN.DEPLOYS, target, service ?? { id: 'x' })
    expect(deploys).toHaveLength(3)
    expect(deploys[0]).toMatchObject({
      provider: 'render',
      project: 'shop-api',
      stage: 'building',
      branch: 'main',
      commit: '5f3e2d1c0b9a88776655443322110fedcba98765',
      url: 'https://shop-api.onrender.com',
      logsUrl: 'https://dashboard.render.com/web/srv-cq5n2lbv2p9c73a0kk0g/deploys/dep-cr1a2b3c4d5e6f7g8h9i',
    })
    expect(deploys[0]?.env).toBeUndefined()
    expect(deploys[1]).toMatchObject({ stage: 'failed', failedAt: 'deploying', message: 'Add healthcheck' })
    expect(deploys[2]).toMatchObject({ stage: 'live', note: 'superseded' })
  })

  test('statuses map onto the pipeline', () => {
    expect(renderStage('created').stage).toBe('queued')
    expect(renderStage('queued').stage).toBe('queued')
    expect(renderStage('pre_deploy_in_progress').stage).toBe('deploying')
    expect(renderStage('update_in_progress').stage).toBe('deploying')
    expect(renderStage('build_failed')).toEqual({ stage: 'failed', failedAt: 'building' })
    expect(renderStage('pre_deploy_failed').failedAt).toBe('deploying')
    expect(renderStage('canceled').stage).toBe('canceled')
  })

  test('a blueprint name resolves to its service id, exactly', async () => {
    expect(pickRenderService(RN.SERVICES, 'shop-api')?.id).toBe('srv-cq5n2lbv2p9c73a0kk0g')
    expect(pickRenderService(RN.SERVICES, 'shop')).toBeUndefined()
    const calls: string[] = []
    const client = fakeClient(
      'render',
      {
        'https://api.render.com/v1/services?name=shop-api': RN.SERVICES,
        'https://api.render.com/v1/services/srv-cq5n2lbv2p9c73a0kk0g/deploys': RN.DEPLOYS,
      },
      calls,
    )
    const { deploys, meta } = await listRender(client, target)
    expect(deploys).toHaveLength(3)
    expect(meta['serviceId']).toBe('srv-cq5n2lbv2p9c73a0kk0g')
    expect(calls[1]).toBe('GET https://api.render.com/v1/services/srv-cq5n2lbv2p9c73a0kk0g/deploys?limit=10')
    // With the id cached in meta, the next read skips the lookup.
    calls.length = 0
    await listRender(client, { ...target, meta })
    expect(calls).toHaveLength(1)
  })
})

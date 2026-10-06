import { describe, expect, test } from 'claude-code/testing'

import type { DeployDeckTarget } from '../types'
import type { Client } from '../hooks/net'
import { ProviderError, cliJson, getJson, redact, retryAfterMs } from '../hooks/net'
import { listGithub } from '../hooks/providers/github'
import { listVercel } from '../hooks/providers/vercel'

const NOW = Date.parse('2026-10-06T10:00:00Z')
const TOKEN = 'vcp_9Zk3LmQ8xR2tW7yB4nH6jF1sD5gA0cE'

function answering(status: number, text: string, headers: Record<string, string> = {}): Client {
  return {
    provider: 'vercel',
    token: TOKEN,
    secrets: [TOKEN, 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    now: NOW,
    fetch: async () => ({ status, ok: status >= 200 && status < 300, headers, text }),
  }
}

async function failure(work: () => Promise<unknown>): Promise<ProviderError> {
  try {
    await work()
  } catch (error) {
    if (error instanceof ProviderError) return error
    throw error
  }
  throw new Error('expected a ProviderError')
}

describe('the token never leaks', () => {
  const target: DeployDeckTarget = { kind: 'vercel', id: 'prj_1', source: 'pinned' }

  test('a 401 whose body echoes the token', async () => {
    const body = JSON.stringify({ error: { code: 'forbidden', message: `The token "${TOKEN}" is invalid. Bearer ${TOKEN}`, invalidToken: true } })
    const error = await failure(() => listVercel(answering(401, body), target, undefined))
    expect(error.kind).toBe('auth')
    expect(error.status).toBe(401)
    expect(error.message).toContain('vercel: not authorized (HTTP 401)')
    expect(error.message).toContain('check vercelToken')
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain(TOKEN.slice(4, 20))
    expect(String(error)).not.toContain(TOKEN)
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(TOKEN)
  })

  test('a network error naming the header', async () => {
    const client: Client = {
      ...answering(200, '{}'),
      fetch: async () => {
        throw new Error(`proxy refused Authorization: Bearer ${TOKEN}`)
      },
    }
    const error = await failure(() => getJson(client, 'https://api.vercel.com/v7/deployments'))
    expect(error.kind).toBe('network')
    expect(error.message).not.toContain(TOKEN)
  })

  test('a gh CLI failure that prints a token', async () => {
    const client: Client = {
      provider: 'github',
      secrets: [],
      now: NOW,
      fetch: async () => ({ status: 200, ok: true, headers: {}, text: '{}' }),
      run: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'HTTP 401: Bad credentials (token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789)',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      }),
    }
    const error = await failure(() => listGithub(client, { kind: 'github', id: 'acme/shop', source: 'detected' }))
    expect(error.kind).toBe('auth')
    expect(error.message).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
  })

  test('the token rides the Authorization header only, and only on GET', async () => {
    const seen: { url: string; method: string | undefined; auth: string | undefined }[] = []
    const client: Client = {
      ...answering(200, '{"deployments":[]}'),
      fetch: async (url, init) => {
        seen.push({ url, method: init?.method, auth: init?.headers?.['Authorization'] })
        return { status: 200, ok: true, headers: {}, text: '{"deployments":[]}' }
      },
    }
    await listVercel(client, target, 'team_1')
    expect(seen).toEqual([{ url: 'https://api.vercel.com/v7/deployments?projectId=prj_1&limit=10&teamId=team_1', method: 'GET', auth: `Bearer ${TOKEN}` }])
    expect(seen[0]?.url).not.toContain(TOKEN)
  })

  test('redact scrubs known secrets and token shapes', () => {
    expect(redact(`x ${TOKEN} y`, [TOKEN])).toBe('x ••• y')
    expect(redact('Authorization: Bearer abcdefghijklmnop', [])).toBe('Authorization: Bearer •••')
    expect(redact('github_pat_11ABCDEFGH0123456789_abcdef', [])).toBe('•••')
  })
})

describe('rate limits and errors', () => {
  test('429 with Retry-After seconds', async () => {
    const error = await failure(() => getJson(answering(429, '{}', { 'retry-after': '30' }), 'https://x'))
    expect(error.kind).toBe('rate')
    expect(error.retryAfterMs).toBe(30_000)
  })

  test('GitHub 403 with x-ratelimit-remaining 0 is a rate limit until the reset', async () => {
    const reset = String(Math.floor(NOW / 1000) + 600)
    const error = await failure(() =>
      getJson({ ...answering(403, '{"message":"API rate limit exceeded"}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), provider: 'github' }, 'https://x'),
    )
    expect(error.kind).toBe('rate')
    expect(error.retryAfterMs).toBe(600_000)
  })

  test('Render ratelimit-reset is seconds from now', () => {
    expect(retryAfterMs({ 'ratelimit-reset': '12' }, NOW)).toBe(12_000)
    expect(retryAfterMs({ 'retry-after': 'Tue, 06 Oct 2026 10:01:00 GMT' }, NOW)).toBe(60_000)
    expect(retryAfterMs({}, NOW)).toBeUndefined()
  })

  test('5xx is a server error; 404 not found; non-JSON a parse error', async () => {
    expect((await failure(() => getJson(answering(502, 'Bad gateway'), 'https://x'))).kind).toBe('server')
    expect((await failure(() => getJson(answering(404, '{"error":{"message":"Project not found"}}'), 'https://x'))).message).toBe(
      'vercel: not found (HTTP 404): Project not found',
    )
    expect((await failure(() => getJson(answering(200, '<html>'), 'https://x'))).kind).toBe('parse')
  })

  test('a CLI that cannot start', async () => {
    const client: Client = {
      provider: 'github',
      secrets: [],
      now: NOW,
      fetch: async () => ({ status: 200, ok: true, headers: {}, text: '{}' }),
      run: async () => {
        throw new Error('spawn gh ENOENT')
      },
    }
    const error = await failure(() => cliJson(client, ['gh', 'api', '/x']))
    expect(error.kind).toBe('cli')
    expect(error.message).toBe('github: gh could not run: spawn gh ENOENT')
  })
})

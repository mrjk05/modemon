import { expect, test } from 'claude-code/testing'

import type { DeployDeckDeploy, DeployDeckFeed } from '../types'
import {
  backoffDelay,
  bandDeploys,
  finishedSince,
  formatAge,
  formatElapsed,
  mergeTargets,
  parseCommand,
  parseTargetSpec,
  parseTargets,
  pipeline,
  runsText,
  statusText,
  toastText,
  versionFromRef,
} from '../hooks/lib'

const NOW = 1_000_000_000

function deploy(over: Partial<DeployDeckDeploy> = {}): DeployDeckDeploy {
  return {
    key: 'vercel:app:dpl_1',
    provider: 'vercel',
    kind: 'vercel',
    id: 'dpl_1',
    project: 'app',
    env: 'production',
    commit: 'abc1234def',
    stage: 'building',
    startedAt: NOW - 72_000,
    ...over,
  }
}

function feed(deploys: DeployDeckDeploy[], over: Partial<DeployDeckFeed> = {}): DeployDeckFeed {
  return { target: { kind: 'vercel', id: 'app', source: 'detected' }, deploys, auth: 'token', primed: true, checkedAt: NOW - 10_000, ...over }
}

test('target specs and aliases', () => {
  expect(parseTargetSpec('vercel:my-app', 'pinned')).toEqual({ kind: 'vercel', id: 'my-app', source: 'pinned' })
  expect(parseTargetSpec('cloudflare:site', 'added')).toEqual({ kind: 'cloudflare-pages', id: 'site', source: 'added' })
  expect(parseTargetSpec('workers:api', 'added')).toMatchObject({ kind: 'cloudflare-workers' })
  expect(parseTargetSpec('gh:acme/shop', 'added')).toMatchObject({ kind: 'github', id: 'acme/shop' })
  expect(parseTargetSpec('github:shop', 'added')).toBe('github targets are owner/repo, not "shop"')
  expect(parseTargetSpec('heroku:x', 'added')).toMatch(/unknown provider/)
  expect(parseTargetSpec('vercel', 'added')).toMatch(/not provider:id/)
  const { targets, errors } = parseTargets('vercel:my-app, cloudflare-pages:site  render:srv-123,bogus', 'pinned')
  expect(targets.map(t => `${t.kind}:${t.id}`)).toEqual(['vercel:my-app', 'cloudflare-pages:site', 'render:srv-123'])
  expect(errors).toHaveLength(1)
})

test('merging keeps the first of each and drops removed ones', () => {
  const merged = mergeTargets(
    [[{ kind: 'vercel', id: 'a', source: 'added' }], [{ kind: 'vercel', id: 'a', source: 'detected' }, { kind: 'render', id: 'b', source: 'detected' }]],
    ['render:b'],
  )
  expect(merged).toEqual([{ kind: 'vercel', id: 'a', source: 'added' }])
})

test('commands', () => {
  expect(parseCommand('')).toEqual({ verb: 'open' })
  expect(parseCommand('refresh')).toEqual({ verb: 'refresh' })
  expect(parseCommand('add vercel:my-app')).toEqual({ verb: 'add', spec: 'vercel:my-app' })
  expect(parseCommand('rm render:srv-1')).toEqual({ verb: 'remove', spec: 'render:srv-1' })
  expect(parseCommand('status')).toEqual({ verb: 'status' })
  expect(parseCommand('add')).toEqual({ verb: 'help' })
})

test('the pipeline, full and compact', () => {
  expect(runsText(pipeline({ stage: 'queued' }, false))).toBe('◉ queued ━ ○ building ━ ○ deploying ━ ○ live')
  expect(runsText(pipeline({ stage: 'building' }, false))).toBe('● queued ━ ◉ building ━ ○ deploying ━ ○ live')
  expect(runsText(pipeline({ stage: 'live' }, false))).toBe('● queued ━ ● building ━ ● deploying ━ ✓ live')
  expect(runsText(pipeline({ stage: 'failed', failedAt: 'building' }, false))).toBe('● queued ━ ✗ building ━ ○ deploying ━ ○ live')
  expect(runsText(pipeline({ stage: 'canceled' }, false))).toBe('○ queued ━ ○ building ━ ○ deploying ━ ⊘ canceled')
  expect(runsText(pipeline({ stage: 'deploying' }, true))).toBe('●━●━◉━○')
  const colors = pipeline({ stage: 'failed', failedAt: 'deploying' }, true).map(run => run.color ?? '-')
  expect(colors).toEqual(['success', '-', 'success', '-', 'error', '-', '-'])
})

test('times', () => {
  expect(formatElapsed(72_000)).toBe('1:12')
  expect(formatElapsed(5_000)).toBe('0:05')
  expect(formatElapsed(3_725_000)).toBe('1:02:05')
  expect(formatAge(10_000)).toBe('just now')
  expect(formatAge(5 * 60_000)).toBe('5m ago')
  expect(formatAge(3 * 3_600_000)).toBe('3h ago')
  expect(formatAge(3 * 86_400_000)).toBe('3d ago')
  expect(versionFromRef('v1.4.2')).toBe('v1.4.2')
  expect(versionFromRef('refs/tags/release-7')).toBe('release-7')
  expect(versionFromRef('main')).toBeUndefined()
})

test('status line: the in-flight one first, production first, then a recent finish', () => {
  const preview = deploy({ key: 'p', env: 'preview', provider: 'render', startedAt: NOW - 5_000 })
  const prod = deploy()
  expect(statusText({ a: feed([preview, prod]) }, {}, NOW)).toBe('🚀 vercel building 1:12 +1')
  const live = deploy({ stage: 'live', version: 'v1.4.2', finishedAt: NOW - 1_000 })
  expect(statusText({ a: feed([live]) }, { [live.key]: NOW - 1_000 }, NOW)).toBe('✓ prod live v1.4.2')
  const failed = deploy({ key: 'r', provider: 'render', env: undefined, stage: 'failed', failedAt: 'building' })
  expect(statusText({ a: feed([live, failed]) }, { [live.key]: NOW - 1_000, r: NOW - 2_000 }, NOW)).toBe('✗ render build failed')
  expect(statusText({ a: feed([live]) }, { [live.key]: NOW - 11 * 60_000 }, NOW)).toBeUndefined()
  // A stuck in-flight record older than six hours is not "current".
  expect(statusText({ a: feed([deploy({ startedAt: NOW - 7 * 3_600_000 })]) }, {}, NOW)).toBeUndefined()
})

test('toasts', () => {
  expect(toastText(deploy({ stage: 'live' }))).toBe('✓ vercel production live · abc1234')
  expect(toastText(deploy({ provider: 'render', env: undefined, stage: 'failed', failedAt: 'building' }))).toBe('✗ render build failed · abc1234')
})

test('band: in flight, plus finishes for a minute', () => {
  const active = deploy()
  const done = deploy({ key: 'done', stage: 'live', startedAt: NOW - 200_000 })
  const old = deploy({ key: 'old', stage: 'live', startedAt: NOW - 400_000 })
  const shown = bandDeploys({ a: feed([active, done, old]) }, { done: NOW - 30_000, old: NOW - 90_000 }, NOW)
  expect(shown.map(d => d.key)).toEqual([active.key, 'done'])
})

test('finishedSince: transitions, new finishes, and nothing on a first read', () => {
  const was = feed([deploy()])
  const now = [deploy({ stage: 'live', finishedAt: NOW })]
  expect(finishedSince(was, now).map(d => d.key)).toEqual([now[0]?.key])
  expect(finishedSince(feed([deploy({ stage: 'live' })]), now)).toEqual([])
  expect(finishedSince(feed([], { primed: false }), now)).toEqual([])
  expect(finishedSince(undefined, now)).toEqual([])
  const quick = deploy({ key: 'quick', stage: 'failed', startedAt: NOW - 5_000, finishedAt: NOW - 1_000 })
  const ancient = deploy({ key: 'ancient', stage: 'live', startedAt: NOW - 9e6, finishedAt: NOW - 9e6 })
  expect(finishedSince(feed([]), [quick, ancient]).map(d => d.key)).toEqual(['quick'])
})

test('backoff doubles to a cap, honours Retry-After, rests on auth errors', () => {
  expect(backoffDelay('rate', 1, undefined)).toBe(30_000)
  expect(backoffDelay('server', 3, undefined)).toBe(120_000)
  expect(backoffDelay('server', 20, undefined)).toBe(900_000)
  expect(backoffDelay('rate', 1, 300_000)).toBe(300_000)
  expect(backoffDelay('auth', 1, undefined)).toBe(600_000)
})

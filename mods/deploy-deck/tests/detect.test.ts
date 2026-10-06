import { expect, test } from 'claude-code/testing'

import {
  detectTargets,
  parseGitRemote,
  parseRenderYaml,
  parseVercelJsonName,
  parseVercelProject,
  parseWranglerJsonc,
  parseWranglerToml,
} from '../hooks/detect'
import * as F from './fixtures/repos'

const ROOT = '/work/shop'

function reader(files: Record<string, string>) {
  const asked: string[] = []
  const read = async (path: string) => {
    asked.push(path)
    return files[path]
  }
  return { read, asked }
}

test('git remotes on github.com in every spelling', () => {
  expect(parseGitRemote('git@github.com:acme/shop.git')).toBe('acme/shop')
  expect(parseGitRemote('https://github.com/acme/shop')).toBe('acme/shop')
  expect(parseGitRemote('https://github.com/acme/shop.git/')).toBe('acme/shop')
  expect(parseGitRemote('ssh://git@github.com/acme/my.site.git')).toBe('acme/my.site')
  expect(parseGitRemote('https://x-access-token:abc@github.com/acme/shop.git')).toBe('acme/shop')
  expect(parseGitRemote('git@gitlab.com:acme/shop.git')).toBeUndefined()
  expect(parseGitRemote(null)).toBeUndefined()
})

test('vercel: project.json and vercel.json', () => {
  expect(parseVercelProject(F.VERCEL_PROJECT_JSON)).toEqual({
    projectId: 'prj_Qm8kd7Vf2LpXr0aNc3TyEw9H',
    orgId: 'team_9aB8cD7eF6gH5iJ4kL3mN2oP',
    name: 'shop-web',
  })
  expect(parseVercelProject('{}')).toBeUndefined()
  expect(parseVercelProject('not json')).toBeUndefined()
  expect(parseVercelJsonName(F.VERCEL_JSON)).toBeUndefined()
  expect(parseVercelJsonName('{"name":"legacy-app"}')).toBe('legacy-app')
})

test('wrangler: Pages vs Workers, toml and jsonc', () => {
  expect(parseWranglerToml(F.WRANGLER_PAGES_TOML)).toEqual({
    name: 'docs-site',
    kind: 'cloudflare-pages',
    accountId: '023e105f4ecef8ad9ca31a8372d0c353',
  })
  expect(parseWranglerToml(F.WRANGLER_WORKER_TOML)).toEqual({ name: 'edge-api', kind: 'cloudflare-workers' })
  expect(parseWranglerJsonc(F.WRANGLER_JSONC)).toEqual({ name: 'edge-api', kind: 'cloudflare-workers' })
  expect(parseWranglerToml('[vars]\nname = "x"\n')).toBeUndefined()
})

test('render.yaml: service names only, not env var or database references', () => {
  expect(parseRenderYaml(F.RENDER_YAML)).toEqual(['shop-api', 'shop-worker'])
  expect(parseRenderYaml('databases:\n  - name: db\n')).toEqual([])
})

test('detectTargets reads every file and builds targets', async () => {
  const { read } = reader({
    [`${ROOT}/.vercel/project.json`]: F.VERCEL_PROJECT_JSON,
    [`${ROOT}/wrangler.toml`]: F.WRANGLER_PAGES_TOML,
    [`${ROOT}/render.yaml`]: F.RENDER_YAML,
  })
  const targets = await detectTargets(ROOT, 'git@github.com:acme/shop.git', read)
  expect(targets).toEqual([
    { kind: 'github', id: 'acme/shop', source: 'detected' },
    {
      kind: 'vercel',
      id: 'prj_Qm8kd7Vf2LpXr0aNc3TyEw9H',
      source: 'detected',
      meta: { teamId: 'team_9aB8cD7eF6gH5iJ4kL3mN2oP', name: 'shop-web' },
    },
    { kind: 'cloudflare-pages', id: 'docs-site', source: 'detected', meta: { accountId: '023e105f4ecef8ad9ca31a8372d0c353' } },
    { kind: 'render', id: 'shop-api', source: 'detected' },
    { kind: 'render', id: 'shop-worker', source: 'detected' },
  ])
})

test('a personal Vercel link has no team; vercel.json alone names the folder; wrangler.jsonc is read', async () => {
  const personal = await detectTargets(ROOT, null, reader({ [`${ROOT}/.vercel/project.json`]: F.VERCEL_PROJECT_JSON_PERSONAL }).read)
  expect(personal).toEqual([{ kind: 'vercel', id: 'prj_personal123', source: 'detected', meta: {} }])

  const unlinked = await detectTargets(
    ROOT,
    'https://example.com/acme/shop.git',
    reader({ [`${ROOT}/vercel.json`]: F.VERCEL_JSON, [`${ROOT}/wrangler.jsonc`]: F.WRANGLER_JSONC }).read,
  )
  expect(unlinked).toEqual([
    { kind: 'vercel', id: 'shop', source: 'detected', meta: { guessed: 'name' } },
    { kind: 'cloudflare-workers', id: 'edge-api', source: 'detected' },
  ])
})

test('an empty repo detects nothing', async () => {
  expect(await detectTargets(ROOT, null, reader({}).read)).toEqual([])
})

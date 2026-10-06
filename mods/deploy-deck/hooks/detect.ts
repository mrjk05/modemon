// Detection: which targets a repo deploys to, read from its files.
//
// - git remote on github.com          → github:owner/repo
// - .vercel/project.json {projectId, orgId} → vercel:<projectId> (orgId team_… → team)
//   else vercel.json (with `name`, or the folder's name) → vercel:<name>
// - wrangler.toml / wrangler.jsonc / wrangler.json: `name`; with
//   `pages_build_output_dir` it is a Pages project, else a Worker;
//   `account_id` is kept for the Cloudflare account
// - render.yaml: each `services[].name` → render:<name> (resolved to srv-… by API)
//
// The parsers are pure; `detectTargets` reads the files through a reader.

import type { DeployDeckTarget } from '../types'

/** `git@github.com:o/r.git`, `https://github.com/o/r`, `ssh://git@github.com/o/r.git` → `o/r`. */
export function parseGitRemote(remote: string | null | undefined): string | undefined {
  if (remote === null || remote === undefined) return undefined
  const match = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  if (match === null) return undefined
  return `${match[1]}/${match[2]}`
}

/** `.vercel/project.json` → its project and org ids. */
export function parseVercelProject(text: string): { projectId: string; orgId?: string; name?: string } | undefined {
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const projectId = body['projectId']
    if (typeof projectId !== 'string' || projectId === '') return undefined
    const out: { projectId: string; orgId?: string; name?: string } = { projectId }
    if (typeof body['orgId'] === 'string') out.orgId = body['orgId']
    if (typeof body['projectName'] === 'string') out.name = body['projectName']
    return out
  } catch {
    return undefined
  }
}

/** `vercel.json`'s (legacy) `name`, when it has one. */
export function parseVercelJsonName(text: string): string | undefined {
  try {
    const name = (JSON.parse(stripJsonc(text)) as Record<string, unknown>)['name']
    return typeof name === 'string' && name !== '' ? name : undefined
  } catch {
    return undefined
  }
}

/** JSONC → JSON: drops comments (outside strings) and trailing commas. */
export function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    const next = text[i + 1]
    if (inString) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i += 1
      } else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

export type WranglerInfo = { name: string; kind: 'cloudflare-pages' | 'cloudflare-workers'; accountId?: string }

function wranglerFrom(name: unknown, pagesDir: unknown, accountId: unknown): WranglerInfo | undefined {
  if (typeof name !== 'string' || name === '') return undefined
  const info: WranglerInfo = { name, kind: typeof pagesDir === 'string' && pagesDir !== '' ? 'cloudflare-pages' : 'cloudflare-workers' }
  if (typeof accountId === 'string' && accountId !== '') info.accountId = accountId
  return info
}

/** The top-level keys of a `wrangler.toml` (before its first [table]). */
export function parseWranglerToml(text: string): WranglerInfo | undefined {
  const top: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) break
    const match = /^([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^#\s][^#]*?))\s*(?:#.*)?$/.exec(line)
    if (match === null) continue
    const key = match[1] ?? ''
    top[key] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return wranglerFrom(top['name'], top['pages_build_output_dir'], top['account_id'])
}

/** `wrangler.jsonc` / `wrangler.json`. */
export function parseWranglerJsonc(text: string): WranglerInfo | undefined {
  try {
    const body = JSON.parse(stripJsonc(text)) as Record<string, unknown>
    return wranglerFrom(body['name'], body['pages_build_output_dir'], body['account_id'])
  } catch {
    return undefined
  }
}

/** The service names in a `render.yaml` blueprint (`services:` → `- name:`). */
export function parseRenderYaml(text: string): string[] {
  const names: string[] = []
  let inServices = false
  let itemIndent = -1
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(raw)) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (indent === 0) {
      inServices = /^services\s*:\s*$/.test(line)
      itemIndent = -1
      continue
    }
    if (!inServices) continue
    if (line.startsWith('- ')) {
      if (itemIndent === -1) itemIndent = indent
      if (indent !== itemIndent) continue
      const first = /^-\s+name\s*:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line)
      if (first?.[1] !== undefined) names.push(first[1])
      continue
    }
    if (itemIndent !== -1 && indent === itemIndent + 2) {
      const key = /^name\s*:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line)
      if (key?.[1] !== undefined) names.push(key[1])
    }
  }
  return [...new Set(names)]
}

/** Reads a file, or undefined when it is not there. */
export type Reader = (path: string) => Promise<string | undefined>

/** Every target the repo at `root` declares. */
export async function detectTargets(root: string, remote: string | null | undefined, read: Reader): Promise<DeployDeckTarget[]> {
  const found: DeployDeckTarget[] = []
  const repo = parseGitRemote(remote)
  if (repo !== undefined) found.push({ kind: 'github', id: repo, source: 'detected' })

  const project = await read(`${root}/.vercel/project.json`)
  const vercel = project === undefined ? undefined : parseVercelProject(project)
  if (vercel !== undefined) {
    const meta: Record<string, string> = {}
    if (vercel.orgId?.startsWith('team_') === true) meta['teamId'] = vercel.orgId
    if (vercel.name !== undefined) meta['name'] = vercel.name
    found.push({ kind: 'vercel', id: vercel.projectId, source: 'detected', meta })
  } else {
    const config = await read(`${root}/vercel.json`)
    if (config !== undefined) {
      const folder = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
      const name = parseVercelJsonName(config) ?? folder
      if (name !== '') found.push({ kind: 'vercel', id: name, source: 'detected', meta: { guessed: 'name' } })
    }
  }

  let wrangler: WranglerInfo | undefined
  const toml = await read(`${root}/wrangler.toml`)
  if (toml !== undefined) wrangler = parseWranglerToml(toml)
  for (const file of ['wrangler.jsonc', 'wrangler.json']) {
    if (wrangler !== undefined) break
    const json = await read(`${root}/${file}`)
    if (json !== undefined) wrangler = parseWranglerJsonc(json)
  }
  if (wrangler !== undefined) {
    const target: DeployDeckTarget = { kind: wrangler.kind, id: wrangler.name, source: 'detected' }
    if (wrangler.accountId !== undefined) target.meta = { accountId: wrangler.accountId }
    found.push(target)
  }

  const blueprint = (await read(`${root}/render.yaml`)) ?? (await read(`${root}/render.yml`))
  if (blueprint !== undefined) {
    for (const name of parseRenderYaml(blueprint)) found.push({ kind: 'render', id: name, source: 'detected' })
  }
  return found
}

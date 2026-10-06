// The tracker's pure half: the config, how each provider is reached, and one
// target's read through its adapter. The polling itself (timer, state,
// toasts) is in register.tsx, where `$` lives.

import type { DeployDeckAuth, DeployDeckDeploy, DeployDeckProvider, DeployDeckTarget } from '../types'
import type { Client } from './net'
import { ProviderError } from './net'
import { listCloudflare } from './providers/cloudflare'
import { listGithub } from './providers/github'
import { listRender } from './providers/render'
import { listVercel } from './providers/vercel'


export type Config = {
  tokens: Partial<Record<DeployDeckProvider, string>>
  vercelTeamId: string
  cloudflareAccountId: string
  targets: string
  autoDetect: boolean
  useCli: boolean
  fastMs: number
  slowMs: number
  band: boolean
  toasts: boolean
  statusLine: boolean
}

/** Runs work that must never break the caller. */
export async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch {
    // A missed read costs one refresh, never the user's session.
  }
}

/** How a provider is reached under this config. */
export function authOf(provider: DeployDeckProvider, cfg: Config): DeployDeckAuth {
  const token = cfg.tokens[provider]
  if (token !== undefined && token !== '') return 'token'
  if (provider === 'github' && cfg.useCli) return 'cli'
  return 'none'
}

export function secretsOf(cfg: Config): string[] {
  return Object.values(cfg.tokens).filter((token): token is string => token !== undefined && token !== '')
}

/** One target's read, through its adapter. */
export async function readTarget(
  client: Client,
  target: DeployDeckTarget,
  cfg: Config,
): Promise<{ deploys: DeployDeckDeploy[]; meta?: Record<string, string> }> {
  switch (target.kind) {
    case 'github':
      return { deploys: await listGithub(client, target) }
    case 'vercel': {
      const team = cfg.vercelTeamId !== '' ? cfg.vercelTeamId : target.meta?.['teamId']
      return { deploys: await listVercel(client, target, team) }
    }
    case 'cloudflare-pages':
    case 'cloudflare-workers': {
      const account = cfg.cloudflareAccountId !== '' ? cfg.cloudflareAccountId : (target.meta?.['accountId'] ?? '')
      if (account === '') {
        throw new ProviderError('cloudflare', 'config', 'cloudflare: set cloudflareAccountId (or account_id in wrangler.toml)')
      }
      return { deploys: await listCloudflare(client, target, account) }
    }
    case 'render':
      return listRender(client, target)
  }
}

export const MISSING: Record<DeployDeckProvider, string> = {
  github: 'github: no githubToken and the gh CLI fallback is off; see /deploys status',
  vercel: 'vercel: set vercelToken to read deployments; see /deploys',
  cloudflare: 'cloudflare: set cloudflareToken and cloudflareAccountId; see /deploys',
  render: 'render: set renderToken to read deploys; see /deploys',
}


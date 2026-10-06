// deploy-deck's state contract: what it keeps in `$.state` for the session,
// so a hot reload of the module keeps every deploy it has seen.

/** The providers deploy-deck reads. */
export type DeployDeckProvider = 'github' | 'vercel' | 'cloudflare' | 'render'

/** What a target is on its provider. */
export type DeployDeckTargetKind = 'github' | 'vercel' | 'cloudflare-pages' | 'cloudflare-workers' | 'render'

/** The one normalised stage pipeline: queued → building → deploying → live / failed / canceled. */
export type DeployDeckStage = 'queued' | 'building' | 'deploying' | 'live' | 'failed' | 'canceled'

/** The in-flight stages, in pipeline order. */
export type DeployDeckStep = 'queued' | 'building' | 'deploying'

/** One thing deploys are read for: a repo, a project, a script, a service. */
export type DeployDeckTarget = {
  kind: DeployDeckTargetKind
  /** owner/repo, a Vercel project id or name, a Pages project, a Worker script, a Render service id or name. */
  id: string
  /** Where it came from. */
  source: 'detected' | 'pinned' | 'added'
  /** Provider facts learned along the way (account id, team id, resolved service id, dashboard URL). */
  meta?: Record<string, string>
}

/** One deploy, normalised across providers. */
export type DeployDeckDeploy = {
  /** `<kind>:<target id>:<provider id>`: unique in the session. */
  key: string
  provider: DeployDeckProvider
  kind: DeployDeckTargetKind
  /** The provider's id for it. */
  id: string
  /** The project, repo, script or service it belongs to. */
  project: string
  /** production, preview, a GitHub environment or workflow name. */
  env?: string
  /** A tag or version number, when the provider has one. */
  version?: string
  /** The full commit sha, when known. */
  commit?: string
  branch?: string
  message?: string
  stage: DeployDeckStage
  /** For a failed deploy: the step it failed in. */
  failedAt?: DeployDeckStep
  /** A short provider note (`blocked`, `superseded`, `90% of traffic`). */
  note?: string
  /** Epoch milliseconds. */
  startedAt: number
  finishedAt?: number
  /** The deployed site, when there is one. */
  url?: string
  /** Where its build or run logs are. */
  logsUrl?: string
}

/** How a provider is reached. */
export type DeployDeckAuth = 'token' | 'cli' | 'none'

/** One target's latest read. */
export type DeployDeckFeed = {
  target: DeployDeckTarget
  /** Newest first. */
  deploys: DeployDeckDeploy[]
  auth: DeployDeckAuth
  /** The last read's error, already free of any credential. */
  error?: string
  /** When it was last read (epoch ms). */
  checkedAt?: number
  /** True once a read succeeded: later reads may toast new deploys. */
  primed: boolean
}

/** Per-provider backoff after rate limits, server errors and auth failures. */
export type DeployDeckBackoff = { until: number; failures: number; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'deploy-deck': {
      /** The targets in force: detected, pinned in settings, added by command. */
      targets: DeployDeckTarget[]
      /** Each target's latest read, by target key (`<kind>:<id>`). */
      feeds: Record<string, DeployDeckFeed>
      /** The clock at the last tick, which elapsed times read. */
      now: number
      /** Deploy keys a finish toast went out for. */
      announced: string[]
      /** When a deploy was seen to finish (deploy key → epoch ms): the band keeps it 60s. */
      finished: Record<string, number>
      /** Per-provider backoff. */
      backoff: Partial<Record<DeployDeckProvider, DeployDeckBackoff>>
      /** The poll interval in force (ms); 0 while stopped. */
      intervalMs: number
      /** True once targets were resolved this session. */
      isReady: boolean
    }
  }
}

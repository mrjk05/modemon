// The one network door every adapter goes through. It injects the
// provider's credential into the request headers, sends GET only, and turns
// every failure into a ProviderError whose message is built here, scrubbed
// of every secret the client knows: no token ever reaches an error, a log,
// the status line or the UI.

import type { HttpInit, HttpResponse, ProcessRunResult } from 'claude-code'

import type { DeployDeckProvider } from '../types'

export type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>
export type Run = (argv: readonly string[]) => Promise<ProcessRunResult>

/** How one provider is reached for one poll. */
export type Client = {
  provider: DeployDeckProvider
  fetch: Fetch
  /** A host command runner, for the CLI fallback. */
  run?: Run
  /** The provider's token; absent when the CLI (or nothing) is used. */
  token?: string
  /** Every secret the error text must never hold (all tokens). */
  secrets: readonly string[]
  /** The clock at the poll, for Retry-After / reset headers. */
  now: number
}

export type ProviderErrorKind = 'auth' | 'notfound' | 'rate' | 'server' | 'network' | 'parse' | 'cli' | 'config'

/** A failed read, its message safe to show. */
export class ProviderError extends Error {
  readonly provider: DeployDeckProvider
  readonly kind: ProviderErrorKind
  readonly status: number | undefined
  /** How long the provider asked us to wait, when it said so. */
  readonly retryAfterMs: number | undefined

  constructor(
    provider: DeployDeckProvider,
    kind: ProviderErrorKind,
    message: string,
    status?: number,
    retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
    this.provider = provider
    this.kind = kind
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

const USER_AGENT = 'deploy-deck (Claude Code mod; +https://github.com/mrjk05/modemon)'

/** Removes every known secret, and anything shaped like a bearer credential, from `text`. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('•••')
  }
  return out
    .replace(/(bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 •••')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|rnd_[A-Za-z0-9]{8,})\b/g, '•••')
}

/** One line, at most `max` characters. */
function oneLine(text: string, max = 160): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * How long to wait, from `Retry-After` (seconds or an HTTP date) or a reset
 * header (`x-ratelimit-reset`, `ratelimit-reset`: epoch seconds, or seconds
 * from now when small). Headers are lower-cased, as `$.http.fetch` gives them.
 */
export function retryAfterMs(headers: Readonly<Record<string, string>>, now: number): number | undefined {
  const after = headers['retry-after']
  if (after !== undefined && after.trim() !== '') {
    const seconds = Number(after)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const at = Date.parse(after)
    if (Number.isFinite(at)) return Math.max(0, at - now)
  }
  const reset = headers['x-ratelimit-reset'] ?? headers['ratelimit-reset']
  if (reset !== undefined) {
    const value = Number(reset)
    if (Number.isFinite(value)) {
      // Epoch seconds (GitHub, Vercel) or seconds until reset (Render).
      return value > 1e9 ? Math.max(0, value * 1000 - now) : Math.max(0, value * 1000)
    }
  }
  return undefined
}

/** The provider's own error words from a JSON body, when it has some. */
function bodyMessage(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const error = body['error']
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>)['message']
      if (typeof message === 'string') return message
    }
    if (typeof error === 'string') return error
    const errors = body['errors']
    if (Array.isArray(errors) && errors.length > 0) {
      const first = errors[0] as Record<string, unknown> | undefined
      if (first !== undefined && typeof first['message'] === 'string') return first['message']
    }
    if (typeof body['message'] === 'string') return body['message']
  } catch {
    // not JSON
  }
  return undefined
}

const TOKEN_FIELD: Record<DeployDeckProvider, string> = {
  github: 'githubToken',
  vercel: 'vercelToken',
  cloudflare: 'cloudflareToken',
  render: 'renderToken',
}

/** Builds the safe error for a non-2xx answer. */
export function httpError(client: Client, response: HttpResponse): ProviderError {
  const { provider } = client
  const status = response.status
  const said = bodyMessage(response.text)
  const detail = said === undefined ? '' : `: ${oneLine(redact(said, client.secrets), 120)}`
  const wait = retryAfterMs(response.headers, client.now)
  const isRateLimited =
    status === 429 || (status === 403 && (response.headers['x-ratelimit-remaining'] === '0' || wait !== undefined))
  if (isRateLimited) return new ProviderError(provider, 'rate', `${provider}: rate limited (HTTP ${status})`, status, wait)
  if (status >= 500) return new ProviderError(provider, 'server', `${provider}: server error (HTTP ${status})${detail}`, status, wait)
  if (status === 401 || status === 403) {
    const hint = client.token !== undefined ? `check ${TOKEN_FIELD[provider]} and its read scopes` : 'set a read-only token'
    return new ProviderError(provider, 'auth', `${provider}: not authorized (HTTP ${status})${detail}; ${hint}`, status)
  }
  if (status === 404) return new ProviderError(provider, 'notfound', `${provider}: not found (HTTP 404)${detail}`, status)
  return new ProviderError(provider, 'server', `${provider}: HTTP ${status}${detail}`, status)
}

/**
 * GETs `url` with the provider's auth header and answers its JSON body.
 * Throws ProviderError only, whose message never holds a secret.
 */
export async function getJson(client: Client, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const sent: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers }
  if (client.token !== undefined && client.token !== '') sent['Authorization'] = `Bearer ${client.token}`
  let response: HttpResponse
  try {
    response = await client.fetch(url, { method: 'GET', headers: sent })
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    throw new ProviderError(client.provider, 'network', `${client.provider}: network error: ${oneLine(redact(said, client.secrets), 120)}`)
  }
  if (!response.ok) throw httpError(client, response)
  try {
    return JSON.parse(response.text) as unknown
  } catch {
    throw new ProviderError(client.provider, 'parse', `${client.provider}: answer was not JSON (HTTP ${response.status})`)
  }
}

/** Runs a read-only CLI command that prints JSON (`gh api <path>`) and parses it. */
export async function cliJson(client: Client, argv: readonly string[]): Promise<unknown> {
  const tool = argv[0] ?? 'cli'
  if (client.run === undefined) throw new ProviderError(client.provider, 'cli', `${client.provider}: no CLI runner`)
  let ran: ProcessRunResult
  try {
    ran = await client.run(argv)
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    throw new ProviderError(client.provider, 'cli', `${client.provider}: ${tool} could not run: ${oneLine(redact(said, client.secrets), 100)}`)
  }
  if (ran.exitCode !== 0) {
    const said = oneLine(redact(ran.stderr || ran.stdout, client.secrets), 120)
    const status = /HTTP (\d{3})/.exec(said)?.[1]
    const code = status === undefined ? undefined : Number(status)
    const kind: ProviderErrorKind =
      code === 401 || code === 403 || /auth login|not logged/i.test(said)
        ? 'auth'
        : code === 404
          ? 'notfound'
          : code === 429
            ? 'rate'
            : code !== undefined && code >= 500
              ? 'server'
              : 'cli'
    throw new ProviderError(client.provider, kind, `${client.provider}: ${tool} failed: ${said}`, code)
  }
  try {
    return JSON.parse(ran.stdout) as unknown
  } catch {
    throw new ProviderError(client.provider, 'parse', `${client.provider}: ${tool} did not print JSON`)
  }
}

// --- Tolerant readers over unknown JSON ---------------------------------------

export type Json = Record<string, unknown>

export function obj(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function str(record: Json | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function num(record: Json | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** An ISO date string or epoch ms, as epoch ms. */
export function time(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const at = Date.parse(value)
    return Number.isFinite(at) ? at : undefined
  }
  return undefined
}

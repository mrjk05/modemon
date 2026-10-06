// Pure helpers for agent-deck: formatting and describing, no `$`.

import type { AgentDeckCard, AgentDeckStatus } from '../types'

/** Cuts `text` to `max` characters, ending in an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (max === 1) return '…'
  return text.slice(0, max - 1).trimEnd() + '…'
}

/** Elapsed time as a card shows it: `0s`, `42s`, `3m 07s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/**
 * A prompt summarised to one line: markdown markers and whitespace folded,
 * cut at a word boundary to `max` characters.
 */
export function summarizePrompt(prompt: string, max = 120): string {
  const lines = prompt
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, '').trim())
    .filter(line => line.length > 0 && !/^```/.test(line))
  const flat = lines.join(' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  const head = space > max * 0.6 ? cut.slice(0, space) : cut
  return head.replace(/[\s,.;:]+$/, '') + '…'
}

/** A path made short: relative to `cwd` when under it, else its last three parts. */
export function shortPath(path: string, cwd?: string): string {
  if (cwd !== undefined && cwd.length > 0) {
    const root = cwd.endsWith('/') ? cwd : cwd + '/'
    if (path.startsWith(root)) return path.slice(root.length)
  }
  const parts = path.split('/').filter(part => part.length > 0)
  if (parts.length <= 3) return path
  return '…/' + parts.slice(-3).join('/')
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function quoted(text: string, max: number): string {
  return `"${truncate(text.replace(/\s+/g, ' '), max)}"`
}

/**
 * One tool call described in a few words: `Grep "foo"`, `Edit src/x.ts`,
 * `Bash npm test`, `WebFetch example.com`. Cut to `max` characters.
 */
export function describeTool(
  tool: string,
  input: Record<string, unknown>,
  cwd?: string,
  max = 60,
): string {
  const name = String(tool)
  let text: string
  const path = str(input, 'file_path') ?? str(input, 'notebook_path')
  if (name === 'Grep' || name === 'Glob') {
    const pattern = str(input, 'pattern')
    text = pattern === undefined ? name : `${name} ${quoted(pattern, 40)}`
  } else if (path !== undefined) {
    text = `${name} ${shortPath(path, cwd)}`
  } else if (name === 'Bash' || name === 'PowerShell') {
    const command = str(input, 'command')
    const first = command?.split(/\r?\n/)[0]?.trim()
    text = first === undefined || first.length === 0 ? name : `${name} ${first}`
  } else if (name === 'WebFetch') {
    const url = str(input, 'url')
    text = url === undefined ? name : `${name} ${hostOf(url)}`
  } else if (name === 'WebSearch') {
    const query = str(input, 'query')
    text = query === undefined ? name : `${name} ${quoted(query, 40)}`
  } else if (name === 'Agent' || name === 'Task') {
    const description = str(input, 'description')
    text = description === undefined ? name : `${name} ${quoted(description, 40)}`
  } else if (name === 'Skill') {
    const skill = str(input, 'skill') ?? str(input, 'command')
    text = skill === undefined ? name : `${name} ${skill}`
  } else if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__')
    text = rest.length > 0 ? `${server ?? 'mcp'} ${rest.join('__')}` : name
  } else {
    text = name
  }
  return truncate(text, max)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/**
 * A model id made short: `claude-haiku-4-5-20251001` → `haiku 4.5`,
 * `claude-opus-5-5[1m]` → `opus 5.5`; an alias (`haiku`) stays as given.
 */
export function shortModel(model: string | undefined): string | undefined {
  if (model === undefined || model.length === 0) return undefined
  let id = model.replace(/\[[^\]]*\]$/, '').replace(/^(?:[a-z]+\.)?anthropic\./, '')
  id = id.replace(/^claude-/, '').replace(/-\d{8}(?:-v\d+(?::\d+)?)?$/, '').replace(/@\d{8}$/, '')
  const pair = /^([a-z]+)-(\d+)-(\d+)$/.exec(id)
  if (pair !== null) return `${pair[1]} ${pair[2]}.${pair[3]}`
  const single = /^([a-z]+)-(\d+)$/.exec(id)
  if (single !== null) return `${single[1]} ${single[2]}`
  const legacy = /^(\d+)-(\d+)-([a-z]+)$/.exec(id)
  if (legacy !== null) return `${legacy[3]} ${legacy[1]}.${legacy[2]}`
  return id
}

/** How many cards stand in each status. */
export function countByStatus(cards: readonly AgentDeckCard[]): Record<AgentDeckStatus, number> {
  const counts: Record<AgentDeckStatus, number> = { running: 0, done: 0, failed: 0 }
  for (const card of cards) counts[card.status] += 1
  return counts
}

/** The status line while agents run (`⚙ 2 agents running`), else undefined. */
export function statusText(cards: readonly AgentDeckCard[]): string | undefined {
  const running = countByStatus(cards).running
  if (running === 0) return undefined
  return `⚙ ${running} agent${running === 1 ? '' : 's'} running`
}

/** Running cards first (oldest first), then finished ones, latest to end first. */
export function orderCards(cards: readonly AgentDeckCard[]): AgentDeckCard[] {
  const running = cards.filter(card => card.status === 'running')
  const finished = cards
    .filter(card => card.status !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  return [...running, ...finished]
}

/** A card's elapsed time: to `now` while it runs, to its end once finished. */
export function elapsedOf(card: AgentDeckCard, now: number): number {
  const end = card.status === 'running' ? Math.max(now, card.startedAt) : (card.endedAt ?? now)
  return Math.max(0, end - card.startedAt)
}

/** The header line over the cards: `2 running · 1 done · 1 failed`. */
export function headerText(cards: readonly AgentDeckCard[]): string {
  if (cards.length === 0) return 'No subagents yet'
  const counts = countByStatus(cards)
  const parts: string[] = []
  if (counts.running > 0) parts.push(`${counts.running} running`)
  if (counts.done > 0) parts.push(`${counts.done} done`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  return parts.join(' · ')
}

/** What `/agents <args>` asks for. */
export type DeckCommand = 'toggle' | 'open' | 'close' | 'clear' | 'help'

/** Parses the arguments of `/agents`. */
export function parseCommand(args: string): DeckCommand {
  const word = args.trim().toLowerCase()
  if (word === '') return 'toggle'
  if (word === 'clear' || word === 'open' || word === 'close') return word
  return 'help'
}

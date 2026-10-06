// agent-deck: a side pane with one card per subagent of the session.
//
// Data: the Agent tool's `tool.call` (start and result), `agent.spawn`
// (agent id and resolved model), every `tool.call` carrying `agentId` (the
// subagent's own tool calls), `turn.complete` and `classic.SubagentStop`
// (its end), and `$.agent.list()` (reconciled while any run).
//
// Every card lives in `$.state`, so a hot reload keeps the deck. Two runtime
// facts stay module-level on purpose: the ticking timer's handle (a reload
// drops the timers, and the handle with them) and the layout last seen while
// drawing (a render hook may not write `$.state`; it is re-learned at the
// next draw).

import { atom, read, update } from 'claude-code'
import type {
  AgentSpawnInput,
  CommandRunInput,
  CommandRunResult,
  EngineInterface,
  RenderSurface,
  PluginOptions,
  Register,
  RenderViewport,
  Timer,
  ToolCallResult,
} from 'claude-code'

import type { AgentDeckCard, AgentDeckStatus } from '../types'
import {
  describeTool,
  elapsedOf,
  formatClock,
  formatElapsed,
  headerText,
  INLINE_HEAD,
  inlineDeckText,
  metaLine,
  orderCards,
  parseCommand,
  shortModel,
  statusGlyph,
  statusText,
  summarizePrompt,
  toolLine,
  truncate,
} from './lib'

type Engine = EngineInterface
type Cards = AgentDeckCard[]

const PANE = 'agent-deck'
const TITLE = 'Agents'
const TICK_MS = 1000
const RECONCILE_EVERY = 5
/** The width from which a pane opened unasked is seated (see PaneOpenArgs). */
const UNASKED_MIN_COLUMNS = 144

const agents = atom({ plugin: 'agent-deck', key: 'agents' } as const, [] as Cards)
const clockNow = atom({ plugin: 'agent-deck', key: 'now' } as const, 0)
const autoOpened = atom({ plugin: 'agent-deck', key: 'autoOpened' } as const, false)
const cwdAtom = atom({ plugin: 'agent-deck', key: 'cwd' } as const, '')
const phoneWatching = atom({ plugin: 'agent-deck', key: 'phoneWatching' } as const, false)

/** The ticking timer while any agent runs (runtime handle, see the header). */
let ticker: Timer | undefined
/** The layout last seen while drawing or running a command (see the header). */
let layout: { isFullscreen?: boolean; columns?: number } = {}

function learnLayout(viewport: RenderViewport | undefined): void {
  if (viewport === undefined) return
  layout = {
    isFullscreen: viewport.isFullscreen ?? layout.isFullscreen,
    columns: viewport.columns,
  }
}

/** Runs bookkeeping that must never stand in the way of the call it watches. */
async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch {
    // A tracking miss costs a card's detail, never the user's tool call.
  }
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function replaceCard(list: Cards, key: string, change: (card: AgentDeckCard) => AgentDeckCard): Cards {
  return list.map(card => (card.key === key ? change(card) : card))
}

function findByAgent(list: Cards, agentId: string): AgentDeckCard | undefined {
  return list.find(card => card.agentId === agentId)
}

function finish(card: AgentDeckCard, status: AgentDeckStatus, at: number, note?: string): AgentDeckCard {
  if (card.status !== 'running') return card
  const ended: AgentDeckCard = { ...card, status, endedAt: at }
  if (card.currentTool !== undefined) {
    ended.lastTool = card.currentTool
    delete ended.currentTool
  }
  if (note !== undefined) ended.note = note
  return ended
}

type Config = { autoOpen: boolean; statusLine: boolean }

/** Status line and ticker follow the cards after every change. */
async function settle($: Engine, cfg: Config): Promise<void> {
  const list = await read($, agents)
  if (cfg.statusLine) $.ui.status(statusText(list, await read($, phoneWatching)))
  const isRunning = list.some(card => card.status === 'running')
  if (isRunning && ticker === undefined) {
    let ticks = 0
    ticker = $.clock.every(TICK_MS, () => {
      ticks += 1
      void quietly(() => tick($, cfg, ticks % RECONCILE_EVERY === 0))
    })
  } else if (!isRunning && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
  }
}

async function tick($: Engine, cfg: Config, reconcileToo: boolean): Promise<void> {
  const at = await $.clock.now()
  await update($, clockNow, () => at)
  if (reconcileToo) await reconcile($, cfg)
  else await settle($, cfg)
}

async function change($: Engine, cfg: Config, edit: (list: Cards, at: number) => Cards): Promise<void> {
  const at = await $.clock.now()
  await update($, agents, list => edit(list, at))
  await update($, clockNow, previous => Math.max(previous, at))
  await settle($, cfg)
}

/** Brings the cards in line with the engine's own list of agents. */
async function reconcile($: Engine, cfg: Config): Promise<void> {
  const listed = await $.agent.list()
  await change($, cfg, (list, at) => {
    let next = list
    for (const info of listed) {
      const card = findByAgent(next, info.id)
      if (card === undefined) {
        const isLive = info.status === 'running' || info.status === 'pending' || info.status === 'waiting'
        if (!isLive) continue
        next = [
          ...next,
          {
            key: `agent:${info.id}`,
            agentId: info.id,
            status: 'running',
            type: info.type,
            title: info.description || info.name || info.type,
            summary: '',
            startedAt: at,
            toolCount: 0,
          },
        ]
      } else if (info.status === 'completed') {
        next = replaceCard(next, card.key, one => finish(one, 'done', at))
      } else if (info.status === 'failed' || info.status === 'killed') {
        next = replaceCard(next, card.key, one => finish(one, 'failed', at, info.status))
      }
    }
    return next
  })
}

async function surfacesOf($: Engine): Promise<readonly RenderSurface[]> {
  try {
    return await $.session.surfaces()
  } catch {
    return []
  }
}

/** Re-reads whether a phone watches the session; the status line follows. */
async function learnSurfaces($: Engine, cfg: Config): Promise<void> {
  const isPhone = (await surfacesOf($)).includes('mobile')
  if ((await read($, phoneWatching)) !== isPhone) {
    await update($, phoneWatching, () => isPhone)
    await settle($, cfg)
  }
}

async function cwdOf($: Engine): Promise<string | undefined> {
  const known = await read($, cwdAtom)
  if (known.length > 0) return known
  try {
    const cwd = await $.session.cwd()
    await update($, cwdAtom, () => cwd)
    return cwd
  } catch {
    return undefined
  }
}

async function isPaneUp($: Engine): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

/** Opens the deck unasked, once, and only where it docks as a sidebar. */
async function maybeAutoOpen($: Engine, cfg: Config): Promise<void> {
  if (!cfg.autoOpen || layout.isFullscreen !== true) return
  if (layout.columns !== undefined && layout.columns < UNASKED_MIN_COLUMNS) return
  if (await read($, autoOpened)) return
  if (await isPaneUp($)) return
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (opened.isPlaced) await update($, autoOpened, () => true)
  else await $.ui.close({ id: PANE })
}

/** A card for an Agent call, made or filled from what the call says. */
async function agentStarted(
  $: Engine,
  cfg: Config,
  toolUseId: string,
  fields: { type?: string; title?: string; prompt?: string; model?: string },
): Promise<void> {
  await change($, cfg, (list, at) => {
    const existing = list.find(card => card.toolUseId === toolUseId)
    if (existing !== undefined) {
      return replaceCard(list, existing.key, card => ({
        ...card,
        type: fields.type ?? card.type,
        title: fields.title ?? card.title,
        summary: fields.prompt !== undefined ? summarizePrompt(fields.prompt) : card.summary,
        model: card.model ?? fields.model,
      }))
    }
    const card: AgentDeckCard = {
      key: toolUseId,
      toolUseId,
      status: 'running',
      type: fields.type ?? 'general-purpose',
      title: fields.title ?? 'Subagent',
      summary: fields.prompt !== undefined ? summarizePrompt(fields.prompt) : '',
      startedAt: at,
      toolCount: 0,
    }
    if (fields.model !== undefined) card.model = fields.model
    return [...list, card]
  })
  await maybeAutoOpen($, cfg)
}

/** What the Agent call answered: launched in the background, finished, or failed. */
async function agentSettled($: Engine, cfg: Config, toolUseId: string, ran: ToolCallResult): Promise<void> {
  await change($, cfg, (list, at) => {
    const card = list.find(one => one.toolUseId === toolUseId)
    if (card === undefined) return list
    if (ran.deny !== undefined) {
      return replaceCard(list, card.key, one => finish(one, 'failed', at, truncate(ran.deny, 120)))
    }
    const result: Record<string, unknown> =
      typeof ran.result === 'object' && ran.result !== null ? (ran.result as Record<string, unknown>) : {}
    const agentId = str(result, 'agentId')
    const model = str(result, 'resolvedModel')
    const status = str(result, 'status')
    const totalTools = num(result, 'totalToolUseCount')
    return replaceCard(list, card.key, one => {
      let next: AgentDeckCard = { ...one }
      if (agentId !== undefined) next.agentId = agentId
      if (model !== undefined) next.model = model
      if (totalTools !== undefined) next.toolCount = Math.max(next.toolCount, totalTools)
      if (ran.isError === true) {
        next = finish(next, 'failed', at, ran.text !== undefined ? truncate(ran.text, 120) : 'error')
      } else if (status === 'completed') {
        next = finish(next, 'done', at)
      } else if (status === 'remote_launched') {
        next = finish(next, 'done', at, 'running in the cloud')
      }
      return next
    })
  })
}

/** A subagent's own tool call started or finished. */
async function subagentTool($: Engine, cfg: Config, agentId: string, described: string, phase: 'start' | 'end'): Promise<void> {
  await change($, cfg, (list, at) => {
    const card = findByAgent(list, agentId)
    if (card === undefined) {
      if (phase === 'end') return list
      return [
        ...list,
        {
          key: `agent:${agentId}`,
          agentId,
          status: 'running',
          type: 'subagent',
          title: 'Subagent',
          summary: '',
          startedAt: at,
          toolCount: 1,
          currentTool: described,
        },
      ]
    }
    return replaceCard(list, card.key, one => {
      if (phase === 'start') {
        const woke: AgentDeckCard = { ...one, toolCount: one.toolCount + 1, currentTool: described }
        if (one.status !== 'running') {
          // A teammate woke for another turn.
          woke.status = 'running'
          delete woke.endedAt
          delete woke.note
        }
        return woke
      }
      const ended: AgentDeckCard = { ...one, lastTool: described }
      if (one.currentTool === described) delete ended.currentTool
      return ended
    })
  })
}

async function agentEnded($: Engine, cfg: Config, agentId: string, status: AgentDeckStatus, note?: string): Promise<void> {
  await change($, cfg, (list, at) => {
    const card = findByAgent(list, agentId)
    return card === undefined ? list : replaceCard(list, card.key, one => finish(one, status, at, note))
  })
}

/** `/agents [clear|open|close]`: toggles the deck, or clears finished cards. */
async function runDeck($: Engine, cfg: Config, e: CommandRunInput): Promise<CommandRunResult> {
  layout = { isFullscreen: e.presentation.isFullscreen, columns: e.presentation.columns }
  const name = e.command
  const command = parseCommand(e.args)
  if (command === 'help') {
    return {
      text: `Usage: /${name} toggles the agent deck; /${name} open, /${name} close; /${name} clear removes finished agents.`,
    }
  }
  if (command === 'clear') {
    const before = await read($, agents)
    const kept = before.filter(card => card.status === 'running')
    const removed = before.length - kept.length
    await update($, agents, list => list.filter(card => card.status === 'running'))
    await settle($, cfg)
    return { text: removed === 0 ? 'No finished agents to clear.' : `Cleared ${removed} finished agent${removed === 1 ? '' : 's'}.` }
  }
  // The phone docks no pane: asked from it (or where only phones draw),
  // the deck answers inline, as the command's output row.
  const surfaces = await surfacesOf($)
  const isPhoneOnly = surfaces.length > 0 && surfaces.every(surface => surface === 'mobile')
  const isFromPhone = isPhoneOnly || (e.origin.kind === 'bridge' && surfaces.includes('mobile'))
  if (isFromPhone && command !== 'close') {
    await quietly(() => reconcile($, cfg))
    return inline($)
  }
  const isUp = await isPaneUp($)
  if (command === 'close' || (command === 'toggle' && isUp)) {
    if (isUp) await $.ui.close({ id: PANE })
    return { text: 'Agent deck closed.' }
  }
  await quietly(() => reconcile($, cfg))
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (opened.isPlaced) return { text: 'Agent deck opened.' }
  // Open but unplaced (no attached surface places panes): it is seated when
  // one that does attaches; until then the deck answers inline.
  return inline($)
}

/** The deck as the command's output: text the model reads, cards the CommandOutput hook draws. */
async function inline($: Engine): Promise<CommandRunResult> {
  const at = await $.clock.now()
  await update($, clockNow, previous => Math.max(previous, at))
  const now = await read($, clockNow)
  return { text: inlineDeckText(await read($, agents), now) }
}

export const register: Register = (on, options: PluginOptions) => {
  const cfg: Config = {
    autoOpen: options['autoOpen'] !== false,
    statusLine: options['statusLine'] !== false,
  }

  // --- Session and commands -------------------------------------------------

  on('session.start', async ($, e, next) => {
    await quietly(async () => {
      // `/agents` is the name of a removed, hidden built-in, which
      // `$.command.register` refuses: the `command.run` hook below answers
      // it all the same. `/agent-deck` is the always-registered alias.
      await quietly(() =>
        $.command.register({
          name: 'agents',
          description: 'Toggle the agent deck pane; /agents clear removes finished agents',
          argumentHint: '[clear|open|close]',
          immediate: true,
        }),
      )
      await $.command.register({
        name: 'agent-deck',
        description: 'Toggle the agent deck pane; /agent-deck clear removes finished agents',
        argumentHint: '[clear|open|close]',
        immediate: true,
      })
    })
    await quietly(() => cwdOf($))
    await quietly(() => learnSurfaces($, cfg))
    await quietly(() => settle($, cfg))
    return next(e)
  })

  // A phone joining or leaving switches the status line's variant.
  on('session.attach', async ($, e, next) => {
    const joined = await next(e)
    await quietly(() => learnSurfaces($, cfg))
    return joined
  })
  on('session.detach', async ($, e, next) => {
    const left = await next(e)
    await quietly(() => learnSurfaces($, cfg))
    return left
  })

  on('command.describe', { command: 'agents' }, async ($, e, next) => {
    const described = await next(e)
    return {
      ...described,
      description: 'Toggle the agent deck pane; /agents clear removes finished agents',
      argumentHint: '[clear|open|close]',
      isHidden: false,
    }
  })

  on('command.run', { command: 'agents' }, ($, e) => runDeck($, cfg, e)).catch(($, e, next) =>
    next.called ? next(e) : { text: 'agent-deck: the command failed.' },
  )
  on('command.run', { command: 'agent-deck' }, ($, e) => runDeck($, cfg, e)).catch(($, e, next) =>
    next.called ? next(e) : { text: 'agent-deck: the command failed.' },
  )

  // --- Agent lifecycle ------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const parent = e.agentId
    const isAgentCall = tool === 'Agent' || tool === 'Task'
    let described: string | undefined
    if (parent !== undefined) {
      await quietly(async () => {
        described = describeTool(tool, input, await cwdOf($))
        await subagentTool($, cfg, parent, described, 'start')
      })
    }
    if (isAgentCall) {
      const fields: { type?: string; title?: string; prompt?: string; model?: string } = {}
      const type = str(input, 'subagent_type')
      const title = str(input, 'description')
      const prompt = str(input, 'prompt')
      const model = str(input, 'model')
      if (type !== undefined) fields.type = type
      if (title !== undefined) fields.title = title
      if (prompt !== undefined) fields.prompt = prompt
      if (model !== undefined) fields.model = model
      await quietly(() => agentStarted($, cfg, e.tool_use_id, fields))
    }
    const ran = await next(e)
    if (isAgentCall) await quietly(() => agentSettled($, cfg, e.tool_use_id, ran))
    if (parent !== undefined && described !== undefined) {
      const done = described
      await quietly(() => subagentTool($, cfg, parent, done, 'end'))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e: AgentSpawnInput, next) => {
    const fields: { type?: string; title?: string; prompt?: string; model?: string } = {
      type: e.subagentType,
      prompt: e.prompt,
    }
    if (e.description.length > 0) fields.title = e.description
    const model = e.model ?? (e.fork ? e.parentModel : undefined)
    if (model !== undefined) fields.model = model
    await quietly(() => agentStarted($, cfg, e.tool_use_id, fields))
    const ran = await next(e)
    await quietly(() =>
      change($, cfg, (list, at) => {
        const card = list.find(one => one.toolUseId === e.tool_use_id)
        if (card === undefined) return list
        if (ran.deny !== undefined) {
          return replaceCard(list, card.key, one => finish(one, 'failed', at, truncate(ran.deny, 120)))
        }
        return replaceCard(list, card.key, one => {
          const linked: AgentDeckCard = { ...one, model: ran.model }
          if (ran.agentId !== undefined) linked.agentId = ran.agentId
          return linked
        })
      }),
    )
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const status: AgentDeckStatus = e.reason === 'answer' ? 'done' : 'failed'
      const note = e.reason === 'answer' ? undefined : e.reason === 'aborted' ? 'stopped' : e.reason
      await quietly(() => agentEnded($, cfg, agentId, status, note))
    }
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await quietly(() => agentEnded($, cfg, e.agent_id, 'done'))
    return next(e)
  }).catch(($, e, next) => next(e))

  // --- Drawing --------------------------------------------------------------

  // Passive: learns whether the surface docks panes, so the deck opens by
  // itself only where it is a sidebar. The spinner draws while a turn runs,
  // which is when subagents spawn.
  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    learnLayout(e.viewport)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    learnLayout(e.viewport)
    const { Box, Text } = $.ui.resolve(e)
    const list = orderCards(await read($, agents))
    const now = await read($, clockNow)
    const width = Math.max(16, e.props.bodyColumns)
    const isDesktop = e.surface === 'desktop'
    const inner = isDesktop ? width - 4 : width - 2
    const viewing = e.props.view.agentId

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>{truncate(headerText(list), Math.max(4, width - 8))}</Text>
        <Text dimColor>{list.length > 0 ? `${list.length}` : ''}</Text>
      </Box>
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text dimColor wrap="wrap">
            Cards appear here when Claude spawns a subagent.
          </Text>
        </Box>
      )
    }

    const cards = list.map(card => {
      const isRunning = card.status === 'running'
      const isFailed = card.status === 'failed'
      const color = isRunning ? 'claude' : isFailed ? 'error' : 'success'
      const glyph = isRunning ? '●' : isFailed ? '✗' : '✓'
      const elapsed = formatElapsed(elapsedOf(card, now))
      const titleRoom = Math.max(4, inner - elapsed.length - 3)
      const model = shortModel(card.model)
      const meta = [card.type, model].filter((part): part is string => part !== undefined && part.length > 0).join(' · ')
      const tool = card.currentTool ?? card.lastTool
      const toolLine =
        `${card.toolCount} tool${card.toolCount === 1 ? '' : 's'}` +
        (tool === undefined ? '' : card.currentTool !== undefined && isRunning ? ` · ▸ ${tool}` : ` · last ${tool}`)
      const isViewed = viewing !== undefined && card.agentId === viewing
      const body = (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate">
              <Text color={color}>{glyph}</Text> <Text bold={!isFailed} dimColor={!isRunning}>
                {truncate(card.title, titleRoom)}
              </Text>
            </Text>
            <Text dimColor={!isRunning} color={isRunning ? 'claude' : undefined}>
              {elapsed}
            </Text>
          </Box>
          <Text dimColor wrap="truncate">
            {'  '}
            {truncate(meta + (isViewed ? ' · in view' : ''), inner)}
          </Text>
          {card.summary.length > 0 && (
            <Text dimColor={!isRunning} wrap="truncate">
              {'  '}
              {truncate(card.summary, inner)}
            </Text>
          )}
          <Text dimColor wrap="truncate">
            {'  '}
            {truncate(toolLine, inner)}
          </Text>
          {card.note !== undefined && (
            <Text color={isFailed ? 'error' : undefined} dimColor={!isFailed} wrap="truncate">
              {'  '}
              {truncate(card.note, inner)}
            </Text>
          )}
        </Box>
      )
      return isDesktop ? (
        <Box
          key={`card:${card.key}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={isViewed ? 'suggestion' : color}
          borderDimColor={!isRunning}
          paddingX={1}
        >
          {body}
        </Box>
      ) : (
        <Box key={`card:${card.key}`} flexDirection="column">
          {body}
        </Box>
      )
    })

    const hasFinished = list.some(card => card.status !== 'running')
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {cards}
        {hasFinished && <Text dimColor>/agents clear removes finished agents</Text>}
      </Box>
    )
  })

  // The inline deck: `/agents` answered as its output row (a phone, or no
  // surface that places panes). It reads the cards from `$.state`, which
  // subscribes the row, so it redraws live as agents change, ticking with
  // the clock while any run; the stamp says when it last changed.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const command = e.props.command
    const isOurs = command === 'agents' || command === 'agent-deck'
    if (!isOurs || e.props.isErrored || !e.props.text.startsWith(INLINE_HEAD)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const list = orderCards(await read($, agents))
    const now = await read($, clockNow)
    const width = Math.max(20, Math.min(e.viewport?.columns ?? 40, 72))
    const stamp = `as of ${formatClock(now)}`

    const header = (
      <Box flexDirection="column">
        <Text bold wrap="truncate">
          {truncate(`Agents · ${headerText(list)}`, width)}
        </Text>
        <Text dimColor wrap="truncate">
          {stamp}
        </Text>
      </Box>
    )
    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor wrap="wrap">
            Cards appear here when Claude spawns a subagent.
          </Text>
        </Box>
      )
    }
    const inner = width - 2
    const cards = list.map(card => {
      const isRunning = card.status === 'running'
      const isFailed = card.status === 'failed'
      const color = isRunning ? 'claude' : isFailed ? 'error' : 'success'
      const elapsed = formatElapsed(elapsedOf(card, now))
      const titleRoom = Math.max(4, width - elapsed.length - 3)
      const tool = toolLine(card)
      return (
        <Box key={`inline:${card.key}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate">
              <Text color={color}>{statusGlyph(card.status)}</Text> <Text bold={!isFailed} dimColor={!isRunning}>
                {truncate(card.title, titleRoom)}
              </Text>
            </Text>
            <Text dimColor={!isRunning}>{elapsed}</Text>
          </Box>
          <Text dimColor wrap="truncate">
            {'  '}
            {truncate(metaLine(card), inner)}
          </Text>
          {tool !== undefined && (
            <Text dimColor wrap="truncate">
              {'  '}
              {truncate(tool, inner)}
            </Text>
          )}
          {card.note !== undefined && (
            <Text color={isFailed ? 'error' : undefined} dimColor={!isFailed} wrap="truncate">
              {'  '}
              {truncate(card.note, inner)}
            </Text>
          )}
        </Box>
      )
    })
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {cards}
      </Box>
    )
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderNode } from 'claude-code'

import {
  WARNING,
  barCells,
  cardText,
  formatTokens,
  headlineRuns,
  labelCells,
  legendItems,
  packLegend,
  parseCommand,
  richStatusText,
  shareOf,
  shouldWarn,
  statusText,
  toRuns,
  toSnapshot,
  topCategories,
} from './lib'
import type { Run } from './lib'

const COMMAND = 'context-bar'
const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'context-bar', key: 'isHidden' } as const, false)
const hasWarned = atom({ plugin: 'context-bar', key: 'hasWarned' } as const, false)

/** A Text's style props from a run, leaving out the ones it does not set. */
function style(run: Run): { color?: string; bold?: boolean; dimColor?: boolean } {
  return {
    ...(run.color !== undefined && { color: run.color }),
    ...(run.bold && { bold: true }),
    ...(run.dim && { dimColor: true }),
  }
}

/**
 * Whether a tree from beneath draws nothing: absent, empty strings and empty
 * Boxes or Texts, or the engine's own band while no survey holds it (the
 * band draws only when none does).
 */
function drawsNothing(node: RenderNode | undefined): boolean {
  if (node === undefined) return true
  if (typeof node === 'string') return node === ''
  if (node.type === 'engine') return true
  if (node.type === 'Box' || node.type === 'Text') return (node.children ?? []).every(drawsNothing)

  return false
}

type Settings = { warnAtHalf: boolean; statusMode: string }

/** Surfaces that never raise the band: mobile, VS Code. */
function isBandless(surface: string): boolean {
  return surface !== 'terminal' && surface !== 'desktop'
}

/**
 * Pins the status entry when the band cannot be seen: hidden, or a surface
 * without it attached (mobile), where it reads `🟡 ctx 71% · passive`.
 */
async function syncStatus($: EngineInterface, settings: Settings): Promise<void> {
  if (settings.statusMode === 'off') return $.ui.status(undefined)
  const bandless = (await $.session.surfaces()).some(isBandless)
  const show = settings.statusMode === 'always' || bandless || (await read($, isHidden))
  const s = await read($, snapshot)
  $.ui.status(show ? (bandless ? richStatusText(s) : statusText(s)) : undefined)
}

/** Re-measures the window (the free, local `summary` breakdown) and warns once past 50%. */
async function refresh($: EngineInterface, settings: Settings): Promise<void> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const measured = toSnapshot(context)
    await update($, snapshot, () => measured)

    let fire = false
    await update($, hasWarned, warned => {
      fire = settings.warnAtHalf && shouldWarn(measured.percent, warned)
      return warned || fire
    })
    if (fire) $.ui.toast(WARNING, { timeoutMs: 8000 })

    await syncStatus($, settings)
  } catch {
    // A failed measurement leaves the last drawing in place.
  }
}

/** A fresh conversation: forget the old figures and re-arm the warning. */
async function rearm($: EngineInterface): Promise<void> {
  await update($, snapshot, () => null)
  await update($, hasWarned, () => false)
}

export const register: Register = (on, options) => {
  const showLegend = options.legend !== false
  const settings: Settings = {
    warnAtHalf: options.warnAtHalf !== false,
    statusMode: typeof options.statusLine === 'string' ? options.statusLine : 'auto',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show a context window card; on|off shows or hides the bar above the prompt',
      argumentHint: '[show|on|off|toggle]',
    })
    await refresh($, settings)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) await refresh($, settings)

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const isMainCompaction = e.agentId === undefined && e.trigger !== 'precompute'
    if (isMainCompaction && result.skip === undefined) {
      await update($, hasWarned, () => false)
      await refresh($, settings)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await rearm($)

    return next(e)
  })

  // A phone (or another bandless surface) joining or leaving moves the status entry.
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    await syncStatus($, settings).catch(() => undefined)

    return result
  })

  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'detach') await syncStatus($, settings).catch(() => undefined)

    return result
  })

  // A /clear raises no session.start; the settings hook event carries it instead.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear') {
      await rearm($)
      await refresh($, settings)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const action = parseCommand(e.args)
    if (action === 'show') {
      await refresh($, settings)

      return { text: cardText(await read($, snapshot)) }
    }
    if (action === 'unknown') return { text: 'Usage: /context-bar [show|on|off|toggle]' }

    const hidden = await update($, isHidden, was => (action === 'on' ? false : action === 'off' ? true : !was))
    await syncStatus($, settings)

    return { text: hidden ? 'Context bar hidden.' : 'Context bar shown.' }
  })

  // `/context-bar` (or `show`) draws a compact card in its output row, on every surface.
  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND } }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.isErrored || parseCommand(e.props.args) !== 'show' || s === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.min(100, Math.max(16, (e.viewport?.columns ?? 60) - 2))
    const row = (runs: Run[]) => (
      <Box flexDirection="row">
        {runs.map(run => (
          <Text wrap="truncate-end" {...style(run)}>
            {run.text}
          </Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Text color="claude" bold>
            ◆ context{'  '}
          </Text>
          {headlineRuns(s).map(run => (
            <Text {...style(run)}>{run.text}</Text>
          ))}
        </Box>
        {row(toRuns(barCells(s, width)))}
        {width >= 24 && row(toRuns(labelCells(s, width)))}
        {topCategories(s, 4).map(seg => (
          <Text wrap="truncate-end">
            <Text color={seg.color}>■</Text>
            <Text> {seg.name} </Text>
            <Text bold>{formatTokens(seg.tokens)}</Text>
            <Text dimColor> · {shareOf(s, seg.tokens)}%</Text>
          </Text>
        ))}
        {s.segments.length > 0 && <Text dimColor>Category split is estimated.</Text>}
      </Box>
    )
  })

  // The band is one instance for every plugin: draw ours, then stack what is beneath under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hidden = await read($, isHidden)
    const s = await read($, snapshot)
    const below = await next(e)
    if (e.props.hasSurvey || hidden || s === null) return below

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(1, e.props.bodyColumns)
    const head = headlineRuns(s).map(run => <Text {...style(run)}>{run.text}</Text>)

    const stack = (mine: RenderElement): RenderElement =>
      drawsNothing(below) ? mine : (
        <Box flexDirection="column">
          {mine}
          {below}
        </Box>
      )

    if (width < 24) {
      return stack(
        <Box flexDirection="row">
          <Text color="claude" bold>
            ctx{' '}
          </Text>
          {head}
        </Box>,
      )
    }

    const row = (runs: Run[]) => (
      <Box flexDirection="row">
        {runs.map(run => (
          <Text wrap="truncate-end" {...style(run)}>
            {run.text}
          </Text>
        ))}
      </Box>
    )
    const legendRoom = Math.max(0, e.props.maxRows - 3)
    const legend = showLegend ? packLegend(legendItems(s), width).slice(0, legendRoom) : []

    return stack(
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text color="claude" bold>
              ◆ context{'  '}
            </Text>
            {head}
          </Box>
          {s.segments.length > 0 && width >= 64 && <Text dimColor>split estimated</Text>}
        </Box>
        {row(toRuns(barCells(s, width)))}
        {e.props.maxRows >= 3 && row(toRuns(labelCells(s, width)))}
        {legend.map(line => (
          <Box flexDirection="row" columnGap={2}>
            {line.map(item => (
              <Text>
                <Text color={item.color}>{item.glyph}</Text>
                <Text dimColor> {item.label}</Text>
              </Text>
            ))}
          </Box>
        ))}
      </Box>,
    )
  })
}

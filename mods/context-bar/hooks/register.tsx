import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  WARNING,
  barCells,
  headlineRuns,
  labelCells,
  legendItems,
  packLegend,
  shouldWarn,
  statusText,
  toRuns,
  toSnapshot,
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

type Settings = { warnAtHalf: boolean; statusMode: string }

/** Pins `ctx 71%` when the band cannot be seen: hidden, or on a surface without it. */
async function syncStatus($: EngineInterface, settings: Settings): Promise<void> {
  let show = settings.statusMode === 'always'
  if (settings.statusMode === 'auto') {
    const surfaces = await $.session.surfaces()
    show = (await read($, isHidden)) || surfaces.some(s => s !== 'terminal' && s !== 'desktop')
  }
  $.ui.status(show ? statusText(await read($, snapshot)) : undefined)
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
      description: 'Toggle the context window bar above the prompt',
      argumentHint: '[on|off]',
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
    const arg = e.args.trim().toLowerCase()
    const hidden = await update($, isHidden, was => (arg === 'on' ? false : arg === 'off' ? true : !was))
    await syncStatus($, settings)

    return { text: hidden ? 'Context bar hidden.' : 'Context bar shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hidden = await read($, isHidden)
    const s = await read($, snapshot)
    if (e.props.hasSurvey || hidden || s === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(1, e.props.bodyColumns)
    const head = headlineRuns(s).map(run => <Text {...style(run)}>{run.text}</Text>)

    if (width < 24) {
      return (
        <Box flexDirection="row">
          <Text color="claude" bold>
            ctx{' '}
          </Text>
          {head}
        </Box>
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

    return (
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
      </Box>
    )
  })
}

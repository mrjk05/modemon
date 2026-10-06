import type { EngineInterface, Register } from 'claude-code'

import type { CasualPrefs } from '../types'
import {
  STATUS_TEXT,
  STORE_KEY,
  USAGE,
  applyAction,
  callLine,
  describePrefs,
  effectiveVerbosity,
  errorText,
  groupErrors,
  groupLine,
  parseArgs,
  shouldFold,
  stylePrompt,
  toPrefs,
  withSection,
} from './lib'

const prefsRef = { plugin: 'casual', key: 'prefs' } as const

/**
 * The person's prefs: the session's value once set, else what `/casual` last
 * stored, else on. Read while drawing, it subscribes the row to changes.
 */
async function loadPrefs($: EngineInterface): Promise<CasualPrefs> {
  const held = await $.state.get(prefsRef)
  if (held.version > 0 && held.value !== undefined) return held.value
  return toPrefs(await $.store.get(STORE_KEY))
}

/** Keeps the prefs for this session and the next ones, and shows the badge. */
async function savePrefs($: EngineInterface, prefs: CasualPrefs): Promise<void> {
  await $.state.set(prefsRef, prefs)
  await $.store.set(STORE_KEY, prefs)
  $.ui.status(prefs.isOn ? STATUS_TEXT : undefined)
}

/** True where a row asks to be drawn in full (ctrl+o, --verbose), whatever the component. */
function isExpanded(props: object): boolean {
  return (props as { isExpanded?: unknown }).isExpanded === true
}

export const register: Register = (on, options) => {
  const collapse = options.collapseTools !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'casual',
      description: 'Short, conversational replies: on, off, brief, chill or status.',
      argumentHint: 'on|off|brief|chill|status',
      immediate: true,
    })
    const prefs = await loadPrefs($)
    await $.state.set(prefsRef, prefs)
    $.ui.status(prefs.isOn ? STATUS_TEXT : undefined)
    return next(e)
  })

  on('command.run', { command: 'casual' }, async ($, e) => {
    const action = parseArgs(e.args)
    if (action.kind === 'usage') return { text: `Unknown option \`${action.arg}\`. ${USAGE}` }
    const before = await loadPrefs($)
    const after = applyAction(before, action)
    if (action.kind !== 'status') await savePrefs($, after)
    return { text: describePrefs(after, effectiveVerbosity(after, options.verbosity), collapse) }
  })

  // The style itself: one section after the engine's own, while casual is on.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('teammate')) return composed
    const prefs = await loadPrefs($)
    if (!prefs.isOn) return composed
    const text = stylePrompt(effectiveVerbosity(prefs, options.verbosity))
    return { sections: withSection(composed.sections, text) }
  })

  if (!collapse) return

  // A finished tool call's row: one dim line, red when it failed. A running
  // call (it may be waiting on a permission dialog) is drawn as the engine does.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    if (isExpanded(p) || p.isRunning || !shouldFold(p.tool)) return next(e)
    if (!(await loadPrefs($)).isOn) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const line = callLine(p)
    return (
      <Box>
        {p.isErrored && !p.isInterrupted ? (
          <Text color="error" wrap="truncate-end">
            ✗ {line}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            · {line}
          </Text>
        )}
      </Box>
    )
  })

  // The result under a standalone row: the row's one-liner already says how
  // it went, so a success draws nothing and an error keeps one red line.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const p = e.props
    if (isExpanded(p) || !shouldFold(p.tool)) return next(e)
    if (!(await loadPrefs($)).isOn) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (p.isErrored) {
      return (
        <Box paddingLeft={2}>
          <Text color="error" wrap="truncate-end">
            ⎿ {errorText(p.output)}
          </Text>
        </Box>
      )
    }
    return <Box display="none" />
  })

  // A folded run of reads and searches: `· ran 4 tools (Read ×2, Grep, Edit)`.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const p = e.props
    if (p.isExpanded || p.calls.length === 0) return next(e)
    if (p.calls.some(c => !shouldFold(c.tool))) return next(e)
    if (!(await loadPrefs($)).isOn) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const failed = groupErrors(p.calls)
    return (
      <Box flexDirection="row">
        <Text dimColor wrap="truncate-end">
          · {groupLine(p.calls)}
        </Text>
        {failed === undefined ? null : (
          <Text color="error" wrap="truncate-end">
            {' '}· {failed}
          </Text>
        )}
      </Box>
    )
  })
}

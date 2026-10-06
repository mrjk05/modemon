import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement, RenderInputOf, RenderSurface } from 'claude-code'

import type { ProjectColorProject } from '../types'
import {
  basename,
  branchFromHead,
  commandText,
  gitdirFromFile,
  packPalette,
  parseArg,
  parseSummary,
  resolveSwatch,
  statusText,
  stripeParts,
  textOn,
} from './lib'

const project = atom({ plugin: 'project-color', key: 'project' } as const, null)

/** A `CommandOutput` row's render input, on any surface. */
type OutputInput = { [S in RenderSurface]: RenderInputOf<'CommandOutput', S> }[RenderSurface]

type Config = { stripe: boolean; statusLine: boolean; branch: boolean; thickness: number }

/** Where an override is kept: one per repository root. */
const storeKey = (root: string) => `override:${root}`

/** Runs `work`, swallowing a refusal: a missing piece never stops the mod. */
async function quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

/** The checked-out branch, read from `.git/HEAD` (a worktree's `.git` file followed); null when not cheap to know. */
async function readBranch($: EngineInterface, root: string): Promise<string | null> {
  const dir = root.replace(/[\\/]+$/, '')
  const head = await quietly(() => $.fs.read(`${dir}/.git/HEAD`))
  if (head !== undefined) return branchFromHead(head)
  const file = await quietly(() => $.fs.read(`${dir}/.git`))
  const gitdir = file === undefined ? null : gitdirFromFile(file, dir)
  if (gitdir === null) return null
  const linked = await quietly(() => $.fs.read(`${gitdir}/HEAD`))
  return linked === undefined ? null : branchFromHead(linked)
}

/** Who this session's project is: the repo root's basename, else the session root's, else the cwd's. */
async function identify($: EngineInterface, cwd: string, cfg: Config): Promise<ProjectColorProject> {
  const repo = await quietly(() => $.session.repo())
  const sessionRoot = await quietly(() => $.session.root())
  const root = repo?.root ?? sessionRoot ?? cwd
  const stored = await quietly(() => $.store.get(storeKey(root)))
  const override = typeof stored === 'string' ? stored : null
  // The session root is the working tree a worktree session is in; the repo root is the main one.
  const branch = cfg.branch ? await readBranch($, sessionRoot ?? root) : null
  return { name: basename(root), root, branch, override }
}

/** Pins `🟣 modemon` under the prompt, on every surface (it is the phone's only sign of the colour). */
function syncStatus($: EngineInterface, p: ProjectColorProject | null, cfg: Config): void {
  if (!cfg.statusLine || p === null) return
  $.ui.status(statusText(p.name, resolveSwatch(p.name, p.override)))
}

/** `/color [name|#hex|auto]`: shows, pins or resets the colour, answering the row `drawOutput` draws. */
async function runColor($: EngineInterface, args: string, cfg: Config): Promise<{ text: string }> {
  let p = await read($, project)
  if (p === null) {
    p = await identify($, await $.session.cwd(), cfg)
    await update($, project, () => p)
  }
  const arg = parseArg(args)
  if (arg.kind === 'error') return { text: arg.message }

  let note: string | undefined
  if (arg.kind === 'auto') {
    await $.store.delete(storeKey(p.root))
    p = { ...p, override: null }
    note = 'Back to the automatic colour.'
  } else if (arg.kind === 'set') {
    await $.store.set(storeKey(p.root), arg.override)
    p = { ...p, override: arg.override }
    note = `Pinned for ${p.root}.`
  }
  if (arg.kind !== 'show') {
    const next = p
    await update($, project, () => next)
    syncStatus($, next, cfg)
  }
  return { text: commandText(p.name, resolveSwatch(p.name, p.override), p.override, note) }
}

// The command's row drawn as a tree: the current colour, then the palette as swatches.
async function drawOutput($: EngineInterface, e: OutputInput): Promise<RenderElement | null> {
  const summary = parseSummary(e.props.text)
  if (e.props.isErrored || summary === null) return null

  const { Box, Text } = $.ui.resolve(e)
  const width = Math.max(16, e.viewport?.columns ?? 60)
  const fg = textOn(summary.hex)
  const rows = packPalette(width)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text backgroundColor={summary.hex} color={fg} bold wrap="truncate-end">
          {` ▌ ${summary.project} `}
        </Text>
        <Text bold> {summary.name}</Text>
        <Text dimColor>
          {' '}
          {summary.hex} · {summary.source}
        </Text>
      </Box>
      {rows.map(row => (
        <Box flexDirection="row" columnGap={2}>
          {row.map(s => {
            const isCurrent = s.name === summary.name
            return (
              <Text>
                <Text backgroundColor={s.hex} color={s.fg}>
                  {isCurrent ? ' ● ' : '   '}
                </Text>
                <Text bold={isCurrent} dimColor={!isCurrent}>
                  {' '}
                  {s.name}
                </Text>
              </Text>
            )
          })}
        </Box>
      ))}
      <Text dimColor wrap="truncate-end">
        /color &lt;name|#hex&gt; pins · /color auto resets
      </Text>
    </Box>
  )
}

export const register: Register = (on, options: PluginOptions) => {
  const cfg: Config = {
    stripe: options['stripe'] !== false,
    statusLine: options['statusLine'] !== false,
    branch: options['branch'] !== false,
    thickness: options['thickness'] === '2' ? 2 : 1,
  }

  on('session.start', async ($, e, next) => {
    // `/color` is the short name; `/project-color` always registers, in case a build owns `/color`.
    await quietly(() =>
      $.command.register({
        name: 'color',
        description: "Show or pin this project's colour (stripe above the prompt)",
        argumentHint: '[name|#hex|auto]',
        immediate: true,
      }),
    )
    await quietly(() =>
      $.command.register({
        name: 'project-color',
        description: "Show or pin this project's colour (same as /color)",
        argumentHint: '[name|#hex|auto]',
        immediate: true,
      }),
    )
    const p = await quietly(() => identify($, e.cwd, cfg))
    if (p !== undefined) {
      await update($, project, () => p)
      syncStatus($, p, cfg)
    }
    return next(e)
  })

  // The branch can move during a session; one small read per turn keeps the hint honest.
  on('turn.complete', async ($, e, next) => {
    if (cfg.branch && cfg.stripe) {
      await quietly(async () => {
        const p = await read($, project)
        if (p === null) return
        const branch = await readBranch($, (await quietly(() => $.session.root())) ?? p.root)
        if (branch !== p.branch) await update($, project, was => (was === null ? was : { ...was, branch }))
      })
    }
    return next(e)
  })

  on('command.run', { command: 'color' }, ($, e) => runColor($, e.args, cfg))
  on('command.run', { command: 'project-color' }, ($, e) => runColor($, e.args, cfg))
  on('ui.render', { component: 'CommandOutput', props: { command: 'color' } }, async ($, e, next) => {
    return (await drawOutput($, e)) ?? next(e)
  })
  on('ui.render', { component: 'CommandOutput', props: { command: 'project-color' } }, async ($, e, next) => {
    return (await drawOutput($, e)) ?? next(e)
  })

  // The stripe: drawn on top, then whatever the other band mods draw beneath it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !cfg.stripe) return next(e)
    const p = await read($, project)
    if (p === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const swatch = resolveSwatch(p.name, p.override)
    const width = Math.max(1, e.props.bodyColumns)
    const parts = stripeParts(p.name, p.branch, width)
    const rows = cfg.thickness === 2 && e.props.maxRows >= 3 ? 2 : 1
    const paint = { backgroundColor: swatch.hex, color: swatch.fg }

    const stripe = (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" width={width}>
          <Text {...paint} bold wrap="truncate-end">
            {parts.left}
          </Text>
          <Text {...paint}>{parts.fill}</Text>
          {parts.right !== '' && (
            <Text {...paint} dimColor>
              {parts.right}
            </Text>
          )}
        </Box>
        {rows === 2 && <Text {...paint}>{' '.repeat(width)}</Text>}
      </Box>
    )

    const below: RenderElement | null | undefined = await next(e)
    if (below === null || below === undefined || below.type === 'engine') return stripe
    return (
      <Box flexDirection="column">
        {stripe}
        {below}
      </Box>
    )
  })
}

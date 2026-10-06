import { atom, memberOf, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { Decision, DecisionEntry, DecisionStatus } from '../types'
import {
  clip,
  dirSegments,
  INDEX_MARKER,
  isDecisionFile,
  isSafeName,
  parseDecision,
  fileName,
  formatList,
  formatRecord,
  formatSearch,
  guideText,
  INDEX_FILE,
  isoDate,
  newestFirst,
  nextId,
  oneLine,
  parseDecide,
  parseDecisionsArgs,
  parseToolInput,
  recordMarkdown,
  renderIndex,
  search,
  serializeDecision,
  supersededNote,
  type SearchHit,
} from './lib'

const TOOL = 'mcp__decision-log__decision'
const PANE = 'decisions'
/** First line of `/decisions` when the pane cannot be placed; the CommandOutput hook draws the card for it. */
const WAITING_HEAD = 'The decisions pane has no room here, so here is the log:'

/** The elements every surface has, mobile included: the only ones the trees use. */
type Ui = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Markdown'>
type Dollar = EngineInterface

const records = atom({ plugin: 'decision-log', key: 'records' } as const, [])
const selected = atom({ plugin: 'decision-log', key: 'selected' } as const, 0)

const TOOL_DESCRIPTION = [
  "The repository's decision log: architecture decision records (ADRs) kept as markdown files in the repo.",
  'Record genuine decisions (architecture, dependencies, data model, API shape, trade-offs the user agreed to) with the why and the alternatives; not trivial edits.',
  'Actions: "record" {title, context, decision, alternatives[], consequences, tags[], files[], status (default accepted), supersedes?};',
  '"list" {status?, tag?}; "search" {query} (ranked, with snippets); "get" {id}; "supersede" {id, by} (old #id is superseded by #by, linked both ways);',
  '"set-status" {id, status}. Do not rewrite accepted records: record a new one and supersede. Results are compact text with the file path.',
].join(' ')

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['record', 'list', 'search', 'get', 'supersede', 'set-status'], description: 'What to do.' },
    title: { type: 'string', description: 'record: a short imperative title, e.g. "Use SQLite for the local cache".' },
    context: { type: 'string', description: 'record: the situation and forces that called for a decision (markdown).' },
    decision: { type: 'string', description: 'record: what was decided and why (markdown).' },
    alternatives: { type: 'array', items: { type: 'string' }, description: 'record: options considered and why each was not chosen.' },
    consequences: { type: 'string', description: 'record: what follows, good and bad (markdown).' },
    tags: { type: 'array', items: { type: 'string' }, description: 'record: short lowercase tags.' },
    files: { type: 'array', items: { type: 'string' }, description: 'record: repo paths the decision mainly concerns.' },
    deciders: { type: 'array', items: { type: 'string' }, description: 'record: who decided (default user, claude).' },
    status: {
      type: 'string',
      enum: ['proposed', 'accepted', 'superseded', 'rejected'],
      description: 'record: proposed, accepted (default) or rejected. set-status: the new status. list: filter.',
    },
    supersedes: { type: 'integer', description: 'record: the number of an earlier record this one replaces.' },
    tag: { type: 'string', description: 'list: only records with this tag.' },
    query: { type: 'string', description: 'search: words to look for in titles, tags and bodies.' },
    id: { type: 'integer', description: 'get, supersede, set-status: the record number (#7 -> 7).' },
    by: { type: 'integer', description: 'supersede: the number of the newer record that replaces #id.' },
  },
  required: ['action'],
  additionalProperties: false,
} as const

// ---------------------------------------------------------------------------------------------------------------
// Where the decisions folder is, reading every record, and writes that stay inside the resolved folder.
/** A refusal with a message meant for the person or the model. */
class PlaceError extends Error {}

type Place = {
  /** The repository root, every link resolved, no trailing separator. */
  rootReal: string
  /** The decisions folder, resolved the same way (its missing tail appended to the deepest folder that exists). */
  dirReal: string
  /** The separator the resolved paths use. */
  sep: string
  /** The folder relative to the root, `/`-separated, for messages and `path`s. */
  dirPath: string
  /** Whether the folder exists yet. */
  exists: boolean
}

const statOf = ($: Dollar, path: string) => $.fs.stat(path, { resolve: true }).catch(() => undefined)

/** The repository root: the git root that holds the session's project root, else the project root itself. */
async function repoRoot($: Dollar): Promise<string> {
  const root = await $.session.root()
  let repoRootPath: string | undefined
  try {
    repoRootPath = (await $.session.repo())?.root
  } catch {
    repoRootPath = undefined
  }
  if (repoRootPath !== undefined) {
    const base = repoRootPath.replace(/[\\/]+$/, '')
    // A worktree's project root lies outside the main tree's root: the worktree is where its files go.
    if (root === base || root.startsWith(`${base}/`) || root.startsWith(`${base}\\`)) return base
  }
  return root
}

function isInside(child: string, parent: string, sep: string): boolean {
  return child.startsWith(parent + sep) && !child.slice(parent.length + 1).split(sep).includes('..')
}

/** Resolves the decisions folder under the real repository root, refusing anything that lands outside it. */
async function resolvePlace($: Dollar, dirOption: string): Promise<Place> {
  const parsed = dirSegments(dirOption)
  if ('error' in parsed) throw new PlaceError(`decision-log: ${parsed.error}.`)
  const { segments } = parsed
  const root = await repoRoot($)
  const rootStat = await statOf($, root)
  if (rootStat?.realPath === undefined || rootStat.kind !== 'dir') throw new PlaceError(`decision-log: cannot resolve the repository root ${root}.`)
  const sep = rootStat.realPath.includes('/') || !rootStat.realPath.includes('\\') ? '/' : '\\'
  const rootReal = rootStat.realPath.length > 1 ? rootStat.realPath.replace(/[\\/]+$/, '') : rootStat.realPath
  const base = rootReal === sep ? '' : rootReal

  for (let i = segments.length; i >= 0; i--) {
    const spelled = [base, ...segments.slice(0, i)].join(sep) || sep
    const found = await statOf($, spelled)
    if (found === undefined) continue
    if (found.realPath === undefined) throw new PlaceError(`decision-log: cannot resolve ${spelled}.`)
    if (found.kind !== 'dir') throw new PlaceError(`decision-log: ${spelled} is not a folder.`)
    const prefix = found.realPath.length > 1 ? found.realPath.replace(/[\\/]+$/, '') : ''
    const dirReal = [prefix, ...segments.slice(i)].join(sep)
    if (!isInside(dirReal, base, sep)) {
      throw new PlaceError(`decision-log: the decisions folder "${dirOption}" resolves to ${dirReal}, outside the repository ${rootReal}; nothing was written.`)
    }
    return { rootReal, dirReal, sep, dirPath: segments.join('/'), exists: i === segments.length }
  }
  throw new PlaceError(`decision-log: cannot resolve the repository root ${root}.`)
}

/** Every record in the folder, oldest first. A file that cannot be read is skipped. */
async function loadAll($: Dollar, place: Place): Promise<{ entries: DecisionEntry[]; names: string[] }> {
  if (!place.exists) return { entries: [], names: [] }
  const listing = await $.fs.list(place.dirReal).catch(() => [])
  // Every NNNN-*.md name counts for numbering; only plain files are read (a link is never followed).
  const names = listing.filter(e => isDecisionFile(e.name)).map(e => e.name)
  const files = listing.filter(e => e.kind === 'file' && !e.isLink && isDecisionFile(e.name)).map(e => e.name)
  const entries: DecisionEntry[] = []
  for (const name of files.sort()) {
    try {
      const text = await $.fs.read(`${place.dirReal}${place.sep}${name}`)
      const d = parseDecision(text, name)
      if (d.id > 0) entries.push({ ...d, file: name, path: `${place.dirPath}/${name}` })
    } catch {
      // unreadable: left out
    }
  }
  entries.sort((a, b) => a.id - b.id || a.file.localeCompare(b.file))
  return { entries, names }
}

/**
 * What a write may replace: `new` (nothing may be there), a record id (the file there must hold that id), or the
 * `index` (only a file this plugin generated).
 */
type WriteGuard = { kind: 'new' } | { kind: 'record'; id: number } | { kind: 'index' }

/**
 * Writes `text` to `name` inside the decisions folder. The target is resolved again first: it must land at
 * exactly `<dirReal>/<name>` (no link out), and the guard decides whether an existing file may be replaced.
 * Answers false for an index it declined to overwrite.
 */
async function safeWrite($: Dollar, place: Place, name: string, text: string, guard: WriteGuard): Promise<boolean> {
  if (!isSafeName(name)) throw new PlaceError(`decision-log: refusing the file name "${name}".`)
  const target = `${place.dirReal}${place.sep}${name}`
  const folder = await statOf($, place.dirReal)
  if (folder !== undefined && (folder.realPath !== place.dirReal || folder.kind !== 'dir')) {
    throw new PlaceError(`decision-log: ${place.dirPath} moved or is a link out of the repository; nothing was written.`)
  }
  const existing = await statOf($, target)
  if (existing !== undefined) {
    if (existing.kind !== 'file' || existing.isLink || existing.realPath !== target) {
      throw new PlaceError(`decision-log: ${place.dirPath}/${name} is not a plain file inside the folder; nothing was written.`)
    }
    const current = await $.fs.read(target)
    if (guard.kind === 'new') {
      throw new PlaceError(`decision-log: ${place.dirPath}/${name} already exists; refusing to overwrite it.`)
    }
    if (guard.kind === 'index') {
      if (!current.includes(INDEX_MARKER)) return false
    } else {
      const held = parseDecision(current, name).id
      if (held !== guard.id) throw new PlaceError(`decision-log: ${place.dirPath}/${name} holds #${held}, not #${guard.id}; refusing to overwrite it.`)
    }
  }
  await $.fs.write(target, text)
  return true
}

function indexPath(place: Place): string {
  return `${place.dirPath}/${INDEX_FILE}`
}

function entryOf(place: Place, d: Decision, file: string): DecisionEntry {
  return { ...d, file, path: `${place.dirPath}/${file}` }
}

// ---------------------------------------------------------------------------------------------------------------

let dirOption = 'docs/decisions' // set from the `dir` option on every (re)load of register

/** Reads the folder from disk into $.state (hand edits included) and answers where it is and what it holds. */
async function refresh($: Dollar): Promise<{ place: Place; entries: DecisionEntry[]; names: string[] }> {
  const place = await resolvePlace($, dirOption)
  const { entries, names } = await loadAll($, place)
  await update($, records, () => entries)
  return { place, entries, names }
}

/** Rewrites `<dir>/README.md` from the records; a README this plugin did not generate is left alone. */
async function writeIndex($: Dollar, place: Place, entries: readonly DecisionEntry[]): Promise<string> {
  const isWritten = await safeWrite($, place, INDEX_FILE, renderIndex(entries), { kind: 'index' })
  return isWritten ? `Index: ${indexPath(place)}` : `Index not written: ${indexPath(place)} was not generated by decision-log.`
}

async function saveRecord($: Dollar, place: Place, d: DecisionEntry): Promise<void> {
  await safeWrite($, place, d.file, serializeDecision(d), { kind: 'record', id: d.id })
}

function find(entries: readonly DecisionEntry[], id: number): DecisionEntry | undefined {
  return entries.find(e => e.id === id)
}

function addId(list: readonly number[], id: number): number[] {
  return list.includes(id) ? [...list] : [...list, id].sort((a, b) => a - b)
}

type RecordInput = {
  title: string
  context: string
  decision: string
  alternatives: string[]
  consequences: string
  tags: string[]
  files: string[]
  deciders: string[]
  status: DecisionStatus
  supersedes: number[]
}

/** Writes a new record (and links any it supersedes both ways), then the index. Answers the result text. */
async function recordDecision($: Dollar, input: RecordInput): Promise<{ text: string; entry: DecisionEntry }> {
  const { place, entries, names } = await refresh($)
  const old = input.supersedes.map(id => ({ id, entry: find(entries, id) }))
  const missing = old.filter(o => o.entry === undefined).map(o => `#${o.id}`)
  if (missing.length > 0) throw new PlaceError(`No record ${missing.join(', ')} to supersede. ${entries.length} records in ${place.dirPath}/.`)

  const id = nextId(entries, names)
  const d: Decision = {
    id,
    title: oneLine(input.title),
    status: input.status,
    date: isoDate(await $.clock.now()),
    deciders: input.deciders,
    supersedes: [...input.supersedes].sort((a, b) => a - b),
    supersededBy: [],
    tags: input.tags,
    files: input.files,
    context: input.context,
    decision: input.decision,
    alternatives: input.alternatives,
    consequences: input.consequences,
    preamble: '',
    extraSections: [],
    extraMeta: [],
  }
  const entry = entryOf(place, d, fileName(id, d.title))
  await safeWrite($, place, entry.file, serializeDecision(entry), { kind: 'new' })
  const lines = [`Recorded #${id} "${entry.title}" (${entry.status}) at ${entry.path}`]
  const all = [...entries, entry]
  for (const { entry: prior } of old) {
    if (prior === undefined) continue
    const changed: DecisionEntry = { ...prior, status: 'superseded', supersededBy: addId(prior.supersededBy, id) }
    await saveRecord($, place, changed)
    all.splice(all.indexOf(prior), 1, changed)
    lines.push(`#${prior.id} is now superseded by #${id} (${prior.path})`)
  }
  lines.push(await writeIndex($, place, all))
  await update($, records, () => all)
  return { text: lines.join('\n'), entry }
}

async function supersede($: Dollar, id: number, by: number): Promise<string> {
  const { place, entries } = await refresh($)
  const prior = find(entries, id)
  const newer = find(entries, by)
  if (prior === undefined || newer === undefined) {
    throw new PlaceError(`No record #${prior === undefined ? id : by}. ${entries.length} records in ${place.dirPath}/.`)
  }
  const changedOld: DecisionEntry = { ...prior, status: 'superseded', supersededBy: addId(prior.supersededBy, by) }
  const changedNew: DecisionEntry = { ...newer, supersedes: addId(newer.supersedes, id) }
  await saveRecord($, place, changedOld)
  await saveRecord($, place, changedNew)
  const all = entries.map(e => (e === prior ? changedOld : e === newer ? changedNew : e))
  const index = await writeIndex($, place, all)
  await update($, records, () => all)
  return [`#${id} "${prior.title}" is superseded by #${by} "${newer.title}".`, `${changedOld.path}: superseded-by ${changedOld.supersededBy.join(', ')}`, `${changedNew.path}: supersedes ${changedNew.supersedes.join(', ')}`, index].join('\n')
}

async function setStatus($: Dollar, id: number, status: DecisionStatus): Promise<string> {
  const { place, entries } = await refresh($)
  const prior = find(entries, id)
  if (prior === undefined) throw new PlaceError(`No record #${id}. ${entries.length} records in ${place.dirPath}/.`)
  const changed: DecisionEntry = { ...prior, status }
  await saveRecord($, place, changed)
  const all = entries.map(e => (e === prior ? changed : e))
  const index = await writeIndex($, place, all)
  await update($, records, () => all)
  return `#${id} "${prior.title}" is now ${status} (was ${prior.status}) at ${prior.path}\n${index}`
}

function messageOf(error: unknown): string {
  return error instanceof PlaceError ? error.message : `decision-log: ${error instanceof Error ? error.message : String(error)}`
}

/** `/decisions` with no arguments: the pane where it can be placed, the log as text otherwise. */
async function openPane($: Dollar, entries: readonly DecisionEntry[], dirPath: string): Promise<string> {
  await update($, memberOf(selected, { requestId: PANE }), () => -1)
  const opened = await $.ui.open({ id: PANE, title: 'Decisions', rows: Math.min(Math.max(entries.length, 1) + 4, 24) })
  const list = formatList(entries, dirPath)
  if (opened.isPlaced) return `Decisions pane opened. ${list}`
  return `${WAITING_HEAD}\n${list}`
}

export const register: Register = (on, options) => {
  dirOption = typeof options.dir === 'string' && options.dir.trim() !== '' ? options.dir : 'docs/decisions'
  const nudge = options.nudge !== false

  on('session.start', async ($, e, next) => {
    try {
      await refresh($)
    } catch (error) {
      $.ui.log(`decision-log: could not read the decisions folder (${messageOf(error)})`, { to: 'debug' })
    }
    await $.tool.register({ name: 'decision', description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA })
    await $.command.register({
      name: 'decide',
      description: 'Record a decision in the repo\'s decision log (you as the decider, status accepted)',
      argumentHint: '<title> — <why>',
    })
    await $.command.register({
      name: 'decisions',
      description: 'Browse the decision log (pane; inline on mobile)',
      argumentHint: '[<n> | search <query>]',
    })
    return next(e)
  })

  // The tool only reads and writes files inside the resolved decisions folder, so it needs no permission prompt.
  on('tool.check', { tool: TOOL }, () => ({ decision: 'allow' as const }))

  // Keep the schema in the prompt's tool list rather than behind ToolSearch.
  on('tool.describe', { tool: TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const request = parseToolInput(e as unknown as Record<string, unknown>)
    try {
      switch (request.action) {
        case 'error':
          return { deny: request.message }
        case 'record': {
          const { action: _action, ...input } = request
          return { result: (await recordDecision($, input)).text }
        }
        case 'list': {
          const { place, entries } = await refresh($)
          return { result: formatList(entries, place.dirPath, { status: request.status, tag: request.tag }) }
        }
        case 'search': {
          const { entries } = await refresh($)
          return { result: formatSearch(search(entries, request.query), request.query) }
        }
        case 'get': {
          const { place, entries } = await refresh($)
          const entry = find(entries, request.id)
          if (entry === undefined) return { deny: `No record #${request.id}. ${entries.length} records in ${place.dirPath}/.` }
          return { result: formatRecord(entry) }
        }
        case 'supersede':
          return { result: await supersede($, request.id, request.by) }
        case 'set-status':
          return { result: await setStatus($, request.id, request.status) }
      }
    } catch (error) {
      return { deny: messageOf(error) }
    }
  }).catch(() => ({ deny: 'decision-log: the tool failed. Call it with action "list" to see the current state.' }))

  on('command.run', { command: 'decide' }, async ($, e) => {
    const parsed = parseDecide(e.args)
    if ('error' in parsed) return { text: parsed.error }
    try {
      const { text } = await recordDecision($, {
        title: parsed.title,
        context: parsed.why,
        decision: parsed.title,
        alternatives: [],
        consequences: '',
        tags: [],
        files: [],
        deciders: ['user'],
        status: 'accepted',
        supersedes: [],
      })
      return { text }
    } catch (error) {
      return { text: messageOf(error) }
    }
  })

  on('command.run', { command: 'decisions' }, async ($, e) => {
    const command = parseDecisionsArgs(e.args)
    if (command.kind === 'error') return { text: command.message }
    let loaded: Awaited<ReturnType<typeof refresh>>
    try {
      loaded = await refresh($)
    } catch (error) {
      return { text: messageOf(error) }
    }
    const { place, entries } = loaded
    switch (command.kind) {
      case 'list':
        return { text: await openPane($, entries, place.dirPath) }
      case 'show': {
        const entry = find(entries, command.id)
        return { text: entry === undefined ? `No record #${command.id}. ${entries.length} records in ${place.dirPath}/.` : formatRecord(entry) }
      }
      case 'search':
        return { text: formatSearch(search(entries, command.query), command.query) }
    }
  })

  if (nudge) {
    on('prompt.compose', async ($, e, next) => {
      const composed = await next(e)
      if (e.traits.includes('bare')) return composed
      const dirPath = dirOption.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '')
      return { sections: [...composed.sections, { id: 'decision-log:guide', text: guideText(dirPath, TOOL), scope: 'session' as const }] }
    })
  }

  // The pane, wherever a surface places one. Only Box, Text, Button and Markdown: all of them exist on mobile too.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text, Markdown } = $.ui.resolve(e)
    const ui: Ui = { Box, Button, Text, Markdown }
    const entries = await read($, records)
    const view = memberOf(selected, e)
    const choice = await read($, view)
    const go = (id: number) => update($, view, () => id)
    const entry = choice > 0 ? find(entries, choice) : undefined
    if (entry !== undefined) return recordTree(ui, entry, go)
    return listTree(ui, entries, e.props.bodyColumns, go)
  })

  // `/decisions` draws the log inline as a card with Buttons: always on mobile (which places no pane), and
  // elsewhere when the pane could not be placed. `/decisions <n>` and `/decisions search <q>` always draw inline.
  on('ui.render', { component: 'CommandOutput', props: { command: 'decisions' } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const command = parseDecisionsArgs(e.props.args)
    if (command.kind === 'error') return next(e)
    if (command.kind === 'list' && e.surface !== 'mobile' && !e.props.text.startsWith(WAITING_HEAD)) return next(e)
    const { Box, Button, Text, Markdown } = $.ui.resolve(e)
    const ui: Ui = { Box, Button, Text, Markdown }
    const entries = await read($, records)
    const view = memberOf(selected, e)
    const choice = await read($, view)
    const go = (id: number) => update($, view, () => id)
    const columns = e.viewport?.columns
    const shown = choice > 0 ? choice : choice === 0 && command.kind === 'show' ? command.id : undefined
    if (shown !== undefined) {
      const entry = find(entries, shown)
      if (entry !== undefined) return recordTree(ui, entry, go)
      if (command.kind === 'show' && choice === 0) return next(e)
    }
    if (choice === 0 && command.kind === 'search') return searchTree(ui, search(entries, command.query), command.query, columns, go)
    return listTree(ui, entries, columns, go)
  })
}

function statusColor(status: DecisionStatus): 'success' | 'warning' | 'error' | 'inactive' {
  switch (status) {
    case 'accepted':
      return 'success'
    case 'proposed':
      return 'warning'
    case 'rejected':
      return 'error'
    case 'superseded':
      return 'inactive'
  }
}

function row(ui: Ui, entry: DecisionEntry, columns: number | undefined, go: (id: number) => unknown): RenderElement {
  const { Box, Button, Text } = ui
  const isDim = entry.status === 'superseded'
  // Room for `#nnnn`, the status and spaces; a narrow phone gets a shorter line rather than a wrapped one.
  const titleMax = columns === undefined ? 200 : Math.max(columns - 20, 10)
  return (
    <Box key={`row-${entry.id}`} flexDirection="row">
      <Button key={`open-${entry.id}`} plain label={`#${entry.id}`} dimColor={isDim} onPress={() => go(entry.id)} />
      <Text color={statusColor(entry.status)} dimColor={isDim}>
        {` ${entry.status.padEnd(10)} `}
      </Text>
      <Text dimColor={isDim} wrap="truncate-end">
        {clip(entry.title, titleMax)}
        {supersededNote(entry)}
      </Text>
    </Box>
  )
}

/** Newest first, status coloured, superseded rows dimmed with `→ #N`; each row's Button opens the record. */
function listTree(ui: Ui, entries: readonly DecisionEntry[], columns: number | undefined, go: (id: number) => unknown): RenderElement {
  const { Box, Text } = ui
  if (entries.length === 0) {
    return (
      <Box key="decisions-empty" flexDirection="column">
        <Text dimColor>{'No decisions recorded yet. Add one with /decide <title> — <why>, or ask Claude to record one.'}</Text>
      </Box>
    )
  }
  return (
    <Box key="decisions-list" flexDirection="column">
      <Text bold>
        {entries.length} decision{entries.length === 1 ? '' : 's'}
      </Text>
      {newestFirst(entries).map(entry => row(ui, entry, columns, go))}
    </Box>
  )
}

function searchTree(ui: Ui, hits: readonly SearchHit[], query: string, columns: number | undefined, go: (id: number) => unknown): RenderElement {
  const { Box, Button, Text } = ui
  const snippetMax = columns === undefined ? 160 : Math.max(columns - 4, 20)
  return (
    <Box key="decisions-search" flexDirection="column">
      <Text bold>{hits.length === 0 ? `No decisions match "${query}".` : `${hits.length} match "${query}"`}</Text>
      {hits.map(hit => (
        <Box key={`hit-${hit.entry.id}`} flexDirection="column">
          {row(ui, hit.entry, columns, go)}
          <Text dimColor wrap="truncate-end">
            {`  ${clip(hit.snippet, snippetMax)}`}
          </Text>
        </Box>
      ))}
      <Box flexDirection="row">
        <Button key="all" label="All decisions" onPress={() => go(-1)} />
      </Box>
    </Box>
  )
}

/** The full record as Markdown, a Button back to the list and one per linked record. */
function recordTree(ui: Ui, entry: DecisionEntry, go: (id: number) => unknown): RenderElement {
  const { Box, Button, Markdown } = ui
  const links = [...entry.supersedes, ...entry.supersededBy]
  return (
    <Box key={`record-${entry.id}`} flexDirection="column">
      <Box flexDirection="row">
        <Button key="back" label="← All decisions" onPress={() => go(-1)} />
        {links.map(id => (
          <Button key={`link-${id}`} label={`#${id}`} onPress={() => go(id)} />
        ))}
      </Box>
      <Markdown key={`md-${entry.id}`} text={recordMarkdown(entry)} />
    </Box>
  )
}

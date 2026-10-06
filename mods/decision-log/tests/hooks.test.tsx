import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__decision-log__decision'
const ROOT = '/work/repo'
const DIR = `${ROOT}/docs/decisions`
const ALL_SURFACES = ['terminal', 'desktop', 'mobile'] as const

/** An in-memory file system: folders, files and symbolic links, with `realPath` resolution. */
class MemFs {
  files = new Map<string, string>()
  dirs = new Set<string>(['/'])
  links = new Map<string, string>()
  /** Names fs.list leaves out, as if written after the listing. */
  hidden = new Set<string>()

  constructor() {
    this.mkdirp(ROOT)
    this.mkdirp('/outside')
  }

  mkdirp(path: string): void {
    const parts = path.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) this.dirs.add(`/${parts.slice(0, i).join('/')}`)
  }

  /** Folds `.`/`..` and follows links on every prefix; the last part's link only when `follow`. */
  resolve(path: string, follow = true): string {
    const out: string[] = []
    const parts = path.split('/').filter(p => p !== '' && p !== '.')
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as string
      if (part === '..') {
        out.pop()
        continue
      }
      out.push(part)
      const here = `/${out.join('/')}`
      const target = this.links.get(here)
      if (target !== undefined && (follow || i < parts.length - 1)) {
        out.length = 0
        out.push(...this.resolve(target).split('/').filter(Boolean))
      }
    }
    return `/${out.join('/')}`
  }

  kindOf(real: string): 'file' | 'dir' | undefined {
    return this.files.has(real) ? 'file' : this.dirs.has(real) ? 'dir' : undefined
  }

  write(path: string, text: string): void {
    const real = this.resolve(path)
    this.mkdirp(real.slice(0, real.lastIndexOf('/')) || '/')
    this.files.set(real, text)
  }

  install(on: On): void {
    on('fs.stat', (_$, e) => {
      const real = this.resolve(e.path)
      const kind = this.kindOf(real)
      if (kind === undefined) return { deny: `ENOENT: ${e.path}` }
      const isLink = this.links.has(this.resolve(e.path, false))
      return { value: { kind, size: this.files.get(real)?.length ?? 0, mtimeMs: 0, isLink, ...(e.resolve ? { realPath: real } : {}) } }
    })
    on('fs.exists', (_$, e) => ({ value: this.kindOf(this.resolve(e.path)) !== undefined }))
    on('fs.read', (_$, e) => {
      const text = this.files.get(this.resolve(e.path))
      return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
    })
    on('fs.write', (_$, e) => {
      this.write(e.path, e.text)
      return { value: undefined }
    })
    on('fs.list', (_$, e) => {
      const real = this.resolve(e.path)
      if (!this.dirs.has(real)) return { deny: `ENOENT: ${e.path}` }
      const names = new Set<string>()
      for (const p of [...this.files.keys(), ...this.dirs, ...this.links.keys()]) {
        if (p.startsWith(`${real}/`) && !p.slice(real.length + 1).includes('/') && !this.hidden.has(p.slice(real.length + 1))) names.add(p.slice(real.length + 1))
      }
      return {
        value: [...names].map(name => {
          const full = `${real}/${name}`
          const isLink = this.links.has(full)
          return { name, kind: isLink ? ('other' as const) : this.files.has(full) ? ('file' as const) : ('dir' as const), size: this.files.get(full)?.length ?? 0, mtimeMs: 0, isLink }
        }),
      }
    })
  }
}

/** The world beneath the plugin: a repo at ROOT, a clock on 2026-10-06, the in-memory fs (returned). */
function world(on: On): MemFs {
  const fs = new MemFs()
  fs.install(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 6, 12) })
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__decision-log__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  return fs
}

const startSession = ($: { session: { start: (e: { cwd: string; surface: 'terminal'; isInteractive: boolean }) => Promise<unknown> } }) =>
  $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

const RECORD = {
  tool: TOOL,
  action: 'record',
  title: 'Use REST for the public API',
  context: 'Clients are browsers and curl.',
  decision: 'Expose a REST API with JSON bodies.',
  alternatives: ['GraphQL: more moving parts', 'gRPC: poor browser support'],
  consequences: 'We version via the URL.',
  tags: ['api'],
  files: ['src/api/'],
} as const

test('record writes NNNN-slug.md and the README index, and returns the path', async ($, on) => {
  const fs = world(on)
  await startSession($)
  const out = await $.tool.call({ ...RECORD })
  expect(out.deny).toBeUndefined()
  expect(String(out.result)).toContain('Recorded #1 "Use REST for the public API" (accepted) at docs/decisions/0001-use-rest-for-the-public-api.md')
  const file = fs.files.get(`${DIR}/0001-use-rest-for-the-public-api.md`)
  expect(file).toContain('id: 1\ntitle: Use REST for the public API\nstatus: accepted\ndate: 2026-10-06\ndeciders: [user, claude]')
  expect(file).toContain('## Alternatives considered\n\n- GraphQL: more moving parts\n- gRPC: poor browser support')
  expect(fs.files.get(`${DIR}/README.md`)).toContain('| 0001 | [Use REST for the public API](0001-use-rest-for-the-public-api.md) | accepted | 2026-10-06 |')

  const second = await $.tool.call({ ...RECORD, title: 'Cache responses' })
  expect(String(second.result)).toContain('#2')
  expect(fs.files.has(`${DIR}/0002-cache-responses.md`)).toBe(true)
})

test('numbering continues after hand-made files', async ($, on) => {
  const fs = world(on)
  fs.write(`${DIR}/0041-hand-made.md`, '# Something old\r\n\r\n## Decision\r\nKeep it.\r\n')
  await startSession($)
  const out = await $.tool.call({ ...RECORD })
  expect(String(out.result)).toContain('#42')
  const listed = await $.tool.call({ tool: TOOL, action: 'list' })
  expect(String(listed.result)).toContain('#41 proposed')
  // The hand-made file is not rewritten by a record or a list.
  expect(fs.files.get(`${DIR}/0041-hand-made.md`)).toContain('\r\n')
})

test('record with supersedes, and supersede, link both ways; list, search and get', async ($, on) => {
  const fs = world(on)
  await startSession($)
  await $.tool.call({ ...RECORD })
  const second = await $.tool.call({ ...RECORD, title: 'Use GraphQL for the public API', tags: ['api', 'graphql'], supersedes: 1 })
  expect(String(second.result)).toContain('#1 is now superseded by #2')
  expect(fs.files.get(`${DIR}/0001-use-rest-for-the-public-api.md`)).toContain('status: superseded')
  expect(fs.files.get(`${DIR}/0001-use-rest-for-the-public-api.md`)).toContain('superseded-by: [2]')
  expect(fs.files.get(`${DIR}/0002-use-graphql-for-the-public-api.md`)).toContain('supersedes: [1]')
  expect(fs.files.get(`${DIR}/README.md`)).toContain('superseded (by #2)')

  await $.tool.call({ ...RECORD, title: 'Use gRPC internally', tags: ['rpc'] })
  const sup = await $.tool.call({ tool: TOOL, action: 'supersede', id: 2, by: 3 })
  expect(String(sup.result)).toContain('#2 "Use GraphQL for the public API" is superseded by #3')
  expect(fs.files.get(`${DIR}/0002-use-graphql-for-the-public-api.md`)).toContain('superseded-by: [3]')
  expect(fs.files.get(`${DIR}/0003-use-grpc-internally.md`)).toContain('supersedes: [2]')

  const listed = String((await $.tool.call({ tool: TOOL, action: 'list' })).result).split('\n')
  expect(listed[0]).toBe('3 decisions in docs/decisions/, newest first:')
  expect(listed[1]).toMatch(/^#3 accepted 2026-10-06 Use gRPC internally/)
  expect(listed[3]).toContain('→ #2')
  const superseded = String((await $.tool.call({ tool: TOOL, action: 'list', status: 'superseded' })).result)
  expect(superseded.split('\n')).toHaveLength(3)
  expect(String((await $.tool.call({ tool: TOOL, action: 'list', tag: 'graphql' })).result)).toContain('#2 superseded')

  const found = String((await $.tool.call({ tool: TOOL, action: 'search', query: 'graphql' })).result)
  expect(found.split('\n')[1]).toMatch(/^#2 /)
  expect(found).toContain('docs/decisions/0002-use-graphql-for-the-public-api.md')
  expect(found).toContain('GraphQL: more moving parts')

  const got = String((await $.tool.call({ tool: TOOL, action: 'get', id: 3 })).result)
  expect(got.startsWith('docs/decisions/0003-use-grpc-internally.md\n\n---\nid: 3')).toBe(true)
  expect((await $.tool.call({ tool: TOOL, action: 'get', id: 99 })).deny).toContain('No record #99')

  const status = await $.tool.call({ tool: TOOL, action: 'set-status', id: 3, status: 'rejected' })
  expect(String(status.result)).toContain('#3 "Use gRPC internally" is now rejected (was accepted)')
  expect(fs.files.get(`${DIR}/0003-use-grpc-internally.md`)).toContain('status: rejected')
})

test('the tool needs no permission prompt and stays in the prompt tool list', async ($, on) => {
  world(on)
  await startSession($)
  const { decision } = await $.tool.check({ tool: TOOL, input: { action: 'list' } })
  expect(decision).toBe('allow')
})

test('a folder option that leaves the repository is refused and nothing is written', { options: { dir: '../outside' } }, async ($, on) => {
  const fs = world(on)
  await startSession($)
  const out = await $.tool.call({ ...RECORD })
  expect(out.isError === true || out.deny !== undefined).toBe(true)
  expect(String(out.deny ?? out.text)).toContain('may not leave the repository')
  expect([...fs.files.keys()]).toEqual([])
})

test('a decisions folder that is a link out of the repository is refused', async ($, on) => {
  const fs = world(on)
  fs.mkdirp(`${ROOT}/docs`)
  fs.links.set(DIR, '/outside')
  await startSession($)
  const out = await $.tool.call({ ...RECORD })
  expect(String(out.deny ?? out.text)).toContain('outside the repository')
  expect([...fs.files.keys()]).toEqual([])
  const decided = await $.command.run({ command: 'decide', args: 'Use tabs — consistency', ...COMMAND })
  expect(decided.text).toContain('outside the repository')
  expect([...fs.files.keys()]).toEqual([])
})

test('a README the plugin did not generate is left alone', async ($, on) => {
  const fs = world(on)
  fs.write(`${DIR}/README.md`, '# Our ADRs\n\nHand written.\n')
  await startSession($)
  const out = await $.tool.call({ ...RECORD })
  expect(String(out.result)).toContain('Index not written')
  expect(fs.files.get(`${DIR}/README.md`)).toBe('# Our ADRs\n\nHand written.\n')
})

test('an existing file is never overwritten by a record with another id', async ($, on) => {
  const fs = world(on)
  // A file the listing does not show yet (written by someone else meanwhile) sits where #1 would go.
  fs.write(`${DIR}/0001-use-rest-for-the-public-api.md`, '---\nid: 9\ntitle: Theirs\n---\n')
  fs.hidden.add('0001-use-rest-for-the-public-api.md')
  await startSession($)
  const out = await $.tool.call({ ...RECORD })
  expect(String(out.deny ?? out.text)).toContain('already exists; refusing to overwrite')
  expect(fs.files.get(`${DIR}/0001-use-rest-for-the-public-api.md`)).toContain('title: Theirs')
})

test('a link in the folder is never written through', async ($, on) => {
  const fs = world(on)
  fs.mkdirp(DIR)
  fs.write('/outside/README.md', 'secret')
  fs.links.set(`${DIR}/README.md`, '/outside/README.md')
  await startSession($)
  const out = await $.tool.call({ ...RECORD })
  expect(String(out.deny ?? out.text)).toContain('README.md is not a plain file inside the folder')
  expect(fs.files.get('/outside/README.md')).toBe('secret')
})

test('/decide records your decision as accepted, decided by you', async ($, on) => {
  const fs = world(on)
  await startSession($)
  const out = await $.command.run({ command: 'decide', args: 'Use pnpm -- faster installs and strict deps', ...COMMAND })
  expect(out.text).toContain('Recorded #1 "Use pnpm" (accepted) at docs/decisions/0001-use-pnpm.md')
  const file = String(fs.files.get(`${DIR}/0001-use-pnpm.md`))
  expect(file).toContain('deciders: [user]')
  expect(file).toContain('## Context\n\nfaster installs and strict deps')
  expect(file).toContain('## Decision\n\nUse pnpm')
  expect((await $.command.run({ command: 'decide', args: '', ...COMMAND })).text).toContain('Usage')
})

test('the system prompt gets a short decision-log section', { options: { dir: 'adr' } }, async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  await startSession($)
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const section = composed.sections.find(s => s.id === 'decision-log:guide')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('adr/')
  expect(section?.text).toContain(TOOL)
  expect(String(section?.text).split(/\s+/).length).toBeLessThan(120)
})

const PANE_PROPS = { title: 'Decisions', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const

async function seed($: Engine): Promise<void> {
  await $.tool.call({ ...RECORD })
  await $.tool.call({ ...RECORD, title: 'Use GraphQL for the public API', supersedes: 1 })
}

test('the pane lists decisions newest first and a Button opens the full record', async ($, on) => {
  world(on)
  await startSession($)
  await seed($)
  for (const surface of ALL_SURFACES) {
    const pane = await $.ui.mount({ plugin: 'decision-log', surface, component: 'Pane', requestId: 'decisions', props: PANE_PROPS })
    const rows = (await pane.findAll({ type: 'Button' })).map(b => b.props.label)
    expect(rows).toEqual(['#2', '#1'])
    expect((await pane.find({ type: 'Text', text: /→ #2/ }))?.props.dimColor).toBe(true)
    expect((await pane.find({ type: 'Text', text: / accepted / }))?.props.color).toBe('success')
    await pane.press({ key: 'open-1' })
    const md = await pane.find({ type: 'Markdown' })
    expect(String(md?.props.text)).toContain('# 1. Use REST for the public API')
    expect(String(md?.props.text)).toContain('superseded by #2')
    await pane.press({ key: 'link-2' })
    expect(String((await pane.find({ type: 'Markdown' }))?.props.text)).toContain('# 2. Use GraphQL')
    await pane.press({ key: 'back' })
    expect(await pane.find({ key: 'open-2' })).toBeDefined()
    await pane.unmount()
  }
})

const commandRow = (args: string, text: string) =>
  ({ component: 'CommandOutput', props: { command: 'decisions', args, text, isErrored: false }, viewport: { columns: 40, rows: 30 } }) as const

test('/decisions draws an inline card on mobile; a Button opens the record there', async ($, on) => {
  world(on)
  on('ui.render', { component: 'CommandOutput' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine-row">{e.props.text}</Text>
  })
  await startSession($)
  await seed($)
  const card = await $.ui.mount({ plugin: 'decision-log', surface: 'mobile', ...commandRow('', 'Decisions pane opened.') })
  expect(await card.find({ key: 'open-2' })).toBeDefined()
  await card.press({ key: 'open-2' })
  expect(String((await card.find({ type: 'Markdown' }))?.props.text)).toContain('# 2. Use GraphQL for the public API')
  await card.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const plain = await $.ui.mount({ plugin: 'decision-log', surface, ...commandRow('', 'Decisions pane opened.') })
    expect(await plain.find({ key: 'open-2' })).toBeUndefined()
    expect(await plain.find({ type: 'Text', text: 'Decisions pane opened.' })).toBeDefined()
    await plain.unmount()
  }
})

test('/decisions answers inline when the pane cannot be placed, on every surface', async ($, on) => {
  world(on)
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'no surface places panes' } }))
  await startSession($)
  await seed($)
  const answer = await $.command.run({ command: 'decisions', args: '', ...COMMAND })
  expect(answer.text).toContain('#2 accepted')
  for (const surface of ALL_SURFACES) {
    const card = await $.ui.mount({ plugin: 'decision-log', surface, ...commandRow('', String(answer.text)) })
    expect(await card.find({ key: 'open-1' })).toBeDefined()
    await card.unmount()
  }
})

test('/decisions <n> and /decisions search <q> draw inline on every surface', async ($, on) => {
  world(on)
  await startSession($)
  await seed($)
  const shown = await $.command.run({ command: 'decisions', args: '1', ...COMMAND })
  expect(shown.text).toContain('docs/decisions/0001-use-rest-for-the-public-api.md')
  const searched = await $.command.run({ command: 'decisions', args: 'search graphql', ...COMMAND })
  expect(searched.text).toContain('#2 accepted')
  for (const surface of ALL_SURFACES) {
    const one = await $.ui.mount({ plugin: 'decision-log', surface, ...commandRow('1', String(shown.text)) })
    expect(String((await one.find({ type: 'Markdown' }))?.props.text)).toContain('# 1. Use REST')
    await one.press({ key: 'back' })
    expect(await one.find({ key: 'open-2' })).toBeDefined()
    await one.unmount()

    const hits = await $.ui.mount({ plugin: 'decision-log', surface, ...commandRow('search graphql', String(searched.text)) })
    expect(await hits.find({ key: 'hit-2' })).toBeDefined()
    await hits.press({ key: 'open-2' })
    expect(String((await hits.find({ type: 'Markdown' }))?.props.text)).toContain('# 2. Use GraphQL')
    await hits.unmount()
  }
})

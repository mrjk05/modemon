export type DecisionStatus = 'proposed' | 'accepted' | 'superseded' | 'rejected'

/** One decision record, as parsed from (and serialized to) its markdown file. */
export type Decision = {
  id: number
  title: string
  status: DecisionStatus
  /** YYYY-MM-DD, or whatever a hand-edited file holds. */
  date: string
  deciders: string[]
  supersedes: number[]
  supersededBy: number[]
  tags: string[]
  files: string[]
  context: string
  decision: string
  alternatives: string[]
  consequences: string
  /** Text between the title heading and the first section, kept as written. */
  preamble: string
  /** Sections other than the four known ones, kept in order. */
  extraSections: { heading: string; body: string }[]
  /** Front-matter keys this plugin does not know, kept with their raw values. */
  extraMeta: [string, string][]
}

/** A record with where it lives. */
export type DecisionEntry = Decision & {
  /** The file name inside the decisions folder. */
  file: string
  /** The path relative to the repository root, `/`-separated. */
  path: string
}

declare module 'claude-code' {
  interface PluginState {
    'decision-log': {
      /** Every record in the decisions folder, as last read from disk. */
      records: DecisionEntry[]
      /** Per drawing (pane or command row): 0 its default view, -1 the list, n > 0 record #n. */
      selected: StateFamily<number>
    }
  }
}

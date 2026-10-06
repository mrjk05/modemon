/** One colour of the palette, or a pinned custom hex. */
export type ProjectColorSwatch = {
  /** A palette name (`purple`), or `custom` for a pinned hex. */
  name: string
  /** `#RRGGBB`, upper case. */
  hex: string
  /** Black or white: whichever reads better on `hex`. */
  fg: string
  /** The coloured circle the status line shows (mobile has no stripe). */
  emoji: string
}

/** The session's project as the stripe and status line draw it. */
export type ProjectColorProject = {
  /** The repository root's basename (the working directory's outside a repo). */
  name: string
  /** The absolute root the override is stored under. */
  root: string
  /** The checked-out branch, or a short commit when detached; null when unknown. */
  branch: string | null
  /** The pinned colour (`red`, `#12AB34`); null when picked automatically. */
  override: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'project-color': {
      project: ProjectColorProject | null
    }
  }
}

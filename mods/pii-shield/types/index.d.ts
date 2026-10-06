// pii-shield: the values it keeps in $.state for the session.

/** What `/redact` sets: `auto` polls for recorders, `on` and `off` force it. */
export type PiiShieldMode = 'auto' | 'on' | 'off'

export type PiiShieldState = {
  /** Set by `/redact`; null means "use the configured mode". */
  override: PiiShieldMode | null
  /**
   * The recorder or screen-sharing process seen this session (sticky), or
   * null. Cleared only by `/redact off` or `/redact auto`.
   */
  recorder: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'pii-shield': {
      shield: PiiShieldState
      /** Names found at session start: OS username, git user.name. */
      identity: string[]
    }
  }
}

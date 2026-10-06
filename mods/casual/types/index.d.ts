export type CasualVerbosity = 'chill' | 'brief'

/**
 * The person's choice, as `/casual` last set it. `verbosity` is absent until
 * `/casual brief` or `/casual chill` overrides the `verbosity` option.
 */
export type CasualPrefs = { isOn: boolean; verbosity?: CasualVerbosity }

declare module 'claude-code' {
  interface PluginState {
    casual: { prefs: CasualPrefs }
  }
}

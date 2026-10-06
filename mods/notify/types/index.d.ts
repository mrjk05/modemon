/**
 * notify's session state: `muted` is true while `/notify off` holds.
 */
export type NotifyMuted = boolean

declare module 'claude-code' {
  interface PluginState {
    notify: { muted: boolean }
  }
}

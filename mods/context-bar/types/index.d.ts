/** What a bar segment stands for: content in the window, free room, or the compaction reserve. */
export type ContextBarSegmentKind = 'used' | 'free' | 'buffer'

/** One category of the context window, as the bar draws it. */
export type ContextBarSegment = {
  name: string
  tokens: number
  /** A theme key (or raw colour) from the engine's /context breakdown. */
  color: string
  kind: ContextBarSegmentKind
}

/** The context window as the band last measured it. */
export type ContextBarSnapshot = {
  /** Exact input tokens of the last API response; null before the first one. */
  tokens: number | null
  /** `tokens` over the model's window as a whole percentage; null before the first response. */
  percent: number | null
  /** The model's context window, in tokens. */
  window: number
  /** The window the categories fill (the compaction window), in tokens. */
  scale: number
  /** The estimated total of the categories, used while `tokens` is null. */
  estimatedTokens: number | null
  /** Token count at which auto-compaction runs; null when it is off. */
  autoCompactAt: number | null
  segments: ContextBarSegment[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      snapshot: ContextBarSnapshot | null
      isHidden: boolean
      hasWarned: boolean
    }
  }
}

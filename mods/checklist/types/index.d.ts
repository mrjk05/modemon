export type ChecklistStatus = 'todo' | 'doing' | 'done'

export type ChecklistItem = {
  /** Stable item number, shown in every list and used by the tool and /checklist. */
  id: number
  text: string
  status: ChecklistStatus
  /** Milliseconds since the epoch. */
  createdAt: number
  /** Milliseconds since the epoch, set while the item is done. */
  doneAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    checklist: {
      /** The current repo's items, mirrored from $.store for drawing. */
      items: ChecklistItem[]
      /** The $.store key the items persist under (one per repo root). */
      storeKey: string
    }
  }
}

// agent-deck's state contract: the values it keeps in `$.state` for the
// session, so a hot reload of the module keeps every card.

/** Where a subagent stands, as its card shows it. */
export type AgentDeckStatus = 'running' | 'done' | 'failed';

/** One subagent of the session, as its card draws it. */
export type AgentDeckCard = {
  /** Stable key: the Agent call's tool_use_id, or `agent:<id>` when only the id is known. */
  key: string;
  /** The Agent tool call that started it, when known. */
  toolUseId?: string;
  /** The agent's id (`$.agent.list()`, `tool.call`'s `agentId`), once known. */
  agentId?: string;
  status: AgentDeckStatus;
  /** Agent type (`general-purpose`, `Explore`, a plugin's agent). */
  type: string;
  /** The Agent call's `description`. */
  title: string;
  /** One-line summary of the prompt. */
  summary: string;
  /** The prompt as given (capped), shown when the card is expanded. */
  prompt?: string;
  /** Model: the resolved id when known, else the alias asked for. */
  model?: string;
  /** Epoch milliseconds. */
  startedAt: number;
  endedAt?: number;
  /** Tool calls the subagent made. */
  toolCount: number;
  /** The tool call running now, described (`Grep "foo"`). */
  currentTool?: string;
  /** The last tool call that finished, described. */
  lastTool?: string;
  /** Why it failed, or a note on how it ended. */
  note?: string;
};

declare module 'claude-code' {
  interface PluginState {
    'agent-deck': {
      /** Every subagent card, in spawn order. */
      agents: AgentDeckCard[];
      /** The clock's last tick, which running cards' elapsed time reads. */
      now: number;
      /** True once the deck opened by itself this session. */
      autoOpened: boolean;
      /** The session's directory, which tool paths are shown relative to. */
      cwd: string;
      /** True while the Claude mobile app is among the session's surfaces. */
      phoneWatching: boolean;
      /** Keys of the cards expanded in the pane to show their full prompt. */
      expanded: string[];
      /** Keys of running cards a stop was asked for, until they end. */
      stopping: string[];
    };
  }
}

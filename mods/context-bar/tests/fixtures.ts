import type { ContextCategory, RenderPropsOf, SessionUsage } from 'claude-code'

const WINDOW = 200_000
const BUFFER = 33_000

function category(name: string, tokens: number, color: string, kind: ContextCategory['kind']): ContextCategory {
  return { name, tokens, color, kind, isDeferred: kind === 'deferred' }
}

/** A `$.session.usage({ breakdown: 'summary' })` answer with `tokens` in use (null: before the first response). */
export function usageAt(tokens: number | null): SessionUsage {
  const fixed = 3_000 + 12_000 + 2_000
  const messages = Math.max(0, (tokens ?? fixed) - fixed)
  const used = fixed + messages
  const categories = [
    category('System prompt', 3_000, 'promptBorder', 'used'),
    category('System tools', 12_000, 'inactive', 'used'),
    category('Memory files', 2_000, 'claude', 'used'),
    category('MCP tools', 9_000, 'ide', 'deferred'),
    category('Messages', messages, 'permission', 'used'),
    category('Free space', Math.max(0, WINDOW - BUFFER - used), 'inactive', 'free'),
    category('Autocompact buffer', BUFFER, 'warning', 'buffer'),
  ]

  return {
    startedAt: 0,
    rateLimits: [],
    context: {
      window: WINDOW,
      ...(tokens !== null && { tokens, percent: Math.round((tokens / WINDOW) * 100) }),
      breakdown: {
        categories,
        totalTokens: used,
        maxTokens: WINDOW,
        rawMaxTokens: WINDOW,
        autocompactSource: 'model-default',
        percentage: Math.round((used / WINDOW) * 100),
        gridRows: [],
        model: 'claude-test',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        autoCompactThreshold: WINDOW - BUFFER,
        isAutoCompactEnabled: true,
        apiUsage: null,
      },
    },
  }
}

/** The band's props as a terminal of `columns` measures them. */
export function bandProps(columns: number, maxRows = 10): RenderPropsOf['AbovePrompt'] {
  return {
    hasSurvey: false,
    isWorking: false,
    maxRows,
    bodyColumns: columns,
    scroll: { offset: 0, bodyRows: maxRows },
    view: {},
  }
}

/** One question of a log entry: AskUserQuestion's header, text and option labels, or a detected sentence. */
export type QuestionLogQuestion = {
  header?: string
  text: string
  options?: string[]
}

/** One logged question: an AskUserQuestion call or a question detected at the end of a reply. */
export type QuestionLogEntry = {
  id: string
  kind: 'ask' | 'detected'
  /** When it was asked, ms since the epoch. */
  at: number
  questions: QuestionLogQuestion[]
  /** The answer: the dialog's choices, or the first ~200 characters of your next prompt. Absent while open. */
  answer?: string
  answeredAt?: number
  /** The transcript row (session.append uuid) of the reply that asked, for a detected question. */
  messageId?: string
  /** A hash of the reply's text, to recognise its row when the row's id is not known. */
  textHash?: string
}

declare module 'claude-code' {
  interface PluginState {
    'question-log': { log: QuestionLogEntry[] }
  }
}

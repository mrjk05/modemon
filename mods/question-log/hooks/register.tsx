import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { QuestionLogEntry } from '../types'
import {
  answerDetected,
  askQuestions,
  detectQuestion,
  findFlagged,
  formatAskAnswer,
  normalize,
  relativeTime,
  statusText,
  textHash,
} from './lib'

const PANE = 'question-log'
const COMMAND = 'questions'
const MAX_ENTRIES = 200

const log = atom({ plugin: 'question-log', key: 'log' } as const, [])

/** Origins of a prompt the person wrote: only these answer an open question. */
function isPersonsPrompt(origin: PromptOrigin): boolean {
  return origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
}

/** Applies `change` to the log and pins the `? N open` status line to match. */
async function commit(
  $: EngineInterface,
  change: (entries: QuestionLogEntry[]) => QuestionLogEntry[],
): Promise<QuestionLogEntry[]> {
  const next = await update($, log, entries => change(entries).slice(-MAX_ENTRIES))
  $.ui.status(statusText(next))
  return next
}

/** The text blocks of a response row, joined. */
function rowText(content: ReadonlyArray<{ type: string; [field: string]: unknown }>): string {
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => String(block.text))
    .join('\n')
}

export const register: Register = (on, options) => {
  const detectQuestions = options.detectQuestions !== false
  const highlight = options.highlight !== false

  // The last main-loop response row with text this turn, so a detected
  // question can name the row it came from.
  let lastResponse: { uuid: string; text: string } | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Toggle the question log pane (questions asked and their answers)',
      argumentHint: '[clear]',
      immediate: true,
    })
    $.ui.status(statusText(await read($, log)))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      lastResponse = null
      await commit($, () => [])
    }
    return next(e)
  })

  // AskUserQuestion: logged open while the dialog is up, answered from its result.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const at = await $.clock.now()
    const id = e.tool_use_id
    await commit($, entries => [...entries, { id, kind: 'ask', at, questions: askQuestions(e.questions) }])

    const ran = await next(e)

    let answer: string
    if (ran.deny !== undefined) answer = '(dismissed)'
    else if (ran.isError === true) answer = '(dismissed)'
    else {
      const result = ran.result
      answer = formatAskAnswer(e.questions, result.answers as Record<string, unknown>, result.response)
    }
    const answeredAt = await $.clock.now()
    await commit($, entries => entries.map(entry => (entry.id === id ? { ...entry, answer, answeredAt } : entry)))
    return ran
  }).catch(($, e, next) => next(e))

  // The main loop's response rows: remember the last one that carries text.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && e.message.role === 'assistant') {
      const text = rowText(e.message.content)
      if (text.trim().length > 0) lastResponse = { uuid: e.uuid, text }
    }
    return stored
  }).catch(($, e, next) => next(e))

  // Detected questions: the reply's final text, as the turn ends.
  on('turn.complete', async ($, e, next) => {
    const response = lastResponse
    if (e.agentId === undefined) lastResponse = null
    if (!detectQuestions || e.agentId !== undefined || e.reason !== 'answer') return next(e)

    const found = detectQuestion(e.answer)
    if (found.isQuestion) {
      const at = await $.clock.now()
      const entry: QuestionLogEntry = {
        id: `d-${e.turnId}`,
        kind: 'detected',
        at,
        questions: found.questions.map(text => ({ text })),
      }
      const isSameRow = response !== null && normalize(e.answer).endsWith(normalize(response.text))
      if (response !== null && isSameRow) {
        entry.messageId = response.uuid
        entry.textHash = textHash(response.text)
      } else {
        entry.textHash = textHash(e.answer)
      }
      await commit($, entries => [...entries.filter(one => one.id !== entry.id), entry])
    }
    return next(e)
  })

  // The person's next prompt answers every open detected question.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop !== undefined || !isPersonsPrompt(e.origin)) return entered
    if (e.text.trimStart().startsWith('/')) return entered
    const entries = await read($, log)
    if (entries.some(entry => entry.kind === 'detected' && entry.answer === undefined)) {
      const now = await $.clock.now()
      await commit($, list => answerDetected(list, e.text, now))
    }
    return entered
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'clear') {
      await commit($, () => [])
      return { text: 'Question log cleared.' }
    }
    if (arg !== '') return { text: `Usage: /${COMMAND} [clear]` }

    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isUp) {
      await $.ui.close({ id: PANE })
      return { text: 'Question log closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Questions' })
    return { text: opened.isPlaced ? 'Question log opened.' : 'Question log opens when the terminal is wide enough.' }
  })

  // Highlight: a reply flagged as a question is drawn in a coloured box.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!highlight || e.props.isSummary === true) return next(e)
    if (!e.props.text.includes('?')) return next(e)
    const entries = await read($, log)
    const flagged = findFlagged(entries, e.requestId, e.props.text)
    if (flagged === undefined) return next(e)

    const { Box, Text, Markdown } = $.ui.resolve(e)
    const isOpen = flagged.answer === undefined
    const accent = isOpen ? 'yellow' : 'magenta'
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
        <Text bold color={accent}>
          ? Question for you
          {isOpen ? '' : ' · answered'}
        </Text>
        <Markdown text={e.props.text} />
      </Box>
    )
  })

  // The log pane: every question in order, newest at the bottom.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const entries = await read($, log)
    const now = await $.clock.now()
    const open = entries.filter(entry => entry.answer === undefined).length

    if (entries.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No questions yet. AskUserQuestion dialogs and replies that end with a question show here.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>
          {entries.length} question{entries.length === 1 ? '' : 's'}
          {open > 0 ? ` · ${open} open` : ''}
        </Text>
        {entries.map(entry => {
          const isOpen = entry.answer === undefined
          return (
            <Box key={entry.id} flexDirection="column" marginTop={1}>
              <Text>
                <Text bold color={isOpen ? 'yellow' : 'green'}>
                  {isOpen ? '? open' : '✓ answered'}
                </Text>
                <Text dimColor>
                  {'  '}
                  {relativeTime(entry.at, now)} {'·'} {entry.kind === 'ask' ? 'AskUserQuestion' : 'in reply'}
                </Text>
              </Text>
              {entry.questions.map(question => (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text color={isOpen ? 'yellow' : undefined} bold={isOpen}>
                    {question.header !== undefined ? `[${question.header}] ` : ''}
                    {question.text}
                  </Text>
                  {question.options !== undefined && (
                    <Text dimColor>options: {question.options.join(' · ')}</Text>
                  )}
                </Box>
              ))}
              {entry.answer !== undefined && (
                <Box paddingLeft={4}>
                  <Text>
                    {'↳ '}
                    {entry.answer}
                    <Text dimColor>
                      {entry.answeredAt !== undefined ? `  ${relativeTime(entry.answeredAt, now)}` : ''}
                    </Text>
                  </Text>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}

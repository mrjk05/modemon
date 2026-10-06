# question-log

Makes it obvious when Claude is waiting on you, and keeps a log of every question and your answer.

- **Captures AskUserQuestion**: each dialog's questions, headers and options, and what you chose. Multi-select answers are comma-joined, and text typed under "Other" is logged as `Other: "..."`.
- **Detects questions in replies**: when a reply's final paragraph asks you something ("Should I also add a test?"), it is logged as an open question. Your next prompt answers it, and its first 200 characters are kept as the answer.
- **Highlight**: a reply detected as a question is drawn in a round, coloured box with a `? Question for you` header. The box is yellow while the question is open and magenta once you have answered.
- **Log pane**: `/questions` lists every question in order (newest at the bottom). Open ones are highlighted, answers are indented under their question, and each has a relative timestamp.
- **Status line**: `? 2 open` under the prompt while anything is unanswered. It clears at zero.

## Install

```
/plugin install question-log --marketplace mrjk05/modemon
```

Answer `y` to add the marketplace, then pick a scope.

## What it looks like

A reply that ends with a question:

```
╭──────────────────────────────────────────────────────────────╮
│ ? Question for you                                           │
│ I fixed the relative path and the suite passes.              │
│                                                              │
│ Should I also add a regression test?                         │
╰──────────────────────────────────────────────────────────────╯
```

The `/questions` pane:

```
┌ Questions ───────────────────────────────────────────────────┐
│ 3 questions · 1 open                                         │
│                                                              │
│ ✓ answered  12m ago · AskUserQuestion                        │
│   [Auth] Which auth method?                                  │
│   options: OAuth · API key                                   │
│     ↳ Other: "magic links"  11m ago                          │
│                                                              │
│ ✓ answered  6m ago · in reply                                │
│   Want me to push the branch?                                │
│     ↳ yes, and open a PR  5m ago                             │
│                                                              │
│ ? open  just now · in reply                                  │
│   Should I also add a regression test?                       │
└──────────────────────────────────────────────────────────────┘
  ? 1 open
```

## Commands

| Command | What it does |
| --- | --- |
| `/questions` | Opens the log pane, or closes it if it is already open |
| `/questions clear` | Empties the log and clears the status line |

## Config

These show up in `/config` under question-log:

| Field | Default | What it does |
| --- | --- | --- |
| `detectQuestions` | `true` | Log replies whose final paragraph asks you something |
| `highlight` | `true` | Draw detected-question replies in the coloured, bordered box |

## How detection works

Only the **end** of the main conversation's final reply in a turn counts. The detector reads the last paragraph. If that paragraph is a list, it also reads the paragraph that introduces the list. The reply counts as a question when that block ends on a question. A short closer after the question ("Let me know.") still counts, and so does a list of options right after the question.

These never count:

- questions in fenced code blocks, inline code, block quotes, tables or quoted text
- URLs with `?` in them
- headings such as `## Why does this fail?`
- rhetorical questions that the reply answers itself ("Why does this fail? Because ...")
- questions earlier in the reply

Subagent turns and interrupted turns are ignored. A slash command, or a prompt that a plugin or a scheduled task sends, does not answer an open question. Only a prompt you send yourself does (typed, or sent through Remote Control or the SDK).

## Limitations

- Detection is a heuristic. A question with no `?` ("Let me know which you prefer.") is missed. A reply that ends on a code block after its question is treated as not asking.
- The answer to a detected question is your next prompt, whether or not it actually answers the question.
- The highlight replaces the engine's drawing of that reply block with this plugin's own box and Markdown, so the reply's leading bullet is not drawn. The hook cannot wrap the engine's own rendering. `AssistantMessage` has no `isExpanded` prop in this build, so the box shows in the ctrl+o view too. Only the reply's last text block is boxed.
- Rows are matched to log entries by their transcript id where it is known, and otherwise by a hash of the reply's text. Two replies with identical text are both boxed.
- The AskUserQuestion dialog itself is left alone: its render props carry only the questions, so there is no safe way to add an accent without redrawing the engine's dialog.
- The log lives in session state. It survives hot reloads, is emptied by `/clear`, and is not kept across sessions. It holds the last 200 entries.
- Relative timestamps in the pane refresh whenever the log changes, not on a timer.
- Built against Claude Code 2.1.290. The mods API is early access and may change between releases.

## License

MIT

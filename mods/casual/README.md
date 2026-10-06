# casual

Short, conversational replies. Claude talks like a friendly senior teammate on Slack ("hey, so here's where we're at"): 1 to 4 short sentences, outcome first, plain words, no headers or bullet walls unless you ask. It stays exact about file paths, commands, numbers and errors, and it never hides a failure or skips a confirmation. Tool-call noise in the transcript folds into one dim line per call or group.

## Before / after

Before:

```
## Summary

I've completed the requested changes. Here's an overview of what was done:

### Changes Made
- **src/auth.ts**: Updated the token expiry validation logic
- **tests/auth.test.ts**: Verified existing tests

### Testing
All tests are passing.

Let me know if you'd like any further modifications!
```

After:

```
Fixed it: the expiry check in `src/auth.ts` was inverted, so expired tokens got
through. `npm test` passes now (48/48). Want me to add a regression test too?
```

And the transcript, with `collapseTools` on:

```
· ran 4 tools (Read ×2, Grep, Edit) · 1 failed: Grep "foo("
· Bash npm test · 52 lines
· Edit src/auth.ts · +1 −1
```

## Install

```
/plugin install casual --marketplace mrjk05/modemon
```

Answer `y` to add the marketplace, then pick a scope. Casual mode is on as soon as it's installed; the status line shows `☺ casual`.

## Commands

| Command | What it does |
| --- | --- |
| `/casual on` | Turn casual mode on |
| `/casual off` | Back to Claude Code's default style and transcript |
| `/casual brief` | Even shorter: 1 or 2 sentences, no small talk (turns it on) |
| `/casual chill` | The default friendly 1 to 4 sentences (turns it on) |
| `/casual status` (or `/casual`) | Show the current mode |

Your choice is kept in the plugin's store, so it carries over to new sessions.

## Config

In `/config` (or `pluginConfigs.casual.options` in settings):

| Option | Values | Default | Notes |
| --- | --- | --- | --- |
| `verbosity` | `chill`, `brief` | `chill` | The starting verbosity. Once you run `/casual brief` or `/casual chill`, that choice wins. |
| `collapseTools` | `true`, `false` | `true` | Fold finished tool rows into one-liners while casual is on. |

## What it does

- **Style** (`prompt.compose`): appends a `casual:style` section after the engine's own system prompt sections. It covers length, leading with the outcome, prose over markdown, not narrating tool calls, exactness, reporting failures, and keeping confirmations and caveats. It also tells Claude to drop the style when you ask for detail or a write-up, and when writing things that aren't chat (commit messages, PR descriptions, subagent reports, files). It's skipped for in-process teammates.
- **Collapse** (`ui.render`):
  - `ToolGroup`: a folded run of reads and searches becomes `· ran N tools (Read ×2, Grep, …)`. Failed calls are added in red. Expanding the group (ctrl+o in the non-fullscreen transcript, or `--verbose`) shows the engine's own rows.
  - `ToolUse`: a finished call becomes `· Bash npm test · 12 lines`, or a red `✗ Bash npm test` if it failed. Running calls are left alone.
  - `ToolResult`: hidden on success, since the row above already says how it went. On error it's one red line with the first line of the error.
  - Never folded: `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode`, `TodoWrite`, `SendUserMessage` and `SendUserFile`. Anything still running is left alone too. The permission dialog is drawn by the engine only, so this mod can't touch it.

## Limitations

- **Thinking can't be hidden by this mod.** Thinking blocks don't go through a hookable component in this build (`AssistantMessage` only carries reply text). Claude Code already keeps thinking out of the default transcript and shows it under ctrl+o.
- **ctrl+o and single tool rows.** In this build, `ToolUse` and `ToolResult` don't say whether they're drawn in the ctrl+o transcript (only `ToolGroup` and `UserMessage` have `isExpanded`). So a single tool call stays folded in ctrl+o too, as does each call in the fullscreen ctrl+o view, which draws groups as separate rows. If a future build adds `isExpanded` to those rows, the mod already respects it. For now, use `/casual off` or set `collapseTools` to `false` to see full tool output, including Edit diffs and Bash output.
- **Style is guidance, not a guarantee.** The model may still write a longer answer when the content calls for it, and the prompt allows that on purpose.
- **Subagents.** The `prompt.compose` input doesn't say whether a prompt is for a subagent, so the section may reach subagents too. Its text tells the model that reports for another agent follow their own conventions.
- **Custom output styles.** The section is appended alongside any output style you've chosen. If they conflict, use `/casual off`.
- Built against Claude Code 2.1.290. The mods API is early access and may change.

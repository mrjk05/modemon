# agent-deck

A side pane listing every subagent of your Claude Code session as a card: what it is, what model it runs on, what it was asked, how long it has run and what it is doing right now.

```
┌ Agents ─────────────────────────────────────────┐
│ 2 running · 1 done · 1 failed                 4 │
│                                                 │
│ ● Find auth middleware                   1m 12s │
│   Explore · haiku 4.5                           │
│   Look for where the JWT is verified and rep…   │
│   14 tools · ▸ Grep "verifyJwt"                 │
│                                                 │
│ ● Write unit tests for lib.ts               38s │
│   general-purpose · opus 5.5                    │
│   Add tests covering formatElapsed and the p…   │
│   6 tools · ▸ Edit tests/lib.test.ts            │
│                                                 │
│ ✓ Summarise README                          21s │
│   Explore · haiku 4.5                           │
│   Read README.md and summarise it in three b…   │
│   3 tools · last Read README.md                 │
│                                                 │
│ ✗ Migrate config                             4s │
│   general-purpose · sonnet 4.5                  │
│   1 tool · last Bash npm run migrate            │
│   stopped                                       │
│                                                 │
│ /agents clear removes finished agents           │
└─────────────────────────────────────────────────┘
⚙ 2 agents running
```

Each card shows:

- **Status**: `●` running (accent colour), `✓` done (green), `✗` failed (red). Finished cards are dimmed and stay until you clear them.
- **Title**: the Agent call's `description`.
- **Agent type and model**: the subagent type (`Explore`, `general-purpose`, a plugin's agent) and the model it resolved to (`haiku 4.5`), or the alias asked for until the resolved one is known.
- **Prompt summary**: the prompt folded to one line.
- **Elapsed time**: ticks every second while the agent runs, then freezes at its final duration.
- **Tool calls**: how many tools the subagent has called, and the one running now (`▸ Grep "foo"`) or the last one (`last Edit src/x.ts`).

While any subagent runs, a status line under the prompt reads `⚙ 2 agents running`.

On the desktop app the same cards are drawn as bordered boxes coloured by status.

## Surfaces: terminal, desktop and mobile

| Surface | What you get |
| --- | --- |
| Terminal | The side pane (docked in the fullscreen layout, inline above the prompt on the main screen) and the status line. |
| Desktop (Code tab) | The same pane, with each card a bordered box coloured by status. |
| Claude mobile app | No pane: the phone never docks one. `/agents` (or `/agent-deck`) answers **inline**, as compact cards in the command's output row, and the status line names the newest running agent. |

The inline deck is used whenever the pane cannot be shown: `/agents` sent from the phone (a Remote Control message while the mobile app is attached, or a session only phones are watching), or `$.ui.open` answering `isPlaced: false` because no attached surface places panes. Each compact card fits the screen's width:

```
Agents · 2 running · 1 done
as of 14:03:27

● Find auth middleware        1m 12s
  haiku 4.5 · Explore
  ▸ Grep "verifyJwt"

✓ Summarise README               21s
  haiku 4.5 · Explore
  last Read README.md
```

- **Live, with a stamp.** The row reads the cards from `$.state`, which subscribes it, so it redraws as agents start, call tools and finish, and ticks every second while any run. `as of HH:MM:SS` is when the cards last changed. The text behind the row (what the model reads, and what a surface shows if it draws the plain text) is a snapshot taken when you ran the command, stamped the same way. Every inline deck row in the transcript shows the current deck, not the deck at the time it was asked.
- **Status line on the phone.** While the mobile app is attached, the status line switches from `⚙ 2 agents running` to a short variant naming the newest running agent: `⚙ 2 · Find auth middleware` (title cut to 24 characters). It switches back when the phone detaches.
- Every tree uses only `Box` and `Text`, which every surface draws.

## Install

```
/plugin install agent-deck --marketplace mrjk05/modemon
```

Answer `y` to add the marketplace, then pick a scope.

## Commands

| Command | What it does |
| --- | --- |
| `/agents` | Toggle the pane (on the phone: show the deck inline) |
| `/agents open` / `/agents close` | Open or close it |
| `/agents clear` | Remove finished (done and failed) cards |
| `/agent-deck [clear\|open\|close]` | The same, under the mod's own name |

The deck opens by itself the first time a subagent spawns, but only where it docks beside the transcript as a sidebar: the fullscreen layout, with a terminal at least 144 columns wide. It does this once per session. Elsewhere, open it with `/agents`.

## Config

Set these in `/config` (or under `pluginConfigs["agent-deck"].options` in settings):

| Option | Default | What it does |
| --- | --- | --- |
| `autoOpen` | `true` | Open the deck when the first subagent spawns (sidebar layouts only) |
| `statusLine` | `true` | Show `⚙ N agents running` while subagents run (`⚙ N · <newest title>` with a phone attached) |

## How it works

- `tool.call` for the `Agent` tool (and `Task`, its older name) makes a card when the call starts and reads its result. A background agent answers `async_launched` with its id and resolved model. A foreground agent answers `completed` with its tool count.
- `agent.spawn` links the card to the agent id and the resolved model, including spawns made by other plugins.
- Every `tool.call` that carries an `agentId` is one of a subagent's own tool calls. It feeds the tool count and the current or last tool.
- `turn.complete` with an `agentId` and `classic.SubagentStop` end the card: done on an answer, failed on an error, refusal or interrupt.
- `$.agent.list()` is checked every 5 seconds while agents run, to catch agents that ended or were killed without an event the deck saw.
- All cards live in `$.state`, so editing or hot-reloading the mod keeps the deck.

## Limitations

- `/agents` is also the name of a retired, hidden built-in command. The mod answers it in place of that stub, and `/agent-deck` always works as an alias.
- The deck learns whether the surface docks panes from what it draws (the spinner during a turn, or the command's own presentation). Until it has seen one, it does not open by itself.
- Agents launched remotely (`isolation: "remote"`) are marked done with the note "running in the cloud", because their progress is not visible to the session.
- A subagent's tool calls are only counted from when the mod is loaded. Cards for agents found only through `$.agent.list()` start with no prompt summary and no tool history.
- Teammates (named agents that idle between turns) show as done between turns and switch back to running when they call a tool again.
- The command cannot tell which screen typed it: a Remote Control (`bridge`) message with the mobile app attached counts as the phone. A message from a web client while a phone is also attached is answered inline too.
- The status line is one line for every surface, so with a phone attached the terminal shows the phone's variant as well.
- `/agents clear` and `/agents close` work from the phone; `close` closes the pane on the terminal or desktop, if one is open.
- Built against Claude Code 2.1.290. The mods API is early access and may change between releases.

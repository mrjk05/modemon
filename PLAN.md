# modemon: plan

Open-source (MIT) [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview).
This repo is a single marketplace. Each mod lives in `mods/<name>/` and installs separately:

```
/plugin install <mod> --marketplace mrjk05/modemon
```

Built against Claude Code **2.1.290** (the mods API is early access and may change between releases).

## Conventions (every mod)

- `mods/<name>/.claude-plugin/plugin.json`: name, version `0.1.0`, description, author `mrjk05`, license `MIT`; `"types": "./types/index.d.ts"` when it keeps `$.state`.
- `mods/<name>/hooks/hooks.json` → `{ "modules": ["./register.tsx"] }`.
- `mods/<name>/hooks/register.tsx`: the hooks module. Pure helpers go in `hooks/lib.ts` so they are unit-testable.
- `mods/<name>/tests/*.test.ts`: run with `claude plugin test mods/<name>`.
- `mods/<name>/README.md`: what it does, install line, commands, config, limitations.
- Settings go through `userConfig` in plugin.json (they show up in the config menu) instead of hard-coded constants.
- Render on every surface (`terminal`, `desktop`); degrade gracefully where an element is missing.
- `claude plugin validate`, `claude plugin test` and `tsc` must be clean before pushing.

## The mods

### 1. `context-bar`: live context window
- **Band above the prompt**: a horizontal bar segmented and coloured by category (system prompt, tools, MCP tools, memory files, skills, agents, messages, free space, autocompact buffer), from `$.session.usage({ breakdown: 'summary' })`, refreshed after each turn and compaction.
- **50% marker** splits the bar into **ACTIVE** (left) and **PASSIVE** (right). Also a marker at the auto-compact threshold.
- Label: `142k / 200k · 71% · passive` plus a legend.
- **One-time toast per session** when usage first crosses 50%: "Past 50%, consider /compact or a fresh session". Re-armed after a compact or clear.
- `/context-bar` toggles the band. Status line fallback: `ctx 71%`.
- Exact `tokens/percent` from the last API response is the headline number; the category split is an estimate (the API says so).

### 2. `pii-shield`: redact PII on screen while recording
- **Screen only**: rewrites what's drawn (`ui.render` on AssistantMessage, UserMessage, ToolUse, ToolResult, CommandOutput). The model and the transcript keep real values.
- **Masks**: emails, phone numbers, IPv4/IPv6; card numbers (Luhn-checked), IBAN, US SSN, bank account/sort codes; secrets (`sk-…`, `ghp_…`, AWS `AKIA…`, JWTs, `Bearer …`, private-key blocks, `KEY=value` env assignments with secret-ish names); names from a user-supplied list plus the OS/git username; home-directory usernames in paths (`/Users/jins/` → `/Users/████/`).
- **Activation**: `/redact on|off|auto`. In `auto` (default) it polls every 5s via `$.process.run` for known recorders/sharers (QuickTime, `screencaptureui`, OBS, Loom, CleanShot, Kap, ScreenFlow, Zoom sharing (`CptHost`), Screen Studio, Camtasia, Linux: `wf-recorder`, `obs`, `simplescreenrecorder`, `kooha`) and turns redaction on. It never turns itself off automatically while a recorder was seen this session (sticky), unless the user runs `/redact off`.
- Status badge: `● REDACTING` / `○ pii-shield`.
- **Limit (documented)**: browser-based sharing (Meet, Teams web) is not detected. macOS has no public "am I being captured" API, so detection is heuristic. Use `/redact on` before recording to be sure.

### 3. `agent-deck`: subagent side pane
- Side pane (`/agents` toggles it; opens by itself when the first subagent spawns and the terminal is wide enough).
- One card per agent: status dot (running/done/failed), **model**, **agent type**, **title** (the Agent call's `description`), a one-line **summary** of its prompt, elapsed time, tool-call count, **current/last tool** (e.g. `Grep "foo"`).
- Data: `tool.call` for `Agent`/`Task` (start and result), `agent.spawn`, `tool.call` events carrying `agentId`, `$.agent.list()`.
- Finished agents stay (dimmed) until `/agents clear`.

### 4. `checklist`: persistent per-repo checklist
- Stored in `$.store` keyed by repo root (survives sessions).
- **Model tool** `checklist` (`list | add | start | done | remove | clear-done`) so Claude can track and work through items.
- **Slash command** `/checklist [add <text> | done <n> | undo <n> | rm <n> | clear]` for you.
- **Band above prompt**: `☑ 3/7 ▕██████░░░░▏ next: Write tests`, with a pane view for the full list.
- **Keep-going nudge**: a short system-prompt section tells Claude the list exists and to work through open items, marking each done.

### 5. `casual`: short, conversational replies
- `/casual on|off` (default on once installed).
- **Style**: adds a system-prompt section (`prompt.compose`): talk like a teammate on Slack; 1–4 short sentences; lead with what happened; no headers or bullet walls unless asked; still precise about files and commands.
- **Collapse**: the transcript hides thinking and folds tool-call noise (`ToolGroup`/`ToolUse` compact rows) while casual mode is on; ctrl+o still expands.
- Config: `verbosity: "chill" | "brief"`.

### 6. `notify`: desktop notifications
- Fires when: **permission/input needed** (`classic.Notification`, AskUserQuestion); **turn finished** after more than `minTurnSeconds` (default 30); **errors** (API errors, failed turns); **subagent done**.
- Delivery: macOS `terminal-notifier` if installed (click focuses the terminal), otherwise `osascript display notification … sound name "Glass"`; Linux `notify-send`. Via `$.process.run`.
- Config: toggles per trigger, `minTurnSeconds`, `sound`, `onlyWhenUnfocused`. `/notify test` sends a sample.

### 7. `question-log`: highlighted questions and a Q&A log
- Captures **AskUserQuestion** (questions, options, answers) and **detected questions**: assistant replies whose final paragraph asks the user something.
- **Highlight**: detected-question assistant messages get a bordered, coloured box with a `?` badge.
- **Log pane** via `/questions`: every question in order, with answer or `open`, timestamps.
- **Status line**: `? 2 open`. A detected question counts as answered when you send your next prompt.

## Delivery
All seven built in parallel, each validated, tested and type-checked, then pushed to `main`. Per-mod deviations and limitations are listed in each mod's README.

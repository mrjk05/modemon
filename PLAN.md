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

## Surfaces: terminal, desktop and mobile

Every mod must work on the **terminal**, **desktop** (Code tab) and the **Claude mobile app** (watching a cloud or Remote Control session). Mods run in the engine, wherever the session runs. The phone only draws what they hand it.

- **Mobile elements**: `Box`, `Text`, `Button`, `Svg`, `Link`, `Code`, `Markdown`. No `Input`, `Select`, `Raster`, `Image`, `Client`. Narrow on `e.surface` before using anything outside that set.
- **Not raised on mobile**: `AbovePrompt`, `PromptHint`, `SessionMode`. Mobile reports `viewport.isFullscreen === false`, so it never docks a pane.
- **Mobile fallbacks**, in order of preference:
  1. `$.ui.status(text)`: a short, emoji-friendly status entry.
  2. Slash-command output drawn as a tree via `ui.render` on `{ component: 'CommandOutput', props: { command: '<cmd>' } }`. Use `Markdown` or `Box`/`Text`, compact, sized to `e.viewport.columns`.
  3. `$.ui.toast` for one-off nudges.
  4. When `$.ui.open` answers `isPlaced: false`, answer the command inline instead.
- **Sharing the band** (`AbovePrompt`, one instance for all plugins): never swallow it. Draw your part, then `const below = await next(e)` and stack the two (yours first) in a column `Box`, leaving `below` out when it draws nothing. Every band mod does this, so they all show together.
- **Tests**: every UI mount test loops over `['terminal', 'desktop', 'mobile'] as const` for components that mobile raises (`Pane`, `CommandOutput`, transcript rows), and over terminal and desktop for `AbovePrompt`. At least one test proves the mobile fallback (status text or command output).

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
- **Phone push** (optional): set `ntfyTopic` (and optionally `ntfyServer`, default `https://ntfy.sh`) and every notification is also POSTed there, so the ntfy app on your phone buzzes. This works from cloud sessions too, where there is no desktop.

### 7. `question-log`: highlighted questions and a Q&A log
- Captures **AskUserQuestion** (questions, options, answers) and **detected questions**: assistant replies whose final paragraph asks the user something.
- **Highlight**: detected-question assistant messages get a bordered, coloured box with a `?` badge.
- **Log pane** via `/questions`: every question in order, with answer or `open`, timestamps.
- **Status line**: `? 2 open`. A detected question counts as answered when you send your next prompt.

### 8. `project-color`: a colour per project
- **Stripe above the prompt**: a full-width bar in the project's colour with the project name, e.g. `▌ modemon ▐` on a solid colour background. It is shown on top of any other band and composes with them via `next(e)`.
- **Colour choice**: picked automatically from a 12-colour palette, the same colour every time for the same repo, and readable in light and dark themes. `/color <name|#hex>` pins a colour for the repo (saved in `$.store`), `/color auto` resets it, `/color` lists the palette.
- **Mobile**: the band is not raised there, so the status line shows `● modemon` with a colour emoji (🟣🔵🟢🟡🟠🔴 …) matched to the palette.

### 9. `deploy-deck`: deployments panel and live status tracker
- **Providers**: GitHub (Actions workflow runs plus Deployments and environments), Vercel (deployments, preview and production), Cloudflare (Pages deployments with their stages, Workers versions and deployments), Render (service deploys). Each is an adapter behind one interface: `detect(repo) → targets`, `list(target) → Deploy[]`, `normalize → { provider, project, env, version/commit, branch, stage, state, startedAt, finishedAt, url, logsUrl }`.
- **Auth**: one read-only token per provider in `sensitive` userConfig fields (`githubToken`, `vercelToken`, `vercelTeamId`, `cloudflareToken`, `cloudflareAccountId`, `renderToken`), never logged or drawn. A missing token falls back to a logged-in CLI where one exists (`gh api`, `vercel`, `wrangler`) via `$.process.run`. **Read-only**: GET requests only.
- **Scope**: auto-detected from the repo (git remote → GitHub owner/repo; `.vercel/project.json` or `vercel.json`; `wrangler.toml`/`wrangler.jsonc`; `render.yaml`), plus extra targets pinned in settings (`targets`, e.g. `vercel:my-app, cloudflare-pages:site, render:srv-123`).
- **Tracker**: polls every 10s while any deploy is in progress and every 2 min when idle, backing off on errors and rate limits. Stages are normalised to `queued → building → deploying → live ✓ / failed ✗ / canceled`.
- **UI**:
  - Band above the prompt only while something is in flight: one row per active deploy with a stage pipeline (`● queued ━ ◉ building ━ ○ deploying ━ ○ live`) and elapsed time. It composes with other bands via `next(e)`.
  - `/deploys` opens a panel with every target's latest deploys (version/commit, branch, env, state, age, URL), or an inline card on mobile.
  - A toast when a deploy finishes, and a status line `🚀 vercel building 1:12` / `✓ prod live v1.4.2`.
- `/deploys refresh`, `/deploys add <provider:id>`.

### 10. `decision-log`: decisions you can go back to
- **Storage**: ADR markdown files committed in the repo, `docs/decisions/NNNN-slug.md` (folder configurable), in MADR style with front matter (`status`, `date`, `deciders`, `supersedes`, `superseded-by`, `tags`, `files`) and sections Context, Decision, Alternatives considered, Consequences.
- **Capture**: Claude gets a `decision` tool (`record`, `list`, `search`, `get`, `supersede`, `set-status`) and a short system-prompt note to record real, consequential decisions (not trivia) as they happen, with the why and the alternatives. You add your own with `/decide <title> — <why>`.
- **Lifecycle**: `proposed | accepted | superseded | rejected`. `supersede` links the old and new records both ways.
- **Recall**: `/decisions` lists them (pane on terminal and desktop, inline card on mobile) with buttons to open one in full. `/decisions <n>` shows one. Claude can `search` and `get` them when it needs context.
- An index `docs/decisions/README.md` is regenerated on each change.

## Delivery
All seven built in parallel, each validated, tested and type-checked, then pushed to `main`. Per-mod deviations and limitations are listed in each mod's README.

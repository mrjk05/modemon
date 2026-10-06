# modemon

Open-source **mods** for [Claude Code](https://code.claude.com/docs/en/plugins/mods/overview): small plugins of function hooks that add live panes, bands, status badges and behaviours to your Claude Code session.

| Mod | What it does |
| --- | --- |
| [`context-bar`](mods/context-bar) | Live, colour-segmented context window bar above the prompt, split into **active** (first 50%) and **passive** (second 50%), so you know when to compact or start fresh. |
| [`pii-shield`](mods/pii-shield) | Masks emails, names, phone and account numbers, card numbers, API keys and home-dir usernames **on screen** while you screen-record. Auto-detects common recorders. |
| [`agent-deck`](mods/agent-deck) | Side pane with a live card per subagent: model, type, task title, summary, elapsed time, current tool. |
| [`checklist`](mods/checklist) | Persistent per-repo checklist that you and Claude share. Claude gets a `checklist` tool and keeps working through open items. |
| [`casual`](mods/casual) | Short, conversational replies ("hey, here's where we're at") and a quieter transcript. |
| [`notify`](mods/notify) | Native desktop notifications when Claude needs input, finishes a long turn, hits an error, or a subagent completes. |
| [`question-log`](mods/question-log) | Highlights every question Claude asks you and keeps a `/questions` log of questions and answers. |
| [`project-color`](mods/project-color) | Gives each project its own colour: a stripe above the prompt and a colour emoji in the status line, so you can tell sessions apart at a glance. |
| [`decision-log`](mods/decision-log) | Records decisions as ADRs in `docs/decisions/` so you and Claude can go back to them later. |

## Install

In a Claude Code terminal session:

```
/plugin install <mod> --marketplace mrjk05/modemon
```

for example `/plugin install context-bar --marketplace mrjk05/modemon`. Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

Each mod is independent. Install the ones you want.

## Works on terminal, desktop and phone

Mods run inside Claude Code wherever the session runs (your Mac or a cloud session), and every surface draws what they hand it: the terminal, the desktop app's Code tab, and the Claude mobile app when you watch a session from your phone. The mobile app draws fewer elements and has no band above the prompt or docked panes, so each mod falls back to a status-line entry and inline command output there. Each mod's README has a *Surfaces* section saying what shows where.

## Develop

```bash
# load a mod from disk for one session (hot-reloads on save)
claude --plugin-dir ./mods/context-bar

# check and test
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
```

Built against Claude Code 2.1.290. The mods API is early access and may change between releases. See [PLAN.md](PLAN.md) for the design of each mod.

## License

[MIT](LICENSE)

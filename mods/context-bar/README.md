# context-bar

A live view of the context window in the band above the prompt. The bar is split into colour-coded segments by category (system prompt, tools, memory files, skills, agents, messages, free space, the auto-compact buffer), using the same colours as `/context`. A divider at 50% separates the **ACTIVE** half from the **PASSIVE** half, and a second mark shows where auto-compaction will run.

```
◆ context  142k / 200k · 71% · passive                       split estimated
████████████████████████████████████┃██████████████░░░░░░░░░╎▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
               ACTIVE               ┃              PASSIVE   ▲ auto-compact
█ System prompt 3k  █ System tools 12k  █ Memory files 2k  █ Messages 125k
░ Free space 25k  ▒ Autocompact buffer 33k
```

- The **headline** (`142k / 200k · 71%`) is exact: it comes from the input tokens of the last API response. It turns green, then yellow at 50%, then red at 80%.
- The **category split** is an estimate. It comes from `$.session.usage({ breakdown: 'summary' })`, which is computed locally and makes no network request.
- Before the first response of a session, or right after a compaction, the headline shows the estimate (`~17k / 200k · estimate, no response yet`).
- The bar fits the width of the band. It refreshes after every turn, after a compaction and after `/clear`.
- The first time usage passes 50% in a session, a toast says: *Past 50%, consider /compact or a fresh session*. The toast is re-armed after `/compact`, an auto-compaction or `/clear`.
- Bands narrower than 24 columns show a single line (`ctx 142k / 200k · 71% · passive`). Short bands drop the legend first, then the label row.

Works on the terminal and in the desktop app's Code tab. Surfaces that have no band above the prompt (mobile, VS Code) get the status line instead (see `statusLine` below).

## Install

```
/plugin install context-bar --marketplace mrjk05/modemon
```

Answer `y` to add the marketplace, then pick a scope.

## Commands

| Command | What it does |
| --- | --- |
| `/context-bar` | Shows or hides the band. |
| `/context-bar on` / `/context-bar off` | Shows or hides it explicitly. |

When the band is hidden, the status line under the prompt shows `ctx 71%` instead.

## Config

Set these from the `/config` menu, or under `pluginConfigs["context-bar"].options` in settings.

| Field | Default | Meaning |
| --- | --- | --- |
| `legend` | `true` | Show the per-category legend under the bar. |
| `warnAtHalf` | `true` | Show a toast once per session when usage passes 50%. |
| `statusLine` | `auto` | When to pin `ctx 71%` under the prompt. `auto` pins it while the band is hidden or a surface without the band is attached, `always` pins it all the time, `off` never pins it. |

## Limitations

- The category split is the engine's local estimate (the `summary` breakdown), so the segments may not add up exactly to the headline number.
- The bar's scale is the compaction window that the breakdown reports. In the rare setups where that window is smaller than the model's window, the bar and the headline percentage measure against different totals.
- A marker drawn on top of a segment covers that segment's cell, so a category that gets only one cell can be hidden by the 50% divider or the auto-compact mark.
- On narrow bands the auto-compact label is shortened to a bare `▲`.
- Built against Claude Code 2.1.290. The mods API is in early access and may change between releases.

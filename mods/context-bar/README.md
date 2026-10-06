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

- The band is shared: other band mods (checklist, project-color, ...) draw beneath it, stacked in one column, so they all show together.

## Surfaces

| Surface | Band above the prompt | `/context-bar` card | Status line |
| --- | --- | --- | --- |
| Terminal | Yes | Yes | `ctx 71%` while the band is hidden |
| Desktop (Code tab) | Yes | Yes | `ctx 71%` while the band is hidden |
| Claude mobile app | No, the app does not raise it | Yes, inline in the transcript | `🟡 ctx 71% · passive` whenever a phone is attached |
| VS Code | No | Yes | Same as mobile |

- **Mobile status line**: while a phone (or any surface without the band) is attached, the status line shows the percentage with a zone dot: 🟢 under 50%, 🟡 from 50%, 🔴 from 80% (⚪ before the first response). It appears when the phone attaches and goes back to the plain form (or away) when it detaches. The status line is one entry for the session, so the terminal shows the same text while a phone is attached.
- **Context card**: `/context-bar` draws a compact card in its output row: the headline, the segmented bar sized to the transcript's width (with the 50% divider and auto-compact mark), and the four largest categories with their share. It is the way to see the full picture on a phone.

```
◆ context  142k / 200k · 71% · passive
██████████████████████████┃████████░░░░░╎▒▒▒▒▒▒▒▒▒▒
         ACTIVE           ┃     PASSIVE   ▲ auto-compact
■ Messages 125k · 63%
■ System tools 12k · 6%
■ System prompt 3k · 2%
■ Memory files 2k · 1%
Category split is estimated.
```

## Install

```
/plugin install context-bar --marketplace mrjk05/modemon
```

Answer `y` to add the marketplace, then pick a scope.

## Commands

| Command | What it does |
| --- | --- |
| `/context-bar` or `/context-bar show` | Draws the context card inline (every surface, mobile included). The model reads a one-line summary of it. |
| `/context-bar on` / `/context-bar off` | Shows or hides the band above the prompt (terminal and desktop). |
| `/context-bar toggle` | Flips the band. |

When the band is hidden, the status line under the prompt shows `ctx 71%` instead.

Changed in this version: a bare `/context-bar` used to toggle the band. It now shows the card; use `toggle` for the old behaviour.

## Config

Set these from the `/config` menu, or under `pluginConfigs["context-bar"].options` in settings.

| Field | Default | Meaning |
| --- | --- | --- |
| `legend` | `true` | Show the per-category legend under the bar. |
| `warnAtHalf` | `true` | Show a toast once per session when usage passes 50%. |
| `statusLine` | `auto` | When to pin `ctx 71%` under the prompt. `auto` pins it while the band is hidden or a surface without the band is attached (mobile, VS Code: `🟡 ctx 71% · passive`), `always` pins it all the time, `off` never pins it. |

## Limitations

- The category split is the engine's local estimate (the `summary` breakdown), so the segments may not add up exactly to the headline number.
- The bar's scale is the compaction window that the breakdown reports. In the rare setups where that window is smaller than the model's window, the bar and the headline percentage measure against different totals.
- A marker drawn on top of a segment covers that segment's cell, so a category that gets only one cell can be hidden by the 50% divider or the auto-compact mark.
- On narrow bands the auto-compact label is shortened to a bare `▲`.
- Mobile has no band above the prompt, so there is no always-on bar there: the status line and the `/context-bar` card stand in for it. The card is drawn with coloured text blocks, not an SVG, so it looks the same on every surface; how evenly the blocks line up depends on the app's font.
- The card shows the latest measurement whenever its row is redrawn, not a frozen copy from when the command ran.
- Built against Claude Code 2.1.290. The mods API is in early access and may change between releases.

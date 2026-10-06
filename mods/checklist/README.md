# checklist

A persistent, per-repo checklist that you and Claude share. Claude gets a `checklist` tool to plan and tick off work, you get `/checklist`, a progress band above the prompt, a status line, and a pane with the full list. It works on the terminal, the desktop Code tab and the Claude mobile app.

```
 ╭─ Checklist ─────────────────────────────────────────╮
 │ ☑ 3/7 ▕████░░░░░░▏ 4 open                            │
 │ ☑ #1 Sketch the data model                        ✕  │
 │ ☑ #2 Add the migration                            ✕  │
 │ ☑ #3 Wire up the API route                        ✕  │
 │ ◐ #4 Write tests                                  ✕  │
 │ ☐ #5 Update the README                            ✕  │
 │ ☐ #6 Handle the empty state                       ✕  │
 │ ☐ #7 Ship it                                      ✕  │
 │ [ Clear done ]                                       │
 ╰──────────────────────────────────────────────────────╯
 ☑ 3/7 ▕████░░░░░░▏ next: Write tests                [-]
 ╭──────────────────────────────────────────────────────╮
 │ >                                                    │
 ╰──────────────────────────────────────────────────────╯
```

## Install

```
/plugin install checklist --marketplace mrjk05/modemon
```

Answer `y` to add the marketplace, then pick a scope. Built against Claude Code 2.1.290; the mods API is early access and may change between releases.

## Commands

| Command | What it does |
| --- | --- |
| `/checklist` | Opens the pane, or closes it if it is already open. Where no pane can be placed (mobile, or a narrow terminal) it shows the list inline instead |
| `/checklist add <text>` | Adds an item |
| `/checklist done <n>` | Marks item `n` done (`done 2,3` marks several) |
| `/checklist undo <n>` | Puts item `n` back to todo |
| `/checklist rm <n>` | Removes item `n` |
| `/checklist clear` | Removes every done item |
| `/checklist start <n>` | Marks item `n` as in progress |
| `/checklist list` | Shows the list inline, with tappable ticks |

`n` is the item number shown as `#n`. Numbers stay the same when other items are removed. New items get the next number after the highest one in the list.

In the pane and in the inline list, click or tap (or focus and press Enter on) `☐` / `◐` / `☑` to tick or untick an item, `✕` to remove it, and `Clear done` to drop finished items.

## Surfaces

| | Terminal | Desktop (Code tab) | Mobile app |
| --- | --- | --- | --- |
| Band above the prompt | yes | yes | not raised there |
| Status line `☑ 3/7 · next: …` | yes | yes | yes |
| Pane | yes (docked or inline) | yes | never placed |
| `/checklist` inline list with tappable ticks | when the pane cannot be placed, and for `/checklist list` | same | always |
| Tool, slash command, nudge | yes | yes | yes |

- **Band.** It shares the row with other band mods (context-bar, project-color, ...): it draws its line, then asks the hooks beneath (`next(e)`) and stacks what they draw under it in a column. When they draw nothing, the checklist line is drawn alone.
- **Status line.** Shown while the list has items, on every surface, because surfaces can attach and detach mid-session (a phone joining a cloud or Remote Control session). It is the only checklist view the mobile app shows without you asking. On the terminal it repeats the band's numbers in one short entry. Turn it off with `showStatus: false`. The next item's text is cut to 40 characters there.
- **Inline list.** `/checklist` with no arguments draws the list as the command's output row whenever the pane cannot be placed (`$.ui.open` answers `isPlaced: false`). On mobile it always does, since the app never docks a pane. `/checklist list` always draws it. The buttons work like the pane's and the row redraws live. The text the model reads is still the plain list. The tree uses only `Box`, `Text` and `Button`, which every surface has, and item text is cut to the width the surface reports.
- **Pane.** It uses the same elements, so it is mobile-safe if a future app version places panes.

## How Claude uses it

- **Tool `mcp__checklist__checklist`**, which takes `{ action, items?, ids? }`:
  - `list`
  - `add` with `items: ["...", "..."]` (several at once)
  - `start`, `done` and `remove` with `ids: [n, ...]`
  - `clear-done`

  Every call returns the updated list as compact text:
  ```
  Checklist 3/7 done ([ ] todo, [>] doing, [x] done):
  [x] #1 Sketch the data model
  [>] #4 Write tests
  [ ] #5 Update the README
  ```
  The tool only changes this plugin's own list, so the plugin allows it without a permission prompt. A call with a bad action or an unknown item number is refused, and the reason goes back to Claude.
- **Keep-going nudge.** While the list has open items, a short section is appended to the session part of the system prompt. It lists the open items (up to 12) and asks Claude to keep working through them unless you ask for something else: `start` each item, mark it `done` once it is finished, and `add` any work it discovers. When nothing is open, the section is not added.

## Config

The plugin's rows in `/config` (`pluginConfigs.checklist.options` in settings):

| Option | Default | |
| --- | --- | --- |
| `showBand` | `true` | Draw the progress band above the prompt |
| `showStatus` | `true` | Show the `☑ 3/7 · next: …` status line while the list has items |
| `nudge` | `true` | Add the keep-going section to the system prompt |

## Storage

Items are `{ id, text, status: 'todo' | 'doing' | 'done', createdAt, doneAt? }`. They are kept in the plugin's `$.store` (a JSON file under your Claude Code config directory) under `list:<repo root>`, so every worktree and subfolder of a repo shares one list. Outside a git repo, the key is the session's working directory. The list is loaded at session start and mirrored into `$.state` for drawing.

## Limitations

- The list is chosen once, at session start. Moving the session to another repo with `/cd` keeps showing the old repo's list until the plugin reloads or a new session starts.
- The store is per machine and per user. It is not committed to the repo or synced anywhere.
- The nudge is part of the system prompt, so a list change alters the session part of the prompt and costs some prompt-cache reuse on the next request. Turn it off with `nudge: false`.
- Subagents whose system prompt is composed through the same hook may also see the open items.
- The mobile app has no band and places no pane. There, the status line and the inline `/checklist` list replace them. Items can be ticked, unticked and removed by tapping. Adding an item still goes through `/checklist add <text>` or Claude, because the app draws no text field.
- `/checklist add` adds one item per call. To add several at once, ask Claude, since the tool takes a list.

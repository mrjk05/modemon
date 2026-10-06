# project-color

A colour per project, so you can tell at a glance which repo a Claude Code window belongs to. A full-width stripe in the project's colour sits above the prompt with the project name on the left and the current branch, dimmed, on the right.

```
 ▌ modemon                                                        feature/x
╭──────────────────────────────────────────────────────────────────────────╮
│ >                                                                        │
╰──────────────────────────────────────────────────────────────────────────╯
  🟣 modemon
```

The stripe row is a solid colour band (purple here) and the name is bold in black or white, whichever has more contrast on it.

- **Project identity**: the basename of the git repository root (the main working tree's root, for a worktree). Outside a repo it uses the session's project root, then the working directory.
- **Automatic colour**: a stable 32-bit FNV-1a hash of the project name, mod 12, picks one of the palette's colours. The same repo gets the same colour in every session and on every machine.
- **Palette**: purple, blue, teal, green, lime, yellow, amber, orange, red, pink, magenta, slate. They are mid-tones chosen to stand out on both dark and light terminal themes. Each gets black or white text from its WCAG luminance (always at least 4.5:1 contrast) and a colour emoji for the status line.
- **Shared band**: the stripe is drawn on top, and any other band mod (context-bar, checklist, ...) is drawn beneath it in the same column. It steps aside while a survey holds the band.
- **Branch hint**: read from `.git/HEAD` (worktree `.git` files are followed) at session start and after each turn. A detached HEAD shows a short commit. It is dropped when the band is too narrow, or skipped if it can't be read.

## Install

```
/plugin install project-color --marketplace mrjk05/modemon
```

Answer `y` to add the marketplace, then pick a scope.

## Commands

| Command | What it does |
| --- | --- |
| `/color` | Shows the current colour and the palette as swatches. Also works as `/color list`. |
| `/color <name>` | Pins a palette colour for this repo, e.g. `/color teal`. |
| `/color <#hex>` | Pins any colour: `#RGB`, `#RRGGBB` or a bare `RRGGBB`. Anything else is refused and the palette is listed. |
| `/color auto` | Removes the pin and goes back to the automatic colour. Also works as `/color reset`. |
| `/project-color ...` | The same command under the mod's own name. It is always registered, in case a Claude Code build reserves `/color` for itself. |

A pin is saved in the mod's `$.store`, keyed by the repo root, so it lasts across sessions and only applies to that repo.

The `/color` output is drawn as a small tree: the project in its colour, then the 12 swatches with the current one marked `●`. Its plain-text form, which the model reads and which is shown wherever the tree can't be drawn, names the colour, its hex and whether it is `auto` or `pinned`.

## Surfaces

| Surface | Stripe above the prompt | `/color` swatches | Status line |
| --- | --- | --- | --- |
| Terminal | Yes | Yes | `🟣 modemon` |
| Desktop (Code tab) | Yes | Yes | `🟣 modemon` |
| Claude mobile app | No, the app does not raise the band | Yes, inline in the transcript | `🟣 modemon`: this is how the colour shows on the phone |

## Configuration

Set these in `/config` (or under `pluginConfigs.project-color` in settings):

| Option | Default | Meaning |
| --- | --- | --- |
| `stripe` | `true` | Draw the stripe above the prompt. |
| `thickness` | `"1"` | `"2"` draws a two-row stripe. It falls back to one row when the band has fewer than 3 rows of room. |
| `branch` | `true` | Show the branch at the right end of the stripe. |
| `statusLine` | `true` | Pin `<emoji> <project>` as the mod's status entry on every surface. |

## Limitations

- **Claude Code's own prompt border and theme are not recoloured.** The theme is global to Claude Code, and a mod can't set it per session. Only the stripe, the status line and the `/color` output use the project colour.
- **The stripe isn't drawn on mobile.** The Claude mobile app doesn't raise the band above the prompt, so the status line's colour emoji is used instead. There are only nine coloured circle emoji, so several colours share one (teal, green and lime are all 🟢; pink shares 🔴 and magenta shares 🟣). A custom hex gets the emoji of its nearest palette colour.
- Exact colours depend on the terminal. In a terminal without truecolor support, hex colours are approximated.
- When nothing else draws in the band, the engine's own (empty) band drawing is left out, and only the stripe is returned.
- Identity is the folder name, so two different repos with the same folder name get the same automatic colour. Pin one with `/color` to tell them apart.

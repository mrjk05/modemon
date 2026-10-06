# pii-shield

Masks personal data and secrets **on screen** while you record or share your screen, so a demo video doesn't show your email address, your API keys or the name of the client in your file paths.

```
mail me at jin.song@agentsy.ai, key sk-ant-api03-…, home /Users/jins/code
```
is drawn as
```
mail me at ████[email], key ████[key], home /Users/████/code
```

It is **display only**. It rewrites what Claude Code draws, and nothing else. Claude still reads the real values, and the transcript stores them, so your session works exactly as before.

## Install

```
/plugin install pii-shield --marketplace mrjk05/modemon
```

Answer `y` to add the marketplace, then pick a scope.

## How it turns on

| Mode | What happens |
| --- | --- |
| `auto` (default) | Every 5 seconds it checks the process list for a known screen recorder or screen-share helper. When it finds one, redaction turns on and you get a toast. It **stays on for the rest of the session** (sticky), even after the recorder quits, until you run `/redact off`. |
| `on` | Always redacting. |
| `off` | Never redacting, and no polling. |

Detected recorders:

- **macOS:** QuickTime Player, the screenshot/recording toolbar (`screencaptureui`, ⇧⌘5), `screencapture`, OBS, Loom, CleanShot X, Kap, ScreenFlow, Screen Studio, Camtasia, Rotato, and Zoom while it shares your screen (`CptHost`).
- **Linux:** OBS, wf-recorder, SimpleScreenRecorder, Kooha, Peek, vokoscreenNG, Kazam, GPU Screen Recorder, recordMyDesktop, Green/Blue Recorder, Byzanz, wl-screenrec, and Zoom's `CptHost`.

The status line shows `● REDACTING` while masking and `○ pii-shield` while not.

## Commands

| Command | Effect |
| --- | --- |
| `/redact on` | Start masking now. Run this **before** you start recording if you need to be sure. |
| `/redact off` | Stop masking and clear the "recorder seen" flag. |
| `/redact auto` | Go back to watching for recorders (checks right away). |
| `/redact status` (or `/redact`) | Show the mode, whether it is masking, which recorder was seen, and which categories are on. |

`/redact` overrides the configured mode for the current session only.

## What gets masked

| Category | Masked |
| --- | --- |
| Contact | E-mail addresses (not `git@host` SSH logins or `icon@2x.png`); international `+…` phone numbers; US numbers like `(415) 555-0123`, `415-555-0123`, `1-800-555-0199`. |
| Network | IPv4 and IPv6 addresses. Loopback (`127.*`, `::1`), `0.0.0.0` and `255.255.*` netmasks are left alone. |
| Financial | Card numbers (13 to 19 digits, a card network's prefix, **Luhn-checked**); IBANs (**mod-97 checked**); US SSNs (`123-45-6789`); account, routing and sort-code numbers that follow a banking word (`Account number: 12345678`, `sort code 12-34-56`). |
| Secrets | `sk-ant-…`, `sk-…`/`sk-proj-…`, Stripe `sk_live_…`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_…`, `github_pat_…`, `glpat-…`, Slack `xox[abpors]-…`, AWS `AKIA…`/`ASIA…`, Google `AIza…`, `npm_…`, `hf_…`; JWTs; `Bearer …` and `Basic …` credentials; private-key blocks (`-----BEGIN … PRIVATE KEY-----`; the BEGIN/END lines stay, the body is masked line by line); the password in `scheme://user:password@host`; assignments with secret-sounding names: `API_KEY=…`, `PASSWORD=…`, `DB_PASS="…"`, `"client_secret": "…"`, `password: …`, `--password=…`. |
| Names | The names in the `names` setting, your OS username (from `$USER` or `whoami`, unless it is a generic one like `root` or `user`) and your `git config user.name`. Whole words only, any case. |
| Paths | The username in `/Users/<you>/`, `/home/<you>/` and `C:\Users\<you>\` (`/Users/Shared` is left alone). |

Masks use a fixed width (`████`) so the length of the hidden value doesn't leak. Most also carry a tag (`████[email]`, `████[key]`) so the video still makes sense. Masking never adds or removes a line.

The following are deliberately **not** masked: git SHAs, version numbers (`1.2.3`, `v18.17.1`), timestamps (`2024-10-06T12:34:56Z`, `12:34:56`), `file.ts:12:34` positions, UUIDs, epoch timestamps, `sha256:` digests, `std::vector`-style paths, MAC addresses, `max_tokens: 4096`, `password: string` type annotations, and placeholders like `${API_KEY}` or `<your token>`.

### Where it applies

Assistant replies, your prompts (and other user-role rows), slash-command output, tool-call rows (their input, such as a Bash command or a file path, and their inline output), tool results (Bash output, file contents, MCP results), collapsed tool groups, and the option descriptions and previews in the AskUserQuestion dialog.

## Config

Open `/config` (or the plugin's config screen at install time):

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto`, `on` or `off` (see above). |
| `names` | empty | Comma-separated extra names or words to mask: people, clients, project code names. |
| `maskContact` | on | E-mails and phone numbers. |
| `maskNetwork` | on | IP addresses. |
| `maskFinancial` | on | Cards, IBANs, SSNs, bank numbers. |
| `maskSecrets` | on | Keys, tokens, private keys, secret assignments. |
| `maskNames` | on | The names above plus your OS username and git name. |
| `maskPaths` | on | Your username in home-folder paths. |

## Failure policy: fail closed

If masking a row fails (an exception, or redaction overruns its time budget) while redaction is on, or before pii-shield knows whether it is on, the row is replaced by a single dim line: `████ pii-shield hid this row (it could not be redacted)`. It is not drawn unmasked. For a privacy tool, a hidden row is a smaller problem than a leaked one. While redaction is known to be off, a failure just draws the normal row.

## Limitations

- **Detection is heuristic.** macOS has no public "is the screen being captured" API, and Linux compositors don't expose one either. pii-shield looks for the processes of known recorders. A recorder it doesn't know about, a browser tab sharing your screen (Google Meet, Teams on the web, Discord in a browser), Microsoft Teams' desktop share, or capture done by another machine (a capture card, a phone camera) **will not be detected**. Run `/redact on` before you start recording if you need to be sure. Polling runs every 5 seconds, so a recording can start up to 5 seconds before detection. Windows and other platforms have no detection, so use `/redact on`.
- **Display only.** The model, the transcript file (`~/.claude/projects/…`), exports, `--resume` and anything that reads the session see the real values. Only the screen is masked. Text that Claude Code draws outside the hooked rows is not masked: the prompt you are typing, permission dialogs (the engine draws them alone), the spinner, toasts, status lines from other plugins, and the terminal's own scrollback from before redaction turned on.
- **Pattern-based.** Detection uses regular expressions and checksums, not a language model. Expect misses: a phone number written without separators, a secret in a variable with an unremarkable name, a name that isn't in your list. Expect occasional false positives too: a hex word pair like `dead::beef` read as IPv6, or a long random literal assigned to a `*_token` field.
- **Names are matched as whole words.** That is plain regex matching, so it doesn't catch inflections, nicknames, or a name glued into an identifier (`jins_test`). Short or common words in `names` will mask that word everywhere. A generic OS username (`root`, `user`, `admin`, …) is skipped for that reason.
- **Engine fallbacks.** If the engine itself refuses a rewritten row, or one throws while it is drawn, the engine draws its own original row. pii-shield keeps every row's shape intact to avoid this, but cannot prevent it.

## Development

```
claude plugin validate mods/pii-shield
claude plugin test mods/pii-shield
```

The redaction engine is `hooks/redact.ts` (pure functions with no engine access). Recorder detection is `hooks/detect.ts`. The hooks module is `hooks/register.tsx`.

## License

MIT

# notify

Native desktop notifications from Claude Code, so you can look away while it works. You get one when Claude needs you, when a long turn finishes, when something fails, and when a subagent finishes. Optionally, each one is also pushed to your phone through [ntfy](https://ntfy.sh), which works from cloud sessions too, where there is no desktop.

## Install

```
/plugin install notify --marketplace mrjk05/modemon
```

Answer `y` to add the marketplace, then pick a scope. Run `/notify test` to check that notifications reach you.

## When it notifies

| Trigger | Source | Body |
| --- | --- | --- |
| Needs input | `classic.Notification` (permission prompt, idle prompt, elicitation; not `auth_success`) and every `AskUserQuestion` call | The prompt's message, or `Question: <first question>` |
| Turn finished | `turn.complete` for a main-loop turn that ran longer than `minTurnSeconds` (timed from `turn.start`) | `Done in 1m 12s: <first line of the answer>` |
| Error | a turn that ended on an API error or a refusal, and `classic.StopFailure` | `Error: rate limited`, `Error: API server error (…)` |
| Subagent done | `classic.SubagentStop`, or a foreground `Agent` call's result | `Agent done: <the Agent call's description>` |

The title is `Claude Code · <repo-name>`.

Interrupted turns (Esc) and subagent turns never send a "done" notification. To avoid spamming you, it sends at most **one notification per kind every 5 seconds**. That's why a failed turn and the `StopFailure` that follows it produce only one error notification.

## Commands

- `/notify test`: sends a sample right away to the desktop and, when `ntfyTopic` is set, to your phone. It ignores mute, throttle and focus, and reports for each side what delivered it or why it failed.
- `/notify off` / `/notify on`: mutes or unmutes this session.
- `/notify status` (or just `/notify`): shows mute state, platform, the backend in use, the last delivery failure, the ntfy target (topic masked, e.g. `https://ntfy.sh/cl••••sT`), the last push result and the current config. It draws as a small card in the terminal and the desktop app, and as a compact headline plus Markdown list on the Claude mobile app.

## Config

Set these in `/config` (the plugin's rows) or in the install screen. `ntfyTopic` is marked sensitive, so it is kept in secure storage and is not a `/config` row (see [Phone push](#phone-push-ntfy)).

| Field | Default | Meaning |
| --- | --- | --- |
| `onNeedsInput` | `true` | Permission and idle prompts, AskUserQuestion |
| `onTurnDone` | `true` | Long turns finishing |
| `minTurnSeconds` | `30` | A turn must run longer than this to send a "done" notification |
| `onError` | `true` | API errors and failed turns |
| `onSubagentDone` | `true` | Subagents finishing |
| `sound` | `Glass` | macOS sound name (`Ping`, `Hero`, `Submarine`, ...). Leave it empty for silent notifications |
| `onlyWhenUnfocused` | `true` | macOS: skip desktop notifications while your terminal app is the frontmost app |
| `ntfyTopic` | empty (off) | ntfy topic to also push every notification to. Sensitive |
| `ntfyServer` | `https://ntfy.sh` | ntfy server base URL; a self-hosted one may have a path prefix |
| `ntfyOnlyWhenAway` | `true` | Skip the phone push while your terminal is the frontmost app (macOS only; see below) |

## Delivery

Notifications are sent with `$.process.run` (no shell), after the hook returns, so a notification never holds up the turn or a tool call. A failed delivery is swallowed and never breaks the session. Once a backend works, the mod caches it for the rest of the session.

### macOS

1. **`terminal-notifier`** if it is installed. Clicking the notification brings your terminal to the front. Notifications from one session replace each other (`-group claude-code-<session>`).

   ```
   brew install terminal-notifier
   ```

   The terminal is detected from `TERM_PROGRAM`: Terminal, iTerm2, Ghostty, VS Code and WezTerm are recognised. Otherwise it falls back to macOS's `__CFBundleIdentifier`.
2. Otherwise **`osascript -e 'display notification "…" with title "…" sound name "Glass"'`**. Clicking it opens Script Editor, not your terminal.

**Permission:** macOS shows a notification only if the sending app may post them. Open **System Settings → Notifications**. Allow your terminal app for `osascript`, or *terminal-notifier* once it has posted its first notification. If `/notify test` says it sent but nothing appears, this setting or Focus / Do Not Disturb is usually the cause.

### Linux

**`notify-send -a "Claude Code" -- <title> <body>`** (from `libnotify-bin` / `libnotify`). The body is markup-escaped, because most notification daemons parse it as markup. Linux notifications have no sound.

### Other platforms

There is no desktop backend on other platforms (Windows included), so nothing is shown there. `/notify status` says so. Phone push still works.

## Phone push (ntfy)

[ntfy](https://ntfy.sh) is a simple pub/sub notification service: you subscribe to a *topic* in its phone app, and anything POSTed to `https://ntfy.sh/<topic>` buzzes your phone. notify POSTs every notification it sends there too.

### Setup

1. Install the **ntfy** app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy), [iOS](https://apps.apple.com/app/ntfy/id1625396347), or F-Droid).
2. Make up a **long random topic name**. Anyone who knows it can read and send to it, so treat it as a password. For example:

   ```
   echo "claude-$(openssl rand -hex 12)"
   ```

   Topic names are 1-64 letters, digits, `-` or `_`.
3. In the app, tap **+** and subscribe to that topic (on the default server, or yours).
4. Set `ntfyTopic` in notify's config:
   - **Installed plugin:** `/plugin`, pick notify, and set it on its config screen (the same screen as at install). Because the field is sensitive it is stored in secure storage and does not show as a `/config` row.
   - **Settings file:** under `pluginConfigs` in `~/.claude/settings.json`, keyed by the plugin name (`notify`, or `notify@inline` for a `--plugin-dir` load):

     ```json
     {
       "pluginConfigs": {
         "notify": { "options": { "ntfyTopic": "claude-3f9c1e…", "ntfyServer": "https://ntfy.sh" } }
       }
     }
     ```
5. Run `/notify test`. It reports `phone push sent via ntfy (HTTP 200)` and your phone buzzes.

For a **cloud session**, the topic has to be in settings that session reads (for example your user settings). Never put it in a committed project file such as `.claude/settings.json`: anyone with the repo could then read your notifications. A value written into a settings file by hand is plain text there; only the config screen puts it in secure storage. The mod needs nothing installed in the container, because the push goes through the session's own `$.http.fetch`.

### What is sent

`POST <ntfyServer>/<ntfyTopic>` with:

| Header | Value |
| --- | --- |
| `Title` | `Claude Code · <repo>`. HTTP headers must be ASCII, so a title with any non-ASCII character (the `·` included) is sent as RFC 2047 encoded words (`=?UTF-8?B?…?=`), which ntfy decodes |
| `Priority` | `high` for needs-input and errors, `default` otherwise |
| `Tags` | `question` (needs input), `white_check_mark` (turn done), `warning` (error), `robot` (subagent), `bell` (`/notify test`); the app draws them as emoji |

The body is the notification text (UTF-8, flattened to one line, up to 1000 characters). Control characters are removed before anything goes into a header, so a message cannot inject headers.

### When the phone gets it

Mute (`/notify off`), the per-trigger toggles and the 5-second throttle apply to both the desktop and the phone. Focus is handled separately:

- `onlyWhenUnfocused` only gates the **desktop** notification.
- `ntfyOnlyWhenAway` (default `true`) skips the **phone** push only when there is proof you are at the computer: your terminal is the frontmost app (readable on macOS only) *and* the desktop side did not fail. If the desktop notification failed while you were focused, the phone still gets it.
- Wherever focus cannot be read (Linux, a cloud container, a terminal that cannot be identified) or there is no desktop notifier at all, every notification goes to the phone.
- Set `ntfyOnlyWhenAway` to `false` to push everything to the phone, focused or not.

Desktop and phone are delivered one after the other, each in its own error handling: a missing `notify-send` or a blocked `osascript` never stops the push, and an unreachable ntfy server never stops the desktop notification. `/notify status` shows the last push result.

### Privacy

- **ntfy.sh is a public server.** Anyone who knows or guesses your topic can subscribe and read your notifications (repo names, the first line of Claude's answers, questions it asks you). Short or common topics (`claude`, `mytopic`) are guessed in practice. Use a long random topic; `/notify status` flags topics shorter than 20 characters.
- The topic is kept masked in `/notify status` and is stored as a sensitive config value, but it travels in the URL of every push, so it is visible to the ntfy server (and to anything that logs your outgoing URLs, e.g. a corporate proxy).
- Notification text passes through ntfy.sh's servers (and the platform push services the app uses), which cache messages for a while so offline phones can catch up.
- To keep it all on your own infrastructure, **self-host ntfy** ([docs](https://docs.ntfy.sh/install/)), optionally with access control, and point `ntfyServer` at it (e.g. `https://ntfy.example.com`). Authenticated topics (tokens) are not supported by this mod yet.

## Limitations

- **Phone push** needs the session to reach the ntfy server through `$.http.fetch`; an organization web-fetch policy that blocks the host makes every push fail (shown in `/notify status`). There is no retry and no auth token support.
- **Focus** can be read only on macOS, and only at the app level (`lsappinfo`). If your terminal is frontmost but you are looking at another tab or tmux pane, you still won't get a notification. On Linux, and in any terminal whose app can't be identified, `onlyWhenUnfocused` has no effect and every notification is sent.
- The throttle is per kind. If two subagents finish within 5 seconds, you get one notification.
- `classic.PermissionRequest` is not hooked. Permission prompts are caught through `classic.Notification`, which avoids notifying for requests that a policy or auto mode answers without asking you.
- The per-session state (backend cache, turn timers, throttle) resets on a hot reload of the mod. Mute is kept in `$.state` and survives a reload.

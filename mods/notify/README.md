# notify

Native desktop notifications from Claude Code, so you can look away while it works. You get one when Claude needs you, when a long turn finishes, when something fails, and when a subagent finishes.

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

- `/notify test`: sends a sample right away. It ignores mute, throttle and focus, and reports which backend delivered it or why none could.
- `/notify off` / `/notify on`: mutes or unmutes this session.
- `/notify status` (or just `/notify`): shows mute state, platform, the backend in use, the last delivery failure and the current config.

## Config

Set these in `/config` (the plugin's rows) or in the install screen.

| Field | Default | Meaning |
| --- | --- | --- |
| `onNeedsInput` | `true` | Permission and idle prompts, AskUserQuestion |
| `onTurnDone` | `true` | Long turns finishing |
| `minTurnSeconds` | `30` | A turn must run longer than this to send a "done" notification |
| `onError` | `true` | API errors and failed turns |
| `onSubagentDone` | `true` | Subagents finishing |
| `sound` | `Glass` | macOS sound name (`Ping`, `Hero`, `Submarine`, ...). Leave it empty for silent notifications |
| `onlyWhenUnfocused` | `true` | macOS: skip notifications while your terminal app is the frontmost app |

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

There is no backend on other platforms (Windows included), so nothing is sent. `/notify status` says so.

## Limitations

- **Focus** can be read only on macOS, and only at the app level (`lsappinfo`). If your terminal is frontmost but you are looking at another tab or tmux pane, you still won't get a notification. On Linux, and in any terminal whose app can't be identified, `onlyWhenUnfocused` has no effect and every notification is sent.
- The throttle is per kind. If two subagents finish within 5 seconds, you get one notification.
- `classic.PermissionRequest` is not hooked. Permission prompts are caught through `classic.Notification`, which avoids notifying for requests that a policy or auto mode answers without asking you.
- The per-session state (backend cache, turn timers, throttle) resets on a hot reload of the mod. Mute is kept in `$.state` and survives a reload.

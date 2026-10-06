# deploy-deck

Live deploy tracking inside Claude Code. deploy-deck watches **GitHub** (Actions workflow runs and Deployments), **Vercel** (preview and production deployments), **Cloudflare** (Pages deployments with their stages, Workers deployments and versions) and **Render** (service deploys). It shows each deploy on one normalised pipeline:

`queued → building → deploying → live ✓ / failed ✗ / canceled ⊘`

It is **read-only**: it only sends `GET` requests.

```
vercel · shop-web · production   ● queued ━ ◉ building ━ ○ deploying ━ ○ live  1:12
render · shop-api                ● queued ━ ● building ━ ◉ deploying ━ ○ live  3:40
github · acme/shop · Deploy      ● queued ━ ● building ━ ● deploying ━ ✓ live  2:05
▌ modemon ▐                                               ← other band mods, below
╭──────────────────────────────────────────────────────────────────────────────╮
│ >                                                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
  🚀 vercel building 1:12 +1
```

The band only appears while something is in flight, and keeps a finished deploy for 60 seconds. `/deploys` opens the panel:

```
┌ Deploys ──────────────────────────────────────── every 10s ┐
│ vercel · prj_Qm8kd7Vf2LpXr0aNc3TyEw9H                token │
│ ◉ building  production · a1b2c3d · main · 1:12             │
│   open · logs  Fix checkout rounding                       │
│ ✗ build failed  preview · ffeeddc · feature/cart · 1h ago  │
│   open · logs  Cart drawer                                 │
│ ✓ live  production · 0123456 · main · 1d ago               │
│   open · logs                                              │
│                                                            │
│ render · shop-api                                    token │
│ ◉ building  a5f3e2d · main · 3:40                          │
│ ✗ deploy failed  1111111 · main · 3h ago                   │
│ ✓ live  abcdefa · main · 1d ago                            │
│                                                            │
│ cloudflare · docs-site (pages)                       token │
│ ⚠ cloudflare: set cloudflareAccountId (or account_id …)    │
│                                                            │
│ /deploys refresh · add · remove · status                   │
└────────────────────────────────────────────────────────────┘
```

Each row shows the state glyph and stage, the environment, the version (a tag or version number when the provider has one, else the short sha), the branch, and the age (or elapsed time while in flight). `open` links to the deployed URL and `logs` links to the provider's build or run page.

## Install

```
/plugin install deploy-deck --marketplace mrjk05/modemon
```

Answer `y` to add the marketplace, then pick a scope. The install screen asks for the options below. You can change them later with `/plugin`, then deploy-deck, then configure.

## Setup per provider

Each provider takes one **read-only** token. The tokens are `sensitive` fields, so Claude Code keeps them in secure storage and they do not appear as `/config` rows. You can set them on the plugin's configure screen (`/plugin`, then deploy-deck), or under `pluginConfigs` in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "deploy-deck": {
      "options": {
        "vercelToken": "…",
        "vercelTeamId": "team_…",
        "cloudflareToken": "…",
        "cloudflareAccountId": "023e105f4ecef8ad9ca31a8372d0c353",
        "renderToken": "rnd_…"
      }
    }
  }
}
```

(Use `deploy-deck@inline` as the key for a `--plugin-dir` load.)

| Provider | Where to create it | Minimum scope |
|---|---|---|
| GitHub | github.com/settings/personal-access-tokens (fine-grained) | Repository access: the repo. Permissions: **Actions: Read**, **Deployments: Read**, Metadata: Read (implied). Or leave `githubToken` empty and run `gh auth login`: deploy-deck then reads through `gh api` (GET only). |
| Vercel | vercel.com/account/tokens | Scope the token to the **team** that owns the project. Vercel has no read-only token scope, but deploy-deck only sends `GET /v7/deployments`. Set `vercelTeamId` unless `.vercel/project.json` names the team. |
| Cloudflare | dash.cloudflare.com/profile/api-tokens, then Create custom token | Account permissions **Cloudflare Pages: Read** and **Workers Scripts: Read**, limited to the one account. Also set `cloudflareAccountId`, or put `account_id` in wrangler.toml. |
| Render | dashboard.render.com, then Account settings, then API keys | Render API keys cover the whole account and have no scopes. deploy-deck only sends GETs with the key. |

`/deploys status` shows, for each provider, whether a token is set, the gh CLI is used, or nothing is configured. It never shows a token.

## Detection

When `autoDetect` is on (the default), deploy-deck reads targets from the repository root, or from the session root outside git:

| Source | Target |
|---|---|
| `origin` remote on github.com (`git@github.com:o/r.git`, `https://github.com/o/r`) | `github:o/r` |
| `.vercel/project.json` (`vercel link`) | `vercel:<projectId>`. An `orgId` starting with `team_` becomes the team. |
| `vercel.json` without a link | `vercel:<name>`: its legacy `name` field, else the folder name (a guess) |
| `wrangler.toml`, `wrangler.jsonc`, `wrangler.json` | `name`. With `pages_build_output_dir` it is `cloudflare-pages:<name>`, otherwise `cloudflare-workers:<name>`. `account_id` is used as the account. |
| `render.yaml` / `render.yml` | `render:<name>` for each `services[].name`. The name is resolved to its `srv-…` id with `GET /v1/services?name=`. |

To add more targets, list them in `targets` (comma-separated, e.g. `vercel:my-app, cloudflare-pages:site, cloudflare-workers:api, render:srv-123, github:owner/repo`) or use `/deploys add`.

## Commands

| Command | What it does |
|---|---|
| `/deploys` | Opens the panel on terminal and desktop. On the phone, or where no pane can be placed, it answers inline as a card. With nothing configured, it explains how to set up each provider. |
| `/deploys refresh` | Clears any backoff and reads every target now. |
| `/deploys add <provider:id>` | Tracks another target, saved per repo. Providers: `github`, `vercel`, `cloudflare-pages` (or `cloudflare`, `pages`), `cloudflare-workers` (or `workers`), `render`. |
| `/deploys remove <provider:id>` | Stops tracking a target, a detected one included. This is saved per repo. |
| `/deploys status` | For each provider: auth source (token, gh CLI, none), targets with where each came from, the last error, any backoff and the poll interval. |
| `/deploys close` | Closes the panel. |

## What you see

- **Band above the prompt** (terminal and desktop). It shows one row per in-flight deploy: `provider · project · env`, a coloured stage pipeline, and elapsed time. Done stages are green, the current one is in the accent colour, a failed one is red. Finished deploys stay for 60 seconds. The row fits `bodyColumns`: the full pipeline when it fits, then glyphs with the stage word (`●━◉━○━○ building`), then just `◉ building`. Other band mods are stacked below it through `next(e)`.
- **Toasts**, once per deploy, when it goes live or fails: `✓ vercel production live · a1b2c3d`, `✗ render build failed · 5f3e2d1`.
- **Status line**: the most important current item. That is the in-flight deploy (production first, `🚀 vercel building 1:12 +1`), else a failure or go-live from the last 10 minutes (`✗ render build failed`, `✓ prod live v1.4.2`). Otherwise the status line is empty.

## Polling

- There is one timer. It runs every `fastSeconds` (10) while any deploy is in flight and every `slowSeconds` (120) when idle. It stops when there are no targets.
- **Backoff per provider**: on HTTP 429, 5xx or a network error, the provider rests for 30s, doubling up to 15 minutes, and for at least as long as `Retry-After`, `x-ratelimit-reset` or `ratelimit-reset` asks. A GitHub 403 with `x-ratelimit-remaining: 0` counts as a rate limit. On 401, 403 or 404 the provider rests for 10 minutes. `/deploys refresh` clears the rest.
- The first read of each target never toasts, so old deploys stay quiet. After that, a deploy toasts when it moves from in flight to live or failed. It also toasts when it is new and finished since the previous read.
- An in-flight record older than 6 hours (for example a GitHub deployment that never got a status) does not count as active.

## Config

| Field | Default | |
|---|---|---|
| `githubToken` | empty | Sensitive. Empty: `gh api` is used when `useCli` is on. |
| `vercelToken`, `vercelTeamId` | empty | Token is sensitive. Team id is `team_…`. |
| `cloudflareToken`, `cloudflareAccountId` | empty | Token is sensitive. |
| `renderToken` | empty | Sensitive. |
| `targets` | empty | Extra targets, `provider:id`, comma-separated. |
| `autoDetect` | on | Read targets from the repo files. |
| `useCli` | on | Without a GitHub token, read GitHub through `gh api`. |
| `fastSeconds` / `slowSeconds` | 10 / 120 | Poll intervals (minimum 5 / 30). |
| `band`, `toasts`, `statusLine` | on | Turn each surface element on or off. |

## Surfaces

- **Terminal and desktop**: band, `/deploys` pane (bordered cards on desktop), toasts and status line.
- **Mobile** (Claude app watching a cloud or Remote Control session): the band is not raised there, so the **status line** carries the current deploy. `/deploys` sent from the phone, or anywhere `$.ui.open` answers `isPlaced: false`, comes back as an **inline card** (`CommandOutput`) drawn with `Box`, `Text` and `Link` only. It redraws as deploys change. The card's text is also plain markdown, so it reads well wherever the tree is not drawn. The set-up help is drawn as `Markdown`.

## Security

- Tokens are injected as `Authorization: Bearer …` by a single network helper (`hooks/net.ts`). They are never put in URLs, errors, logs, the status line, toasts, the panel or `/deploys status`. Every error message is built by deploy-deck from the HTTP status and the provider's own error words. Known tokens and anything shaped like a bearer credential (`ghp_…`, `github_pat_…`, `Bearer …`) are scrubbed from those words. A test shows that a 401 whose body echoes the token does not leak it.
- deploy-deck sends `GET` requests only, and `gh api` without `-X`/`--method`.
- Tokens are `sensitive` userConfig fields, so Claude Code keeps them in secure storage.
- Requests go through `$.http.fetch`, so an organisation's web-fetch policy applies.

## Limitations

- **Vercel, Cloudflare and Render need a token.** Only GitHub has a CLI fallback (`gh api`). `vercel ls` and `wrangler` print no stable JSON for deployment lists, so there is no fallback for them.
- **No read-only tokens on Vercel or Render**: those providers do not offer read-only scopes. deploy-deck itself only reads.
- **Elapsed time** moves at the poll rate (every 10s while in flight), not every second.
- **GitHub**: the 8 latest workflow runs of every workflow (CI included), plus the 3 latest Deployments with one status read each. Runs are not filtered by branch. A run's "live" means the run succeeded.
- **Vercel has no separate deploying stage**: a deployment goes building → live. With only `vercel.json` (no `.vercel/project.json`) the project is guessed from the folder name. Run `vercel link` or `/deploys add vercel:<name>` to fix it.
- **Cloudflare Workers** deployments are atomic, so they show as live when they appear (a toast when a new one is seen). Gradual rollouts show the split (`90%/10% split`). Workers have no deploy URL.
- **Render** blueprints are matched by exact service name. Preview environments and databases are not tracked.
- Detection reads the repo root only (no monorepo sub-folders). Add sub-projects with `targets` or `/deploys add`.
- Detected targets are read at session start and again on `/deploys refresh`.
- Built against Claude Code 2.1.290. The mods API is early access.

// Repo files detection reads, as they appear in real projects.

/** .vercel/project.json, written by `vercel link`. */
export const VERCEL_PROJECT_JSON = `{"projectId":"prj_Qm8kd7Vf2LpXr0aNc3TyEw9H","orgId":"team_9aB8cD7eF6gH5iJ4kL3mN2oP","projectName":"shop-web"}`

/** A personal-account link: orgId is a user id, no team. */
export const VERCEL_PROJECT_JSON_PERSONAL = `{"projectId":"prj_personal123","orgId":"AbCdEfGh12345678"}`

/** vercel.json without a link. */
export const VERCEL_JSON = `{
  // comments are allowed by the CLI
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "cleanUrls": true,
  "rewrites": [{ "source": "/api/(.*)", "destination": "/api/$1" }],
}`

/** wrangler.toml for a Pages project. */
export const WRANGLER_PAGES_TOML = `# Cloudflare Pages
name = "docs-site"
compatibility_date = "2025-09-01"
pages_build_output_dir = "./dist"
account_id = "023e105f4ecef8ad9ca31a8372d0c353" # acme

[vars]
name = "not-this-one"
`

/** wrangler.toml for a Worker. */
export const WRANGLER_WORKER_TOML = `name = 'edge-api'
main = "src/index.ts"
compatibility_date = "2025-09-01"

[[routes]]
pattern = "api.acme.dev/*"
`

/** wrangler.jsonc for a Worker. */
export const WRANGLER_JSONC = `{
  // see https://developers.cloudflare.com/workers/wrangler/configuration/
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "edge-api", /* the script */
  "main": "src/index.ts",
  "compatibility_date": "2025-09-01",
  "observability": { "enabled": true, },
}`

/** render.yaml blueprint with two services, a cron job and env vars referencing others. */
export const RENDER_YAML = `# Render blueprint
services:
  - type: web
    name: shop-api
    runtime: node
    buildCommand: npm ci && npm run build
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: shop-db
          property: connectionString
      - key: WORKER_HOST
        fromService:
          type: worker
          name: shop-worker
          property: host
  - name: shop-worker
    type: worker
    runtime: node

databases:
  - name: shop-db
    plan: basic-256mb
`

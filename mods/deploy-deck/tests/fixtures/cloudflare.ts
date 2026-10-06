// Realistic Cloudflare API v4 answers (trimmed): Pages deployments, Workers
// deployments and Workers versions.

/** GET /accounts/{acct}/pages/projects/docs-site/deployments */
export const PAGES = {
  success: true,
  errors: [],
  messages: [],
  result: [
    {
      id: 'f64788e9-fccd-4d4a-a28a-cb84f88f6f20',
      short_id: 'f64788e9',
      project_id: '7b162ea7-7367-4d67-bcde-1160995d5',
      project_name: 'docs-site',
      environment: 'production',
      url: 'https://f64788e9.docs-site.pages.dev',
      created_on: '2026-10-06T10:00:00.000000Z',
      modified_on: '2026-10-06T10:01:30.000000Z',
      aliases: ['https://docs.acme.dev'],
      latest_stage: { name: 'build', started_on: '2026-10-06T10:00:20Z', status: 'active', ended_on: null },
      deployment_trigger: {
        type: 'github:push',
        metadata: { branch: 'main', commit_hash: 'ad9ccd918a81025731e10e40267e11273a263421', commit_message: 'Update docs', commit_dirty: false },
      },
      stages: [
        { name: 'queued', started_on: '2026-10-06T10:00:00Z', ended_on: '2026-10-06T10:00:05Z', status: 'success' },
        { name: 'initialize', started_on: '2026-10-06T10:00:05Z', ended_on: '2026-10-06T10:00:12Z', status: 'success' },
        { name: 'clone_repo', started_on: '2026-10-06T10:00:12Z', ended_on: '2026-10-06T10:00:20Z', status: 'success' },
        { name: 'build', started_on: '2026-10-06T10:00:20Z', ended_on: null, status: 'active' },
        { name: 'deploy', started_on: null, ended_on: null, status: 'idle' },
      ],
    },
    {
      id: '0a1b2c3d-1111-2222-3333-444455556666',
      short_id: '0a1b2c3d',
      project_name: 'docs-site',
      environment: 'preview',
      url: 'https://0a1b2c3d.docs-site.pages.dev',
      created_on: '2026-10-06T09:00:00Z',
      modified_on: '2026-10-06T09:02:00Z',
      latest_stage: { name: 'build', started_on: '2026-10-06T09:00:20Z', status: 'failure', ended_on: '2026-10-06T09:02:00Z' },
      deployment_trigger: { type: 'github:push', metadata: { branch: 'typo-fix', commit_hash: 'beefbeefbeefbeefbeefbeefbeefbeefbeefbeef', commit_message: 'typo' } },
    },
    {
      id: '99999999-aaaa-bbbb-cccc-dddddddddddd',
      short_id: '99999999',
      project_name: 'docs-site',
      environment: 'production',
      url: 'https://99999999.docs-site.pages.dev',
      created_on: '2026-10-05T12:00:00Z',
      modified_on: '2026-10-05T12:03:00Z',
      latest_stage: { name: 'deploy', started_on: '2026-10-05T12:02:40Z', status: 'success', ended_on: '2026-10-05T12:03:00Z' },
      deployment_trigger: { type: 'ad_hoc', metadata: { branch: 'main', commit_hash: 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff', commit_message: '' } },
    },
  ],
  result_info: { page: 1, per_page: 10, count: 3, total_count: 3 },
}

/** GET /accounts/{acct}/workers/scripts/edge-api/deployments */
export const WORKER_DEPLOYMENTS = {
  success: true,
  errors: [],
  messages: [],
  result: {
    deployments: [
      {
        id: 'bcf48806-b317-4351-9ee7-36e7d557d4de',
        created_on: '2026-10-06T09:30:00.000000Z',
        source: 'wrangler',
        strategy: 'percentage',
        author_email: 'jin@example.com',
        annotations: { 'workers/triggered_by': 'deployment', 'workers/message': 'Roll out v2 router' },
        versions: [
          { version_id: '9b1d6c1e-0000-4000-8000-000000000002', percentage: 90 },
          { version_id: '9b1d6c1e-0000-4000-8000-000000000001', percentage: 10 },
        ],
      },
      {
        id: '7c2a1e00-1111-4222-8333-444455556666',
        created_on: '2026-10-04T15:00:00.000000Z',
        source: 'wrangler',
        strategy: 'percentage',
        versions: [{ version_id: '9b1d6c1e-0000-4000-8000-000000000001', percentage: 100 }],
      },
    ],
  },
}

/** GET /accounts/{acct}/workers/scripts/edge-api/versions */
export const WORKER_VERSIONS = {
  success: true,
  errors: [],
  messages: [],
  result: {
    items: [
      {
        id: '9b1d6c1e-0000-4000-8000-000000000002',
        number: 42,
        metadata: { created_on: '2026-10-06T09:29:00Z', source: 'wrangler', author_email: 'jin@example.com' },
        annotations: { 'workers/tag': 'v2.0.0', 'workers/message': 'v2 router' },
      },
      {
        id: '9b1d6c1e-0000-4000-8000-000000000001',
        number: 41,
        metadata: { created_on: '2026-10-04T14:59:00Z', source: 'wrangler' },
      },
    ],
  },
}

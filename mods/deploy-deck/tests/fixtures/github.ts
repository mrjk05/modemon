// Realistic GitHub REST answers (trimmed to the fields the adapter reads,
// plus a few it ignores), shaped as api.github.com returns them.

/** GET /repos/acme/shop/actions/runs?per_page=8 */
export const RUNS = {
  total_count: 4,
  workflow_runs: [
    {
      id: 11223344556,
      name: 'Deploy',
      node_id: 'WFR_kwLOA1b2c88AAAACn5ZYrA',
      head_branch: 'main',
      head_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      path: '.github/workflows/deploy.yml',
      display_title: 'Fix checkout rounding',
      run_number: 412,
      event: 'push',
      status: 'in_progress',
      conclusion: null,
      workflow_id: 61234567,
      html_url: 'https://github.com/acme/shop/actions/runs/11223344556',
      created_at: '2026-10-06T10:00:00Z',
      updated_at: '2026-10-06T10:01:10Z',
      run_attempt: 1,
      run_started_at: '2026-10-06T10:00:05Z',
      head_commit: {
        id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        message: 'Fix checkout rounding\n\nCloses #88',
        timestamp: '2026-10-06T09:59:40Z',
        author: { name: 'Jin', email: 'jin@example.com' },
      },
    },
    {
      id: 11223344000,
      name: 'CI',
      head_branch: 'feature/cart',
      head_sha: 'ffeeddccbbaa99887766554433221100ffeeddcc',
      event: 'pull_request',
      status: 'completed',
      conclusion: 'failure',
      html_url: 'https://github.com/acme/shop/actions/runs/11223344000',
      created_at: '2026-10-06T09:40:00Z',
      updated_at: '2026-10-06T09:46:30Z',
      run_started_at: '2026-10-06T09:40:02Z',
      head_commit: { id: 'ffeeddccbbaa99887766554433221100ffeeddcc', message: 'Cart drawer' },
    },
    {
      id: 11223343000,
      name: 'Deploy',
      head_branch: 'main',
      head_sha: '0123456789abcdef0123456789abcdef01234567',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/acme/shop/actions/runs/11223343000',
      created_at: '2026-10-05T18:00:00Z',
      updated_at: '2026-10-05T18:04:00Z',
      run_started_at: '2026-10-05T18:00:03Z',
      head_commit: { id: '0123456789abcdef0123456789abcdef01234567', message: 'Release 1.4.1' },
    },
    {
      id: 11223342000,
      name: 'Nightly',
      head_branch: 'main',
      head_sha: '89abcdef0123456789abcdef0123456789abcdef',
      event: 'schedule',
      status: 'queued',
      conclusion: null,
      html_url: 'https://github.com/acme/shop/actions/runs/11223342000',
      created_at: '2026-10-06T10:01:00Z',
      updated_at: '2026-10-06T10:01:00Z',
      head_commit: null,
    },
  ],
}

/** GET /repos/acme/shop/deployments?per_page=3 */
export const DEPLOYMENTS = [
  {
    url: 'https://api.github.com/repos/acme/shop/deployments/1890001',
    id: 1890001,
    node_id: 'DE_kwDOA1b2c84AHNBx',
    sha: '0123456789abcdef0123456789abcdef01234567',
    ref: 'v1.4.2',
    task: 'deploy',
    payload: {},
    original_environment: 'production',
    environment: 'production',
    description: 'Release v1.4.2',
    creator: { login: 'github-actions[bot]' },
    created_at: '2026-10-06T08:00:00Z',
    updated_at: '2026-10-06T08:03:00Z',
    statuses_url: 'https://api.github.com/repos/acme/shop/deployments/1890001/statuses',
    production_environment: true,
  },
  {
    id: 1890002,
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    ref: 'main',
    environment: 'staging',
    description: null,
    created_at: '2026-10-06T10:00:30Z',
    updated_at: '2026-10-06T10:00:30Z',
  },
]

/** GET /repos/acme/shop/deployments/1890001/statuses?per_page=1 */
export const STATUSES_SUCCESS = [
  {
    id: 7700001,
    state: 'success',
    description: 'Deployment finished successfully.',
    environment: 'production',
    target_url: 'https://github.com/acme/shop/actions/runs/11223343999',
    log_url: 'https://github.com/acme/shop/actions/runs/11223343999/job/3100',
    environment_url: 'https://shop.acme.dev',
    created_at: '2026-10-06T08:03:00Z',
    updated_at: '2026-10-06T08:03:00Z',
  },
]

/** GET /repos/acme/shop/deployments/1890002/statuses?per_page=1 */
export const STATUSES_IN_PROGRESS = [
  {
    id: 7700002,
    state: 'in_progress',
    environment: 'staging',
    target_url: '',
    log_url: 'https://github.com/acme/shop/actions/runs/11223344556/job/3200',
    environment_url: '',
    created_at: '2026-10-06T10:00:40Z',
  },
]

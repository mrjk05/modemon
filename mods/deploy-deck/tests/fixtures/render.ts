// Realistic Render API v1 answers (trimmed).

/** GET /v1/services?name=shop-api&limit=20 */
export const SERVICES = [
  {
    service: {
      id: 'srv-cq5n2lbv2p9c73a0kk0g',
      name: 'shop-api',
      type: 'web_service',
      repo: 'https://github.com/acme/shop',
      branch: 'main',
      autoDeploy: 'yes',
      dashboardUrl: 'https://dashboard.render.com/web/srv-cq5n2lbv2p9c73a0kk0g',
      serviceDetails: { url: 'https://shop-api.onrender.com', region: 'oregon', plan: 'starter' },
      createdAt: '2025-03-01T10:00:00Z',
    },
    cursor: 'Y3Vyc29yMQ==',
  },
  {
    service: { id: 'srv-other00000000000000', name: 'shop-api-staging', type: 'web_service', branch: 'staging' },
    cursor: 'Y3Vyc29yMg==',
  },
]

/** GET /v1/services/srv-cq5n2lbv2p9c73a0kk0g/deploys?limit=10 */
export const DEPLOYS = [
  {
    deploy: {
      id: 'dep-cr1a2b3c4d5e6f7g8h9i',
      commit: { id: '5f3e2d1c0b9a88776655443322110fedcba98765', message: 'Bump prisma', createdAt: '2026-10-06T09:58:00Z' },
      status: 'build_in_progress',
      trigger: 'new_commit',
      startedAt: '2026-10-06T10:00:00Z',
      finishedAt: null,
      createdAt: '2026-10-06T09:59:58Z',
      updatedAt: '2026-10-06T10:00:30Z',
    },
    cursor: 'ZGVwMQ==',
  },
  {
    deploy: {
      id: 'dep-cqzz9y8x7w6v5u4t3s2r',
      commit: { id: '1111111111222222222233333333334444444444', message: 'Add healthcheck\n\nlong body' },
      status: 'update_failed',
      trigger: 'manual',
      startedAt: '2026-10-06T07:00:00Z',
      finishedAt: '2026-10-06T07:06:00Z',
      createdAt: '2026-10-06T07:00:00Z',
      updatedAt: '2026-10-06T07:06:00Z',
    },
    cursor: 'ZGVwMg==',
  },
  {
    deploy: {
      id: 'dep-cqaa1b2c3d4e5f6g7h8i',
      commit: { id: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd', message: 'Initial' },
      status: 'deactivated',
      trigger: 'new_commit',
      startedAt: '2026-10-05T07:00:00Z',
      finishedAt: '2026-10-05T07:04:00Z',
      createdAt: '2026-10-05T07:00:00Z',
      updatedAt: '2026-10-06T07:06:00Z',
    },
    cursor: 'ZGVwMw==',
  },
]

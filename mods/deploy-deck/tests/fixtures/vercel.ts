// A realistic Vercel GET /v7/deployments answer (trimmed).

export const DEPLOYMENTS = {
  deployments: [
    {
      uid: 'dpl_8rTqJx3kQhG2bVnM5yLzP1aW',
      name: 'shop-web',
      url: 'shop-web-9jaeg38me-acme.vercel.app',
      created: 1791280800000,
      createdAt: 1791280800000,
      buildingAt: 1791280803000,
      source: 'git',
      state: 'BUILDING',
      readyState: 'BUILDING',
      type: 'LAMBDAS',
      creator: { uid: 'eLrCnEgbKhsHyfbiNR7E8496', username: 'jin' },
      inspectorUrl: 'https://vercel.com/acme/shop-web/8rTqJx3kQhG2bVnM5yLzP1aW',
      meta: {
        githubCommitAuthorName: 'Jin',
        githubCommitMessage: 'Fix checkout rounding\n\nCloses #88',
        githubCommitOrg: 'acme',
        githubCommitRef: 'main',
        githubCommitRepo: 'shop',
        githubCommitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        githubDeployment: '1',
      },
      target: 'production',
      projectId: 'prj_Qm8kd7Vf2LpXr0aNc3TyEw9H',
    },
    {
      uid: 'dpl_4hNcLqW1pZr7GxTbV0sKe2Ym',
      name: 'shop-web',
      url: 'shop-web-git-feature-cart-acme.vercel.app',
      created: 1791279000000,
      createdAt: 1791279000000,
      buildingAt: 1791279002000,
      ready: 1791279095000,
      state: 'ERROR',
      readyState: 'ERROR',
      errorCode: 'BUILD_FAILED',
      errorMessage: 'Command "npm run build" exited with 1',
      type: 'LAMBDAS',
      creator: { uid: 'eLrCnEgbKhsHyfbiNR7E8496' },
      inspectorUrl: 'https://vercel.com/acme/shop-web/4hNcLqW1pZr7GxTbV0sKe2Ym',
      meta: { githubCommitRef: 'feature/cart', githubCommitSha: 'ffeeddccbbaa99887766554433221100ffeeddcc', githubCommitMessage: 'Cart drawer' },
      target: null,
      projectId: 'prj_Qm8kd7Vf2LpXr0aNc3TyEw9H',
    },
    {
      uid: 'dpl_2euZBFqxYdDMDG1jTrHFnNZ2eUVa',
      name: 'shop-web',
      url: 'shop-web-k2l4m6n8p-acme.vercel.app',
      created: 1791194400000,
      createdAt: 1791194400000,
      buildingAt: 1791194401000,
      ready: 1791194460000,
      state: 'READY',
      readyState: 'READY',
      readySubstate: 'PROMOTED',
      type: 'LAMBDAS',
      creator: { uid: 'eLrCnEgbKhsHyfbiNR7E8496' },
      inspectorUrl: 'https://vercel.com/acme/shop-web/2euZBFqxYdDMDG1jTrHFnNZ2eUVa',
      meta: { githubCommitRef: 'main', githubCommitSha: '0123456789abcdef0123456789abcdef01234567' },
      target: 'production',
      projectId: 'prj_Qm8kd7Vf2LpXr0aNc3TyEw9H',
    },
    {
      uid: 'dpl_Canceled1111111111111111',
      name: 'shop-web',
      url: 'shop-web-zz-acme.vercel.app',
      created: 1791190000000,
      createdAt: 1791190000000,
      state: 'CANCELED',
      readyState: 'CANCELED',
      type: 'LAMBDAS',
      creator: { uid: 'x' },
      inspectorUrl: null,
      meta: {},
      target: 'production',
      projectId: 'prj_Qm8kd7Vf2LpXr0aNc3TyEw9H',
    },
  ],
  pagination: { count: 4, next: 1791190000000, prev: 1791280800000 },
}

/** The same first deployment, a poll later: READY. */
export function readyLater(): typeof DEPLOYMENTS {
  const copy = JSON.parse(JSON.stringify(DEPLOYMENTS)) as typeof DEPLOYMENTS
  const first = copy.deployments[0] as Record<string, unknown>
  first['state'] = 'READY'
  first['readyState'] = 'READY'
  first['ready'] = 1791280870000
  return copy
}

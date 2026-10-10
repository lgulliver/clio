import { describe, expect, it } from 'vitest';
import { collectGitHubDeployments, parseGitHubCheckpoint } from '../src/index.ts';
import { deployment, metadata, observedAt, response, status, transport } from './fixtures.ts';

const path = '/repos/renamed-owner/renamed-repo/deployments';
const link = (resource: string, page: number) => ({
  link: `<https://api.github.com${resource}?per_page=100&page=${page}>; rel="next"`,
});
function input(fetch: Parameters<typeof collectGitHubDeployments>[0]['fetch']) {
  return {
    instance: 'installation-1',
    repositoryId: 11,
    token: 'fictional-token',
    clock: () => new Date(observedAt),
    fetch,
  };
}

describe('GitHub resumable collection', () => {
  it('resumes status pages before deployment pages and never claims a split traversal complete', async () => {
    const first = transport([
      response(metadata),
      response([deployment()], link(path, 2)),
      response([status()], link(`${path}/21/statuses`, 2)),
    ]);
    const a = await collectGitHubDeployments({
      ...input(first.fetch),
      maxPages: 3,
      incremental: { checkpoint: null, deployments: [] },
    });
    expect(a.checkpoint).toEqual({ deploymentPage: 2, statuses: [{ deploymentId: 21, page: 2 }] });
    expect(a.statuses).toHaveLength(1);
    expect(a.completedStatusTraversals).toHaveLength(0);
    const second = transport([
      response(metadata),
      response([status(), status({ id: 32 })]),
      response([deployment({ id: 22 })]),
      response([status({ id: 33 })]),
    ]);
    const b = await collectGitHubDeployments({
      ...input(second.fetch),
      incremental: {
        checkpoint: parseGitHubCheckpoint(JSON.parse(JSON.stringify(a.checkpoint))),
        deployments: a.deployments,
      },
    });
    expect(
      second.calls.map((call) => new URL(call.url).pathname + new URL(call.url).search),
    ).toEqual([
      '/repositories/11',
      `${path}/21/statuses?per_page=100&page=2`,
      `${path}?per_page=100&page=2`,
      `${path}/22/statuses?per_page=100&page=1`,
    ]);
    expect(b.checkpoint).toBeNull();
    expect(b.transportComplete).toBe(false);
    expect(b.deployments).toHaveLength(1);
    expect(b.deployments[0]?.sourceDeploymentId).toBe('repository:11:deployment:22');
    expect((b.completedStatusTraversals ?? []).map((item) => item.deploymentId)).toEqual([
      b.deployments[0]?.id,
    ]);
    // A completed sweep restarts at page one so later source additions can be acquired.
    const catchup = transport([
      response(metadata),
      response([deployment({ id: 23 })]),
      response([]),
    ]);
    const c = await collectGitHubDeployments({
      ...input(catchup.fetch),
      incremental: {
        checkpoint: b.checkpoint ?? null,
        deployments: [...a.deployments, ...b.deployments],
      },
    });
    expect(catchup.calls[1]?.url).toContain('page=1');
    expect(c.deployments[0]?.sourceDeploymentId).toBe('repository:11:deployment:23');
  });

  it('persists empty-page progress and pending statuses even after deployment pagination ends', async () => {
    const first = transport([response(metadata), response([], link(path, 2))]);
    const a = await collectGitHubDeployments({
      ...input(first.fetch),
      maxPages: 2,
      incremental: { checkpoint: null, deployments: [] },
    });
    expect(a.deployments).toHaveLength(0);
    expect(a.checkpoint).toEqual({ deploymentPage: 2, statuses: [] });
    const second = transport([response(metadata), response([deployment()])]);
    const b = await collectGitHubDeployments({
      ...input(second.fetch),
      maxPages: 2,
      incremental: { checkpoint: a.checkpoint ?? null, deployments: [] },
    });
    expect(b.checkpoint).toEqual({
      deploymentPage: null,
      statuses: [{ deploymentId: 21, page: 1 }],
    });
    const third = transport([response(metadata), response([])]);
    const c = await collectGitHubDeployments({
      ...input(third.fetch),
      incremental: { checkpoint: b.checkpoint ?? null, deployments: b.deployments },
    });
    expect(c.completedStatusTraversals).toHaveLength(1);
    expect(c.checkpoint).toBeNull();
    expect(c.deployments).toHaveLength(0);
  });

  it('rejects malformed pagination without accepting evidence or advancing checkpoint', async () => {
    const mock = transport([response(metadata), response([deployment()], link('/other', 3))]);
    const checkpoint = { deploymentPage: 2, statuses: [] };
    const result = await collectGitHubDeployments({
      ...input(mock.fetch),
      incremental: { checkpoint, deployments: [] },
    });
    expect(result.checkpoint).toEqual(checkpoint);
    expect(result.deployments).toHaveLength(0);
    expect(result.diagnostics[0]?.code).toBe('unsafe_pagination');
  });

  it('rejects oversized deployment pages before cursor queue or evidence changes', async () => {
    const mock = transport([
      response(metadata),
      response(Array.from({ length: 101 }, (_, n) => deployment({ id: n + 1 }))),
    ]);
    const result = await collectGitHubDeployments({
      ...input(mock.fetch),
      incremental: { checkpoint: null, deployments: [] },
    });
    expect(result.deployments).toHaveLength(0);
    expect(result.checkpoint).toEqual({ deploymentPage: 1, statuses: [] });
    expect(result.diagnostics[0]?.code).toBe('invalid_page');
  });

  it('does not fetch pending statuses without matching retained repository identity', async () => {
    const mock = transport([response(metadata)]);
    const result = await collectGitHubDeployments({
      ...input(mock.fetch),
      incremental: {
        checkpoint: { deploymentPage: null, statuses: [{ deploymentId: 21, page: 2 }] },
        deployments: [],
      },
    });
    expect(mock.calls).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('checkpoint_deployment_missing');
    expect(result.checkpoint?.statuses[0]?.page).toBe(2);
  });

  it.each([
    null,
    {},
    { deploymentPage: 0, statuses: [] },
    { deploymentPage: 1.5, statuses: [] },
    { deploymentPage: Number.MAX_SAFE_INTEGER + 1, statuses: [] },
    { deploymentPage: 'https://api.github.com', statuses: [] },
    { deploymentPage: null, statuses: [] },
    { deploymentPage: 1, statuses: [], token: 'secret' },
    { deploymentPage: 1, statuses: [{ deploymentId: 1, page: 0 }] },
    { deploymentPage: 1, statuses: [{ deploymentId: 1, page: 1, url: '/evil' }] },
    {
      deploymentPage: 1,
      statuses: [
        { deploymentId: 1, page: 1 },
        { deploymentId: 1, page: 2 },
      ],
    },
    {
      deploymentPage: 1,
      statuses: Array.from({ length: 101 }, (_, n) => ({ deploymentId: n + 1, page: 1 })),
    },
  ])('rejects invalid stored checkpoint %#', (value) => {
    expect(() => parseGitHubCheckpoint(value)).toThrow();
  });
});

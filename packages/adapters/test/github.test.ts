import { describe, expect, it } from 'vitest';
import { collectGitHubDeployments, githubApiVersion } from '../src/index.ts';
import { deployment, metadata, observedAt, response, status, transport } from './fixtures.ts';

const path = '/repos/renamed-owner/renamed-repo/deployments';
function input(fetch: Parameters<typeof collectGitHubDeployments>[0]['fetch']) {
  return {
    instance: 'installation-1',
    repositoryId: 11,
    token: 'fictional-installation-token',
    clock: () => new Date(observedAt),
    fetch,
  };
}
describe('GitHub full-backfill collector', () => {
  it('resolves stable repository, traverses unfiltered deployments/statuses, dedupes replay and discards payload', async () => {
    const mock = transport([
      response(metadata),
      response([deployment()], {
        link: `<https://api.github.com${path}?per_page=100&page=2>; rel="next"`,
      }),
      response([deployment()]),
      response([status()], {
        link: `<https://api.github.com${path}/21/statuses?per_page=100&page=2>; rel="next"`,
      }),
      response([status(), status({ id: 32, state: 'inactive' })]),
    ]);
    const result = await collectGitHubDeployments(input(mock.fetch));
    expect(result.transportComplete).toBe(true);
    expect(result.deployments).toHaveLength(1);
    expect(result.statuses).toHaveLength(2);
    expect(result.statuses[0]?.environment).toBe('prod');
    expect(JSON.stringify(result)).not.toContain('discard-me');
    expect(mock.calls[0]?.url).toBe('https://api.github.com/repositories/11');
    for (const call of mock.calls) {
      expect(call.url).not.toContain('environment=');
      expect(call.init.redirect).toBe('error');
      expect(new Headers(call.init.headers).get('X-GitHub-Api-Version')).toBe(githubApiVersion);
    }
    expect(result.deployments[0]?.observedAt).toBe(new Date(observedAt).toISOString());
  });
  it.each([
    `https://evil.test${path}?per_page=100&page=2`,
    `http://api.github.com${path}?per_page=100&page=2`,
    `https://user:password@api.github.com${path}?per_page=100&page=2`,
    `https://api.github.com/other?per_page=100&page=2`,
    `https://api.github.com${path}?per_page=100&page=1`,
    `https://api.github.com${path}?per_page=100&page=3`,
    `https://api.github.com${path}?per_page=100&page=2&environment=prod`,
    `https://api.github.com${path}?per_page=100&page=2#fragment`,
    `https://api.github.com${path}?per_page=100&page=2&page=2`,
  ])('never follows unsafe next link %s', async (url) => {
    const mock = transport([
      response(metadata),
      response([deployment()], { link: `<${url}>; rel="next"` }),
    ]);
    const result = await collectGitHubDeployments(input(mock.fetch));
    expect(result.transportComplete).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('unsafe_pagination');
    expect(result.deployments).toHaveLength(0);
    expect(mock.calls).toHaveLength(2);
  });
  it('retains deployment as partial evidence when status predates its request', async () => {
    const mock = transport([
      response(metadata),
      response([deployment()]),
      response([
        status({ created_at: '2026-01-01T09:00:00Z', updated_at: '2026-01-01T09:00:00Z' }),
      ]),
    ]);
    const result = await collectGitHubDeployments(input(mock.fetch));
    expect(result.transportComplete).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('status_before_deployment');
    expect(result.deployments).toHaveLength(1);
    expect(result.statuses).toHaveLength(0);
  });
  it('retains deployment revisions and requests statuses once per stable operation', async () => {
    const mock = transport([
      response(metadata),
      response([
        deployment({
          environment: 'prod',
          updated_at: '2026-01-02T00:00:00Z',
          task: 'deploy:migrations',
        }),
        deployment({ task: 'deploy:migrations' }),
      ]),
      response([status()]),
    ]);
    const result = await collectGitHubDeployments(input(mock.fetch));
    expect(result.transportComplete).toBe(true);
    expect(result.deployments).toHaveLength(2);
    expect(
      result.deployments.every((record) => record.deploymentTask === 'deploy:migrations'),
    ).toBe(true);
    expect(mock.calls).toHaveLength(3);
    expect(result.statuses).toHaveLength(1);
  });
  it('retains primary rate-limit reset time for retry scheduling', async () => {
    const reset = Math.floor(new Date(observedAt).getTime() / 1000) + 120;
    const mock = transport([
      response({}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, 403),
    ]);
    const result = await collectGitHubDeployments(input(mock.fetch));
    expect(result.diagnostics[0]).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 120 });
  });
  it('rejects conflicting duplicate page atomically', async () => {
    const mock = transport([
      response(metadata),
      response([deployment(), deployment({ sha: 'b'.repeat(40) })]),
    ]);
    const result = await collectGitHubDeployments(input(mock.fetch));
    expect(result.diagnostics[0]?.code).toBe('conflicting_source_record');
    expect(result.deployments).toHaveLength(0);
  });
  it('keeps earlier pages when later page conflicts', async () => {
    const mock = transport([
      response(metadata),
      response([deployment()], {
        link: `<https://api.github.com${path}?per_page=100&page=2>; rel="next"`,
      }),
      response([deployment({ sha: 'b'.repeat(40) })]),
    ]);
    const result = await collectGitHubDeployments(input(mock.fetch));
    expect(result.deployments).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('conflicting_source_record');
  });
  it.each([401, 403, 404, 429])(
    'keeps partial evidence and safe HTTP %i diagnostics',
    async (code) => {
      const mock = transport([
        response(metadata),
        response([deployment()]),
        response({ message: 'private-error' }, code === 429 ? { 'retry-after': '30' } : {}, code),
      ]);
      const result = await collectGitHubDeployments(input(mock.fetch));
      expect(result.transportComplete).toBe(false);
      expect(result.deployments).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe(code === 429 ? 'rate_limited' : `http_${code}`);
      expect(result.diagnostics[0]?.retryAfterSeconds).toBe(code === 429 ? 30 : null);
      expect(JSON.stringify(result)).not.toContain('private-error');
    },
  );
  it('detects exhausted rate limit 403', async () => {
    const result = await collectGitHubDeployments(
      input(transport([response({}, { 'x-ratelimit-remaining': '0' }, 403)]).fetch),
    );
    expect(result.diagnostics[0]?.code).toBe('rate_limited');
  });
  it('empty transport is complete without making OEMS coverage assertions', async () => {
    const result = await collectGitHubDeployments(
      input(transport([response(metadata), response([])]).fetch),
    );
    expect(result).toMatchObject({
      transportComplete: true,
      deployments: [],
      statuses: [],
      diagnostics: [],
    });
    expect(result).not.toHaveProperty('collection_complete');
  });
  it('rejects invalid JSON, invalid ids and future source timestamps', async () => {
    const invalid = await collectGitHubDeployments(
      input(transport([response(metadata), new Response('private invalid JSON')]).fetch),
    );
    expect(invalid.diagnostics[0]?.code).toBe('invalid_json');
    for (const row of [
      deployment({ id: 0 }),
      deployment({ created_at: '2027-01-01T00:00:00Z' }),
      deployment({ created_at: '2026-02-30T00:00:00Z' }),
    ]) {
      const result = await collectGitHubDeployments(
        input(transport([response(metadata), response([row])]).fetch),
      );
      expect(result.transportComplete).toBe(false);
      expect(result.deployments).toHaveLength(0);
    }
  });
  it('validates explicit binding and stable repository metadata', async () => {
    const mismatch = await collectGitHubDeployments({
      ...input(transport([response(metadata)]).fetch),
      binding: { owner: 'old-owner', name: 'old-name' },
    });
    expect(mismatch.diagnostics[0]?.code).toBe('repository_binding_mismatch');
    const wrongId = await collectGitHubDeployments(
      input(transport([response({ ...metadata, id: 99 })]).fetch),
    );
    expect(wrongId.diagnostics[0]?.code).toBe('repository_binding_mismatch');
  });
  it('bounds traversal pages and record counts', async () => {
    const pageLimited = await collectGitHubDeployments({
      ...input(transport([response(metadata)]).fetch),
      maxPages: 1,
    });
    expect(pageLimited.diagnostics[0]?.code).toBe('page_limit');
    const recordLimited = await collectGitHubDeployments({
      ...input(
        transport([response(metadata), response([deployment(), deployment({ id: 22 })])]).fetch,
      ),
      maxRecords: 1,
    });
    expect(recordLimited.diagnostics[0]?.code).toBe('record_limit');
  });
  it('cancels and allows honest full replay after interrupted statuses', async () => {
    const controller = new AbortController();
    const mock = transport([response(metadata), response([deployment()])]);
    const interrupted = await collectGitHubDeployments({
      ...input(async (url, init) => {
        if (url.includes('/statuses')) {
          controller.abort();
          throw new Error('private error');
        }
        return mock.fetch(url, init);
      }),
      signal: controller.signal,
    });
    expect(interrupted.diagnostics[0]?.code).toBe('cancelled');
    const replay = await collectGitHubDeployments(
      input(transport([response(metadata), response([deployment()]), response([status()])]).fetch),
    );
    expect(replay.transportComplete).toBe(true);
    expect(replay.deployments[0]).toEqual(interrupted.deployments[0]);
    expect(replay.statuses).toHaveLength(1);
  });
});

it.each([
  'garbage',
  `<https://api.github.com${path}?per_page=100&page=2>; rel=next`,
  `<https://api.github.com${path}?per_page=100&page=2>; rel="next", <https://api.github.com${path}?per_page=100&page=2>; rel="next"`,
])('rejects malformed or duplicated pagination %s', async (link) => {
  const mock = transport([response(metadata), response([deployment()], { link })]);
  const result = await collectGitHubDeployments(input(mock.fetch));
  expect(result.transportComplete).toBe(false);
  expect(result.diagnostics[0]?.code).toBe('invalid_pagination');
  expect(mock.calls).toHaveLength(2);
});

it('rejects redirect transport without retrying arbitrary destination', async () => {
  const mock = transport([response(metadata)]);
  const result = await collectGitHubDeployments(
    input(async (url, init) => {
      if (url.includes('/deployments')) {
        expect(init.redirect).toBe('error');
        throw new Error('redirect to https://evil.test with private details');
      }
      return mock.fetch(url, init);
    }),
  );
  expect(result.diagnostics[0]?.code).toBe('transport_failed');
  expect(JSON.stringify(result)).not.toContain('evil.test');
});

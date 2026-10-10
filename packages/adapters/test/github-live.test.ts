import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createBoundedGitHubTransport,
  type FetchTransport,
  verifyGitHubScope,
} from '../src/index.ts';
import { object } from '../src/value.ts';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const minimal = { deployments: 'read', metadata: 'read' };
const account = { id: 22, type: 'Organization', login: 'fictional-org' };
const repo = {
  id: 33,
  owner: account,
  name: 'fictional-repo',
  full_name: 'fictional-org/fictional-repo',
};
function bodies(): unknown[] {
  return [
    {
      id: 11,
      app_id: 123,
      account,
      suspended_at: null,
      suspended_by: null,
      repository_selection: 'selected',
      permissions: minimal,
    },
    {
      token: 'fictional-token',
      expires_at: '2026-01-04T01:00:00Z',
      repository_selection: 'selected',
      permissions: minimal,
    },
    repo,
    { total_count: 1, repositories: [repo] },
  ];
}
function setup(values = bodies()) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchTransport = async (url, init) => {
    calls.push({ url, init });
    return Response.json(values.shift());
  };
  return {
    calls,
    input: {
      appId: '123',
      privateKey: key,
      installationId: 11,
      accountId: 22,
      accountType: 'Organization' as const,
      repositoryId: 33,
      clock: () => new Date('2026-01-04T00:00:00Z'),
      fetch,
    },
  };
}
describe('live GitHub scope verification', () => {
  it('checks App installation before issuing narrowed token and confirming numeric repo and exact list', async () => {
    const { input, calls } = setup();
    await expect(verifyGitHubScope(input)).resolves.toEqual({
      accountLogin: account.login,
      repositoryName: repo.name,
      token: 'fictional-token',
      expiresAt: '2026-01-04T01:00:00Z',
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/app/installations/11',
      'https://api.github.com/app/installations/11/access_tokens',
      'https://api.github.com/repositories/33',
      'https://api.github.com/installation/repositories?per_page=100&page=1',
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      repository_ids: [33],
      permissions: minimal,
    });
    expect(new Headers(calls[2]?.init.headers).get('Authorization')).toBe('Bearer fictional-token');
  });
  it.each([
    { id: 12 },
    { app_id: 124 },
    { account: { ...account, id: 23 } },
    { account: { ...account, type: 'User' } },
    { suspended_at: '2026-01-01T00:00:00Z' },
    { suspended_by: account },
    { repository_selection: 'all' },
    { permissions: { ...minimal, contents: 'read' } },
    { permissions: { deployments: 'write', metadata: 'read' } },
    { permissions: { deployments: 'read' } },
    { id: '11' },
  ])('rejects installation mismatch before token issuance %j', async (patch) => {
    const values = bodies();
    values[0] = { ...object(values[0]), ...patch };
    const { input, calls } = setup(values);
    await expect(verifyGitHubScope(input)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it.each([
    { permissions: { ...minimal, contents: 'read' } },
    { permissions: { deployments: 'write', metadata: 'read' } },
    { repository_selection: 'all' },
    { expires_at: '2026-01-04T00:00:30Z' },
    { token: 42 },
  ])('rejects expanded or malformed token %j', async (patch) => {
    const values = bodies();
    values[1] = { ...object(values[1]), ...patch };
    const { input, calls } = setup(values);
    await expect(verifyGitHubScope(input)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
  it.each([
    { ...repo, id: 34 },
    { ...repo, id: '33' },
    { ...repo, full_name: 'other/repo' },
    { ...repo, owner: { ...account, id: 23 } },
    { ...repo, name: '../unsafe' },
  ])('rejects canonical repository mismatch %j', async (value) => {
    const values = bodies();
    values[2] = value;
    await expect(verifyGitHubScope(setup(values).input)).rejects.toThrow();
  });
  it.each([
    { total_count: 2, repositories: [repo] },
    { total_count: 1, repositories: [repo, repo] },
    { total_count: 0, repositories: [] },
    { total_count: 1, repositories: [{ ...repo, id: 34 }] },
    {
      total_count: 1,
      repositories: [{ ...repo, name: 'renamed', full_name: 'fictional-org/renamed' }],
    },
  ])('requires exact one token repository %j', async (value) => {
    const values = bodies();
    values[3] = value;
    await expect(verifyGitHubScope(setup(values).input)).rejects.toThrow();
  });
  it('rejects token repository pagination even when body claims exactly one repository', async () => {
    const mock = setup();
    const fetch: FetchTransport = async (url, init) => {
      const response = await mock.input.fetch(url, init);
      if (url.includes('/installation/repositories?'))
        response.headers.set(
          'link',
          '<https://api.github.com/installation/repositories?page=2>; rel="next"',
        );
      return response;
    };
    await expect(verifyGitHubScope({ ...mock.input, fetch })).rejects.toThrow(
      /^github_repository_scope_mismatch$/,
    );
  });
  it('redacts HTTP bodies, invalid JSON and injected exceptions', async () => {
    for (const fetch of [
      async () => new Response('secret-key-token', { status: 403 }),
      async () => new Response('secret-key-token'),
      async () => {
        throw new Error('secret-key-token');
      },
    ]) {
      await expect(verifyGitHubScope({ ...setup().input, fetch })).rejects.toThrow(
        /^(github_http_403|invalid_github_json|transport_failed)$/,
      );
    }
  });
});
describe('bounded GitHub transport', () => {
  it.each([
    'http://api.github.com/x',
    'https://evil.example/x',
    'https://api.github.com@evil.example/x',
    'https://user@api.github.com/x',
  ])('rejects unsafe destination %s without calling fetch', async (url) => {
    let called = false;
    const fetch = createBoundedGitHubTransport({
      fetch: async () => {
        called = true;
        return new Response();
      },
    });
    await expect(fetch(url, {})).rejects.toThrow('unsafe_github_url');
    expect(called).toBe(false);
  });
  it('forces redirect error and rejects injected redirect response', async () => {
    const fetch = createBoundedGitHubTransport({
      fetch: async (_, init) => {
        expect(init.redirect).toBe('error');
        return new Response('private', {
          status: 302,
          headers: { Location: 'https://evil.example' },
        });
      },
    });
    await expect(fetch('https://api.github.com/x', { redirect: 'follow' })).rejects.toThrow(
      /^unsafe_github_redirect$/,
    );
  });
  it.each([undefined, '1', '999999'])(
    'counts streamed bytes regardless Content-Length %s',
    async (length) => {
      const fetch = createBoundedGitHubTransport({
        maxBytes: 3,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                controller.enqueue(new Uint8Array([3, 4]));
                controller.close();
              },
            }),
            { headers: length ? { 'Content-Length': length } : {} },
          ),
      });
      await expect(fetch('https://api.github.com/x', {})).rejects.toThrow(/^response_too_large$/);
    },
  );
  it.each(['request', 'body', 'cancel'])(
    'deadline settles uncooperative %s work',
    async (phase) => {
      const fetch = createBoundedGitHubTransport({
        timeoutMs: 15,
        fetch: async () => {
          if (phase === 'request') return new Promise<Response>(() => {});
          return new Response(
            new ReadableStream({
              pull: () => new Promise<void>(() => {}),
              cancel: () => new Promise<void>(() => {}),
            }),
          );
        },
      });
      await expect(fetch('https://api.github.com/x', {})).rejects.toThrow(/^transport_timeout$/);
    },
  );
  it.each(['request', 'body', 'before'])(
    'caller abort settles uncooperative %s work',
    async (phase) => {
      const controller = new AbortController();
      const fetch = createBoundedGitHubTransport({
        fetch: async () => {
          if (phase === 'request') return new Promise<Response>(() => {});
          return new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) }));
        },
      });
      if (phase === 'before') controller.abort('private-reason');
      const pending = fetch('https://api.github.com/x', { signal: controller.signal });
      setTimeout(() => controller.abort('private-reason'), 5);
      await expect(pending).rejects.toThrow(/^cancelled$/);
    },
  );
  it('redacts stream errors and aborts underlying transport on timeout', async () => {
    let signal: AbortSignal | null | undefined;
    const fetch = createBoundedGitHubTransport({
      timeoutMs: 15,
      fetch: async (_, init) => {
        signal = init.signal;
        return new Promise<Response>(() => {});
      },
    });
    await expect(fetch('https://api.github.com/x', {})).rejects.toThrow(/^transport_timeout$/);
    expect(signal?.aborted).toBe(true);
    const broken = createBoundedGitHubTransport({
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error('private-body-key'));
            },
          }),
        ),
    });
    await expect(broken('https://api.github.com/x', {})).rejects.toThrow(/^transport_failed$/);
  });
  it('rejects response URL redirect even when injected transport conceals redirect status', async () => {
    const response = new Response('private');
    Object.defineProperty(response, 'url', { value: 'https://evil.example/private' });
    const fetch = createBoundedGitHubTransport({ fetch: async () => response });
    await expect(fetch('https://api.github.com/x', {})).rejects.toThrow(/^unsafe_github_redirect$/);
  });
  it('returns fully buffered body readable through native response methods', async () => {
    const fetch = createBoundedGitHubTransport({ fetch: async () => Response.json({ ok: true }) });
    const result = await fetch('https://api.github.com/x', {});
    await expect(result.clone().json()).resolves.toEqual({ ok: true });
    await expect(result.text()).resolves.toBe('{"ok":true}');
  });
});

describe('live transport review regressions', () => {
  it('rejects injected streams yielding non-byte values before buffering', async () => {
    const fetch = createBoundedGitHubTransport({
      maxBytes: 8,
      fetch: async () => {
        const response = new Response();
        Object.defineProperty(response, 'body', {
          value: new ReadableStream<string>({
            start(controller) {
              controller.enqueue('oversized private value');
            },
          }),
        });
        return response;
      },
    });
    await expect(fetch('https://api.github.com/app', {})).rejects.toMatchObject({
      code: 'transport_failed',
    });
  });
  it('cancels scope verification during an uncooperative request without issuing a token', async () => {
    const { input } = setup();
    const controller = new AbortController();
    let calls = 0;
    let started: () => void = () => {};
    const beginning = new Promise<void>((resolve) => {
      started = resolve;
    });
    const result = verifyGitHubScope({
      ...input,
      signal: controller.signal,
      fetch: async () => {
        calls += 1;
        started();
        return new Promise<Response>(() => {});
      },
    });
    await beginning;
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toBe(1);
  });
});

it.each([
  { index: 0, patch: { id: 12 }, code: 'github_installation_mismatch', count: 1 },
  {
    index: 1,
    patch: { permissions: { deployments: 'write', metadata: 'read' } },
    code: 'github_permissions_mismatch',
    count: 2,
  },
  { index: 2, patch: { id: 34 }, code: 'github_repository_scope_mismatch', count: 3 },
  { index: 3, patch: { total_count: 2 }, code: 'github_repository_scope_mismatch', count: 4 },
])(
  'fails closed at intended verification phase: $code after $count calls',
  async ({ index, patch, code, count }) => {
    const values = bodies();
    values[index] = { ...object(values[index]), ...patch };
    const { input, calls } = setup(values);
    await expect(verifyGitHubScope(input)).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(count);
  },
);

import { randomUUID } from 'node:crypto';
import type { PullCheckpoint } from '@clio/adapters';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrations.ts';
import { type ClioAuth, createAuth } from '../src/features/identity/auth.ts';
import { readAuthConfig } from '../src/features/identity/config.ts';
import { createIdentityRepository } from '../src/features/identity/repository.ts';
import { createOrganizationRepository } from '../src/features/organization/repository.ts';
import { type SpaceGitHubConfig, spaceConfig } from '../src/features/space-github/config.ts';
import type { SpaceGitHubProvider } from '../src/features/space-github/provider.ts';
import { processOneSpaceGitHub } from '../src/features/space-github/worker.ts';
import { createServer } from '../src/server.ts';

if (!process.env.CLIO_TEST_DATABASE_URL) throw new Error('CLIO_TEST_DATABASE_URL required');
const connectionString = process.env.CLIO_TEST_DATABASE_URL;
const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString, connectionTimeoutMillis: 3000 });
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000,
});
const identity = createIdentityRepository(pool);
const organization = createOrganizationRepository(pool);
const config = readAuthConfig({
  AUTH_SECRET: 'space-http-fixture-only-123456789123456789123456789',
  AUTH_BASE_URL: 'http://localhost:3000',
  APP_ORIGIN: 'http://localhost:5173',
  GITHUB_CLIENT_ID: 'fixture-client',
  GITHUB_CLIENT_SECRET: 'fixture-secret',
});
if (!config) throw new Error('Fixture config missing');
let auth: ClioAuth;
let server: FastifyInstance;
let created = false;
let providerId = 40000;
const servers: FastifyInstance[] = [];
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected record');
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}
function cookieHeader(value: string | string[] | undefined) {
  return (typeof value === 'string' ? [value] : (value ?? []))
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}
async function login() {
  const id = String(++providerId);
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://github.com/login/oauth/access_token')
      return Response.json({
        access_token: 'fixture-transient',
        token_type: 'bearer',
        scope: 'read:user,user:email',
      });
    if (url === 'https://api.github.com/user')
      return Response.json({
        id,
        login: `space-${id}`,
        name: `Space ${id}`,
        email: `space-${id}@example.com`,
        avatar_url: null,
      });
    if (url === 'https://api.github.com/user/emails')
      return Response.json([
        { email: `space-${id}@example.com`, primary: true, verified: true, visibility: 'private' },
      ]);
    throw new Error('Unexpected external request');
  });
  const start = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: { origin: 'http://localhost:5173' },
    payload: { provider: 'github', disableRedirect: true },
  });
  expect(start.statusCode).toBe(200);
  const state = new URL(string(record(start.json()).url)).searchParams.get('state');
  const callback = await server.inject({
    url: `/api/auth/callback/github?code=fixture&state=${encodeURIComponent(state ?? '')}`,
    headers: { cookie: cookieHeader(start.headers['set-cookie']) },
  });
  expect(callback.statusCode).toBe(302);
  const cookie = cookieHeader(callback.headers['set-cookie']);
  const current = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!current) throw new Error('Fixture session absent');
  return { userId: current.user.id, sessionId: current.session.id, cookie };
}
const window = { windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-03T00:00:00.000Z' };
const checkpoint: PullCheckpoint = {
  version: 1,
  phase: 'ready',
  repositoryId: 20,
  repositoryOwner: 'fixture',
  repositoryName: 'repo',
  nextPullPage: null,
  nextReviewIndex: 0,
  nextReviewPage: 1,
  pulls: [],
  reviews: [],
  reviewTraversalComplete: [],
  discoveryTraversalComplete: true,
  gaps: [],
};
const provider: SpaceGitHubProvider = {
  verify: async () => ({
    accountLogin: 'fixture',
    repositoryName: 'repo',
    token: 'PRIVATE-FIXTURE-TOKEN',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }),
  collect: async () => ({ checkpoint, done: true, activeMillis: 1, requests: 0 }),
};
function http(
  featureConfig: SpaceGitHubConfig | null,
  fixtureProvider = provider,
  withIdentity = true,
) {
  if (!config) throw new Error('Fixture config missing');
  const api = createServer(
    { ready: async () => {}, close: async () => {} },
    withIdentity
      ? { pool, auth, config, spaceGithub: featureConfig, spaceGithubProvider: fixtureProvider }
      : undefined,
  );
  servers.push(api);
  return api;
}
async function fixture() {
  const owner = await login(),
    member = await login();
  const workspace = await identity.createWorkspace(owner, 'HTTP fixture');
  const team = await organization.createTeam(owner, workspace.id, 'Team');
  await pool.query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    [workspace.id, member.userId],
  );
  const featureConfig = spaceConfig({
    appId: 12,
    privateKey: 'PRIVATE-FIXTURE-KEY',
    grants: [
      {
        workspaceId: workspace.id,
        installationId: 10,
        accountId: 30,
        accountType: 'Organization',
        repositoryIds: [20],
        fingerprint: 'f'.repeat(64),
      },
      {
        workspaceId: randomUUID(),
        installationId: 11,
        accountId: 31,
        accountType: 'User',
        repositoryIds: [21],
        fingerprint: 'g'.repeat(64),
      },
    ],
  });
  const api = http(featureConfig);
  const base = `/api/workspaces/${workspace.id}/space/github`;
  const headers = { cookie: owner.cookie, origin: 'http://localhost:5173' };
  const body = { teamId: team.id, installationId: 10, repositoryId: 20 };
  async function save() {
    const response = await api.inject({
      method: 'POST',
      url: `${base}/mappings`,
      headers,
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    return record(record(response.json()).mapping);
  }
  return { owner, member, workspace, team, featureConfig, api, base, headers, body, save };
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool);
  auth = createAuth(pool, config);
  server = createServer({ ready: async () => {}, close: async () => {} }, { pool, auth, config });
  await server.ready();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.map((api) => api.close()));
  if (server) await server.close();
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});
it('exposes only safe workspace grants to owners; members only enabled state', async () => {
  const f = await fixture();
  const owner = await f.api.inject({ url: `${f.base}/availability`, headers: f.headers });
  expect(owner.statusCode).toBe(200);
  expect(owner.json()).toEqual({
    workspaceId: f.workspace.id,
    enabled: true,
    grants: [
      {
        appId: 12,
        installationId: 10,
        accountId: 30,
        accountType: 'Organization',
        repositoryIds: [20],
      },
    ],
  });
  expect(owner.body).not.toMatch(/PRIVATE|fingerprint|profile/);
  const member = await f.api.inject({
    url: `${f.base}/availability`,
    headers: { cookie: f.member.cookie },
  });
  expect(member.json()).toEqual({ workspaceId: f.workspace.id, enabled: true });
  expect(member.headers['cache-control']).toBe('no-store');
});
it('rejects unauthenticated, wrong Origin, member writes and cross-workspace resources', async () => {
  const f = await fixture(),
    mapping = await f.save();
  expect((await f.api.inject(`${f.base}/mappings`)).statusCode).toBe(401);
  for (const headers of [
    { cookie: f.owner.cookie },
    { ...f.headers, origin: 'https://wrong.example' },
    { ...f.headers, cookie: f.member.cookie },
  ]) {
    const denied = await f.api.inject({
      method: 'POST',
      url: `${f.base}/mappings`,
      headers,
      payload: f.body,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['cache-control']).toBe('no-store');
  }
  const invalidDenied = await f.api.inject({
    method: 'POST',
    url: `${f.base}/mappings`,
    headers: { ...f.headers, origin: 'https://wrong.example' },
    payload: { unexpected: true },
  });
  expect(invalidDenied.statusCode).toBe(403);
  expect(invalidDenied.json()).toEqual({ error: 'forbidden' });
  expect(invalidDenied.headers['cache-control']).toBe('no-store');
  const other = await identity.createWorkspace(f.owner, 'Other');
  const missing = await f.api.inject({
    url: `/api/workspaces/${other.id}/space/github/mappings/${mapping.id}/runs`,
    headers: f.headers,
  });
  expect(missing.statusCode).toBe(404);
  const outsider = await login();
  expect(
    (await f.api.inject({ url: `${f.base}/mappings`, headers: { cookie: outsider.cookie } }))
      .statusCode,
  ).toBe(404);
});
it('rejects unknown fields, stale revision, ungranted repositories, invalid cursor and foreign team', async () => {
  const f = await fixture();
  for (const payload of [
    { ...f.body, extra: 'PRIVATE' },
    { ...f.body, repositoryId: 21 },
    { ...f.body, teamId: randomUUID() },
  ]) {
    const response = await f.api.inject({
      method: 'POST',
      url: `${f.base}/mappings`,
      headers: f.headers,
      payload,
    });
    expect(response.statusCode).toBe(
      'extra' in payload ? 400 : payload.repositoryId === 21 ? 403 : 404,
    );
    expect(response.body).not.toContain('PRIVATE');
  }
  const mapping = await f.save();
  expect(
    (
      await f.api.inject({
        method: 'PATCH',
        url: `${f.base}/mappings/${mapping.id}`,
        headers: f.headers,
        payload: { revision: 2, teamId: f.team.id },
      })
    ).statusCode,
  ).toBe(409);
  for (const query of ['?cursor=!', '?extra=1', '?teamId=invalid'])
    expect(
      (await f.api.inject({ url: `${f.base}/mappings${query}`, headers: f.headers })).statusCode,
    ).toBe(400);
});
it.each(['demote', 'revoke-session', 'remove-member'] as const)(
  'rechecks actual %s after provider verification before saving',
  async (action) => {
    const f = await fixture();
    const raced = http(f.featureConfig, {
      ...provider,
      verify: async (input) => {
        if (action === 'demote')
          await pool.query(
            "UPDATE workspace_memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",
            [f.workspace.id, f.owner.userId],
          );
        if (action === 'remove-member')
          await pool.query(
            'DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
            [f.workspace.id, f.owner.userId],
          );
        if (action === 'revoke-session')
          await pool.query('DELETE FROM auth_sessions WHERE id=$1', [f.owner.sessionId]);
        return provider.verify(input);
      },
    });
    const response = await raced.inject({
      method: 'POST',
      url: `${f.base}/mappings`,
      headers: f.headers,
      payload: f.body,
    });
    expect(response.statusCode).toBe(
      action === 'demote' ? 403 : action === 'revoke-session' ? 401 : 404,
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(
      (
        await pool.query('SELECT id FROM space_github_mappings WHERE workspace_id=$1', [
          f.workspace.id,
        ])
      ).rowCount,
    ).toBe(0);
  },
);
it('validates closed collection days against the database when the API clock trails UTC midnight', async () => {
  const f = await fixture();
  const mapping = await f.save();
  const clock = await pool.query<{ window_end: string }>(
    "SELECT to_char(date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS window_end",
  );
  const windowEnd = clock.rows[0]?.window_end;
  if (!windowEnd) throw new Error('Missing database clock');
  const windowStart = new Date(Date.parse(windowEnd) - 86400000).toISOString();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(windowEnd) - 1);
  try {
    const response = await f.api.inject({
      method: 'POST',
      url: `${f.base}/mappings/${mapping.id}/runs`,
      headers: f.headers,
      payload: { revision: 1, requestId: randomUUID(), windowStart, windowEnd },
    });
    expect(response.statusCode).toBe(202);
    expect(record(record(response.json()).run)).toMatchObject({ windowStart, windowEnd });
    const future = await f.api.inject({
      method: 'POST',
      url: `${f.base}/mappings/${mapping.id}/runs`,
      headers: f.headers,
      payload: {
        revision: 1,
        requestId: randomUUID(),
        windowStart: windowEnd,
        windowEnd: new Date(Date.parse(windowEnd) + 2 * 86400000).toISOString(),
      },
    });
    expect(future.statusCode).toBe(400);
  } finally {
    vi.useRealTimers();
  }
});

it('preserves saved results after config loss, disconnect and team deletion; replays enqueue exactly', async () => {
  const f = await fixture(),
    mapping = await f.save();
  const request = { revision: 1, requestId: randomUUID(), ...window };
  const response = await f.api.inject({
    method: 'POST',
    url: `${f.base}/mappings/${mapping.id}/runs`,
    headers: f.headers,
    payload: request,
  });
  expect(response.statusCode).toBe(202);
  const run = record(record(response.json()).run);
  expect(
    (
      await f.api.inject({
        method: 'POST',
        url: `${f.base}/mappings/${mapping.id}/runs`,
        headers: f.headers,
        payload: request,
      })
    ).json(),
  ).toEqual({ run });
  expect(
    (
      await f.api.inject({
        method: 'POST',
        url: `${f.base}/mappings/${mapping.id}/runs`,
        headers: f.headers,
        payload: { ...request, revision: 2 },
      })
    ).statusCode,
  ).toBe(409);
  await processOneSpaceGitHub(pool, f.featureConfig, { provider });
  const disabled = http(null);
  await expect(organization.deleteTeam(f.owner, f.workspace.id, f.team.id)).rejects.toMatchObject({
    status: 409,
  });
  expect(
    (await disabled.inject({ url: `${f.base}/availability`, headers: f.headers })).json(),
  ).toEqual({ workspaceId: f.workspace.id, enabled: false, grants: [] });
  const disconnected = await disabled.inject({
    method: 'POST',
    url: `${f.base}/mappings/${mapping.id}/disconnect`,
    headers: f.headers,
    payload: { revision: 1 },
  });
  expect(disconnected.statusCode).toBe(200);
  expect(record(record(disconnected.json()).mapping).connected).toBe(false);
  // Exact original revision is idempotent; dependency fix must retain the same mapping.
  const replay = await disabled.inject({
    method: 'POST',
    url: `${f.base}/mappings/${mapping.id}/disconnect`,
    headers: f.headers,
    payload: { revision: 1 },
  });
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(disconnected.json());
  await organization.deleteTeam(f.owner, f.workspace.id, f.team.id);
  const history = await disabled.inject({
    url: `${f.base}/mappings/${mapping.id}/runs?teamId=${f.team.id}`,
    headers: { cookie: f.member.cookie },
  });
  const runs = record(history.json()).runs;
  if (!Array.isArray(runs)) throw new Error('Missing run page');
  const saved = record(runs[0]);
  expect(saved.state).toBe('succeeded');
  const result = await disabled.inject({
    url: `${f.base}/results/${saved.resultId}`,
    headers: { cookie: f.member.cookie },
  });
  expect(result.statusCode).toBe(200);
  expect(record(record(result.json()).result).teamName).toBe('Team');
  expect(result.body).not.toMatch(/PRIVATE|fingerprint|checkpoint|lease/);
  const results = await disabled.inject({
    url: `${f.base}/mappings/${mapping.id}/results?teamId=${f.team.id}`,
    headers: { cookie: f.member.cookie },
  });
  expect(results.statusCode).toBe(200);
  expect(results.json()).toEqual({
    workspaceId: f.workspace.id,
    mappingId: mapping.id,
    teamId: f.team.id,
    results: [record(result.json()).result],
    nextCursor: null,
  });
  const other = await identity.createWorkspace(f.owner, 'Other results');
  expect(
    (
      await disabled.inject({
        url: `/api/workspaces/${other.id}/space/github/results/${saved.resultId}`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await disabled.inject({
        method: 'POST',
        url: `${f.base}/mappings`,
        headers: f.headers,
        payload: f.body,
      })
    ).statusCode,
  ).toBe(404); // deleted team checked first
  expect(
    (
      await disabled.inject({
        method: 'POST',
        url: `${f.base}/mappings/${mapping.id}/runs`,
        headers: f.headers,
        payload: { ...request, requestId: randomUUID(), revision: 2 },
      })
    ).statusCode,
  ).toBe(409);
});
it('returns scoped 503 without identity and disabled availability without PR config', async () => {
  const f = await fixture();
  expect((await http(null, provider, false).inject(`${f.base}/availability`)).statusCode).toBe(503);
  const disabled = http(null);
  expect(
    (
      await disabled.inject({ url: `${f.base}/availability`, headers: { cookie: f.member.cookie } })
    ).json(),
  ).toEqual({ workspaceId: f.workspace.id, enabled: false });
  expect(
    (
      await disabled.inject({
        method: 'POST',
        url: `${f.base}/mappings`,
        headers: f.headers,
        payload: f.body,
      })
    ).statusCode,
  ).toBe(503);
});
it('enforces 25-row history pages and workspace/mapping/team/kind cursor context', async () => {
  const f = await fixture(),
    mapping = await f.save();
  const context = {
    workspaceId: f.workspace.id,
    mappingId: mapping.id,
    mappingRevision: 1,
    teamId: f.team.id,
    teamName: 'Team',
    appId: 12,
    installationId: 10,
    repositoryId: 20,
    repositoryLabel: 'fixture/repo',
    ...window,
  };
  for (let i = 0; i < 26; i++)
    await pool.query(
      "WITH fixture_clock AS MATERIALIZED (SELECT clock_timestamp()-interval '1 second' AS queued_at) INSERT INTO space_github_jobs(id,workspace_id,mapping_id,request_id,context,grant_fingerprint,state,reason,queued_at,expires_at,completed_at) SELECT $1,$2,$3,$4,$5,$6,'failed','provider_unavailable',queued_at,queued_at+interval '24 hours',queued_at+interval '1 millisecond' FROM fixture_clock",
      [
        randomUUID(),
        f.workspace.id,
        mapping.id,
        randomUUID(),
        JSON.stringify(context),
        f.featureConfig.grants[0]?.fingerprint,
      ],
    );
  const first = await f.api.inject({
    url: `${f.base}/mappings/${mapping.id}/runs?teamId=${f.team.id}`,
    headers: f.headers,
  });
  expect(first.statusCode).toBe(200);
  expect(record(first.json()).runs).toHaveLength(25);
  const cursor = string(record(first.json()).nextCursor);
  const second = await f.api.inject({
    url: `${f.base}/mappings/${mapping.id}/runs?teamId=${f.team.id}&cursor=${cursor}`,
    headers: f.headers,
  });
  expect(record(second.json()).runs).toHaveLength(1);
  expect(record(second.json()).nextCursor).toBeNull();
  for (const path of [
    `/mappings/${mapping.id}/runs?cursor=${cursor}`,
    `/mappings/${mapping.id}/results?teamId=${f.team.id}&cursor=${cursor}`,
    `/mappings?teamId=${f.team.id}&cursor=${cursor}`,
  ])
    expect((await f.api.inject({ url: f.base + path, headers: f.headers })).statusCode).toBe(400);
  const missingCursor = Buffer.from(
    JSON.stringify({
      scope: {
        kind: 'runs',
        workspaceId: f.workspace.id,
        mappingId: mapping.id,
        teamId: f.team.id,
      },
      id: randomUUID(),
    }),
  ).toString('base64url');
  expect(
    (
      await f.api.inject({
        url: `${f.base}/mappings/${mapping.id}/runs?teamId=${f.team.id}&cursor=${missingCursor}`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(404);
});
it('keeps connected history readable without PR config while new enqueue is unavailable', async () => {
  const f = await fixture(),
    mapping = await f.save();
  const disabled = http(null);
  const history = await disabled.inject({
    url: `${f.base}/mappings/${mapping.id}/runs`,
    headers: f.headers,
  });
  expect(history.statusCode).toBe(200);
  expect(record(history.json()).runs).toEqual([]);
  const enqueue = await disabled.inject({
    method: 'POST',
    url: `${f.base}/mappings/${mapping.id}/runs`,
    headers: f.headers,
    payload: { revision: 1, requestId: randomUUID(), ...window },
  });
  expect(enqueue.statusCode).toBe(503);
  expect(enqueue.json()).toEqual({ error: 'unavailable' });
});
it('revoked sessions/members lose reads; demoted owner loses grants and writes', async () => {
  const f = await fixture();
  await pool.query(
    "UPDATE workspace_memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [f.workspace.id, f.owner.userId],
  );
  expect(
    (await f.api.inject({ url: `${f.base}/availability`, headers: f.headers })).json(),
  ).toEqual({ workspaceId: f.workspace.id, enabled: true });
  expect(
    (
      await f.api.inject({
        method: 'POST',
        url: `${f.base}/mappings`,
        headers: f.headers,
        payload: f.body,
      })
    ).statusCode,
  ).toBe(403);
  await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
    f.workspace.id,
    f.member.userId,
  ]);
  expect(
    (await f.api.inject({ url: `${f.base}/mappings`, headers: { cookie: f.member.cookie } }))
      .statusCode,
  ).toBe(404);
  await pool.query('DELETE FROM auth_sessions WHERE id=$1', [f.owner.sessionId]);
  expect((await f.api.inject({ url: `${f.base}/mappings`, headers: f.headers })).statusCode).toBe(
    401,
  );
});
it('filters frozen team ownership before LIMIT and preserves current mapping owner', async () => {
  const f = await fixture(),
    mapping = await f.save();
  const otherTeam = await organization.createTeam(f.owner, f.workspace.id, 'Other team');
  const context = {
    workspaceId: f.workspace.id,
    mappingId: mapping.id,
    mappingRevision: 1,
    teamId: f.team.id,
    teamName: 'Team',
    appId: 12,
    installationId: 10,
    repositoryId: 20,
    repositoryLabel: 'fixture/repo',
    ...window,
  };
  const originalId = randomUUID();
  await pool.query(
    "WITH fixture_clock AS MATERIALIZED (SELECT clock_timestamp()-interval '1 hour' AS queued_at) INSERT INTO space_github_jobs(id,workspace_id,mapping_id,request_id,context,grant_fingerprint,state,reason,queued_at,expires_at,completed_at) SELECT $1,$2,$3,$4,$5,$6,'failed','provider_unavailable',queued_at,queued_at+interval '24 hours',queued_at+interval '1 millisecond' FROM fixture_clock",
    [
      originalId,
      f.workspace.id,
      mapping.id,
      randomUUID(),
      JSON.stringify(context),
      f.featureConfig.grants[0]?.fingerprint,
    ],
  );
  const update = await f.api.inject({
    method: 'PATCH',
    url: `${f.base}/mappings/${mapping.id}`,
    headers: f.headers,
    payload: { revision: 1, teamId: otherTeam.id },
  });
  expect(update.statusCode).toBe(200);
  expect(record(record(update.json()).mapping).revision).toBe(2);
  for (let i = 0; i < 26; i++)
    await pool.query(
      "WITH fixture_clock AS MATERIALIZED (SELECT clock_timestamp()-interval '1 second' AS queued_at) INSERT INTO space_github_jobs(id,workspace_id,mapping_id,request_id,context,grant_fingerprint,state,reason,queued_at,expires_at,completed_at) SELECT $1,$2,$3,$4,$5,$6,'failed','provider_unavailable',queued_at,queued_at+interval '24 hours',queued_at+interval '1 millisecond' FROM fixture_clock",
      [
        randomUUID(),
        f.workspace.id,
        mapping.id,
        randomUUID(),
        JSON.stringify({
          ...context,
          mappingRevision: 2,
          teamId: otherTeam.id,
          teamName: otherTeam.name,
        }),
        f.featureConfig.grants[0]?.fingerprint,
      ],
    );
  const history = await f.api.inject({
    url: `${f.base}/mappings/${mapping.id}/runs?teamId=${f.team.id}`,
    headers: f.headers,
  });
  expect(history.statusCode).toBe(200);
  const runs = record(history.json()).runs;
  if (!Array.isArray(runs)) throw new Error('Missing run page');
  expect(runs).toHaveLength(1);
  expect(record(runs[0])).toMatchObject({ id: originalId, teamId: f.team.id, teamName: 'Team' });
  expect(record(history.json()).nextCursor).toBeNull();
  const mappings = await f.api.inject({
    url: `${f.base}/mappings?teamId=${f.team.id}`,
    headers: f.headers,
  });
  expect(mappings.statusCode).toBe(200);
  const rows = record(mappings.json()).mappings;
  if (!Array.isArray(rows)) throw new Error('Missing mapping page');
  expect(rows).toHaveLength(1);
  expect(record(rows[0])).toMatchObject({ id: mapping.id, teamId: otherTeam.id });
});

import { randomUUID } from 'node:crypto';
import { AdapterError, collectGitHubDeployments, type GitHubBatch, identity } from '@clio/adapters';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrl } from '../src/config.ts';
import { checkReadiness, loadMigrations, migrate } from '../src/db/migrations.ts';
import { type GitHubConfig, parseGrants } from '../src/features/github-collection/config.ts';
import { snapshotDigest } from '../src/features/github-collection/digest.ts';
import { parseConnection } from '../src/features/github-collection/input.ts';
import { type GitHubProvider, githubProvider } from '../src/features/github-collection/provider.ts';
import { createGitHubRepository } from '../src/features/github-collection/repository.ts';
import { registerGitHubRoutes } from '../src/features/github-collection/routes.ts';
import { createGitHubWorker, processOne } from '../src/features/github-collection/worker.ts';
import { IdentityError } from '../src/features/identity/input.ts';
import { createIdentityRepository } from '../src/features/identity/repository.ts';

if (!process.env.CLIO_TEST_DATABASE_URL)
  throw new Error('CLIO_TEST_DATABASE_URL is required for PostgreSQL integration tests');
const connectionString = databaseUrl(process.env.CLIO_TEST_DATABASE_URL);
const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString, connectionTimeoutMillis: 3000 });
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000,
});
const identities = createIdentityRepository(pool);
const owner = { userId: 'github-owner', sessionId: 'github-owner-session' },
  member = { userId: 'github-member', sessionId: 'github-member-session' },
  outsider = { userId: 'github-outsider', sessionId: 'github-outsider-session' };
let created = false;
const migrations = await loadMigrations();
const window = { start: '2026-01-01T00:00:00.000Z', end: '2026-01-03T00:00:00.000Z' };
const settings = {
  expectedRevision: null,
  installationId: 10,
  repositoryId: 20,
  productionEnvironment: 'production',
  exposurePolicyReference: 'urn:fixture:policy:v1',
  repositoryDeploymentsBelongToService: true,
};
function batch(): GitHubBatch {
  const sourceId = identity('github', '10'),
    deploymentId = identity(sourceId, 'deployment', 20, 30),
    observedAt = new Date().toISOString();
  return {
    deployments: [
      {
        id: deploymentId,
        sourceId,
        sourceDeploymentId: identity('repository', 20, 'deployment', 30),
        revision: '2026-01-02T10:00:00Z',
        environment: 'production',
        eventAt: '2026-01-02T10:00:00Z',
        observedAt,
        sourceRef: `urn:clio:${identity('github', '10', 'repository', 20, 'deployment', 30)}`,
        repository: {
          repositoryId: identity('github', '10', 'repository', 20),
          tipSha: 'a'.repeat(40),
        },
        reconciledConfigurationRevision: null,
        configurationRepositoryId: null,
        deploymentTask: null,
        operationKind: 'rollout',
      },
    ],
    statuses: [
      {
        id: identity(sourceId, 'status', 20, 40),
        deploymentId,
        revision: '2026-01-02T10:01:00Z',
        environment: 'production',
        signal: 'success',
        health: null,
        consumerExposure: false,
        eventAt: '2026-01-02T10:01:00Z',
        observedAt,
        sourceRef: `urn:clio:${identity('github', '10', 'repository', 20, 'status', 40)}`,
      },
    ],
    completedStatusTraversals: [{ deploymentId, observedAt }],
    transportComplete: true,
    diagnostics: [],
  };
}
async function fixture(save = true) {
  const workspace = await identities.createWorkspace(owner, `GitHub fixture ${randomUUID()}`);
  const service = await identities.createService(owner, workspace.id, 'Fixture service');
  await pool.query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    [workspace.id, member.userId],
  );
  const config: GitHubConfig = Object.freeze({
    appId: 12,
    privateKey: 'fictional-not-a-signing-key',
    grants: parseGrants(
      [
        {
          workspaceId: workspace.id,
          installationId: 10,
          accountId: 11,
          accountType: 'Organization',
          repositoryIds: [20, 21],
        },
      ],
      12,
    ),
  });
  const provider = {
    verify: vi.fn(async (_input: Parameters<GitHubProvider['verify']>[0]) => ({
      accountLogin: 'fixture-owner',
      repositoryName: 'fixture-repo',
      token: 'private-fixture-token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })),
    collect: vi.fn(async (_input: Parameters<GitHubProvider['collect']>[0]) => batch()),
  };
  const repository = createGitHubRepository(pool, config, { provider });
  if (save) await repository.save(owner, workspace.id, service.id, settings);
  provider.verify.mockClear();
  const enqueue = (requestId = randomUUID(), revision = 1, w = window) =>
    repository.enqueue(owner, workspace.id, service.id, {
      connectionRevision: revision,
      requestId,
      window: w,
    });
  return {
    workspaceId: workspace.id,
    serviceId: service.id,
    config,
    provider,
    repository,
    enqueue,
    worker: createGitHubWorker(pool, config),
  };
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool, migrations);
  for (const actor of [owner, member, outsider]) {
    await pool.query('INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,$1,$2,true)', [
      actor.userId,
      `${actor.userId}@example.com`,
    ]);
    await pool.query(
      "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$1,now()+interval '1 day')",
      [actor.sessionId, actor.userId],
    );
  }
});
afterEach(async () => {
  await pool.query(
    "UPDATE github_collection_runs SET status='failed',failure_code='github_connection_revoked',completed_at=statement_timestamp(),updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE status IN ('pending','running')",
  );
  await pool.query('DELETE FROM github_quota_state');
  await pool.query(
    "UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
    [owner.sessionId],
  );
});
afterAll(async () => {
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});
describe('live GitHub PostgreSQL boundaries', () => {
  it('resumes persisted status pages with retained evidence across workers and resets after a sweep', async () => {
    const f = await fixture();
    const calls: string[] = [];
    const collect: GitHubProvider['collect'] = async (input) =>
      collectGitHubDeployments({
        ...input,
        instance: String(input.installationId),
        maxPages: 3,
        fetch: async (url) => {
          const parsed = new URL(url);
          calls.push(parsed.pathname + parsed.search);
          if (parsed.pathname === '/repositories/20')
            return Response.json({
              id: 20,
              name: 'fixture-repo',
              owner: { login: 'fixture-owner' },
            });
          if (parsed.pathname.endsWith('/deployments'))
            return Response.json([
              {
                id: 30,
                created_at: '2026-01-02T10:00:00Z',
                updated_at: '2026-01-02T10:00:00Z',
                environment: 'staging',
                sha: 'a'.repeat(40),
              },
            ]);
          const page = parsed.searchParams.get('page');
          return Response.json(
            [
              {
                id: page === '1' ? 40 : 41,
                created_at: '2026-01-02T10:01:00Z',
                updated_at: '2026-01-02T10:01:00Z',
                environment: page === '1' ? 'staging' : 'production',
                state: 'success',
              },
            ],
            page === '1'
              ? {
                  headers: {
                    link: '<https://api.github.com/repos/fixture-owner/fixture-repo/deployments/30/statuses?per_page=100&page=2>; rel="next"',
                  },
                }
              : {},
          );
        },
      });
    f.provider.collect.mockImplementation(collect);
    const first = await f.enqueue();
    await processOne(pool, f.config, { provider: f.provider });
    const cursor = (
      await pool.query<Record<string, unknown>>(
        'SELECT cursor FROM github_collection_checkpoints WHERE workspace_id=$1',
        [f.workspaceId],
      )
    ).rows[0]?.cursor;
    expect(cursor).toEqual({ deploymentPage: null, statuses: [{ deploymentId: 30, page: 2 }] });
    const firstStored = (
      await pool.query<Record<string, unknown>>(
        'SELECT evidence,digest FROM github_collection_snapshots WHERE run_id=$1',
        [first.id],
      )
    ).rows[0];
    calls.length = 0;
    const second = await f.enqueue();
    // A newly constructed worker/provider resumes exclusively from PostgreSQL state.
    await processOne(pool, f.config, { provider: { verify: f.provider.verify, collect } });
    expect(calls).toEqual([
      '/repositories/20',
      '/repos/fixture-owner/fixture-repo/deployments/30/statuses?per_page=100&page=2',
    ]);
    expect(
      (await f.repository.getRun(owner, f.workspaceId, f.serviceId, second.id)).result,
    ).toMatchObject({ qualifyingCount: 1, coverage: { collectionComplete: false } });
    const latest = (
      await pool.query<Record<string, unknown>>(
        'SELECT evidence FROM github_collection_snapshots WHERE run_id=$1',
        [second.id],
      )
    ).rows[0]?.evidence;
    expect(latest).toMatchObject({
      deployments: expect.any(Array),
      statuses: expect.arrayContaining([
        expect.objectContaining({ id: identity(identity('github', '10'), 'status', 20, 40) }),
        expect.objectContaining({ id: identity(identity('github', '10'), 'status', 20, 41) }),
      ]),
      completedStatusTraversals: [],
    });
    expect(
      (
        await pool.query<Record<string, unknown>>(
          'SELECT cursor FROM github_collection_checkpoints WHERE workspace_id=$1',
          [f.workspaceId],
        )
      ).rows[0]?.cursor,
    ).toBeNull();
    expect(
      (
        await pool.query<Record<string, unknown>>(
          'SELECT evidence,digest FROM github_collection_snapshots WHERE run_id=$1',
          [first.id],
        )
      ).rows[0],
    ).toEqual(firstStored);
    calls.length = 0;
    await f.enqueue();
    await processOne(pool, f.config, { provider: f.provider });
    expect(calls[1]).toContain('/deployments?per_page=100&page=1');
  });
  it('commits empty-page cursor progress without claiming complete coverage', async () => {
    const f = await fixture();
    f.provider.collect.mockResolvedValueOnce({
      deployments: [],
      statuses: [],
      completedStatusTraversals: [],
      transportComplete: false,
      diagnostics: [{ code: 'page_limit', resource: 'deployments', retryAfterSeconds: null }],
      checkpoint: { deploymentPage: 2, statuses: [] },
    });
    const run = await f.enqueue();
    await processOne(pool, f.config, { provider: f.provider });
    expect(
      (await f.repository.getRun(owner, f.workspaceId, f.serviceId, run.id)).result,
    ).toMatchObject({
      deploymentCount: 0,
      transportComplete: false,
      coverage: { collectionComplete: false },
    });
    const next = await f.enqueue();
    const claim = await f.worker.claim();
    if (!claim) throw new Error('Missing claim');
    expect((await f.worker.preflight(claim)).incremental.checkpoint).toEqual({
      deploymentPage: 2,
      statuses: [],
    });
    await f.worker.fail(claim, null, true);
    await f.repository.save(owner, f.workspaceId, f.serviceId, {
      ...settings,
      expectedRevision: 1,
    });
    await f.enqueue(randomUUID(), 2);
    const revised = await f.worker.claim();
    if (!revised) throw new Error('Missing revised claim');
    expect((await f.worker.preflight(revised)).incremental.checkpoint).toBeNull();
    const other = await fixture();
    await other.enqueue();
    // Installation acquisition is serialized; complete previous lease before another service claims.
    await f.worker.fail(revised, null, true);
    const isolated = await other.worker.claim();
    if (!isolated) throw new Error('Missing isolated claim');
    expect((await other.worker.preflight(isolated)).incremental.checkpoint).toBeNull();
    expect((await f.repository.getRun(owner, f.workspaceId, f.serviceId, next.id)).status).toBe(
      'failed',
    );
  });
  it('preserves committed progress after stale lease and revoked grant completion attempts', async () => {
    const f = await fixture();
    const initial: GitHubBatch = {
      ...batch(),
      transportComplete: false,
      checkpoint: { deploymentPage: 2, statuses: [{ deploymentId: 30, page: 2 }] },
    };
    await f.enqueue();
    const first = await f.worker.claim();
    if (!first) throw new Error('Missing first claim');
    await f.worker.complete(first, initial, new Date().toISOString());
    await f.enqueue();
    const stale = await f.worker.claim();
    if (!stale) throw new Error('Missing stale claim');
    await pool.query(
      "UPDATE github_collection_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [stale.id],
    );
    await pool.query(
      "UPDATE github_quota_state SET lease_until=clock_timestamp()-interval '1 second' WHERE app_id=12 AND installation_id=10",
    );
    const replacement = await f.worker.claim();
    if (!replacement) throw new Error('Missing replacement claim');
    expect(
      await f.worker.complete(stale, { ...initial, checkpoint: null }, new Date().toISOString()),
    ).toBe(false);
    const revoked = createGitHubWorker(pool, f.config, { configNow: () => null });
    await expect(
      revoked.complete(replacement, { ...initial, checkpoint: null }, new Date().toISOString()),
    ).rejects.toThrow();
    expect(
      (
        await pool.query<Record<string, unknown>>(
          'SELECT cursor,run_id FROM github_collection_checkpoints WHERE workspace_id=$1',
          [f.workspaceId],
        )
      ).rows[0],
    ).toEqual({ cursor: initial.checkpoint, run_id: first.id });
    expect(
      (
        await pool.query('SELECT run_id FROM github_collection_snapshots WHERE run_id=$1', [
          replacement.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('fails stalled deleted-resource runs after bounded retries without advancing their checkpoint', async () => {
    const f = await fixture();
    await f.enqueue();
    const first = await f.worker.claim();
    if (!first) throw new Error('Missing initial claim');
    const checkpoint = { deploymentPage: null, statuses: [{ deploymentId: 30, page: 2 }] };
    await f.worker.complete(
      first,
      { ...batch(), transportComplete: false, checkpoint },
      new Date().toISOString(),
    );
    f.provider.collect.mockImplementation(async (input) =>
      collectGitHubDeployments({
        ...input,
        instance: String(input.installationId),
        fetch: async (url) =>
          new URL(url).pathname === '/repositories/20'
            ? Response.json({ id: 20, name: 'fixture-repo', owner: { login: 'fixture-owner' } })
            : Response.json({ message: 'Not Found' }, { status: 404 }),
      }),
    );
    const blocked = await f.enqueue();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0)
        await pool.query(
          'UPDATE github_collection_runs SET available_at=clock_timestamp() WHERE id=$1',
          [blocked.id],
        );
      await processOne(pool, f.config, { provider: f.provider });
    }
    expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, blocked.id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      failureCode: 'github_processing_failed',
      result: null,
    });
    expect(
      (
        await pool.query<Record<string, unknown>>(
          'SELECT cursor,run_id FROM github_collection_checkpoints WHERE workspace_id=$1',
          [f.workspaceId],
        )
      ).rows[0],
    ).toEqual({ cursor: checkpoint, run_id: first.id });
    expect(
      (
        await pool.query('SELECT run_id FROM github_collection_snapshots WHERE run_id=$1', [
          blocked.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('rejects production collection batches that omit required durable cursor state', async () => {
    const f = await fixture();
    const queued = await f.enqueue();
    const verify = vi.spyOn(githubProvider, 'verify').mockResolvedValue({
      accountLogin: 'fixture-owner',
      repositoryName: 'fixture-repo',
      token: 'private-fixture-token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const collect = vi.spyOn(githubProvider, 'collect').mockResolvedValue(batch());
    try {
      await processOne(pool, f.config);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(collect).toHaveBeenCalledTimes(1);
      expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject(
        { status: 'pending', attempts: 1, result: null },
      );
      expect(
        (
          await pool.query('SELECT run_id FROM github_collection_snapshots WHERE run_id=$1', [
            queued.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query(
            'SELECT run_id FROM github_collection_checkpoints WHERE workspace_id=$1',
            [f.workspaceId],
          )
        ).rowCount,
      ).toBe(0);
      collect.mockResolvedValue({ ...batch(), checkpoint: null });
      await pool.query(
        'UPDATE github_collection_runs SET available_at=clock_timestamp() WHERE id=$1',
        [queued.id],
      );
      await processOne(pool, f.config);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(collect).toHaveBeenCalledTimes(2);
      expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject(
        { status: 'succeeded', attempts: 2 },
      );
    } finally {
      verify.mockRestore();
      collect.mockRestore();
    }
  });
  it('rejects ungranted scope before network; serializes revision races and rechecks owner/session after verification', async () => {
    const f = await fixture(false);
    await expect(
      f.repository.save(owner, f.workspaceId, f.serviceId, { ...settings, repositoryId: 99 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.repository.save(member, f.workspaceId, f.serviceId, settings),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.provider.verify).not.toHaveBeenCalled();
    let release = () => {};
    const verified = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.provider.verify.mockImplementationOnce(async () => {
      await verified;
      return {
        accountLogin: 'fixture-owner',
        repositoryName: 'fixture-repo',
        token: 'private',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    });
    const pending = f.repository.save(owner, f.workspaceId, f.serviceId, settings);
    await vi.waitFor(() => expect(f.provider.verify).toHaveBeenCalledTimes(1));
    await pool.query(
      "UPDATE workspace_memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",
      [f.workspaceId, owner.userId],
    );
    release();
    await expect(pending).rejects.toMatchObject({ status: 403 });
    await pool.query(
      "UPDATE workspace_memberships SET role='owner' WHERE workspace_id=$1 AND user_id=$2",
      [f.workspaceId, owner.userId],
    );
    f.provider.verify.mockImplementationOnce(async () => {
      await pool.query(
        "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [owner.sessionId],
      );
      return {
        accountLogin: 'fixture-owner',
        repositoryName: 'fixture-repo',
        token: 'private',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    });
    await expect(
      f.repository.save(owner, f.workspaceId, f.serviceId, settings),
    ).rejects.toMatchObject({ status: 401 });
    await pool.query(
      "UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      [owner.sessionId],
    );
    const concurrent = await Promise.allSettled([
      f.repository.save(owner, f.workspaceId, f.serviceId, settings),
      f.repository.save(owner, f.workspaceId, f.serviceId, settings),
    ]);
    expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
  });
  it('pins immutable requests, rejects changed replay/active concurrency, scopes member reads', async () => {
    const f = await fixture(),
      requestId = randomUUID();
    const replay = await Promise.all([f.enqueue(requestId), f.enqueue(requestId)]);
    expect(replay[0]).toEqual(replay[1]);
    await expect(
      f.enqueue(requestId, 1, { ...window, end: '2026-01-04T00:00:00.000Z' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(f.enqueue()).rejects.toMatchObject({ status: 409 });
    await expect(
      f.repository.enqueue(member, f.workspaceId, f.serviceId, {
        connectionRevision: 1,
        requestId: randomUUID(),
        window,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await f.repository.getRun(member, f.workspaceId, f.serviceId, replay[0]?.id ?? ''),
    ).toEqual(replay[0]);
    await expect(f.repository.list(outsider, f.workspaceId, f.serviceId)).rejects.toMatchObject({
      status: 404,
    });
    const other = await fixture();
    await expect(
      f.repository.getRun(owner, other.workspaceId, other.serviceId, replay[0]?.id ?? ''),
    ).rejects.toMatchObject({ status: 404 });
    await identities.revokeMember(owner, f.workspaceId, member.userId);
    await expect(f.repository.list(member, f.workspaceId, f.serviceId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      pool.query("UPDATE github_collection_runs SET service_name='changed' WHERE id=$1", [
        replay[0]?.id,
      ]),
    ).rejects.toThrow('immutable');
  });
  it('serializes enqueue requests and same-installation service acquisitions', async () => {
    const f = await fixture();
    const concurrent = await Promise.allSettled([f.enqueue(), f.enqueue()]);
    expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
    const service = await identities.createService(
      owner,
      f.workspaceId,
      'Independent GitHub service',
    );
    await f.repository.save(owner, f.workspaceId, service.id, settings);
    await f.repository.enqueue(owner, f.workspaceId, service.id, {
      connectionRevision: 1,
      requestId: randomUUID(),
      window,
    });
    const claims = await Promise.all([f.worker.claim(), f.worker.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find((claim) => claim !== null);
    if (!first) throw new Error('Missing serialized claim');
    expect(await f.worker.complete(first, batch(), new Date().toISOString())).toBe(true);
    const second = await f.worker.claim();
    if (!second) throw new Error('Missing next installation claim');
    expect(await f.worker.complete(second, batch(), new Date().toISOString())).toBe(true);
  });
  it('fences disconnect and changed revisions, preserving immutable historical input/replays', async () => {
    const f = await fixture(),
      queued = await f.enqueue();
    const claim = await f.worker.claim();
    if (!claim) throw new Error('Missing claim');
    const disconnected = await f.repository.disconnect(owner, f.workspaceId, f.serviceId, {
      expectedRevision: 1,
    });
    expect(disconnected).toMatchObject({ revision: 2, active: false });
    expect(await f.worker.complete(claim, batch(), new Date().toISOString())).toBe(false);
    expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureCode: 'github_connection_revoked',
    });
    await expect(f.enqueue(randomUUID(), 2)).rejects.toMatchObject({ status: 409 });
    await expect(
      pool.query('DELETE FROM github_connection_revisions WHERE workspace_id=$1', [f.workspaceId]),
    ).rejects.toThrow('immutable');
    const saved = await f.repository.save(owner, f.workspaceId, f.serviceId, {
      ...settings,
      expectedRevision: 2,
    });
    expect(saved.revision).toBe(3);
    const next = await f.enqueue(randomUUID(), 3);
    await f.repository.save(owner, f.workspaceId, f.serviceId, {
      ...settings,
      expectedRevision: 3,
    });
    expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, next.id)).toMatchObject({
      status: 'failed',
      attempts: 0,
    });
  });
  it('rechecks grants before token issuance and completion; removed grants fence jobs', async () => {
    const f = await fixture();
    await f.enqueue();
    const denied = { ...f.config, grants: [] };
    await processOne(pool, denied, { provider: f.provider });
    expect(f.provider.verify).not.toHaveBeenCalled();
    expect((await f.repository.list(owner, f.workspaceId, f.serviceId))[0]).toMatchObject({
      status: 'failed',
      failureCode: 'github_connection_revoked',
    });
    const queued = await f.enqueue();
    let current: GitHubConfig | null = f.config;
    f.provider.collect.mockImplementationOnce(async () => {
      current = denied;
      return batch();
    });
    await processOne(pool, f.config, { provider: f.provider, configNow: () => current });
    expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject({
      status: 'failed',
      failureCode: 'github_connection_revoked',
    });
    expect(
      (
        await pool.query('SELECT run_id FROM github_collection_snapshots WHERE run_id=$1', [
          queued.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('claims once concurrently, recovers expired leases, exhausts three attempts, rejects stale commits', async () => {
    const f = await fixture(),
      queued = await f.enqueue();
    const claims = await Promise.all([f.worker.claim(), f.worker.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find((c) => c !== null);
    if (!first) throw new Error('Missing claim');
    await pool.query(
      "UPDATE github_collection_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [queued.id],
    );
    await pool.query(
      "UPDATE github_quota_state SET lease_until=clock_timestamp()-interval '1 second' WHERE app_id=12 AND installation_id=10",
    );
    const second = await f.worker.claim();
    if (!second) throw new Error('Missing second claim');
    expect(second.token).not.toBe(first.token);
    expect(await f.worker.complete(first, batch(), new Date().toISOString())).toBe(false);
    expect(await f.worker.fail(first)).toBe(false);
    await pool.query(
      "UPDATE github_collection_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [queued.id],
    );
    await pool.query(
      "UPDATE github_quota_state SET lease_until=clock_timestamp()-interval '1 second' WHERE app_id=12 AND installation_id=10 AND lease_token IS NOT NULL",
    );
    const third = await f.worker.claim();
    if (!third) throw new Error('Missing third claim');
    await pool.query(
      "UPDATE github_collection_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [queued.id],
    );
    expect(await f.worker.claim()).toBeNull();
    expect(await f.worker.complete(third, batch(), new Date().toISOString())).toBe(false);
    expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      failureCode: 'github_processing_failed',
    });
  });
  it('stores useful partial evidence and earliest observations, retains old success after disappearance', async () => {
    const f = await fixture(),
      queued = await f.enqueue(),
      initial = batch();
    f.provider.collect.mockResolvedValueOnce({
      ...initial,
      transportComplete: false,
      diagnostics: [{ code: 'rate_limited', resource: 'private-path', retryAfterSeconds: 9999 }],
    });
    await processOne(pool, f.config, { provider: f.provider });
    const done = await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      result: {
        transportComplete: false,
        qualifyingCount: 1,
        deploymentFrequency: { count: 1, deploymentsPerDay: null },
        coverage: {
          collectionComplete: false,
          deploymentHistoryComplete: false,
          recoveryEvidenceComplete: false,
        },
      },
    });
    const history = await pool.query<Record<string, unknown>>(
      'SELECT payload FROM github_collection_history WHERE workspace_id=$1 AND kind=$2',
      [f.workspaceId, 'status'],
    );
    expect(history.rows[0]?.payload).toEqual(initial.statuses[0]);
    const next = await f.enqueue();
    expect(await processOne(pool, f.config, { provider: f.provider })).toBe(false);
    expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, next.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    const quota = await pool.query<Record<string, unknown>>(
      'SELECT extract(epoch FROM blocked_until-clock_timestamp())::float AS delay FROM github_quota_state WHERE app_id=12 AND installation_id=10',
    );
    expect(Number(quota.rows[0]?.delay)).toBeGreaterThan(9998);
    await pool.query(
      "UPDATE github_quota_state SET blocked_until='-infinity' WHERE app_id=12 AND installation_id=10",
    );
    f.provider.collect.mockResolvedValueOnce({
      deployments: [],
      statuses: [],
      completedStatusTraversals: [],
      transportComplete: true,
      diagnostics: [],
    });
    await processOne(pool, f.config, { provider: f.provider });
    expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, next.id)).toMatchObject({
      status: 'succeeded',
      result: { transportComplete: true, qualifyingCount: 1, deploymentFrequency: { count: 1 } },
    });
    expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toEqual(done);
    await expect(
      pool.query("UPDATE github_collection_history SET payload='{}' WHERE workspace_id=$1", [
        f.workspaceId,
      ]),
    ).rejects.toThrow('immutable');
  });
  it('honors long provider retry delays and bounds attempts without exposing diagnostics', async () => {
    const f = await fixture(),
      queued = await f.enqueue();
    f.provider.collect.mockResolvedValue({
      deployments: [],
      statuses: [],
      completedStatusTraversals: [],
      transportComplete: false,
      diagnostics: [{ code: 'private-reason', resource: 'private-path', retryAfterSeconds: 9999 }],
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await pool.query(
        "UPDATE github_quota_state SET blocked_until='-infinity' WHERE app_id=12 AND installation_id=10",
      );
      await pool.query(
        "UPDATE github_collection_runs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [queued.id],
      );
      await processOne(pool, f.config, { provider: f.provider });
      const done = await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id);
      expect(done).toMatchObject({
        status: attempt === 3 ? 'failed' : 'pending',
        attempts: attempt,
        result: null,
      });
      expect(JSON.stringify(done)).not.toContain('private');
      if (attempt < 3) {
        expect(await f.worker.claim()).toBeNull();
        const delay = await pool.query<Record<string, unknown>>(
          'SELECT extract(epoch FROM available_at-clock_timestamp())::float AS delay FROM github_collection_runs WHERE id=$1',
          [queued.id],
        );
        expect(Number(delay.rows[0]?.delay)).toBeGreaterThan(9998);
        expect(Number(delay.rows[0]?.delay)).toBeLessThanOrEqual(10030);
      }
    }
  });
  it('counts a production collection throttle once through transport observation and worker completion', async () => {
    const f = await fixture(),
      queued = await f.enqueue();
    const verify = vi.spyOn(githubProvider, 'verify').mockResolvedValue({
      accountLogin: 'fixture-owner',
      repositoryName: 'fixture-repo',
      token: 'private-fixture-token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 429 }));
    try {
      await processOne(pool, f.config);
      expect(fetch).toHaveBeenCalledTimes(1);
      const quota = await pool.query<Record<string, unknown>>(
        'SELECT consecutive_throttles,extract(epoch FROM blocked_until-clock_timestamp())::float AS wait FROM github_quota_state WHERE app_id=12 AND installation_id=10',
      );
      expect(quota.rows[0]?.consecutive_throttles).toBe(1);
      expect(Number(quota.rows[0]?.wait)).toBeGreaterThanOrEqual(59);
      expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject(
        { status: 'pending', attempts: 1 },
      );
      expect(await processOne(pool, f.config)).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      verify.mockRestore();
      fetch.mockRestore();
    }
  });
  it('keeps a paced production prefix when a large full backfill reaches the soft acquisition deadline', async () => {
    const f = await fixture(),
      queued = await f.enqueue();
    const verify = vi.spyOn(githubProvider, 'verify').mockResolvedValue({
      accountLogin: 'fixture-owner',
      repositoryName: 'fixture-repo',
      token: 'private-fixture-token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const deployments = Array.from({ length: 61 }, (_, i) => ({
      id: i + 1,
      created_at: '2026-01-01T10:00:00Z',
      updated_at: '2026-01-01T10:00:00Z',
      environment: 'production',
      sha: 'a'.repeat(40),
    }));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      const body =
        path === '/repositories/20'
          ? { id: 20, name: 'fixture-repo', owner: { login: 'fixture-owner' } }
          : path.endsWith('/deployments')
            ? deployments
            : [];
      return new Response(JSON.stringify(body));
    });
    try {
      await processOne(pool, f.config, { acquisitionBudgetMs: 4000 });
      expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject(
        {
          status: 'succeeded',
          result: {
            transportComplete: false,
            deploymentCount: 61,
            coverage: { collectionComplete: false },
          },
        },
      );
      expect(fetch.mock.calls.length).toBeLessThan(10);
      expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
      const before = await f.worker.claim();
      expect(before).toBeNull();
      fetch.mockClear();
      const resumed = await f.enqueue();
      await processOne(pool, f.config, { acquisitionBudgetMs: 4000 });
      expect(
        (await f.repository.getRun(owner, f.workspaceId, f.serviceId, resumed.id)).status,
      ).toBe('succeeded');
      expect(
        fetch.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/deployments')),
      ).toBe(false);
      expect(
        fetch.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/statuses')),
      ).toBe(true);
    } finally {
      verify.mockRestore();
      fetch.mockRestore();
    }
  });
  it('defers repeated unrelated App cooldowns without consuming acquisition attempts', async () => {
    const f = await fixture(),
      queued = await f.enqueue();
    f.provider.verify.mockImplementation(async () => {
      await pool.query(
        "UPDATE github_quota_state SET blocked_until=clock_timestamp()+interval '600 seconds' WHERE app_id=12 AND installation_id=0",
      );
      throw new AdapterError('transport_failed');
    });
    for (let i = 0; i < 3; i++) {
      await pool.query("UPDATE github_quota_state SET blocked_until='-infinity' WHERE app_id=12");
      await pool.query(
        "UPDATE github_collection_runs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [queued.id],
      );
      await processOne(pool, f.config, {
        provider: { ...f.provider, quotaContention: () => true },
      });
      expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject(
        { status: 'pending', attempts: 0 },
      );
    }
    expect(f.provider.collect).not.toHaveBeenCalled();
  });
  it('fences pending jobs when current configuration is removed', async () => {
    const f = await fixture(),
      queued = await f.enqueue();
    await processOne(pool, f.config, { configNow: () => null, provider: f.provider });
    expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject({
      status: 'failed',
      failureCode: 'github_connection_revoked',
      attempts: 0,
    });
    expect(f.provider.verify).not.toHaveBeenCalled();
  });
  it('rejects arbitrary attempt rollback even during a shared cooldown', async () => {
    const f = await fixture();
    await f.enqueue();
    const claim = await f.worker.claim();
    if (!claim) throw new Error('Missing claim');
    await pool.query(
      "UPDATE github_quota_state SET blocked_until=clock_timestamp()+interval '600 seconds' WHERE app_id=12 AND installation_id=0",
    );
    await expect(
      pool.query(
        "UPDATE github_collection_runs SET attempts=0,quota_app_id=NULL,status='pending',lease_token=NULL,lease_until=NULL WHERE id=$1",
        [claim.id],
      ),
    ).rejects.toThrow('attempts cannot decrease');
    expect(await f.worker.deferQuota(claim)).toBe(true);
  });
  it('does not refund deterministic failure merely because a shared cooldown exists', async () => {
    const f = await fixture(),
      queued = await f.enqueue();
    f.provider.verify.mockImplementation(async () => {
      await pool.query(
        "UPDATE github_quota_state SET blocked_until=clock_timestamp()+interval '600 seconds' WHERE app_id=12 AND installation_id=0",
      );
      throw new AdapterError('github_http_404');
    });
    await processOne(pool, f.config, { provider: { ...f.provider, quotaContention: () => true } });
    expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
  });
  it('refunds a real production quota-check failure after successful primary exhaustion', async () => {
    const f = await fixture(),
      queued = await f.enqueue();
    const verify = vi.spyOn(githubProvider, 'verify').mockResolvedValue({
      accountLogin: 'fixture-owner',
      repositoryName: 'fixture-repo',
      token: 'private-fixture-token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ id: 20, name: 'fixture-repo', owner: { login: 'fixture-owner' } }),
        {
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 900),
          },
        },
      ),
    );
    try {
      await processOne(pool, f.config);
      expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject(
        { status: 'pending', attempts: 0, result: null },
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await processOne(pool, f.config)).toBe(false);
    } finally {
      verify.mockRestore();
      fetch.mockRestore();
    }
  });
  it('does not refund real production transport failure without quota-check contention', async () => {
    const f = await fixture(),
      queued = await f.enqueue();
    const verify = vi.spyOn(githubProvider, 'verify').mockResolvedValue({
      accountLogin: 'fixture-owner',
      repositoryName: 'fixture-repo',
      token: 'private-fixture-token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await pool.query(
        "UPDATE github_quota_state SET blocked_until=clock_timestamp()+interval '600 seconds' WHERE app_id=12 AND installation_id=0",
      );
      throw new Error('private transport failure');
    });
    try {
      await processOne(pool, f.config);
      expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject(
        { status: 'pending', attempts: 1, result: null },
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      verify.mockRestore();
      fetch.mockRestore();
    }
  });
  it('keeps unchanged backfills flat while retaining new source observations and immutable snapshots', async () => {
    const f = await fixture();
    const counts = async () =>
      (
        await pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM github_collection_history WHERE workspace_id=$1 AND service_id=$2',
          [f.workspaceId, f.serviceId],
        )
      ).rows[0]?.count;
    for (let i = 0; i < 12; i++) {
      const run = await f.enqueue();
      await processOne(pool, f.config, { provider: f.provider });
      expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, run.id)).toMatchObject({
        status: 'succeeded',
      });
      expect(await counts()).toBe(3);
    }
    f.provider.collect.mockImplementationOnce(async () => {
      const next = batch();
      const prior = next.statuses[0];
      if (!prior) throw new Error('Missing status');
      return {
        ...next,
        statuses: [
          ...next.statuses,
          {
            ...prior,
            id: identity(identity('github', '10'), 'status', 20, 41),
            sourceRef: `urn:clio:${identity('github', '10', 'repository', 20, 'status', 41)}`,
            signal: 'inactive',
          },
        ],
      };
    });
    await f.enqueue();
    await processOne(pool, f.config, { provider: f.provider });
    expect(await counts()).toBe(5);
    const snapshots = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM github_collection_snapshots WHERE workspace_id=$1 AND service_id=$2',
      [f.workspaceId, f.serviceId],
    );
    expect(snapshots.rows[0]?.count).toBe(13);
  });
  it('aborts uncooperative acquisition on shutdown and never commits partial data afterwards', async () => {
    const f = await fixture(),
      queued = await f.enqueue(),
      controller = new AbortController();
    f.provider.collect.mockImplementationOnce(async () => new Promise<GitHubBatch>(() => {}));
    const processing = processOne(pool, f.config, {
      provider: f.provider,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(f.provider.collect).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(processing).resolves.toBe(true);
    expect(await f.repository.getRun(owner, f.workspaceId, f.serviceId, queued.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      result: null,
    });
    expect(
      (
        await pool.query('SELECT run_id FROM github_collection_snapshots WHERE run_id=$1', [
          queued.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('rolls back history and snapshot together when terminal commit fails; rejects immutable changes and conflict', async () => {
    const f = await fixture();
    await f.enqueue();
    const claim = await f.worker.claim();
    if (!claim) throw new Error('Missing claim');
    await pool.query(
      `CREATE FUNCTION reject_github_test_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'test terminal failure'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER test_github_completion BEFORE UPDATE ON github_collection_runs FOR EACH ROW EXECUTE FUNCTION reject_github_test_completion()',
    );
    const acquired: GitHubBatch = {
      ...batch(),
      transportComplete: false,
      checkpoint: { deploymentPage: 2, statuses: [{ deploymentId: 30, page: 2 }] },
    };
    try {
      await expect(f.worker.complete(claim, acquired, new Date().toISOString())).rejects.toThrow(
        'test terminal failure',
      );
      expect(
        (
          await pool.query('SELECT payload FROM github_collection_history WHERE workspace_id=$1', [
            f.workspaceId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query('SELECT run_id FROM github_collection_snapshots WHERE run_id=$1', [
            claim.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query(
            'SELECT cursor FROM github_collection_checkpoints WHERE workspace_id=$1',
            [f.workspaceId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER test_github_completion ON github_collection_runs');
      await pool.query('DROP FUNCTION reject_github_test_completion()');
    }
    expect(await f.worker.complete(claim, acquired, new Date().toISOString())).toBe(true);
    expect(await f.worker.complete(claim, acquired, new Date().toISOString())).toBe(false);
    await expect(
      pool.query('UPDATE github_collection_checkpoints SET cursor=NULL WHERE workspace_id=$1', [
        f.workspaceId,
      ]),
    ).rejects.toThrow('current captured snapshot');
    const stored = (
      await pool.query<Record<string, unknown>>(
        'SELECT * FROM github_collection_snapshots WHERE run_id=$1',
        [claim.id],
      )
    ).rows[0];
    if (!stored) throw new Error('Missing snapshot');
    expect(stored.digest).toBe(
      snapshotDigest({
        connection: parseConnection(stored.connection_input),
        serviceName: stored.service_name,
        evidence: stored.evidence,
        snapshot: stored.snapshot,
        metrics: stored.metrics,
        oemsRevision: stored.oems_revision,
        result: stored.public_result,
      }),
    );
    await expect(
      pool.query('DELETE FROM github_collection_snapshots WHERE run_id=$1', [claim.id]),
    ).rejects.toThrow('immutable');
    await expect(
      pool.query("UPDATE github_collection_runs SET result='{}' WHERE id=$1", [claim.id]),
    ).rejects.toThrow('immutable');
    const next = await f.enqueue(),
      nextClaim = await f.worker.claim();
    if (!nextClaim) throw new Error('Missing next claim');
    const status = acquired.statuses[0];
    if (!status) throw new Error('Missing status');
    await expect(
      f.worker.complete(
        nextClaim,
        { ...acquired, checkpoint: null, statuses: [{ ...status, signal: 'failure' }] },
        new Date().toISOString(),
      ),
    ).rejects.toThrow('Conflicting source record');
    expect((await f.repository.getRun(owner, f.workspaceId, f.serviceId, next.id)).status).toBe(
      'running',
    );
    expect(
      (
        await pool.query<Record<string, unknown>>(
          'SELECT cursor FROM github_collection_checkpoints WHERE workspace_id=$1',
          [f.workspaceId],
        )
      ).rows[0]?.cursor,
    ).toEqual(acquired.checkpoint);
  });
  it('reports microsecond observations, independent empty coverage, newest 25; detects readiness drift', async () => {
    const f = await fixture();
    f.provider.collect.mockResolvedValue({
      deployments: [],
      statuses: [],
      completedStatusTraversals: [],
      transportComplete: true,
      diagnostics: [],
    });
    for (let i = 0; i < 26; i++) {
      await f.enqueue();
      await processOne(pool, f.config, { provider: f.provider });
    }
    const listed = await f.repository.list(member, f.workspaceId, f.serviceId);
    expect(listed).toHaveLength(25);
    expect(listed.map((r) => r.createdAt)).toEqual(
      listed
        .map((r) => r.createdAt)
        .sort()
        .reverse(),
    );
    expect(listed[0]?.result).toMatchObject({
      deploymentCount: 0,
      qualifyingCount: 0,
      unknownCount: 0,
      transportComplete: true,
      deploymentFrequency: { count: 0, deploymentsPerDay: null },
      coverage: { collectionComplete: false },
    });
    const connection = (await f.repository.get(member, f.workspaceId, f.serviceId)).connection;
    expect(connection?.observedAt).toMatch(/\.\d{6}Z$/);
    await checkReadiness(pool, migrations);
    await pool.query(
      'ALTER TABLE github_collection_snapshots RENAME COLUMN evidence TO missing_evidence',
    );
    try {
      await expect(checkReadiness(pool, migrations)).rejects.toThrow();
    } finally {
      await pool.query(
        'ALTER TABLE github_collection_snapshots RENAME COLUMN missing_evidence TO evidence',
      );
    }
  });
  it('keeps installed HTTP routes inside caller identity/origin/redaction hooks, exposes no secrets', async () => {
    const f = await fixture();
    const server = Fastify({ logger: false });
    let current = owner;
    const origin = 'http://localhost:5173';
    server.register(async (routes) => {
      routes.addHook('onRequest', async (_request, reply) => {
        reply.header('cache-control', 'no-store');
      });
      routes.setErrorHandler((error, _request, reply) => {
        const known = error instanceof IdentityError;
        reply
          .code(known ? error.status : 503)
          .send({ error: known ? error.message : 'unavailable' });
      });
      registerGitHubRoutes(routes, {
        pool,
        github: f.config,
        actor: async (request, reply, write) => {
          if (write && request.headers.origin !== origin) throw new IdentityError(403, 'forbidden');
          reply.header('set-cookie', 'renewed=fixture; HttpOnly');
          return current;
        },
      });
    });
    const base = `/api/workspaces/${f.workspaceId}/services/${f.serviceId}`;
    try {
      const read = await server.inject(`${base}/github-connection`);
      expect(read.statusCode).toBe(200);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(read.headers['set-cookie']).toContain('renewed=fixture');
      expect(read.json()).toMatchObject({ configured: true, connection: { mode: 'live' } });
      const payload = { connectionRevision: 1, requestId: randomUUID(), window };
      expect(
        (await server.inject({ method: 'POST', url: `${base}/github-collection-runs`, payload }))
          .statusCode,
      ).toBe(403);
      const queued = await server.inject({
        method: 'POST',
        url: `${base}/github-collection-runs`,
        headers: { origin },
        payload,
      });
      expect(queued.statusCode).toBe(202);
      for (const secret of [
        'privateKey',
        'token',
        'lease',
        'grant_fingerprint',
        'connection_input',
        'requestId',
      ])
        expect(queued.body).not.toContain(secret);
      current = member;
      expect(
        (
          await server.inject({
            method: 'POST',
            url: `${base}/github-connection/disconnect`,
            headers: { origin },
            payload: { expectedRevision: 1 },
          })
        ).statusCode,
      ).toBe(403);
      const spy = vi
        .spyOn(githubProvider, 'verify')
        .mockRejectedValueOnce(new Error('private provider token'));
      current = owner;
      try {
        const failed = await server.inject({
          method: 'POST',
          url: `${base}/github-connection`,
          headers: { origin },
          payload: { ...settings, expectedRevision: 1 },
        });
        expect(failed.statusCode).toBe(503);
        expect(failed.json()).toEqual({ error: 'unavailable' });
      } finally {
        spy.mockRestore();
      }
      current = outsider;
      expect((await server.inject(`${base}/github-collection-runs`)).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});

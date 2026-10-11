import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrl } from '../src/config.ts';
import { checkReadiness, loadMigrations, migrate } from '../src/db/migrations.ts';
import { captureMapping } from '../src/features/deployment-mappings/preview.ts';
import { createMappingRepository } from '../src/features/deployment-mappings/repository.ts';
import { createAuth, readSession } from '../src/features/identity/auth.ts';
import { readAuthConfig } from '../src/features/identity/config.ts';
import { createIdentityRepository } from '../src/features/identity/repository.ts';
import { snapshotDigest } from '../src/features/mock-collection/digest.ts';
import { parseMapping } from '../src/features/mock-collection/model.ts';
import { createMockCollectionRepository } from '../src/features/mock-collection/repository.ts';
import { createMockWorker, processOne } from '../src/features/mock-collection/worker.ts';
import { createServer } from '../src/server.ts';

vi.mock('../src/features/identity/auth.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/features/identity/auth.ts')>();
  return { ...original, readSession: vi.fn() };
});
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
const mappings = createMappingRepository(pool);
const runs = createMockCollectionRepository(pool);
const worker = createMockWorker(pool);
const migrations = await loadMigrations();
const owner = { userId: 'mapping-owner', sessionId: 'mapping-owner-session' };
const member = { userId: 'mapping-member', sessionId: 'mapping-member-session' };
const outsider = { userId: 'mapping-outsider', sessionId: 'mapping-outsider-session' };
let server: FastifyInstance;
let created = false;
let workspaceId: string;
let serviceId: string;
const origin = 'http://localhost:5173';
const settings = {
  expectedRevision: null,
  primaryProvider: 'github',
  productionEnvironment: 'production',
  exposureAttested: true,
};
function url(suffix: string) {
  return `/api/workspaces/${workspaceId}/services/${serviceId}/${suffix}`;
}
function session(actor = owner) {
  const now = new Date();
  vi.mocked(readSession).mockResolvedValue({
    headers: new Headers({ 'set-cookie': 'renewed=fixture; HttpOnly' }),
    response: {
      user: {
        id: actor.userId,
        name: 'Fixture',
        email: `${actor.userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
        image: null,
      },
      session: {
        id: actor.sessionId,
        userId: actor.userId,
        token: 'fictional-token',
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: now,
        updatedAt: now,
        ipAddress: null,
        userAgent: null,
      },
    },
  });
}
function post(
  suffix: string,
  payload: Record<string, unknown>,
  trustedOrigin: string | undefined = origin,
) {
  return server.inject({
    method: 'POST',
    url: url(suffix),
    headers: trustedOrigin ? { origin: trustedOrigin } : {},
    payload,
  });
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool, migrations);
  for (const actor of [owner, member, outsider]) {
    await pool.query(
      'INSERT INTO auth_users (id, name, email, email_verified) VALUES ($1, $1, $2, true)',
      [actor.userId, `${actor.userId}@example.com`],
    );
    await pool.query(
      "INSERT INTO auth_sessions (id, user_id, token, expires_at) VALUES ($1, $2, $1, now() + interval '1 day')",
      [actor.sessionId, actor.userId],
    );
  }
  const workspace = await identities.createWorkspace(owner, 'Mapping workspace');
  workspaceId = workspace.id;
  const service = await identities.createService(owner, workspaceId, 'Scoped backend');
  serviceId = service.id;
  await pool.query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
    [workspaceId, member.userId],
  );
  const config = readAuthConfig({
    AUTH_SECRET: 'fictional-mapping-test-secret-long-enough',
    AUTH_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: origin,
    GITHUB_CLIENT_ID: 'fixture',
    GITHUB_CLIENT_SECRET: 'fixture',
  });
  if (!config) throw new Error('Missing fixture configuration');
  server = createServer(
    { ready: async () => {}, close: async () => {} },
    { auth: createAuth(pool, config), config, pool },
  );
  session();
});
afterAll(async () => {
  if (server) await server.close();
  await pool.end();
  try {
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
});
async function fixture(provider: 'github' | 'argocd' = 'github') {
  session();
  const service = await identities.createService(owner, workspaceId, `Mock ${randomUUID()}`);
  serviceId = service.id;
  const mapping = await mappings.save(owner, workspaceId, serviceId, {
    ...settings,
    primaryProvider: provider,
  });
  const body = { revision: 1, requestId: randomUUID() };
  return { service, mapping, body };
}
async function enqueue() {
  const fixtureInput = await fixture();
  return {
    ...fixtureInput,
    run: await runs.enqueue(owner, workspaceId, serviceId, fixtureInput.body),
  };
}
async function expire(id: string) {
  await pool.query(
    "UPDATE mock_collection_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [id],
  );
}
async function eligible(id: string) {
  await pool.query(
    "UPDATE mock_collection_runs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [id],
  );
}
async function finishAll() {
  while (await processOne(pool)) {
    /* Drain fictional fixtures only. */
  }
}
describe('durable mock collection', () => {
  it('replays before latest revision and active checks; pins mapping and service name across later edits', async () => {
    const { body, run: queued, mapping, service } = await enqueue();
    expect(await runs.enqueue(owner, workspaceId, serviceId, body)).toEqual(queued);
    await expect(
      runs.enqueue(owner, workspaceId, serviceId, { ...body, revision: 2 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      runs.enqueue(owner, workspaceId, serviceId, { ...body, requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
    await mappings.save(owner, workspaceId, serviceId, {
      ...settings,
      expectedRevision: 1,
      primaryProvider: 'argocd',
    });
    await pool.query('UPDATE services SET name=$1 WHERE id=$2', [
      'Renamed after enqueue',
      serviceId,
    ]);
    expect(await runs.enqueue(owner, workspaceId, serviceId, body)).toEqual(queued);
    await expect(
      runs.enqueue(owner, workspaceId, serviceId, { revision: 1, requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
    await finishAll();
    const done = await runs.get(owner, workspaceId, serviceId, queued.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      mappingRevision: 1,
      mappingObservedAt: mapping.observedAt,
      primaryProvider: 'github',
      attempts: 1,
    });
    expect(done.completedAt).toBe(done.updatedAt);
    expect(done.createdAt <= done.updatedAt).toBe(true);
    const stored = await pool.query<Record<string, unknown>>(
      'SELECT service_name,mapping_input,evidence,snapshot,metrics,oems_revision,public_result,digest FROM mock_collection_snapshots WHERE run_id=$1',
      [queued.id],
    );
    expect(stored.rows[0]).toMatchObject({ service_name: service.name, mapping_input: mapping });
    expect(stored.rows[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    const saved = stored.rows[0];
    if (!saved) throw new Error('Missing persisted snapshot');
    expect(saved.digest).toBe(
      snapshotDigest({
        mapping: saved.mapping_input,
        serviceName: saved.service_name,
        evidence: saved.evidence,
        snapshot: saved.snapshot,
        metrics: saved.metrics,
        oemsRevision: saved.oems_revision,
        preview: saved.public_result,
      }),
    );
    expect(stored.rows[0]?.metrics).toHaveLength(1);
    expect((await runs.enqueue(owner, workspaceId, serviceId, body)).id).toBe(queued.id);
    const next = await runs.enqueue(owner, workspaceId, serviceId, {
      revision: 2,
      requestId: randomUUID(),
    });
    expect(next.primaryProvider).toBe('argocd');
    await finishAll();
    expect(await runs.get(owner, workspaceId, serviceId, queued.id)).toEqual(done);
  });
  it('keeps member reads scoped and denies writes, wrong scope, revoked/expired sessions', async () => {
    const { run: queued } = await enqueue();
    session(member);
    expect((await server.inject(url('mock-collection-runs'))).statusCode).toBe(200);
    expect((await server.inject(url(`mock-collection-runs/${queued.id}`))).statusCode).toBe(200);
    expect(
      (await post('mock-collection-runs', { revision: 1, requestId: randomUUID() })).statusCode,
    ).toBe(403);
    session(outsider);
    expect((await server.inject(url(`mock-collection-runs/${queued.id}`))).statusCode).toBe(404);
    session();
    const other = await identities.createWorkspace(owner, 'Other mock scope');
    expect(
      (
        await server.inject(
          `/api/workspaces/${other.id}/services/${serviceId}/mock-collection-runs/${queued.id}`,
        )
      ).statusCode,
    ).toBe(404);
    await expect(runs.get(owner, workspaceId, serviceId, randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    await pool.query(
      "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [outsider.sessionId],
    );
    await expect(runs.list(outsider, workspaceId, serviceId)).rejects.toMatchObject({
      status: 401,
    });
    await pool.query('DELETE FROM auth_sessions WHERE id=$1', [outsider.sessionId]);
    await expect(runs.get(outsider, workspaceId, serviceId, queued.id)).rejects.toMatchObject({
      status: 401,
    });
    session(outsider);
    expect((await server.inject(url(`mock-collection-runs/${queued.id}`))).statusCode).toBe(401);
    session();
    await identities.revokeMember(owner, workspaceId, member.userId);
    await expect(runs.list(member, workspaceId, serviceId)).rejects.toMatchObject({ status: 404 });
    await pool.query(
      "INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$2,'member')",
      [workspaceId, member.userId],
    );
    await finishAll();
  });
  it('returns no-store, renewal cookies and redacted origin/body/dependency errors; unset mapping is 404', async () => {
    const { body } = await fixture();
    const response = await post('mock-collection-runs', body);
    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toContain('renewed=fixture; HttpOnly');
    for (const field of [
      'requestId',
      'mapping_input',
      'sourceRef',
      'lease_token',
      'service_name',
      'created_by',
      'metrics',
    ])
      expect(response.body).not.toContain(field);
    for (const origin of ['', 'https://evil.example'])
      expect((await post('mock-collection-runs', body, origin)).statusCode).toBe(403);
    expect((await post('mock-collection-runs', { ...body, secret: 'private' })).statusCode).toBe(
      400,
    );
    vi.mocked(readSession).mockRejectedValueOnce(new Error('private database token'));
    const failed = await server.inject(url('mock-collection-runs'));
    expect(failed.json()).toEqual({ error: 'unavailable' });
    expect(failed.headers['cache-control']).toBe('no-store');
    const unset = await identities.createService(owner, workspaceId, `Unset ${randomUUID()}`);
    await expect(runs.enqueue(owner, workspaceId, unset.id, body)).rejects.toMatchObject({
      status: 404,
    });
    await finishAll();
  });
  it('serializes concurrent enqueue and SKIP LOCKED claims without duplicate ownership', async () => {
    const { body } = await fixture();
    const duplicate = await Promise.all([
      runs.enqueue(owner, workspaceId, serviceId, body),
      runs.enqueue(owner, workspaceId, serviceId, body),
    ]);
    expect(duplicate[0]?.id).toBe(duplicate[1]?.id);
    const claims = await Promise.all([worker.claim(), worker.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find((c) => c !== null);
    if (!claim) throw new Error('Missing claim');
    const mapping = parseMapping(claim.mapping);
    await expect(
      worker.complete(claim, captureMapping(mapping, { id: mapping.serviceId, name: 'wrong' })),
    ).rejects.toThrow('Capture mismatch');
    if (typeof claim.serviceName !== 'string') throw new Error('Invalid service name');
    const capture = captureMapping(mapping, { id: mapping.serviceId, name: claim.serviceName });
    expect(await worker.complete(claim, capture)).toBe(true);
    expect(await worker.complete(claim, capture)).toBe(false);
    expect(await worker.fail(claim)).toBe(false);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM mock_collection_snapshots WHERE run_id=$1',
          [claim.id],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
  it('allows independent concurrent claims and rejects competing distinct enqueue requests', async () => {
    await fixture();
    const results = await Promise.allSettled([
      runs.enqueue(owner, workspaceId, serviceId, { revision: 1, requestId: randomUUID() }),
      runs.enqueue(owner, workspaceId, serviceId, { revision: 1, requestId: randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const denied = results.find((result) => result.status === 'rejected');
    if (denied?.status !== 'rejected') throw new Error('Missing enqueue conflict');
    expect(denied.reason).toMatchObject({ status: 409 });
    await enqueue();
    const claims = await Promise.all([worker.claim(), worker.claim()]);
    expect(new Set(claims.map((claim) => claim?.id)).size).toBe(2);
    for (const claim of claims) {
      if (!claim || typeof claim.serviceName !== 'string')
        throw new Error('Missing independent claim');
      const mapping = parseMapping(claim.mapping);
      expect(
        await worker.complete(
          claim,
          captureMapping(mapping, { id: mapping.serviceId, name: claim.serviceName }),
        ),
      ).toBe(true);
    }
  });
  it('recovers expired leases, fences stale tokens, and fails exhausted third lease', async () => {
    const { run: queued } = await enqueue();
    const first = await worker.claim();
    if (!first || typeof first.serviceName !== 'string') throw new Error('Missing first claim');
    await expire(queued.id);
    const second = await worker.claim();
    if (!second) throw new Error('Missing second claim');
    expect(second.id).toBe(first.id);
    expect(second.token).not.toBe(first.token);
    const mapping = parseMapping(first.mapping);
    const capture = captureMapping(mapping, { id: mapping.serviceId, name: first.serviceName });
    expect(await worker.complete(first, capture)).toBe(false);
    expect(await worker.fail(first)).toBe(false);
    await expire(queued.id);
    const third = await worker.claim();
    if (!third) throw new Error('Missing third claim');
    await expire(queued.id);
    expect(await worker.claim()).toBeNull();
    expect(await worker.complete(third, capture)).toBe(false);
    expect(await runs.get(owner, workspaceId, serviceId, queued.id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      failureCode: 'mock_processing_failed',
      result: null,
    });
    const exhausted = await runs.get(owner, workspaceId, serviceId, queued.id);
    expect(exhausted.completedAt).toBe(exhausted.updatedAt);
    expect(exhausted.createdAt <= exhausted.updatedAt).toBe(true);
    expect(
      (
        await pool.query('SELECT run_id FROM mock_collection_snapshots WHERE run_id=$1', [
          queued.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('backs off failures then exhausts bounded processing attempts without raw error detail', async () => {
    const { run: queued } = await enqueue();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await eligible(queued.id);
        expect(
          await processOne(pool, () => {
            throw new Error('private mock payload');
          }),
        ).toBe(true);
        expect(await runs.get(owner, workspaceId, serviceId, queued.id)).toMatchObject({
          attempts: attempt,
          status: attempt === 3 ? 'failed' : 'pending',
        });
        if (attempt === 3) {
          const failed = await runs.get(owner, workspaceId, serviceId, queued.id);
          expect(failed.completedAt).toBe(failed.updatedAt);
          expect(failed.createdAt <= failed.updatedAt).toBe(true);
        }
        if (attempt < 3) expect(await worker.claim()).toBeNull();
      }
      expect(await processOne(pool)).toBe(false);
      expect(JSON.stringify(log.mock.calls)).not.toContain('private mock payload');
    } finally {
      log.mockRestore();
    }
  });
  it('enforces immutable inputs, snapshots and terminal states; rolls back failed atomic completion', async () => {
    const { run: queued } = await enqueue();
    for (const change of [
      'mapping_revision=2',
      "service_name='changed'",
      "request_id='00000000-0000-4000-8000-000000000000'",
    ])
      await expect(
        pool.query(`UPDATE mock_collection_runs SET ${change} WHERE id=$1`, [queued.id]),
      ).rejects.toThrow('immutable');
    const claim = await worker.claim();
    if (!claim || typeof claim.serviceName !== 'string') throw new Error('Missing claim');
    const mapping = parseMapping(claim.mapping);
    const capture = captureMapping(mapping, { id: mapping.serviceId, name: claim.serviceName });
    await pool.query(
      `CREATE FUNCTION reject_test_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'test terminal failure'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER test_completion BEFORE UPDATE ON mock_collection_runs FOR EACH ROW EXECUTE FUNCTION reject_test_completion()',
    );
    await expect(worker.complete(claim, capture)).rejects.toThrow('test terminal failure');
    expect(
      (await pool.query('SELECT run_id FROM mock_collection_snapshots WHERE run_id=$1', [claim.id]))
        .rowCount,
    ).toBe(0);
    expect((await runs.get(owner, workspaceId, serviceId, claim.id)).status).toBe('running');
    await pool.query('DROP TRIGGER test_completion ON mock_collection_runs');
    await pool.query('DROP FUNCTION reject_test_completion()');
    expect(await worker.complete(claim, capture)).toBe(true);
    await expect(
      pool.query(
        "UPDATE mock_collection_runs SET status='pending',result=NULL,completed_at=NULL WHERE id=$1",
        [claim.id],
      ),
    ).rejects.toThrow('immutable');
    await expect(
      pool.query('DELETE FROM mock_collection_runs WHERE id=$1', [claim.id]),
    ).rejects.toThrow('immutable');
    await expect(
      pool.query("UPDATE mock_collection_snapshots SET digest=repeat('0',64) WHERE run_id=$1", [
        claim.id,
      ]),
    ).rejects.toThrow('immutable');
    await expect(
      pool.query('DELETE FROM mock_collection_snapshots WHERE run_id=$1', [claim.id]),
    ).rejects.toThrow('immutable');
  });
  it('stores both fictional sources with unknown coverage; lists latest 25 and detects readiness drift', async () => {
    for (const provider of ['github', 'argocd'] as const) {
      const { body } = await fixture(provider);
      for (let count = 0; count < 27; count++) {
        const queued = await runs.enqueue(owner, workspaceId, serviceId, {
          ...body,
          requestId: randomUUID(),
        });
        await processOne(pool);
        const result = await runs.get(owner, workspaceId, serviceId, queued.id);
        expect(result).toMatchObject({
          status: 'succeeded',
          primaryProvider: provider,
          result: {
            mode: 'mock',
            coverage: {
              collectionComplete: false,
              deploymentHistoryComplete: false,
              recoveryEvidenceComplete: false,
            },
            deploymentFrequency: { deploymentsPerDay: null },
            changeFailureRate: null,
            failedDeploymentRecoveryTime: null,
          },
        });
      }
      const listed = await runs.list(member, workspaceId, serviceId);
      expect(listed).toHaveLength(25);
      expect(listed.map((r) => r.createdAt)).toEqual(
        listed
          .map((r) => r.createdAt)
          .sort()
          .reverse(),
      );
    }
    await expect(checkReadiness(pool, migrations)).resolves.toBeUndefined();
    await pool.query(
      'ALTER TABLE mock_collection_snapshots RENAME COLUMN evidence TO missing_evidence',
    );
    await expect(checkReadiness(pool, migrations)).rejects.toThrow();
    await pool.query(
      'ALTER TABLE mock_collection_snapshots RENAME COLUMN missing_evidence TO evidence',
    );
  });
  it('captures complete scenario immutably across mapping changes, replay and expired lease takeover', async () => {
    // Own service avoids altering any real provider connection or previous fixture history.
    session();
    const service = await identities.createService(
      owner,
      workspaceId,
      `Fictional lifecycle ${randomUUID()}`,
    );
    serviceId = service.id;
    const mapping = await mappings.save(owner, workspaceId, serviceId, {
      ...settings,
      scenario: 'complete-lifecycle',
    });
    const body = { revision: mapping.revision, requestId: randomUUID() };
    const queued = await runs.enqueue(owner, workspaceId, serviceId, body);
    expect(queued.scenario).toBe('complete-lifecycle');
    const first = await worker.claim();
    if (!first || first.id !== queued.id || typeof first.serviceName !== 'string')
      throw new Error('Missing lifecycle claim');
    const captured = parseMapping(first.mapping);
    expect(captured.scenario).toBe('complete-lifecycle');
    await mappings.save(owner, workspaceId, serviceId, {
      ...settings,
      expectedRevision: 1,
      scenario: 'partial',
      exposureAttested: false,
    });
    expect(await runs.enqueue(owner, workspaceId, serviceId, body)).toMatchObject({
      id: queued.id,
      createdAt: queued.createdAt,
      mappingRevision: queued.mappingRevision,
      mappingObservedAt: queued.mappingObservedAt,
      scenario: 'complete-lifecycle',
      status: 'running',
      attempts: 1,
    });
    await expire(first.id);
    const second = await worker.claim();
    if (!second || second.id !== first.id) throw new Error('Missing replacement lifecycle lease');
    const capture = captureMapping(captured, { id: service.id, name: first.serviceName });
    expect(await worker.complete(first, capture)).toBe(false);
    expect(await worker.complete(second, capture)).toBe(true);
    expect(await worker.complete(second, capture)).toBe(false);
    const saved = await runs.get(member, workspaceId, serviceId, queued.id);
    expect(saved).toMatchObject({
      scenario: 'complete-lifecycle',
      mappingRevision: 1,
      attempts: 2,
      status: 'succeeded',
      result: {
        scenario: 'complete-lifecycle',
        resultVersion: 'clio.mock.lifecycle.v1',
        deploymentFrequency: { count: 3, deploymentsPerDay: 1.5 },
        changeFailureRate: 1 / 3,
        failedDeploymentRecoveryTime: 1800,
        metricResult: {
          change_lead_time: { median_seconds: 3600 },
          deployment_rework_rate: { ratio: 1 / 3 },
        },
      },
    });
    expect((await runs.enqueue(owner, workspaceId, serviceId, body)).id).toBe(queued.id);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM mock_collection_snapshots WHERE run_id=$1',
          [queued.id],
        )
      ).rows[0]?.count,
    ).toBe(1);
    const next = await runs.enqueue(owner, workspaceId, serviceId, {
      revision: 2,
      requestId: randomUUID(),
    });
    await processOne(pool);
    expect((await runs.get(owner, workspaceId, serviceId, next.id)).result).toMatchObject({
      coverage: { collectionComplete: false },
      deploymentFrequency: { count: 0, deploymentsPerDay: null },
    });
    expect(await runs.get(member, workspaceId, serviceId, queued.id)).toEqual(saved);
    await expect(async () =>
      mappings.save(owner, workspaceId, serviceId, {
        ...settings,
        expectedRevision: 2,
        scenario: 'complete-lifecycle',
        productionEnvironment: 'staging',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      pool.query(
        "UPDATE deployment_mapping_revisions SET scenario='partial' WHERE workspace_id=$1 AND service_id=$2 AND revision=1",
        [workspaceId, serviceId],
      ),
    ).rejects.toThrow('immutable');
    await pool.query(
      'ALTER TABLE deployment_mapping_revisions RENAME COLUMN scenario TO missing_scenario',
    );
    await expect(checkReadiness(pool, migrations)).rejects.toThrow();
    await pool.query(
      'ALTER TABLE deployment_mapping_revisions RENAME COLUMN missing_scenario TO scenario',
    );
  });
});

it('saved history finds success behind 30 failures and pages tied timestamps with scoped authorization', async () => {
  await pool.query(
    "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$1,clock_timestamp()+interval '1 day') ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at",
    [outsider.sessionId, outsider.userId],
  );
  const f = await enqueue();
  await finishAll();
  const repo = runs;
  const wid = workspaceId,
    sid = serviceId;
  const queued = f.run;
  const saved = await repo.get(member, wid, sid, queued.id);
  await pool.query(
    `INSERT INTO mock_collection_runs(id,workspace_id,service_id,request_id,mapping_revision,mapping_input,service_name,status,attempts,created_at,updated_at,completed_at,failure_code)
       SELECT gen_random_uuid(),workspace_id,service_id,gen_random_uuid(),mapping_revision,mapping_input,service_name,'failed',1,statement_timestamp(),statement_timestamp(),statement_timestamp(),'mock_processing_failed'
       FROM mock_collection_runs CROSS JOIN generate_series(1,30) WHERE id=$1`,
    [queued.id],
  );
  await runs.enqueue(owner, wid, sid, { revision: 1, requestId: randomUUID() });
  expect((await repo.list(member, wid, sid)).every((run) => run.status !== 'succeeded')).toBe(true);
  const success = await repo.listPage(member, wid, sid, { status: 'succeeded' });
  expect(success).toEqual({ runs: [saved], nextCursor: null });
  session(member);
  const history = await server.inject(url('mock-collection-runs?status=succeeded'));
  expect(history.statusCode).toBe(200);
  expect(history.json()).toEqual(success);
  expect(history.headers['cache-control']).toBe('no-store');
  expect((await server.inject(url('mock-collection-runs?unknown=true'))).statusCode).toBe(400);
  session();
  const first = await repo.listPage(member, wid, sid);
  expect(first.runs).toHaveLength(25);
  expect(first.nextCursor).toBe(first.runs.at(-1)?.id);
  const second = await repo.listPage(member, wid, sid, { cursor: first.nextCursor });
  expect(second.runs).toHaveLength(7);
  expect(second.nextCursor).toBeNull();
  const all = [...first.runs, ...second.runs];
  expect(new Set(all.map((run) => run.id)).size).toBe(32);
  const storage = await pool.query<{ id: string }>(
    `SELECT id FROM mock_collection_runs WHERE workspace_id=$1 AND service_id=$2 ORDER BY created_at DESC,id DESC`,
    [wid, sid],
  );
  expect(all.map((run) => run.id)).toEqual(storage.rows.map((row) => row.id));
  expect(second.runs.at(-1)).toEqual(saved);
  for (const query of [{ cursor: randomUUID() }, { cursor: first.nextCursor, status: 'succeeded' }])
    await expect(repo.listPage(member, wid, sid, query)).rejects.toMatchObject({ status: 404 });
  for (const query of [
    { cursor: 'invalid' },
    { limit: 100 },
    { status: 'failed' },
    { cursor: [queued.id] },
  ])
    await expect(async () => repo.listPage(member, wid, sid, query)).rejects.toMatchObject({
      status: 400,
    });
  const other = await createIdentityRepository(pool).createService(owner, wid, 'Other history');
  await expect(repo.listPage(member, wid, other.id, { cursor: queued.id })).rejects.toMatchObject({
    status: 404,
  });
  await expect(repo.listPage(outsider, wid, sid)).rejects.toMatchObject({ status: 404 });
  await mappings.save(owner, wid, sid, {
    ...settings,
    expectedRevision: 1,
    primaryProvider: 'argocd',
  });
  expect(await repo.get(member, wid, sid, queued.id)).toEqual(saved);
  await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
    wid,
    member.userId,
  ]);
  await expect(repo.listPage(member, wid, sid, { status: 'succeeded' })).rejects.toMatchObject({
    status: 404,
  });
  await pool.query(
    "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [owner.sessionId],
  );
  try {
    await expect(
      repo.listPage(owner, wid, sid, { cursor: first.nextCursor }),
    ).rejects.toMatchObject({ status: 401 });
  } finally {
    await pool.query(
      "UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      [owner.sessionId],
    );
  }
});

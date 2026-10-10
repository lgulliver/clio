import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrations.ts';
import type { ArgoConfig } from '../src/features/argo-collection/config.ts';
import { registerArgoIngress } from '../src/features/argo-collection/ingress.ts';
import { instant } from '../src/features/argo-collection/input.ts';
import { createArgoRepository } from '../src/features/argo-collection/repository.ts';
import { createArgoWorker } from '../src/features/argo-collection/worker.ts';
import { createIdentityRepository } from '../src/features/identity/repository.ts';
import { grantFixture } from './argo-fixture.ts';

if (!process.env.CLIO_TEST_DATABASE_URL) throw new Error('CLIO_TEST_DATABASE_URL required');
const connectionString = process.env.CLIO_TEST_DATABASE_URL;
const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString });
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
  statement_timeout: 10000,
});
const owner = { userId: 'argo-owner', sessionId: 'argo-owner-session' },
  member = { userId: 'argo-member', sessionId: 'argo-member-session' },
  outsider = { userId: 'argo-outsider', sessionId: 'argo-outsider-session' };
let created = false;
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool, await loadMigrations());
  for (const actor of [owner, member, outsider]) {
    await pool.query('INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,$1,$2,true)', [
      actor.userId,
      `${actor.userId}@example.com`,
    ]);
    await pool.query(
      "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$1,clock_timestamp()+interval '1 day')",
      [actor.sessionId, actor.userId],
    );
  }
});
afterAll(async () => {
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});
async function fixture() {
  const ids = createIdentityRepository(pool),
    w = await ids.createWorkspace(owner, randomUUID()),
    s = await ids.createService(owner, w.id, 'Argo fixture');
  await pool.query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    [w.id, member.userId],
  );
  const scope = grantFixture(w.id, s.id),
    token = 'b'.repeat(64);
  const grant = {
    ...scope,
    tokenDigest: createHash('sha256').update(token).digest('hex'),
    fingerprint: createHash('sha256')
      .update(JSON.stringify(scope) + token)
      .digest('hex'),
  };
  const config: ArgoConfig = { grants: [grant] },
    repo = createArgoRepository(pool, config);
  const save = (expectedRevision: number | null = null) =>
    repo.save(owner, w.id, s.id, {
      expectedRevision,
      sourceId: scope.sourceId,
      applicationOperationsBelongToService: true,
      exposurePolicyReference: 'urn:fixture:policy:v1',
    });
  await save();
  const app = Fastify({ logger: false });
  registerArgoIngress(app, { pool, argo: config });
  const post = (payload: unknown, credential = token) =>
    app.inject({
      method: 'POST',
      url: `/api/argo/sources/${scope.sourceId}/operations`,
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  const enqueue = (revision = 1, requestId = randomUUID()) =>
    repo.enqueue(owner, w.id, s.id, {
      connectionRevision: revision,
      requestId,
      window: { start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' },
    });
  return { w: w.id, s: s.id, scope, config, repo, app, post, save, enqueue };
}
function notification(f: Awaited<ReturnType<typeof fixture>>, id = randomUUID()) {
  const finished = new Date(Date.now() - 60000).toISOString(),
    started = new Date(Date.now() - 120000).toISOString();
  return {
    contract: 'clio.argocd.notification.v1',
    application: {
      uid: f.scope.applicationUid,
      name: f.scope.applicationName,
      namespace: f.scope.applicationNamespace,
      project: f.scope.project,
      destination: {
        server: f.scope.destinationServer,
        name: null,
        namespace: f.scope.destinationNamespace,
      },
      repoURL: f.scope.repoURL,
      hasSources: false,
      hasSourceHydrator: false,
    },
    operation: {
      phase: 'Succeeded',
      startedAt: started,
      finishedAt: finished,
      retryCount: 0,
      info: [
        { name: 'clio.operation-id', value: id },
        { name: 'clio.operation-kind', value: 'rollout' },
      ],
      initiatedBy: { username: 'fixture', automated: false },
      revision: 'opaque-config-rev',
      revisions: [],
    },
    health: { status: 'Healthy', lastTransitionTime: finished },
  };
}
it('owner writes/member reads, outsider hidden and expired session rejected', async () => {
  const f = await fixture();
  try {
    expect((await f.repo.get(member, f.w, f.s)).connection?.revision).toBe(1);
    await expect(
      f.repo.disconnect(member, f.w, f.s, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(f.repo.get(outsider, f.w, f.s)).rejects.toMatchObject({ status: 404 });
    await pool.query(
      "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [owner.sessionId],
    );
    await expect(f.save(1)).rejects.toMatchObject({ status: 401 });
  } finally {
    await pool.query(
      "UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      [owner.sessionId],
    );
    await f.app.close();
  }
});
it('auth before JSON, immutable original replay, metadata conflict and disconnect fences replay', async () => {
  const f = await fixture();
  try {
    expect((await f.post('{', 'wrong')).statusCode).toBe(401);
    const payload = notification(f),
      first = await f.post(payload);
    expect(first.statusCode).toBe(202);
    expect((await f.post(payload)).json()).toEqual(first.json());
    const changed = { ...payload, operation: { ...payload.operation, revision: 'different' } };
    expect((await f.post(changed)).statusCode).toBe(409);
    await f.repo.disconnect(owner, f.w, f.s, { expectedRevision: 1 });
    expect((await f.post(payload)).statusCode).toBe(409);
  } finally {
    await f.app.close();
  }
});
it('scope drift retains no foreign payload; unsupported observations save deduplicated minimal gaps', async () => {
  const f = await fixture();
  try {
    const payload = notification(f);
    expect(
      (
        await f.post({
          ...payload,
          application: { ...payload.application, project: 'PRIVATE-FOREIGN' },
        })
      ).statusCode,
    ).toBe(400);
    const gap = { ...payload, operation: { ...payload.operation, info: [] } };
    const first = await f.post(gap);
    expect(first.statusCode).toBe(202);
    expect((await f.post(gap)).json()).toEqual(first.json());
    const run = await f.enqueue();
    expect(await createArgoWorker(pool, f.config).runOnce()).toBe(true);
    const result = (await f.repo.getRun(member, f.w, f.s, run.id)).result;
    expect(result).toMatchObject({
      recordedGapCount: 1,
      scopeDriftCount: 1,
      transportComplete: false,
      changeFailureRate: null,
      failedDeploymentRecoveryTime: null,
      retainedEvidenceCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-FOREIGN');
  } finally {
    await f.app.close();
  }
});
it('atomic snapshots retain operation metadata, statuses and cutoff counts without qualifying native exposure', async () => {
  const f = await fixture();
  try {
    const payload = notification(f);
    expect((await f.post(payload)).statusCode).toBe(202);
    const run = await f.enqueue();
    const worker = createArgoWorker(pool, f.config);
    const claim = await worker.claim();
    expect(claim?.id).toBe(run.id);
    if (!claim) throw new Error('missing claim');
    await worker.complete(claim);
    const saved = await f.repo.getRun(member, f.w, f.s, run.id);
    expect(saved).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      result: {
        retainedReceiptCount: 1,
        retainedEvidenceCount: 2,
        qualifyingCount: 0,
        transportComplete: false,
        deploymentFrequency: { status: 'provisional', deploymentsPerDay: null },
      },
    });
    expect((await f.post(notification(f))).statusCode).toBe(202);
    expect((await f.repo.getRun(member, f.w, f.s, run.id)).result).toEqual(saved.result);
    expect(await worker.complete(claim)).toBe(false);
  } finally {
    await f.app.close();
  }
});
it('grant drift fences processing; expired claims cannot complete; runs replay input conflicts', async () => {
  const f = await fixture();
  try {
    const requestId = randomUUID(),
      run = await f.enqueue(1, requestId);
    expect((await f.enqueue(1, requestId)).id).toBe(run.id);
    await expect(f.enqueue(2, requestId)).rejects.toMatchObject({ status: 409 });
    const worker = createArgoWorker(pool, f.config, { configNow: () => null });
    expect(await worker.runOnce()).toBe(true);
    expect(await f.repo.getRun(member, f.w, f.s, run.id)).toMatchObject({
      status: 'failed',
      failureCode: 'argo_connection_revoked',
    });
    const next = await f.enqueue();
    const other = createArgoWorker(pool, f.config);
    const old = await other.claim();
    if (!old) throw new Error('missing claim');
    await pool.query(
      "UPDATE argo_collection_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [next.id],
    );
    expect(await other.complete(old)).toBe(false);
    expect(await other.runOnce()).toBe(true);
    expect((await f.repo.getRun(member, f.w, f.s, next.id)).attempts).toBe(2);
  } finally {
    await f.app.close();
  }
});
it('new arrivals enforce horizon but authorized exact replay precedes age; temporal gaps cannot bypass metadata conflicts', async () => {
  const f = await fixture();
  try {
    const payload = notification(f);
    const first = await f.post(payload);
    expect(first.statusCode).toBe(202);
    const worker = createArgoWorker(pool, f.config);
    const old = {
      ...payload,
      operation: {
        ...payload.operation,
        startedAt: '2026-01-02T10:00:00Z',
        finishedAt: '2026-01-02T10:01:00Z',
      },
      health: { ...payload.health, lastTransitionTime: '2026-01-02T10:01:00Z' },
    };
    expect((await f.post(old)).statusCode).toBe(409);
    const gap = {
      ...old,
      operation: {
        ...old.operation,
        info: [
          { name: 'clio.operation-id', value: randomUUID() },
          { name: 'clio.operation-kind', value: 'rollout' },
        ],
      },
    };
    expect((await f.post(gap)).statusCode).toBe(202);
    expect((await f.post(payload)).json()).toEqual(first.json());
    const run = await f.enqueue();
    await worker.runOnce();
    expect((await f.repo.getRun(member, f.w, f.s, run.id)).result?.gapReasons).toEqual({
      observation_horizon: 1,
    });
  } finally {
    await f.app.close();
  }
});
it('budgets fail closed with saturating counters while exact replay remains free and disconnect remains possible', async () => {
  const f = await fixture();
  try {
    const payload = notification(f),
      first = await f.post(payload);
    expect(first.statusCode).toBe(202);
    await pool.query(
      'UPDATE argo_source_state SET retained_rows=5000,rejection_count=2147483646 WHERE source_id=$1',
      [f.scope.sourceId],
    );
    expect((await f.post(notification(f))).statusCode).toBe(503);
    expect((await f.post(payload)).json()).toEqual(first.json());
    expect((await f.post(notification(f))).statusCode).toBe(503);
    const row = (
      await pool.query('SELECT rejection_count FROM argo_source_state WHERE source_id=$1', [
        f.scope.sourceId,
      ])
    ).rows[0];
    expect(row?.rejection_count).toBe(2147483647);
    await f.repo.disconnect(owner, f.w, f.s, { expectedRevision: 1 });
    await f.save(2);
    const run = await f.enqueue(3);
    await createArgoWorker(pool, f.config).runOnce();
    expect(
      (await f.repo.getRun(member, f.w, f.s, run.id)).result?.gapReasons.connection_interruption,
    ).toBe(2);
  } finally {
    await f.app.close();
  }
});
it('connection boundaries count once each, policy re-save has no gap and inactive disconnect conflicts', async () => {
  const f = await fixture();
  try {
    const count = async () =>
      Number(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM argo_interruptions WHERE source_id=$1',
            [f.scope.sourceId],
          )
        ).rows[0]?.count,
      );
    await f.save(1);
    expect(await count()).toBe(0);
    await f.repo.disconnect(owner, f.w, f.s, { expectedRevision: 2 });
    expect(await count()).toBe(1);
    await expect(f.repo.disconnect(owner, f.w, f.s, { expectedRevision: 3 })).rejects.toMatchObject(
      { status: 409 },
    );
    expect(await count()).toBe(1);
    await f.save(3);
    expect(await count()).toBe(2);
    await f.save(4);
    expect(await count()).toBe(2);
    const old = f.config.grants[0];
    if (!old) throw new Error('Missing test grant');
    const next = {
      ...old,
      sourceId: randomUUID(),
      applicationUid: randomUUID(),
      fingerprint: 'a'.repeat(64),
    };
    const repository = createArgoRepository(pool, { grants: [old, next] });
    await repository.save(owner, f.w, f.s, {
      expectedRevision: 5,
      sourceId: next.sourceId,
      applicationOperationsBelongToService: true,
      exposurePolicyReference: null,
    });
    expect(await count()).toBe(3);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM argo_interruptions WHERE source_id=$1',
          [next.sourceId],
        )
      ).rows[0]?.count,
    ).toBe(1);
  } finally {
    await f.app.close();
  }
});
it('new windows must be closed against database time even when application clock is ahead', async () => {
  const f = await fixture();
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 86400000);
    const repository = createArgoRepository(pool, f.config, {
      clock: () => new Date(tomorrow.getTime() + 86400000),
    });
    await expect(
      repository.enqueue(owner, f.w, f.s, {
        connectionRevision: 1,
        requestId: randomUUID(),
        window: { start: today.toISOString(), end: tomorrow.toISOString() },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await f.repo.list(owner, f.w, f.s)).length).toBe(0);
  } finally {
    await f.app.close();
  }
});
it('same combination changes become minimal gaps; out-of-order statuses preserve oldest metadata and every accepted combination', async () => {
  const f = await fixture();
  try {
    const payload = notification(f);
    expect((await f.post(payload)).statusCode).toBe(202);
    const older = {
      ...payload,
      operation: {
        ...payload.operation,
        phase: 'Failed',
        finishedAt: new Date(Date.now() - 90000).toISOString(),
      },
      health: {
        status: 'Degraded',
        lastTransitionTime: new Date(Date.now() - 90000).toISOString(),
      },
    };
    expect((await f.post(older)).statusCode).toBe(202);
    const repeated = {
      ...payload,
      health: { ...payload.health, lastTransitionTime: new Date(Date.now() - 30000).toISOString() },
    };
    expect((await f.post(repeated)).statusCode).toBe(202);
    const run = await f.enqueue();
    await createArgoWorker(pool, f.config).runOnce();
    const saved = await f.repo.getRun(member, f.w, f.s, run.id);
    expect(saved.result).toMatchObject({
      retainedReceiptCount: 3,
      retainedEvidenceCount: 4,
      recordedGapCount: 1,
      gapReasons: { status_combination_repeated: 1 },
    });
    const snapshot = (
      await pool.query('SELECT evidence FROM argo_collection_snapshots WHERE run_id=$1', [run.id])
    ).rows[0]?.evidence;
    expect(snapshot.deployments).toHaveLength(1);
    expect(snapshot.statuses).toHaveLength(2);
    expect(instant(snapshot.deployments[0].observedAt)).toBe(
      instant((await f.post(payload)).json().observedAt),
    );
    expect(
      snapshot.statuses.every((s: { consumerExposure: boolean }) => s.consumerExposure === false),
    ).toBe(true);
  } finally {
    await f.app.close();
  }
});
it('completion rolls back snapshot when grant changes at terminal fence, then retries no more than three attempts', async () => {
  const f = await fixture();
  try {
    expect((await f.post(notification(f))).statusCode).toBe(202);
    const run = await f.enqueue();
    let reads = 0;
    const worker = createArgoWorker(pool, f.config, {
      configNow: () => (++reads === 1 ? f.config : null),
    });
    expect(await worker.runOnce()).toBe(true);
    expect((await f.repo.getRun(member, f.w, f.s, run.id)).failureCode).toBe(
      'argo_connection_revoked',
    );
    expect(
      (await pool.query('SELECT run_id FROM argo_collection_snapshots WHERE run_id=$1', [run.id]))
        .rowCount,
    ).toBe(0);
    const retry = await f.enqueue(),
      other = createArgoWorker(pool, f.config);
    for (let i = 1; i <= 3; i++) {
      const claim = await other.claim();
      if (!claim) throw new Error('Missing retry claim');
      expect(claim.id).toBe(retry.id);
      await other.fail(claim);
      await pool.query(
        "UPDATE argo_collection_runs SET available_at=clock_timestamp() WHERE id=$1 AND status='pending'",
        [retry.id],
      );
    }
    expect(await f.repo.getRun(member, f.w, f.s, retry.id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      failureCode: 'argo_processing_failed',
    });
    expect(await other.claim()).toBeNull();
  } finally {
    await f.app.close();
  }
});
it('scope drift is distinct from malformed shape and token/query auth never becomes browser authorization', async () => {
  const f = await fixture();
  try {
    const payload = notification(f);
    expect((await f.post({ ...payload, extra: 'private' })).statusCode).toBe(400);
    const state = (
      await pool.query('SELECT scope_drift_count FROM argo_source_state WHERE source_id=$1', [
        f.scope.sourceId,
      ])
    ).rows[0];
    expect(state?.scope_drift_count).toBe(0);
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/argo/sources/${f.scope.sourceId}/operations?token=${'b'.repeat(64)}`,
      headers: { authorization: `Bearer ${'b'.repeat(64)}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
    expect(response.statusCode).toBe(401);
    expect((await f.post('{')).statusCode).toBe(400);
    expect((await f.post(' '.repeat(65537))).statusCode).toBe(400);
    expect(
      (await pool.query('SELECT id FROM argo_receipts WHERE source_id=$1', [f.scope.sourceId]))
        .rowCount,
    ).toBe(0);
  } finally {
    await f.app.close();
  }
});
it('browser mutations demand write actor with exact Origin and keep current DB membership authoritative', async () => {
  const f = await fixture(),
    app = Fastify({ logger: false });
  const { registerArgoRoutes } = await import('../src/features/argo-collection/routes.ts');
  const { IdentityError } = await import('../src/features/identity/input.ts');
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(error instanceof IdentityError ? error.status : 503)
      .send({ error: error instanceof IdentityError ? error.message : 'unavailable' }),
  );
  registerArgoRoutes(app, {
    pool,
    argo: f.config,
    actor: async (req, _reply, write) => {
      if (write && req.headers.origin !== 'http://localhost:5173')
        throw new IdentityError(403, 'forbidden');
      return owner;
    },
  });
  const url = `/api/workspaces/${f.w}/services/${f.s}/argo-connection/disconnect`;
  try {
    expect(
      (await app.inject({ method: 'POST', url, payload: { expectedRevision: 1 } })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { origin: 'https://foreign.example' },
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(403);
    await pool.query(
      "UPDATE workspace_memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",
      [f.w, owner.userId],
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { origin: 'http://localhost:5173' },
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/workspaces/${f.w}/services/${f.s}/argo-connection`,
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
    await f.app.close();
  }
});
it('source locks serialize later receipts/counters behind cutoff snapshot', async () => {
  const f = await fixture();
  try {
    const { acceptReceipt } = await import('../src/features/argo-collection/ingress.ts');
    const payload = notification(f);
    expect((await f.post(payload)).statusCode).toBe(202);
    const run = await f.enqueue();
    let pending: ReturnType<typeof acceptReceipt> | undefined;
    const grant = f.config.grants[0];
    if (!grant) throw new Error('Missing grant');
    const worker = createArgoWorker(pool, f.config, {
      configNow: () => {
        pending ??= acceptReceipt(pool, grant, {
          ...payload,
          application: { ...payload.application, project: 'later-scope-drift' },
        });
        return f.config;
      },
    });
    expect(await worker.runOnce()).toBe(true);
    await pending;
    const result = (await f.repo.getRun(member, f.w, f.s, run.id)).result;
    expect(result).toMatchObject({ retainedReceiptCount: 1, scopeDriftCount: 0 });
    expect(
      (
        await pool.query('SELECT scope_drift_count FROM argo_source_state WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rows[0]?.scope_drift_count,
    ).toBe(1);
  } finally {
    await f.app.close();
  }
});
it('byte budget rejects new observations without dropping first receipts; changed grant cannot replay retained receipts', async () => {
  const f = await fixture();
  try {
    const payload = notification(f),
      first = await f.post(payload);
    expect(first.statusCode).toBe(202);
    await pool.query('UPDATE argo_source_state SET retained_bytes=8388608 WHERE source_id=$1', [
      f.scope.sourceId,
    ]);
    expect((await f.post(notification(f))).statusCode).toBe(503);
    expect((await f.post(payload)).json()).toEqual(first.json());
    const grant = f.config.grants[0];
    if (!grant) throw new Error('Missing grant');
    const config = { grants: [{ ...grant, fingerprint: 'f'.repeat(64) }] },
      app = Fastify({ logger: false });
    registerArgoIngress(app, { pool, argo: config });
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/argo/sources/${f.scope.sourceId}/operations`,
            headers: {
              authorization: `Bearer ${'b'.repeat(64)}`,
              'content-type': 'application/json',
            },
            payload: JSON.stringify(payload),
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  } finally {
    await f.app.close();
  }
});
it('receipt and snapshot records reject mutation and terminal run input/result rewrites', async () => {
  const f = await fixture();
  try {
    const receipt = await f.post(notification(f));
    expect(receipt.statusCode).toBe(202);
    await expect(
      pool.query("UPDATE argo_receipts SET reason='non_terminal' WHERE id=$1", [
        receipt.json().receiptId,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query('DELETE FROM argo_receipts WHERE id=$1', [receipt.json().receiptId]),
    ).rejects.toThrow();
    const run = await f.enqueue();
    await createArgoWorker(pool, f.config).runOnce();
    await expect(
      pool.query('UPDATE argo_collection_snapshots SET digest=$2 WHERE run_id=$1', [
        run.id,
        '0'.repeat(64),
      ]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      pool.query('UPDATE argo_collection_runs SET result=result WHERE id=$1', [run.id]),
    ).rejects.toThrow('Argo terminal runs are immutable');
    expect((await f.repo.getRun(member, f.w, f.s, run.id)).status).toBe('succeeded');
  } finally {
    await f.app.close();
  }
});
it('authorized canonical replay retains original observation after native age horizon', async () => {
  const f = await fixture();
  try {
    const { argoNotificationDigest, parseArgoNotification } = await import('@clio/adapters');
    const { scopeFor } = await import('../src/features/argo-collection/config.ts');
    const grant = f.config.grants[0];
    if (!grant) throw new Error('Missing grant');
    const payload = notification(f);
    payload.operation.startedAt = '2026-01-02T10:00:00Z';
    payload.operation.finishedAt = '2026-01-02T10:01:00Z';
    payload.health.lastTransitionTime = '2026-01-02T10:01:00Z';
    const observedAt = '2026-01-02T10:02:00.123456Z',
      scope = scopeFor(grant),
      notificationResult = parseArgoNotification(payload, scope, observedAt),
      receiptId = randomUUID();
    if (notificationResult.kind !== 'operation')
      throw new Error('Expected seeded historical operation');
    // Represent a historical, already accepted database-clock receipt in this random schema.
    await pool.query(
      'INSERT INTO argo_receipts(id,source_id,workspace_id,service_id,connection_revision,application_uid,grant_fingerprint,scope,digest,observed_at,started_at,operation_id,notification_revision,phase,health,canonical_json,evidence) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [
        receiptId,
        grant.sourceId,
        f.w,
        f.s,
        grant.applicationUid,
        grant.fingerprint,
        JSON.stringify(scope),
        argoNotificationDigest(payload, scope),
        observedAt,
        notificationResult.startedAt,
        notificationResult.operationId,
        notificationResult.notificationRevision,
        notificationResult.phase,
        notificationResult.health,
        notificationResult.canonicalJson,
        JSON.stringify(notificationResult.evidence),
      ],
    );
    await pool.query(
      'UPDATE argo_source_state SET retained_rows=3,first_observed_at=$2 WHERE source_id=$1',
      [grant.sourceId, observedAt],
    );
    const response = await f.post(payload);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ receiptId, observedAt });
    expect(
      (
        await pool.query('SELECT retained_rows FROM argo_source_state WHERE source_id=$1', [
          grant.sourceId,
        ])
      ).rows[0]?.retained_rows,
    ).toBe(3);
    const run = await f.enqueue();
    await createArgoWorker(pool, f.config).runOnce();
    expect((await f.repo.getRun(member, f.w, f.s, run.id)).result).toMatchObject({
      deploymentCount: 1,
      qualifyingCount: 0,
      unknownCount: 1,
      retainedEvidenceCount: 2,
      deploymentFrequency: { count: 0, status: 'provisional' },
      observationPeriod: { start: observedAt },
    });
  } finally {
    await f.app.close();
  }
});
it('concurrent notification retries and enqueue retries persist one identity under serial locks', async () => {
  const f = await fixture();
  try {
    const payload = notification(f),
      responses = await Promise.all([f.post(payload), f.post(payload), f.post(payload)]);
    expect(responses.every((response) => response.statusCode === 202)).toBe(true);
    expect(new Set(responses.map((response) => response.json().receiptId)).size).toBe(1);
    expect(
      (
        await pool.query('SELECT retained_rows FROM argo_source_state WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rows[0]?.retained_rows,
    ).toBe(3);
    const requestId = randomUUID(),
      runs = await Promise.all([f.enqueue(1, requestId), f.enqueue(1, requestId)]);
    expect(runs[0]?.id).toBe(runs[1]?.id);
    await f.repo.disconnect(owner, f.w, f.s, { expectedRevision: 1 });
    expect((await f.repo.getRun(member, f.w, f.s, runs[0]?.id ?? '')).failureCode).toBe(
      'argo_connection_revoked',
    );
  } finally {
    await f.app.close();
  }
});

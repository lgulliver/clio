import { createHash, randomUUID } from 'node:crypto';
import { archiveRecordDigest, argoNotificationDigest, parseArgoNotification } from '@clio/adapters';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrations.ts';
import type { ArgoConfig } from '../src/features/argo-collection/config.ts';
import { registerArgoIngress } from '../src/features/argo-collection/ingress.ts';
import { createArgoRepository } from '../src/features/argo-collection/repository.ts';
import { createArgoWorker } from '../src/features/argo-collection/worker.ts';
import { createIdentityRepository } from '../src/features/identity/repository.ts';
import { grantFixture } from './argo-fixture.ts';

const connectionString = process.env.CLIO_TEST_DATABASE_URL;
if (!connectionString) throw new Error('CLIO_TEST_DATABASE_URL required');
const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString });
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
  statement_timeout: 10000,
});
const owner = { userId: 'archive-owner', sessionId: 'archive-session' };
let created = false;
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool, await loadMigrations());
  await pool.query(
    "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,$1,'archive@example.com',true)",
    [owner.userId],
  );
  await pool.query(
    "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$1,clock_timestamp()+interval '1 day')",
    [owner.sessionId, owner.userId],
  );
});
afterAll(async () => {
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});
async function fixture() {
  const identity = createIdentityRepository(pool),
    w = await identity.createWorkspace(owner, randomUUID()),
    service = await identity.createService(owner, w.id, 'archive');
  const scope = grantFixture(w.id, service.id),
    token = 'b'.repeat(64),
    archiveToken = 'c'.repeat(64);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const grant = {
    ...scope,
    tokenDigest: hash(token),
    fingerprint: hash(JSON.stringify(scope) + token),
  };
  const archive = {
    ...scope,
    producerId: randomUUID(),
    journalId: randomUUID(),
    policyReference: 'urn:fixture:archive:v1',
    capability: 'operation_archive' as const,
    tokenDigest: hash(archiveToken),
    fingerprint: hash(JSON.stringify(scope) + archiveToken),
  };
  let config: ArgoConfig = { grants: [grant], archives: [archive] };
  const repo = createArgoRepository(pool, config, { configNow: () => config });
  const save = (revision: number | null = null, selected: string | null = archive.producerId) =>
    repo.save(owner, w.id, service.id, {
      expectedRevision: revision,
      sourceId: scope.sourceId,
      archiveProducerId: selected,
      applicationOperationsBelongToService: true,
      exposurePolicyReference: null,
    });
  await save();
  const app = Fastify({ logger: false });
  registerArgoIngress(app, { pool, argo: config, configNow: () => config });
  const post = (payload: unknown, live = false) =>
    app.inject({
      method: 'POST',
      url: `/api/argo/sources/${scope.sourceId}/${live ? 'operations' : `archives/${archive.producerId}`}`,
      headers: {
        authorization: `Bearer ${live ? token : archiveToken}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });
  const resetRate = async () => {
    await pool.query('UPDATE argo_ingress_buckets SET tokens=10 WHERE source_id=$1', [
      scope.sourceId,
    ]);
    await pool.query('UPDATE argo_archive_buckets SET tokens=2 WHERE source_id=$1', [
      scope.sourceId,
    ]);
  };
  const enqueue = (revision = 1) =>
    repo.enqueue(owner, w.id, service.id, {
      connectionRevision: revision,
      requestId: randomUUID(),
      window: { start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' },
    });
  return {
    scope,
    archive,
    grant,
    app,
    repo,
    w: w.id,
    s: service.id,
    save,
    post,
    resetRate,
    enqueue,
    config: () => config,
    change: (next: ArgoConfig) => {
      config = next;
    },
  };
}
function signed<T extends object>(row: T) {
  return { ...row, digest: archiveRecordDigest(row) };
}
function entry(
  f: Awaited<ReturnType<typeof fixture>>,
  payload: unknown = notification(f),
  sequence = 1,
  previous = '0'.repeat(64),
  capture = new Date(Date.now() - 30000).toISOString(),
) {
  return signed({
    contract: 'clio.argocd.archive.v1',
    kind: 'entry',
    source_id: f.scope.sourceId,
    producer_id: f.archive.producerId,
    journal_id: f.archive.journalId,
    policy_reference: f.archive.policyReference,
    startup_at: '2026-01-01T00:00:00Z',
    sequence,
    previous_digest: previous,
    captured_at: capture,
    evidence_ref: 'urn:fixture:original',
    notification: payload,
  });
}
function notification(f: { scope: ReturnType<typeof grantFixture> }, id = randomUUID()) {
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

it('outage import, exact replay, unsupported payload progression and seal persist atomically', async () => {
  const f = await fixture();
  try {
    const payload = notification(f);
    const capture = payload.health.lastTransitionTime;
    const old = {
      ...payload,
      operation: {
        ...payload.operation,
        startedAt: '2026-01-02T00:00:00Z',
        finishedAt: '2026-01-02T00:01:00Z',
      },
      health: { ...payload.health, lastTransitionTime: '2026-01-02T00:01:00Z' },
    };
    const e = entry(f, old, 1, '0'.repeat(64), '2026-01-02T00:02:00Z');
    const accepted = await f.post(e);
    expect(accepted.statusCode).toBe(202);
    expect((await f.post(e)).json()).toEqual(accepted.json());
    await f.resetRate();
    const unsupported = entry(f, {}, 2, e.digest, capture);
    expect((await f.post(unsupported)).statusCode).toBe(202);
    const checkpoint = await pool.query(
      'SELECT last_sequence FROM argo_archive_journals WHERE source_id=$1',
      [f.scope.sourceId],
    );
    expect(Number(checkpoint.rows[0]?.last_sequence)).toBe(2);
    expect(
      (
        await pool.query('SELECT count(*)::int AS count FROM argo_receipts WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rows[0]?.count,
    ).toBe(1);
    expect((await f.post(old, true)).statusCode).toBe(400);
    const run = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    const saved = await f.repo.getRun(owner, f.w, f.s, run.id);
    expect(saved.result?.archiveSummary).toMatchObject({
      lastSequence: 2,
      entryCount: 2,
      gapCount: 1,
    });
    expect(saved.result?.coverage.collectionComplete).toBe(false);
  } finally {
    await f.app.close();
  }
});

function seal(
  f: Awaited<ReturnType<typeof fixture>>,
  last = 0,
  digest = '0'.repeat(64),
  first = 1,
  start = '2026-01-01T00:00:00Z',
  end = '2026-01-03T00:00:00Z',
) {
  return signed({
    contract: 'clio.argocd.archive.v1',
    kind: 'seal',
    source_id: f.scope.sourceId,
    producer_id: f.archive.producerId,
    journal_id: f.archive.journalId,
    policy_reference: f.archive.policyReference,
    startup_at: '2026-01-01T00:00:00Z',
    seal_id: randomUUID(),
    start,
    end,
    first_sequence: first,
    last_sequence: last,
    entry_count: last - first + 1,
    last_digest: digest,
    interruptions: [],
    evidence_ref: 'urn:fixture:seal',
  });
}
it('missing/divergent predecessor, future capture and invalid envelopes never advance journal', async () => {
  const f = await fixture();
  try {
    const e = entry(f);
    const missing = entry(f, e.notification, 2, e.digest);
    expect((await f.post(missing)).statusCode).toBe(409);
    const future = entry(f, e.notification, 1, '0'.repeat(64), '2099-01-01T00:00:00Z');
    expect((await f.post(future)).statusCode).toBe(409);
    await f.resetRate();
    expect((await f.post({ ...e, digest: 'f'.repeat(64) })).statusCode).toBe(400);
    expect((await f.post({ ...e, extra: true })).statusCode).toBe(400);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM argo_archive_journals WHERE source_id=$1',
          [f.scope.sourceId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    await f.resetRate();
    expect((await f.post(e)).statusCode).toBe(202);
    expect((await f.post(signed({ ...e, evidence_ref: 'divergent' }))).statusCode).toBe(409);
    expect(
      (
        await pool.query(
          'SELECT last_sequence::int AS n FROM argo_archive_journals WHERE source_id=$1',
          [f.scope.sourceId],
        )
      ).rows[0]?.n,
    ).toBe(1);
  } finally {
    await f.app.close();
  }
});
it('payload scope, temporal and metadata conflicts become gaps; later entries and seals progress', async () => {
  const f = await fixture();
  try {
    const n = notification(f),
      bad = { ...n, application: { ...n.application, project: 'foreign' } };
    const a = entry(f, bad, 1, '0'.repeat(64), '2026-01-02T00:00:00Z');
    expect((await f.post(a)).json()).toMatchObject({ gapReason: 'payload_scope', receiptId: null });
    const b = entry(f, n, 2, a.digest, '2026-01-02T00:01:00Z');
    expect((await f.post(b)).json()).toMatchObject({
      receiptId: null,
      gapReason: 'payload_temporal',
    });
    await f.resetRate();
    const c = entry(f, n, 3, b.digest);
    expect((await f.post(c)).statusCode).toBe(202);
    const changed = { ...n, operation: { ...n.operation, revision: 'conflicting' } };
    const d = entry(f, changed, 4, c.digest, new Date().toISOString());
    expect((await f.post(d)).json()).toMatchObject({
      gapReason: 'payload_metadata',
      receiptId: null,
    });
    await f.resetRate();
    const close = seal(f, 4, d.digest, 1, '2026-01-01T00:00:00Z', new Date().toISOString());
    const acknowledged = await f.post(close);
    expect(acknowledged.statusCode).toBe(202);
    expect((await f.post(close)).json()).toEqual(acknowledged.json());
    const run = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    expect((await f.repo.getRun(owner, f.w, f.s, run.id)).result?.archiveSummary).toMatchObject({
      lastSequence: 4,
      entryCount: 4,
      gapCount: 3,
      lastSuccessfulReconciliationAt: acknowledged.json().observedAt,
    });
  } finally {
    await f.app.close();
  }
});
it('delayed and empty seals cannot exclude next accepted entry; rejected seal UUID can be corrected', async () => {
  const f = await fixture();
  try {
    const first = entry(f, {}, 1, '0'.repeat(64), '2026-01-02T00:00:00Z'),
      second = entry(f, {}, 2, first.digest, '2026-01-02T01:00:00Z');
    expect((await f.post(first)).statusCode).toBe(202);
    expect((await f.post(second)).statusCode).toBe(202);
    await f.resetRate();
    const empty = seal(f);
    expect((await f.post(empty)).statusCode).toBe(409);
    const prefix = seal(f, 1, first.digest);
    expect((await f.post(prefix)).statusCode).toBe(409);
    await f.resetRate();
    const fixed = signed({ ...prefix, end: '2026-01-02T00:30:00Z' });
    expect((await f.post(fixed)).statusCode).toBe(202);
    const backdated = entry(f, {}, 3, second.digest, '2026-01-02T00:20:00Z');
    expect((await f.post(backdated)).statusCode).toBe(409);
    await f.resetRate();
    const next = seal(f, 2, second.digest, 2, '2026-01-02T00:30:00Z', '2026-01-03T00:00:00Z');
    expect((await f.post(next)).statusCode).toBe(202);
    const third = seal(f, 2, second.digest, 3, '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z');
    expect((await f.post(third)).statusCode).toBe(202);
    await f.resetRate();
    expect((await f.post(entry(f, {}, 3, second.digest, '2026-01-03T00:00:00Z'))).statusCode).toBe(
      409,
    );
  } finally {
    await f.app.close();
  }
});
it('empty genesis seals preserve incomplete coverage, interruptions and immutable old results', async () => {
  const f = await fixture();
  try {
    const empty = signed({
      ...seal(f),
      interruptions: [
        { start: '2026-01-01T01:00:00Z', end: '2026-01-01T02:00:00Z', reason: 'producer_offline' },
      ],
    });
    expect((await f.post(empty)).statusCode).toBe(202);
    const run = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    const before = await f.repo.getRun(owner, f.w, f.s, run.id);
    expect(before.result?.archiveSummary).toMatchObject({
      lastSequence: 0,
      entryCount: 0,
      gapCount: 0,
      sealedInterval: { start: empty.start, end: empty.end },
    });
    expect(before.result?.archiveSummary?.missingIntervals).toContainEqual(empty.interruptions[0]);
    expect(before.result?.coverage).toEqual({
      collectionComplete: false,
      deploymentHistoryComplete: false,
      recoveryEvidenceComplete: false,
    });
    expect((await f.post(entry(f))).statusCode).toBe(202);
    expect(await f.repo.getRun(owner, f.w, f.s, run.id)).toEqual(before);
    const later = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    expect((await f.repo.getRun(owner, f.w, f.s, later.id)).result?.retainedReceiptCount).toBe(1);
  } finally {
    await f.app.close();
  }
});
it('native-first identical archive reuses receipt and cannot downgrade into repeated-status gap', async () => {
  const f = await fixture();
  try {
    const n = notification(f),
      live = await f.post(n, true);
    expect(live.statusCode).toBe(202);
    const archived = await f.post(entry(f, n));
    expect(archived.statusCode).toBe(202);
    expect(archived.json()).toMatchObject({ receiptId: live.json().receiptId, gapReason: null });
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM argo_receipts WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rows[0]?.n,
    ).toBe(1);
    expect((await f.post(n, true)).json()).toEqual(live.json());
  } finally {
    await f.app.close();
  }
});
it('archive-first live authority has later immutable time and survives archive revocation independently', async () => {
  const f = await fixture();
  try {
    const n = notification(f),
      archived = await f.post(entry(f, n));
    expect(archived.statusCode).toBe(202);
    const prior = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    const old = await f.repo.getRun(owner, f.w, f.s, prior.id);
    const live = await f.post(n, true);
    expect(live.statusCode).toBe(202);
    expect(live.json().receiptId).toBe(archived.json().receiptId);
    expect(live.json().observedAt > archived.json().observedAt).toBe(true);
    expect((await f.post(n, true)).json()).toEqual(live.json());
    f.change({ grants: [f.grant], archives: [] });
    await f.save(1, null);
    const later = await f.enqueue(2);
    await createArgoWorker(pool, f.config()).runOnce();
    expect((await f.repo.getRun(owner, f.w, f.s, later.id)).result?.retainedReceiptCount).toBe(1);
    const stored = await pool.query(
      'SELECT evidence FROM argo_collection_snapshots WHERE run_id=$1',
      [later.id],
    );
    expect(stored.rows[0]?.evidence.deployments[0]?.observedAt).toBe(live.json().observedAt);
    expect(await f.repo.getRun(owner, f.w, f.s, prior.id)).toEqual(old);
    await expect(
      pool.query(
        'UPDATE argo_receipt_authorities SET observed_at=clock_timestamp() WHERE receipt_id=$1',
        [live.json().receiptId],
      ),
    ).rejects.toThrow('immutable');
  } finally {
    await f.app.close();
  }
});
it('archive-only revocation removes new eligibility and fences claimed snapshot completion', async () => {
  const f = await fixture();
  try {
    expect((await f.post(entry(f))).statusCode).toBe(202);
    const worker = createArgoWorker(pool, f.config(), { configNow: f.config });
    const run = await f.enqueue(),
      claim = await worker.claim();
    if (!claim) throw new Error('Missing claim');
    f.change({ grants: [f.grant], archives: [] });
    await expect(worker.complete(claim)).rejects.toThrow();
    await worker.fail(claim, 1, true);
    expect((await f.repo.getRun(owner, f.w, f.s, run.id)).failureCode).toBe(
      'argo_connection_revoked',
    );
    await f.save(1, null);
    const later = await f.enqueue(2);
    await createArgoWorker(pool, f.config()).runOnce();
    expect((await f.repo.getRun(owner, f.w, f.s, later.id)).result?.retainedReceiptCount).toBe(0);
  } finally {
    await f.app.close();
  }
});
it('native rotation before first import uses current pins; preexisting native identity becomes archive gap', async () => {
  for (const priorLive of [false, true]) {
    const f = await fixture();
    try {
      const n = notification(f);
      if (priorLive) expect((await f.post(n, true)).statusCode).toBe(202);
      const rotated = { ...f.grant, fingerprint: 'd'.repeat(64) };
      f.change({ grants: [rotated], archives: [f.archive] });
      await f.save(1);
      const response = await f.post(entry(f, n));
      expect(response.statusCode).toBe(202);
      if (priorLive) {
        expect(response.json()).toMatchObject({
          gapReason: 'cross_native_fingerprint',
          receiptId: null,
        });
      } else {
        expect(response.json().gapReason).toBeNull();
        expect(
          (
            await pool.query('SELECT grant_fingerprint FROM argo_receipts WHERE id=$1', [
              response.json().receiptId,
            ])
          ).rows[0]?.grant_fingerprint,
        ).toBe(rotated.fingerprint);
      }
      expect(
        (
          await pool.query('SELECT count(*)::int AS n FROM argo_receipts WHERE source_id=$1', [
            f.scope.sourceId,
          ])
        ).rows[0]?.n,
      ).toBe(1);
    } finally {
      await f.app.close();
    }
  }
});
it('archive pacing preserves two live tokens, sub-bucket survives rotation and exhaustion is atomic', async () => {
  const f = await fixture();
  try {
    const a = entry(f, {});
    expect((await f.post(a)).statusCode).toBe(202);
    expect((await f.post(a)).statusCode).toBe(202);
    const throttled = await f.post(a);
    expect(throttled.statusCode).toBe(503);
    expect(throttled.headers['retry-after']).toBe('4');
    await f.resetRate();
    await pool.query('UPDATE argo_ingress_buckets SET tokens=2 WHERE source_id=$1', [
      f.scope.sourceId,
    ]);
    expect((await f.post(a)).statusCode).toBe(503);
    expect((await f.post(notification(f), true)).statusCode).toBe(202);
    await f.resetRate();
    await pool.query('UPDATE argo_source_state SET retained_rows=5000 WHERE source_id=$1', [
      f.scope.sourceId,
    ]);
    const b = entry(f, notification(f), 2, a.digest);
    expect((await f.post(b)).statusCode).toBe(503);
    expect(
      (
        await pool.query(
          'SELECT last_sequence::int AS n FROM argo_archive_journals WHERE source_id=$1',
          [f.scope.sourceId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect((await f.post(a)).statusCode).toBe(202);
  } finally {
    await f.app.close();
  }
});
it('concurrent exact journal registration commits one prefix, one native anchor and one ack', async () => {
  const f = await fixture();
  try {
    const e = entry(f),
      responses = await Promise.all([f.post(e), f.post(e)]);
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202]);
    expect(responses[0]?.json()).toEqual(responses[1]?.json());
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM argo_archive_records WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rows[0]?.n,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM argo_receipts WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rows[0]?.n,
    ).toBe(1);
  } finally {
    await f.app.close();
  }
});

it('exposure before recovered anchor remains retryable; exact retry succeeds after historical import', async () => {
  const f = await fixture();
  try {
    const producer = {
      ...f.scope,
      producerId: randomUUID(),
      capability: 'consumer_exposure' as const,
      policyReference: 'urn:fixture:exposure:v1',
      repositoryIds: [],
      tokenDigest: createHash('sha256').update('e'.repeat(64)).digest('hex'),
      fingerprint: 'e'.repeat(64),
    };
    f.change({ grants: [f.grant], archives: [f.archive], producers: [producer] });
    await f.repo.save(owner, f.w, f.s, {
      expectedRevision: 1,
      sourceId: f.scope.sourceId,
      archiveProducerId: f.archive.producerId,
      enrichmentProducerIds: [producer.producerId],
      applicationOperationsBelongToService: true,
      exposurePolicyReference: null,
    });
    const n = notification(f),
      event = {
        contract: 'clio.argocd.enrichment.v1',
        kind: 'consumer_exposure',
        event_id: randomUUID(),
        source_id: f.scope.sourceId,
        producer_id: producer.producerId,
        policy_reference: producer.policyReference,
        evidence_ref: 'urn:fixture:exposure',
        application_uid: f.scope.applicationUid,
        operation_id: n.operation.info[0]?.value,
        configuration_revision: n.operation.revision,
        effective_at: n.operation.finishedAt,
        subject: { kind: 'configuration', revision: n.operation.revision },
      };
    const post = () =>
      f.app.inject({
        method: 'POST',
        url: `/api/argo/sources/${f.scope.sourceId}/enrichments/${producer.producerId}`,
        headers: { authorization: `Bearer ${'e'.repeat(64)}`, 'content-type': 'application/json' },
        payload: JSON.stringify(event),
      });
    expect((await post()).statusCode).toBe(409);
    expect((await f.post(entry(f, n))).statusCode).toBe(202);
    const accepted = await post();
    expect(accepted.statusCode).toBe(202);
    expect((await post()).json()).toEqual(accepted.json());
  } finally {
    await f.app.close();
  }
});
it('archive credential rotation preserves checkpoint and quota but removes older archive-only eligibility', async () => {
  const f = await fixture();
  try {
    const e = entry(f);
    expect((await f.post(e)).statusCode).toBe(202);
    const first = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    const before = await f.repo.getRun(owner, f.w, f.s, first.id);
    f.change({ grants: [f.grant], archives: [{ ...f.archive, fingerprint: 'f'.repeat(64) }] });
    await f.save(1);
    expect((await f.post(e)).json().archiveRecordId).toBeDefined();
    expect((await f.post(e)).statusCode).toBe(503);
    const second = await f.enqueue(2);
    await createArgoWorker(pool, f.config()).runOnce();
    const rotated = await f.repo.getRun(owner, f.w, f.s, second.id);
    expect(rotated.result?.retainedReceiptCount).toBe(0);
    expect(rotated.result?.archiveSummary).toMatchObject({ entryCount: 1, lastSequence: 1 });
    expect(await f.repo.getRun(owner, f.w, f.s, first.id)).toEqual(before);
  } finally {
    await f.app.close();
  }
});
it('valid nonrollout archive observations retain native kinds without confirming exposure', async () => {
  for (const kind of ['self_heal', 'retry', 'unknown']) {
    const f = await fixture();
    try {
      const n = notification(f),
        operation = {
          ...n.operation,
          info: n.operation.info.map((i) =>
            i.name === 'clio.operation-kind' ? { ...i, value: kind } : i,
          ),
        };
      const response = await f.post(entry(f, { ...n, operation }));
      expect(response.statusCode).toBe(202);
      expect(response.json().gapReason).toBeNull();
      const receipt = await pool.query('SELECT evidence FROM argo_receipts WHERE id=$1', [
        response.json().receiptId,
      ]);
      expect(receipt.rows[0]?.evidence.deployments[0]?.operationKind).toBe(kind);
      expect(receipt.rows[0]?.evidence.statuses[0]?.consumerExposure).toBe(false);
    } finally {
      await f.app.close();
    }
  }
});
it('shared byte exhaustion rolls back new anchor, operation lock and journal registration', async () => {
  const f = await fixture();
  try {
    await pool.query('UPDATE argo_source_state SET retained_bytes=8388608 WHERE source_id=$1', [
      f.scope.sourceId,
    ]);
    expect((await f.post(entry(f))).statusCode).toBe(503);
    for (const table of [
      'argo_archive_journals',
      'argo_archive_records',
      'argo_receipts',
      'argo_operation_metadata',
    ])
      expect(
        (
          await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE source_id=$1`, [
            f.scope.sourceId,
          ])
        ).rows[0]?.n,
      ).toBe(0);
  } finally {
    await f.app.close();
  }
});
it('configuration changes before atomic commit roll back acknowledged prefix', async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const app = Fastify({ logger: false });
    registerArgoIngress(app, {
      pool,
      argo: f.config(),
      configNow: () => {
        reads++;
        return reads >= 5 ? { grants: [f.grant], archives: [] } : f.config();
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/argo/sources/${f.scope.sourceId}/archives/${f.archive.producerId}`,
        headers: { authorization: `Bearer ${'c'.repeat(64)}`, 'content-type': 'application/json' },
        payload: JSON.stringify(entry(f)),
      });
      expect(response.statusCode).toBe(409);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM argo_archive_records WHERE source_id=$1',
            [f.scope.sourceId],
          )
        ).rows[0]?.n,
      ).toBe(0);
      expect(
        (
          await pool.query('SELECT retained_rows FROM argo_source_state WHERE source_id=$1', [
            f.scope.sourceId,
          ])
        ).rows[0]?.retained_rows,
      ).toBe(0);
    } finally {
      await app.close();
    }
  } finally {
    await f.app.close();
  }
});
it('multiple archived statuses merge one deployment while preserving distinct cutoff lineage aliases', async () => {
  const f = await fixture();
  try {
    const n = notification(f),
      a = entry(f, n),
      b = entry(f, { ...n, health: { ...n.health, status: 'Degraded' } }, 2, a.digest);
    expect((await f.post(a)).statusCode).toBe(202);
    expect((await f.post(b)).statusCode).toBe(202);
    const run = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    const saved = await f.repo.getRun(owner, f.w, f.s, run.id);
    expect(saved.status).toBe('succeeded');
    expect(saved.result?.retainedEvidenceCount).toBe(4);
    const stored = await pool.query(
      'SELECT evidence FROM argo_collection_snapshots WHERE run_id=$1',
      [run.id],
    );
    expect(stored.rows[0]?.evidence.deployments).toHaveLength(1);
    expect(stored.rows[0]?.evidence.statuses).toHaveLength(2);
    expect(stored.rows[0]?.evidence.argoArchiveLineages).toHaveLength(2);
  } finally {
    await f.app.close();
  }
});
it('migration preserves prior live receipts without new authority rows or lifetime budget changes', async () => {
  const legacySchema = `clio_test_${randomUUID().replaceAll('-', '')}`,
    legacy = new Pool({
      connectionString,
      options: `-c search_path=${legacySchema}`,
      statement_timeout: 10000,
    });
  let made = false;
  const app = Fastify({ logger: false });
  try {
    await admin.query(`CREATE SCHEMA "${legacySchema}"`);
    made = true;
    const migrations = await loadMigrations();
    await migrate(
      legacy,
      migrations.filter((m) => m.name < '0010_'),
    );
    const scope = grantFixture(),
      token = 'b'.repeat(64),
      grant = {
        ...scope,
        tokenDigest: createHash('sha256').update(token).digest('hex'),
        fingerprint: 'b'.repeat(64),
      };
    await legacy.query("INSERT INTO workspaces(id,name) VALUES($1,'legacy')", [scope.workspaceId]);
    await legacy.query("INSERT INTO services(id,workspace_id,name) VALUES($1,$2,'legacy')", [
      scope.serviceId,
      scope.workspaceId,
    ]);
    await legacy.query(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES('legacy','legacy','legacy@example.com',true)",
    );
    const connection = {
      workspaceId: scope.workspaceId,
      serviceId: scope.serviceId,
      sourceId: scope.sourceId,
      applicationName: scope.applicationName,
      applicationNamespace: scope.applicationNamespace,
      instance: scope.instance,
      productionEnvironment: scope.environment,
      mode: 'live',
      provider: 'argocd',
      revision: 1,
      active: true,
      exposurePolicyReference: null,
      applicationOperationsBelongToService: true,
      observedAt: '2026-01-01T00:00:00Z',
    };
    await legacy.query(
      "INSERT INTO argo_connection_revisions(workspace_id,service_id,revision,connection,grant_fingerprint,scope,created_by) VALUES($1,$2,1,$3,$4,$5,'legacy')",
      [
        scope.workspaceId,
        scope.serviceId,
        JSON.stringify(connection),
        grant.fingerprint,
        JSON.stringify(scope),
      ],
    );
    await legacy.query(
      'INSERT INTO argo_source_state(source_id,workspace_id,service_id,retained_rows,retained_bytes,first_observed_at) VALUES($1,$2,$3,3,1000,$4)',
      [scope.sourceId, scope.workspaceId, scope.serviceId, '2026-01-02T00:02:00Z'],
    );
    const base = notification({ scope }),
      payload = {
        ...base,
        operation: {
          ...base.operation,
          startedAt: '2026-01-02T00:00:00Z',
          finishedAt: '2026-01-02T00:01:00Z',
        },
        health: { ...base.health, lastTransitionTime: '2026-01-02T00:01:00Z' },
      },
      observed = '2026-01-02T00:02:00Z',
      parsed = parseArgoNotification(payload, scope, observed),
      id = randomUUID();
    if (parsed.kind !== 'operation') throw new Error('Expected historical native fixture');
    await legacy.query(
      'INSERT INTO argo_receipts(id,source_id,workspace_id,service_id,connection_revision,application_uid,grant_fingerprint,scope,digest,observed_at,started_at,operation_id,notification_revision,phase,health,canonical_json,evidence) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [
        id,
        scope.sourceId,
        scope.workspaceId,
        scope.serviceId,
        scope.applicationUid,
        grant.fingerprint,
        JSON.stringify(scope),
        argoNotificationDigest(payload, scope),
        observed,
        parsed.startedAt,
        parsed.operationId,
        parsed.notificationRevision,
        parsed.phase,
        parsed.health,
        parsed.canonicalJson,
        JSON.stringify(parsed.evidence),
      ],
    );
    await migrate(legacy, migrations);
    registerArgoIngress(app, { pool: legacy, argo: { grants: [grant] } });
    const response = await app.inject({
      method: 'POST',
      url: `/api/argo/sources/${scope.sourceId}/operations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ receiptId: id, observedAt: '2026-01-02T00:02:00.000000Z' });
    expect(
      (await legacy.query('SELECT retained_rows,retained_bytes FROM argo_source_state')).rows,
    ).toEqual([{ retained_rows: 3, retained_bytes: 1000 }]);
    expect(
      (await legacy.query('SELECT count(*)::int AS n FROM argo_receipt_authorities')).rows[0]?.n,
    ).toBe(0);
  } finally {
    await app.close();
    await legacy.end();
    if (made) await admin.query(`DROP SCHEMA "${legacySchema}" CASCADE`);
  }
});
it('valid-envelope wrong chain/scope conflicts do not advance; unsupported identity and late capture become retained gaps', async () => {
  const f = await fixture();
  try {
    const n = notification(f),
      first = entry(f, { ...n, operation: { ...n.operation, info: [] } });
    expect((await f.post(first)).json()).toMatchObject({
      receiptId: null,
      gapReason: 'unmarked_operation',
    });
    const wrong = entry(f, {}, 2, '0'.repeat(64));
    expect((await f.post(wrong)).statusCode).toBe(409);
    await f.resetRate();
    const scoped = signed({ ...entry(f, {}, 2, first.digest), journal_id: randomUUID() });
    expect((await f.post(scoped)).statusCode).toBe(409);
    const old = {
        ...n,
        operation: {
          ...n.operation,
          startedAt: '2026-01-02T00:00:00Z',
          finishedAt: '2026-01-02T00:01:00Z',
        },
        health: { ...n.health, lastTransitionTime: '2026-01-02T00:01:00Z' },
      },
      late = entry(f, old, 2, first.digest, new Date().toISOString());
    const accepted = await f.post(late);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ receiptId: null, gapReason: 'payload_temporal' });
    expect(
      (
        await pool.query(
          'SELECT last_sequence::int AS n FROM argo_archive_journals WHERE source_id=$1',
          [f.scope.sourceId],
        )
      ).rows[0]?.n,
    ).toBe(2);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM argo_receipts WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rows[0]?.n,
    ).toBe(0);
  } finally {
    await f.app.close();
  }
});
it('archive-first then native rotation cannot mint independent live authority under different fingerprint', async () => {
  const f = await fixture();
  try {
    const n = notification(f),
      a = entry(f, n);
    expect((await f.post(a)).statusCode).toBe(202);
    f.change({ grants: [{ ...f.grant, fingerprint: 'd'.repeat(64) }], archives: [f.archive] });
    await f.save(1);
    expect((await f.post(n, true)).statusCode).toBe(409);
    const b = entry(f, n, 2, a.digest);
    expect((await f.post(b)).json()).toMatchObject({
      receiptId: null,
      gapReason: 'cross_native_fingerprint',
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM argo_receipt_authorities a JOIN argo_receipts r ON r.id=a.receipt_id WHERE r.source_id=$1 AND a.kind='live'",
          [f.scope.sourceId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  } finally {
    await f.app.close();
  }
});
it('historical import recovers after earlier stale live gap without rewriting retained gap or native identity index', async () => {
  const f = await fixture();
  try {
    const base = notification(f),
      payload = {
        ...base,
        operation: {
          ...base.operation,
          startedAt: '2026-01-02T00:00:00Z',
          finishedAt: '2026-01-02T00:01:00Z',
        },
        health: { ...base.health, lastTransitionTime: '2026-01-02T00:01:00Z' },
      };
    const live = await f.post(payload, true);
    expect(live.statusCode).toBe(202);
    const a = entry(f, payload, 1, '0'.repeat(64), '2026-01-02T00:02:00Z'),
      archived = await f.post(a);
    expect(archived.statusCode).toBe(202);
    expect(archived.json().gapReason).toBeNull();
    expect(archived.json().receiptId).not.toBe(live.json().receiptId);
    const receipts = await pool.query(
      'SELECT id,reason,evidence FROM argo_receipts WHERE source_id=$1',
      [f.scope.sourceId],
    );
    expect(receipts.rows.find((r) => r.id === live.json().receiptId)?.reason).toBe(
      'observation_horizon',
    );
    expect(receipts.rows.filter((r) => r.evidence !== null)).toHaveLength(1);
    const b = entry(f, payload, 2, a.digest, '2026-01-02T00:03:00Z');
    expect((await f.post(b)).json()).toMatchObject({
      receiptId: archived.json().receiptId,
      gapReason: null,
    });
    const run = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    expect((await f.repo.getRun(owner, f.w, f.s, run.id)).result).toMatchObject({
      deploymentCount: 1,
      recordedGapCount: 1,
      archiveSummary: { gapCount: 0, entryCount: 2 },
    });
  } finally {
    await f.app.close();
  }
});
it('current-grant fence also applies to exact persisted archive replays before acknowledgement', async () => {
  const f = await fixture();
  try {
    const e = entry(f),
      first = await f.post(e);
    expect(first.statusCode).toBe(202);
    let reads = 0;
    const app = Fastify({ logger: false });
    registerArgoIngress(app, {
      pool,
      argo: f.config(),
      configNow: () => {
        reads++;
        return reads >= 5 ? { grants: [f.grant], archives: [] } : f.config();
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/argo/sources/${f.scope.sourceId}/archives/${f.archive.producerId}`,
        headers: { authorization: `Bearer ${'c'.repeat(64)}`, 'content-type': 'application/json' },
        payload: JSON.stringify(e),
      });
      expect(response.statusCode).toBe(409);
      expect(
        (
          await pool.query('SELECT id FROM argo_archive_records WHERE source_id=$1', [
            f.scope.sourceId,
          ])
        ).rows,
      ).toEqual([{ id: first.json().archiveRecordId }]);
    } finally {
      await app.close();
    }
  } finally {
    await f.app.close();
  }
});
it('existing archive journal cannot be rebound to another native scope', async () => {
  const f = await fixture();
  try {
    expect((await f.post(seal(f))).statusCode).toBe(202);
    f.change({
      grants: [{ ...f.grant, environment: 'staging', fingerprint: 'd'.repeat(64) }],
      archives: [{ ...f.archive, environment: 'staging', fingerprint: 'e'.repeat(64) }],
    });
    await expect(f.save(1)).rejects.toMatchObject({ status: 409 });
    const next = { ...seal(f), start: '2026-01-03T00:00:00Z', end: '2026-01-04T00:00:00Z' };
    next.digest = archiveRecordDigest(next);
    const response = await f.post(next);
    expect(response.statusCode).toBe(409);
    expect(
      Number(
        (
          await pool.query(
            'SELECT count(*) AS count FROM argo_archive_records WHERE source_id=$1',
            [f.scope.sourceId],
          )
        ).rows[0]?.count,
      ),
    ).toBe(1);
  } finally {
    await f.app.close();
  }
});
it('unsupported archive observations remain counted gaps without invented missing duration', async () => {
  const f = await fixture();
  try {
    const n = notification(f);
    expect(
      (await f.post(entry(f, { ...n, operation: { ...n.operation, phase: 'Running' } })))
        .statusCode,
    ).toBe(202);
    const run = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    const saved = await f.repo.getRun(owner, f.w, f.s, run.id);
    expect(saved.status).toBe('succeeded');
    expect(saved.result?.archiveSummary?.gapCount).toBe(1);
    for (const interval of saved.result?.archiveSummary?.missingIntervals ?? [])
      expect(Date.parse(interval.start)).toBeLessThan(Date.parse(interval.end));
  } finally {
    await f.app.close();
  }
});

// Controlled durable producer -> authenticated API -> PostgreSQL -> immutable OEMS capture.
import {
  chmod as journalChmod,
  mkdtemp as journalMkdtemp,
  realpath as journalRealpath,
  rm as journalRemove,
  writeFile as journalWrite,
} from 'node:fs/promises';
import { tmpdir as journalTmpdir } from 'node:os';
import { join as journalJoin } from 'node:path';
import {
  appendJournal,
  drainJournal,
  initJournal,
  sealJournal,
  statusJournal,
} from '../../../infra/argocd/journal/journal.ts';

it('durable producer survives receiver outage and lost committed acknowledgement without changing old snapshot', async () => {
  const f = await fixture();
  const directoryRoot = await journalMkdtemp(
    journalJoin(await journalRealpath(journalTmpdir()), 'clio-archive-proof-'),
  );
  await journalChmod(directoryRoot, 0o700);
  const directory = journalJoin(directoryRoot, 'journal');
  const tokenFile = journalJoin(directoryRoot, 'archive.token');
  try {
    await journalWrite(tokenFile, 'c'.repeat(64), { mode: 0o600 });
    await initJournal(directory, {
      sourceId: f.scope.sourceId,
      producerId: f.archive.producerId,
      journalId: f.archive.journalId,
      policyReference: f.archive.policyReference,
      fictional: true,
      startupAt: '2026-01-01T00:00:00Z',
    });
    const n = notification(f);
    const original = {
      ...n,
      operation: {
        ...n.operation,
        startedAt: '2026-01-02T00:00:00Z',
        finishedAt: '2026-01-02T00:01:00Z',
      },
      health: { ...n.health, lastTransitionTime: '2026-01-02T00:01:00Z' },
    };
    await appendJournal(directory, {
      notification: original,
      evidenceRef: 'urn:fixture:retained-before-delivery',
      capturedAt: '2026-01-02T00:02:00Z',
    });
    await sealJournal(directory, {
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-03T00:00:00Z',
      evidenceRef: 'urn:fixture:sealed-prefix',
    });
    const baseOptions = { baseUrl: 'http://127.0.0.1:3000', tokenFile, env: {}, maxWaitMs: 5000 };
    const outage = await drainJournal(directory, {
      ...baseOptions,
      maxAttempts: 1,
      fetcher: async () => {
        throw new Error('controlled receiver outage');
      },
    });
    expect(outage.acknowledgedRecords).toBe(0);
    expect((await statusJournal(directory)).retainedRecords).toBe(2);
    const beforeRun = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    const before = await f.repo.getRun(owner, f.w, f.s, beforeRun.id);
    expect(before.result?.deploymentCount).toBe(0);
    const beforeJson = JSON.stringify(before);
    let loseAcknowledgement = true;
    const bodies: string[] = [];
    const replay = await drainJournal(directory, {
      ...baseOptions,
      maxAttempts: 4,
      fetcher: async (_url, options) => {
        if (typeof options?.body !== 'string') throw new Error('Expected exact journal body');
        bodies.push(options.body);
        const response = await f.app.inject({
          method: 'POST',
          url: `/api/argo/sources/${f.scope.sourceId}/archives/${f.archive.producerId}`,
          headers: {
            authorization: 'Bearer ' + 'c'.repeat(64),
            'content-type': 'application/json',
          },
          payload: options.body,
        });
        if (loseAcknowledgement && response.statusCode === 202) {
          loseAcknowledgement = false;
          throw new Error('controlled lost committed acknowledgement');
        }
        return new Response(response.body, {
          status: response.statusCode,
          headers:
            response.headers['retry-after'] === undefined
              ? {}
              : { 'retry-after': String(response.headers['retry-after']) },
        });
      },
    });
    expect(replay.acknowledgedRecords).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect((await statusJournal(directory)).retainedRecords).toBe(2);
    expect(
      Number(
        (
          await pool.query('SELECT count(*) AS count FROM argo_receipts WHERE source_id=$1', [
            f.scope.sourceId,
          ])
        ).rows[0]?.count,
      ),
    ).toBe(1);
    const afterRun = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    const after = await f.repo.getRun(owner, f.w, f.s, afterRun.id);
    expect(after.result?.deploymentCount).toBe(1);
    expect(after.result?.archiveSummary).toMatchObject({
      entryCount: 1,
      lastSequence: 1,
      gapCount: 0,
      sealedInterval: { start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' },
    });
    expect(after.result?.coverage).toEqual({
      collectionComplete: false,
      deploymentHistoryComplete: false,
      recoveryEvidenceComplete: false,
    });
    expect(JSON.stringify(await f.repo.getRun(owner, f.w, f.s, beforeRun.id))).toBe(beforeJson);
  } finally {
    await f.app.close();
    await journalRemove(directoryRoot, { recursive: true, force: true });
  }
}, 25000);
it('seal interruption summaries reserve serialized snapshot headroom before admission', async () => {
  const f = await fixture();
  try {
    const record = seal(f);
    const interruptions = Array.from({ length: 32 }, (_, index) => ({
      start: new Date(Date.parse('2026-01-01T00:00:00Z') + index * 2000).toISOString(),
      end: new Date(Date.parse('2026-01-01T00:00:00Z') + index * 2000 + 1000).toISOString(),
      reason: 'x'.repeat(200),
    }));
    const large = { ...record, interruptions };
    large.digest = archiveRecordDigest(large);
    const size = Number(
      (await pool.query('SELECT octet_length($1::jsonb::text) AS size', [JSON.stringify(large)]))
        .rows[0]?.size,
    );
    await pool.query('UPDATE argo_source_state SET retained_bytes=$2 WHERE source_id=$1', [
      f.scope.sourceId,
      8388608 - size - 6500,
    ]);
    expect((await f.post(large)).statusCode).toBe(503);
    expect(
      Number(
        (
          await pool.query(
            'SELECT count(*) AS count FROM argo_archive_records WHERE source_id=$1',
            [f.scope.sourceId],
          )
        ).rows[0]?.count,
      ),
    ).toBe(0);
  } finally {
    await f.app.close();
  }
});
it.each(['\u0000', '\ud800', '\udfff'])(
  'rejects incompatible Unicode before database admission: %s',
  async (unsafe) => {
    const f = await fixture();
    try {
      const raw: Record<string, unknown> = { ...entry(f, 'original'), notification: unsafe };
      delete raw.digest;
      const canonical = `{${Object.keys(raw)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${JSON.stringify(raw[key])}`)
        .join(',')}}`;
      const payload = { ...raw, digest: createHash('sha256').update(canonical).digest('hex') };
      expect((await f.post(payload)).statusCode).toBe(400);
      expect(
        Number(
          (
            await pool.query(
              'SELECT count(*) AS count FROM argo_archive_records WHERE source_id=$1',
              [f.scope.sourceId],
            )
          ).rows[0]?.count,
        ),
      ).toBe(0);
      expect(
        Number(
          (
            await pool.query(
              'SELECT count(*) AS count FROM argo_archive_journals WHERE source_id=$1',
              [f.scope.sourceId],
            )
          ).rows[0]?.count,
        ),
      ).toBe(0);
    } finally {
      await f.app.close();
    }
  },
);

// A controlled Kubernetes transport plus a real stalled loopback receiver exercise
// acquisition through durable files, authenticated admission and immutable results.
import { createServer as captureServer } from 'node:http';
import type { CaptureConfig } from '../../../infra/argocd/capture/config.ts';
import { runCapture } from '../../../infra/argocd/capture/run.ts';

it('continuous capture retains changing operation during stalled delivery, then reconciles PostgreSQL without changing old result', async () => {
  const f = await fixture();
  const root = await journalMkdtemp(
    journalJoin(await journalRealpath(journalTmpdir()), 'clio-watch-db-'),
  );
  await journalChmod(root, 0o700);
  let markRequest: () => void = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    markRequest = resolve;
  });
  let releaseRequest: () => void = () => {};
  const receiverReleased = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const server = captureServer(async (request, response) => {
    request.resume();
    markRequest();
    await receiverReleased;
    response.writeHead(503);
    response.end();
  });
  const stop = new AbortController();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('capture_listener');
    const tokenFile = journalJoin(root, 'archive.token');
    const kubeconfig = journalJoin(root, 'trusted-fixture.kubeconfig');
    await journalWrite(tokenFile, 'c'.repeat(64), { mode: 0o600 });
    await journalWrite(kubeconfig, '{}', { mode: 0o600 });
    const directory = journalJoin(root, 'journal');
    await initJournal(directory, {
      sourceId: f.scope.sourceId,
      producerId: f.archive.producerId,
      journalId: f.archive.journalId,
      policyReference: f.archive.policyReference,
    });
    const config: CaptureConfig = {
      journalDirectory: directory,
      kubectlPath: process.execPath,
      kubeconfig,
      context: 'controlled-fixture',
      scope: f.scope,
      producerId: f.archive.producerId,
      journalId: f.archive.journalId,
      policyReference: f.archive.policyReference,
      receiver: { baseUrl: `http://127.0.0.1:${address.port}`, tokenFile },
    };
    const n = notification(f);
    const application = (version: string, phase: string) => ({
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: {
        uid: f.scope.applicationUid,
        name: f.scope.applicationName,
        namespace: f.scope.applicationNamespace,
        resourceVersion: version,
      },
      spec: {
        project: f.scope.project,
        source: { repoURL: f.scope.repoURL },
        destination: { server: f.scope.destinationServer, namespace: f.scope.destinationNamespace },
      },
      status: {
        operationState: {
          phase,
          startedAt: n.operation.startedAt,
          ...(phase === 'Succeeded' ? { finishedAt: n.operation.finishedAt } : {}),
          operation: { info: n.operation.info, initiatedBy: n.operation.initiatedBy },
          syncResult: { revision: n.operation.revision, revisions: [] },
        },
        health: n.health,
      },
    });
    const beforeRun = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    const before = JSON.stringify(await f.repo.getRun(owner, f.w, f.s, beforeRun.id));
    const progress = await runCapture(config, {
      signal: stop.signal,
      env: {},
      progress(value) {
        if (value.captured >= 2) {
          stop.abort();
          releaseRequest();
        }
      },
      transport: {
        list: async () => ({
          apiVersion: 'argoproj.io/v1alpha1',
          kind: 'ApplicationList',
          metadata: { resourceVersion: 'opaque-1' },
          items: [application('opaque-1', 'Running')],
        }),
        async *watch() {
          await requestStarted;
          // The real HTTP request remains blocked while this durable append runs.
          yield { type: 'MODIFIED', object: application('opaque-2', 'Succeeded') };
        },
      },
    });
    expect(progress.captured).toBe(2);
    expect(await statusJournal(directory)).toMatchObject({ entries: 2, acknowledgedRecords: 0 });
    let loseAck = true;
    const bodies: string[] = [];
    const replay = await drainJournal(directory, {
      ...config.receiver,
      env: {},
      maxAttempts: 12,
      sleep: async () => {},
      fetcher: async (_url, options) => {
        if (typeof options?.body !== 'string') throw new Error('capture_body');
        bodies.push(options.body);
        await f.resetRate();
        const response = await f.post(JSON.parse(options.body));
        if (loseAck && response.statusCode === 202) {
          loseAck = false;
          throw new Error('controlled lost acknowledgement');
        }
        return new Response(response.body, { status: response.statusCode });
      },
    });
    expect(replay.pendingRecords).toBe(0);
    expect(bodies[0]).toBe(bodies[1]);
    const afterRun = await f.enqueue();
    await createArgoWorker(pool, f.config()).runOnce();
    const after = await f.repo.getRun(owner, f.w, f.s, afterRun.id);
    expect(after.result?.deploymentCount).toBe(1);
    expect(after.result?.archiveSummary).toMatchObject({ entryCount: 2, lastSequence: 2 });
    expect(after.result?.coverage).toEqual({
      collectionComplete: false,
      deploymentHistoryComplete: false,
      recoveryEvidenceComplete: false,
    });
    expect(JSON.stringify(await f.repo.getRun(owner, f.w, f.s, beforeRun.id))).toBe(before);
  } finally {
    stop.abort();
    releaseRequest();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await f.app.close();
    await journalRemove(root, { recursive: true, force: true });
  }
}, 25000);

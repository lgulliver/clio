import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  artifactDigest,
  buildPolicy,
  captureBaseline,
  exposurePolicy,
  observeArtifact,
  provenanceEvent,
} from '../../../infra/argocd/evidence-demo/producers.ts';
import { loadMigrations, migrate } from '../src/db/migrations.ts';
import {
  type ArgoConfig,
  type ArgoProducerGrant,
  digest,
} from '../src/features/argo-collection/config.ts';
import { acceptEnrichment } from '../src/features/argo-collection/enrichment-ingress.ts';
import { registerArgoIngress } from '../src/features/argo-collection/ingress.ts';
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
async function fixture(sandboxPolicies = false) {
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
  const exposure = {
    ...scope,
    producerId: randomUUID(),
    capability: 'consumer_exposure' as const,
    policyReference: sandboxPolicies ? exposurePolicy : 'urn:fixture:exposure:v1',
    repositoryIds: [],
    tokenDigest: digest('c'.repeat(64)),
    fingerprint: digest(randomUUID()),
  };
  const build = {
    ...scope,
    producerId: randomUUID(),
    capability: 'application_provenance' as const,
    policyReference: sandboxPolicies ? buildPolicy : 'urn:fixture:build:v1',
    repositoryIds: ['github:fixture/app'],
    tokenDigest: digest('d'.repeat(64)),
    fingerprint: digest(randomUUID()),
  };
  const config: ArgoConfig = { grants: [grant], producers: [exposure, build] },
    repo = createArgoRepository(pool, config);
  const save = (expectedRevision: number | null = null) =>
    repo.save(owner, w.id, s.id, {
      expectedRevision,
      sourceId: scope.sourceId,
      applicationOperationsBelongToService: true,
      exposurePolicyReference: 'urn:fixture:policy:v1',
      enrichmentProducerIds: [exposure.producerId, build.producerId],
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
  const enrich = (
    payload: unknown,
    producer: ArgoProducerGrant = exposure,
    credential = producer === exposure ? 'c'.repeat(64) : 'd'.repeat(64),
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/argo/sources/${scope.sourceId}/enrichments/${producer.producerId}`,
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  return {
    w: w.id,
    s: s.id,
    scope,
    config,
    repo,
    app,
    post,
    save,
    enqueue,
    enrich,
    exposure,
    build,
    grant,
  };
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
const artifact = `sha256:${'e'.repeat(64)}`;
function exposureEvent(
  f: Awaited<ReturnType<typeof fixture>>,
  native: ReturnType<typeof notification>,
) {
  return {
    contract: 'clio.argocd.enrichment.v1',
    event_id: randomUUID(),
    source_id: f.scope.sourceId,
    producer_id: f.exposure.producerId,
    policy_reference: f.exposure.policyReference,
    evidence_ref: 'urn:fictional:traffic',
    kind: 'consumer_exposure' as const,
    application_uid: f.scope.applicationUid,
    operation_id: native.operation.info[0]?.value,
    configuration_revision: native.operation.revision,
    effective_at: native.operation.finishedAt,
    subject: { kind: 'artifact' as const, digest: artifact },
  };
}
function buildEvent(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    contract: 'clio.argocd.enrichment.v1',
    event_id: randomUUID(),
    source_id: f.scope.sourceId,
    producer_id: f.build.producerId,
    policy_reference: f.build.policyReference,
    evidence_ref: 'urn:fictional:build',
    kind: 'application_provenance' as const,
    repository_id: 'github:fixture/app',
    commit_sha: 'f'.repeat(40),
    artifact_digest: artifact,
  };
}
it('auth before parse, capability misuse, exact replay and changed content conflicts', async () => {
  const f = await fixture();
  try {
    expect((await f.enrich('{', f.exposure, 'wrong')).statusCode).toBe(401);
    expect((await f.enrich('{')).statusCode).toBe(400);
    expect((await f.enrich(' '.repeat(65537))).statusCode).toBe(400);
    const build = buildEvent(f);
    expect(
      (
        await f.enrich({
          ...build,
          producer_id: f.exposure.producerId,
          policy_reference: f.exposure.policyReference,
        })
      ).statusCode,
    ).toBe(400);
    const first = await f.enrich(build, f.build);
    expect(first.statusCode).toBe(202);
    expect((await f.enrich(build, f.build)).json()).toEqual(first.json());
    expect((await f.enrich({ ...build, commit_sha: 'a'.repeat(40) }, f.build)).statusCode).toBe(
      409,
    );
    const privateJson = JSON.stringify((await f.repo.get(member, f.w, f.s)).connection);
    expect(privateJson).not.toContain(f.build.fingerprint);
    expect(privateJson).not.toContain('tokenDigest');
    await f.repo.disconnect(owner, f.w, f.s, { expectedRevision: 1 });
    expect((await f.enrich(build, f.build)).statusCode).toBe(409);
  } finally {
    await f.app.close();
  }
});
it('missing anchors retry original event; Failed/Degraded rollout accepts exact exposure and temporal bounds reject', async () => {
  const f = await fixture();
  try {
    const native = notification(f);
    native.operation.phase = 'Failed';
    native.health.status = 'Degraded';
    const event = exposureEvent(f, native);
    const missing = await f.enrich(event);
    expect(missing.statusCode).toBe(409);
    expect(missing.headers['retry-after']).toBe('2');
    expect((await f.post(native)).statusCode).toBe(202);
    expect(
      (
        await f.enrich({
          ...event,
          event_id: randomUUID(),
          effective_at: new Date(Date.now() + 60000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.enrich({
          ...event,
          event_id: randomUUID(),
          effective_at: new Date(Date.parse(native.operation.startedAt) - 1000).toISOString(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await f.enrich({ ...event, configuration_revision: 'wrong', event_id: randomUUID() }))
        .statusCode,
    ).toBe(409);
    expect((await f.enrich(event)).statusCode).toBe(202);
    const changed = {
      ...event,
      event_id: randomUUID(),
      subject: { kind: 'configuration', revision: native.operation.revision },
    };
    const conflict = await f.enrich(changed);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.headers['retry-after']).toBeUndefined();
    const nonrollout = notification(f);
    nonrollout.operation.info[1] = { name: 'clio.operation-kind', value: 'retry' };
    expect((await f.post(nonrollout)).statusCode).toBe(202);
    expect((await f.enrich(exposureEvent(f, nonrollout))).statusCode).toBe(409);
  } finally {
    await f.app.close();
  }
});
it('concurrent conflicting provenance and subjects atomically accept one; agreeing assertions and replay reserve no lock rows', async () => {
  const f = await fixture();
  try {
    const build = buildEvent(f);
    const replies = await Promise.all([
      f.enrich(build, f.build),
      f.enrich({ ...build, event_id: randomUUID(), commit_sha: 'a'.repeat(40) }, f.build),
    ]);
    expect(replies.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    expect(
      (
        await pool.query('SELECT * FROM argo_enrichment_artifacts WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rowCount,
    ).toBe(1);
    const native = notification(f);
    expect((await f.post(native)).statusCode).toBe(202);
    const exposure = exposureEvent(f, native);
    const subjects = await Promise.all([
      f.enrich(exposure),
      f.enrich({
        ...exposure,
        event_id: randomUUID(),
        subject: { kind: 'artifact', digest: `sha256:${'a'.repeat(64)}` },
      }),
    ]);
    expect(subjects.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    const winner =
      subjects[0]?.statusCode === 202
        ? exposure
        : {
            ...exposure,
            subject: { kind: 'artifact' as const, digest: `sha256:${'a'.repeat(64)}` },
          };
    expect((await f.enrich({ ...winner, event_id: randomUUID() })).statusCode).toBe(202);
    expect(
      (
        await pool.query('SELECT retained_rows FROM argo_source_state WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rows[0]?.retained_rows,
    ).toBe(8);
    expect(
      (
        await pool.query('SELECT * FROM argo_enrichment_subjects WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    await f.app.close();
  }
});
it('shared lifetime budget exhausts both ingress kinds, leaves no locks, authorized replay survives exhaustion', async () => {
  const f = await fixture();
  try {
    const build = buildEvent(f),
      first = await f.enrich(build, f.build);
    expect(first.statusCode).toBe(202);
    await pool.query('UPDATE argo_source_state SET retained_rows=5000 WHERE source_id=$1', [
      f.scope.sourceId,
    ]);
    expect(
      (
        await f.enrich(
          { ...build, event_id: randomUUID(), artifact_digest: `sha256:${'a'.repeat(64)}` },
          f.build,
        )
      ).statusCode,
    ).toBe(503);
    expect((await f.post(notification(f))).statusCode).toBe(503);
    expect((await f.enrich(build, f.build)).json()).toEqual(first.json());
    expect(
      (
        await pool.query('SELECT * FROM argo_enrichment_artifacts WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rowCount,
    ).toBe(1);
    await f.repo.disconnect(owner, f.w, f.s, { expectedRevision: 1 });
  } finally {
    await f.app.close();
  }
});
it('native and enrichment producers consume same ingress bucket before malformed JSON parsing', async () => {
  const f = await fixture();
  try {
    expect((await f.post(notification(f))).statusCode).toBe(202);
    await pool.query(
      'UPDATE argo_ingress_buckets SET tokens=0,refilled_at=clock_timestamp() WHERE source_id=$1',
      [f.scope.sourceId],
    );
    const enrichment = await f.enrich('{');
    expect(enrichment.statusCode).toBe(503);
    expect(enrichment.headers['retry-after']).toBe('2');
    expect((await f.post('{')).statusCode).toBe(503);
  } finally {
    await f.app.close();
  }
});
it('rotations fence replay/jobs, preserve lifetime locks; native fingerprint rotation invalidates old anchors', async () => {
  const f = await fixture();
  try {
    const native = notification(f);
    expect((await f.post(native)).statusCode).toBe(202);
    const event = exposureEvent(f, native);
    expect((await f.enrich(event)).statusCode).toBe(202);
    const run = await f.enqueue();
    const rotated = { ...f.exposure, fingerprint: digest(randomUUID()) };
    const config = { ...f.config, producers: [rotated, f.build] };
    const worker = createArgoWorker(pool, f.config, { configNow: () => config });
    await worker.runOnce();
    expect((await f.repo.getRun(member, f.w, f.s, run.id)).failureCode).toBe(
      'argo_connection_revoked',
    );
    const repo = createArgoRepository(pool, config);
    await repo.save(owner, f.w, f.s, {
      expectedRevision: 1,
      sourceId: f.scope.sourceId,
      applicationOperationsBelongToService: true,
      exposurePolicyReference: null,
      enrichmentProducerIds: [rotated.producerId, f.build.producerId],
    });
    await expect(acceptEnrichment(pool, rotated, event, () => config)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      acceptEnrichment(
        pool,
        rotated,
        {
          ...event,
          event_id: randomUUID(),
          subject: { kind: 'configuration', revision: native.operation.revision },
        },
        () => config,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await acceptEnrichment(pool, rotated, { ...event, event_id: randomUUID() }, () => config),
    ).toHaveProperty('receiptId');
    const nativeRotated = { ...f.grant, fingerprint: digest(randomUUID()) };
    const nativeConfig = { ...config, grants: [nativeRotated] };
    const nativeRepo = createArgoRepository(pool, nativeConfig);
    await nativeRepo.save(owner, f.w, f.s, {
      expectedRevision: 2,
      sourceId: f.scope.sourceId,
      applicationOperationsBelongToService: true,
      exposurePolicyReference: null,
      enrichmentProducerIds: [rotated.producerId, f.build.producerId],
    });
    await expect(
      acceptEnrichment(pool, rotated, { ...event, event_id: randomUUID() }, () => nativeConfig),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await pool.query('SELECT * FROM argo_enrichment_subjects WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    await f.app.close();
  }
});
it('snapshot cutoff includes separate enrichment evidence, late provenance enriches next result only; native JSON never mutates', async () => {
  const f = await fixture();
  try {
    const native = notification(f);
    expect((await f.post(native)).statusCode).toBe(202);
    const exposure = exposureEvent(f, native);
    expect((await f.enrich(exposure)).statusCode).toBe(202);
    const first = await f.enqueue();
    await createArgoWorker(pool, f.config).runOnce();
    const saved = await f.repo.getRun(member, f.w, f.s, first.id);
    expect(saved.result).toMatchObject({
      qualifyingCount: 1,
      enrichmentSummary: { consumerExposureCount: 1, applicationProvenanceCount: 0 },
      coverage: {
        collectionComplete: false,
        deploymentHistoryComplete: false,
        recoveryEvidenceComplete: false,
      },
      changeFailureRate: null,
      failedDeploymentRecoveryTime: null,
    });
    const build = buildEvent(f);
    expect((await f.enrich(build, f.build)).statusCode).toBe(202);
    const next = await f.enqueue();
    await createArgoWorker(pool, f.config).runOnce();
    expect((await f.repo.getRun(member, f.w, f.s, next.id)).result).toMatchObject({
      qualifyingCount: 1,
      enrichmentSummary: { consumerExposureCount: 1, applicationProvenanceCount: 1 },
    });
    expect((await f.repo.getRun(member, f.w, f.s, first.id)).result).toEqual(saved.result);
    const snapshot = (
      await pool.query(
        'SELECT evidence,snapshot,metrics FROM argo_collection_snapshots WHERE run_id=$1',
        [next.id],
      )
    ).rows[0];
    expect(snapshot?.evidence.argoEnrichments).toHaveLength(2);
    expect(snapshot?.evidence.statuses[0].consumerExposure).toBe(false);
    expect(snapshot?.evidence.deployments[0].repository).toBeNull();
    expect(snapshot?.snapshot.deployments[0].effective_at).toBe(exposure.effective_at);
    expect(snapshot?.snapshot.deployments[0].extensions.tip_provenance).toEqual([]);
    const assertionsRef = `urn:clio:argo-provenance:${f.scope.sourceId}:${artifact}`;
    expect(snapshot?.snapshot.deployments[0].extensions.artifact_source_provenance).toEqual([
      {
        repository_id: build.repository_id,
        commit_sha: build.commit_sha,
        artifact_digest: artifact,
        assertions_ref: assertionsRef,
        assertion_count: 1,
      },
    ]);
    expect(snapshot?.snapshot.services[0].extensions.argo_artifact_provenance).toEqual([
      expect.objectContaining({
        id: assertionsRef,
        source_id: f.scope.sourceId,
        artifact_digest: artifact,
        repository_id: build.repository_id,
        commit_sha: build.commit_sha,
        assertions: [
          expect.objectContaining({
            producer_id: f.build.producerId,
            event_id: build.event_id,
            policy_reference: f.build.policyReference,
            evidence_ref: build.evidence_ref,
          }),
        ],
      }),
    ]);
    expect(snapshot?.snapshot.changes).toEqual([]);
    expect(snapshot?.metrics[0].change_lead_time.median_seconds).toBeNull();
    expect(snapshot?.metrics[0].deployment_rework_rate.ratio).toBeNull();
  } finally {
    await f.app.close();
  }
});
it('completion rolls back captured enrichments on producer revocation at terminal fence', async () => {
  const f = await fixture();
  try {
    expect((await f.enrich(buildEvent(f), f.build)).statusCode).toBe(202);
    const run = await f.enqueue();
    let calls = 0;
    const worker = createArgoWorker(pool, f.config, {
      configNow: () => (++calls === 1 ? f.config : { ...f.config, producers: [f.exposure] }),
    });
    await worker.runOnce();
    expect((await f.repo.getRun(member, f.w, f.s, run.id)).failureCode).toBe(
      'argo_connection_revoked',
    );
    expect(
      (await pool.query('SELECT * FROM argo_collection_snapshots WHERE run_id=$1', [run.id]))
        .rowCount,
    ).toBe(0);
  } finally {
    await f.app.close();
  }
});
it('provenance locks reject conflicting producers/rotations and preserve agreeing assertions', async () => {
  const f = await fixture();
  try {
    const event = buildEvent(f);
    expect((await f.enrich(event, f.build)).statusCode).toBe(202);
    const other = {
      ...f.build,
      producerId: randomUUID(),
      fingerprint: digest(randomUUID()),
      tokenDigest: digest('e'.repeat(64)),
    };
    const config = { ...f.config, producers: [f.exposure, f.build, other] };
    const repo = createArgoRepository(pool, config);
    await repo.save(owner, f.w, f.s, {
      expectedRevision: 1,
      sourceId: f.scope.sourceId,
      applicationOperationsBelongToService: true,
      exposurePolicyReference: null,
      enrichmentProducerIds: config.producers.map((p) => p.producerId),
    });
    const agreeing = { ...event, producer_id: other.producerId, event_id: randomUUID() };
    expect(await acceptEnrichment(pool, other, agreeing, () => config)).toHaveProperty('receiptId');
    await expect(
      acceptEnrichment(
        pool,
        other,
        { ...agreeing, event_id: randomUUID(), commit_sha: 'a'.repeat(40) },
        () => config,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const rotated = { ...other, fingerprint: digest(randomUUID()) },
      rotatedConfig = { ...config, producers: [f.exposure, f.build, rotated] };
    await createArgoRepository(pool, rotatedConfig).save(owner, f.w, f.s, {
      expectedRevision: 2,
      sourceId: f.scope.sourceId,
      applicationOperationsBelongToService: true,
      exposurePolicyReference: null,
      enrichmentProducerIds: rotatedConfig.producers.map((p) => p.producerId),
    });
    await expect(
      acceptEnrichment(
        pool,
        rotated,
        { ...agreeing, event_id: randomUUID(), commit_sha: 'a'.repeat(40) },
        () => rotatedConfig,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await pool.query('SELECT * FROM argo_enrichment_artifacts WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT * FROM argo_enrichment_receipts WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rowCount,
    ).toBe(2);
    await expect(
      pool.query('UPDATE argo_enrichment_artifacts SET commit_sha=$2 WHERE source_id=$1', [
        f.scope.sourceId,
        'a'.repeat(40),
      ]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      pool.query('DELETE FROM argo_enrichment_receipts WHERE source_id=$1', [f.scope.sourceId]),
    ).rejects.toThrow(/immutable/i);
  } finally {
    await f.app.close();
  }
});
it('unchanged grant revisions reuse eligible receipts without duplicate interruption boundaries', async () => {
  const f = await fixture();
  try {
    const native = notification(f);
    expect((await f.post(native)).statusCode).toBe(202);
    const event = exposureEvent(f, native),
      first = await f.enrich(event);
    expect(first.statusCode).toBe(202);
    await f.save(1);
    expect((await f.enrich(event)).json()).toEqual(first.json());
    expect(
      (await pool.query('SELECT * FROM argo_interruptions WHERE source_id=$1', [f.scope.sourceId]))
        .rowCount,
    ).toBe(0);
    const run = await f.enqueue(2);
    await createArgoWorker(pool, f.config).runOnce();
    expect((await f.repo.getRun(member, f.w, f.s, run.id)).result).toMatchObject({
      qualifyingCount: 1,
      enrichmentSummary: { consumerExposureCount: 1 },
    });
    await f.repo.disconnect(owner, f.w, f.s, { expectedRevision: 2 });
    await f.save(3);
    expect(
      (await pool.query('SELECT * FROM argo_interruptions WHERE source_id=$1', [f.scope.sourceId]))
        .rowCount,
    ).toBe(2);
    await f.save(4);
    expect(
      (await pool.query('SELECT * FROM argo_interruptions WHERE source_id=$1', [f.scope.sourceId]))
        .rowCount,
    ).toBe(2);
  } finally {
    await f.app.close();
  }
});
it('acceptance final grant fence rolls back receipt, lock and shared-budget reservation', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    await expect(
      acceptEnrichment(pool, f.build, buildEvent(f), () =>
        ++calls === 1 ? f.config : { ...f.config, producers: [f.exposure] },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await pool.query('SELECT retained_rows FROM argo_source_state WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rows[0]?.retained_rows,
    ).toBe(0);
    expect(
      (
        await pool.query('SELECT * FROM argo_enrichment_receipts WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query('SELECT * FROM argo_enrichment_artifacts WHERE source_id=$1', [
          f.scope.sourceId,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.app.close();
  }
});
it('concurrent exposure arriving during cutoff capture waits; next result alone includes it', async () => {
  const f = await fixture();
  try {
    const native = notification(f);
    expect((await f.post(native)).statusCode).toBe(202);
    const run = await f.enqueue();
    let pending: ReturnType<typeof acceptEnrichment> | undefined;
    const worker = createArgoWorker(pool, f.config, {
      configNow: () => {
        pending ??= acceptEnrichment(pool, f.exposure, exposureEvent(f, native), () => f.config);
        return f.config;
      },
    });
    await worker.runOnce();
    await pending;
    const original = (await f.repo.getRun(member, f.w, f.s, run.id)).result;
    expect(original).toMatchObject({
      qualifyingCount: 0,
      enrichmentSummary: { consumerExposureCount: 0 },
      coverageAssessment: {
        populationEvidence: 'not_supplied',
        unresolvedQualificationCount: 1,
        windowPopulationCount: 0,
      },
    });
    // Fixture exposes now, after the closed January window: lifetime qualification
    // changes, but reporting-window/history cohorts correctly remain empty.
    const next = await f.enqueue();
    await createArgoWorker(pool, f.config).runOnce();
    expect((await f.repo.getRun(member, f.w, f.s, next.id)).result).toMatchObject({
      qualifyingCount: 1,
      enrichmentSummary: { consumerExposureCount: 1 },
      coverageAssessment: {
        populationEvidence: 'not_supplied',
        unresolvedQualificationCount: 0,
        historyQualifyingCount: 0,
        windowPopulationCount: 0,
        incompleteChangeLinkCount: 0,
        unknownFailureCount: 0,
      },
    });
    expect((await f.repo.getRun(member, f.w, f.s, run.id)).result).toEqual(original);
  } finally {
    await f.app.close();
  }
});
it('old eligible native anchor accepts independent delayed configuration activation beyond ten-minute horizon', async () => {
  const f = await fixture();
  try {
    const { argoNotificationDigest, parseArgoNotification } = await import('@clio/adapters');
    const { scopeFor } = await import('../src/features/argo-collection/config.ts');
    const native = notification(f);
    native.operation.startedAt = '2026-01-02T10:00:00Z';
    native.operation.finishedAt = '2026-01-02T10:01:00Z';
    native.health.lastTransitionTime = native.operation.finishedAt;
    const scope = scopeFor(f.grant),
      observedAt = '2026-01-02T10:02:00Z',
      parsed = parseArgoNotification(native, scope, observedAt);
    if (parsed.kind !== 'operation') throw new Error('Invalid fixture');
    await pool.query(
      'INSERT INTO argo_receipts(id,source_id,workspace_id,service_id,connection_revision,application_uid,grant_fingerprint,scope,digest,observed_at,started_at,operation_id,notification_revision,phase,health,canonical_json,evidence) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [
        randomUUID(),
        f.scope.sourceId,
        f.w,
        f.s,
        f.scope.applicationUid,
        f.grant.fingerprint,
        JSON.stringify(scope),
        argoNotificationDigest(native, scope),
        observedAt,
        parsed.startedAt,
        parsed.operationId,
        parsed.notificationRevision,
        parsed.phase,
        parsed.health,
        parsed.canonicalJson,
        JSON.stringify(parsed.evidence),
      ],
    );
    await pool.query(
      'UPDATE argo_source_state SET retained_rows=3,first_observed_at=$2 WHERE source_id=$1',
      [f.scope.sourceId, observedAt],
    );
    const event = {
      ...exposureEvent(f, native),
      effective_at: '2026-01-03T10:00:00.123456Z',
      subject: { kind: 'configuration', revision: native.operation.revision },
    };
    const first = await f.enrich(event);
    expect(first.statusCode).toBe(202);
    expect((await f.enrich(event)).json()).toEqual(first.json());
    const run = await f.enqueue();
    await createArgoWorker(pool, f.config).runOnce();
    const snapshot = (
      await pool.query('SELECT snapshot FROM argo_collection_snapshots WHERE run_id=$1', [run.id])
    ).rows[0]?.snapshot;
    expect(snapshot.deployments[0].effective_at).toBe(event.effective_at);
  } finally {
    await f.app.close();
  }
});

it('reserves snapshot headroom before admission and tightens artifact reserve only with an immutable mapping', async () => {
  const unknown = await fixture(),
    known = await fixture(),
    exhausted = await fixture();
  const retainedBytes = async (sourceId: string) => {
    const result = await pool.query<{ retained_bytes: number }>(
      'SELECT retained_bytes FROM argo_source_state WHERE source_id=$1',
      [sourceId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Missing source state');
    return row.retained_bytes;
  };
  try {
    const first = notification(unknown),
      second = notification(known),
      third = notification(exhausted);
    expect((await unknown.post(first)).statusCode).toBe(202);
    const beforeUnknown = await retainedBytes(unknown.scope.sourceId);
    expect((await unknown.enrich(exposureEvent(unknown, first))).statusCode).toBe(202);
    const unknownCharge = (await retainedBytes(unknown.scope.sourceId)) - beforeUnknown;
    expect((await known.post(second)).statusCode).toBe(202);
    expect((await known.enrich(buildEvent(known), known.build)).statusCode).toBe(202);
    const beforeKnown = await retainedBytes(known.scope.sourceId);
    expect((await known.enrich(exposureEvent(known, second))).statusCode).toBe(202);
    const knownCharge = (await retainedBytes(known.scope.sourceId)) - beforeKnown;
    expect(unknownCharge - knownCharge).toBeGreaterThan(10000);
    expect((await exhausted.post(third)).statusCode).toBe(202);
    await pool.query('UPDATE argo_source_state SET retained_bytes=$2 WHERE source_id=$1', [
      exhausted.scope.sourceId,
      8 * 1024 * 1024 - 4096,
    ]);
    expect((await exhausted.enrich(exposureEvent(exhausted, third))).statusCode).toBe(503);
    expect(await retainedBytes(exhausted.scope.sourceId)).toBe(8 * 1024 * 1024 - 4096);
    const locks = await pool.query(
      'SELECT source_id FROM argo_enrichment_subjects WHERE source_id=$1',
      [exhausted.scope.sourceId],
    );
    expect(locks.rowCount).toBe(0);
  } finally {
    await unknown.app.close();
    await known.app.close();
    await exhausted.app.close();
  }
});

it('generated demo producer events traverse ingress, cutoff storage and OEMS without health-derived exposure', async () => {
  const f = await fixture(true);
  try {
    const bytes = Buffer.from('<html>Sandbox activation only</html>');
    const receipt = {
      contract: 'clio.sandbox.git-artifact.v1',
      repository_id: 'github:fixture/app',
      commit_sha: 'f'.repeat(40),
      artifact_digest: artifactDigest(bytes),
      source_path: 'infra/argocd/evidence-demo/app/index.html',
    };
    const endpoint = 'http://127.0.0.1:8099/index.html';
    const operationId = randomUUID();
    const baseline = await captureBaseline(
      endpoint,
      operationId,
      async () => new Response(null, { status: 404 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    const native = notification(f, operationId);
    native.operation.startedAt = new Date().toISOString();
    native.operation.finishedAt = native.operation.startedAt;
    native.operation.phase = 'Failed';
    native.health.status = 'Degraded';
    native.health.lastTransitionTime = native.operation.finishedAt;
    expect((await f.post(native)).statusCode).toBe(202);
    const first = await f.enqueue();
    await createArgoWorker(pool, f.config).runOnce();
    const earlier = await f.repo.getRun(member, f.w, f.s, first.id);
    const exposure = await observeArtifact(
      {
        endpoint,
        bytes,
        receipt,
        notification: native,
        baseline,
        producer: { sourceId: f.scope.sourceId, producerId: f.exposure.producerId },
      },
      async () => new Response(bytes),
    );
    const provenance = provenanceEvent(bytes, receipt, {
      sourceId: f.scope.sourceId,
      producerId: f.build.producerId,
    });
    expect((await f.enrich(provenance, f.build)).statusCode).toBe(202);
    expect((await f.enrich(exposure.event, f.exposure)).statusCode).toBe(202);
    const next = await f.enqueue();
    await createArgoWorker(pool, f.config).runOnce();
    expect((await f.repo.getRun(member, f.w, f.s, next.id)).result).toMatchObject({
      qualifyingCount: 1,
      deploymentFrequency: { count: 0 },
      enrichmentSummary: { consumerExposureCount: 1, applicationProvenanceCount: 1 },
    });
    const saved = (
      await pool.query('SELECT snapshot FROM argo_collection_snapshots WHERE run_id=$1', [next.id])
    ).rows[0]?.snapshot;
    expect(saved.deployments[0].effective_at).toBe(exposure.event.effective_at);
    expect(saved.deployments[0].extensions.tip_provenance).toEqual([]);
    expect(saved.deployments[0].extensions.artifact_source_provenance).toEqual([
      expect.objectContaining({
        repository_id: provenance.repository_id,
        commit_sha: provenance.commit_sha,
        artifact_digest: receipt.artifact_digest,
        assertion_count: 1,
      }),
    ]);
    expect(saved.changes).toEqual([]);
    expect((await f.repo.getRun(member, f.w, f.s, first.id)).result).toEqual(earlier.result);
  } finally {
    await f.app.close();
  }
});

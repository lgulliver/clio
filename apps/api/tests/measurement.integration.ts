import { randomUUID } from 'node:crypto';
import type { MeasurementReport } from '@clio/adapters';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../src/config.ts';
import { checkReadiness, loadMigrations, migrate } from '../src/db/migrations.ts';
import { pinArchive, publicArchive } from '../src/features/argo-collection/archive-grants.ts';
import { captureArgo } from '../src/features/argo-collection/capture.ts';
import {
  type ArgoArchiveGrant,
  type ArgoConfig,
  type ArgoGrant,
  type ArgoProducerGrant,
  scopeFor,
} from '../src/features/argo-collection/config.ts';
import { pinProducer, publicProducer } from '../src/features/argo-collection/enrichment-grants.ts';
import { captureGitHub } from '../src/features/github-collection/capture.ts';
import { type GitHubConfig, parseGrants } from '../src/features/github-collection/config.ts';
import { snapshotDigest } from '../src/features/github-collection/digest.ts';
import { windowInput } from '../src/features/github-collection/input.ts';
import { IdentityError } from '../src/features/identity/input.ts';
import {
  credentialDigest,
  type MeasurementConfig,
  type MeasurementGrant,
  parseMeasurementGrant,
} from '../src/features/measurements/config.ts';
import {
  acceptMeasurementReport,
  receiverTime,
  registerMeasurementIngress,
} from '../src/features/measurements/ingress.ts';
import {
  parseRetainedGapManifest,
  readNativeMeasurementBasis,
} from '../src/features/measurements/native-basis.ts';
import { createMeasurementRepository } from '../src/features/measurements/repository.ts';
import { registerMeasurementRoutes } from '../src/features/measurements/routes.ts';
import { createMeasurementWorker } from '../src/features/measurements/worker.ts';
import { argoFixture, evidenceFixture } from './measurement-fixture.ts';

if (!process.env.CLIO_TEST_DATABASE_URL)
  throw new Error('CLIO_TEST_DATABASE_URL is required for PostgreSQL integration tests');
const connectionString = databaseUrl(process.env.CLIO_TEST_DATABASE_URL),
  schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString, connectionTimeoutMillis: 3000 }),
  pool = new Pool({
    connectionString,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
  });
const owner = { userId: 'measurement-owner', sessionId: 'measurement-owner-session' },
  member = { userId: 'measurement-member', sessionId: 'measurement-member-session' },
  outsider = { userId: 'measurement-outsider', sessionId: 'measurement-outsider-session' };
const migrations = await loadMigrations();
let created = false;
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
      "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$1,clock_timestamp()+interval '1 day')",
      [actor.sessionId, actor.userId],
    );
  }
});
afterEach(async () => {
  if (!created) return;
  await pool.query(
    "UPDATE measurement_runs SET status='failed',attempts=GREATEST(attempts,1),failure_code='measurement_processing_failed',completed_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE status IN ('pending','running')",
  );
  await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 day'");
});
afterAll(async () => {
  await pool.end();
  try {
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
});
function rotate(
  g: MeasurementGrant,
  changes: Record<string, unknown> = {},
  tokenDigest = g.tokenDigest,
) {
  const source =
    g.source.provider === 'github'
      ? { installationId: g.source.installationId, repositoryId: g.source.repositoryId }
      : { sourceId: g.source.sourceId };
  return parseMeasurementGrant(
    {
      workspaceId: g.workspaceId,
      serviceId: g.serviceId,
      provider: g.source.provider,
      source,
      producerId: g.producerId,
      capability: g.capability,
      name: g.name,
      policyRef: g.policyRef,
      productionPaths: g.productionPaths,
      repositoryIds: g.repositoryIds,
      ...changes,
    },
    tokenDigest,
  );
}
async function seed(empty = false, prewindow = false) {
  const f = evidenceFixture(empty, prewindow),
    c = f.fixture.capture,
    connection = c.connection,
    wid = f.fixture.workspaceId,
    sid = f.fixture.serviceId;
  await pool.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [wid, 'Measurement fixture']);
  await pool.query('INSERT INTO services(id,workspace_id,name) VALUES($1,$2,$3)', [
    sid,
    wid,
    'Fictional',
  ]);
  for (const actor of [owner, member])
    await pool.query(
      'INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)',
      [wid, actor.userId, actor === owner ? 'owner' : 'member'],
    );
  let github: GitHubConfig | null = {
    appId: 12,
    privateKey: 'fictional',
    grants: parseGrants(
      [
        {
          workspaceId: wid,
          installationId: 10,
          accountId: 11,
          accountType: 'Organization',
          repositoryIds: [20],
        },
      ],
      12,
    ),
  };
  const fingerprint = github.grants[0]?.fingerprint;
  if (!fingerprint) throw new Error('Missing grant');
  await pool.query(
    'INSERT INTO github_connection_revisions(workspace_id,service_id,revision,connection,grant_fingerprint,created_by) VALUES($1,$2,1,$3,$4,$5)',
    [wid, sid, JSON.stringify(connection), fingerprint, owner.userId],
  );
  await pool.query(
    "INSERT INTO github_collection_runs(id,workspace_id,service_id,connection_revision,request_id,connection_input,grant_fingerprint,window_input,service_name,status,attempts,lease_token,lease_until) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,'running',1,$9,clock_timestamp()+interval '120 seconds')",
    [
      f.fixture.runId,
      wid,
      sid,
      randomUUID(),
      JSON.stringify(connection),
      fingerprint,
      JSON.stringify(windowInput({ start: c.snapshot.window.start, end: c.snapshot.window.end })),
      'Fictional',
      randomUUID(),
    ],
  );
  await pool.query(
    'INSERT INTO github_collection_snapshots(run_id,workspace_id,service_id,connection_revision,connection_input,service_name,evidence,snapshot,metrics,oems_revision,public_result,digest) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      f.fixture.runId,
      wid,
      sid,
      JSON.stringify(connection),
      'Fictional',
      JSON.stringify(c.evidence),
      JSON.stringify(c.snapshot),
      JSON.stringify(c.metrics),
      c.oemsRevision,
      JSON.stringify(c.result),
      c.digest,
    ],
  );
  await pool.query(
    "UPDATE github_collection_runs SET status='succeeded',result=$2,completed_at=statement_timestamp(),updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1",
    [f.fixture.runId, JSON.stringify(c.result)],
  );
  const tokens = f.grants.map((_, i) => String(i + 1).repeat(64)),
    grants = f.grants.map((g, i) => {
      const t = tokens[i];
      if (!t) throw new Error('Missing token');
      return rotate(g, {}, credentialDigest(t));
    });
  let config: MeasurementConfig | null = { grants };
  const deps = { configNow: () => config, githubNow: () => github, argoNow: () => null },
    repository = createMeasurementRepository(pool, deps),
    worker = createMeasurementWorker(pool, deps);
  function report(capability: MeasurementReport['capability']) {
    const r = f.reports.find((r) => r.capability === capability),
      g = grants.find((g) => g.capability === capability);
    if (!r || !g) throw new Error('Missing report');
    return { r, g };
  }
  const accept = (capability: MeasurementReport['capability']) => {
    const { r, g } = report(capability);
    return acceptMeasurementReport(pool, deps, g, 'github', f.fixture.runId, r);
  };
  const queue = (producerIds = grants.map((g) => g.producerId), requestId: string = randomUUID()) =>
    repository.enqueue(owner, wid, sid, {
      provider: 'github',
      basisRunId: f.fixture.runId,
      producerIds,
      requestId,
    });
  return {
    ...f,
    wid,
    sid,
    grants,
    tokens,
    deps,
    repository,
    worker,
    report,
    accept,
    queue,
    setConfig: (next: MeasurementConfig | null) => {
      config = next;
    },
    setGitHub: (next: GitHubConfig | null) => {
      github = next;
    },
    getConfig: () => config,
    getGitHub: () => github,
  };
}
async function freshGitHubBasis(f: Awaited<ReturnType<typeof seed>>) {
  const runId = randomUUID(),
    prior = f.fixture.capture,
    connection = prior.connection,
    grant = f.getGitHub()?.grants[0];
  if (!grant) throw new Error('Missing fixture');
  const captured = {
      connection,
      serviceName: prior.serviceName,
      ...captureGitHub({
        runId,
        connection,
        serviceName: prior.serviceName,
        window: windowInput({ start: prior.snapshot.window.start, end: prior.snapshot.window.end }),
        evidence: prior.evidence,
        transportComplete: true,
        acquiredAt: prior.snapshot.evidence_cutoff,
        databaseObservedAt: prior.snapshot.evidence_cutoff,
      }),
    },
    capture = { ...captured, digest: snapshotDigest(captured) };
  await pool.query(
    "INSERT INTO github_collection_runs(id,workspace_id,service_id,connection_revision,request_id,connection_input,grant_fingerprint,window_input,service_name,status,attempts,lease_token,lease_until) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,'running',1,$9,clock_timestamp()+interval '120 seconds')",
    [
      runId,
      f.wid,
      f.sid,
      randomUUID(),
      JSON.stringify(connection),
      grant.fingerprint,
      JSON.stringify(
        windowInput({ start: prior.snapshot.window.start, end: prior.snapshot.window.end }),
      ),
      prior.serviceName,
      randomUUID(),
    ],
  );
  await pool.query(
    'INSERT INTO github_collection_snapshots(run_id,workspace_id,service_id,connection_revision,connection_input,service_name,evidence,snapshot,metrics,oems_revision,public_result,digest) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      runId,
      f.wid,
      f.sid,
      JSON.stringify(connection),
      prior.serviceName,
      JSON.stringify(capture.evidence),
      JSON.stringify(capture.snapshot),
      JSON.stringify(capture.metrics),
      capture.oemsRevision,
      JSON.stringify(capture.result),
      capture.digest,
    ],
  );
  await pool.query(
    "UPDATE github_collection_runs SET status='succeeded',result=$2,completed_at=statement_timestamp(),updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1",
    [runId, JSON.stringify(capture.result)],
  );
  return readNativeMeasurementBasis({ ...f.fixture, runId, capture });
}
async function seedArgo(companion: 'archive' | 'enrichment' | null = null) {
  let fixture = argoFixture();
  const wid = fixture.workspaceId,
    sid = fixture.serviceId;
  const raw = { ...fixture.argoScope, tokenDigest: credentialDigest('a'.repeat(64)) },
    nativeGrant: ArgoGrant = { ...raw, fingerprint: snapshotDigest(raw) };
  const exposureRaw = {
      ...scopeFor(nativeGrant),
      producerId: randomUUID(),
      capability: 'consumer_exposure' as const,
      policyReference: 'exposure-v1',
      repositoryIds: [],
      tokenDigest: credentialDigest('c'.repeat(64)),
    },
    exposure: ArgoProducerGrant = { ...exposureRaw, fingerprint: snapshotDigest(exposureRaw) };
  const archiveRaw = {
      ...nativeGrant,
      producerId: randomUUID(),
      journalId: randomUUID(),
      policyReference: 'archive-v1',
      capability: 'operation_archive' as const,
      tokenDigest: credentialDigest('d'.repeat(64)),
    },
    archive: ArgoArchiveGrant = { ...archiveRaw, fingerprint: snapshotDigest(archiveRaw) };
  let argo: ArgoConfig | null = {
    grants: [nativeGrant],
    producers: companion === 'enrichment' ? [exposure] : [],
    archives: companion === 'archive' ? [archive] : [],
  };
  if (companion) {
    const prior = fixture.capture,
      connection = {
        ...prior.connection,
        ...(companion === 'enrichment'
          ? { enrichmentProducers: [publicProducer(exposure)] }
          : { archiveProducer: publicArchive(archive) }),
      };
    const capture = {
      connection,
      serviceName: prior.serviceName,
      ...captureArgo({
        runId: fixture.runId,
        connection,
        serviceName: prior.serviceName,
        window: windowInput({ start: prior.snapshot.window.start, end: prior.snapshot.window.end }),
        evidence: prior.evidence,
        nativeGapManifest: parseRetainedGapManifest(prior.evidence.nativeGapManifest),
        databaseObservedAt: prior.snapshot.evidence_cutoff,
        stats: {
          retainedReceiptCount: 1,
          retainedEvidenceCount: 2,
          recordedGapCount: 0,
          gapReasons: {},
          rejectionCount: 0,
          scopeDriftCount: 0,
          observationPeriod: { start: '2026-01-02T10:06:00Z', end: prior.snapshot.evidence_cutoff },
        },
      }),
    };
    fixture = { ...fixture, capture: { ...capture, digest: snapshotDigest(capture) } };
  }
  const c = fixture.capture;
  await pool.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [
    wid,
    'Argo measurement fixture',
  ]);
  await pool.query('INSERT INTO services(id,workspace_id,name) VALUES($1,$2,$3)', [
    sid,
    wid,
    'Fictional',
  ]);
  await pool.query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [wid, owner.userId],
  );
  await pool.query(
    'INSERT INTO argo_connection_revisions(workspace_id,service_id,revision,connection,grant_fingerprint,scope,created_by,enrichment_grants,archive_grant) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)',
    [
      wid,
      sid,
      JSON.stringify(c.connection),
      nativeGrant.fingerprint,
      JSON.stringify(scopeFor(nativeGrant)),
      owner.userId,
      JSON.stringify(companion === 'enrichment' ? [pinProducer(exposure)] : []),
      companion === 'archive' ? JSON.stringify(pinArchive(archive)) : null,
    ],
  );
  await pool.query(
    "INSERT INTO argo_collection_runs(id,workspace_id,service_id,connection_revision,request_id,connection_input,grant_fingerprint,window_input,service_name,status,attempts,lease_token,lease_until) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,'running',1,$9,clock_timestamp()+interval '120 seconds')",
    [
      fixture.runId,
      wid,
      sid,
      randomUUID(),
      JSON.stringify(c.connection),
      nativeGrant.fingerprint,
      JSON.stringify(windowInput({ start: c.snapshot.window.start, end: c.snapshot.window.end })),
      'Fictional',
      randomUUID(),
    ],
  );
  await pool.query(
    'INSERT INTO argo_collection_snapshots(run_id,workspace_id,service_id,connection_revision,connection_input,service_name,evidence,snapshot,metrics,oems_revision,public_result,digest) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      fixture.runId,
      wid,
      sid,
      JSON.stringify(c.connection),
      'Fictional',
      JSON.stringify(c.evidence),
      JSON.stringify(c.snapshot),
      JSON.stringify(c.metrics),
      c.oemsRevision,
      JSON.stringify(c.result),
      c.digest,
    ],
  );
  await pool.query(
    "UPDATE argo_collection_runs SET status='succeeded',result=$2,completed_at=statement_timestamp(),updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1",
    [fixture.runId, JSON.stringify(c.result)],
  );
  const grant = parseMeasurementGrant(
      {
        workspaceId: wid,
        serviceId: sid,
        provider: 'argocd',
        source: { sourceId: nativeGrant.sourceId },
        producerId: randomUUID(),
        capability: 'population',
        name: 'Argo census',
        policyRef: 'census-v1',
        productionPaths: [fixture.productionPath],
        repositoryIds: [],
      },
      credentialDigest('b'.repeat(64)),
    ),
    native = readNativeMeasurementBasis(fixture),
    interval = { start: c.snapshot.window.start, end: c.snapshot.window.end };
  const report: MeasurementReport = {
    contract: 'clio.measurement.evidence.v1',
    eventId: randomUUID(),
    producerId: grant.producerId,
    workspaceId: wid,
    serviceId: sid,
    capability: 'population',
    policyRef: grant.policyRef,
    evidenceRef: 'independent-census',
    basis: native.context.basis,
    payload: {
      interval,
      exhaustive: true,
      productionPaths: [fixture.productionPath],
      operations: native.nativeIndex.map((n) => ({
        sourceId: n.sourceId,
        sourceDeploymentId: n.sourceDeploymentId,
      })),
      gapResolutions: native.gaps.map((gap) => ({
        gap,
        scope: interval,
        evidenceRef: 'independent-transport-proof',
      })),
    },
  };
  const deps = {
    configNow: () => ({ grants: [grant] }),
    githubNow: () => null,
    argoNow: () => argo,
  };
  return {
    wid,
    sid,
    fixture,
    grant,
    report,
    deps,
    argo,
    exposure,
    archive,
    setArgo: (next: ArgoConfig | null) => {
      argo = next;
    },
    repository: createMeasurementRepository(pool, deps),
    worker: createMeasurementWorker(pool, deps),
  };
}
describe('real PostgreSQL durable measurement foundation', () => {
  it('requires measurement columns for readiness without trusting ledger', async () => {
    await expect(checkReadiness(pool, migrations)).resolves.toBeUndefined();
    for (const [table, column] of [
      ['measurement_reports', 'authority_fingerprint'],
      ['measurement_source_budgets', 'retained_bytes'],
      ['measurement_runs', 'input'],
      ['measurement_snapshots', 'lineage'],
    ]) {
      await pool.query(
        `ALTER TABLE ${table} RENAME COLUMN ${column} TO measurement_readiness_probe`,
      );
      try {
        await expect(checkReadiness(pool, migrations)).rejects.toThrow();
      } finally {
        await pool.query(
          `ALTER TABLE ${table} RENAME COLUMN measurement_readiness_probe TO ${column}`,
        );
      }
    }
  });
  it('stores exact replay once with first DB time; conflicts retain pacing but no extra storage quota', async () => {
    const f = await seed(),
      first = await f.accept('population'),
      replay = await f.accept('population');
    expect(replay).toEqual({ ...first, replayed: true });
    const { r, g } = f.report('population');
    await expect(
      acceptMeasurementReport(pool, f.deps, g, 'github', f.fixture.runId, {
        ...r,
        eventId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const budget = await pool.query(
      'SELECT retained_facts,rate_requests FROM measurement_source_budgets WHERE workspace_id=$1',
      [f.wid],
    );
    expect(budget.rows[0]).toEqual({ retained_facts: 3, rate_requests: 3 });
    const accounting = await pool.query(
      'SELECT b.retained_bytes,(SELECT sum(r.payload_bytes)::int FROM measurement_reports r WHERE r.workspace_id=b.workspace_id) AS used FROM measurement_source_budgets b WHERE b.workspace_id=$1',
      [f.wid],
    );
    expect(accounting.rows[0]?.retained_bytes).toBe(accounting.rows[0]?.used);
    const other = rotate(g, { producerId: randomUUID() });
    f.setConfig({ grants: [...f.grants, other] });
    await expect(
      acceptMeasurementReport(pool, f.deps, other, 'github', f.fixture.runId, {
        ...r,
        producerId: other.producerId,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('recovery-first receipt remains available while causal classification blocks completed recovery', async () => {
    const f = await seed();
    await f.accept('recovery');
    const run = await f.queue();
    await f.worker.runOnce();
    const saved = await f.repository.getRun(member, f.wid, f.sid, run.id);
    expect(saved.result?.assessment.blockers).toContain('recovery_classification_missing');
    expect(saved.result?.coverage.recoveryEvidenceComplete).toBe(false);
  });
  it('actual GitHub capture + exact native basis + four independent reports yields all five complete', async () => {
    const f = await seed();
    for (const capability of ['recovery', 'population', 'change_links', 'classification'] as const)
      await f.accept(capability);
    const run = await f.queue(),
      claim = await f.worker.claim();
    if (!claim) throw new Error('Missing claim');
    expect(await f.worker.complete(claim)).toBe(true);
    const saved = await f.repository.getRun(member, f.wid, f.sid, run.id);
    expect(saved.status).toBe('succeeded');
    expect(saved.result?.assessment).toEqual({
      blockers: [],
      collectionComplete: true,
      historyComplete: true,
      recoveryComplete: true,
    });
    expect(saved.result?.metricResult.change_fail_rate.ratio).toBe(0.5);
    expect(saved.result?.metricResult.change_lead_time.median_seconds).toBe(3600);
    expect(saved.result?.metricResult.failed_deployment_recovery_time.median_seconds).toBe(1800);
    expect(saved.result?.evidenceCutoff).not.toBe(f.native.snapshot.data.evidence_cutoff);
    for (const metric of [
      'deployment_frequency',
      'change_lead_time',
      'change_fail_rate',
      'deployment_rework_rate',
      'failed_deployment_recovery_time',
    ] as const)
      expect(saved.result?.metricResult[metric].status).toBe('complete');
    const publicJSON = JSON.stringify(saved);
    for (const privateField of [
      'private-fixture-reference',
      'failure-proof',
      'scopeDigest',
      'fingerprint',
      'nativeIndex',
      'snapshotDigest',
      'tokenDigest',
      'source_refs',
    ])
      expect(publicJSON).not.toContain(privateField);
    const prior = saved.result;
    f.setConfig(null);
    f.setGitHub(null);
    expect((await f.repository.getRun(member, f.wid, f.sid, run.id)).result).toEqual(prior);
    await expect(
      f.queue(
        f.grants.map((g) => g.producerId),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      pool.query('UPDATE measurement_snapshots SET digest=$2 WHERE run_id=$1', [
        run.id,
        'f'.repeat(64),
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query("UPDATE measurement_runs SET status='pending' WHERE id=$1", [run.id]),
    ).rejects.toThrow();
    await expect(
      pool.query('DELETE FROM measurement_reports WHERE workspace_id=$1', [f.wid]),
    ).rejects.toThrow();
  });
  it('pins missing reports at queue; later receipt never changes saved snapshot', async () => {
    const f = await seed();
    const run = await f.queue();
    await f.accept('population');
    expect(await f.worker.runOnce()).toBe(true);
    const saved = await f.repository.getRun(member, f.wid, f.sid, run.id);
    expect(saved.result?.assessment.blockers).toContain('population_missing');
    expect(saved.result?.coverage.collectionComplete).toBe(false);
    const second = await f.queue();
    await f.worker.runOnce();
    expect(
      (await f.repository.getRun(member, f.wid, f.sid, second.id)).result?.coverage
        .collectionComplete,
    ).toBe(true);
    expect((await f.repository.getRun(member, f.wid, f.sid, run.id)).result).toEqual(saved.result);
  });
  it('no authority never promotes empty native evidence; duplicate capability selections rejected', async () => {
    const f = await seed();
    const run = await f.queue([]);
    await f.worker.runOnce();
    expect((await f.repository.getRun(member, f.wid, f.sid, run.id)).result?.coverage).toEqual({
      collectionComplete: false,
      deploymentHistoryComplete: false,
      recoveryEvidenceComplete: false,
    });
    const g = f.grants[0];
    if (!g) throw new Error('Missing grant');
    const other = rotate(g, { producerId: randomUUID() });
    f.setConfig({ grants: [...f.grants, other] });
    await expect(f.queue([g.producerId, other.producerId])).rejects.toMatchObject({ status: 409 });
  });
  it('authenticates machine separately from browser sessions and redacts invalid payloads', async () => {
    const f = await seed(),
      server = Fastify();
    registerMeasurementIngress(server, { pool, ...f.deps });
    const { r, g } = f.report('population'),
      base = `/api/measurement/bases/github/${f.fixture.runId}/producers/${g.producerId}`;
    try {
      expect(
        (await server.inject({ method: 'GET', url: base, headers: { cookie: 'session=fixture' } }))
          .statusCode,
      ).toBe(401);
      const headers = { authorization: `Bearer ${f.tokens[0]}` };
      const projection = await server.inject({ method: 'GET', url: base, headers });
      expect(projection.statusCode).toBe(200);
      expect(projection.json().operations).toHaveLength(2);
      expect(JSON.stringify(projection.json())).not.toContain('tokenDigest');
      const accepted = await server.inject({
        method: 'POST',
        url: `${base}/reports`,
        headers,
        payload: r,
      });
      expect(accepted.statusCode).toBe(201);
      const malformed = await server.inject({
        method: 'POST',
        url: `${base}/reports`,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: '{',
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ error: 'invalid_request' });
    } finally {
      await server.close();
    }
  });
  it('rejects scope/digest/foreign operation/source/producer claims and rolls back quota', async () => {
    const f = await seed(),
      { r, g } = f.report('population');
    for (const changed of [
      { ...r, producerId: randomUUID() },
      { ...r, workspaceId: randomUUID() },
      { ...r, basis: { ...r.basis, evidenceDigest: 'f'.repeat(64) } },
      { ...r, basis: { ...r.basis, sourceId: 'github:foreign' } },
      {
        ...r,
        payload: {
          ...r.payload,
          operations: [{ sourceId: r.basis.sourceId, sourceDeploymentId: 'foreign' }],
        },
      },
    ])
      await expect(
        acceptMeasurementReport(pool, f.deps, g, 'github', f.fixture.runId, changed),
      ).rejects.toThrow();
    expect(
      (
        await pool.query(
          'SELECT retained_facts,retained_bytes FROM measurement_source_budgets WHERE workspace_id=$1',
          [f.wid],
        )
      ).rows,
    ).toEqual([{ retained_facts: 0, retained_bytes: 0 }]);
  });
  it('rechecks current native/authority grants before replay and queue', async () => {
    const f = await seed();
    await f.accept('population');
    const run = await f.queue(),
      g = f.grants[0];
    if (!g) throw new Error('Missing grant');
    f.setConfig({
      grants: f.grants.map((p) =>
        p.producerId === g.producerId ? rotate(p, { policyRef: 'rotated-policy' }) : p,
      ),
    });
    await expect(f.accept('population')).rejects.toMatchObject({ status: 409 });
    await expect(
      f.queue(
        f.grants.map((g) => g.producerId),
        run.id,
      ),
    ).rejects.toMatchObject({ status: 409 });
    f.setConfig({ grants: f.grants });
    f.setGitHub(null);
    await expect(f.accept('population')).rejects.toMatchObject({ status: 409 });
  });
  it('revocation between queue/claim/completion blocks stale save; terminal result absent', async () => {
    const f = await seed(),
      run = await f.queue(),
      claim = await f.worker.claim();
    if (!claim) throw new Error('Missing claim');
    f.setConfig(null);
    await expect(f.worker.complete(claim)).rejects.toMatchObject({ status: 409 });
    expect(await f.worker.fail(claim, true)).toBe(true);
    expect((await f.repository.getRun(member, f.wid, f.sid, run.id)).failureCode).toBe(
      'measurement_revoked',
    );
    expect(
      (await pool.query('SELECT * FROM measurement_snapshots WHERE run_id=$1', [run.id])).rowCount,
    ).toBe(0);
  });
  it('same source revision change requires fresh basis', async () => {
    const f = await seed(),
      c = f.fixture.capture.connection,
      next = { ...c, revision: 2 };
    await pool.query(
      'INSERT INTO github_connection_revisions(workspace_id,service_id,revision,connection,grant_fingerprint,created_by) SELECT workspace_id,service_id,2,$3,grant_fingerprint,created_by FROM github_connection_revisions WHERE workspace_id=$1 AND service_id=$2 AND revision=1',
      [f.wid, f.sid, JSON.stringify(next)],
    );
    await expect(f.queue()).rejects.toMatchObject({ status: 409 });
    await expect(f.accept('population')).rejects.toMatchObject({ status: 409 });
  });
  it('rate bound persists across producers and credential rotation; exact replay counts', async () => {
    const f = await seed();
    await f.accept('population');
    for (let i = 1; i < 120; i++) await f.accept('population');
    await expect(f.accept('population')).rejects.toMatchObject({ status: 429 });
    await expect(f.accept('recovery')).rejects.toMatchObject({ status: 429 });
    const g = f.grants[1];
    if (!g) throw new Error('Missing grant');
    const rotated = rotate(g, { policyRef: 'rotated' }, credentialDigest('f'.repeat(64)));
    f.setConfig({ grants: f.grants.map((p) => (p.producerId === g.producerId ? rotated : p)) });
    const r = f.reports.find((r) => r.capability === g.capability);
    if (!r) throw new Error('Missing report');
    await expect(
      acceptMeasurementReport(pool, f.deps, rotated, 'github', f.fixture.runId, {
        ...r,
        policyRef: 'rotated',
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(
      (
        await pool.query(
          'SELECT retained_facts,rate_requests FROM measurement_source_budgets WHERE workspace_id=$1',
          [f.wid],
        )
      ).rows[0],
    ).toEqual({ retained_facts: 3, rate_requests: 120 });
  }, 30000);
  it('stable shared lifetime counts/bytes reject overflow and cannot reset on rotation', async () => {
    const f = await seed();
    await f.accept('population');
    await pool.query(
      'UPDATE measurement_source_budgets SET retained_facts=5000 WHERE workspace_id=$1',
      [f.wid],
    );
    await expect(f.accept('recovery')).rejects.toMatchObject({ status: 409 });
    await expect(
      pool.query('UPDATE measurement_source_budgets SET retained_facts=0 WHERE workspace_id=$1', [
        f.wid,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query('DELETE FROM measurement_source_budgets WHERE workspace_id=$1', [f.wid]),
    ).rejects.toThrow();
    const second = await seed();
    await second.accept('population');
    await pool.query(
      'UPDATE measurement_source_budgets SET retained_bytes=8388608 WHERE workspace_id=$1',
      [second.wid],
    );
    await expect(second.accept('recovery')).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM measurement_reports WHERE workspace_id=$1',
          [second.wid],
        )
      ).rows[0]?.n,
    ).toBe(1);
  });
  it('owner writes/member reads enforce DB session expiry, membership and foreign scope', async () => {
    const f = await seed();
    const input = {
      requestId: randomUUID(),
      provider: 'github',
      basisRunId: f.fixture.runId,
      producerIds: [],
    };
    await expect(f.repository.enqueue(member, f.wid, f.sid, input)).rejects.toMatchObject({
      status: 403,
    });
    await expect(f.repository.list(outsider, f.wid, f.sid)).rejects.toMatchObject({ status: 404 });
    await expect(f.repository.list(member, f.wid, randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    await pool.query('UPDATE auth_sessions SET expires_at=clock_timestamp() WHERE id=$1', [
      owner.sessionId,
    ]);
    await expect(f.repository.enqueue(owner, f.wid, f.sid, input)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('browser actor callback retains real transactional authorization', async () => {
    const f = await seed(),
      server = Fastify();
    server.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof IdentityError ? error.status : 503)
        .send({ error: error instanceof IdentityError ? error.message : 'unavailable' }),
    );
    registerMeasurementRoutes(server, { pool, ...f.deps, actor: async () => member });
    try {
      const response = await server.inject({
        method: 'POST',
        url: `/api/workspaces/${f.wid}/services/${f.sid}/measurement-runs`,
        payload: {
          requestId: randomUUID(),
          provider: 'github',
          basisRunId: f.fixture.runId,
          producerIds: [],
        },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
  it('stale leases lose completion; reclaim fences tokens and third expired attempt terminates', async () => {
    const f = await seed(),
      run = await f.queue(),
      first = await f.worker.claim();
    if (!first) throw new Error('Missing claim');
    await pool.query(
      "UPDATE measurement_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [run.id],
    );
    const second = await f.worker.claim();
    if (!second) throw new Error('Missing claim');
    expect(second.token).not.toBe(first.token);
    expect(await f.worker.complete(first)).toBe(false);
    await pool.query(
      "UPDATE measurement_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [run.id],
    );
    const third = await f.worker.claim();
    if (!third) throw new Error('Missing claim');
    await pool.query(
      "UPDATE measurement_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [run.id],
    );
    await f.worker.claim();
    expect((await f.repository.getRun(member, f.wid, f.sid, run.id)).status).toBe('failed');
    expect(await f.worker.complete(third)).toBe(false);
  });
  it('history traverses more than newest 25 with stable cursor and member safe reads', async () => {
    const f = await seed();
    for (let i = 0; i < 27; i++) {
      await f.queue([]);
      await f.worker.runOnce();
    }
    const first = await f.repository.list(member, f.wid, f.sid);
    expect(first.runs).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const second = await f.repository.list(member, f.wid, f.sid, first.nextCursor);
    expect(second.runs).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.runs, ...second.runs].map((r) => r.id)).size).toBe(27);
    for (let i = 0; i < 30; i++) {
      await f.queue([]);
      const claim = await f.worker.claim();
      if (!claim) throw new Error('Missing failure fixture claim');
      await f.worker.fail(claim, true);
    }
    expect(
      (await f.repository.list(member, f.wid, f.sid)).runs.every((r) => r.status === 'failed'),
    ).toBe(true);
    const successes = await f.repository.list(member, f.wid, f.sid, undefined, 'succeeded');
    expect(successes.runs).toHaveLength(25);
    expect(successes.runs.every((r) => r.status === 'succeeded')).toBe(true);
    const older = await f.repository.list(member, f.wid, f.sid, successes.nextCursor, 'succeeded');
    expect(older.runs.map((r) => r.id)).toEqual(second.runs.map((r) => r.id));
    expect(() => f.repository.list(member, f.wid, f.sid, undefined, 'failed')).toThrow(
      'invalid_request',
    );
  }, 30000);
  it('independently exhaustive empty census differs from no authority on identical empty native basis', async () => {
    const f = await seed(true),
      partial = await f.queue([]);
    await f.worker.runOnce();
    expect(
      (await f.repository.getRun(member, f.wid, f.sid, partial.id)).result?.metricResult
        .deployment_frequency.status,
    ).toBe('provisional');
    for (const capability of ['population', 'change_links', 'classification', 'recovery'] as const)
      await f.accept(capability);
    const complete = await f.queue();
    await f.worker.runOnce();
    const saved = await f.repository.getRun(member, f.wid, f.sid, complete.id);
    expect(saved.result?.metricResult.deployment_frequency).toMatchObject({
      status: 'complete',
      count: 0,
    });
    expect(saved.result?.coverage).toEqual({
      collectionComplete: true,
      deploymentHistoryComplete: true,
      recoveryEvidenceComplete: true,
    });
  });
  it('retains pre-window causal deployment and post-window service restoration', async () => {
    const f = await seed(false, true);
    for (const capability of ['population', 'change_links', 'classification', 'recovery'] as const)
      await f.accept(capability);
    const run = await f.queue();
    await f.worker.runOnce();
    const saved = await f.repository.getRun(member, f.wid, f.sid, run.id);
    expect(saved.result?.metricResult.failed_deployment_recovery_time).toMatchObject({
      status: 'complete',
      observation_count: 1,
      median_seconds: 172800,
    });
    expect(saved.result?.metricResult.change_lead_time.observation_count).toBe(0);
    expect(saved.result?.window.calendarDays).toBe(1);
  });
  it('Argo native unknown qualification remains provisional after exact exhaustive census and gap resolutions', async () => {
    const f = await seedArgo();
    await acceptMeasurementReport(pool, f.deps, f.grant, 'argocd', f.fixture.runId, f.report);
    const run = await f.repository.enqueue(owner, f.wid, f.sid, {
      provider: 'argocd',
      basisRunId: f.fixture.runId,
      producerIds: [f.grant.producerId],
      requestId: randomUUID(),
    });
    await f.worker.runOnce();
    const saved = await f.repository.getRun(owner, f.wid, f.sid, run.id);
    expect(saved.result?.coverage.collectionComplete).toBe(true);
    expect(saved.result?.metricResult.deployment_frequency.status).toBe('provisional');
    expect(saved.result?.metricResult.deployment_frequency.quality_reasons).toContain(
      'unresolved_qualification',
    );
    expect(saved.result?.metricResult.qualification_unknown_count).toBe(1);
  });

  it('fresh ingress fence rolls back receiver append and storage budget while retaining request pacing', async () => {
    const f = await seed(),
      current = f.getConfig();
    let calls = 0;
    f.deps.configNow = () => (++calls === 1 ? current : null);
    await expect(f.accept('population')).rejects.toMatchObject({ status: 409 });
    expect(
      (await pool.query('SELECT * FROM measurement_reports WHERE workspace_id=$1', [f.wid]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT retained_facts,retained_bytes FROM measurement_source_budgets WHERE workspace_id=$1',
          [f.wid],
        )
      ).rows,
    ).toEqual([{ retained_facts: 0, retained_bytes: 0 }]);
  });
  it('fresh replay fence rejects acknowledgement and retains authenticated request pacing', async () => {
    const f = await seed();
    await f.accept('population');
    const current = f.getConfig();
    let calls = 0;
    f.deps.configNow = () => (++calls === 1 ? current : null);
    await expect(f.accept('population')).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await pool.query(
          'SELECT rate_requests FROM measurement_source_budgets WHERE workspace_id=$1',
          [f.wid],
        )
      ).rows[0]?.rate_requests,
    ).toBe(2);
  });
  it('post-calculation final fence rolls back snapshot inserted before revocation', async () => {
    const f = await seed(),
      g = f.grants[0];
    if (!g) throw new Error('Missing fixture');
    await f.accept('population');
    const run = await f.queue([g.producerId]),
      claim = await f.worker.claim();
    if (!claim) throw new Error('Missing claim');
    const current = f.getConfig();
    let calls = 0;
    f.deps.configNow = () => (++calls < 3 ? current : null);
    await expect(f.worker.complete(claim)).rejects.toMatchObject({ status: 409 });
    expect(calls).toBe(3);
    expect(
      (await pool.query('SELECT * FROM measurement_snapshots WHERE run_id=$1', [run.id])).rowCount,
    ).toBe(0);
    expect(
      (await pool.query('SELECT status FROM measurement_runs WHERE id=$1', [run.id])).rows[0]
        ?.status,
    ).toBe('running');
  });
  it('exact owner request replay preserves immutable pinned receipt set and conflicts on changed selection', async () => {
    const f = await seed(),
      requestId = randomUUID(),
      run = await f.queue([], requestId);
    await f.accept('population');
    const replay = await f.queue([], requestId);
    expect(replay.id).toBe(run.id);
    await expect(
      f.queue(
        f.grants.map((g) => g.producerId),
        requestId,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await f.worker.runOnce();
    expect(
      (await f.repository.getRun(member, f.wid, f.sid, run.id)).result?.assessment.blockers,
    ).toContain('population_missing');
  });
  it('source lifetime budget and pacing remain shared across exact fresh native bases', async () => {
    const f = await seed();
    await f.accept('population');
    const native = await freshGitHubBasis(f),
      { r, g } = f.report('population'),
      report = { ...r, eventId: randomUUID(), basis: native.context.basis };
    await acceptMeasurementReport(pool, f.deps, g, 'github', native.context.basis.runId, report);
    expect(
      (
        await pool.query(
          'SELECT retained_facts,rate_requests FROM measurement_source_budgets WHERE workspace_id=$1',
          [f.wid],
        )
      ).rows[0],
    ).toEqual({ retained_facts: 6, rate_requests: 2 });
    await pool.query(
      'UPDATE measurement_source_budgets SET retained_facts=5000,rate_requests=120 WHERE workspace_id=$1',
      [f.wid],
    );
    const next = await freshGitHubBasis(f);
    await expect(
      acceptMeasurementReport(pool, f.deps, g, 'github', next.context.basis.runId, {
        ...report,
        eventId: randomUUID(),
        basis: next.context.basis,
      }),
    ).rejects.toMatchObject({ status: 429 });
    await pool.query(
      "UPDATE measurement_source_budgets SET rate_started_at=clock_timestamp()-interval '61 seconds' WHERE workspace_id=$1",
      [f.wid],
    );
    await expect(
      acceptMeasurementReport(pool, f.deps, g, 'github', next.context.basis.runId, {
        ...report,
        eventId: randomUUID(),
        basis: next.context.basis,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it.each(['archive', 'enrichment'] as const)(
    'captured Argo %s credential revocation fences replay and completion',
    async (companion) => {
      const f = await seedArgo(companion);
      await acceptMeasurementReport(pool, f.deps, f.grant, 'argocd', f.fixture.runId, f.report);
      const run = await f.repository.enqueue(owner, f.wid, f.sid, {
          provider: 'argocd',
          basisRunId: f.fixture.runId,
          producerIds: [f.grant.producerId],
          requestId: randomUUID(),
        }),
        claim = await f.worker.claim();
      if (!claim) throw new Error('Missing claim');
      const current = f.argo;
      if (!current) throw new Error('Missing config');
      f.setArgo({
        ...current,
        ...(companion === 'archive' ? { archives: [] } : { producers: [] }),
      });
      await expect(
        acceptMeasurementReport(pool, f.deps, f.grant, 'argocd', f.fixture.runId, f.report),
      ).rejects.toMatchObject({ status: 409 });
      await expect(f.worker.complete(claim)).rejects.toMatchObject({ status: 409 });
      expect(
        (await pool.query('SELECT * FROM measurement_snapshots WHERE run_id=$1', [run.id]))
          .rowCount,
      ).toBe(0);
    },
  );
});

it('marks rotated authority receipts unavailable without hiding other valid capabilities', async () => {
  const f = await seed();
  await f.accept('population');
  await f.accept('classification');
  const old = f.report('population').g;
  const { source: oldSource, fingerprint: _fingerprint, tokenDigest, ...fields } = old;
  const { provider, ...source } = oldSource;
  const renamed = parseMeasurementGrant(
    { ...fields, provider, source, name: 'Renamed census' },
    tokenDigest,
  );
  f.setConfig({ grants: f.grants.map((g) => (g.producerId === old.producerId ? renamed : g)) });
  const listed = await f.repository.authorities(owner, f.wid, f.sid, 'github', f.fixture.runId);
  expect(listed.authorities.find((g) => g.producerId === old.producerId)).toBeUndefined();
  await expect(f.queue([old.producerId])).rejects.toMatchObject({ status: 409 });
  const classifier = f.report('classification').g;
  expect(
    listed.authorities.find((g) => g.producerId === classifier.producerId)?.receiptAvailable,
  ).toBe(true);
  await expect(
    f.repository.authorities(member, f.wid, f.sid, 'github', f.fixture.runId),
  ).rejects.toMatchObject({ status: 403 });
  await f.queue([classifier.producerId]);
  expect(await f.worker.runOnce()).toBe(true);
});
it.each(['projection', 'malformed', 'conflict'] as const)(
  'paces every authenticated %s attempt before expensive validation',
  async (mode) => {
    const f = await seed(),
      server = Fastify();
    registerMeasurementIngress(server, { pool, ...f.deps });
    const { r, g } = f.report('population');
    const base = `/api/measurement/bases/github/${f.fixture.runId}/producers/${g.producerId}`;
    const headers = { authorization: `Bearer ${f.tokens[0]}`, 'content-type': 'application/json' };
    let used = 0;
    try {
      if (mode === 'conflict') {
        await f.accept('population');
        used = 1;
      }
      for (let i = used; i < 120; i++) {
        const response =
          mode === 'projection'
            ? await server.inject({ url: base, headers })
            : await server.inject({
                method: 'POST',
                url: `${base}/reports`,
                headers,
                payload: mode === 'malformed' ? '{' : { ...r, eventId: randomUUID() },
              });
        expect(response.statusCode).toBe(
          mode === 'projection' ? 200 : mode === 'malformed' ? 400 : 409,
        );
      }
      const limited = await server.inject({ url: base, headers });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBe('60');
      expect(limited.json()).toEqual({ error: 'rate_limited' });
      expect(
        (await server.inject({ url: base, headers: { authorization: `Bearer ${'f'.repeat(64)}` } }))
          .statusCode,
      ).toBe(401);
      const stored = await pool.query(
        'SELECT retained_facts,rate_requests FROM measurement_source_budgets WHERE workspace_id=$1',
        [f.wid],
      );
      expect(stored.rows[0]).toEqual({
        retained_facts: mode === 'conflict' ? 3 : 0,
        rate_requests: 120,
      });
    } finally {
      await server.close();
    }
  },
  30000,
);
it('uses actual database receipt time and rejects basis cutoffs ahead of database clock', async () => {
  const client = await pool.connect();
  try {
    const observed = await receiverTime(client, '2000-01-01T00:00:00Z');
    expect(observed).toMatch(/^20/);
    await expect(receiverTime(client, '2999-01-01T00:00:00Z')).rejects.toMatchObject({
      status: 409,
    });
  } finally {
    client.release();
  }
});

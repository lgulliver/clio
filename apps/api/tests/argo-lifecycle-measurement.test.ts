import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveMeasurementEvidence, identity, type MeasurementGap } from '@clio/adapters';
import { calculate, type Dataset, oemsContract, validateSnapshot } from '@clio/oems';
import { afterEach, describe, expect, it } from 'vitest';
import { runLifecycleCli } from '../../../infra/argocd/evidence-demo/lifecycle-cli.ts';
import {
  buildLifecycleReports,
  lifecycleCapabilities,
} from '../../../infra/argocd/evidence-demo/lifecycle-measurement.ts';

/** Entire fixture fictional; controlled normalized exposure, not live coverage proof. */
function fixture() {
  const workspaceId = String(randomUUID()),
    serviceId = String(randomUUID()),
    applicationUid = String(randomUUID());
  const ledger = {
    contract: 'clio.sandbox.lifecycle.v1',
    workspaceId,
    serviceId,
    applicationUid,
    repositoryId: 'local:clio-lifecycle-app',
    startedAt: '2026-01-02T08:00:00Z',
    closedAt: '2026-01-03T00:00:00Z',
    operations: ['healthy', 'broken', 'recovery'].map((stage, i) => ({
      stage,
      operationId: String(randomUUID()),
      commitSha: String(i + 1).repeat(40),
      committedAt: `2026-01-02T${9 + i}:00:00Z`.replace('T9:', 'T09:'),
      effectiveAt: `2026-01-02T${9 + i}:01:00Z`.replace('T9:', 'T09:'),
      healthObservedAt: `2026-01-02T${9 + i}:${i === 1 ? '01' : '02'}:00Z`.replace('T9:', 'T09:'),
      healthStatus: [200, 503, 200][i],
      evidenceRef: `urn:fictional:receipt:${i}`,
    })),
  };
  const sourceId = identity('argocd', 'fictional-instance');
  const basis = {
    provider: 'argocd',
    runId: String(randomUUID()),
    sourceId,
    connectionRevision: 1,
    oemsRevision: String(oemsContract.revision),
    snapshotDigest: 'a'.repeat(64),
    evidenceDigest: 'b'.repeat(64),
    gapManifestDigest: 'c'.repeat(64),
  };
  const window = {
    start: '2026-01-02T00:00:00Z',
    end: ledger.closedAt,
    timezone: 'UTC' as const,
    calendar_days: 1,
  };
  const operations = ledger.operations.map((op) => ({
    sourceId,
    sourceDeploymentId: identity('application', applicationUid, 'operation', op.operationId),
    productionPath: 'fictional-production',
    qualification: 'qualifying',
    effectiveAt: op.effectiveAt,
    qualificationWindow: null,
  }));
  const gapManifest: MeasurementGap[] = [
    { gapId: 'fictional-transport-gap', sourceId, reason: 'transport_incomplete', bounds: null },
  ];
  const projection = {
    contract: 'clio.measurement.basis.v1',
    workspaceId,
    serviceId,
    basis,
    window,
    evidenceCutoff: '2026-01-05T00:00:00Z',
    operations,
    gapManifest,
  };
  const producers = lifecycleCapabilities.map((capability) => ({
    capability,
    producerId: String(randomUUID()),
    policyRef: `urn:fictional:${capability}`,
  }));
  const eventIds = Object.fromEntries(
    lifecycleCapabilities.map((capability) => [capability, String(randomUUID())]),
  );
  const review = {
    interval: { start: window.start, end: window.end },
    productionPath: operations[0]?.productionPath,
    historyEvidenceRef: 'urn:fictional:independent-history',
    populationEvidenceRef: 'urn:fictional:independent-census',
    recoveryEvidenceRef: 'urn:fictional:independent-recovery',
    gapResolutions: gapManifest.map((gap) => ({
      gap,
      scope: { start: window.start, end: window.end },
      evidenceRef: 'urn:fictional:independent-gap',
    })),
  };
  const nativeIndex = operations.map((op, i) => ({
    sourceId,
    sourceDeploymentId: op.sourceDeploymentId,
    productionPath: op.productionPath,
    deploymentId: `fictional-deployment-${i}`,
  }));
  const data: Dataset = {
    dataset_id: 'fictional-lifecycle',
    profile_version: '0.1-draft',
    snapshot_as_of_cutoff: true,
    window,
    evidence_cutoff: projection.evidenceCutoff,
    collection_complete: false,
    deployment_history_complete: false,
    recovery_evidence_complete: false,
    services: [
      {
        id: 'fictional-service',
        name: 'Fictional',
        source_refs: ['urn:fictional:service'],
        observed_at: projection.evidenceCutoff,
      },
    ],
    changes: [],
    incidents: [],
    deployments: nativeIndex.map((op, i) => ({
      id: op.deploymentId,
      service_id: 'fictional-service',
      rollout_group_id: op.deploymentId,
      environment: 'production',
      qualification: 'qualifying',
      effective_at: operations[i]?.effectiveAt ?? null,
      change_ids: [],
      failure: 'unknown',
      rework: 'unknown',
      observed_at: projection.evidenceCutoff,
      change_links_complete: false,
      qualification_window: null,
      source_refs: ['urn:fictional:native'],
      failure_evidence_refs: [],
      rework_evidence_refs: [],
    })),
  };
  const checked = validateSnapshot(data);
  if (!checked.ok) throw new Error('invalid fictional fixture');
  const snapshot = checked.data;
  function build(reviewed = false) {
    return buildLifecycleReports(
      ledger,
      projection,
      producers,
      eventIds,
      reviewed ? review : undefined,
    );
  }
  function measure(reviewed = false) {
    const reports = build(reviewed);
    return deriveMeasurementEvidence({
      basis: snapshot,
      context: {
        workspaceId,
        serviceId,
        canonicalServiceId: 'fictional-service',
        basis: { ...basis, provider: 'argocd' },
      },
      nativeIndex,
      gapManifest,
      authorityScopes: producers.map((p) => ({
        ...p,
        workspaceId,
        serviceId,
        basis: { ...basis, provider: 'argocd' },
        productionPaths: ['fictional-production'],
        repositoryIds: [ledger.repositoryId],
      })),
      reports: reports.map((report) => ({ report, observedAt: '2026-01-06T00:00:00Z' })),
      measurementCutoff: '2026-01-07T00:00:00Z',
    });
  }
  return { ledger, projection, producers, eventIds, review, build, measure };
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('bounded lifecycle reports', () => {
  it('defaults to three reports, absent history/population and bounded approximate causal recovery', () => {
    const f = fixture();
    expect(f.build()).toEqual(f.build());
    expect(f.build().map((r) => r.capability)).toEqual([
      'change_links',
      'classification',
      'recovery',
    ]);
    expect(f.build().find((r) => r.capability === 'change_links')?.payload.history).toBeNull();
    expect(f.build().find((r) => r.capability === 'recovery')?.payload).toMatchObject({
      interval: { start: f.ledger.startedAt, end: f.ledger.closedAt },
      episodes: [
        {
          sourceDeploymentId: f.projection.operations[1]?.sourceDeploymentId,
          approximate: true,
          onset: f.ledger.operations[1]?.effectiveAt,
          restored: f.ledger.operations[2]?.healthObservedAt,
        },
      ],
    });
    const result = f.measure();
    expect(result.metrics[0]?.deployment_frequency.status).toBe('provisional');
    expect(result.snapshot.data.collection_complete).toBe(false);
    expect(result.snapshot.data.deployment_history_complete).toBe(false);
    expect(result.snapshot.data.recovery_evidence_complete).toBe(false);
  });
  it('preserves later probe time and older commits while using approximate deployment-time onset', () => {
    const f = fixture();
    const broken = f.ledger.operations[1];
    const healthy = f.ledger.operations[0];
    if (!broken || !healthy) throw new Error('fixture');
    broken.healthObservedAt = '2026-01-02T10:02:00Z';
    healthy.committedAt = '2026-01-01T00:00:00Z';
    const reports = f.build();
    expect(reports.find((r) => r.capability === 'recovery')?.payload.episodes[0]).toMatchObject({
      onset: broken.effectiveAt,
      approximate: true,
    });
    expect(broken.healthObservedAt).toBe('2026-01-02T10:02:00Z');
    const metric = f.measure().metrics[0]?.failed_deployment_recovery_time;
    expect(metric?.median_seconds).toBeNull();
    expect(metric?.approximate_median_seconds).toBe(3660);
  });
  it('accepts equivalent timestamps and ignores gaps outside the reviewed interval', () => {
    const f = fixture();
    const healthy = f.ledger.operations[0];
    if (!healthy) throw new Error('fixture');
    healthy.effectiveAt = '2026-01-02T09:01:00.000Z';
    const irrelevant = {
      gapId: 'fictional-later-gap',
      sourceId: f.projection.basis.sourceId,
      reason: 'transport_incomplete',
      bounds: { start: '2026-01-03T00:00:00Z', end: '2026-01-04T00:00:00Z' },
    };
    f.projection.gapManifest.push(irrelevant);
    expect(f.measure(true).metrics[0]?.deployment_frequency.status).toBe('complete');
    f.review.gapResolutions.push({
      gap: irrelevant,
      scope: irrelevant.bounds,
      evidenceRef: 'urn:fictional:unrelated-gap',
    });
    expect(() => f.build(true)).toThrow('measurement_lifecycle_gap_copy');
  });
  it('passes reviewed census through actual OEMS; approximate onset never becomes exact recovery', () => {
    const f = fixture(),
      result = f.measure(true),
      metrics = calculate(result.snapshot)[0];
    expect(f.build(true).find((r) => r.capability === 'population')?.evidenceRef).toBe(
      f.review.populationEvidenceRef,
    );
    expect(metrics?.deployment_frequency).toMatchObject({ status: 'complete', count: 3 });
    expect(metrics?.change_fail_rate).toMatchObject({ status: 'complete', ratio: 1 / 3 });
    expect(metrics?.deployment_rework_rate).toMatchObject({ status: 'complete', ratio: 1 / 3 });
    expect(metrics?.change_lead_time).toMatchObject({
      status: 'complete',
      observation_count: 3,
      median_seconds: 60,
    });
    expect(metrics?.failed_deployment_recovery_time).toMatchObject({
      status: 'provisional',
      median_seconds: null,
      approximate_count: 1,
      approximate_median_seconds: 3660,
    });
    expect(result.snapshot.data.changes.map((c) => c.committed_at).sort()).toEqual(
      f.ledger.operations.map((op) => op.committedAt).sort(),
    );
  });
  it.each([
    'extra',
    'scope',
    'stage',
    'status',
    'order',
    'future',
    'duplicate-id',
    'duplicate-sha',
    'duplicate-ref',
    'invalid-time',
    'invalid-uuid',
    'unknown-field',
  ])('rejects ledger %s', (kind) => {
    const f = fixture(),
      op = f.ledger.operations[1];
    if (!op) throw new Error('fixture');
    switch (kind) {
      case 'extra':
        f.ledger.operations.push({ ...op });
        break;
      case 'scope':
        f.ledger.workspaceId = String(randomUUID());
        break;
      case 'stage':
        op.stage = 'healthy';
        break;
      case 'status':
        op.healthStatus = 200;
        break;
      case 'order':
        op.effectiveAt = '2026-01-02T09:01:00Z';
        break;
      case 'future':
        f.ledger.closedAt = '2999-01-01T00:00:00Z';
        break;
      case 'duplicate-id':
        op.operationId = f.ledger.operations[0]?.operationId ?? '';
        break;
      case 'duplicate-sha':
        op.commitSha = f.ledger.operations[0]?.commitSha ?? '';
        break;
      case 'duplicate-ref':
        op.evidenceRef = f.ledger.operations[0]?.evidenceRef ?? '';
        break;
      case 'invalid-time':
        op.committedAt = '2026-02-30T00:00:00Z';
        break;
      case 'invalid-uuid':
        op.operationId = 'x';
        break;
      case 'unknown-field':
        Object.assign(op, { guessed: true });
        break;
    }
    expect(() => f.build()).toThrow();
  });
  it.each([
    'unknown-id',
    'extra',
    'effective',
    'source',
    'qualification',
    'path',
    'pin',
    'cutoff',
    'service',
    'window',
  ])('rejects native projection %s', (kind) => {
    const f = fixture(),
      op = f.projection.operations[0];
    if (!op) throw new Error('fixture');
    switch (kind) {
      case 'unknown-id':
        op.sourceDeploymentId = 'guessed';
        break;
      case 'extra':
        f.projection.operations.push({ ...op });
        break;
      case 'effective':
        op.effectiveAt = '2026-01-02T09:01:01Z';
        break;
      case 'source':
        op.sourceId = 'foreign';
        break;
      case 'qualification':
        op.qualification = 'unknown';
        break;
      case 'path':
        op.productionPath = 'foreign';
        break;
      case 'pin':
        f.projection.basis.oemsRevision = 'foreign';
        break;
      case 'cutoff':
        f.projection.evidenceCutoff = '2026-01-02T11:00:00Z';
        break;
      case 'service':
        f.projection.serviceId = String(randomUUID());
        break;
      case 'window':
        f.projection.window.calendar_days = 2;
        break;
    }
    expect(() => f.build()).toThrow();
  });
  it.each([
    'start',
    'end',
    'future',
    'path',
    'omitted',
    'extra',
    'copy',
    'scope',
    'ref',
    'envelope-ref',
    'manifest',
  ])('rejects coverage review %s', (kind) => {
    const f = fixture(),
      resolution = f.review.gapResolutions[0];
    if (!resolution) throw new Error('fixture');
    switch (kind) {
      case 'start':
        f.review.interval.start = f.ledger.startedAt;
        break;
      case 'end':
        f.review.interval.end = '2026-01-02T23:00:00Z';
        break;
      case 'future':
        f.review.interval.end = '2026-01-04T00:00:00Z';
        break;
      case 'path':
        f.review.productionPath = 'foreign';
        break;
      case 'omitted':
        f.review.gapResolutions = [];
        break;
      case 'extra':
        f.review.gapResolutions.push({ ...resolution });
        break;
      case 'copy':
        resolution.gap = { ...resolution.gap, reason: 'invented' };
        break;
      case 'scope':
        resolution.scope.start = f.ledger.startedAt;
        break;
      case 'ref':
        resolution.evidenceRef = f.review.historyEvidenceRef;
        break;
      case 'envelope-ref':
        f.review.historyEvidenceRef = `urn:clio:sandbox:lifecycle:report:${f.eventIds.change_links}`;
        break;
      case 'manifest':
        Object.assign(f.projection, { gapManifest: null });
        break;
    }
    expect(() => f.build(true)).toThrow();
  });
  it('matches copied gaps irrespective of JSON property order and honors bounded gap scope', () => {
    const f = fixture(),
      gap = f.projection.gapManifest[0];
    if (!gap) throw new Error('fixture');
    gap.bounds = Object.assign({}, { start: '2026-01-02T10:00:00Z', end: '2026-01-02T10:01:00Z' });
    f.review.gapResolutions = [
      {
        gap: { bounds: gap.bounds, reason: gap.reason, sourceId: gap.sourceId, gapId: gap.gapId },
        scope: gap.bounds,
        evidenceRef: 'urn:fictional:bounded-resolution',
      },
    ];
    expect(f.build(true)).toHaveLength(4);
  });
  it('rejects duplicate producers, duplicate events, missing capabilities and unknown descriptors', () => {
    for (const kind of ['producer', 'event', 'capability', 'unknown']) {
      const f = fixture(),
        p = f.producers[1];
      if (!p) throw new Error('fixture');
      if (kind === 'producer') p.producerId = f.producers[0]?.producerId ?? '';
      if (kind === 'event') Object.assign(f.eventIds, { recovery: f.eventIds.classification });
      if (kind === 'capability') p.capability = 'population';
      if (kind === 'unknown') Object.assign(p, { token: 'must-not-accept' });
      expect(() => f.build()).toThrow();
    }
  });
  it('refuses output beneath real Git ancestors before reading private inputs', async () => {
    await expect(
      runLifecycleCli([
        '/missing-ledger',
        '/missing-basis',
        '/missing-producers',
        join(process.cwd(), 'forbidden'),
      ]),
    ).rejects.toThrow('lifecycle_output_inside_git');
    await expect(
      runLifecycleCli(['/missing-ledger', '/missing-basis', '/missing-producers', 'relative']),
    ).rejects.toThrow('invalid_lifecycle_path');
    await expect(runLifecycleCli([])).rejects.toThrow('usage:');
  });
  it('writes exclusive private output; retained event IDs survive replay; refuses Git, symlink, reuse, oversized JSON', async (context) => {
    let directory: string;
    try {
      directory = await mkdtemp('/var/tmp/clio-lifecycle-');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EROFS') {
        context.skip(
          'Sandbox has no writable temporary directory outside Git; CLI filesystem acceptance requires coordinator run.',
        );
        return;
      }
      throw error;
    }
    directories.push(directory);
    const f = fixture();
    const inputs = ['ledger', 'basis', 'producers'];
    const values = [f.ledger, f.projection, f.producers];
    await Promise.all(
      inputs.map((name, i) =>
        writeFile(join(directory, `${name}.json`), JSON.stringify(values[i]), { mode: 0o600 }),
      ),
    );
    const args = inputs.map((name) => join(directory, `${name}.json`));
    const output = join(directory, 'reports');
    const paths = await runLifecycleCli([...args, output]);
    expect(paths).toHaveLength(3);
    expect((await lstat(output)).mode & 0o777).toBe(0o700);
    for (const path of paths) expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const retained = await readFile(paths[0] ?? '', 'utf8');
    await expect(runLifecycleCli([...args, output])).rejects.toThrow();
    expect(await readFile(paths[0] ?? '', 'utf8')).toBe(retained);
    const link = join(directory, 'linked');
    await symlink(directory, link);
    await expect(runLifecycleCli([...args, join(link, 'reports2')])).rejects.toThrow();
    const inputLink = join(directory, 'linked.json');
    await symlink(args[0] ?? '', inputLink);
    await expect(
      runLifecycleCli([inputLink, ...args.slice(1), join(directory, 'reports2')]),
    ).rejects.toThrow();
    await writeFile(args[0] ?? '', ' '.repeat(65537));
    await expect(runLifecycleCli([...args, join(directory, 'reports2')])).rejects.toThrow();
    await mkdir(join(directory, '.git'));
    await expect(runLifecycleCli([...args, join(directory, 'reports2')])).rejects.toThrow();
  });
});

import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveMeasurementEvidence } from '@clio/adapters';
import { calculate, oemsContract, validateSnapshot } from '@clio/oems';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  authorityScope,
  credentialDigest,
  parseMeasurementGrant,
  readMeasurementConfig,
  sourceScope,
} from '../src/features/measurements/config.ts';
import {
  basisProjection,
  registerMeasurementIngress,
  reportFacts,
} from '../src/features/measurements/ingress.ts';
import {
  encodeCursor,
  enqueueInput,
  historyCursor,
  parseJobInput,
} from '../src/features/measurements/input.ts';
import { readNativeMeasurementBasis } from '../src/features/measurements/native-basis.ts';
import { parseMeasurementResult } from '../src/features/measurements/result.ts';
import { argoFixture, evidenceFixture } from './measurement-fixture.ts';

function resultFixture(historyUnknown = false) {
  const f = evidenceFixture(),
    cutoff = '2026-01-07T00:00:00Z';
  const derived = deriveMeasurementEvidence({
    basis: f.native.snapshot,
    context: f.native.context,
    nativeIndex: f.native.nativeIndex,
    gapManifest: f.native.gapManifest,
    authorityScopes: f.grants.map((g) => authorityScope(g, f.native.context.basis)),
    reports: f.reports.map((report) => ({ report, observedAt: '2026-01-06T00:00:00Z' })),
    measurementCutoff: cutoff,
  });
  let metrics = derived.metrics;
  if (historyUnknown) {
    const data = { ...derived.snapshot.data, deployments: [...derived.snapshot.data.deployments] },
      first = data.deployments[0];
    if (!first) throw new Error('Missing fixture deployment');
    data.deployments.push({
      ...first,
      id: `${first.id}:prewindow-unknown`,
      rollout_group_id: `${first.rollout_group_id}:prewindow-unknown`,
      qualification: 'unknown',
      effective_at: null,
      qualification_window: { start: '2025-12-30T00:00:00Z', end: '2025-12-31T00:00:00Z' },
      change_ids: [],
      change_links_complete: false,
      failure: 'unknown',
      rework: 'unknown',
      failure_evidence_refs: [],
      rework_evidence_refs: [],
    });
    const validated = validateSnapshot(data);
    if (!validated.ok) throw new Error('Invalid unknown-history fixture');
    metrics = calculate(validated.data);
  }
  return {
    contract: 'clio.measurement.result.v1',
    workspaceId: f.fixture.workspaceId,
    serviceId: f.fixture.serviceId,
    provider: 'github',
    basisRunId: f.fixture.runId,
    connectionRevision: 1,
    oemsRevision: oemsContract.revision,
    window: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-03T00:00:00.000Z',
      timezone: 'UTC',
      calendarDays: 2,
    },
    basisEvidenceCutoff: f.native.snapshot.data.evidence_cutoff,
    evidenceCutoff: cutoff,
    assessment: derived.assessment,
    coverage: {
      collectionComplete: derived.assessment.collectionComplete,
      deploymentHistoryComplete: derived.assessment.historyComplete,
      recoveryEvidenceComplete: derived.assessment.recoveryComplete,
    },
    metricResult: metrics[0],
  };
}
describe('bounded measurement boundary', () => {
  it('parses complete five-metric results without native false-coverage restriction', () => {
    const result = parseMeasurementResult(resultFixture());
    expect(result.assessment).toEqual({
      blockers: [],
      collectionComplete: true,
      historyComplete: true,
      recoveryComplete: true,
    });
    for (const metric of [
      result.metricResult.deployment_frequency,
      result.metricResult.change_lead_time,
      result.metricResult.change_fail_rate,
      result.metricResult.deployment_rework_rate,
      result.metricResult.failed_deployment_recovery_time,
    ])
      expect(metric.status).toBe('complete');
  });
  it('retains pinned history-quality blocker despite independently complete history coverage', () => {
    const parsed = parseMeasurementResult(resultFixture(true));
    expect(parsed.coverage.deploymentHistoryComplete).toBe(true);
    expect(parsed.metricResult.deployment_frequency.status).toBe('complete');
    expect(parsed.metricResult.change_lead_time.status).toBe('provisional');
    expect(parsed.metricResult.change_lead_time.quality_reasons).toContain('incomplete_history');
  });
  it('rejects private fields, foreign contexts and coverage contradictions', () => {
    const result = resultFixture();
    for (const changed of [
      { ...result, snapshot: {} },
      { ...result, metricResult: { ...result.metricResult, source_refs: ['secret'] } },
      { ...result, serviceId: randomUUID() },
      { ...result, evidenceCutoff: '2026-01-08T00:00:00Z' },
      { ...result, basisEvidenceCutoff: result.evidenceCutoff },
      { ...result, basisEvidenceCutoff: '2025-12-31T00:00:00Z' },
      { ...result, coverage: { ...result.coverage, collectionComplete: false } },
    ])
      expect(() => parseMeasurementResult(changed)).toThrow();
  });
  it('projects only precise native assertions and exact retained gaps', () => {
    const f = evidenceFixture(),
      projection = basisProjection({
        ...f.native,
        source: { provider: 'github', installationId: 10, repositoryId: 20 },
        sourceScope: 'fixture',
        productionPath: f.fixture.productionPath,
        nativeFingerprint: 'a'.repeat(64),
        capture: f.fixture.capture,
        eligibilityFingerprint: 'b'.repeat(64),
      });
    expect(projection.operations).toHaveLength(2);
    expect(projection.gapManifest).toEqual([]);
    for (const key of [
      'evidence',
      'snapshot',
      'grant',
      'fingerprint',
      'policyRef',
      'repositoryName',
    ])
      expect(JSON.stringify(projection)).not.toContain(`"${key}"`);
  });
  it('counts report overhead and nested changes in shared fact budget', () => {
    const f = evidenceFixture();
    expect(f.reports.map(reportFacts)).toEqual([3, 6, 3, 2]);
  });
  it('pins exact enqueue fields; rejects client authority/digest/window injection', () => {
    const body = {
      requestId: randomUUID(),
      provider: 'github',
      basisRunId: randomUUID(),
      producerIds: [randomUUID()],
    };
    expect(enqueueInput(body)).toEqual(body);
    for (const key of ['authorityScopes', 'window', 'metrics', 'cutoff', 'digest'])
      expect(() => enqueueInput({ ...body, [key]: {} })).toThrow();
    expect(() =>
      enqueueInput({ ...body, producerIds: [body.producerIds[0], body.producerIds[0]] }),
    ).toThrow();
  });
  it('rejects malformed/noncanonical cursors and preserves microsecond ordering', () => {
    const cursor = { createdAt: '2026-01-01T00:00:00.123456Z', id: randomUUID() };
    expect(historyCursor(encodeCursor(cursor.createdAt, cursor.id))).toEqual(cursor);
    for (const value of [
      '',
      {},
      'bad=',
      Buffer.from(JSON.stringify({ ...cursor, extra: 1 })).toString('base64url'),
    ])
      expect(() => historyCursor(value)).toThrow();
  });
  it('rejects invalid private job inputs and duplicate selected identities', () => {
    const f = evidenceFixture();
    const job = {
      version: 1,
      workspaceId: f.fixture.workspaceId,
      serviceId: f.fixture.serviceId,
      basis: f.native.context.basis,
      sourceScope: sourceScope(
        f.grants[0]?.source ?? { provider: 'github', installationId: 10, repositoryId: 20 },
      ),
      nativeFingerprint: 'a'.repeat(64),
      window: {
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-03T00:00:00.000Z',
        timezone: 'UTC',
        calendarDays: 2,
      },
      producerPins: [],
      receipts: [],
    };
    expect(parseJobInput(job)).toEqual(job);
    expect(() => parseJobInput({ ...job, basis: { ...job.basis, snapshotDigest: 'x' } })).toThrow();
    expect(() =>
      parseJobInput({
        ...job,
        receipts: [{ id: randomUUID(), digest: 'a'.repeat(64), producerId: randomUUID() }],
      }),
    ).toThrow();
  });
  it('authenticates machine onRequest before invalid JSON parsing; cookies irrelevant', async () => {
    const server = Fastify(),
      pool = new Pool();
    registerMeasurementIngress(server, {
      pool,
      configNow: () => null,
      githubNow: () => null,
      argoNow: () => null,
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: `/api/measurement/bases/github/${randomUUID()}/producers/${randomUUID()}/reports`,
        headers: { 'content-type': 'application/json', cookie: 'session=fictional' },
        payload: '{',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await server.close();
      await pool.end();
    }
  });
  it('scope fingerprint changes on policy/path/repository/name/token/source edits; lifetime key does not rotate', () => {
    const f = evidenceFixture(),
      grant = f.grants[0];
    if (!grant) throw new Error('Missing fixture');
    const raw = {
      workspaceId: grant.workspaceId,
      serviceId: grant.serviceId,
      provider: 'github',
      source: { installationId: 10, repositoryId: 20 },
      producerId: grant.producerId,
      capability: grant.capability,
      name: grant.name,
      policyRef: grant.policyRef,
      productionPaths: grant.productionPaths,
      repositoryIds: grant.repositoryIds,
    };
    for (const change of [
      { name: 'renamed' },
      { policyRef: 'rotated' },
      { productionPaths: ['other'] },
      { repositoryIds: ['git:other'] },
      { source: { installationId: 10, repositoryId: 21 } },
    ])
      expect(parseMeasurementGrant({ ...raw, ...change }, grant.tokenDigest).fingerprint).not.toBe(
        grant.fingerprint,
      );
    const rotated = parseMeasurementGrant(raw, 'f'.repeat(64));
    expect(rotated.fingerprint).not.toBe(grant.fingerprint);
    expect(sourceScope(rotated.source)).toBe(sourceScope(grant.source));
    expect(() => parseMeasurementGrant({ ...raw, name: 'bad\nname' }, grant.tokenDigest)).toThrow();
  });
  it('loads optional private configuration and rejects empty, public, symlink and Git files', async () => {
    expect(await readMeasurementConfig({})).toBeNull();
    await expect(readMeasurementConfig({ CLIO_MEASUREMENT_GRANTS_FILE: '' })).rejects.toThrow(
      'Invalid measurement configuration',
    );
    const dir = await mkdtemp(join(tmpdir(), 'clio-measurement-'));
    try {
      const token = join(dir, 'token'),
        config = join(dir, 'grants');
      await writeFile(token, `${'a'.repeat(64)}\n`, { mode: 0o600 });
      const f = evidenceFixture(),
        g = f.grants[0];
      if (!g) throw new Error('Missing fixture');
      const raw = {
        workspaceId: g.workspaceId,
        serviceId: g.serviceId,
        provider: 'github',
        source: { installationId: 10, repositoryId: 20 },
        producerId: g.producerId,
        capability: g.capability,
        name: g.name,
        policyRef: g.policyRef,
        productionPaths: g.productionPaths,
        repositoryIds: g.repositoryIds,
        tokenFile: token,
      };
      await writeFile(config, JSON.stringify([raw]), { mode: 0o600 });
      const loaded = await readMeasurementConfig({ CLIO_MEASUREMENT_GRANTS_FILE: config });
      expect(loaded?.grants[0]?.tokenDigest).toBe(credentialDigest('a'.repeat(64)));
      expect(JSON.stringify(loaded)).not.toContain('a'.repeat(64));
      await chmod(token, 0o644);
      await expect(readMeasurementConfig({ CLIO_MEASUREMENT_GRANTS_FILE: config })).rejects.toThrow(
        'Invalid measurement configuration',
      );
      await chmod(token, 0o600);
      const link = join(dir, 'link');
      await symlink(config, link);
      await expect(readMeasurementConfig({ CLIO_MEASUREMENT_GRANTS_FILE: link })).rejects.toThrow(
        'Invalid measurement configuration',
      );
      await writeFile(join(dir, '.git'), 'gitdir: /fictional');
      await expect(readMeasurementConfig({ CLIO_MEASUREMENT_GRANTS_FILE: config })).rejects.toThrow(
        'Invalid measurement configuration',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('empty exhaustive evidence and pre-window recovery use actual capture and engine', () => {
    for (const [empty, prewindow] of [
      [true, false],
      [false, true],
    ]) {
      const f = evidenceFixture(empty, prewindow),
        derived = deriveMeasurementEvidence({
          basis: f.native.snapshot,
          context: f.native.context,
          nativeIndex: f.native.nativeIndex,
          gapManifest: f.native.gapManifest,
          authorityScopes: f.grants.map((g) => authorityScope(g, f.native.context.basis)),
          reports: f.reports.map((report) => ({ report, observedAt: '2026-01-06T00:00:00Z' })),
          measurementCutoff: '2026-01-07T00:00:00Z',
        });
      expect(derived.assessment).toEqual({
        blockers: [],
        collectionComplete: true,
        historyComplete: true,
        recoveryComplete: true,
      });
      if (empty)
        expect(derived.metrics[0]?.deployment_frequency).toMatchObject({
          status: 'complete',
          count: 0,
        });
      else
        expect(derived.metrics[0]?.failed_deployment_recovery_time).toMatchObject({
          status: 'complete',
          observation_count: 1,
          median_seconds: 172800,
        });
    }
  });
  it('native Argo exact gap inventory stays unknown with no independent authority', () => {
    const fixture = argoFixture(),
      native = readNativeMeasurementBasis(fixture),
      derived = deriveMeasurementEvidence({
        basis: native.snapshot,
        context: native.context,
        nativeIndex: native.nativeIndex,
        gapManifest: native.gapManifest,
        authorityScopes: [],
        reports: [],
        measurementCutoff: '2026-01-07T00:00:00Z',
      });
    expect(native.gapManifest).toHaveLength(1);
    expect(native.nativeIndex).toHaveLength(1);
    expect(derived.metrics[0]?.deployment_frequency.status).toBe('provisional');
    expect(derived.metrics[0]?.qualification_unknown_count).toBe(1);
    expect(derived.assessment.collectionComplete).toBe(false);
  });
});

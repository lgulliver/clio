import { randomUUID } from 'node:crypto';
import {
  type ArgoEnrichmentEvidence,
  type ArgoEnrichmentScope,
  parseArgoNotification,
} from '@clio/adapters';
import { expect, it } from 'vitest';
import { captureArgo } from '../src/features/argo-collection/capture.ts';
import { enrichmentCaptureReserve } from '../src/features/argo-collection/enrichment-budget.ts';
import { boundedJson, maxBytes } from '../src/features/argo-collection/history.ts';
import { type ArgoConnection, windowInput } from '../src/features/argo-collection/input.ts';
import { parseResult } from '../src/features/argo-collection/result.ts';
import { snapshotDigest } from '../src/features/github-collection/digest.ts';
import { grantFixture } from './argo-fixture.ts';

function fixture(minimal = false) {
  const scope = {
      ...grantFixture(),
      ...(minimal
        ? {
            instance: 'a',
            applicationUid: 'a',
            applicationName: 'a',
            applicationNamespace: 'a',
            project: 'a',
            destinationClusterId: 'a',
            destinationServer: 'a',
            destinationNamespace: 'a',
            configurationRepositoryId: 'a',
            repoURL: 'a',
            environment: 'a',
          }
        : {}),
    },
    operationId = randomUUID();
  const producer: ArgoEnrichmentScope = {
    ...scope,
    producerId: randomUUID(),
    capability: 'consumer_exposure',
    policyReference: 'urn:fictional:traffic:v1',
    repositoryIds: [],
  };
  const buildProducer: ArgoEnrichmentScope = {
    ...scope,
    producerId: randomUUID(),
    capability: 'application_provenance',
    policyReference: 'urn:fictional:build:v1',
    repositoryIds: ['github:fictional/app'],
  };
  const connection: ArgoConnection = {
    workspaceId: scope.workspaceId,
    serviceId: scope.serviceId,
    mode: 'live',
    provider: 'argocd',
    revision: 1,
    active: true,
    sourceId: scope.sourceId,
    applicationName: scope.applicationName,
    applicationNamespace: scope.applicationNamespace,
    instance: scope.instance,
    productionEnvironment: scope.environment,
    exposurePolicyReference: null,
    applicationOperationsBelongToService: true,
    observedAt: '2026-01-01T00:00:00Z',
    enrichmentProducers: [producer, buildProducer]
      .map((p) => ({
        producerId: p.producerId,
        capability: p.capability,
        policyReference: p.policyReference,
      }))
      .sort((a, b) => a.producerId.localeCompare(b.producerId)),
  };
  const parseNative = (operationId: string) =>
    parseArgoNotification(
      {
        contract: 'clio.argocd.notification.v1',
        application: {
          uid: scope.applicationUid,
          name: scope.applicationName,
          namespace: scope.applicationNamespace,
          project: scope.project,
          destination: {
            server: scope.destinationServer,
            name: null,
            namespace: scope.destinationNamespace,
          },
          repoURL: scope.repoURL,
          hasSources: false,
          hasSourceHydrator: false,
        },
        operation: {
          phase: 'Failed',
          startedAt: '2026-01-02T10:00:00Z',
          finishedAt: '2026-01-02T10:05:00Z',
          retryCount: 0,
          info: [
            { name: 'clio.operation-id', value: operationId },
            { name: 'clio.operation-kind', value: 'rollout' },
          ],
          initiatedBy: { username: 'fictional', automated: false },
          revision: 'gitops-v1',
          revisions: [],
        },
        health: { status: 'Degraded', lastTransitionTime: '2026-01-02T10:05:00Z' },
      },
      scope,
      '2026-01-02T10:06:00Z',
    );
  const parsed = parseNative(operationId);
  if (parsed.kind !== 'operation') throw new Error('Invalid fixture');
  const artifact = `sha256:${'a'.repeat(64)}`;
  const exposure: ArgoEnrichmentEvidence = {
    scope: producer,
    observedAt: '2026-01-03T11:00:00Z',
    sourceRef: 'urn:fictional:exposure-receipt',
    event: {
      contract: 'clio.argocd.enrichment.v1',
      event_id: randomUUID(),
      source_id: scope.sourceId,
      producer_id: producer.producerId,
      policy_reference: producer.policyReference,
      evidence_ref: 'urn:fictional:traffic-proof',
      kind: 'consumer_exposure',
      application_uid: scope.applicationUid,
      operation_id: operationId,
      configuration_revision: 'gitops-v1',
      effective_at: '2026-01-02T10:02:00Z',
      subject: { kind: 'artifact', digest: artifact },
    },
  };
  const build: ArgoEnrichmentEvidence = {
    scope: buildProducer,
    observedAt: '2026-01-04T11:00:00Z',
    sourceRef: 'urn:fictional:build-receipt',
    event: {
      contract: 'clio.argocd.enrichment.v1',
      event_id: randomUUID(),
      source_id: scope.sourceId,
      producer_id: buildProducer.producerId,
      policy_reference: buildProducer.policyReference,
      evidence_ref: 'urn:fictional:build-proof',
      kind: 'application_provenance',
      repository_id: 'github:fictional/app',
      commit_sha: 'b'.repeat(40),
      artifact_digest: artifact,
    },
  };
  const input = {
    runId: randomUUID(),
    connection,
    serviceName: 'Fictional service',
    window: windowInput({ start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' }),
    evidence: parsed.evidence,
    databaseObservedAt: '2026-01-05T00:00:00Z',
    stats: {
      retainedReceiptCount: 1,
      retainedEvidenceCount: 2,
      recordedGapCount: 0,
      gapReasons: {},
      rejectionCount: 0,
      scopeDriftCount: 0,
      observationPeriod: { start: '2026-01-02T10:06:00Z', end: '2026-01-05T00:00:00Z' },
    },
  };
  return { input, exposure, build, parseNative };
}
it('API capture calculates all five metrics with independent Failed exposure, preserves native truth and hashes separate evidence', () => {
  const f = fixture();
  const native = captureArgo(f.input),
    exposed = captureArgo({ ...f.input, argoEnrichments: [f.exposure] }),
    joined = captureArgo({ ...f.input, argoEnrichments: [f.exposure, f.build] });
  expect(native.result.qualifyingCount).toBe(0);
  expect(exposed.result).toMatchObject({
    qualifyingCount: 1,
    enrichmentSummary: { consumerExposureCount: 1, applicationProvenanceCount: 0 },
  });
  expect(joined.evidence.statuses[0]?.consumerExposure).toBe(false);
  expect(joined.evidence.deployments[0]?.repository).toBeNull();
  expect(joined.evidence.argoEnrichments).toHaveLength(2);
  expect(snapshotDigest(joined)).not.toBe(snapshotDigest(exposed));
  expect(joined.snapshot.deployments[0]?.effective_at).toBe('2026-01-02T10:02:00Z');
  expect(joined.snapshot.deployments[0]?.failure).toBe('unknown');
  expect(joined.snapshot.changes).toEqual([]);
  expect(joined.metrics[0]).toMatchObject({
    deployment_frequency: { count: 1, deployments_per_day: null },
    change_lead_time: { median_seconds: null },
    change_fail_rate: { ratio: null },
    deployment_rework_rate: { ratio: null },
    failed_deployment_recovery_time: { median_seconds: null },
  });
  expect(JSON.stringify(joined.result)).not.toContain('urn:fictional:traffic-proof');
  expect(JSON.stringify(joined.result)).not.toContain('urn:fictional:build-proof');
});
it('build-only inventory never qualifies native operation; configuration exposure attaches no application provenance', () => {
  const f = fixture();
  expect(captureArgo({ ...f.input, argoEnrichments: [f.build] }).result.qualifyingCount).toBe(0);
  if (f.exposure.event.kind !== 'consumer_exposure') throw new Error('Invalid exposure');
  const configuration: ArgoEnrichmentEvidence = {
    ...f.exposure,
    event: { ...f.exposure.event, subject: { kind: 'configuration', revision: 'gitops-v1' } },
  };
  const result = captureArgo({ ...f.input, argoEnrichments: [configuration, f.build] });
  expect(result.result.qualifyingCount).toBe(1);
  expect(JSON.stringify(result.snapshot)).not.toContain('artifact_source_provenance');
});
it('capture rejects observations after cutoff; historical result fields default only when absent', () => {
  const f = fixture();
  expect(() =>
    captureArgo({
      ...f.input,
      argoEnrichments: [{ ...f.build, observedAt: '2026-01-06T00:00:00Z' }],
    }),
  ).toThrow('Evidence observed after acquisition');
  const result = captureArgo(f.input).result;
  const { enrichmentSummary: _summary, ...legacy } = result;
  expect(parseResult(legacy, f.input.connection, f.input.window).enrichmentSummary).toBeUndefined();
  expect(() =>
    parseResult({ ...legacy, enrichmentSummary: null }, f.input.connection, f.input.window),
  ).toThrow();
  expect(() =>
    parseResult(
      { ...result, enrichmentSummary: { ...result.enrichmentSummary, extra: 'private' } },
      f.input.connection,
      f.input.window,
    ),
  ).toThrow();
});

it('captures full row budget of agreeing artifact assertions without quadratic reference expansion', () => {
  const f = fixture();
  // Native receipt/deployment/status = 3 rows; one subject and artifact lock = 2 rows.
  const assertions = [
    ...Array.from({ length: 2497 }, () => f.exposure),
    ...Array.from({ length: 2498 }, () => f.build),
  ].map((entry) => {
    const event = { ...entry.event, event_id: randomUUID() };
    return {
      ...entry,
      event,
      sourceRef: `urn:clio:argo-enrichment:${entry.scope.sourceId}:${entry.scope.producerId}:${event.event_id}`,
    };
  });
  const start = performance.now();
  const capture = captureArgo({ ...f.input, argoEnrichments: assertions });
  expect(capture.result.qualifyingCount).toBe(1);
  expect(capture.result.enrichmentSummary?.retainedReceiptCount).toBe(4995);
  expect(capture.evidence.argoEnrichments).toHaveLength(4995);
  expect(Buffer.byteLength(boundedJson(capture), 'utf8')).toBeLessThanOrEqual(maxBytes);
  expect(performance.now() - start).toBeLessThan(5000);
  expect(capture.evidence.argoEnrichmentScopes).toHaveLength(2);
  expect(capture.evidence.argoEnrichmentScopes).toEqual(
    expect.arrayContaining([f.exposure.scope, f.build.scope]),
  );
  expect(new Set(capture.evidence.argoEnrichments.map((entry) => entry.event.event_id)).size).toBe(
    4995,
  );
});

it('captures repeated rollouts of one artifact with a shared complete provenance assertion set', () => {
  const f = fixture();
  const operations = Array.from({ length: 899 }, () => randomUUID());
  const batches = operations.map((operation) => {
    const parsed = f.parseNative(operation);
    if (parsed.kind !== 'operation') throw new Error('Invalid native fixture');
    return parsed.evidence;
  });
  const exposures = operations.map((operation) => {
    if (f.exposure.event.kind !== 'consumer_exposure') throw new Error('Invalid exposure');
    const event = { ...f.exposure.event, operation_id: operation, event_id: randomUUID() };
    return {
      ...f.exposure,
      event,
      sourceRef: `urn:clio:argo-enrichment:${event.source_id}:${event.producer_id}:${event.event_id}`,
    };
  });
  const builds = Array.from({ length: 500 }, (_, index) => {
    const event = {
      ...f.build.event,
      event_id: randomUUID(),
      evidence_ref: `urn:fixture:build:${index.toString().padStart(182, 'x')}`,
    };
    return {
      ...f.build,
      event,
      sourceRef: `urn:clio:argo-enrichment:${event.source_id}:${event.producer_id}:${event.event_id}`,
    };
  });
  // 899 native triples + 899 exposure/subject pairs + 500 builds + one digest lock = 4996 rows.
  const start = performance.now();
  const capture = captureArgo({
    ...f.input,
    evidence: {
      deployments: batches.flatMap((batch) => batch.deployments),
      statuses: batches.flatMap((batch) => batch.statuses),
    },
    argoEnrichments: [...exposures, ...builds],
    stats: { ...f.input.stats, retainedReceiptCount: 899, retainedEvidenceCount: 1798 },
  });
  expect(capture.result.qualifyingCount).toBe(899);
  expect(capture.evidence.argoEnrichments).toHaveLength(1399);
  expect(Buffer.byteLength(boundedJson(capture))).toBeLessThanOrEqual(maxBytes);
  expect(performance.now() - start).toBeLessThan(5000);
  const registry = capture.snapshot.services[0]?.extensions?.argo_artifact_provenance;
  expect(registry).toEqual([
    expect.objectContaining({
      assertions: expect.arrayContaining(
        builds.map((entry) =>
          expect.objectContaining({
            event_id: entry.event.event_id,
            evidence_ref: entry.event.evidence_ref,
          }),
        ),
      ),
    }),
  ]);
  expect(
    capture.snapshot.deployments.every((deployment) =>
      JSON.stringify(deployment.extensions).includes('"assertion_count":500'),
    ),
  ).toBe(true);
});

it('captures byte-budgeted assertions with unique maximum-length evidence and policy references', () => {
  const f = fixture(true);
  const prefix = 'urn:fixture:policy:v1:';
  const policy = prefix + '🚀'.repeat(200 - [...prefix].length);
  const exposure = {
    ...f.exposure,
    scope: { ...f.exposure.scope, policyReference: policy },
    event: { ...f.exposure.event, policy_reference: policy, evidence_ref: '🚀'.repeat(200) },
  };
  const build = {
    ...f.build,
    scope: { ...f.build.scope, policyReference: policy },
    event: { ...f.build.event, policy_reference: policy, evidence_ref: '🚀'.repeat(200) },
  };
  // PostgreSQL jsonb text adds separators; these fictional strings contain no quoted keys.
  const jsonbBytes = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value).replaceAll('":', '": ').replaceAll(',"', ', "'));
  const charge = (entry: ArgoEnrichmentEvidence) =>
    jsonbBytes(entry.event) +
    jsonbBytes(entry.scope) +
    2 +
    256 +
    enrichmentCaptureReserve(entry.event);
  // Reserve 5 KiB for one native receipt, two normalized native rows and both lifetime locks.
  const pairs = Math.min(2497, Math.floor((maxBytes - 5120) / (charge(exposure) + charge(build))));
  expect(pairs).toBeGreaterThan(100);
  expect(5120 + pairs * (charge(exposure) + charge(build))).toBeLessThanOrEqual(maxBytes);
  const receipts = [exposure, build].flatMap((entry) =>
    Array.from({ length: pairs }, (_, index) => {
      const event = {
        ...entry.event,
        event_id: randomUUID(),
        evidence_ref:
          '🚀'.repeat(200 - [...`urn:fixture:${entry.event.kind}:${index}`].length) +
          `urn:fixture:${entry.event.kind}:${index}`,
      };
      return {
        ...entry,
        event,
        sourceRef: `urn:clio:argo-enrichment:${event.source_id}:${event.producer_id}:${event.event_id}`,
      };
    }),
  );
  const connection = {
    ...f.input.connection,
    enrichmentProducers: (f.input.connection.enrichmentProducers ?? []).map((producer) => ({
      ...producer,
      policyReference: policy,
    })),
  };
  const capture = captureArgo({ ...f.input, connection, argoEnrichments: receipts });
  expect(capture.evidence.argoEnrichments).toHaveLength(pairs * 2);
  expect(capture.result.qualifyingCount).toBe(1);
  expect(Buffer.byteLength(boundedJson(capture))).toBeLessThanOrEqual(maxBytes);
});

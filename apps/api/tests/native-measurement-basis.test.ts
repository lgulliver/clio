import { randomUUID } from 'node:crypto';
import {
  type DeploymentEvidence,
  deriveMeasurementEvidence,
  type EvidenceBatch,
  identity,
  type MeasurementAuthorityScope,
  type MeasurementReport,
  parseArgoNotification,
  type StatusEvidence,
} from '@clio/adapters';
import { describe, expect, it } from 'vitest';
import { captureArgo } from '../src/features/argo-collection/capture.ts';
import { type ArgoConnection, windowInput } from '../src/features/argo-collection/input.ts';
import { captureGitHub } from '../src/features/github-collection/capture.ts';
import { snapshotDigest } from '../src/features/github-collection/digest.ts';
import { parseConnection } from '../src/features/github-collection/input.ts';
import {
  parseRetainedGapManifest,
  readNativeMeasurementBasis,
} from '../src/features/measurements/native-basis.ts';
import { grantFixture } from './argo-fixture.ts';

const window = windowInput({ start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' });
const observedAt = '2026-01-05T00:00:00Z';
function githubFixture(transportComplete = true) {
  const runId = randomUUID();
  const connection = parseConnection({
    workspaceId: randomUUID(),
    serviceId: randomUUID(),
    mode: 'live',
    provider: 'github',
    revision: 1,
    active: true,
    installationId: 10,
    repositoryId: 20,
    repositoryName: 'fictional',
    accountLogin: 'fictional',
    productionEnvironment: 'production',
    exposurePolicyReference: 'urn:fictional:exposure',
    repositoryDeploymentsBelongToService: true,
    observedAt: '2026-01-01T00:00:00Z',
    verifiedAt: '2026-01-01T00:00:00Z',
  });
  const sourceId = identity('github', '10');
  const deployments: DeploymentEvidence[] = [],
    statuses: StatusEvidence[] = [],
    completedStatusTraversals: { deploymentId: string; observedAt: string }[] = [];
  const evidence: EvidenceBatch = { deployments, statuses, completedStatusTraversals };
  for (const id of [30, 31]) {
    const deploymentId = identity(sourceId, 'deployment', 20, id);
    deployments.push({
      id: deploymentId,
      sourceId,
      sourceDeploymentId: identity('repository', 20, 'deployment', id),
      revision: '2026-01-02T10:00:00Z',
      environment: 'production',
      eventAt: '2026-01-02T10:00:00Z',
      observedAt,
      sourceRef: `urn:clio:${identity('github', '10', 'repository', 20, 'deployment', id)}`,
      repository: {
        repositoryId: identity('github', '10', 'repository', 20),
        tipSha: 'a'.repeat(40),
      },
      reconciledConfigurationRevision: null,
      configurationRepositoryId: null,
      deploymentTask: 'deploy',
      operationKind: 'rollout',
    });
    statuses.push({
      id: identity(sourceId, 'status', 20, id),
      deploymentId,
      revision: '2026-01-02T10:05:00Z',
      environment: 'production',
      signal: 'success',
      health: null,
      consumerExposure: false,
      eventAt: '2026-01-02T10:05:00Z',
      observedAt,
      sourceRef: `urn:clio:${identity('github', '10', 'repository', 20, 'status', id)}`,
    });
    completedStatusTraversals.push({ deploymentId, observedAt });
  }
  const capture = {
    connection,
    serviceName: 'Fictional',
    ...captureGitHub({
      runId,
      connection,
      serviceName: 'Fictional',
      window,
      evidence,
      transportComplete,
      acquiredAt: observedAt,
      databaseObservedAt: observedAt,
    }),
  };
  return {
    provider: 'github' as const,
    runId,
    workspaceId: connection.workspaceId,
    serviceId: connection.serviceId,
    sourceId: identity('github', '10'),
    connectionRevision: 1,
    productionPath: 'fictional-production-path',
    capture: { ...capture, digest: snapshotDigest(capture) },
  };
}
function argoFixture() {
  const scope = grantFixture();
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
    exposurePolicyReference: 'urn:fictional:exposure',
    applicationOperationsBelongToService: true,
    observedAt: '2026-01-01T00:00:00Z',
  };
  const runId = randomUUID(),
    operationId = randomUUID();
  const parsed = parseArgoNotification(
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
        phase: 'Succeeded',
        startedAt: '2026-01-02T10:00:00Z',
        finishedAt: '2026-01-02T10:05:00Z',
        retryCount: 0,
        info: [
          { name: 'clio.operation-id', value: operationId },
          { name: 'clio.operation-kind', value: 'rollout' },
        ],
        initiatedBy: { username: 'fictional', automated: false },
        revision: 'config-v1',
        revisions: [],
      },
      health: { status: 'Healthy', lastTransitionTime: '2026-01-02T10:05:00Z' },
    },
    scope,
    '2026-01-02T10:06:00Z',
  );
  if (parsed.kind !== 'operation') throw new Error('Invalid fixture');
  const capture = {
    connection,
    serviceName: 'Fictional',
    ...captureArgo({
      runId,
      connection,
      serviceName: 'Fictional',
      window,
      evidence: parsed.evidence,
      databaseObservedAt: observedAt,
      stats: {
        retainedReceiptCount: 1,
        retainedEvidenceCount: 2,
        recordedGapCount: 0,
        gapReasons: {},
        rejectionCount: 0,
        scopeDriftCount: 0,
        observationPeriod: { start: '2026-01-02T10:06:00Z', end: observedAt },
      },
    }),
  };
  return {
    provider: 'argocd' as const,
    runId,
    workspaceId: scope.workspaceId,
    serviceId: scope.serviceId,
    sourceId: identity('argocd', scope.instance),
    connectionRevision: 1,
    productionPath: 'fictional-argo-path',
    argoScope: scope,
    capture: { ...capture, digest: snapshotDigest(capture) },
  };
}
describe('private native measurement basis', () => {
  it('derives exact native identities without correlating repeated SHAs', () => {
    const fixture = githubFixture();
    const before = JSON.stringify(fixture.capture);
    const result = readNativeMeasurementBasis(fixture);
    expect(result.nativeIndex).toHaveLength(2);
    expect(new Set(result.nativeIndex.map((row) => row.deploymentId)).size).toBe(2);
    expect(result.gapManifestComplete).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.context.basis.snapshotDigest).toBe(fixture.capture.digest);
    expect(result.context.basis.evidenceDigest).toBe(snapshotDigest(fixture.capture.evidence));
    expect(JSON.stringify(fixture.capture)).toBe(before);
    expect(Object.isFrozen(result.snapshot.data)).toBe(true);
  });
  it('feeds actual GitHub capture through the native basis and independent five-metric engine', () => {
    const fixture = githubFixture();
    const native = readNativeMeasurementBasis(fixture);
    const interval = { start: window.start, end: window.end };
    const repositoryId = identity('github', '10', 'repository', 20);
    const identities = native.nativeIndex.map(({ sourceId, sourceDeploymentId }) => ({
      sourceId,
      sourceDeploymentId,
    }));
    const first = identities[0];
    if (!first) throw new Error('Missing fixture identity');
    const reports: MeasurementReport[] = [];
    const scopes: MeasurementAuthorityScope[] = [];
    const common = {
      contract: 'clio.measurement.evidence.v1' as const,
      workspaceId: fixture.workspaceId,
      serviceId: fixture.serviceId,
      basis: native.context.basis,
      evidenceRef: 'independent-receipt',
    };
    for (const capability of [
      'population',
      'change_links',
      'classification',
      'recovery',
    ] as const) {
      const producerId = randomUUID(),
        policyRef = `fictional-${capability}-policy`;
      const envelope = { ...common, eventId: randomUUID(), producerId, policyRef };
      scopes.push({
        producerId,
        workspaceId: fixture.workspaceId,
        serviceId: fixture.serviceId,
        capability,
        policyRef,
        basis: native.context.basis,
        productionPaths: [fixture.productionPath],
        repositoryIds: [repositoryId],
      });
      if (capability === 'population')
        reports.push({
          ...envelope,
          capability,
          payload: {
            interval,
            exhaustive: true,
            productionPaths: [fixture.productionPath],
            operations: identities,
            gapResolutions: [],
          },
        });
      else if (capability === 'change_links')
        reports.push({
          ...envelope,
          capability,
          payload: {
            history: {
              kind: 'service_history_origin',
              interval,
              evidenceRef: 'service-origin-proof',
            },
            operations: identities.map((id) => ({
              ...id,
              evidenceRef: 'complete-change-set',
              changes: [
                {
                  repositoryId,
                  commitId: 'a'.repeat(40),
                  committedAt: '2026-01-02T09:05:00Z',
                  evidenceRef: 'actual-deployed-commit',
                },
              ],
            })),
          },
        });
      else if (capability === 'classification')
        reports.push({
          ...envelope,
          capability,
          payload: {
            operations: identities.map((id, i) => ({
              ...id,
              failure: i === 0 ? 'failed' : 'no_recorded_failure',
              rework: i === 0 ? 'incident_driven' : 'not_incident_driven',
              failureEvidenceRef: 'failure-decision-proof',
              reworkEvidenceRef: 'rework-decision-proof',
            })),
          },
        });
      else
        reports.push({
          ...envelope,
          capability,
          payload: {
            interval,
            exhaustive: true,
            episodes: [
              {
                ...first,
                episodeId: 'fictional-episode',
                onset: '2026-01-02T10:06:00Z',
                restored: '2026-01-02T10:36:00Z',
                approximate: false,
                evidenceRef: 'service-restoration-proof',
              },
            ],
          },
        });
    }
    const result = deriveMeasurementEvidence({
      basis: native.snapshot,
      context: native.context,
      nativeIndex: native.nativeIndex,
      gapManifest: native.gapManifest,
      authorityScopes: scopes,
      reports: reports.map((report) => ({ report, observedAt: '2026-01-06T00:00:00Z' })),
      measurementCutoff: '2026-01-07T00:00:00Z',
    });
    const metric = result.metrics[0];
    expect(metric?.deployment_frequency).toMatchObject({
      status: 'complete',
      count: 2,
      deployments_per_day: 1,
    });
    expect(metric?.change_lead_time).toMatchObject({
      status: 'complete',
      observation_count: 1,
      median_seconds: 3600,
    });
    expect(metric?.change_fail_rate).toMatchObject({ status: 'complete', ratio: 0.5 });
    expect(metric?.deployment_rework_rate).toMatchObject({ status: 'complete', ratio: 0.5 });
    expect(metric?.failed_deployment_recovery_time).toMatchObject({
      status: 'complete',
      median_seconds: 1800,
    });
    expect(native.snapshot.data.collection_complete).toBe(false);
    expect(native.snapshot.data.evidence_cutoff).toBe(observedAt);
    expect(result.snapshot.data.evidence_cutoff).toBe('2026-01-07T00:00:00Z');
  });
  it('retains a stable unbounded transport uncertainty needing independent reconciliation', () => {
    const result = readNativeMeasurementBasis(githubFixture(false));
    expect(result.gaps).toEqual([
      {
        gapId: identity('github-transport', result.context.basis.runId),
        sourceId: result.context.basis.sourceId,
        reason: 'transport_incomplete',
        bounds: null,
      },
    ]);
    expect(result.snapshot.data.collection_complete).toBe(false);
  });
  it('rejects foreign workspace/service/run/revision and modified private captures', () => {
    const fixture = githubFixture();
    for (const change of [
      { workspaceId: randomUUID() },
      { serviceId: randomUUID() },
      { runId: randomUUID() },
      { connectionRevision: 2 },
      { sourceId: randomUUID() },
    ])
      expect(() => readNativeMeasurementBasis({ ...fixture, ...change })).toThrow();
    expect(() =>
      readNativeMeasurementBasis({
        ...fixture,
        capture: { ...fixture.capture, serviceName: 'Changed' },
      }),
    ).toThrow('digest');
  });
  it('rejects forged canonical identity even when content is rehashed', () => {
    const fixture = githubFixture();
    const snapshot = {
      ...fixture.capture.snapshot,
      deployments: fixture.capture.snapshot.deployments.map((row, index) =>
        index === 0 ? { ...row, id: 'foreign' } : row,
      ),
    };
    const capture = { ...fixture.capture, snapshot };
    expect(() =>
      readNativeMeasurementBasis({
        ...fixture,
        capture: {
          ...capture,
          digest: snapshotDigest({
            connection: capture.connection,
            serviceName: capture.serviceName,
            evidence: capture.evidence,
            snapshot: capture.snapshot,
            metrics: capture.metrics,
            oemsRevision: capture.oemsRevision,
            result: capture.result,
          }),
        },
      }),
    ).toThrow();
  });
  it('requires independently retained Argo gap manifest; legacy absence cannot certify coverage', () => {
    const fixture = argoFixture();
    const result = readNativeMeasurementBasis(fixture);
    expect(result.nativeIndex).toHaveLength(1);
    expect(result.gapManifestComplete).toBe(false);
    expect(() =>
      readNativeMeasurementBasis({
        ...fixture,
        argoScope: { ...fixture.argoScope, applicationUid: randomUUID() },
      }),
    ).toThrow();
  });
  it('accepts a private exact manifest without changing saved native coverage', () => {
    const fixture = argoFixture();
    const manifest = {
      version: 1,
      complete: true,
      gaps: [
        {
          gapId: 'transport-gap',
          sourceId: fixture.sourceId,
          reason: 'transport_incomplete',
          bounds: null,
        },
        { gapId: 'receipt-gap', sourceId: fixture.sourceId, reason: 'non_terminal', bounds: null },
      ],
    };
    const evidence = { ...fixture.capture.evidence, nativeGapManifest: manifest };
    const { digest: _old, ...capture } = fixture.capture;
    const updated = { ...capture, evidence };
    const result = readNativeMeasurementBasis({
      ...fixture,
      capture: { ...updated, digest: snapshotDigest(updated) },
    });
    expect(result.gapManifestComplete).toBe(true);
    expect(result.gaps).toEqual(manifest.gaps);
    expect(result.snapshot.data.collection_complete).toBe(false);
    const foreign = {
      ...updated,
      evidence: {
        ...evidence,
        nativeGapManifest: {
          ...manifest,
          gaps: manifest.gaps.map((gap, i) => (i === 1 ? { ...gap, sourceId: randomUUID() } : gap)),
        },
      },
    };
    expect(() =>
      readNativeMeasurementBasis({
        ...fixture,
        capture: { ...foreign, digest: snapshotDigest(foreign) },
      }),
    ).toThrow('Foreign or late retained measurement gap');
    const omittedTransport = {
      ...updated,
      evidence: { ...evidence, nativeGapManifest: { ...manifest, gaps: manifest.gaps.slice(1) } },
    };
    expect(() =>
      readNativeMeasurementBasis({
        ...fixture,
        capture: { ...omittedTransport, digest: snapshotDigest(omittedTransport) },
      }),
    ).toThrow('Missing Argo transport uncertainty');
  });
  it('rejects duplicate, malformed, oversized and reversed retained gaps', () => {
    const gap = {
      gapId: 'one',
      sourceId: 'source',
      reason: 'interruption',
      bounds: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
    };
    for (const gaps of [
      [gap, gap],
      [{ ...gap, bounds: { start: gap.bounds.end, end: gap.bounds.start } }],
      [{ ...gap, unexpected: true }],
      Array.from({ length: 5001 }, (_, i) => ({ ...gap, gapId: String(i) })),
    ])
      expect(() => parseRetainedGapManifest({ version: 1, complete: true, gaps })).toThrow();
  });
});

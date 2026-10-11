import { randomUUID } from 'node:crypto';
import {
  type DeploymentEvidence,
  type EvidenceBatch,
  identity,
  type MeasurementReport,
  parseArgoNotification,
  type StatusEvidence,
} from '@clio/adapters';
import { captureArgo } from '../src/features/argo-collection/capture.ts';
import type { ArgoConnection } from '../src/features/argo-collection/input.ts';
import { captureGitHub } from '../src/features/github-collection/capture.ts';
import { snapshotDigest } from '../src/features/github-collection/digest.ts';
import { parseConnection, windowInput } from '../src/features/github-collection/input.ts';
import { capabilities, parseMeasurementGrant } from '../src/features/measurements/config.ts';
import { readNativeMeasurementBasis } from '../src/features/measurements/native-basis.ts';
import { grantFixture } from './argo-fixture.ts';

const window = windowInput({ start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' });
const observedAt = '2026-01-05T00:00:00Z';
export function githubFixture(transportComplete = true, empty = false, prewindow = false) {
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
  for (const id of empty ? [] : [30, 31]) {
    const deploymentId = identity(sourceId, 'deployment', 20, id);
    const deployedAt = id === 30 && prewindow ? '2026-01-01T10:00:00Z' : '2026-01-02T10:00:00Z';
    const effectiveAt = id === 30 && prewindow ? '2026-01-01T10:05:00Z' : '2026-01-02T10:05:00Z';
    deployments.push({
      id: deploymentId,
      sourceId,
      sourceDeploymentId: identity('repository', 20, 'deployment', id),
      revision: deployedAt,
      environment: 'production',
      eventAt: deployedAt,
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
      revision: effectiveAt,
      environment: 'production',
      signal: 'success',
      health: null,
      consumerExposure: false,
      eventAt: effectiveAt,
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
      window: prewindow
        ? windowInput({ start: '2026-01-02T00:00:00Z', end: '2026-01-03T00:00:00Z' })
        : window,
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
    productionPath: identity('github-production', 10, 20, 'production'),
    capture: { ...capture, digest: snapshotDigest(capture) },
  };
}

export function evidenceFixture(empty = false, prewindow = false) {
  const fixture = githubFixture(true, empty, prewindow),
    native = readNativeMeasurementBasis(fixture),
    repositoryId = identity('github', '10', 'repository', 20),
    productionPath = fixture.productionPath;
  const grants = capabilities.map((capability, i) =>
    parseMeasurementGrant(
      {
        workspaceId: fixture.workspaceId,
        serviceId: fixture.serviceId,
        provider: 'github',
        source: { installationId: 10, repositoryId: 20 },
        producerId: randomUUID(),
        capability,
        name: capability,
        policyRef: `fixture-${capability}`,
        productionPaths: [productionPath],
        repositoryIds: [repositoryId],
      },
      String(i + 1).repeat(64),
    ),
  );
  const identities = native.nativeIndex.map((n) => ({
      sourceId: n.sourceId,
      sourceDeploymentId: n.sourceDeploymentId,
    })),
    first = identities[0];
  const interval = { start: window.start, end: window.end };
  const reports: MeasurementReport[] = grants.map((g) => {
    const common = {
      contract: 'clio.measurement.evidence.v1' as const,
      eventId: randomUUID(),
      producerId: g.producerId,
      workspaceId: g.workspaceId,
      serviceId: g.serviceId,
      policyRef: g.policyRef,
      evidenceRef: 'private-fixture-reference',
      basis: native.context.basis,
    };
    switch (g.capability) {
      case 'population':
        return {
          ...common,
          capability: g.capability,
          payload: {
            interval,
            exhaustive: true,
            productionPaths: [productionPath],
            operations: identities,
            gapResolutions: [],
          },
        };
      case 'change_links':
        return {
          ...common,
          capability: g.capability,
          payload: {
            history: { kind: 'service_history_origin', interval, evidenceRef: 'origin' },
            operations: identities.map((n) => ({
              ...n,
              evidenceRef: 'complete-set',
              changes: [
                {
                  repositoryId,
                  commitId: 'a'.repeat(40),
                  committedAt: prewindow ? '2026-01-01T09:05:00Z' : '2026-01-02T09:05:00Z',
                  evidenceRef: 'commit-proof',
                },
              ],
            })),
          },
        };
      case 'classification':
        return {
          ...common,
          capability: g.capability,
          payload: {
            operations: identities.map((n, i) => ({
              ...n,
              failure: i === 0 ? 'failed' : 'no_recorded_failure',
              rework: i === 0 ? 'incident_driven' : 'not_incident_driven',
              failureEvidenceRef: 'failure-proof',
              reworkEvidenceRef: 'rework-proof',
            })),
          },
        };
      case 'recovery':
        return {
          ...common,
          capability: g.capability,
          payload: {
            interval,
            exhaustive: true,
            episodes: first
              ? [
                  {
                    ...first,
                    episodeId: 'episode-1',
                    onset: '2026-01-02T10:06:00Z',
                    restored: prewindow ? '2026-01-04T10:06:00Z' : '2026-01-02T10:36:00Z',
                    approximate: false,
                    evidenceRef: 'service-restoration',
                  },
                ]
              : [],
          },
        };
    }
    throw new Error('Invalid capability');
  });
  return { fixture, native, grants, reports };
}
export function argoFixture() {
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
      nativeGapManifest: {
        version: 1,
        complete: true,
        gaps: [
          {
            gapId: identity('argo-transport', scope.sourceId),
            sourceId: identity('argocd', scope.instance),
            reason: 'transport_incomplete',
            bounds: null,
          },
        ],
      },
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
    productionPath: identity('argo-production', scope.sourceId, scope.environment),
    argoScope: scope,
    capture: { ...capture, digest: snapshotDigest(capture) },
  };
}

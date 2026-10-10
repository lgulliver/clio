import { type EvidenceBatch, identity, reconcileDeployments } from '@clio/adapters';
import { calculate, oemsContract } from '@clio/oems';
import type { DeploymentMapping } from './input.ts';

const fixtureObservedAt = '2026-01-03T00:00:00.000Z';
const window = {
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-01-03T00:00:00.000Z',
  timezone: 'UTC',
  calendar_days: 2,
} as const;

/** Fictional evidence only. No provider transport or credential boundary exists here. */
export function fictionalEvidence(provider: DeploymentMapping['primaryProvider']): EvidenceBatch {
  const sourceId = identity(provider, 'mock-instance');
  const operation =
    provider === 'github'
      ? 'mock-deployment-1'
      : identity('application', 'mock-application', 'operation', 'mock-operation-1');
  const id = identity(sourceId, 'deployment', operation);
  return {
    deployments: [
      {
        id,
        sourceId,
        sourceDeploymentId: operation,
        revision: provider === 'github' ? '2026-01-02T10:00:00.000Z' : 'mock-operation-v1',
        environment: 'production',
        eventAt: '2026-01-02T10:00:00.000Z',
        observedAt: fixtureObservedAt,
        sourceRef: `urn:clio:mock:${provider}:deployment:1`,
        repository: null,
        reconciledConfigurationRevision: provider === 'argocd' ? 'mock-config-revision' : null,
        configurationRepositoryId: provider === 'argocd' ? 'mock-config-repository' : null,
        deploymentTask: null,
        operationKind: 'rollout',
      },
    ],
    statuses: [
      {
        id: identity(id, 'status', 'mock-status-1'),
        deploymentId: id,
        revision: 'mock-status-v1',
        environment: 'production',
        signal: provider === 'github' ? 'success' : 'Succeeded',
        health: provider === 'argocd' ? 'Healthy' : null,
        consumerExposure: true,
        eventAt: '2026-01-02T10:05:00.000Z',
        observedAt: fixtureObservedAt,
        sourceRef: `urn:clio:mock:${provider}:status:1`,
      },
    ],
  };
}

export function captureMapping(
  mapping: DeploymentMapping,
  service: { id: string; name: string },
  evidence: EvidenceBatch = fictionalEvidence(mapping.primaryProvider),
) {
  if (service.id !== mapping.serviceId) throw new Error('Preview service mismatch');
  const sourceId = identity(mapping.primaryProvider, 'mock-instance');
  const observations = [
    mapping.observedAt,
    fixtureObservedAt,
    ...evidence.deployments.map((row) => row.observedAt),
    ...evidence.statuses.map((row) => row.observedAt),
  ];
  const evidenceCutoff = new Date(
    // Round microsecond mapping and fixture observations up to a millisecond
    // cutoff so no accepted observation is accidentally omitted.
    Math.max(
      ...observations.map(
        (time) =>
          Date.parse(time) + (/[1-9]/.test((/\.(\d+)/.exec(time)?.[1] ?? '').slice(3)) ? 1 : 0),
      ),
    ),
  ).toISOString();
  const result = reconcileDeployments({
    datasetId: identity(
      'mock-preview',
      mapping.workspaceId,
      mapping.serviceId,
      String(mapping.revision),
    ),
    window,
    evidenceCutoff,
    mapping: {
      serviceId: service.id,
      serviceName: service.name,
      revision: String(mapping.revision),
      observedAt: mapping.observedAt,
      sourceRef: `urn:clio:mock:mapping:${mapping.workspaceId}:${service.id}:${mapping.revision}`,
      primarySourceId: sourceId,
      deploymentBindings: [
        {
          sourceId,
          sourceDeploymentId:
            mapping.primaryProvider === 'github'
              ? 'mock-deployment-1'
              : identity('application', 'mock-application', 'operation', 'mock-operation-1'),
        },
      ],
      environments: [
        {
          sourceId,
          environment: mapping.productionEnvironment,
          classification: 'production',
          exposurePolicy: mapping.exposureAttested
            ? {
                reference: `urn:clio:mock-only:exposure-policy:${mapping.workspaceId}:${service.id}:${mapping.revision}`,
                signal: mapping.primaryProvider === 'github' ? 'success' : 'Succeeded',
              }
            : null,
        },
      ],
      correlations: [],
    },
    batches: [evidence],
  });
  if (!result.ok) throw new Error('Fictional preview failed validation');
  const data = result.data.data;
  const metrics = calculate(result.data);
  const metric = metrics.find((row) => row.service_id === service.id);
  const rollout = data.deployments[0];
  if (
    !metric ||
    !rollout ||
    data.deployments.length !== 1 ||
    data.collection_complete !== false ||
    data.deployment_history_complete !== false ||
    data.recovery_evidence_complete !== false ||
    metric.deployment_frequency.status !== 'provisional' ||
    metric.deployment_frequency.deployments_per_day !== null ||
    metric.change_fail_rate.ratio !== null ||
    metric.failed_deployment_recovery_time.median_seconds !== null
  )
    throw new Error('Unexpected fictional preview quality');
  const preview = {
    mode: mapping.mode,
    workspaceId: mapping.workspaceId,
    serviceId: service.id,
    mappingRevision: mapping.revision,
    oemsRevision: oemsContract.revision,
    window: {
      start: metric.window.start,
      end: metric.window.end,
      timezone: metric.window.timezone,
      calendarDays: metric.window.calendar_days,
    },
    evidenceCutoff: metric.evidence_cutoff,
    qualification: rollout.qualification,
    rolloutCount: data.deployments.length,
    coverage: {
      collectionComplete: data.collection_complete,
      deploymentHistoryComplete: data.deployment_history_complete,
      recoveryEvidenceComplete: data.recovery_evidence_complete,
    },
    deploymentFrequency: {
      count: metric.deployment_frequency.count,
      status: metric.deployment_frequency.status,
      deploymentsPerDay: metric.deployment_frequency.deployments_per_day,
      qualityReasons: metric.deployment_frequency.quality_reasons,
    },
    changeFailureRate: metric.change_fail_rate.ratio,
    failedDeploymentRecoveryTime: metric.failed_deployment_recovery_time.median_seconds,
  };
  return { preview, evidence, snapshot: data, metrics, oemsRevision: oemsContract.revision };
}

export function previewMapping(
  mapping: DeploymentMapping,
  service: { id: string; name: string },
  evidence: EvidenceBatch = fictionalEvidence(mapping.primaryProvider),
) {
  return captureMapping(mapping, service, evidence).preview;
}

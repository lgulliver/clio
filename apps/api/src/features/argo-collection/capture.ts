import { type EvidenceBatch, identity, reconcileDeployments } from '@clio/adapters';
import { calculate, oemsContract } from '@clio/oems';
import { boundedJson } from './history.ts';
import { type ArgoConnection, instant, timestamp, type windowInput } from './input.ts';
import { parseResult } from './result.ts';

export function captureArgo(input: {
  runId: string;
  connection: ArgoConnection;
  serviceName: string;
  window: ReturnType<typeof windowInput>;
  evidence: EvidenceBatch;
  stats: {
    retainedReceiptCount: number;
    retainedEvidenceCount: number;
    recordedGapCount: number;
    gapReasons: Record<string, number>;
    rejectionCount: number;
    scopeDriftCount: number;
    observationPeriod: { start: string | null; end: string };
  };
  databaseObservedAt: string;
}) {
  const { connection, evidence, window } = input;
  const sourceId = identity('argocd', connection.instance);
  const evidenceCutoff = [timestamp(input.databaseObservedAt), connection.observedAt].reduce(
    (a, b) => (instant(a) >= instant(b) ? a : b),
  );
  for (const observation of [
    ...evidence.deployments,
    ...evidence.statuses,
    ...(evidence.completedStatusTraversals ?? []),
  ]) {
    if (instant(observation.observedAt) > instant(evidenceCutoff))
      throw new Error('Evidence observed after acquisition');
  }
  const reconciled = reconcileDeployments({
    datasetId: identity('live-argocd', input.runId),
    window: {
      start: window.start,
      end: window.end,
      timezone: 'UTC',
      calendar_days: window.calendarDays,
    },
    evidenceCutoff,
    mapping: {
      serviceId: connection.serviceId,
      serviceName: input.serviceName,
      revision: String(connection.revision),
      observedAt: connection.observedAt,
      sourceRef: `urn:clio:argo-connection:${connection.workspaceId}:${connection.serviceId}:${connection.revision}`,
      primarySourceId: sourceId,
      deploymentBindings: [
        ...new Map(
          evidence.deployments.map((r) => [
            r.sourceDeploymentId,
            { sourceId: r.sourceId, sourceDeploymentId: r.sourceDeploymentId },
          ]),
        ).values(),
      ],
      environments: [
        {
          sourceId,
          environment: connection.productionEnvironment,
          classification: 'production',
          exposurePolicy: connection.exposurePolicyReference
            ? { reference: connection.exposurePolicyReference, signal: 'Succeeded' }
            : null,
        },
      ],
      correlations: [],
    },
    batches: [evidence],
  });
  if (!reconciled.ok) throw new Error('Argo snapshot validation failed');
  const snapshot = reconciled.data.data,
    metrics = calculate(reconciled.data),
    metric = metrics.find((row) => row.service_id === connection.serviceId);
  if (
    !metric ||
    snapshot.collection_complete !== false ||
    snapshot.deployment_history_complete !== false ||
    snapshot.recovery_evidence_complete !== false
  )
    throw new Error('Unexpected Argo coverage');
  const result = parseResult(
    {
      mode: 'live',
      workspaceId: connection.workspaceId,
      serviceId: connection.serviceId,
      connectionRevision: connection.revision,
      oemsRevision: oemsContract.revision,
      window,
      evidenceCutoff,
      provider: 'argocd',
      transportComplete: false,
      ...input.stats,
      deploymentCount: snapshot.deployments.length,
      qualifyingCount: snapshot.deployments.filter((r) => r.qualification === 'qualifying').length,
      unknownCount: snapshot.deployments.filter((r) => r.qualification === 'unknown').length,
      coverage: {
        collectionComplete: false,
        deploymentHistoryComplete: false,
        recoveryEvidenceComplete: false,
      },
      deploymentFrequency: {
        count: metric.deployment_frequency.count,
        status: metric.deployment_frequency.status,
        deploymentsPerDay: metric.deployment_frequency.deployments_per_day,
        qualityReasons: metric.deployment_frequency.quality_reasons,
      },
      changeFailureRate: metric.change_fail_rate.ratio,
      failedDeploymentRecoveryTime: metric.failed_deployment_recovery_time.median_seconds,
    },
    connection,
    window,
  );
  const capture = { evidence, snapshot, metrics, oemsRevision: oemsContract.revision, result };
  boundedJson(capture);
  return capture;
}

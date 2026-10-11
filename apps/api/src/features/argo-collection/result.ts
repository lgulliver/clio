import { oemsContract } from '@clio/oems';
import { storedRevision } from '../github-collection/db-value.ts';
import { object, uuid } from '../identity/input.ts';
import { parseArchiveSummary } from './archive-summary.ts';
import { parseCoverageAssessment } from './coverage-assessment.ts';
import {
  type ArgoConnection,
  count,
  instant,
  parseConnection,
  parseProducers,
  timestamp,
  windowInput,
} from './input.ts';

const reasons = new Set([
  'incomplete_collection',
  'unresolved_qualification',
  'unknown_failure_classification',
  'unknown_rework_classification',
  'incomplete_history',
  'incomplete_change_linkage',
  'unresolved_change_links',
  'incomplete_recovery_evidence',
  'unresolved_causal_links',
  'open_recovery_episodes',
  'approximate_recovery_start',
]);
export const gapReasons = [
  'unmarked_operation',
  'non_terminal',
  'missing_sync_result',
  'missing_health_timestamp',
  'multi_source',
  'source_hydrator',
  'future_timestamp',
  'invalid_operation_info',
  'observation_horizon',
  'status_combination_repeated',
  'status_combination_limit',
  'connection_interruption',
] as const;
function parseGapReasons(value: unknown, total: number) {
  const row = object(value, gapReasons);
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) result[key] = count(value);
  if (Object.values(result).reduce((a, b) => a + b, 0) !== total)
    throw new Error('Invalid gap totals');
  return result;
}
function parsePeriod(value: unknown, cutoff: string) {
  const row = object(value, ['start', 'end']);
  const start = row.start === null ? null : timestamp(row.start),
    end = timestamp(row.end);
  if (end !== cutoff || (start !== null && instant(start) > instant(end)))
    throw new Error('Invalid observation period');
  return { start, end };
}
export function parseResult(
  value: unknown,
  connection: ArgoConnection,
  pinnedWindow: ReturnType<typeof windowInput>,
) {
  const row = object(value, [
    'coverageAssessment',
    'archiveSummary',
    'enrichmentSummary',
    'mode',
    'provider',
    'retainedReceiptCount',
    'retainedEvidenceCount',
    'recordedGapCount',
    'gapReasons',
    'rejectionCount',
    'scopeDriftCount',
    'observationPeriod',
    'workspaceId',
    'serviceId',
    'connectionRevision',
    'oemsRevision',
    'window',
    'evidenceCutoff',
    'transportComplete',
    'deploymentCount',
    'qualifyingCount',
    'unknownCount',
    'coverage',
    'deploymentFrequency',
    'changeFailureRate',
    'failedDeploymentRecoveryTime',
  ]);
  const window = object(row.window, ['start', 'end', 'timezone', 'calendarDays']);
  const coverage = object(row.coverage, [
    'collectionComplete',
    'deploymentHistoryComplete',
    'recoveryEvidenceComplete',
  ]);
  const frequency = object(row.deploymentFrequency, [
    'count',
    'status',
    'deploymentsPerDay',
    'qualityReasons',
  ]);
  const deploymentCount = count(row.deploymentCount),
    qualifyingCount = count(row.qualifyingCount),
    unknownCount = count(row.unknownCount),
    frequencyCount = count(frequency.count);
  const cutoff = timestamp(row.evidenceCutoff);
  if (
    row.mode !== 'live' ||
    row.workspaceId !== connection.workspaceId ||
    row.serviceId !== connection.serviceId ||
    row.connectionRevision !== connection.revision ||
    row.oemsRevision !== oemsContract.revision ||
    window.start !== pinnedWindow.start ||
    window.end !== pinnedWindow.end ||
    window.timezone !== 'UTC' ||
    window.calendarDays !== pinnedWindow.calendarDays ||
    row.transportComplete !== false ||
    row.provider !== 'argocd' ||
    coverage.collectionComplete !== false ||
    coverage.deploymentHistoryComplete !== false ||
    coverage.recoveryEvidenceComplete !== false ||
    frequency.status !== 'provisional' ||
    frequency.deploymentsPerDay !== null ||
    row.changeFailureRate !== null ||
    row.failedDeploymentRecoveryTime !== null ||
    qualifyingCount + unknownCount > deploymentCount ||
    frequencyCount > qualifyingCount ||
    instant(cutoff) < instant(connection.observedAt) ||
    instant(cutoff) < instant(pinnedWindow.end) ||
    !Array.isArray(frequency.qualityReasons) ||
    frequency.qualityReasons.length > 11
  )
    throw new Error('Invalid stored Argo result');
  const qualityReasons = frequency.qualityReasons.map((reason: unknown) => {
    if (typeof reason !== 'string' || !reasons.has(reason))
      throw new Error('Invalid stored Argo result');
    return reason;
  });
  if (
    !qualityReasons.includes('incomplete_collection') ||
    new Set(qualityReasons).size !== qualityReasons.length
  )
    throw new Error('Invalid stored Argo result');
  const archiveSummary = Object.hasOwn(row, 'archiveSummary')
    ? parseArchiveSummary(row.archiveSummary)
    : undefined;
  if (
    archiveSummary &&
    (!connection.archiveProducer ||
      archiveSummary.producerId !== connection.archiveProducer.producerId ||
      archiveSummary.journalId !== connection.archiveProducer.journalId ||
      archiveSummary.policyReference !== connection.archiveProducer.policyReference ||
      (archiveSummary.lastSuccessfulReconciliationAt !== null &&
        instant(archiveSummary.lastSuccessfulReconciliationAt) > instant(cutoff)) ||
      (archiveSummary.sealedInterval !== null &&
        instant(archiveSummary.sealedInterval.end) > instant(cutoff)) ||
      archiveSummary.missingIntervals.some((i) => instant(i.end) > instant(cutoff)))
  )
    throw new Error('Invalid archive result');
  return {
    ...(archiveSummary ? { archiveSummary } : {}),
    ...(Object.hasOwn(row, 'coverageAssessment')
      ? {
          coverageAssessment: parseCoverageAssessment(row.coverageAssessment, {
            unknownCount,
            qualifyingCount,
            frequencyCount,
          }),
        }
      : {}),
    ...(Object.hasOwn(row, 'enrichmentSummary')
      ? { enrichmentSummary: parseSummary(row.enrichmentSummary, connection) }
      : {}),
    mode: row.mode,
    workspaceId: connection.workspaceId,
    serviceId: connection.serviceId,
    connectionRevision: connection.revision,
    oemsRevision: row.oemsRevision,
    window: { ...pinnedWindow },
    evidenceCutoff: cutoff,
    provider: 'argocd' as const,
    transportComplete: false as const,
    retainedReceiptCount: count(row.retainedReceiptCount),
    retainedEvidenceCount: count(row.retainedEvidenceCount),
    recordedGapCount: count(row.recordedGapCount),
    rejectionCount: count(row.rejectionCount),
    scopeDriftCount: count(row.scopeDriftCount),
    gapReasons: parseGapReasons(row.gapReasons, count(row.recordedGapCount)),
    observationPeriod: parsePeriod(row.observationPeriod, cutoff),
    deploymentCount,
    qualifyingCount,
    unknownCount,
    coverage: {
      collectionComplete: false as const,
      deploymentHistoryComplete: false as const,
      recoveryEvidenceComplete: false as const,
    },
    deploymentFrequency: {
      count: frequencyCount,
      status: frequency.status,
      deploymentsPerDay: null,
      qualityReasons,
    },
    changeFailureRate: null,
    failedDeploymentRecoveryTime: null,
  };
}
export function storedWindow(value: unknown) {
  const row = object(value, ['start', 'end', 'timezone', 'calendarDays']);
  const window = windowInput({ start: row.start, end: row.end });
  if (
    row.timezone !== 'UTC' ||
    row.calendarDays !== window.calendarDays ||
    row.start !== window.start ||
    row.end !== window.end
  )
    throw new Error('Invalid stored window');
  return window;
}
function failureCode(value: unknown): 'argo_processing_failed' | 'argo_connection_revoked' {
  if (value !== 'argo_processing_failed' && value !== 'argo_connection_revoked')
    throw new Error('Invalid failure code');
  return value;
}
export function parseRun(row: Record<string, unknown>) {
  try {
    const connection = parseConnection(row.connection_input),
      window = storedWindow(row.window_input);
    const status = row.status,
      attempts = count(row.attempts);
    if (
      (status !== 'pending' &&
        status !== 'running' &&
        status !== 'succeeded' &&
        status !== 'failed') ||
      attempts > 3 ||
      (status === 'pending' && attempts === 3) ||
      (status === 'running' && attempts === 0) ||
      uuid(row.workspace_id) !== connection.workspaceId ||
      uuid(row.service_id) !== connection.serviceId ||
      storedRevision(row.connection_revision) !== connection.revision ||
      !connection.active
    )
      throw new Error('Invalid run');
    const terminal = status === 'succeeded' || status === 'failed';
    if (
      terminal !== (row.completed_at_text !== null) ||
      (status === 'succeeded') !== (row.result !== null) ||
      (status === 'failed'
        ? row.failure_code !== 'argo_processing_failed' &&
          row.failure_code !== 'argo_connection_revoked'
        : row.failure_code !== null)
    )
      throw new Error('Invalid run');
    const createdAt = timestamp(row.created_at_text),
      updatedAt = timestamp(row.updated_at_text),
      completedAt = row.completed_at_text === null ? null : timestamp(row.completed_at_text);
    if (
      instant(updatedAt) < instant(createdAt) ||
      instant(createdAt) < instant(connection.observedAt) ||
      (completedAt !== null && instant(completedAt) !== instant(updatedAt))
    )
      throw new Error('Invalid run order');
    const result = status === 'succeeded' ? parseResult(row.result, connection, window) : null;
    if (
      result &&
      (instant(result.evidenceCutoff) > instant(updatedAt) ||
        instant(result.evidenceCutoff) < instant(createdAt))
    )
      throw new Error('Invalid cutoff');
    // Reconstruct only listed fields: private inputs/lease data never spread into HTTP.
    return {
      id: uuid(row.id),
      workspaceId: connection.workspaceId,
      serviceId: connection.serviceId,
      mode: 'live' as const,
      provider: 'argocd' as const,
      connectionRevision: connection.revision,
      status,
      attempts,
      createdAt,
      updatedAt,
      completedAt,
      failureCode: status === 'failed' ? failureCode(row.failure_code) : null,
      result,
    };
  } catch {
    throw new Error('Invalid stored Argo run');
  }
}
export const runColumns = `*, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text, to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_text, to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at_text`;

export type ArgoResult = ReturnType<typeof parseResult>;
export type ArgoRun = ReturnType<typeof parseRun>;

function parseSummary(value: unknown, connection: ArgoConnection) {
  const row = object(value, [
    'retainedReceiptCount',
    'consumerExposureCount',
    'applicationProvenanceCount',
    'policies',
  ]);
  const retainedReceiptCount = count(row.retainedReceiptCount),
    consumerExposureCount = count(row.consumerExposureCount),
    applicationProvenanceCount = count(row.applicationProvenanceCount),
    policies = parseProducers(row.policies);
  if (
    retainedReceiptCount !== consumerExposureCount + applicationProvenanceCount ||
    JSON.stringify(policies) !== JSON.stringify(connection.enrichmentProducers ?? [])
  )
    throw new Error('Invalid enrichment summary');
  return { retainedReceiptCount, consumerExposureCount, applicationProvenanceCount, policies };
}

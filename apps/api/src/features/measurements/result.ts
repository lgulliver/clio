import type { MeasurementAssessment, MeasurementBlocker } from '@clio/adapters';
import { type MetricResult, oemsContract, validateStructure } from '@clio/oems';
import { count, instant, positive, timestamp, windowInput } from '../github-collection/input.ts';
import { uuid } from '../identity/input.ts';
import { exact } from './input.ts';
import { provider } from './source-eligibility.ts';

export const blockers: readonly MeasurementBlocker[] = [
  'population_missing',
  'population_interval',
  'population_paths',
  'population_roster_mismatch',
  'gap_manifest_missing',
  'gap_resolution_mismatch',
  'history_missing',
  'history_population',
  'history_origin',
  'history_change_links',
  'recovery_classification_missing',
  'recovery_missing',
  'recovery_interval',
];
function blocker(value: unknown): MeasurementBlocker {
  for (const b of blockers) if (value === b) return b;
  throw new Error('Invalid measurement assessment');
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid measurement coverage');
  return value;
}
export function parseAssessment(value: unknown): MeasurementAssessment {
  const row = exact(value, [
    'blockers',
    'collectionComplete',
    'historyComplete',
    'recoveryComplete',
  ]);
  if (!Array.isArray(row.blockers) || row.blockers.length > blockers.length)
    throw new Error('Invalid measurement assessment');
  const reasons = row.blockers.map(blocker);
  if (new Set(reasons).size !== reasons.length) throw new Error('Invalid measurement assessment');
  return {
    blockers: reasons,
    collectionComplete: boolean(row.collectionComplete),
    historyComplete: boolean(row.historyComplete),
    recoveryComplete: boolean(row.recoveryComplete),
  };
}
export interface MeasurementResult {
  contract: 'clio.measurement.result.v1';
  workspaceId: string;
  serviceId: string;
  provider: 'github' | 'argocd';
  basisRunId: string;
  connectionRevision: number;
  oemsRevision: string;
  window: ReturnType<typeof windowInput>;
  basisEvidenceCutoff: string;
  evidenceCutoff: string;
  assessment: MeasurementAssessment;
  coverage: {
    collectionComplete: boolean;
    deploymentHistoryComplete: boolean;
    recoveryEvidenceComplete: boolean;
  };
  metricResult: MetricResult;
}
/** Measurement results allow independently established true coverage; native parser is intentionally separate. */
export function parseMeasurementResult(value: unknown): MeasurementResult {
  const row = exact(value, [
    'contract',
    'workspaceId',
    'serviceId',
    'provider',
    'basisRunId',
    'connectionRevision',
    'oemsRevision',
    'window',
    'basisEvidenceCutoff',
    'evidenceCutoff',
    'assessment',
    'coverage',
    'metricResult',
  ]);
  if (row.contract !== 'clio.measurement.result.v1' || row.oemsRevision !== oemsContract.revision)
    throw new Error('Invalid measurement result');
  const w = exact(row.window, ['start', 'end', 'timezone', 'calendarDays']),
    window = windowInput({ start: w.start, end: w.end });
  if (w.timezone !== 'UTC' || w.calendarDays !== window.calendarDays)
    throw new Error('Invalid measurement window');
  const serviceId = uuid(row.serviceId),
    cutoff = timestamp(row.evidenceCutoff),
    basisCutoff = timestamp(row.basisEvidenceCutoff),
    assessment = parseAssessment(row.assessment),
    c = exact(row.coverage, [
      'collectionComplete',
      'deploymentHistoryComplete',
      'recoveryEvidenceComplete',
    ]);
  const coverage = {
    collectionComplete: boolean(c.collectionComplete),
    deploymentHistoryComplete: boolean(c.deploymentHistoryComplete),
    recoveryEvidenceComplete: boolean(c.recoveryEvidenceComplete),
  };
  if (
    coverage.collectionComplete !== assessment.collectionComplete ||
    coverage.deploymentHistoryComplete !== assessment.historyComplete ||
    coverage.recoveryEvidenceComplete !== assessment.recoveryComplete
  )
    throw new Error('Mismatched measurement coverage');
  for (const [prefix, complete] of [
    ['collection', coverage.collectionComplete],
    ['history', coverage.deploymentHistoryComplete],
    ['recovery', coverage.recoveryEvidenceComplete],
  ] as const) {
    const relevant = assessment.blockers.some((b) =>
      prefix === 'collection'
        ? b.startsWith('population_') || b.startsWith('gap_')
        : b.startsWith(`${prefix}_`),
    );
    if (complete === relevant) throw new Error('Mismatched assessment blockers');
  }
  const metric = validateStructure('metric-result', row.metricResult);
  if (!metric.ok) throw new Error('Invalid measurement metrics');
  const m = metric.data;
  if (
    m.service_id !== serviceId ||
    m.profile_version !== '0.1-draft' ||
    instant(m.window.start) !== instant(window.start) ||
    instant(m.window.end) !== instant(window.end) ||
    m.window.calendar_days !== window.calendarDays ||
    instant(m.evidence_cutoff) !== instant(cutoff) ||
    instant(basisCutoff) < instant(window.end) ||
    instant(cutoff) <= instant(basisCutoff)
  )
    throw new Error('Mismatched measurement context');
  for (const q of [
    m.deployment_frequency,
    m.change_lead_time,
    m.change_fail_rate,
    m.deployment_rework_rate,
    m.failed_deployment_recovery_time,
  ])
    if (q.quality_reasons.includes('incomplete_collection') === coverage.collectionComplete)
      throw new Error('Mismatched collection coverage');
  if (
    (!coverage.deploymentHistoryComplete &&
      !m.change_lead_time.quality_reasons.includes('incomplete_history')) ||
    m.failed_deployment_recovery_time.quality_reasons.includes('incomplete_recovery_evidence') ===
      coverage.recoveryEvidenceComplete
  )
    throw new Error('Mismatched evidence coverage');
  return {
    contract: 'clio.measurement.result.v1',
    workspaceId: uuid(row.workspaceId),
    serviceId,
    provider: provider(row.provider),
    basisRunId: uuid(row.basisRunId),
    connectionRevision: positive(row.connectionRevision),
    oemsRevision: oemsContract.revision,
    window,
    basisEvidenceCutoff: basisCutoff,
    evidenceCutoff: cutoff,
    assessment,
    coverage,
    metricResult: m,
  };
}
export const runColumns = `id,workspace_id,service_id,provider,basis_run_id,status,attempts,failure_code,result,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated,to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed`;
export function parseMeasurementRun(row: Record<string, unknown>) {
  const status = row.status;
  if (status !== 'pending' && status !== 'running' && status !== 'succeeded' && status !== 'failed')
    throw new Error('Invalid measurement status');
  const id = uuid(row.id),
    workspaceId = uuid(row.workspace_id),
    serviceId = uuid(row.service_id),
    kind = provider(row.provider),
    basisRunId = uuid(row.basis_run_id),
    result = row.result === null ? null : parseMeasurementResult(row.result),
    attempts = count(row.attempts);
  if (
    attempts > 3 ||
    (status === 'succeeded') !== (result !== null) ||
    (status === 'failed') !== (row.failure_code !== null) ||
    (status === 'succeeded' || status === 'failed') !== (row.completed !== null)
  )
    throw new Error('Invalid measurement state');
  if (
    row.failure_code !== null &&
    row.failure_code !== 'measurement_revoked' &&
    row.failure_code !== 'measurement_processing_failed'
  )
    throw new Error('Invalid measurement failure');
  if (
    result &&
    (result.workspaceId !== workspaceId ||
      result.serviceId !== serviceId ||
      result.provider !== kind ||
      result.basisRunId !== basisRunId)
  )
    throw new Error('Invalid measurement result scope');
  return {
    id,
    workspaceId,
    serviceId,
    provider: kind,
    basisRunId,
    status,
    attempts,
    createdAt: timestamp(row.created),
    updatedAt: timestamp(row.updated),
    completedAt: row.completed === null ? null : timestamp(row.completed),
    failureCode: row.failure_code,
    result,
  };
}

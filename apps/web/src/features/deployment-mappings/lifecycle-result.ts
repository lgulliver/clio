import { oemsContract, validateStructure } from '@clio/oems';
import { ApiError, record } from '../identity/api';
import type { Mapping } from './api';

function object(value: unknown, keys: string[]) {
  const row = record(value);
  if (Object.keys(row).some((key) => !keys.includes(key))) throw new ApiError(0);
  return row;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new ApiError(0);
  return value;
}

/** Pinned schema parser shared with all metric presentations. Native-only coverage
 * parser cannot parse a complete fictional population; bind this envelope explicitly.
 */
export function parseLifecycleResult(value: unknown, mapping: Mapping) {
  const row = object(value, [
    'mode',
    'scenario',
    'resultVersion',
    'workspaceId',
    'serviceId',
    'mappingRevision',
    'oemsRevision',
    'window',
    'evidenceCutoff',
    'qualification',
    'rolloutCount',
    'coverage',
    'deploymentFrequency',
    'changeFailureRate',
    'failedDeploymentRecoveryTime',
    'metricResult',
  ]);
  const parsed = validateStructure('metric-result', row.metricResult);
  if (!parsed.ok) throw new ApiError(0);
  const metric = parsed.data;
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
  const cutoff = timestamp(row.evidenceCutoff);
  if (
    mapping.scenario !== 'complete-lifecycle' ||
    row.mode !== 'mock' ||
    row.scenario !== mapping.scenario ||
    row.resultVersion !== 'clio.mock.lifecycle.v1' ||
    row.workspaceId !== mapping.workspaceId ||
    row.serviceId !== mapping.serviceId ||
    row.mappingRevision !== mapping.revision ||
    row.oemsRevision !== oemsContract.revision ||
    window.start !== '2026-01-01T00:00:00.000Z' ||
    window.end !== '2026-01-03T00:00:00.000Z' ||
    window.timezone !== 'UTC' ||
    window.calendarDays !== 2 ||
    BigInt(Date.parse(cutoff)) * 1000n <
      BigInt(Date.parse(mapping.observedAt)) * 1000n +
        BigInt((/\.(\d+)/.exec(mapping.observedAt)?.[1] ?? '').padEnd(6, '0').slice(3)) ||
    row.qualification !== 'qualifying' ||
    row.rolloutCount !== 3 ||
    coverage.collectionComplete !== true ||
    coverage.deploymentHistoryComplete !== true ||
    coverage.recoveryEvidenceComplete !== true ||
    metric.dataset_id !==
      ['mock-preview', mapping.workspaceId, mapping.serviceId, String(mapping.revision)]
        .map(encodeURIComponent)
        .join(':') ||
    metric.service_id !== mapping.serviceId ||
    metric.profile_version !== '0.1-draft' ||
    metric.window.start !== window.start ||
    metric.window.end !== window.end ||
    metric.window.timezone !== 'UTC' ||
    metric.window.calendar_days !== window.calendarDays ||
    metric.evidence_cutoff !== cutoff ||
    metric.qualification_unknown_count !== 0 ||
    metric.deployment_frequency.count !== row.rolloutCount ||
    metric.deployment_frequency.deployments_per_day !== 1.5 ||
    metric.change_lead_time.observation_count !== 3 ||
    metric.change_lead_time.median_seconds !== 3600 ||
    metric.change_lead_time.unresolved_change_count !== 0 ||
    metric.change_lead_time.linkage_unknown_count !== 0 ||
    [metric.change_fail_rate, metric.deployment_rework_rate].some(
      (r) =>
        r.denominator !== 3 ||
        r.numerator !== 1 ||
        r.unknown_count !== 0 ||
        r.bounds_scope !== 'full_population' ||
        r.ratio !== 1 / 3 ||
        r.lower_bound !== 1 / 3 ||
        r.upper_bound !== 1 / 3,
    ) ||
    metric.failed_deployment_recovery_time.observation_count !== 1 ||
    metric.failed_deployment_recovery_time.median_seconds !== 1800 ||
    metric.failed_deployment_recovery_time.approximate_count !== 0 ||
    metric.failed_deployment_recovery_time.approximate_median_seconds !== null ||
    metric.failed_deployment_recovery_time.unknown_failure_count !== 0 ||
    metric.failed_deployment_recovery_time.open_count !== 0 ||
    metric.failed_deployment_recovery_time.unresolved_count !== 0 ||
    frequency.count !== metric.deployment_frequency.count ||
    frequency.status !== metric.deployment_frequency.status ||
    frequency.deploymentsPerDay !== metric.deployment_frequency.deployments_per_day ||
    JSON.stringify(frequency.qualityReasons) !==
      JSON.stringify(metric.deployment_frequency.quality_reasons) ||
    row.changeFailureRate !== metric.change_fail_rate.ratio ||
    row.failedDeploymentRecoveryTime !== metric.failed_deployment_recovery_time.median_seconds ||
    [
      metric.deployment_frequency,
      metric.change_lead_time,
      metric.change_fail_rate,
      metric.deployment_rework_rate,
      metric.failed_deployment_recovery_time,
    ].some((m) => m.status !== 'complete' || m.quality_reasons.length !== 0)
  )
    throw new ApiError(0);
  return {
    mode: 'mock' as const,
    scenario: 'complete-lifecycle' as const,
    resultVersion: 'clio.mock.lifecycle.v1' as const,
    workspaceId: mapping.workspaceId,
    serviceId: mapping.serviceId,
    mappingRevision: mapping.revision,
    oemsRevision: oemsContract.revision,
    window: {
      start: metric.window.start,
      end: metric.window.end,
      timezone: metric.window.timezone,
      calendarDays: metric.window.calendar_days,
    },
    evidenceCutoff: cutoff,
    qualification: 'qualifying' as const,
    rolloutCount: 3,
    coverage: {
      collectionComplete: true,
      deploymentHistoryComplete: true,
      recoveryEvidenceComplete: true,
    },
    deploymentFrequency: {
      count: metric.deployment_frequency.count,
      status: metric.deployment_frequency.status,
      deploymentsPerDay: metric.deployment_frequency.deployments_per_day,
      qualityReasons: metric.deployment_frequency.quality_reasons,
    },
    changeFailureRate: metric.change_fail_rate.ratio,
    failedDeploymentRecoveryTime: metric.failed_deployment_recovery_time.median_seconds,
    metricResult: metric,
  };
}

import { type MetricResult, validateStructure } from '@clio/oems';

type Context = {
  serviceId: string;
  window: { start: string; end: string; calendarDays: number };
  evidenceCutoff: string;
  unknownCount: number;
  deploymentFrequency: {
    count: number;
    status: string;
    deploymentsPerDay: number | null;
    qualityReasons: string[];
  };
  changeFailureRate: number | null;
  failedDeploymentRecoveryTime: number | null;
};

// Context binds the standard's public result to the saved native-source summary.
// Structure validation copies JSON and rejects private fields at every depth.
export function parseMetricResult(value: unknown, context: Context): MetricResult {
  const parsed = validateStructure('metric-result', value);
  if (!parsed.ok) throw new Error('Invalid metric result');
  const metric = parsed.data;
  const frequency = metric.deployment_frequency;
  const sameReasons =
    [...frequency.quality_reasons].sort().join(',') ===
    [...context.deploymentFrequency.qualityReasons].sort().join(',');
  if (
    metric.service_id !== context.serviceId ||
    metric.profile_version !== '0.1-draft' ||
    instant(metric.window.start) !== instant(context.window.start) ||
    instant(metric.window.end) !== instant(context.window.end) ||
    metric.window.calendar_days !== context.window.calendarDays ||
    instant(metric.evidence_cutoff) !== instant(context.evidenceCutoff) ||
    metric.qualification_unknown_count > context.unknownCount ||
    frequency.count !== context.deploymentFrequency.count ||
    frequency.status !== context.deploymentFrequency.status ||
    frequency.deployments_per_day !== context.deploymentFrequency.deploymentsPerDay ||
    !sameReasons ||
    metric.change_fail_rate.ratio !== context.changeFailureRate ||
    metric.failed_deployment_recovery_time.median_seconds !== context.failedDeploymentRecoveryTime
  )
    throw new Error('Mismatched metric context');
  // Native snapshots retain incomplete collection/history/recovery declarations.
  for (const quality of [
    frequency,
    metric.change_lead_time,
    metric.change_fail_rate,
    metric.deployment_rework_rate,
    metric.failed_deployment_recovery_time,
  ]) {
    if (
      quality.status !== 'provisional' ||
      !quality.quality_reasons.includes('incomplete_collection')
    )
      throw new Error('Invalid metric coverage');
  }
  if (
    !metric.change_lead_time.quality_reasons.includes('incomplete_history') ||
    metric.change_lead_time.observation_count !== 0 ||
    metric.change_lead_time.median_seconds !== null ||
    !metric.failed_deployment_recovery_time.quality_reasons.includes('incomplete_recovery_evidence')
  )
    throw new Error('Invalid metric coverage');
  for (const ratio of [metric.change_fail_rate, metric.deployment_rework_rate]) {
    const n = ratio.denominator;
    if (
      n !== frequency.count ||
      ratio.numerator + ratio.unknown_count > n ||
      ratio.ratio !== null ||
      ratio.bounds_scope !== 'observed_population' ||
      ratio.lower_bound !== (n ? ratio.numerator / n : null) ||
      ratio.upper_bound !== (n ? (ratio.numerator + ratio.unknown_count) / n : null)
    )
      throw new Error('Invalid metric ratio');
  }
  const recovery = metric.failed_deployment_recovery_time;
  if (
    (recovery.observation_count === 0) !== (recovery.median_seconds === null) ||
    (recovery.approximate_count === 0 && recovery.approximate_median_seconds !== null)
  )
    throw new Error('Invalid recovery observations');
  return metric;
}

// Structural validation has checked the timestamp grammar before comparison.
function instant(value: string): bigint {
  const match = /^(.*?)(?:\.(\d{1,6}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match?.[1] || !match[3]) throw new Error('Invalid metric timestamp');
  const milliseconds = Date.parse(`${match[1]}${match[3].toUpperCase()}`);
  if (!Number.isFinite(milliseconds)) throw new Error('Invalid metric timestamp');
  return BigInt(milliseconds) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

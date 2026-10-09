import { checkedDataset, type ValidatedSnapshot } from './snapshot.ts';
import { instant, secondsBetween } from './time.ts';
import type { Dataset, Deployment, MetricResult } from './types.ts';

type Quality = Pick<MetricResult['deployment_frequency'], 'status' | 'quality_reasons'>;
type Reason = Quality['quality_reasons'][number];
function quality(reasons: Reason[], count: number, zeroIsComplete = false): Quality {
  const unique = [...new Set(reasons)].sort();
  return {
    status: unique.length
      ? 'provisional'
      : count || zeroIsComplete
        ? 'complete'
        : 'no_observations',
    quality_reasons: unique,
  };
}
function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  const lower = sorted[middle - 1];
  return sorted.length % 2 || lower === undefined ? upper : (lower + upper) / 2;
}
function effective(deployment: Deployment): string {
  if (deployment.effective_at === null)
    throw new Error('Validated qualifying deployment lacks effective time');
  return deployment.effective_at;
}
function affects(deployment: Deployment, start: bigint | null, end: bigint): boolean {
  const scope = deployment.qualification_window;
  if (scope !== null)
    return instant(scope.start) < end && (start === null || instant(scope.end) > start);
  if (deployment.effective_at !== null) {
    const time = instant(deployment.effective_at);
    return (start === null || start <= time) && time < end;
  }
  return true;
}
function serviceResult(data: Dataset, serviceId: string): MetricResult {
  const start = instant(data.window.start),
    end = instant(data.window.end);
  const deployments = data.deployments.filter((record) => record.service_id === serviceId);
  const qualifying = deployments.filter((record) => record.qualification === 'qualifying');
  const population = qualifying.filter(
    (record) => start <= instant(effective(record)) && instant(effective(record)) < end,
  );
  const unknown = deployments.filter(
    (record) => record.qualification === 'unknown' && affects(record, start, end),
  );
  const reasons: Reason[] = [];
  if (!data.collection_complete) reasons.push('incomplete_collection');
  if (unknown.length) reasons.push('unresolved_qualification');
  const n = population.length;
  function ratio(
    field: 'failure' | 'rework',
    value: 'failed' | 'incident_driven',
    reason: Reason,
  ): MetricResult['change_fail_rate'] {
    const numerator = population.filter((record) => record[field] === value).length;
    const unresolved = population.filter((record) => record[field] === 'unknown').length;
    const metricReasons = [...reasons, ...(unresolved ? [reason] : [])];
    return {
      ...quality(metricReasons, n),
      numerator,
      denominator: n,
      unknown_count: unresolved,
      lower_bound: n ? numerator / n : null,
      upper_bound: n ? (numerator + unresolved) / n : null,
      ratio: n && !metricReasons.length ? numerator / n : null,
      bounds_scope: reasons.length ? 'observed_population' : 'full_population',
    };
  }
  const history = qualifying.filter((record) => instant(effective(record)) < end);
  const historyUnknown = deployments.some(
    (record) => record.qualification === 'unknown' && affects(record, null, end),
  );
  const changes = new Map(data.changes.map((record) => [record.id, record]));
  const missing = new Set(
    history.flatMap((record) => record.change_ids).filter((id) => !changes.has(id)),
  );
  const linkageUnknown = history.filter((record) => !record.change_links_complete).length;
  const leadReasons = [...reasons];
  if (!data.deployment_history_complete || historyUnknown) leadReasons.push('incomplete_history');
  if (missing.size) leadReasons.push('unresolved_change_links');
  if (linkageUnknown) leadReasons.push('incomplete_change_linkage');
  const durations: number[] = [];
  for (const change of changes.values()) {
    let first: string | undefined;
    for (const deployment of history) {
      if (!deployment.change_ids.includes(change.id)) continue;
      const time = effective(deployment);
      if (first === undefined || instant(time) < instant(first)) first = time;
    }
    if (first !== undefined && start <= instant(first) && instant(first) < end)
      durations.push(secondsBetween(first, change.committed_at));
  }
  const confirmed = leadReasons.length === 0;
  const byId = new Map(deployments.map((record) => [record.id, record]));
  const episodes = data.incidents.filter(
    (record) =>
      record.service_id === serviceId &&
      start <= instant(record.failure_started_at) &&
      instant(record.failure_started_at) < end,
  );
  const completed: number[] = [],
    approximate: number[] = [];
  let openCount = 0,
    approximateCount = 0,
    unresolvedCount = 0;
  for (const episode of episodes) {
    const causal = byId.get(episode.causal_deployment_id);
    if (causal?.qualification !== 'qualifying' || causal.failure !== 'failed') {
      unresolvedCount++;
      continue;
    }
    if (episode.start_is_approximate) approximateCount++;
    if (episode.restored_at === null) openCount++;
    else
      (episode.start_is_approximate ? approximate : completed).push(
        secondsBetween(episode.restored_at, episode.failure_started_at),
      );
  }
  const unknownFailures = history.filter((record) => record.failure === 'unknown').length;
  const recoveryReasons = [...reasons];
  if (!data.recovery_evidence_complete) recoveryReasons.push('incomplete_recovery_evidence');
  if (unknownFailures) recoveryReasons.push('unknown_failure_classification');
  if (unresolvedCount) recoveryReasons.push('unresolved_causal_links');
  if (openCount) recoveryReasons.push('open_recovery_episodes');
  if (approximateCount) recoveryReasons.push('approximate_recovery_start');
  return {
    dataset_id: data.dataset_id,
    profile_version: data.profile_version,
    service_id: serviceId,
    window: { ...data.window },
    evidence_cutoff: data.evidence_cutoff,
    qualification_unknown_count: unknown.length,
    deployment_frequency: {
      ...quality(reasons, n, true),
      count: n,
      deployments_per_day: reasons.length ? null : n / data.window.calendar_days,
    },
    change_fail_rate: ratio('failure', 'failed', 'unknown_failure_classification'),
    deployment_rework_rate: ratio('rework', 'incident_driven', 'unknown_rework_classification'),
    change_lead_time: {
      ...quality(leadReasons, durations.length),
      observation_count: confirmed ? durations.length : 0,
      candidate_count: confirmed ? 0 : durations.length,
      unresolved_change_count: missing.size,
      linkage_unknown_count: linkageUnknown,
      median_seconds: confirmed ? median(durations) : null,
    },
    failed_deployment_recovery_time: {
      ...quality(recoveryReasons, completed.length),
      observation_count: completed.length,
      open_count: openCount,
      approximate_count: approximateCount,
      unresolved_count: unresolvedCount,
      unknown_failure_count: unknownFailures,
      median_seconds: median(completed),
      approximate_median_seconds: median(approximate),
    },
  };
}
/** One complete result per service; service ordering is deterministic. */
export function calculate(snapshot: ValidatedSnapshot): MetricResult[] {
  const data = checkedDataset(snapshot);
  return [...data.services]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((service) => serviceResult(data, service.id));
}

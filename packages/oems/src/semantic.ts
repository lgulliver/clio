import type { ValidationIssue, ValidationResult } from './schema.ts';
import { dayMicroseconds, instant } from './time.ts';
import type { Dataset } from './types.ts';

class SemanticError extends Error {
  readonly issue: ValidationIssue;
  constructor(issue: ValidationIssue) {
    super(issue.message);
    this.issue = issue;
  }
}
function require(condition: boolean, code: string, path: string): asserts condition {
  if (!condition)
    throw new SemanticError({ layer: 'semantic', code, path, message: `${code}: ${path}` });
}

function segment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Object key order is immaterial; arrays retain order for duplicate identity. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Requires structural validation first. Produces a deduplicated copy, never selects revisions. */
export function validateSemantics(input: Dataset): ValidationResult<Dataset> {
  try {
    const { window } = input;
    const start = instant(window.start),
      end = instant(window.end),
      cutoff = instant(input.evidence_cutoff);
    require(start < end, 'invalid_window', '/window');
    require([window.start, window.end].every(
      (value) => /(?:[Zz]|\+00:00)$/.test(value) && instant(value) % dayMicroseconds === 0n,
    ), 'unsupported_calendar', '/window');
    require(BigInt(window.calendar_days) ===
      (end - start) / dayMicroseconds, 'calendar_days_mismatch', '/window/calendar_days');
    require(cutoff >= end, 'cutoff_before_window_end', '/evidence_cutoff');
    const seen = new Set<string>();
    function deduplicate<T extends { id: string; observed_at: string }>(
      records: T[],
      kind: string,
    ): T[] {
      const byId = new Map<string, T>();
      for (const record of records) {
        const path = `/${kind}/${segment(record.id)}`;
        const prior = byId.get(record.id);
        if (prior) {
          require(canonical(record) === canonical(prior), 'conflicting_id', path);
          continue;
        }
        require(!seen.has(record.id), 'cross_kind_id', path);
        seen.add(record.id);
        byId.set(record.id, record);
        const observed = instant(record.observed_at);
        require(observed <= cutoff, 'evidence_after_cutoff', path);
        for (const [field, value] of Object.entries(record)) {
          if (
            ['committed_at', 'effective_at', 'failure_started_at', 'restored_at'].includes(field) &&
            typeof value === 'string'
          ) {
            require(instant(value) <= observed, 'event_after_observation', `${path}/${field}`);
          }
        }
      }
      return [...byId.values()];
    }
    const data: Dataset = {
      ...input,
      services: deduplicate(input.services, 'services'),
      changes: deduplicate(input.changes, 'changes'),
      deployments: deduplicate(input.deployments, 'deployments'),
      incidents: deduplicate(input.incidents, 'incidents'),
    };
    const services = new Set(data.services.map((record) => record.id));
    const changes = new Map(data.changes.map((record) => [record.id, record]));
    const changeKeys = new Set<string>();
    for (const change of data.changes) {
      const key = JSON.stringify([change.repository_id, change.commit_id]);
      require(!changeKeys.has(key), 'change_alias', `/changes/${segment(change.id)}`);
      changeKeys.add(key);
    }
    const rollouts = new Set<string>();
    for (const deployment of data.deployments) {
      const path = `/deployments/${segment(deployment.id)}`;
      require(services.has(deployment.service_id), 'missing_service', path);
      const key = JSON.stringify([deployment.service_id, deployment.rollout_group_id]);
      require(!rollouts.has(key), 'rollout_alias', path);
      rollouts.add(key);
      if (deployment.qualification === 'qualifying')
        require(deployment.environment === 'production' &&
          deployment.effective_at !== null, 'invalid_qualification', path);
      if (deployment.qualification === 'excluded')
        require(deployment.effective_at === null, 'excluded_effective_time', path);
      const scope = deployment.qualification_window;
      require(deployment.qualification === 'unknown' ||
        scope === null, 'unexpected_qualification_window', path);
      if (scope !== null) {
        require(instant(scope.start) < instant(scope.end), 'invalid_qualification_window', path);
        if (deployment.effective_at !== null)
          require(instant(scope.start) <= instant(deployment.effective_at) &&
            instant(deployment.effective_at) <
              instant(scope.end), 'qualification_time_outside_scope', path);
      }
      require(deployment.failure !== 'failed' ||
        deployment.qualification === 'qualifying', 'failure_without_qualification', path);
      if (deployment.qualification === 'qualifying' && deployment.effective_at !== null) {
        for (const id of deployment.change_ids) {
          const change = changes.get(id);
          if (change)
            require(instant(change.committed_at) <=
              instant(deployment.effective_at), 'negative_lead_time', `${path}/${segment(id)}`);
        }
      }
    }
    const deployments = new Map(data.deployments.map((record) => [record.id, record]));
    for (const episode of data.incidents) {
      const path = `/incidents/${segment(episode.id)}`;
      require(services.has(episode.service_id), 'missing_service', path);
      if (episode.restored_at !== null)
        require(instant(episode.restored_at) >=
          instant(episode.failure_started_at), 'negative_recovery_time', path);
      const causal = deployments.get(episode.causal_deployment_id);
      if (!causal) continue;
      require(causal.service_id === episode.service_id, 'cross_service_causality', path);
      require(causal.qualification !== 'excluded', 'excluded_causal_deployment', path);
      require(causal.failure !==
        'no_recorded_failure', 'contradictory_causal_classification', path);
      if (causal.effective_at !== null) {
        require(instant(episode.failure_started_at) >=
          instant(causal.effective_at), 'onset_before_deployment', path);
        if (episode.start_is_approximate)
          require(instant(episode.failure_started_at) ===
            instant(causal.effective_at), 'invalid_approximation', path);
      }
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof SemanticError) return { ok: false, errors: [error.issue] };
    throw error;
  }
}

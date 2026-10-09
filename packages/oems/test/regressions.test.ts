import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  calculate,
  type Dataset,
  type MetricResult,
  ValidatedSnapshot,
  validateSnapshot,
  validateStructure,
} from '../src/index.ts';

function fixture(name = 'complete'): Dataset {
  const input: unknown = JSON.parse(
    readFileSync(new URL(`../vendor/conformance/v0.1/cases/${name}.json`, import.meta.url), 'utf8'),
  );
  const checked = validateStructure('dataset', input);
  if (!checked.ok) throw new Error('Invalid fixture');
  return checked.data;
}
function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Missing test record');
  return value;
}
function run(input: unknown): MetricResult {
  const checked = validateSnapshot(input);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return first(calculate(checked.data));
}
function rejected(input: unknown, code: string) {
  const checked = validateSnapshot(input);
  expect(checked.ok).toBe(false);
  if (!checked.ok) expect(checked.errors.map((error) => error.code)).toContain(code);
}

describe('microsecond precision and boundaries', () => {
  it('keeps final microsecond inside window; excludes exact end', () => {
    const data = fixture('configuration-only');
    const deployment = first(data.deployments);
    data.deployments = [
      { ...deployment, effective_at: '2026-10-10T23:59:59.999999Z' },
      {
        ...deployment,
        id: 'deployment:end',
        rollout_group_id: 'rollout:end',
        effective_at: '2026-10-11T00:00:00.000000Z',
      },
    ];
    expect(run(data).deployment_frequency.count).toBe(1);
  });
  it('preserves microsecond lead and recovery durations', () => {
    const data = fixture();
    const deployment = first(data.deployments),
      change = first(data.changes),
      episode = first(data.incidents);
    data.changes = [{ ...change, committed_at: '2026-10-01T08:00:00.000001Z' }];
    data.deployments = [
      {
        ...deployment,
        effective_at: '2026-10-01T08:00:00.000003Z',
        change_ids: [change.id],
        failure: 'failed',
      },
    ];
    data.incidents = [
      {
        ...episode,
        causal_deployment_id: deployment.id,
        failure_started_at: '2026-10-01T08:00:00.000005Z',
        restored_at: '2026-10-01T08:00:00.000008Z',
      },
    ];
    const result = run(data);
    expect(result.change_lead_time.median_seconds).toBe(0.000002);
    expect(result.failed_deployment_recovery_time.median_seconds).toBe(0.000003);
  });
  it('rejects evidence one microsecond after cutoff', () => {
    const data = fixture();
    first(data.services).observed_at = '2026-10-12T00:00:00.000001Z';
    rejected(data, 'evidence_after_cutoff');
  });
  it('rejects event one microsecond after observation', () => {
    const data = fixture();
    first(data.changes).observed_at = '2026-10-01T06:59:59.999999Z';
    rejected(data, 'event_after_observation');
  });
  it('rejects negative lead time hidden inside one millisecond', () => {
    const data = fixture();
    first(data.changes).committed_at = '2026-10-01T08:00:00.000002Z';
    first(data.deployments).effective_at = '2026-10-01T08:00:00.000001Z';
    rejected(data, 'negative_lead_time');
  });
  it('rejects partial microsecond-day and nonzero offset calendar boundaries', () => {
    const data = fixture();
    data.window.start = '2026-10-01T00:00:00.000001Z';
    rejected(data, 'unsupported_calendar');
    data.window.start = '2026-10-01T01:00:00+01:00';
    rejected(data, 'unsupported_calendar');
  });
  it('treats offset timestamps as equivalent microsecond instants', () => {
    const data = fixture();
    first(data.deployments).effective_at = '2026-10-01T09:00:00.000002+01:00';
    first(data.changes).committed_at = '2026-10-01T08:00:00.000001Z';
    data.changes = [first(data.changes)];
    first(data.deployments).change_ids = [first(data.changes).id];
    expect(run(data).change_lead_time.median_seconds).toBe(0.000001);
  });
});

describe('deployment semantic rejection rules', () => {
  it('rejects an excluded deployment with an effective timestamp', () => {
    const data = fixture();
    first(data.deployments).qualification = 'excluded';
    expect(validateStructure('dataset', data).ok).toBe(true);
    rejected(data, 'excluded_effective_time');
  });
  it('rejects a qualification window on an already qualifying deployment', () => {
    const data = fixture();
    first(data.deployments).qualification_window = {
      start: data.window.start,
      end: data.window.end,
    };
    expect(validateStructure('dataset', data).ok).toBe(true);
    rejected(data, 'unexpected_qualification_window');
  });
  it('rejects an unknown deployment timestamp outside its qualification scope', () => {
    const data = fixture();
    const deployment = first(data.deployments);
    deployment.qualification = 'unknown';
    deployment.qualification_window = {
      start: '2026-10-02T00:00:00Z',
      end: '2026-10-03T00:00:00Z',
    };
    expect(validateStructure('dataset', data).ok).toBe(true);
    rejected(data, 'qualification_time_outside_scope');
  });
  it('rejects a confirmed failure without qualifying deployment evidence', () => {
    const data = fixture();
    const deployment = first(data.deployments);
    deployment.qualification = 'unknown';
    deployment.failure = 'failed';
    deployment.failure_evidence_refs = ['https://example.invalid/failure'];
    expect(validateStructure('dataset', data).ok).toBe(true);
    rejected(data, 'failure_without_qualification');
  });
});

describe('canonical identity, isolation and quality', () => {
  it('deduplicates reordered object keys but rejects reordered arrays', () => {
    const data = fixture();
    const deployment = first(data.deployments);
    // Reordered property insertion does not change record identity.
    const reordered = validateStructure(
      'deployment',
      Object.fromEntries(Object.entries(deployment).reverse()),
    );
    if (!reordered.ok) throw new Error('Invalid reordered record');
    data.deployments.push(reordered.data);
    expect(run(data).deployment_frequency.count).toBe(10);
    first(data.deployments).change_ids = [...deployment.change_ids].reverse();
    rejected(data, 'conflicting_id');
  });
  it('deduplicates extension keys with equal locale collation despite insertion order', () => {
    const data = fixture();
    const service = first(data.services);
    service.extensions = { é: 1, 'e\u0301': 2 };
    data.services.push({ ...service, extensions: { 'e\u0301': 2, é: 1 } });
    expect(validateSnapshot(data).ok).toBe(true);
  });
  it('rejects identifiers shared across record kinds', () => {
    const data = fixture();
    first(data.changes).id = first(data.services).id;
    rejected(data, 'cross_kind_id');
  });
  it('separates coverage declarations for services emitted in separate datasets', () => {
    const complete = fixture('empty');
    const incomplete = {
      ...fixture('empty'),
      dataset_id: 'other-service',
      collection_complete: false,
    };
    first(incomplete.services).id = 'service:other';
    expect(run(complete).deployment_frequency).toMatchObject({
      status: 'complete',
      deployments_per_day: 0,
    });
    expect(run(incomplete).deployment_frequency).toMatchObject({
      status: 'provisional',
      deployments_per_day: null,
    });
    expect(run(complete).deployment_frequency.status).toBe('complete');
  });
  it('applies incomplete dataset coverage to every declared service', () => {
    const data = fixture('empty');
    data.services.push({ ...first(data.services), id: 'service:other' });
    data.collection_complete = false;
    data.recovery_evidence_complete = false;
    const checked = validateSnapshot(data);
    if (!checked.ok) throw new Error('Invalid fixture');
    const results = calculate(checked.data);
    expect(results).toHaveLength(2);
    for (const result of results) {
      for (const metric of [
        result.deployment_frequency,
        result.change_lead_time,
        result.change_fail_rate,
        result.deployment_rework_rate,
        result.failed_deployment_recovery_time,
      ]) {
        expect(metric.status).toBe('provisional');
        expect(metric.quality_reasons).toContain('incomplete_collection');
      }
      expect(result.failed_deployment_recovery_time.quality_reasons).toContain(
        'incomplete_recovery_evidence',
      );
      expect(result.deployment_frequency.deployments_per_day).toBeNull();
    }
  });
  it('escapes slash and tilde in semantic record identifiers', () => {
    const data = fixture();
    const change = first(data.changes);
    change.id = 'change:repo/path~x';
    data.changes.push({ ...change, commit_id: 'conflicting' });
    const checked = validateSnapshot(data);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors[0]?.path).toBe('/changes/change:repo~1path~0x');
  });
  it('keeps historical unknown failure in recovery quality, outside ratio window', () => {
    const data = fixture('prior-deployment-onset-cohort');
    first(data.deployments).failure = 'unknown';
    const result = run(data);
    expect(result.failed_deployment_recovery_time.unknown_failure_count).toBe(1);
    expect(result.failed_deployment_recovery_time.unresolved_count).toBe(1);
    expect(result.failed_deployment_recovery_time.quality_reasons).toContain(
      'unknown_failure_classification',
    );
    expect(result.change_fail_rate.unknown_count).toBe(0);
  });
  it('does not retain caller mutations or expose mutable validated state', () => {
    const data = fixture();
    const checked = validateSnapshot(data);
    if (!checked.ok) throw new Error('Invalid fixture');
    const before = calculate(checked.data);
    data.deployments.length = 0;
    data.window.calendar_days = 1;
    expect(calculate(checked.data)).toEqual(before);
    expect(Object.isFrozen(checked.data.data.deployments)).toBe(true);
    expect(Object.isFrozen(first(checked.data.data.deployments))).toBe(true);
    expect(Reflect.set(checked.data.data.window, 'calendar_days', 1)).toBe(false);
    expect(calculate(checked.data)).toEqual(before);
    before[0]?.deployment_frequency.quality_reasons.push('incomplete_collection');
    expect(first(calculate(checked.data)).deployment_frequency.quality_reasons).toEqual([]);
  });
  it('rejects forged token and JavaScript constructor bypass', () => {
    const forged: unknown = Object.create(ValidatedSnapshot.prototype);
    expect(() => Reflect.apply(calculate, undefined, [forged])).toThrow(
      'Calculation requires a validated snapshot',
    );
    expect(() => Reflect.construct(ValidatedSnapshot, [fixture()])).toThrow(
      'Calculation requires a validated snapshot',
    );
  });
  it('rejects cyclic/non-JSON extensions without crashing', () => {
    const data = fixture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    first(data.services).extensions = cyclic;
    rejected(data, 'invalid_json');
    first(data.services).extensions = { missing: undefined };
    rejected(data, 'invalid_json');
  });
});

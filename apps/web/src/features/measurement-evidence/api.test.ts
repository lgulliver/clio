import { validateStructure } from '@clio/oems';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../identity/api';
import { parseAuthorities, parseHistoryPage, parseResult, parseRun } from './api';
import {
  authorities,
  basis,
  cursor,
  page,
  pageCursor,
  prewindowUnknownFixture,
  resultFixture,
  runFixture,
  scope,
} from './fixtures.test-support';

describe('independent measurement boundary', () => {
  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])('accepts pinned five metrics complete=%s empty=%s', (complete, empty) => {
    const result = resultFixture(complete, empty);
    expect(parseResult(result, scope)).toEqual(result);
    if (empty && complete) {
      expect(result.metricResult.deployment_frequency.deployments_per_day).toBe(0);
      expect(result.metricResult.change_fail_rate.status).toBe('no_observations');
      expect(result.metricResult.change_fail_rate.ratio).toBeNull();
    }
    if (empty && !complete)
      expect(result.metricResult.deployment_frequency.deployments_per_day).toBeNull();
  });
  it.each(['token', 'snapshot', 'policyRef', 'extensions', 'snapshotDigest', 'dataset'])(
    'rejects private result field %s',
    (key) => {
      expect(() => parseResult({ ...resultFixture(), [key]: 'private' }, scope)).toThrow(ApiError);
    },
  );
  it.each(['metric', 'metric-window', 'assessment', 'coverage', 'window', 'run', 'authority'])(
    'rejects private nested field in %s',
    (location) => {
      const result = resultFixture();
      if (location === 'metric')
        expect(() =>
          parseResult(
            { ...result, metricResult: { ...result.metricResult, source_refs: ['private'] } },
            scope,
          ),
        ).toThrow();
      if (location === 'metric-window')
        expect(() =>
          parseResult(
            {
              ...result,
              metricResult: {
                ...result.metricResult,
                window: { ...result.metricResult.window, private: true },
              },
            },
            scope,
          ),
        ).toThrow();
      if (location === 'assessment')
        expect(() =>
          parseResult({ ...result, assessment: { ...result.assessment, refs: [] } }, scope),
        ).toThrow();
      if (location === 'coverage')
        expect(() =>
          parseResult({ ...result, coverage: { ...result.coverage, refs: [] } }, scope),
        ).toThrow();
      if (location === 'window')
        expect(() =>
          parseResult({ ...result, window: { ...result.window, refs: [] } }, scope),
        ).toThrow();
      if (location === 'run')
        expect(() => parseRun({ run: { ...runFixture(), token: 'private' } }, scope)).toThrow();
      if (location === 'authority')
        expect(() =>
          parseAuthorities({ authorities: [{ ...authorities[0], policyRef: 'private' }] }),
        ).toThrow();
    },
  );
  it.each([
    { workspaceId: basis.id },
    { serviceId: basis.id },
    { oemsRevision: 'untrusted' },
    { provider: 'mock' },
    { connectionRevision: 0 },
    { basisEvidenceCutoff: undefined },
    { basisEvidenceCutoff: '2026-01-02T00:00:00Z' },
    { basisEvidenceCutoff: resultFixture().evidenceCutoff },
    { basisEvidenceCutoff: '2026-01-04T00:01:00.000002Z' },
    { evidenceCutoff: '2026-02-30T00:00:00Z' },
  ])('rejects unsafe context %#', (patch) =>
    expect(() => parseResult({ ...resultFixture(), ...patch }, scope)).toThrow(ApiError),
  );
  it.each(['service', 'cutoff', 'window', 'profile', 'assessment'])(
    'binds metric context and coverage: %s',
    (field) => {
      const value = resultFixture();
      if (field === 'service') value.metricResult.service_id = basis.id;
      if (field === 'cutoff') value.metricResult.evidence_cutoff = '2026-01-04T00:01:00.000002Z';
      if (field === 'window') value.metricResult.window.calendar_days = 3;
      if (field === 'profile') Object.assign(value.metricResult, { profile_version: 'other' });
      if (field === 'assessment')
        value.assessment.blockers.push('population_missing', 'population_missing');
      expect(() => parseResult(value, scope)).toThrow();
    },
  );
  it.each([
    'population_missing',
    'gap_resolution_mismatch',
    'history_missing',
    'recovery_missing',
  ] as const)('rejects blockers contradicting complete coverage: %s', (blocker) => {
    const value = resultFixture();
    value.assessment.blockers.push(blocker);
    expect(() => parseResult(value, scope)).toThrow(ApiError);
  });
  it.each(['collection', 'history', 'recovery'] as const)(
    'requires matching blocker for incomplete %s coverage',
    (area) => {
      const value = resultFixture(false);
      value.assessment.blockers = value.assessment.blockers.filter((blocker) =>
        area === 'collection'
          ? !blocker.startsWith('population_')
          : !blocker.startsWith(`${area}_`),
      );
      expect(() => parseResult(value, scope)).toThrow(ApiError);
    },
  );
  it('accepts complete retained history with pre-window unknown qualification', () => {
    const value = prewindowUnknownFixture();
    expect(value.metricResult.change_lead_time.quality_reasons).toContain('incomplete_history');
    expect(value.metricResult.qualification_unknown_count).toBe(0);
    expect(parseResult(value, scope)).toEqual(value);
  });
  it.each([
    'deployment_frequency',
    'change_lead_time',
    'change_fail_rate',
    'deployment_rework_rate',
    'failed_deployment_recovery_time',
  ] as const)('rejects metric-only collection mismatch for %s', (metric) => {
    const value = resultFixture(false);
    expect(parseResult(value, scope)).toEqual(value);
    // Replace only this metric with its schema-valid complete observation.
    Object.assign(value.metricResult[metric], resultFixture().metricResult[metric]);
    expect(validateStructure('metric-result', value.metricResult).ok).toBe(true);
    expect(() => parseResult(value, scope)).toThrow(ApiError);
  });
  it('rejects metric-only missing history reason with incomplete coverage', () => {
    const value = resultFixture(false);
    expect(parseResult(value, scope)).toEqual(value);
    value.metricResult.change_lead_time.quality_reasons =
      value.metricResult.change_lead_time.quality_reasons.filter(
        (reason) => reason !== 'incomplete_history',
      );
    expect(validateStructure('metric-result', value.metricResult).ok).toBe(true);
    expect(() => parseResult(value, scope)).toThrow(ApiError);
  });
  it.each([true, false])('rejects metric-only recovery mismatch complete=%s', (complete) => {
    const value = resultFixture(complete);
    expect(parseResult(value, scope)).toEqual(value);
    const metric = value.metricResult.failed_deployment_recovery_time;
    if (complete) metric.status = 'provisional';
    metric.quality_reasons = complete
      ? ['incomplete_recovery_evidence']
      : metric.quality_reasons.filter((reason) => reason !== 'incomplete_recovery_evidence');
    expect(validateStructure('metric-result', value.metricResult).ok).toBe(true);
    expect(() => parseResult(value, scope)).toThrow(ApiError);
  });
  it.each([true, false])('rejects metric-only qualification mismatch reason=%s', (reason) => {
    const value = resultFixture(false);
    expect(parseResult(value, scope)).toEqual(value);
    if (reason)
      value.metricResult.deployment_frequency.quality_reasons.push('unresolved_qualification');
    else value.metricResult.qualification_unknown_count = 1;
    expect(validateStructure('metric-result', value.metricResult).ok).toBe(true);
    expect(() => parseResult(value, scope)).toThrow(ApiError);
  });
  it('retains microseconds when comparing new and original cutoffs', () => {
    const value = resultFixture();
    value.basisEvidenceCutoff = '2026-01-04T00:01:00.000000Z';
    expect(parseResult(value, scope).evidenceCutoff).toBe('2026-01-04T00:01:00.000001Z');
  });
  it('binds response to requested run, basis and original context', () => {
    const run = runFixture();
    expect(parseRun({ run }, scope, { id: run.id, basis })).toEqual(run);
    expect(() => parseRun({ run }, scope, { id: basis.id })).toThrow();
    expect(() =>
      parseRun({ run }, scope, { basis: { ...basis, connectionRevision: 2 } }),
    ).toThrow();
    expect(() => parseRun({ run: { ...run, basisRunId: run.id } }, scope)).toThrow();
    expect(() => parseRun({ run: { ...run, completedAt: null } }, scope)).toThrow();
    expect(() =>
      parseRun({ run: { ...run, status: 'failed', failureCode: 'secret_error' } }, scope),
    ).toThrow();
  });
  it('validates configured descriptors without granting missing receipts', () => {
    expect(parseAuthorities({ authorities })).toEqual(authorities);
    expect(() => parseAuthorities({ authorities: [...authorities, authorities[0]] })).toThrow();
    expect(() =>
      parseAuthorities({ authorities: [{ ...authorities[0], receiptAvailable: 'yes' }] }),
    ).toThrow();
  });
});
describe('opaque measurement history', () => {
  it('accepts exact tuple cursor and strictly older page', () => {
    expect(
      parseHistoryPage({ runs: page, nextCursor: pageCursor }, scope, { succeeded: true }).runs,
    ).toHaveLength(25);
    const older = { ...runFixture(), id: '00000001-1111-4111-8111-111111111111' };
    expect(
      parseHistoryPage({ runs: [older], nextCursor: null }, scope, {
        cursor: pageCursor,
        succeeded: true,
      }).runs,
    ).toEqual([older]);
  });
  it.each(['=', 'not-a-cursor', 'x&status=failed', basis.id])(
    'rejects malformed opaque cursor %s',
    (cursor) => {
      expect(() => parseHistoryPage({ runs: [], nextCursor: null }, scope, { cursor })).toThrow();
    },
  );
  it('rejects duplicates, unordered tuples, wrong filters and cursor rebinding', () => {
    expect(() => parseHistoryPage({ runs: [page[1], page[0]], nextCursor: null }, scope)).toThrow();
    expect(() => parseHistoryPage({ runs: [page[0], page[0]], nextCursor: null }, scope)).toThrow();
    expect(() =>
      parseHistoryPage({ runs: page, nextCursor: cursor(runFixture()) }, scope),
    ).toThrow();
    expect(() =>
      parseHistoryPage({ runs: page, nextCursor: pageCursor }, scope, { cursor: pageCursor }),
    ).toThrow();
    expect(() =>
      parseHistoryPage(
        {
          runs: [{ ...runFixture(), status: 'pending', result: null, completedAt: null }],
          nextCursor: null,
        },
        scope,
        { succeeded: true },
      ),
    ).toThrow();
  });
});

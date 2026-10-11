import { describe, expect, it } from 'vitest';
import { ApiError } from '../identity/api';
import { lifecyclePreview } from '../mock-collection/lifecycle.test-support';
import { parseMapping, parsePreview, parseSavedMapping } from './api';

const scope = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  serviceId: '33333333-3333-4333-8333-333333333333',
};
const saved = {
  ...scope,
  mode: 'mock',
  revision: 1,
  primaryProvider: 'github',
  productionEnvironment: 'production',
  exposureAttested: false,
  observedAt: '2026-10-10T00:00:00Z',
};
const fictional = {
  ...scope,
  mode: 'mock',
  mappingRevision: 1,
  oemsRevision: '5908bb12cdf24e7528088237dff9dca4c10ff45f',
  window: {
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-09T00:00:00Z',
    timezone: 'UTC',
    calendarDays: 8,
  },
  evidenceCutoff: '2026-10-11T00:00:00Z',
  qualification: 'unknown',
  rolloutCount: 1,
  coverage: {
    collectionComplete: false,
    deploymentHistoryComplete: false,
    recoveryEvidenceComplete: false,
  },
  deploymentFrequency: {
    count: 0,
    status: 'provisional',
    deploymentsPerDay: null,
    qualityReasons: ['incomplete_coverage'],
  },
  changeFailureRate: null,
  failedDeploymentRecoveryTime: null,
};
function mapping() {
  const value = parseMapping({ mapping: saved }, scope);
  if (!value) throw new Error('Test mapping missing');
  return value;
}
describe('mock contract parsing', () => {
  it('accepts unset settings and validated saved preview without converting nulls', () => {
    expect(parseMapping({ mapping: null }, scope)).toBeNull();
    expect(parsePreview({ preview: fictional }, mapping())).toEqual(fictional);
    expect(parseSavedMapping({ mapping: saved }, scope, null)).toEqual(saved);
  });
  it.each([
    { mode: 'live' },
    { workspaceId: scope.serviceId },
    { serviceId: scope.workspaceId },
    { revision: 0 },
    { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { primaryProvider: 'other' },
    { exposureAttested: 'true' },
    { productionEnvironment: '' },
    { productionEnvironment: ' production ' },
    { productionEnvironment: '😀'.repeat(201) },
    { observedAt: '2026-02-30T00:00:00Z' },
    { observedAt: 'yesterday' },
  ])('rejects malformed or mismatched mapping %j', (patch) => {
    expect(() => parseMapping({ mapping: { ...saved, ...patch } }, scope)).toThrow(ApiError);
  });
  it('counts Unicode code points and rejects null/stale save success', () => {
    expect(
      parseMapping({ mapping: { ...saved, productionEnvironment: '😀'.repeat(200) } }, scope)
        ?.productionEnvironment,
    ).toHaveLength(400);
    expect(() => parseSavedMapping({ mapping: null }, scope, null)).toThrow(ApiError);
    expect(() => parseSavedMapping({ mapping: saved }, scope, 1)).toThrow(ApiError);
  });
  it.each([
    { mode: 'live' },
    { workspaceId: scope.serviceId },
    { serviceId: scope.workspaceId },
    { mappingRevision: 2 },
    { oemsRevision: 'different' },
    { rolloutCount: -1 },
    { rolloutCount: 0.5 },
    { qualification: 'complete' },
    { evidenceCutoff: '2026-10-01T00:00:00Z' },
    { window: { ...fictional.window, end: fictional.window.start } },
    { window: { ...fictional.window, calendarDays: 0 } },
    { window: { ...fictional.window, timezone: 'Europe/London' } },
    { coverage: { ...fictional.coverage, collectionComplete: true } },
    { coverage: { ...fictional.coverage, recoveryEvidenceComplete: null } },
    { deploymentFrequency: { ...fictional.deploymentFrequency, count: -1 } },
    { deploymentFrequency: { ...fictional.deploymentFrequency, deploymentsPerDay: 0 } },
    { deploymentFrequency: { ...fictional.deploymentFrequency, status: 'final' } },
    { deploymentFrequency: { ...fictional.deploymentFrequency, qualityReasons: [42] } },
    { changeFailureRate: 0 },
    { failedDeploymentRecoveryTime: 0 },
  ])('rejects malformed or mismatched preview %j', (patch) => {
    expect(() => parsePreview({ preview: { ...fictional, ...patch } }, mapping())).toThrow(
      ApiError,
    );
  });
  it('accepts ISO offsets and orders microsecond timestamps without rounding', () => {
    expect(
      parseMapping({ mapping: { ...saved, observedAt: '2026-10-10T01:00:00+01:00' } }, scope)
        ?.observedAt,
    ).toBe('2026-10-10T01:00:00+01:00');
    const precise = { ...mapping(), observedAt: '2026-10-10T00:00:00.000002Z' };
    expect(() =>
      parsePreview(
        { preview: { ...fictional, evidenceCutoff: '2026-10-10T00:00:00.000001Z' } },
        precise,
      ),
    ).toThrow(ApiError);
    expect(
      parsePreview(
        {
          preview: {
            ...fictional,
            window: {
              ...fictional.window,
              start: '2026-10-01T00:00:00.000001Z',
              end: '2026-10-01T00:00:00.000002Z',
            },
          },
        },
        mapping(),
      ).window.end,
    ).toBe('2026-10-01T00:00:00.000002Z');
  });
});

it('binds full fictional results to saved scenario, version, scope and pinned metric schema', () => {
  const complete = {
    ...mapping(),
    scenario: 'complete-lifecycle' as const,
    exposureAttested: true,
    observedAt: '2026-10-10T00:00:00.000Z',
  };
  expect(parsePreview({ preview: lifecyclePreview }, complete)).toEqual(lifecyclePreview);
  for (const change of [
    { scenario: 'partial' },
    { resultVersion: 'clio.mock.lifecycle.v2' },
    { serviceId: scope.workspaceId },
    { mappingRevision: 2 },
    { oemsRevision: 'other' },
    { coverage: { ...lifecyclePreview.coverage, collectionComplete: false } },
    { metricResult: { ...lifecyclePreview.metricResult, service_id: scope.workspaceId } },
    { metricResult: { ...lifecyclePreview.metricResult, privateEvidence: 'forbidden' } },
  ])
    expect(() => parsePreview({ preview: { ...lifecyclePreview, ...change } }, complete)).toThrow();
  expect(() => parsePreview({ preview: lifecyclePreview }, mapping())).toThrow();
  expect(() => parsePreview({ preview: fictional }, complete)).toThrow();
  expect(() => parseMapping({ mapping: { ...saved, scenario: 'unknown' } }, scope)).toThrow();
});

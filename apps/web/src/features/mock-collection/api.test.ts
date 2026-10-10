import { describe, expect, it } from 'vitest';
import { ApiError } from '../identity/api';
import { parseRun, parseRuns } from './api';
import { completed, preview, queued, scope } from './fixtures.test-support';

describe('stored mock run parsing', () => {
  it('reads historical results without latest mapping and keeps microseconds/nulls/pin', () => {
    expect(parseRun({ run: completed }, scope)).toEqual(completed);
    expect(
      parseRuns({ runs: [completed] }, scope)[0]?.result?.deploymentFrequency.deploymentsPerDay,
    ).toBeNull();
    expect(parseRun({ run: queued }, scope).mappingObservedAt).toBe('2026-10-10T00:00:00.000001Z');
  });
  it.each([
    { id: 'bad' },
    { workspaceId: scope.serviceId },
    { serviceId: scope.workspaceId },
    { mode: 'live' },
    { mappingRevision: 0 },
    { mappingRevision: 1.5 },
    { mappingRevision: Number.MAX_SAFE_INTEGER + 1 },
    { primaryProvider: 'other' },
    { status: 'complete' },
    { attempts: -1 },
    { attempts: 4 },
    { attempts: 1.5 },
    { createdAt: '2026-02-30T00:00:00Z' },
    { updatedAt: 'yesterday' },
    { mappingObservedAt: '2026-10-10T00:00:00+00:00' },
    { updatedAt: '2026-10-10T00:00:00Z' },
    { completedAt: null },
    { completedAt: '2026-10-10T00:03:00Z' },
    { failureCode: 'mock_processing_failed' },
    { result: null },
    { result: { ...preview, mappingRevision: 2 } },
    { result: { ...preview, oemsRevision: 'different' } },
    { result: { ...preview, evidenceCutoff: '2026-10-10T00:00:00.000000Z' } },
    { result: { ...preview, coverage: { ...preview.coverage, collectionComplete: true } } },
    { leaseToken: 'private' },
  ])('fails closed for inconsistent public run %j', (patch) => {
    expect(() => parseRun({ run: { ...completed, ...patch } }, scope)).toThrow(ApiError);
  });
  it('enforces terminal nullability and exact requested revision', () => {
    expect(
      parseRun(
        {
          run: {
            ...completed,
            status: 'failed',
            failureCode: 'mock_processing_failed',
            result: null,
          },
        },
        scope,
      ).status,
    ).toBe('failed');
    expect(() => parseRun({ run: { ...queued, result: preview } }, scope)).toThrow(ApiError);
    expect(() =>
      parseRun({ run: { ...queued, completedAt: completed.completedAt } }, scope),
    ).toThrow(ApiError);
    expect(() =>
      parseRun({ run: { ...completed, status: 'failed', result: null } }, scope),
    ).toThrow(ApiError);
    expect(() => parseRun({ run: completed }, scope, 2)).toThrow(ApiError);
  });
  it('enforces latest-25 scope, uniqueness and ordering without truncation', () => {
    expect(() => parseRuns({ runs: [completed, completed] }, scope)).toThrow(ApiError);
    expect(() => parseRuns({ runs: Array.from({ length: 26 }, () => completed) }, scope)).toThrow(
      ApiError,
    );
    const newer = { ...completed, id: scope.workspaceId, createdAt: '2026-10-10T00:01:01Z' };
    expect(parseRuns({ runs: [newer, completed] }, scope)).toHaveLength(2);
    expect(() => parseRuns({ runs: [completed, newer] }, scope)).toThrow(ApiError);
    expect(() => parseRuns({ runs: [null] }, scope)).toThrow(ApiError);
  });
});

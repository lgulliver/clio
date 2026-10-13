import { describe, expect, it } from 'vitest';
import type { PullCheckpoint } from '../../../../../packages/adapters/src/github-pulls-contract.ts';
import { calculateSignals } from '../../../../api/src/features/space-github/calculate.ts';
import { type OperationResult, parseOperationResult } from './api';
import { buildOperationalPoints } from './trends';

// Fictional operational fixtures for tests only; values come from the actual server calculator.
const workspaceId = '11111111-1111-4111-8111-111111111111';
const teamA = '22222222-2222-4222-8222-222222222222';
const teamB = '33333333-3333-4333-8333-333333333333';
const mappingA = 'aaaaaaaa-0000-4000-8000-000000000001';
const mappingB = 'aaaaaaaa-0000-4000-8000-000000000002';
let next = 1;
function id() {
  next += 1;
  return `bbbbbbbb-0000-4000-8000-${next.toString(16).padStart(12, '0')}`;
}
function day(offset: number) {
  return new Date(Date.UTC(2026, 6, 1) + offset * 86_400_000).toISOString();
}
/** `merged` PRs each take `hours` from open to merge; `reviewed` get a first review at +1h. */
function checkpoint(start: string, merged: number, hours: number, reviewed = 0): PullCheckpoint {
  const opened = Date.parse(start) + 3_600_000;
  const pulls = Array.from({ length: merged }, (_, index) => ({
    id: index + 1,
    number: index + 1,
    createdAt: new Date(opened).toISOString(),
    mergedAt: new Date(opened + hours * 3_600_000).toISOString(),
    authorClass: 'human' as const,
    observedAt: day(200),
  }));
  return {
    version: 1,
    phase: 'ready',
    repositoryId: 1,
    repositoryOwner: 'acme',
    repositoryName: 'api',
    nextPullPage: null,
    nextReviewIndex: pulls.length,
    nextReviewPage: 1,
    discoveryTraversalComplete: true,
    reviewTraversalComplete: pulls.map((pull) => pull.id),
    gaps: [],
    pulls,
    reviews: pulls.slice(0, reviewed).map((pull) => ({
      id: pull.id + 100,
      pullId: pull.id,
      submittedAt: new Date(opened + 3_600_000).toISOString(),
      state: 'APPROVED' as const,
      authorClass: 'human' as const,
      reviewerClass: 'human' as const,
      actorEligibilityKnown: true,
      isSelfReview: false,
      observedAt: day(200),
    })),
  };
}
function result(input: {
  mappingId?: string;
  revision?: number;
  repositoryId?: number;
  teamId?: string;
  teamName?: string;
  start: number;
  days: number;
  merged: number;
  hours: number;
  reviewed?: number;
}): OperationResult {
  const window = { windowStart: day(input.start), windowEnd: day(input.start + input.days) };
  const calculated = calculateSignals(
    checkpoint(window.windowStart, input.merged, input.hours, input.reviewed),
    window,
  );
  const value: OperationResult = {
    id: id(),
    runId: id(),
    workspaceId,
    mappingId: input.mappingId ?? mappingA,
    mappingRevision: input.revision ?? 1,
    appId: 12,
    installationId: 34,
    repositoryId: input.repositoryId ?? 123,
    repositoryLabel: input.repositoryId === 456 ? 'acme/web' : 'acme/api',
    teamId: input.teamId ?? teamA,
    teamName: input.teamName ?? 'Platform',
    ...window,
    acquisitionStartedAt: day(150),
    acquisitionEndedAt: day(150),
    completedAt: day(150),
    contractVersion: 'clio.space.github.v1',
    calculated,
    discoveryTraversalComplete: true,
    reviewTraversalComplete: true,
    gaps: [],
  };
  // Prove each fixture survives the strict browser boundary before charting.
  return parseOperationResult(JSON.parse(JSON.stringify({ result: value })), { workspaceId });
}

describe('buildOperationalPoints', () => {
  it('separates repository, mapping revision, original team and window length series', () => {
    const results = [
      result({ start: 0, days: 14, merged: 3, hours: 5 }),
      result({ start: 14, days: 14, merged: 3, hours: 7 }),
      // Reassigned to another team under a new revision: a separate series.
      result({ start: 28, days: 14, merged: 3, hours: 9, revision: 2, teamId: teamB }),
      // Different window length on the same source/team/revision: separate series.
      result({ start: 42, days: 7, merged: 3, hours: 4 }),
      // A second repository is never pooled with the first.
      result({ start: 0, days: 14, merged: 3, hours: 2, mappingId: mappingB, repositoryId: 456 }),
    ];
    const series = buildOperationalPoints(results, 'open_to_merge');
    expect(series).toHaveLength(4);
    const keys = series.map((item) => [
      item.repositoryId,
      item.mappingId,
      item.mappingRevision,
      item.teamId,
      item.lengthDays,
    ]);
    expect(keys).toContainEqual([123, mappingA, 1, teamA, 14]);
    expect(keys).toContainEqual([123, mappingA, 1, teamA, 7]);
    expect(keys).toContainEqual([123, mappingA, 2, teamB, 14]);
    expect(keys).toContainEqual([456, mappingB, 1, teamA, 14]);
    const main = series.find(
      (item) => item.mappingRevision === 1 && item.lengthDays === 14 && item.repositoryId === 123,
    );
    expect(main?.points.map((point) => point.value)).toEqual([5, 7]);
    expect(main?.points.map((point) => point.windowStart)).toEqual([day(0), day(14)]);
    for (const item of series) {
      expect(item.signalId).toBe('open_to_merge');
      expect(item.calculationVersion).toBe('clio.space.github.calculation.v1');
      // Points only: no joined segments for incomplete historical populations.
      expect(item).not.toHaveProperty('segments');
    }
  });

  it('keeps reconnected sources apart even when both start at revision 1', () => {
    const series = buildOperationalPoints(
      [
        result({ start: 0, days: 14, merged: 3, hours: 5 }),
        result({ start: 14, days: 14, merged: 3, hours: 6, mappingId: mappingB }),
      ],
      'open_to_merge',
    );
    expect(series).toHaveLength(2);
  });

  it('keeps null, empty and under-minimum samples as gaps rather than zero', () => {
    const series = buildOperationalPoints(
      [
        result({ start: 0, days: 14, merged: 0, hours: 1 }),
        result({ start: 14, days: 14, merged: 2, hours: 1, reviewed: 2 }),
        result({ start: 28, days: 14, merged: 3, hours: 6, reviewed: 3 }),
      ],
      'open_to_first_review',
    );
    expect(series).toHaveLength(1);
    const points = series[0]?.points ?? [];
    expect(points.map((point) => [point.status, point.value, point.sampleCount])).toEqual([
      ['insufficient_samples', null, 0],
      ['insufficient_samples', null, 2],
      ['provisional', 1, 3],
    ]);
    const counts = buildOperationalPoints(
      [result({ start: 0, days: 14, merged: 0, hours: 1 })],
      'pulls_merged',
    );
    expect(counts[0]?.points[0]).toMatchObject({ status: 'no_observations', value: null });
  });

  it('keeps first-review and open-to-merge selections distinct', () => {
    const input = [result({ start: 0, days: 14, merged: 3, hours: 5, reviewed: 3 })];
    expect(buildOperationalPoints(input, 'open_to_first_review')[0]?.points[0]?.value).toBe(1);
    expect(buildOperationalPoints(input, 'open_to_merge')[0]?.points[0]?.value).toBe(5);
  });
});

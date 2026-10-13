import { type PullCheckpoint, parsePullCheckpoint } from '@clio/adapters';
import { describe, expect, it } from 'vitest';
import { calculateSignals } from '../src/features/space-github/calculate.ts';
import {
  parseCollectionRequest,
  parseMappingRequest,
  parsePageQuery,
} from '../src/features/space-github/input.ts';

const window = { windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-15T00:00:00.000Z' };
function checkpoint(): PullCheckpoint {
  return {
    version: 1,
    phase: 'ready',
    repositoryId: 1,
    repositoryOwner: 'owner',
    repositoryName: 'repo',
    nextPullPage: null,
    nextReviewIndex: 4,
    nextReviewPage: 1,
    discoveryTraversalComplete: true,
    reviewTraversalComplete: [1, 2, 3, 4],
    gaps: [],
    pulls: [1, 2, 3, 4].map((id) => ({
      id,
      number: id,
      createdAt: '2026-09-02T09:00:00.000Z',
      mergedAt: `2026-09-02T${id === 4 ? '14' : String(9 + id * 2 - 1).padStart(2, '0')}:00:00.000Z`,
      authorClass: id === 4 ? 'bot' : 'human',
      observedAt: '2026-09-16T00:00:00.000Z',
    })),
    reviews: [1, 2, 3, 4].map((id) => ({
      id,
      pullId: id,
      submittedAt: `2026-09-02T${String(9 + id * 2 - 1).padStart(2, '0')}:00:00.000Z`,
      state: 'APPROVED',
      authorClass: id === 4 ? 'bot' : 'human',
      reviewerClass: 'human',
      actorEligibilityKnown: true,
      isSelfReview: false,
      observedAt: '2026-09-16T00:00:00.000Z',
    })),
  };
}
describe('operational calculation', () => {
  it('deduplicates observed reviews and excludes bot authors from duration', () => {
    const c = checkpoint();
    const r = calculateSignals({ ...c, reviews: [...c.reviews, ...c.reviews] }, window);
    expect(r.signals.map((s) => s.value)).toEqual([4, 4, 4, 3, 3]);
    expect(r.signals[3]).toEqual({
      id: 'open_to_first_review',
      status: 'provisional',
      value: 3,
      unit: 'hours',
      sampleCount: 3,
    });
  });
  it('keeps first review distinct from merge including draft lifecycle', () => {
    const c = checkpoint();
    const r = calculateSignals(
      {
        ...c,
        pulls: c.pulls.map((p) => ({ ...p, mergedAt: '2026-09-02T14:00:00.000Z' })),
        reviews: c.reviews.map((r) => ({ ...r, submittedAt: '2026-09-02T10:00:00.000Z' })),
      },
      window,
    );
    expect(r.signals.map((s) => s.value)).toEqual([4, 4, 4, 1, 5]);
  });
  it('excludes incomplete review traversal, exposes context and preserves null empty counts', () => {
    const c = checkpoint();
    const r = calculateSignals({ ...c, reviewTraversalComplete: [1], reviews: [] }, window);
    expect(r.signals[2]?.value).toBeNull();
    expect(r.signals[3]).toMatchObject({
      value: null,
      status: 'insufficient_samples',
      sampleCount: 0,
    });
    expect(r.reviewContext).toEqual({
      reviewed: 0,
      noQualifyingReview: 1,
      unknownTraversal: 2,
      excludedActors: 1,
    });
  });
  it('uses half-open cohorts and microseconds', () => {
    const c = checkpoint();
    const r = calculateSignals(
      {
        ...c,
        pulls: c.pulls.map((p) => ({
          ...p,
          createdAt: '2026-09-14T23:59:59.999999Z',
          mergedAt: window.windowEnd,
        })),
        reviews: c.reviews.map((r) => ({ ...r, submittedAt: '2026-09-14T23:59:59.999998Z' })),
      },
      window,
    );
    expect(r.signals[0]?.value).toBe(4);
    expect(r.signals[1]?.value).toBeNull();
    expect(r.signals[3]?.value).toBeNull();
  });
  it('requires three timed PRs and averages even median', () => {
    const c = checkpoint();
    expect(calculateSignals({ ...c, pulls: c.pulls.slice(0, 2) }, window).signals[4]).toMatchObject(
      { value: null, sampleCount: 2 },
    );
    expect(
      calculateSignals(
        {
          ...c,
          pulls: c.pulls.map((p) => ({ ...p, authorClass: 'human' })),
          reviews: c.reviews.map((r) => ({ ...r, authorClass: 'human' })),
        },
        window,
      ).signals[3]?.value,
    ).toBe(4);
  });
});
describe('collection request', () => {
  it('accepts exact closed 90-day windows', () => {
    expect(
      parseCollectionRequest(
        { ...window, revision: 1, requestId: '00000000-0000-0000-0000-000000000001' },
        new Date('2026-09-15'),
      ),
    ).toMatchObject(window);
  });
  it.each([
    { ...window, extra: true },
    { ...window, windowStart: '2026-02-30T00:00:00.000Z' },
    { ...window, windowEnd: '2026-09-16T00:00:00.000Z' },
    { ...window, windowStart: '2026-01-01T00:00:00.000Z' },
  ])('rejects invalid body %j', (body) => {
    expect(() =>
      parseCollectionRequest(
        { ...body, revision: 1, requestId: '00000000-0000-0000-0000-000000000001' },
        new Date('2026-09-15'),
      ),
    ).toThrow();
  });
});

it('consumes actual validated provider canonical facts', () => {
  const c = checkpoint();
  const canonical: unknown = JSON.parse(
    JSON.stringify({ ...c, pulls: [...c.pulls].reverse() }).replaceAll('.000Z', 'Z'),
  );
  const parsed = parsePullCheckpoint(canonical);
  expect(calculateSignals(parsed, window).signals.map((s) => s.value)).toEqual([4, 4, 4, 3, 3]);
});
it('qualifies old-created merged cohort and null unknown merge without invention', () => {
  const c = checkpoint();
  const r = calculateSignals(
    {
      ...c,
      gaps: ['invalid_time'],
      pulls: c.pulls.map((p) => ({
        ...p,
        createdAt: '2026-08-01T00:00:00Z',
        mergedAt: p.id === 4 ? null : '2026-09-02T00:00:00Z',
      })),
    },
    window,
  );
  expect(r.signals[0]?.value).toBeNull();
  expect(r.signals[1]?.value).toBe(3);
  expect(r.signals[4]).toMatchObject({ value: 768, sampleCount: 3, status: 'provisional' });
});
it('uses valid microsecond duration and excludes self/bot/unknown reviewers', () => {
  const c = checkpoint();
  const r = calculateSignals(
    { ...c, reviews: c.reviews.map((r) => ({ ...r, submittedAt: '2026-09-02T09:00:00.000001Z' })) },
    window,
  );
  expect(r.signals[3]?.value).toBe(1 / 3600000000);
  for (const change of [
    { isSelfReview: true },
    { reviewerClass: 'bot' as const },
    { reviewerClass: 'unknown' as const },
    { actorEligibilityKnown: false },
  ])
    expect(
      calculateSignals({ ...c, reviews: c.reviews.map((r) => ({ ...r, ...change })) }, window)
        .signals[2]?.value,
    ).toBeNull();
});
it('publishes valid merge durations independently of missing reviews', () => {
  const c = checkpoint();
  const r = calculateSignals({ ...c, reviewTraversalComplete: [] }, window);
  expect(r.signals[1]?.value).toBe(4);
  expect(r.signals[4]).toMatchObject({ value: 3, sampleCount: 3 });
  expect(r.signals[3]).toMatchObject({ value: null, sampleCount: 0 });
  expect(r.reviewContext.unknownTraversal).toBe(3);
});

it('enforces exactly 90 days and rejects 91 days/non-midnight requests', () => {
  const requestId = '00000000-0000-0000-0000-000000000001';
  const now = new Date('2026-09-30T12:00:00Z');
  expect(
    parseCollectionRequest(
      {
        revision: 1,
        requestId,
        windowStart: '2026-07-02T00:00:00.000Z',
        windowEnd: '2026-09-30T00:00:00.000Z',
      },
      now,
    ),
  ).toHaveProperty('windowStart', '2026-07-02T00:00:00.000Z');
  for (const windowStart of [
    '2026-07-01T00:00:00.000Z',
    '2026-07-02T00:00:00Z',
    '2026-07-02T01:00:00.000Z',
  ])
    expect(() =>
      parseCollectionRequest(
        { revision: 1, requestId, windowStart, windowEnd: '2026-09-30T00:00:00.000Z' },
        now,
      ),
    ).toThrow();
});

it('parses bounded owner mapping/query input and rejects unapproved source fields', () => {
  const teamId = '00000000-0000-0000-0000-000000000003';
  expect(parseMappingRequest({ teamId, installationId: 12, repositoryId: 34 })).toEqual({
    teamId,
    installationId: 12,
    repositoryId: 34,
  });
  expect(parsePageQuery({ teamId, cursor: 'encoded_cursor-1' })).toEqual({
    teamId,
    cursor: 'encoded_cursor-1',
  });
  for (const value of [
    { teamId, installationId: 12, repositoryId: 34, appId: 5 },
    { teamId, installationId: 0, repositoryId: 34 },
  ]) {
    try {
      parseMappingRequest(value);
      throw new Error('accepted invalid request');
    } catch (error) {
      expect(error).toHaveProperty('status', 400);
    }
  }
  expect(() => parsePageQuery({ cursor: 'bad/cursor' })).toThrow();
});
it('counts submitted dismissed reviews and excludes unknown authors from human review cohorts', () => {
  const c = checkpoint();
  expect(
    calculateSignals(
      { ...c, reviews: c.reviews.map((r) => ({ ...r, state: 'DISMISSED' })) },
      window,
    ).signals[2]?.value,
  ).toBe(4);
  expect(
    calculateSignals(
      {
        ...c,
        pulls: c.pulls.map((p) => ({ ...p, authorClass: 'unknown' })),
        reviews: c.reviews.map((r) => ({ ...r, authorClass: 'unknown' })),
      },
      window,
    ).signals.map((s) => s.value),
  ).toEqual([4, 4, null, null, null]);
});

it('counts creation at start and excludes creation and submitted reviews at end', () => {
  const c = checkpoint();
  const pulls = c.pulls.map((p) => ({
    ...p,
    createdAt: p.id === 4 ? window.windowEnd : window.windowStart,
    mergedAt: null,
  }));
  const reviews = c.reviews.map((r) => ({ ...r, submittedAt: window.windowEnd }));
  const result = calculateSignals({ ...c, pulls, reviews }, window);
  expect(result.signals.map((s) => s.value)).toEqual([3, null, null, null, null]);
  expect(result.reviewContext).toEqual({
    reviewed: 0,
    noQualifyingReview: 3,
    unknownTraversal: 0,
    excludedActors: 0,
  });
});
it('later first review remains outside follow-up without backdating observations', () => {
  const c = checkpoint();
  const r = calculateSignals(
    {
      ...c,
      reviews: c.reviews.map((r) => ({
        ...r,
        submittedAt: '2026-09-15T00:00:00.000001Z',
        observedAt: '2026-09-16T00:00:00Z',
      })),
    },
    window,
  );
  expect(r.signals[2]).toMatchObject({ value: null, status: 'no_observations' });
  expect(r.signals[3]).toMatchObject({
    value: null,
    status: 'insufficient_samples',
    sampleCount: 0,
  });
  expect(r.reviewContext).toEqual({
    reviewed: 0,
    noQualifyingReview: 3,
    unknownTraversal: 0,
    excludedActors: 1,
  });
});

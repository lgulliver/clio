import type { PullCheckpoint } from '@clio/adapters';
import { expect, it } from 'vitest';
import { terminalizePullCheckpoint } from '../src/features/space-github/checkpoint.ts';

const discovery: PullCheckpoint = {
  version: 1,
  phase: 'discovery',
  repositoryId: 20,
  repositoryOwner: 'fixture',
  repositoryName: 'repo',
  nextPullPage: 2,
  nextReviewIndex: 0,
  nextReviewPage: 1,
  pulls: [
    {
      id: 101,
      number: 1,
      createdAt: '2026-01-01T00:00:00.000002Z',
      mergedAt: null,
      authorClass: 'human',
      observedAt: '2026-01-04T00:00:00Z',
    },
    {
      id: 103,
      number: 3,
      createdAt: '2026-01-01T00:00:00.000001Z',
      mergedAt: null,
      authorClass: 'human',
      observedAt: '2026-01-04T00:00:00Z',
    },
    {
      id: 102,
      number: 2,
      createdAt: '2026-01-01T00:00:00.000002Z',
      mergedAt: null,
      authorClass: 'human',
      observedAt: '2026-01-04T00:00:00Z',
    },
  ],
  reviews: [],
  reviewTraversalComplete: [],
  discoveryTraversalComplete: false,
  gaps: ['unknown_actor'],
};
it('terminalizes discovery in microsecond/ID order preserving facts and incomplete traversal', () => {
  const ready = terminalizePullCheckpoint(discovery);
  expect(ready.pulls.map((p) => p.id)).toEqual([102, 101, 103]);
  expect(ready.pulls).toEqual(expect.arrayContaining([...discovery.pulls]));
  expect(ready.discoveryTraversalComplete).toBe(false);
  expect(ready.nextPullPage).toBeNull();
  expect(ready.nextReviewIndex).toBe(0);
  expect(ready.gaps).toEqual(['unknown_actor', 'active_time_limit']);
  expect(discovery.phase).toBe('discovery');
  expect(discovery.pulls.map((p) => p.id)).toEqual([101, 103, 102]);
  expect(terminalizePullCheckpoint(ready)).toEqual(ready);
});
it('preserves completed review IDs, current page cursor and retained review facts', () => {
  const sorted = terminalizePullCheckpoint(discovery).pulls;
  const reviews: PullCheckpoint = {
    ...discovery,
    phase: 'reviews',
    nextPullPage: null,
    pulls: sorted,
    nextReviewIndex: 2,
    nextReviewPage: 2,
    discoveryTraversalComplete: true,
    reviewTraversalComplete: [102],
    reviews: [
      {
        id: 201,
        pullId: 103,
        submittedAt: '2026-01-02T00:00:00Z',
        state: 'APPROVED',
        authorClass: 'human',
        reviewerClass: 'human',
        actorEligibilityKnown: true,
        isSelfReview: false,
        observedAt: '2026-01-04T00:00:00Z',
      },
    ],
  };
  const ready = terminalizePullCheckpoint(reviews);
  expect(ready.pulls).toEqual(reviews.pulls);
  expect(ready.reviews).toEqual(reviews.reviews);
  expect(ready.reviewTraversalComplete).toEqual([102]);
  expect(ready.nextReviewIndex).toBe(2);
  expect(ready.nextReviewPage).toBe(2);
  expect(ready.discoveryTraversalComplete).toBe(true);
});
it('rejects malformed or contradictory retained data instead of laundering it into ready', () => {
  expect(() =>
    terminalizePullCheckpoint({ ...discovery, reviewTraversalComplete: [101] }),
  ).toThrow();
  expect(() =>
    terminalizePullCheckpoint({ ...discovery, pulls: [...discovery.pulls, discovery.pulls[0]] }),
  ).toThrow();
});

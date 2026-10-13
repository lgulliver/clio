import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FetchTransport } from '../src/github-app.ts';
import {
  collectGitHubPullSlice,
  parsePullCheckpoint,
  pullFailureCheckpoint,
} from '../src/github-pulls-collect.ts';
import { verifyGitHubPullScope } from '../src/github-pulls-scope.ts';
import { GitHubRateLimitError } from '../src/github-rate-limit.ts';
import { verifyGitHubScope } from '../src/github-scope.ts';
import { object } from '../src/value.ts';

const clock = () => new Date('2026-10-13T12:00:00Z');
const window = { windowStart: '2026-09-01T00:00:00Z', windowEnd: '2026-10-01T00:00:00Z' };
const verified = {
  repositoryId: 7,
  repositoryOwner: 'fiction',
  repositoryName: 'pilot',
  token: 'fixture-token',
};
const root = 'https://api.github.com/repos/fiction/pilot/pulls';
const repository = {
  id: 7,
  name: 'pilot',
  full_name: 'fiction/pilot',
  owner: { id: 8, login: 'fiction', type: 'Organization' },
};
function pull(number = 1, changes: Record<string, unknown> = {}) {
  return {
    id: 100 + number,
    number,
    url: `${root}/${number}`,
    created_at: '2026-09-01T09:00:00Z',
    merged_at: null,
    user: { id: 9, type: 'User', login: 'private-login' },
    title: 'private-title',
    body: 'private-body',
    base: { repo: repository },
    head: { repo: repository, ref: 'private-branch' },
    ...changes,
  };
}
function review(id = 201, changes: Record<string, unknown> = {}) {
  return {
    id,
    pull_request_url: `${root}/1`,
    submitted_at: '2026-09-02T09:00:00Z',
    state: 'APPROVED',
    user: { id: 10, type: 'User', login: 'private-reviewer' },
    body: 'private-review-body',
    ...changes,
  };
}
function http(body: unknown, link?: string) {
  return new Response(JSON.stringify(body), { headers: link ? { link } : {} });
}
function fixture(pulls: unknown[], reviews: unknown[] = [], author = pull()): FetchTransport {
  return async (url) => {
    if (url.includes('?state=all')) return http(pulls);
    if (url.includes('/reviews?')) return http(reviews);
    if (url === `${root}/1`) return http(author);
    throw new Error('unexpected fixture path');
  };
}
function collect(
  fetch: FetchTransport,
  options: Partial<Parameters<typeof collectGitHubPullSlice>[0]> = {},
) {
  return collectGitHubPullSlice({
    verified,
    window,
    clock,
    fetch,
    checkpoint: null,
    activeMillis: 0,
    ...options,
  });
}

describe('bounded pull evidence', () => {
  it('discovers old merged PRs and old reviewed PRs without retaining private fields or person IDs', async () => {
    const old = pull(1, { created_at: '2020-01-01T00:00:00Z', merged_at: '2026-09-03T00:00:00Z' });
    const result = await collect(fixture([old], [review()], old));
    expect(result.done).toBe(true);
    expect(result.requests).toBe(3);
    expect(result.checkpoint.pulls[0]).toMatchObject({
      id: 101,
      createdAt: '2020-01-01T00:00:00Z',
      mergedAt: '2026-09-03T00:00:00Z',
    });
    expect(result.checkpoint.reviews[0]).toMatchObject({
      id: 201,
      isSelfReview: false,
      actorEligibilityKnown: true,
    });
    expect(JSON.stringify(result.checkpoint)).not.toMatch(
      /private-|"user"|"login"|"body"|"ref"|"authorId"|"reviewerId"/,
    );
    expect(parsePullCheckpoint(result.checkpoint)).toEqual(result.checkpoint);
  });
  it('keeps derived bot/self/unknown classes and dismissed facts, excludes pending and preserves end-boundary records for calculator cohort filtering', async () => {
    const result = await collect(
      fixture(
        [pull()],
        [
          review(201, { user: { id: 9, type: 'User' } }),
          review(202, { user: { id: 11, type: 'Bot' } }),
          review(203, { user: null }),
          review(204, { state: 'PENDING', submitted_at: null }),
          review(205, { state: 'DISMISSED' }),
          review(206, { submitted_at: window.windowEnd }),
        ],
      ),
    );
    expect(result.checkpoint.reviews.map((r) => r.id)).toEqual([201, 202, 203, 205, 206]);
    expect(result.checkpoint.reviews[0]?.isSelfReview).toBe(true);
    expect(result.checkpoint.reviews[1]?.reviewerClass).toBe('bot');
    expect(result.checkpoint.reviews[2]?.actorEligibilityKnown).toBe(false);
    expect(result.checkpoint.gaps).toContain('unknown_actor');
  });
  it('resumes a review page with an author re-fetch, respecting the remaining request allowance', async () => {
    const fetch: FetchTransport = async (url) =>
      url.includes('?state=all')
        ? http([pull()])
        : url === `${root}/1`
          ? http(pull())
          : http([review()], `<${root}/1/reviews?per_page=100&page=2>; rel="next"`);
    const first = await collect(fetch, { remainingRequests: 3 });
    expect(first.done).toBe(false);
    expect(first.checkpoint.nextReviewPage).toBe(2);
    const second = await collect(
      async (url) => (url === `${root}/1` ? http(pull(1, { user: null })) : http([review(202)])),
      { checkpoint: first.checkpoint, remainingRequests: 2 },
    );
    expect(second.requests).toBe(2);
    expect(second.done).toBe(true);
    expect(second.checkpoint.reviews[1]?.actorEligibilityKnown).toBe(false);
    expect(second.checkpoint.gaps).toContain('unknown_actor');
  });
  it.each([
    'https://elsewhere.invalid/a?page=2',
    `${root}?state=all&sort=created&direction=desc&per_page=100&page=2`,
    `${root}?state=all&sort=created&direction=desc&per_page=50&page=1`,
    `${root}?state=all&sort=created&direction=desc&per_page=50&page=2&page=3`,
    'https://secret@api.github.com/repos/fiction/pilot/pulls?state=all&sort=created&direction=desc&per_page=50&page=2',
  ])('rejects unsafe endpoint pagination %s', async (next) => {
    await expect(collect(async () => http([pull()], `<${next}>; rel="next"`))).rejects.toThrow(
      /pagination/,
    );
  });
  it('deduplicates repeated review records across pages', async () => {
    const fetch: FetchTransport = async (url) =>
      url.includes('?state=all')
        ? http([pull()])
        : url === `${root}/1`
          ? http(pull())
          : url.endsWith('page=1')
            ? http([review()], `<${root}/1/reviews?per_page=100&page=2>; rel="next"`)
            : http([review()]);
    const result = await collect(fetch);
    expect(result.checkpoint.reviews).toHaveLength(1);
    expect(result.checkpoint.reviewTraversalComplete).toEqual([101]);
  });
  it('conflicting review facts terminate with a gap without selecting a conflicting timestamp', async () => {
    const fetch: FetchTransport = async (url) =>
      url.includes('?state=all')
        ? http([pull()])
        : url === `${root}/1`
          ? http(pull())
          : url.endsWith('page=1')
            ? http([review()], `<${root}/1/reviews?per_page=100&page=2>; rel="next"`)
            : http([review(201, { submitted_at: '2026-09-03T09:00:00Z' })]);
    const result = await collect(fetch);
    expect(result.checkpoint.gaps).toContain('record_conflict');
    expect(result.checkpoint.reviews).toHaveLength(0);
    expect(result.checkpoint.reviewTraversalComplete).toEqual([]);
  });
  it('does not retain arbitrarily selected facts from a conflicting first review page', async () => {
    const result = await collect(
      fixture([pull()], [review(201), review(202), review(201, { state: 'COMMENTED' })]),
    );
    expect(result.done).toBe(true);
    expect(result.checkpoint.gaps).toContain('record_conflict');
    expect(result.checkpoint.reviews).toEqual([]);
  });
  it('excludes both contradictory pull identities for the same repository number', async () => {
    const result = await collect(fixture([pull(), pull(1, { id: 999 })]));
    expect(result.done).toBe(true);
    expect(result.checkpoint.gaps).toContain('record_conflict');
    expect(result.checkpoint.pulls).toEqual([]);
  });
  it('records invalid/future event times as gaps and does not retain timed facts', async () => {
    const result = await collect(
      fixture(
        [pull(1, { merged_at: '2020-01-01T00:00:00Z' })],
        [
          review(201, { submitted_at: '2026-02-30T12:00:00Z' }),
          review(202, { submitted_at: '2027-01-01T00:00:00Z' }),
        ],
      ),
    );
    expect(result.checkpoint.pulls[0]?.mergedAt).toBeNull();
    expect(result.checkpoint.reviews).toHaveLength(0);
    expect(result.checkpoint.gaps).toContain('invalid_time');
  });
  it('declares invalid refetched creation times as gaps without retaining contradictory facts', async () => {
    const result = await collect(
      fixture([pull()], [], pull(1, { created_at: '2026-02-30T00:00:00Z' })),
    );
    expect(result.done).toBe(true);
    expect(result.checkpoint.gaps).toContain('invalid_time');
    expect(result.checkpoint.gaps).toContain('record_conflict');
    expect(result.checkpoint.pulls).toEqual([]);
  });
  it('fails malformed identity and repository rename rather than rebinding', async () => {
    await expect(collect(fixture([pull(1, { id: -1 })]))).rejects.toMatchObject({
      code: 'invalid_id',
    });
    await expect(
      collect(
        fixture([pull()], [], pull(1, { base: { repo: { ...repository, name: 'renamed' } } })),
      ),
    ).rejects.toMatchObject({ code: 'github_pull_identity_mismatch' });
  });
  it('classifies deleted authors as unknown on resume without losing opened or merged events', async () => {
    const p = pull(1, { merged_at: '2026-09-03T00:00:00Z' });
    const first = await collect(
      async (url) =>
        url.includes('?state=all')
          ? http([p])
          : url === `${root}/1`
            ? http(p)
            : http([review()], `<${root}/1/reviews?per_page=100&page=2>; rel="next"`),
      { remainingRequests: 3 },
    );
    const ghost = { id: 10137, login: 'ghost', type: 'User' };
    const resumed = await collect(
      async (url) => (url === `${root}/1` ? http({ ...p, user: ghost }) : http([review(202)])),
      { checkpoint: first.checkpoint },
    );
    expect(resumed.checkpoint.pulls[0]).toMatchObject({
      createdAt: '2026-09-01T09:00:00Z',
      mergedAt: '2026-09-03T00:00:00Z',
      authorClass: 'unknown',
    });
    expect(resumed.checkpoint.reviews.map((r) => r.actorEligibilityKnown)).toEqual([false, false]);
    expect(resumed.checkpoint.gaps).toContain('unknown_actor');
    expect(JSON.stringify(resumed.checkpoint)).not.toMatch(/10137|ghost|"user"|"login"/);
  });
  it('does not manufacture self-review eligibility when both actors are the shared deleted user', async () => {
    const ghost = { id: 10137, login: 'ghost', type: 'User' };
    const p = pull(1, { user: ghost });
    const result = await collect(fixture([p], [review(201, { user: ghost })], p));
    expect(result.checkpoint.reviews[0]).toMatchObject({
      authorClass: 'unknown',
      reviewerClass: 'unknown',
      actorEligibilityKnown: false,
      isSelfReview: false,
    });
    expect(result.checkpoint.gaps).toContain('unknown_actor');
    expect(JSON.stringify(result.checkpoint)).not.toMatch(/10137|ghost/);
  });
  it('excludes a deleted reviewer even when the current author is known', async () => {
    const result = await collect(
      fixture([pull()], [review(201, { user: { id: 10137, login: 'ghost', type: 'User' } })]),
    );
    expect(result.checkpoint.reviews[0]).toMatchObject({
      authorClass: 'human',
      reviewerClass: 'unknown',
      actorEligibilityKnown: false,
      isSelfReview: false,
    });
    expect(result.checkpoint.gaps).toContain('unknown_actor');
  });
  it('retains opened evidence when merge time is invalid and reports merge timing unknown', async () => {
    const p = pull(1, { merged_at: 'invalid-private-timestamp' });
    const result = await collect(fixture([p], [], p));
    expect(result.checkpoint.pulls[0]).toMatchObject({
      createdAt: '2026-09-01T09:00:00Z',
      mergedAt: null,
    });
    expect(result.checkpoint.gaps).toContain('invalid_time');
    expect(JSON.stringify(result.checkpoint)).not.toContain('invalid-private-timestamp');
  });
  it('skips author and review acquisition for PRs created at or after window end', async () => {
    const result = await collect(async (url) => {
      if (!url.includes('?state=all')) throw new Error('unexpected-boundary-request');
      return http([
        pull(1, { created_at: window.windowEnd }),
        pull(2, { created_at: '2026-10-02T00:00:00Z' }),
      ]);
    });
    expect(result.requests).toBe(1);
    expect(result.done).toBe(true);
    expect(result.checkpoint.reviewTraversalComplete).toEqual([]);
    expect(result.checkpoint.reviews).toEqual([]);
  });
  it.each([
    [{ windowStart: '2026-02-30T00:00:00Z', windowEnd: window.windowEnd }, 'invalid_timestamp'],
    [
      { windowStart: '2026-09-01T00:00:01Z', windowEnd: window.windowEnd },
      'invalid_reporting_window',
    ],
    [
      { windowStart: '2026-09-01T00:00:00Z', windowEnd: '2026-09-30T23:59:59Z' },
      'invalid_reporting_window',
    ],
    [
      { windowStart: '2026-07-02T00:00:00Z', windowEnd: window.windowEnd },
      'invalid_reporting_window',
    ],
    [{ windowStart: window.windowEnd, windowEnd: window.windowStart }, 'invalid_reporting_window'],
    [
      { windowStart: window.windowStart, windowEnd: window.windowStart },
      'invalid_reporting_window',
    ],
    [
      { windowStart: window.windowStart, windowEnd: '2026-10-14T00:00:00Z' },
      'invalid_reporting_window',
    ],
  ])(
    'rejects invalid reporting window %j with the expected boundary code',
    async (window, code) => {
      await expect(collect(fixture([]), { window })).rejects.toMatchObject({ code });
    },
  );
  it('accepts exactly ninety closed UTC days', async () => {
    const result = await collect(fixture([]), {
      window: { windowStart: '2026-07-03T00:00:00Z', windowEnd: window.windowEnd },
    });
    expect(result.done).toBe(true);
    expect(result.requests).toBe(1);
  });
  it('rejects later discovery-page conflicts without retaining one conflicting creation time', async () => {
    const result = await collect(async (url) =>
      url.endsWith('page=1')
        ? http(
            [pull()],
            `<${root}?state=all&sort=created&direction=desc&per_page=50&page=2>; rel="next"`,
          )
        : http([pull(1, { created_at: '2026-09-02T09:00:00Z' })]),
    );
    expect(result.requests).toBe(2);
    expect(result.done).toBe(true);
    expect(result.checkpoint.pulls).toEqual([]);
    expect(result.checkpoint.gaps).toContain('record_conflict');
    expect(result.checkpoint.discoveryTraversalComplete).toBe(false);
  });
  it('preserves discovery progress when quota blocks the current-author re-fetch', async () => {
    let failure: unknown;
    try {
      await collect(async (url) => {
        if (url.includes('?state=all')) return http([pull()]);
        throw new GitHubRateLimitError(90);
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GitHubRateLimitError);
    expect(failure).toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 90,
      checkpoint: { phase: 'reviews', nextReviewIndex: 0, nextReviewPage: 1 },
    });
    expect(pullFailureCheckpoint(failure)?.pulls).toHaveLength(1);
    const resumed = await collect(fixture([], [review()]), {
      checkpoint: pullFailureCheckpoint(failure),
    });
    expect(resumed.requests).toBe(2);
    expect(resumed.checkpoint.reviews).toHaveLength(1);
  });
  it('preserves rate-limit classification when the clock also becomes invalid during author lookup', async () => {
    let broken = false;
    let failure: unknown;
    try {
      await collect(
        async (url) => {
          if (url.includes('?state=all')) return http([pull()]);
          broken = true;
          throw new GitHubRateLimitError(45);
        },
        {
          clock: () => {
            if (broken) throw new Error('private-clock-error');
            return clock();
          },
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GitHubRateLimitError);
    expect(failure).toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 45,
      checkpoint: { phase: 'reviews', nextReviewIndex: 0 },
    });
    expect(pullFailureCheckpoint(failure)?.pulls).toHaveLength(1);
  });
  it('uses the explicit deadline cap while author re-fetch times out one clock tick early', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(clock());
    const start = Date.now();
    try {
      const result = collect(
        async (url) =>
          url.includes('?state=all') ? http([pull()]) : new Response(new ReadableStream()),
        {
          clock: () => new Date(Math.min(Date.now(), start + 999)),
          deadline: new Date(start + 1000),
        },
      );
      const assertion = expect(result).resolves.toMatchObject({
        done: false,
        requests: 2,
        activeMillis: 1000,
        checkpoint: { phase: 'reviews', nextReviewIndex: 0, nextReviewPage: 1 },
      });
      void assertion.catch(() => {});
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects completed discovery together with a discovery-limit gap', async () => {
    const complete = await collect(fixture([pull()], [review()]));
    expect(() =>
      parsePullCheckpoint({ ...complete.checkpoint, gaps: ['discovery_limit'] }),
    ).toThrow('invalid_checkpoint');
  });
  it('wraps an invalid or throwing clock after discovery without leaking its error or losing progress', async () => {
    let broken = false;
    await expect(
      collect(
        async (url) => {
          if (url.includes('?state=all')) return http([pull()]);
          broken = true;
          return http(pull());
        },
        {
          clock: () => {
            if (broken) throw new Error('private-clock-error');
            return clock();
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'invalid_clock',
      checkpoint: { phase: 'reviews', nextReviewIndex: 0, nextReviewPage: 1 },
    });
  });
  it('redacts an invalid clock while parsing quota reset metadata', async () => {
    let broken = false;
    await expect(
      collect(
        async (url) => {
          if (url.includes('?state=all')) return http([pull()]);
          broken = true;
          return new Response('{}', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' },
          });
        },
        {
          clock: () => {
            if (broken) throw new Error('private-clock-error');
            return clock();
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_clock', checkpoint: { phase: 'reviews' } });
  });
  it('preserves a safe checkpoint when the clock goes backwards after discovery', async () => {
    let time = clock().getTime();
    await expect(
      collect(
        async (url) => {
          if (url.includes('?state=all')) return http([pull()]);
          time--;
          return http(pull());
        },
        { clock: () => new Date(time) },
      ),
    ).rejects.toMatchObject({
      code: 'invalid_clock',
      checkpoint: { phase: 'reviews', nextReviewIndex: 0, nextReviewPage: 1 },
    });
  });
  it('shares an original verification deadline and counts elapsed provider work', async () => {
    let time = clock().getTime();
    const slice = await collect(
      async () => {
        time += 2000;
        return http([pull()]);
      },
      { clock: () => new Date(time), remainingRequests: 36, deadline: new Date(time + 1000) },
    );
    expect(slice.requests).toBe(1);
    expect(slice.activeMillis).toBe(2000);
    expect(slice.done).toBe(false);
    expect(slice.checkpoint.phase).toBe('reviews');
  });
  it('stops at forty requests including fresh-author lookups', async () => {
    const pulls = Array.from({ length: 25 }, (_, i) => pull(i + 1));
    const slice = await collect(async (url) => {
      if (url.includes('?state=all')) return http(pulls);
      if (url.includes('/reviews?')) return http([]);
      return http(pulls.find((p) => `${root}/${p.number}` === url));
    });
    expect(slice.requests).toBe(39);
    expect(slice.checkpoint.reviewTraversalComplete).toHaveLength(19);
    expect(slice.done).toBe(false);
  });
  it('marks a changed author class unknown for already-retained reviews on resume', async () => {
    const first = await collect(
      async (url) =>
        url.includes('?state=all')
          ? http([pull()])
          : url === `${root}/1`
            ? http(pull())
            : http([review()], `<${root}/1/reviews?per_page=100&page=2>; rel="next"`),
      { remainingRequests: 3 },
    );
    const resumed = await collect(
      async (url) =>
        url === `${root}/1` ? http(pull(1, { user: { id: 9, type: 'Bot' } })) : http([review(202)]),
      { checkpoint: first.checkpoint },
    );
    expect(resumed.checkpoint.pulls[0]?.authorClass).toBe('unknown');
    expect(resumed.checkpoint.reviews.map((r) => r.actorEligibilityKnown)).toEqual([false, false]);
    expect(JSON.stringify(resumed.checkpoint)).not.toMatch(/"(?:author|reviewer|user)Id"/);
  });
  it('caps retained submitted review facts globally including out-of-window reviews', async () => {
    let checkpoint: Parameters<typeof collectGitHubPullSlice>[0]['checkpoint'] = null;
    let done = false;
    for (let slice = 0; slice < 4 && !done; slice++) {
      const result = await collect(
        async (url) => {
          if (url.includes('?state=all')) return http([pull()]);
          if (url === `${root}/1`) return http(pull());
          const page = Number(new URL(url).searchParams.get('page'));
          return http(
            Array.from({ length: 100 }, (_, i) =>
              review((page - 1) * 100 + i + 1, { submitted_at: window.windowEnd }),
            ),
            `<${root}/1/reviews?per_page=100&page=${page + 1}>; rel="next"`,
          );
        },
        { checkpoint },
      );
      checkpoint = result.checkpoint;
      done = result.done;
    }
    expect(done).toBe(true);
    expect(checkpoint?.reviews).toHaveLength(10000);
    expect(checkpoint?.gaps).toContain('fact_limit');
    expect(checkpoint?.reviewTraversalComplete).toEqual([]);
  });
  it('yields cooperatively when an in-flight body reaches the shared slice deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(clock());
    try {
      const result = collect(async () => new Response(new ReadableStream()), {
        clock: () => new Date(),
        deadline: new Date(Date.now() + 1000),
      });
      const assertion = expect(result).resolves.toMatchObject({
        done: false,
        activeMillis: 1000,
        requests: 1,
        checkpoint: { nextPullPage: 1 },
      });
      void assertion.catch(() => {});
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it('fails an ordinary ten-second response-body timeout before the slice deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(clock());
    try {
      const result = collect(async () => new Response(new ReadableStream()), {
        clock: () => new Date(),
      });
      const assertion = expect(result).rejects.toMatchObject({
        code: 'transport_timeout',
        checkpoint: { nextPullPage: 1 },
      });
      void assertion.catch(() => {});
      await vi.advanceTimersByTimeAsync(10000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it('honors an exhausted allowance without making a request', async () => {
    const result = await collect(
      async () => {
        throw new Error('must not fetch');
      },
      { remainingRequests: 0 },
    );
    expect(result.requests).toBe(0);
    expect(result.done).toBe(false);
    expect(result.checkpoint.nextPullPage).toBe(1);
  });
  it('enforces the total active acquisition limit with an incomplete terminal result', async () => {
    const result = await collect(
      async () => {
        throw new Error('must not fetch');
      },
      { activeMillis: 1_800_000 },
    );
    expect(result.done).toBe(true);
    expect(result.checkpoint.gaps).toContain('active_time_limit');
    expect(result.checkpoint.discoveryTraversalComplete).toBe(false);
  });
  it('rejects a false discovery-completion flag without a corresponding acquisition gap', async () => {
    const complete = await collect(fixture([pull()], [review()]));
    expect(() =>
      parsePullCheckpoint({ ...complete.checkpoint, discoveryTraversalComplete: false }),
    ).toThrow();
  });
  it('rejects private checkpoint fields, bad cursors, duplicates and unsupported timestamps', async () => {
    const result = await collect(fixture([pull()], [review()]));
    for (const bad of [
      { ...result.checkpoint, authorId: 9 },
      { ...result.checkpoint, nextReviewIndex: -1 },
      { ...result.checkpoint, pulls: [result.checkpoint.pulls[0], result.checkpoint.pulls[0]] },
      {
        ...result.checkpoint,
        pulls: [{ ...result.checkpoint.pulls[0], createdAt: '2026-09-01T09:00:00+00:00' }],
      },
    ]) {
      expect(() => parsePullCheckpoint(bad)).toThrow();
    }
  });
  it('accepts realistic nested near-cap pages but rejects responses over exactly two million bytes', async () => {
    const nested = pull(1, { body: 'x'.repeat(1_990_000) });
    const result = await collect(fixture([nested], [], nested));
    expect(result.checkpoint.pulls).toHaveLength(1);
    await expect(collect(fixture([pull(1, { body: 'x'.repeat(2_000_000) })]))).rejects.toThrow(
      'response_too_large',
    );
  });

  it('retains committed pages on later quota rejection and resumes without recounting', async () => {
    let failure: unknown;
    try {
      await collect(async (url) => {
        if (url.includes('?state=all')) return http([pull()]);
        if (url === `${root}/1`) return http(pull());
        if (url.endsWith('page=1'))
          return http([review()], `<${root}/1/reviews?per_page=100&page=2>; rel="next"`);
        throw new GitHubRateLimitError(120);
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GitHubRateLimitError);
    expect(failure).toMatchObject({ retryAfterSeconds: 120 });
    const checkpoint = pullFailureCheckpoint(failure);
    expect(checkpoint?.reviews).toHaveLength(1);
    expect(checkpoint?.nextReviewPage).toBe(2);
    const resumed = await collect(
      async (url) => (url === `${root}/1` ? http(pull()) : http([review(), review(202)])),
      { checkpoint },
    );
    expect(resumed.checkpoint.reviews.map((r) => r.id)).toEqual([201, 202]);
    expect(pullFailureCheckpoint(new Error('private-secret'))).toBeNull();
  });
  it('does not checkpoint partially parsed pages on malformed later records', async () => {
    let failure: unknown;
    try {
      await collect(fixture([pull(), pull(2, { base: null })]));
    } catch (error) {
      failure = error;
    }
    const checkpoint = pullFailureCheckpoint(failure);
    expect(checkpoint?.pulls).toEqual([]);
    expect(checkpoint?.nextPullPage).toBe(1);
  });
  it('sorts review candidates by microsecond creation time then descending PR identity', async () => {
    const pulls = [pull(1), pull(2, { created_at: '2026-09-01T09:00:00.000001Z' }), pull(3)];
    const requested: number[] = [];
    const result = await collect(async (url) => {
      if (url.includes('?state=all')) return http(pulls);
      const number = Number(/pulls\/(\d+)/.exec(url)?.[1]);
      if (url.includes('/reviews?')) {
        requested.push(number);
        return http([]);
      }
      return http(pulls.find((p) => p.number === number));
    });
    expect(requested).toEqual([2, 3, 1]);
    expect(result.checkpoint.pulls.map((p) => p.id)).toEqual([102, 103, 101]);
  });
  it('normalizes offset event timestamps without discarding microseconds', async () => {
    const p = pull(1, { created_at: '2026-09-01T10:00:00.123456+01:00' });
    const result = await collect(fixture([p], [], p));
    expect(result.checkpoint.pulls[0]?.createdAt).toBe('2026-09-01T09:00:00.123456Z');
  });
  it('marks exhausted discovery page traversal incomplete even if deduplicated facts are few', async () => {
    const result = await collect(async (url) => {
      if (!url.includes('?state=all')) return url.includes('/reviews?') ? http([]) : http(pull());
      const page = Number(new URL(url).searchParams.get('page'));
      return http(
        [pull()],
        `<${root}?state=all&sort=created&direction=desc&per_page=50&page=${page + 1}>; rel="next"`,
      );
    });
    expect(result.checkpoint.gaps).toContain('discovery_limit');
    expect(result.checkpoint.discoveryTraversalComplete).toBe(false);
    expect(result.checkpoint.pulls).toHaveLength(1);
  });
  it('preserves review limit gaps across slices without calling a completed traversal', async () => {
    let checkpoint: Parameters<typeof collectGitHubPullSlice>[0]['checkpoint'] = null;
    let done = false;
    for (let sliceIndex = 0; sliceIndex < 4 && !done; sliceIndex++) {
      const slice = await collect(
        async (url) => {
          if (url.includes('?state=all')) return http([pull()]);
          if (url === `${root}/1`) return http(pull());
          const page = Number(new URL(url).searchParams.get('page'));
          return http([review()], `<${root}/1/reviews?per_page=100&page=${page + 1}>; rel="next"`);
        },
        { checkpoint },
      );
      checkpoint = slice.checkpoint;
      done = slice.done;
    }
    expect(checkpoint?.gaps).toContain('review_limit');
    expect(checkpoint?.reviewTraversalComplete).toEqual([]);
    expect(checkpoint?.reviews).toHaveLength(1);
  });
  it('aborted response bodies retain the last safe cursor', async () => {
    const controller = new AbortController();
    await expect(
      collect(
        async () =>
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(new TextEncoder().encode('['));
                controller.abort();
              },
            }),
          ),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'cancelled', checkpoint: { nextPullPage: 1, pulls: [] } });
  });
  it('rejects forged checkpoint traversal indexes and completion flags', async () => {
    const complete = await collect(fixture([pull()], [review()]));
    expect(() =>
      parsePullCheckpoint({
        ...complete.checkpoint,
        phase: 'reviews',
        nextReviewIndex: 0,
        reviewTraversalComplete: [],
      }),
    ).toThrow();
  });

  it('preserves quota-shaped failures and redacts aborted/untrusted transports', async () => {
    await expect(
      collect(
        async () =>
          new Response('{"message":"secondary rate limit"}', {
            status: 403,
            headers: { 'retry-after': '60' },
          }),
      ),
    ).rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 60 });
    const controller = new AbortController();
    controller.abort();
    await expect(collect(fixture([]), { signal: controller.signal })).rejects.toThrow('cancelled');
    await expect(
      collect(async () => {
        throw new Error('private-secret');
      }),
    ).rejects.toThrow('transport_failed');
    await expect(collect(async () => new Response(null, { status: 302 }))).rejects.toThrow(
      'unsafe_github_redirect',
    );
  });
});

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
function scopeFixture(profile: 'pull_requests' | 'deployments'): FetchTransport {
  return async (url, init) => {
    const permissions = { [profile]: 'read', metadata: 'read' };
    if (url.endsWith('/access_tokens')) {
      expect(JSON.parse(String(init.body))).toEqual({ repository_ids: [7], permissions });
      return http({
        token: 'fixture-token',
        expires_at: '2026-10-13T13:00:00Z',
        permissions,
        repository_selection: 'selected',
      });
    }
    if (url.includes('/app/installations/'))
      return http({
        id: 6,
        app_id: 5,
        account: repository.owner,
        permissions,
        suspended_at: null,
        suspended_by: null,
        repository_selection: 'selected',
      });
    if (url.includes('/installation/repositories?'))
      return http({ total_count: 1, repositories: [repository] });
    return http(repository);
  };
}
const scopeInput = {
  appId: '5',
  privateKey,
  installationId: 6,
  accountId: 8,
  accountType: 'Organization' as const,
  repositoryId: 7,
  clock,
};
describe('PR-only App scope', () => {
  it('independently verifies exact PR/metadata installation and narrowed token', async () => {
    await expect(
      verifyGitHubPullScope({ ...scopeInput, fetch: scopeFixture('pull_requests') }),
    ).resolves.toMatchObject({ repositoryName: 'pilot', accountLogin: 'fiction' });
  });
  it.each([
    ['app', 'github_installation_mismatch'],
    ['account', 'github_installation_mismatch'],
    ['suspended', 'github_installation_mismatch'],
    ['all-repositories', 'github_installation_mismatch'],
    ['token-permissions', 'github_permissions_mismatch'],
    ['token-selection', 'github_repository_scope_mismatch'],
    ['token-expired', 'expired_token'],
    ['metadata', 'github_repository_scope_mismatch'],
    ['repository-list', 'github_repository_scope_mismatch'],
    ['repository-list-link', 'github_repository_scope_mismatch'],
  ])('rejects independently mismatched %s scope proof', async (mismatch, code) => {
    const original = scopeFixture('pull_requests');
    const fetch: FetchTransport = async (url, init) => {
      const response = await original(url, init);
      const row = object(await response.json());
      if (url.endsWith('/app/installations/6')) {
        if (mismatch === 'app') row.app_id = 999;
        if (mismatch === 'account') row.account = { ...repository.owner, id: 999 };
        if (mismatch === 'suspended') row.suspended_at = '2026-09-01T00:00:00Z';
        if (mismatch === 'all-repositories') row.repository_selection = 'all';
      }
      if (url.endsWith('/access_tokens')) {
        if (mismatch === 'token-permissions')
          row.permissions = { pull_requests: 'read', metadata: 'read', deployments: 'read' };
        if (mismatch === 'token-selection') row.repository_selection = 'all';
        if (mismatch === 'token-expired') row.expires_at = clock().toISOString();
      }
      if (url.endsWith('/repositories/7') && mismatch === 'metadata') row.id = 999;
      if (url.includes('/installation/repositories?')) {
        if (mismatch === 'repository-list') row.total_count = 2;
        if (mismatch === 'repository-list-link')
          return http(
            row,
            '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
          );
      }
      return http(row);
    };
    await expect(verifyGitHubPullScope({ ...scopeInput, fetch })).rejects.toMatchObject({ code });
  });
  it('preserves scoped injected quota failures during verification', async () => {
    await expect(
      verifyGitHubPullScope({
        ...scopeInput,
        fetch: async () => {
          throw new GitHubRateLimitError(30);
        },
      }),
    ).rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 });
  });
  it('rejects deployment-only Apps while preserving the deployment verifier', async () => {
    await expect(
      verifyGitHubPullScope({ ...scopeInput, fetch: scopeFixture('deployments') }),
    ).rejects.toThrow('github_permissions_mismatch');
    await expect(
      verifyGitHubScope({ ...scopeInput, fetch: scopeFixture('deployments') }),
    ).resolves.toMatchObject({ repositoryName: 'pilot' });
  });
});

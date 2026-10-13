import { type FetchTransport, githubApiVersion } from './github-app.ts';
import {
  canonicalPullTime,
  parsePullCheckpoint,
  pullOrder,
  repositorySegment,
  reviewState,
} from './github-pulls-checkpoint.ts';
import {
  type AccountClass,
  type AcquisitionGap,
  type PullCheckpoint,
  type PullFact,
  type PullSlice,
  PullSliceError,
  type PullSliceInput,
  PullSliceRateLimitError,
  type ReviewFact,
} from './github-pulls-contract.ts';
import { nextPullEndpointPage } from './github-pulls-pagination.ts';
import { GitHubRateLimitError, githubRateLimit } from './github-rate-limit.ts';
import { createBoundedGitHubTransport } from './github-transport.ts';
import { AdapterError, content, instant, object, positiveId, string } from './value.ts';

export { parsePullCheckpoint } from './github-pulls-checkpoint.ts';

/** Unknown failures never expose raw provider/transport data. */
export function pullFailureCheckpoint(error: unknown): PullCheckpoint | null {
  return error instanceof PullSliceError || error instanceof PullSliceRateLimitError
    ? parsePullCheckpoint(error.checkpoint)
    : null;
}
function actor(value: unknown): Readonly<{ id: number | null; accountClass: AccountClass }> {
  if (value === null || value === undefined) return { id: null, accountClass: 'unknown' };
  const row = object(value);
  const id = positiveId(row.id);
  // GitHub's reserved replacement account is shared by deleted people.
  if (id === 10137 || row.login === 'ghost') return { id: null, accountClass: 'unknown' };
  return {
    id,
    accountClass: row.type === 'User' ? 'human' : row.type === 'Bot' ? 'bot' : 'unknown',
  };
}
function duplicateContent(record: PullFact | ReviewFact): string {
  const { observedAt: _observedAt, ...rest } = record;
  return content(rest);
}

export async function collectGitHubPullSlice(input: PullSliceInput): Promise<PullSlice> {
  const repositoryId = positiveId(input.verified.repositoryId),
    repositoryOwner = repositorySegment(input.verified.repositoryOwner),
    repositoryName = repositorySegment(input.verified.repositoryName);
  string(input.verified.token);
  function readClock(): number {
    try {
      const value = input.clock().getTime();
      if (!Number.isSafeInteger(value)) throw new AdapterError('invalid_clock');
      return value;
    } catch {
      throw new AdapterError('invalid_clock');
    }
  }
  const start = readClock();
  let lastTime = start;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(input.activeMillis) ||
    input.activeMillis < 0
  )
    throw new AdapterError('invalid_clock');
  const allowance = input.remainingRequests ?? 40;
  if (!Number.isSafeInteger(allowance) || allowance < 0 || allowance > 40)
    throw new AdapterError('invalid_request_budget');
  const suppliedDeadline = input.deadline?.getTime() ?? start + 60_000;
  if (!Number.isSafeInteger(suppliedDeadline)) throw new AdapterError('invalid_clock');
  const deadline = Math.min(
    suppliedDeadline,
    start + 60_000,
    start + Math.max(0, 1_800_000 - input.activeMillis),
  );
  const windowStart = canonicalPullTime(input.window.windowStart),
    windowEnd = canonicalPullTime(input.window.windowEnd);
  if (
    !/^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(windowStart) ||
    !/^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(windowEnd) ||
    instant(windowEnd) <= instant(windowStart) ||
    instant(windowEnd) > BigInt(start) * 1000n ||
    instant(windowEnd) - instant(windowStart) > 90n * 86_400_000_000n
  )
    throw new AdapterError('invalid_reporting_window');
  const initial: PullCheckpoint =
    input.checkpoint === null
      ? {
          version: 1,
          phase: 'discovery',
          repositoryId,
          repositoryOwner,
          repositoryName,
          nextPullPage: 1,
          nextReviewIndex: 0,
          nextReviewPage: 1,
          pulls: [],
          reviews: [],
          reviewTraversalComplete: [],
          discoveryTraversalComplete: false,
          gaps: [],
        }
      : parsePullCheckpoint(input.checkpoint);
  if (
    initial.repositoryId !== repositoryId ||
    initial.repositoryOwner !== repositoryOwner ||
    initial.repositoryName !== repositoryName
  )
    throw new AdapterError('checkpoint_scope_mismatch');
  let phase = initial.phase,
    nextPullPage = initial.nextPullPage,
    nextReviewIndex = initial.nextReviewIndex,
    nextReviewPage = initial.nextReviewPage;
  let pulls = [...initial.pulls],
    reviews = [...initial.reviews];
  const completed = [...initial.reviewTraversalComplete],
    gaps = new Set(initial.gaps);
  let discoveryTraversalComplete = initial.discoveryTraversalComplete,
    requests = 0;
  const base = `https://api.github.com/repos/${repositoryOwner}/${repositoryName}/pulls`;
  let lastValidated = parsePullCheckpoint(initial);
  let deadlineCappedTimeout = false;
  function now(): number {
    const value = readClock();
    if (value < lastTime) throw new AdapterError('invalid_clock');
    lastTime = value;
    return value;
  }
  function checkpoint(): PullCheckpoint {
    const result = parsePullCheckpoint({
      version: 1,
      phase,
      repositoryId,
      repositoryOwner,
      repositoryName,
      nextPullPage,
      nextReviewIndex,
      nextReviewPage,
      pulls,
      reviews,
      reviewTraversalComplete: completed,
      discoveryTraversalComplete,
      gaps: [...gaps],
    });
    lastValidated = result;
    return result;
  }
  function terminate(gap: AcquisitionGap) {
    gaps.add(gap);
    phase = 'ready';
    nextPullPage = null;
    pulls.sort(pullOrder);
  }
  function isReady(): boolean {
    return phase === 'ready';
  }
  function canRequest(cost = 1): boolean {
    return requests + cost <= allowance && now() < deadline;
  }
  async function request(
    url: URL,
  ): Promise<{ value: unknown; next: number | null; observedAt: string }> {
    if (input.signal?.aborted) throw new AdapterError('cancelled');
    requests++;
    deadlineCappedTimeout = false;
    let wrapperQuota: GitHubRateLimitError | undefined;
    const transport: FetchTransport = async (url, init) => {
      try {
        return await input.fetch(url, init);
      } catch (error) {
        if (error instanceof GitHubRateLimitError)
          wrapperQuota = new GitHubRateLimitError(error.retryAfterSeconds);
        throw error;
      }
    };
    const timeoutStarted = now();
    const remainingMillis = deadline - timeoutStarted;
    const timeoutMs = Math.max(1, Math.min(10_000, remainingMillis));
    deadlineCappedTimeout = remainingMillis <= 10_000;
    const fetch = createBoundedGitHubTransport({ fetch: transport, timeoutMs });
    let response: Response;
    try {
      response = await fetch(url.href, {
        redirect: 'error',
        signal: input.signal ?? null,
        headers: {
          Authorization: `Bearer ${input.verified.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': githubApiVersion,
        },
      });
    } catch (error) {
      if (wrapperQuota) throw wrapperQuota;
      if (
        deadlineCappedTimeout &&
        error instanceof AdapterError &&
        error.code === 'transport_timeout'
      )
        lastTime = Math.max(lastTime, timeoutStarted + timeoutMs);
      throw error;
    }
    if (!response.ok) {
      const limit = await githubRateLimit(response, () => new Date(now()));
      if (limit.limited) throw new GitHubRateLimitError(limit.retryAfterSeconds);
      throw new AdapterError(`github_http_${response.status}`);
    }
    const next = nextPullEndpointPage(response.headers.get('link'), url);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new AdapterError('invalid_github_json');
    }
    return { value, next, observedAt: canonicalPullTime(new Date(now()).toISOString()) };
  }
  function pullIdentity(value: unknown): Record<string, unknown> {
    const row = object(value),
      repo = object(object(row.base).repo),
      owner = object(repo.owner);
    const number = positiveId(row.number);
    positiveId(row.id);
    if (
      positiveId(repo.id) !== repositoryId ||
      repo.name !== repositoryName ||
      owner.login !== repositoryOwner ||
      repo.full_name !== `${repositoryOwner}/${repositoryName}` ||
      row.url !== `${base}/${number}`
    )
      throw new AdapterError('github_pull_identity_mismatch');
    return row;
  }
  function event(value: unknown, observedAt: string, earliest?: string): string | null {
    try {
      const time = canonicalPullTime(value);
      if (instant(time) > instant(observedAt) || (earliest && instant(time) < instant(earliest)))
        throw new AdapterError('invalid_timestamp');
      return time;
    } catch {
      gaps.add('invalid_time');
      return null;
    }
  }
  function bytesFit(nextPulls: readonly PullFact[], nextReviews: readonly ReviewFact[]): boolean {
    return (
      Buffer.byteLength(JSON.stringify({ pulls: nextPulls, reviews: nextReviews })) <=
      16 * 1024 * 1024 - 4096
    );
  }
  try {
    while (phase !== 'ready') {
      if (input.signal?.aborted) throw new AdapterError('cancelled');
      if (input.activeMillis + now() - start >= 1_800_000) {
        terminate('active_time_limit');
        break;
      }
      if (!canRequest()) break;
      if (phase === 'discovery') {
        const page = nextPullPage;
        if (page === null) throw new AdapterError('invalid_checkpoint');
        const url = new URL(
          `${base}?state=all&sort=created&direction=desc&per_page=50&page=${page}`,
        );
        const response = await request(url);
        if (!Array.isArray(response.value) || response.value.length > 50)
          throw new AdapterError('invalid_github_page');
        const normalized: PullFact[] = [];
        for (const value of response.value) {
          const row = pullIdentity(value),
            author = actor(row.user);
          const createdAt = event(row.created_at, response.observedAt);
          if (!createdAt) continue;
          if (author.accountClass === 'unknown') gaps.add('unknown_actor');
          normalized.push({
            id: positiveId(row.id),
            number: positiveId(row.number),
            createdAt,
            mergedAt:
              row.merged_at === null ? null : event(row.merged_at, response.observedAt, createdAt),
            authorClass: author.accountClass,
            observedAt: response.observedAt,
          });
        }
        const pending = new Map(pulls.map((p) => [p.id, p]));
        for (const pull of normalized) {
          const previous = pending.get(pull.id);
          if (
            (previous && duplicateContent(previous) !== duplicateContent(pull)) ||
            [...pending.values()].some((p) => p.number === pull.number && p.id !== pull.id)
          ) {
            pulls = pulls.filter((p) => p.id !== pull.id && p.number !== pull.number);
            terminate('record_conflict');
            break;
          }
          if (!previous) pending.set(pull.id, pull);
        }
        if (isReady()) break;
        if (pending.size > 1000) {
          terminate('fact_limit');
          break;
        }
        if (!bytesFit([...pending.values()], reviews)) {
          terminate('byte_limit');
          break;
        }
        pulls = [...pending.values()];
        if (response.next !== null && page < 20 && pulls.length < 1000) {
          nextPullPage = response.next;
          continue;
        }
        discoveryTraversalComplete = response.next === null;
        if (!discoveryTraversalComplete) gaps.add('discovery_limit');
        nextPullPage = null;
        pulls.sort(pullOrder);
        phase = pulls.length ? 'reviews' : 'ready';
      } else {
        const retained = pulls[nextReviewIndex];
        if (!retained) {
          phase = 'ready';
          break;
        }
        if (instant(retained.createdAt) >= instant(windowEnd)) {
          nextReviewIndex++;
          nextReviewPage = 1;
          if (nextReviewIndex === pulls.length) phase = 'ready';
          continue;
        }
        // Each claim obtains a fresh transient author identity, including a mid-PR resume.
        if (!canRequest(2)) break;
        const detail = await request(new URL(`${base}/${retained.number}`));
        const row = pullIdentity(detail.value);
        if (positiveId(row.number) !== retained.number)
          throw new AdapterError('github_pull_identity_mismatch');
        const fetchedCreation = event(row.created_at, detail.observedAt);
        if (positiveId(row.id) !== retained.id || fetchedCreation !== retained.createdAt) {
          pulls = pulls.filter((p) => p.id !== retained.id);
          reviews = reviews.filter((r) => r.pullId !== retained.id);
          terminate('record_conflict');
          break;
        }
        const author = actor(row.user);
        let authorClass: AccountClass = author.accountClass;
        if (authorClass === 'unknown' || authorClass !== retained.authorClass) {
          authorClass = 'unknown';
          gaps.add('unknown_actor');
          pulls[nextReviewIndex] = { ...retained, authorClass };
          reviews = reviews.map((r) =>
            r.pullId === retained.id
              ? { ...r, authorClass: 'unknown', actorEligibilityKnown: false, isSelfReview: false }
              : r,
          );
        }
        while (canRequest()) {
          const response = await request(
            new URL(`${base}/${retained.number}/reviews?per_page=100&page=${nextReviewPage}`),
          );
          if (!Array.isArray(response.value) || response.value.length > 100)
            throw new AdapterError('invalid_github_page');
          const normalized: ReviewFact[] = [];
          for (const value of response.value) {
            const row = object(value),
              id = positiveId(row.id);
            if (row.pull_request_url !== `${base}/${retained.number}`)
              throw new AdapterError('github_review_identity_mismatch');
            if (row.state === 'PENDING') continue;
            const state = reviewState(row.state),
              reviewer = actor(row.user);
            const submittedAt = event(row.submitted_at, response.observedAt, retained.createdAt);
            if (!submittedAt) continue;
            const actorEligibilityKnown =
              authorClass !== 'unknown' && reviewer.accountClass !== 'unknown';
            if (!actorEligibilityKnown) gaps.add('unknown_actor');
            normalized.push({
              id,
              pullId: retained.id,
              submittedAt,
              state,
              authorClass,
              reviewerClass: reviewer.accountClass,
              actorEligibilityKnown,
              isSelfReview: actorEligibilityKnown && author.id === reviewer.id,
              observedAt: response.observedAt,
            });
          }
          const pending = new Map(reviews.map((r) => [r.id, r]));
          for (const review of normalized) {
            const previous = pending.get(review.id);
            if (previous && duplicateContent(previous) !== duplicateContent(review)) {
              reviews = reviews.filter((r) => r.id !== review.id);
              terminate('record_conflict');
              break;
            }
            if (!previous) pending.set(review.id, review);
          }
          if (isReady()) break;
          if (pending.size > 10000) {
            terminate('fact_limit');
            break;
          }
          if (!bytesFit(pulls, [...pending.values()])) {
            terminate('byte_limit');
            break;
          }
          reviews = [...pending.values()];
          if (response.next !== null && nextReviewPage < 100 && reviews.length < 10000) {
            nextReviewPage = response.next;
            continue;
          }
          if (response.next === null) completed.push(retained.id);
          else if (reviews.length === 10000) {
            terminate('fact_limit');
            break;
          } else gaps.add('review_limit');
          nextReviewIndex++;
          nextReviewPage = 1;
          if (nextReviewIndex === pulls.length) phase = 'ready';
          break;
        }
      }
    }
    if (phase !== 'ready' && input.activeMillis + now() - start >= 1_800_000)
      terminate('active_time_limit');
    return Object.freeze({
      checkpoint: checkpoint(),
      done: phase === 'ready',
      activeMillis: now() - start,
      requests,
    });
  } catch (error) {
    let retained = lastValidated;
    try {
      retained = checkpoint();
    } catch {
      /* Keep the last validated boundary. */
    }
    if (
      error instanceof AdapterError &&
      error.code === 'transport_timeout' &&
      deadlineCappedTimeout &&
      !input.signal?.aborted
    ) {
      if (input.activeMillis + lastTime - start >= 1_800_000) {
        // Build from validated evidence even if the live checkpoint could not be recovered.
        retained = Object.freeze({
          ...retained,
          phase: 'ready',
          nextPullPage: null,
          pulls: Object.freeze([...retained.pulls].sort(pullOrder)),
          gaps: Object.freeze([
            ...new Set<AcquisitionGap>([...retained.gaps, 'active_time_limit']),
          ]),
        });
      }
      return Object.freeze({
        checkpoint: retained,
        done: retained.phase === 'ready',
        activeMillis: lastTime - start,
        requests,
      });
    }
    if (error instanceof GitHubRateLimitError)
      throw new PullSliceRateLimitError(error.retryAfterSeconds, retained);
    throw new PullSliceError(
      error instanceof AdapterError ? error.code : 'transport_failed',
      retained,
    );
  }
}

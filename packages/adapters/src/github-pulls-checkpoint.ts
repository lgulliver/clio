import type {
  AccountClass,
  AcquisitionGap,
  PullCheckpoint,
  PullFact,
  ReviewFact,
} from './github-pulls-contract.ts';
import { AdapterError, instant, object, positiveId, string, timestamp } from './value.ts';

export function repositorySegment(value: unknown): string {
  const result = string(value);
  if (!/^[A-Za-z0-9_.-]+$/.test(result) || result === '.' || result === '..')
    throw new AdapterError('invalid_repository_binding');
  return result;
}
/** Normalize timezone/fraction spelling without discarding microsecond precision. */
export function canonicalPullTime(value: unknown): string {
  const time = timestamp(value);
  const whole = time.replace(/\.\d{1,6}/, '');
  const fraction = (/\.(\d{1,6})/.exec(time)?.[1] ?? '').replace(/0+$/, '');
  return `${new Date(whole).toISOString().slice(0, 19)}${fraction ? `.${fraction}` : ''}Z`;
}
function canonical(value: unknown): string {
  const result = canonicalPullTime(value);
  if (result !== value) throw new AdapterError('invalid_checkpoint');
  return result;
}
function keys(row: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(row).length !== expected.length || expected.some((key) => !(key in row)))
    throw new AdapterError('invalid_checkpoint');
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new AdapterError('invalid_checkpoint');
  return value;
}
function count(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new AdapterError('invalid_checkpoint');
  return value;
}
function account(value: unknown): AccountClass {
  if (value !== 'human' && value !== 'bot' && value !== 'unknown')
    throw new AdapterError('invalid_checkpoint');
  return value;
}
export function reviewState(value: unknown): ReviewFact['state'] {
  if (
    value !== 'COMMENTED' &&
    value !== 'APPROVED' &&
    value !== 'CHANGES_REQUESTED' &&
    value !== 'DISMISSED'
  )
    throw new AdapterError('invalid_review_state');
  return value;
}
export function pullOrder(a: PullFact, b: PullFact): number {
  const left = instant(a.createdAt),
    right = instant(b.createdAt);
  return left === right ? b.id - a.id : left > right ? -1 : 1;
}
export function parsePullCheckpoint(value: unknown): PullCheckpoint {
  const row = object(value);
  keys(row, [
    'version',
    'phase',
    'repositoryId',
    'repositoryOwner',
    'repositoryName',
    'nextPullPage',
    'nextReviewIndex',
    'nextReviewPage',
    'pulls',
    'reviews',
    'reviewTraversalComplete',
    'discoveryTraversalComplete',
    'gaps',
  ]);
  if (
    row.version !== 1 ||
    (row.phase !== 'discovery' && row.phase !== 'reviews' && row.phase !== 'ready')
  )
    throw new AdapterError('invalid_checkpoint');
  if (
    !Array.isArray(row.pulls) ||
    row.pulls.length > 1000 ||
    !Array.isArray(row.reviews) ||
    row.reviews.length > 10000 ||
    !Array.isArray(row.reviewTraversalComplete) ||
    !Array.isArray(row.gaps) ||
    row.gaps.length > 8 ||
    row.reviewTraversalComplete.length > row.pulls.length
  )
    throw new AdapterError('invalid_checkpoint');
  const ids = new Set<number>(),
    numbers = new Set<number>();
  const pulls = row.pulls.map((value: unknown): PullFact => {
    const item = object(value);
    keys(item, ['id', 'number', 'createdAt', 'mergedAt', 'authorClass', 'observedAt']);
    const id = positiveId(item.id),
      number = positiveId(item.number),
      createdAt = canonical(item.createdAt),
      observedAt = canonical(item.observedAt);
    const mergedAt = item.mergedAt === null ? null : canonical(item.mergedAt);
    if (
      ids.has(id) ||
      numbers.has(number) ||
      instant(createdAt) > instant(observedAt) ||
      (mergedAt !== null &&
        (instant(mergedAt) < instant(createdAt) || instant(mergedAt) > instant(observedAt)))
    )
      throw new AdapterError('invalid_checkpoint');
    ids.add(id);
    numbers.add(number);
    return Object.freeze({
      id,
      number,
      createdAt,
      mergedAt,
      authorClass: account(item.authorClass),
      observedAt,
    });
  });
  const reviewIds = new Set<number>();
  const reviews = row.reviews.map((value: unknown): ReviewFact => {
    const item = object(value);
    keys(item, [
      'id',
      'pullId',
      'submittedAt',
      'state',
      'authorClass',
      'reviewerClass',
      'actorEligibilityKnown',
      'isSelfReview',
      'observedAt',
    ]);
    const id = positiveId(item.id),
      pullId = positiveId(item.pullId),
      submittedAt = canonical(item.submittedAt),
      observedAt = canonical(item.observedAt);
    const pull = pulls.find((entry) => entry.id === pullId);
    const authorClass = account(item.authorClass),
      reviewerClass = account(item.reviewerClass),
      actorEligibilityKnown = bool(item.actorEligibilityKnown),
      isSelfReview = bool(item.isSelfReview);
    if (
      reviewIds.has(id) ||
      !pull ||
      instant(submittedAt) < instant(pull.createdAt) ||
      instant(submittedAt) > instant(observedAt) ||
      authorClass !== pull.authorClass ||
      (actorEligibilityKnown && (authorClass === 'unknown' || reviewerClass === 'unknown')) ||
      (isSelfReview && !actorEligibilityKnown)
    )
      throw new AdapterError('invalid_checkpoint');
    reviewIds.add(id);
    return Object.freeze({
      id,
      pullId,
      submittedAt,
      state: reviewState(item.state),
      authorClass,
      reviewerClass,
      actorEligibilityKnown,
      isSelfReview,
      observedAt,
    });
  });
  const nextPullPage = row.nextPullPage === null ? null : positiveId(row.nextPullPage);
  const nextReviewIndex = count(row.nextReviewIndex, pulls.length),
    nextReviewPage = positiveId(row.nextReviewPage);
  const discoveryTraversalComplete = bool(row.discoveryTraversalComplete);
  if ((nextPullPage !== null && nextPullPage > 20) || nextReviewPage > 100)
    throw new AdapterError('invalid_checkpoint');
  if (
    reviews.some((review) => {
      const index = pulls.findIndex((pull) => pull.id === review.pullId);
      return index > nextReviewIndex || (index === nextReviewIndex && nextReviewPage === 1);
    })
  )
    throw new AdapterError('invalid_checkpoint');
  const completed = row.reviewTraversalComplete.map((value: unknown) => positiveId(value));
  if (
    new Set(completed).size !== completed.length ||
    completed.some((id) => !ids.has(id) || pulls.findIndex((p) => p.id === id) >= nextReviewIndex)
  )
    throw new AdapterError('invalid_checkpoint');
  if (row.phase === 'discovery') {
    if (
      nextPullPage === null ||
      nextReviewIndex !== 0 ||
      nextReviewPage !== 1 ||
      reviews.length ||
      completed.length ||
      discoveryTraversalComplete
    )
      throw new AdapterError('invalid_checkpoint');
  } else if (
    nextPullPage !== null ||
    (row.phase === 'reviews' && nextReviewIndex === pulls.length) ||
    pulls.some((p, i) => i > 0 && pullOrder(pulls[i - 1] ?? p, p) > 0)
  )
    throw new AdapterError('invalid_checkpoint');
  const allowed: readonly AcquisitionGap[] = [
    'discovery_limit',
    'review_limit',
    'fact_limit',
    'byte_limit',
    'active_time_limit',
    'record_conflict',
    'invalid_time',
    'unknown_actor',
  ];
  const gaps = row.gaps.map((value: unknown): AcquisitionGap => {
    for (const gap of allowed) if (gap === value) return gap;
    throw new AdapterError('invalid_checkpoint');
  });
  if (
    new Set(gaps).size !== gaps.length ||
    (discoveryTraversalComplete && gaps.includes('discovery_limit'))
  )
    throw new AdapterError('invalid_checkpoint');
  const terminalGap = gaps.some(
    (gap) =>
      gap === 'active_time_limit' ||
      gap === 'record_conflict' ||
      gap === 'fact_limit' ||
      gap === 'byte_limit',
  );
  if (
    (row.phase !== 'discovery' &&
      !discoveryTraversalComplete &&
      !gaps.includes('discovery_limit') &&
      !terminalGap) ||
    (row.phase === 'ready' && nextReviewIndex < pulls.length && !terminalGap)
  )
    throw new AdapterError('invalid_checkpoint');

  const result: PullCheckpoint = Object.freeze({
    version: 1,
    phase: row.phase,
    repositoryId: positiveId(row.repositoryId),
    repositoryOwner: repositorySegment(row.repositoryOwner),
    repositoryName: repositorySegment(row.repositoryName),
    nextPullPage,
    nextReviewIndex,
    nextReviewPage,
    pulls: Object.freeze(pulls),
    reviews: Object.freeze(reviews),
    reviewTraversalComplete: Object.freeze(completed),
    discoveryTraversalComplete,
    gaps: Object.freeze(gaps),
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024)
    throw new AdapterError('invalid_checkpoint');
  return result;
}

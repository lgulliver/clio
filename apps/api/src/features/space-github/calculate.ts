import type { PullCheckpoint, ReviewFact } from '@clio/adapters';
import {
  type CalculatedSignals,
  calculationVersion,
  type OperationWindow,
  type Signal,
  type SignalId,
} from './contract.ts';
import { instantMicros, parseWindow } from './input.ts';

function count(id: SignalId, size: number): Signal {
  return {
    id,
    status: size ? 'provisional' : 'no_observations',
    value: size || null,
    unit: 'count',
    sampleCount: size,
  };
}
function duration(id: SignalId, values: bigint[]): Signal {
  values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(values.length / 2),
    upper = values[middle],
    lower = values[middle - 1];
  const value =
    values.length >= 3 && upper !== undefined
      ? (values.length % 2 || lower === undefined ? Number(upper) : Number(upper + lower) / 2) /
        3600000000
      : null;
  return {
    id,
    status: value === null ? 'insufficient_samples' : 'provisional',
    value,
    unit: 'hours',
    sampleCount: values.length,
  };
}
export function calculateSignals(
  checkpoint: PullCheckpoint,
  window: OperationWindow,
): CalculatedSignals {
  const bounds = parseWindow(window),
    start = instantMicros(bounds.windowStart),
    end = instantMicros(bounds.windowEnd);
  const within = (time: string) => {
    const t = instantMicros(time);
    return t >= start && t < end;
  };
  const pulls = [...new Map(checkpoint.pulls.map((p) => [p.id, p])).values()];
  const reviews = [...new Map(checkpoint.reviews.map((r) => [r.id, r])).values()];
  const byId = new Map(pulls.map((p) => [p.id, p]));
  const qualifies = (r: ReviewFact) => {
    const p = byId.get(r.pullId);
    return (
      p !== undefined &&
      p.authorClass !== 'unknown' &&
      r.authorClass === p.authorClass &&
      r.reviewerClass === 'human' &&
      r.actorEligibilityKnown &&
      !r.isSelfReview &&
      instantMicros(r.submittedAt) >= instantMicros(p.createdAt)
    );
  };
  const complete = new Set(checkpoint.reviewTraversalComplete);
  const first: bigint[] = [],
    merge: bigint[] = [];
  const reviewContext = {
    reviewed: 0,
    noQualifyingReview: 0,
    unknownTraversal: 0,
    excludedActors: 0,
  };
  for (const p of pulls) {
    if (p.authorClass === 'human' && p.mergedAt !== null && within(p.mergedAt)) {
      const elapsed = instantMicros(p.mergedAt) - instantMicros(p.createdAt);
      if (elapsed >= 0n) merge.push(elapsed);
    }
    if (!within(p.createdAt)) continue;
    if (p.authorClass !== 'human') {
      reviewContext.excludedActors++;
      continue;
    }
    if (!complete.has(p.id)) {
      reviewContext.unknownTraversal++;
      continue;
    }
    const eligible = reviews
      .filter((r) => r.pullId === p.id && qualifies(r) && within(r.submittedAt))
      .map((r) => instantMicros(r.submittedAt));
    if (!eligible.length) {
      reviewContext.noQualifyingReview++;
      continue;
    }
    const earliest = eligible.reduce((a, b) => (a < b ? a : b));
    first.push(earliest - instantMicros(p.createdAt));
    reviewContext.reviewed++;
  }
  return {
    calculationVersion,
    signals: [
      count('pulls_opened', pulls.filter((p) => within(p.createdAt)).length),
      count(
        'pulls_merged',
        pulls.filter(
          (p) =>
            p.mergedAt !== null &&
            within(p.mergedAt) &&
            instantMicros(p.mergedAt) >= instantMicros(p.createdAt),
        ).length,
      ),
      count(
        'reviews_submitted',
        reviews.filter((r) => qualifies(r) && within(r.submittedAt)).length,
      ),
      duration('open_to_first_review', first),
      duration('open_to_merge', merge),
    ],
    reviewContext,
  };
}

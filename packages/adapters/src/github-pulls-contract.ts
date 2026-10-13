import type { FetchTransport } from './github-app.ts';
import { GitHubRateLimitError } from './github-rate-limit.ts';
import { AdapterError } from './value.ts';

export type AccountClass = 'human' | 'bot' | 'unknown';
export type PullFact = Readonly<{
  id: number;
  number: number;
  createdAt: string;
  mergedAt: string | null;
  authorClass: AccountClass;
  observedAt: string;
}>;
export type ReviewFact = Readonly<{
  id: number;
  pullId: number;
  submittedAt: string;
  state: 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED';
  authorClass: AccountClass;
  reviewerClass: AccountClass;
  actorEligibilityKnown: boolean;
  isSelfReview: boolean;
  observedAt: string;
}>;
export type AcquisitionGap =
  | 'discovery_limit'
  | 'review_limit'
  | 'fact_limit'
  | 'byte_limit'
  | 'active_time_limit'
  | 'record_conflict'
  | 'invalid_time'
  | 'unknown_actor';
export type PullCheckpoint = Readonly<{
  version: 1;
  phase: 'discovery' | 'reviews' | 'ready';
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  nextPullPage: number | null;
  nextReviewIndex: number;
  nextReviewPage: number;
  pulls: readonly PullFact[];
  reviews: readonly ReviewFact[];
  reviewTraversalComplete: readonly number[];
  discoveryTraversalComplete: boolean;
  gaps: readonly AcquisitionGap[];
}>;
export type PullSlice = Readonly<{
  checkpoint: PullCheckpoint;
  done: boolean;
  activeMillis: number;
  requests: number;
}>;
export type PullSliceInput = Readonly<{
  verified: Readonly<{
    repositoryId: number;
    repositoryOwner: string;
    repositoryName: string;
    token: string;
  }>;
  window: Readonly<{ windowStart: string; windowEnd: string }>;
  checkpoint: PullCheckpoint | null;
  activeMillis: number;
  fetch: FetchTransport;
  clock: () => Date;
  signal?: AbortSignal;
  /** Remaining allowance after verification, never a fresh verification budget. */
  remainingRequests?: number;
  /** Original claim's provider deadline, including verification and pacing. */
  deadline?: Date;
}>;

/** Safe failures retain only the last validated page boundary for retry. */
export class PullSliceError extends AdapterError {
  readonly checkpoint: PullCheckpoint;
  constructor(code: string, checkpoint: PullCheckpoint) {
    super(code);
    this.checkpoint = checkpoint;
  }
}
export class PullSliceRateLimitError extends GitHubRateLimitError {
  readonly checkpoint: PullCheckpoint;
  constructor(retryAfterSeconds: number | null, checkpoint: PullCheckpoint) {
    super(retryAfterSeconds);
    this.checkpoint = checkpoint;
  }
}

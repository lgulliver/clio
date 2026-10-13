/** Application operational semantics; independent of OEMS and confidential team pulses. */
export const contractVersion = 'clio.space.github.v1';
export const calculationVersion = 'clio.space.github.calculation.v1';
export const signalIds = [
  'pulls_opened',
  'pulls_merged',
  'reviews_submitted',
  'open_to_first_review',
  'open_to_merge',
] as const;
export type SignalId = (typeof signalIds)[number];
export type Signal = Readonly<{
  id: SignalId;
  status: 'provisional' | 'no_observations' | 'insufficient_samples';
  value: number | null;
  unit: 'count' | 'hours';
  sampleCount: number;
}>;
export type CalculatedSignals = Readonly<{
  calculationVersion: typeof calculationVersion;
  signals: readonly Signal[];
  reviewContext: Readonly<{
    reviewed: number;
    noQualifyingReview: number;
    unknownTraversal: number;
    excludedActors: number;
  }>;
}>;
export const gapReasons = [
  'discovery_limit',
  'review_limit',
  'fact_limit',
  'byte_limit',
  'active_time_limit',
  'record_conflict',
  'invalid_time',
  'unknown_actor',
] as const;
export type GapReason = (typeof gapReasons)[number];
export const runReasons = [
  'scope_changed',
  'disconnected',
  'grant_removed',
  'expired',
  'provider_unavailable',
  'invalid_provider_data',
  'retry_exhausted',
] as const;
export type RunReason = (typeof runReasons)[number];
export type OperationWindow = Readonly<{ windowStart: string; windowEnd: string }>;
export type OperationSource = Readonly<{
  appId: number;
  installationId: number;
  repositoryId: number;
  repositoryLabel: string;
}>;
export type OperationContext = OperationSource &
  OperationWindow &
  Readonly<{
    workspaceId: string;
    mappingId: string;
    mappingRevision: number;
    teamId: string;
    teamName: string;
  }>;
export type OperationMapping = OperationSource &
  Readonly<{
    id: string;
    workspaceId: string;
    teamId: string;
    teamName: string;
    revision: number;
    connected: boolean;
  }>;
export type OperationResult = OperationContext &
  Readonly<{
    id: string;
    runId: string;
    acquisitionStartedAt: string;
    acquisitionEndedAt: string;
    completedAt: string;
    contractVersion: typeof contractVersion;
    calculated: CalculatedSignals;
    discoveryTraversalComplete: boolean;
    reviewTraversalComplete: boolean;
    gaps: readonly GapReason[];
  }>;
export type OperationRun = OperationContext &
  Readonly<{
    id: string;
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    queuedAt: string;
    completedAt: string | null;
    reason: RunReason | null;
    resultId: string | null;
  }>;
export type OperationGrant = Readonly<{
  appId: number;
  installationId: number;
  accountId: number;
  accountType: 'User' | 'Organization';
  repositoryIds: readonly number[];
}>;
export type OperationAvailability =
  | Readonly<{ workspaceId: string; enabled: boolean }>
  | Readonly<{ workspaceId: string; enabled: boolean; grants: readonly OperationGrant[] }>;
export type OperationMappingPage = Readonly<{
  workspaceId: string;
  teamId: string | null;
  mappings: readonly OperationMapping[];
  nextCursor: string | null;
}>;
export type OperationRunPage = Readonly<{
  workspaceId: string;
  mappingId: string;
  teamId: string | null;
  runs: readonly OperationRun[];
  nextCursor: string | null;
}>;
export type OperationResultPage = Readonly<{
  workspaceId: string;
  mappingId: string;
  teamId: string | null;
  results: readonly OperationResult[];
  nextCursor: string | null;
}>;
export type MappingRequest = Readonly<{
  installationId: number;
  repositoryId: number;
  teamId: string;
}>;
export type CollectionRequest = OperationWindow & Readonly<{ revision: number; requestId: string }>;

export type MappingUpdateRequest = Readonly<{ revision: number; teamId: string }>;
export type DisconnectRequest = Readonly<{ revision: number }>;

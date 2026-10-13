import { ApiError, record, request } from '../identity/api';
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
export const signalLabels: Readonly<Record<SignalId, string>> = {
  pulls_opened: 'PRs opened observed',
  pulls_merged: 'PRs merged observed',
  reviews_submitted: 'Review records submitted observed',
  open_to_first_review: 'Time to first human review (open to first review)',
  open_to_merge: 'PR review time (open to merge)',
};
export type OperationScope = {
  workspaceId: string;
  mappingId?: string;
  teamId?: string;
  runId?: string;
  resultId?: string;
  mappingRevision?: number;
  appId?: number;
  installationId?: number;
  repositoryId?: number;
  windowStart?: string;
  windowEnd?: string;
  cursor?: string;
};
function invalid(): never {
  throw new ApiError(0);
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = record(value);
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key))
  )
    invalid();
  return row;
}
function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
    invalid();
  return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function name(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    !value ||
    [...value].length > 200 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string') invalid();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match?.[1]) invalid();
  const base = `${match[1]}.000Z`;
  if (!Number.isFinite(Date.parse(base)) || new Date(base).toISOString() !== base) invalid();
  return value;
}
function micros(value: string): bigint {
  const t = timestamp(value);
  return (
    BigInt(Date.parse(`${t.slice(0, 19)}.000Z`)) * 1000n +
    BigInt((t.includes('.') ? t.slice(20, -1) : '').padEnd(6, '0'))
  );
}
function window(row: Record<string, unknown>): OperationWindow {
  const start = timestamp(row.windowStart),
    end = timestamp(row.windowEnd);
  if (
    !start.endsWith('T00:00:00.000Z') ||
    !end.endsWith('T00:00:00.000Z') ||
    micros(start) >= micros(end) ||
    micros(end) - micros(start) > 90n * 86400000000n
  )
    invalid();
  return { windowStart: start, windowEnd: end };
}
const sourceKeys = ['appId', 'installationId', 'repositoryId', 'repositoryLabel'];
const contextKeys = [
  ...sourceKeys,
  'workspaceId',
  'mappingId',
  'mappingRevision',
  'teamId',
  'teamName',
  'windowStart',
  'windowEnd',
];
function source(row: Record<string, unknown>): OperationSource {
  const label = name(row.repositoryLabel);
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(label)) invalid();
  return {
    appId: integer(row.appId, 1),
    installationId: integer(row.installationId, 1),
    repositoryId: integer(row.repositoryId, 1),
    repositoryLabel: label,
  };
}
function context(row: Record<string, unknown>, scope: OperationScope): OperationContext {
  const result = {
    ...source(row),
    ...window(row),
    workspaceId: uuid(row.workspaceId),
    mappingId: uuid(row.mappingId),
    mappingRevision: integer(row.mappingRevision, 1),
    teamId: uuid(row.teamId),
    teamName: name(row.teamName),
  };
  for (const key of [
    'workspaceId',
    'mappingId',
    'mappingRevision',
    'teamId',
    'appId',
    'installationId',
    'repositoryId',
    'windowStart',
    'windowEnd',
  ] as const) {
    if (scope[key] !== undefined && result[key] !== scope[key]) invalid();
  }
  return result;
}
function calculated(value: unknown): CalculatedSignals {
  const row = exact(value, ['calculationVersion', 'signals', 'reviewContext']);
  if (
    row.calculationVersion !== calculationVersion ||
    !Array.isArray(row.signals) ||
    row.signals.length !== 5
  )
    invalid();
  const signals = row.signals.map((value: unknown, index): Signal => {
    const s = exact(value, ['id', 'status', 'value', 'unit', 'sampleCount']);
    const id = signalIds[index];
    if (!id || s.id !== id) invalid();
    const duration = index >= 3;
    const size = integer(s.sampleCount, 0, duration ? 1000 : index === 2 ? 10000 : 1000);
    if (s.unit !== (duration ? 'hours' : 'count')) invalid();
    if (duration) {
      if (size < 3) {
        if (s.status !== 'insufficient_samples' || s.value !== null) invalid();
      } else if (
        s.status !== 'provisional' ||
        typeof s.value !== 'number' ||
        !Number.isFinite(s.value) ||
        s.value < 0
      )
        invalid();
    } else if (size === 0) {
      if (s.status !== 'no_observations' || s.value !== null) invalid();
    } else if (s.status !== 'provisional' || s.value !== size) invalid();
    if (
      s.status !== 'provisional' &&
      s.status !== 'no_observations' &&
      s.status !== 'insufficient_samples'
    )
      invalid();
    if (s.value !== null && typeof s.value !== 'number') invalid();
    return {
      id,
      status: s.status,
      value: s.value,
      unit: duration ? 'hours' : 'count',
      sampleCount: size,
    };
  });
  const c = exact(row.reviewContext, [
    'reviewed',
    'noQualifyingReview',
    'unknownTraversal',
    'excludedActors',
  ]);
  const reviewContext = {
    reviewed: integer(c.reviewed, 0, 1000),
    noQualifyingReview: integer(c.noQualifyingReview, 0, 1000),
    unknownTraversal: integer(c.unknownTraversal, 0, 1000),
    excludedActors: integer(c.excludedActors, 0, 1000),
  };
  if (
    reviewContext.reviewed !== signals[3]?.sampleCount ||
    Object.values(reviewContext).reduce((a, b) => a + b, 0) !== signals[0]?.sampleCount
  )
    invalid();
  if (
    (signals[4]?.sampleCount ?? 0) > (signals[1]?.sampleCount ?? 0) ||
    reviewContext.reviewed > (signals[2]?.sampleCount ?? 0)
  )
    invalid();
  return { calculationVersion, signals, reviewContext };
}
function result(value: unknown, scope: OperationScope): OperationResult {
  const row = exact(value, [
    ...contextKeys,
    'id',
    'runId',
    'acquisitionStartedAt',
    'acquisitionEndedAt',
    'completedAt',
    'contractVersion',
    'calculated',
    'discoveryTraversalComplete',
    'reviewTraversalComplete',
    'gaps',
  ]);
  if (
    row.contractVersion !== contractVersion ||
    !Array.isArray(row.gaps) ||
    row.gaps.length > gapReasons.length
  )
    invalid();
  const gaps = row.gaps.map((g: unknown) => {
    const found = gapReasons.find((v) => v === g);
    if (!found) invalid();
    return found;
  });
  if (new Set(gaps).size !== gaps.length) invalid();
  const id = uuid(row.id),
    runId = uuid(row.runId);
  if (
    (scope.resultId !== undefined && id !== scope.resultId) ||
    (scope.runId !== undefined && runId !== scope.runId)
  )
    invalid();
  const acquisitionStartedAt = timestamp(row.acquisitionStartedAt),
    acquisitionEndedAt = timestamp(row.acquisitionEndedAt),
    completedAt = timestamp(row.completedAt);
  const ctx = context(row, scope);
  if (
    micros(acquisitionStartedAt) > micros(acquisitionEndedAt) ||
    micros(acquisitionEndedAt) > micros(completedAt) ||
    micros(ctx.windowEnd) > micros(acquisitionStartedAt)
  )
    invalid();
  const qualification = calculated(row.calculated);
  const discoveryTraversalComplete = bool(row.discoveryTraversalComplete);
  const reviewTraversalComplete = bool(row.reviewTraversalComplete);
  if (
    (discoveryTraversalComplete && gaps.includes('discovery_limit')) ||
    (reviewTraversalComplete && qualification.reviewContext.unknownTraversal > 0)
  )
    invalid();
  return {
    ...ctx,
    id,
    runId,
    acquisitionStartedAt,
    acquisitionEndedAt,
    completedAt,
    contractVersion,
    calculated: qualification,
    discoveryTraversalComplete,
    reviewTraversalComplete,
    gaps,
  };
}
function mapping(value: unknown, scope: OperationScope): OperationMapping {
  const row = exact(value, [
    ...sourceKeys,
    'id',
    'workspaceId',
    'teamId',
    'teamName',
    'revision',
    'connected',
  ]);
  const id = uuid(row.id);
  if (
    row.workspaceId !== scope.workspaceId ||
    (scope.mappingId !== undefined && id !== scope.mappingId)
  )
    invalid();
  return {
    ...source(row),
    id,
    workspaceId: scope.workspaceId,
    teamId: uuid(row.teamId),
    teamName: name(row.teamName),
    revision: integer(row.revision, 1),
    connected: bool(row.connected),
  };
}
function run(value: unknown, scope: OperationScope): OperationRun {
  const row = exact(value, [
    ...contextKeys,
    'id',
    'state',
    'queuedAt',
    'completedAt',
    'reason',
    'resultId',
  ]);
  const state = row.state;
  if (
    state !== 'queued' &&
    state !== 'running' &&
    state !== 'succeeded' &&
    state !== 'failed' &&
    state !== 'cancelled'
  )
    invalid();
  const id = uuid(row.id);
  if (scope.runId !== undefined && id !== scope.runId) invalid();
  const queuedAt = timestamp(row.queuedAt),
    completedAt = row.completedAt === null ? null : timestamp(row.completedAt);
  const resultId = row.resultId === null ? null : uuid(row.resultId);
  const reason = row.reason === null ? null : runReasons.find((r) => r === row.reason);
  if (reason === undefined) invalid();
  if (
    state === 'failed' &&
    (reason === null ||
      reason === 'scope_changed' ||
      reason === 'disconnected' ||
      reason === 'grant_removed')
  )
    invalid();
  if (
    state === 'cancelled' &&
    reason !== 'scope_changed' &&
    reason !== 'disconnected' &&
    reason !== 'grant_removed'
  )
    invalid();
  const terminal = state === 'succeeded' || state === 'failed' || state === 'cancelled';
  if (
    terminal !== (completedAt !== null) ||
    (state === 'succeeded') !== (resultId !== null) ||
    ((state === 'queued' || state === 'running' || state === 'succeeded') && reason !== null) ||
    (completedAt !== null && micros(completedAt) < micros(queuedAt))
  )
    invalid();
  const ctx = context(row, scope);
  if (micros(ctx.windowEnd) > micros(queuedAt)) invalid();
  return { ...ctx, id, state, queuedAt, completedAt, resultId, reason };
}
export function parseOperationResult(value: unknown, scope: OperationScope): OperationResult {
  return result(exact(value, ['result']).result, scope);
}
export function parseOperationMapping(value: unknown, scope: OperationScope): OperationMapping {
  return mapping(exact(value, ['mapping']).mapping, scope);
}
export function parseOperationRun(value: unknown, scope: OperationScope): OperationRun {
  return run(exact(value, ['run']).run, scope);
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) invalid();
  return value;
}
function page<T extends { id: string }>(
  value: unknown,
  scope: OperationScope,
  key: string,
  parse: (value: unknown, scope: OperationScope) => T,
  hasMapping: boolean,
): { items: T[]; nextCursor: string | null } {
  const row = exact(value, [
    'workspaceId',
    'teamId',
    ...(hasMapping ? ['mappingId'] : []),
    key,
    'nextCursor',
  ]);
  const items = row[key];
  if (
    row.workspaceId !== scope.workspaceId ||
    row.teamId !== (scope.teamId ?? null) ||
    (hasMapping && row.mappingId !== scope.mappingId) ||
    !Array.isArray(items) ||
    items.length > 25
  )
    invalid();
  const parsed = items.map((v) => parse(v, scope));
  if (
    new Set(parsed.map((v) => v.id)).size !== parsed.length ||
    parsed.some((v) => v.id === scope.cursor)
  )
    invalid();
  const nextCursor = cursor(row.nextCursor);
  if (nextCursor !== null && (parsed.length !== 25 || nextCursor === scope.cursor)) invalid();
  return { items: parsed, nextCursor };
}
export function parseOperationMappingPage(
  value: unknown,
  scope: OperationScope,
): OperationMappingPage {
  const p = page(value, scope, 'mappings', mapping, false);
  return {
    workspaceId: scope.workspaceId,
    teamId: scope.teamId ?? null,
    mappings: p.items,
    nextCursor: p.nextCursor,
  };
}
export function parseOperationRunPage(
  value: unknown,
  scope: OperationScope & { mappingId: string },
): OperationRunPage {
  const p = page(value, scope, 'runs', run, true);
  return {
    workspaceId: scope.workspaceId,
    mappingId: scope.mappingId,
    teamId: scope.teamId ?? null,
    runs: p.items,
    nextCursor: p.nextCursor,
  };
}
export function parseOperationResultPage(
  value: unknown,
  scope: OperationScope & { mappingId: string },
): OperationResultPage {
  const p = page(value, scope, 'results', result, true);
  return {
    workspaceId: scope.workspaceId,
    mappingId: scope.mappingId,
    teamId: scope.teamId ?? null,
    results: p.items,
    nextCursor: p.nextCursor,
  };
}
export function parseOperationAvailability(
  value: unknown,
  scope: { workspaceId: string; role: 'owner' | 'member' },
): OperationAvailability {
  const row = exact(
    value,
    scope.role === 'owner' ? ['workspaceId', 'enabled', 'grants'] : ['workspaceId', 'enabled'],
  );
  if (row.workspaceId !== scope.workspaceId) invalid();
  const enabled = bool(row.enabled);
  if (scope.role === 'member') return { workspaceId: scope.workspaceId, enabled };
  if (!Array.isArray(row.grants) || row.grants.length > 100) invalid();
  const grants = row.grants.map((value: unknown): OperationGrant => {
    const g = exact(value, [
      'appId',
      'installationId',
      'accountId',
      'accountType',
      'repositoryIds',
    ]);
    if (g.accountType !== 'User' && g.accountType !== 'Organization') invalid();
    if (!Array.isArray(g.repositoryIds) || g.repositoryIds.length > 100) invalid();
    const repositoryIds = g.repositoryIds.map((id) => integer(id, 1));
    if (new Set(repositoryIds).size !== repositoryIds.length) invalid();
    return {
      appId: integer(g.appId, 1),
      installationId: integer(g.installationId, 1),
      accountId: integer(g.accountId, 1),
      accountType: g.accountType,
      repositoryIds,
    };
  });
  if (
    new Set(grants.map((g) => `${g.appId}:${g.installationId}:${g.accountId}`)).size !==
    grants.length
  )
    invalid();
  return { workspaceId: scope.workspaceId, enabled, grants };
}
function base(workspaceId: string): string {
  return `/api/workspaces/${uuid(workspaceId)}/space/github`;
}
function query(scope: OperationScope): string {
  const q = new URLSearchParams();
  if (scope.teamId !== undefined) q.set('teamId', uuid(scope.teamId));
  if (scope.cursor !== undefined) {
    cursor(scope.cursor);
    q.set('cursor', scope.cursor);
  }
  return q.size ? `?${q}` : '';
}
export function getOperationAvailability(
  scope: { workspaceId: string; role: 'owner' | 'member' },
  signal?: AbortSignal,
) {
  return request(
    `${base(scope.workspaceId)}/availability`,
    (v) => parseOperationAvailability(v, scope),
    { ...(signal ? { signal } : {}) },
  );
}
export function getOperationMappings(scope: OperationScope, signal?: AbortSignal) {
  return request(
    `${base(scope.workspaceId)}/mappings${query(scope)}`,
    (v) => parseOperationMappingPage(v, scope),
    { ...(signal ? { signal } : {}) },
  );
}
export function getOperationRuns(
  scope: OperationScope & { mappingId: string },
  signal?: AbortSignal,
) {
  return request(
    `${base(scope.workspaceId)}/mappings/${uuid(scope.mappingId)}/runs${query(scope)}`,
    (v) => parseOperationRunPage(v, scope),
    { ...(signal ? { signal } : {}) },
  );
}
export function getOperationResults(
  scope: OperationScope & { mappingId: string },
  signal?: AbortSignal,
) {
  return request(
    `${base(scope.workspaceId)}/mappings/${uuid(scope.mappingId)}/results${query(scope)}`,
    (v) => parseOperationResultPage(v, scope),
    { ...(signal ? { signal } : {}) },
  );
}
export function getOperationResult(
  scope: OperationScope & { resultId: string },
  signal?: AbortSignal,
) {
  return request(
    `${base(scope.workspaceId)}/results/${uuid(scope.resultId)}`,
    (v) => parseOperationResult(v, scope),
    { ...(signal ? { signal } : {}) },
  );
}
export function saveOperationMapping(
  workspaceId: string,
  body: MappingRequest,
  signal?: AbortSignal,
) {
  return request(
    `${base(workspaceId)}/mappings`,
    (v) => {
      const mapping = parseOperationMapping(v, { workspaceId });
      if (
        mapping.teamId !== body.teamId ||
        mapping.installationId !== body.installationId ||
        mapping.repositoryId !== body.repositoryId ||
        !mapping.connected
      )
        invalid();
      return mapping;
    },
    { body, ...(signal ? { signal } : {}) },
  );
}
export function collectOperation(
  scope: OperationScope & { mappingId: string },
  body: CollectionRequest,
  signal?: AbortSignal,
) {
  return request(
    `${base(scope.workspaceId)}/mappings/${uuid(scope.mappingId)}/runs`,
    (v) => parseOperationRun(v, { ...scope, ...body, mappingRevision: body.revision }),
    { body, ...(signal ? { signal } : {}) },
  );
}
export function disconnectOperation(
  scope: OperationScope & { mappingId: string },
  body: { revision: number },
  signal?: AbortSignal,
) {
  return request(
    `${base(scope.workspaceId)}/mappings/${uuid(scope.mappingId)}/disconnect`,
    (v) => {
      const mapping = parseOperationMapping(v, scope);
      if (mapping.connected) invalid();
      return mapping;
    },
    { body, ...(signal ? { signal } : {}) },
  );
}
export function updateOperationMapping(
  scope: OperationScope & { mappingId: string },
  body: { revision: number; teamId: string },
  signal?: AbortSignal,
) {
  return request(
    `${base(scope.workspaceId)}/mappings/${uuid(scope.mappingId)}`,
    (v) => {
      const mapping = parseOperationMapping(v, scope);
      if (mapping.teamId !== body.teamId) invalid();
      return mapping;
    },
    { method: 'PATCH', body, ...(signal ? { signal } : {}) },
  );
}
export type MappingUpdateRequest = Readonly<{ revision: number; teamId: string }>;
export type DisconnectRequest = Readonly<{ revision: number }>;

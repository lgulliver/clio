import { IdentityError } from '../identity/input.ts';
import {
  type CalculatedSignals,
  calculationVersion,
  contractVersion,
  gapReasons,
  type OperationContext,
  type OperationResult,
  type OperationSource,
  type OperationWindow,
  type Signal,
  signalIds,
} from './contract.ts';

// Stored public JSON is validated independently of private provider evidence.
function invalid(): never {
  throw new IdentityError(500, 'invalid_stored_data');
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const row: Record<string, unknown> = Object.fromEntries(Object.entries(value));
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
function context(row: Record<string, unknown>): OperationContext {
  const result = {
    ...source(row),
    ...window(row),
    workspaceId: uuid(row.workspaceId),
    mappingId: uuid(row.mappingId),
    mappingRevision: integer(row.mappingRevision, 1),
    teamId: uuid(row.teamId),
    teamName: name(row.teamName),
  };
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
export function parseStoredResult(value: unknown): OperationResult {
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
  const acquisitionStartedAt = timestamp(row.acquisitionStartedAt),
    acquisitionEndedAt = timestamp(row.acquisitionEndedAt),
    completedAt = timestamp(row.completedAt);
  const ctx = context(row);
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

import { createHash } from 'node:crypto';
import type { ArgoNotification, ArgoScope } from './argo-notification.ts';
import { parseArgoNotification } from './argo-notification.ts';
import { AdapterError, instant, timestamp } from './value.ts';

interface ArchiveBase {
  contract: 'clio.argocd.archive.v1';
  source_id: string;
  producer_id: string;
  journal_id: string;
  policy_reference: string;
  startup_at: string;
  digest: string;
  evidence_ref: string;
}
export interface ArchiveEntry extends ArchiveBase {
  kind: 'entry';
  sequence: number;
  previous_digest: string;
  captured_at: string;
  /** Envelope integrity does not establish native payload eligibility. */
  notification: unknown;
}
export interface ArchiveSeal extends ArchiveBase {
  kind: 'seal';
  seal_id: string;
  start: string;
  end: string;
  first_sequence: number;
  last_sequence: number;
  entry_count: number;
  last_digest: string;
  interruptions: { start: string; end: string; reason: string }[];
}
export type ArchiveRecord = ArchiveEntry | ArchiveSeal;

const genesis = '0'.repeat(64);
const commonKeys = [
  'contract',
  'source_id',
  'producer_id',
  'journal_id',
  'policy_reference',
  'startup_at',
  'digest',
  'evidence_ref',
];
function fail(): never {
  throw new AdapterError('invalid_argo_archive');
}
function row(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail();
  return Object.fromEntries(Object.entries(input));
}
function keys(input: Record<string, unknown>, expected: readonly string[]): void {
  if (
    Object.keys(input).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(input, key))
  )
    fail();
}
/** Reject non-JSON values rather than silently omitting or coercing signed content. */
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (value.includes('\u0000') || !value.isWellFormed()) fail();
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail();
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) fail();
  ancestors.add(value);
  let result: string;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail();
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) fail();
      items.push(canonical(value[index], ancestors));
    }
    result = `[${items.join(',')}]`;
  } else {
    const fields = row(value);
    if (Reflect.ownKeys(value).length !== Object.keys(fields).length) fail();
    result = `{${Object.keys(fields)
      .sort()
      .map((key) => `${canonical(key, ancestors)}:${canonical(fields[key], ancestors)}`)
      .join(',')}}`;
  }
  ancestors.delete(value);
  return result;
}
/** SHA-256 of recursive lexically sorted JSON; exclude only the envelope digest. */
export function archiveRecordDigest(value: unknown): string {
  try {
    const fields = row(value);
    delete fields.digest;
    return createHash('sha256').update(canonical(fields), 'utf8').digest('hex');
  } catch {
    return fail();
  }
}
function ref(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > 200) fail();
  return value;
}
function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  )
    fail();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail();
  return value;
}
function utc(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  )
    fail();
  // Retain original fractional spelling: it is part of the signed envelope.
  return timestamp(value);
}

/** Pure wire validation. Receiver time, grant scope and journal prefix require server admission. */
export function parseArchiveRecord(value: unknown): ArchiveRecord {
  try {
    const serialized = canonical(value);
    if (Buffer.byteLength(serialized, 'utf8') > 65536) fail();
    const input = row(value);
    if (input.contract !== 'clio.argocd.archive.v1') fail();
    const base: ArchiveBase = {
      contract: 'clio.argocd.archive.v1',
      source_id: uuid(input.source_id),
      producer_id: uuid(input.producer_id),
      journal_id: uuid(input.journal_id),
      policy_reference: ref(input.policy_reference),
      startup_at: utc(input.startup_at),
      digest: hash(input.digest),
      evidence_ref: ref(input.evidence_ref),
    };
    if (archiveRecordDigest(input) !== base.digest) fail();
    if (input.kind === 'entry') {
      keys(input, [
        ...commonKeys,
        'kind',
        'sequence',
        'previous_digest',
        'captured_at',
        'notification',
      ]);
      const sequence = integer(input.sequence, 1);
      const previous_digest = hash(input.previous_digest);
      const captured_at = utc(input.captured_at);
      if (instant(captured_at) < instant(base.startup_at)) fail();
      if (sequence === 1 && previous_digest !== genesis) fail();
      const notification: unknown = JSON.parse(canonical(input.notification));
      return Object.freeze({
        ...base,
        kind: 'entry',
        sequence,
        previous_digest,
        captured_at,
        notification,
      });
    }
    if (input.kind !== 'seal') fail();
    keys(input, [
      ...commonKeys,
      'kind',
      'seal_id',
      'start',
      'end',
      'first_sequence',
      'last_sequence',
      'entry_count',
      'last_digest',
      'interruptions',
    ]);
    const start = utc(input.start);
    const end = utc(input.end);
    const first_sequence = integer(input.first_sequence, 1);
    const last_sequence = integer(input.last_sequence, 0);
    const entry_count = integer(input.entry_count, 0);
    const last_digest = hash(input.last_digest);
    if (instant(start) < instant(base.startup_at) || instant(start) >= instant(end)) fail();
    if (BigInt(last_sequence) - BigInt(first_sequence) + 1n !== BigInt(entry_count)) fail();
    if (last_sequence === 0 && last_digest !== genesis) fail();
    if (!Array.isArray(input.interruptions) || input.interruptions.length > 32) fail();
    const interruptions = input.interruptions.map((value: unknown) => {
      const interval = row(value);
      keys(interval, ['start', 'end', 'reason']);
      const intervalStart = utc(interval.start);
      const intervalEnd = utc(interval.end);
      if (
        instant(intervalStart) < instant(start) ||
        instant(intervalEnd) > instant(end) ||
        instant(intervalStart) >= instant(intervalEnd)
      )
        fail();
      return Object.freeze({
        start: intervalStart,
        end: intervalEnd,
        reason: ref(interval.reason),
      });
    });
    for (let index = 1; index < interruptions.length; index++) {
      const previous = interruptions[index - 1],
        current = interruptions[index];
      if (!previous || !current || instant(current.start) < instant(previous.end)) fail();
    }
    return Object.freeze({
      ...base,
      kind: 'seal',
      seal_id: uuid(input.seal_id),
      start,
      end,
      first_sequence,
      last_sequence,
      entry_count,
      last_digest,
      interruptions,
    });
  } catch {
    return fail();
  }
}

/** Original capture checks native eligibility; actual receiver time controls OEMS availability. */
export function parseHistoricalArgoNotification(
  input: unknown,
  scope: ArgoScope,
  capturedAt: string,
  receivedAt: string,
): ArgoNotification {
  const capture = utc(capturedAt);
  const receipt = utc(receivedAt);
  if (instant(capture) > instant(receipt)) throw new AdapterError('argo_archive_future_capture');
  const original = parseArgoNotification(input, scope, capture);
  if (original.kind === 'gap') return original;
  return Object.freeze({
    ...original,
    evidence: {
      ...original.evidence,
      deployments: original.evidence.deployments.map((deployment) => ({
        ...deployment,
        observedAt: receipt,
      })),
      statuses: original.evidence.statuses.map((status) => ({ ...status, observedAt: receipt })),
    },
  });
}

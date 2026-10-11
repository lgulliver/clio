import type { MeasurementBasis } from '@clio/adapters';
import { oemsContract } from '@clio/oems';
import { positive, text, timestamp, windowInput } from '../github-collection/input.ts';
import { IdentityError, object, uuid } from '../identity/input.ts';
import { provider } from './source-eligibility.ts';

export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = object(value, keys);
  if (Object.keys(row).length !== keys.length) throw new IdentityError(400, 'invalid_request');
  return row;
}
export function hash(value: unknown): string {
  const h = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(h)) throw new Error('Invalid measurement digest');
  return h;
}
export function parseBasis(value: unknown): MeasurementBasis {
  const row = exact(value, [
    'provider',
    'runId',
    'sourceId',
    'connectionRevision',
    'oemsRevision',
    'snapshotDigest',
    'evidenceDigest',
    'gapManifestDigest',
  ]);
  if (row.oemsRevision !== oemsContract.revision) throw new Error('Invalid measurement pin');
  return {
    provider: provider(row.provider),
    runId: uuid(row.runId),
    sourceId: text(row.sourceId, 4096),
    connectionRevision: positive(row.connectionRevision),
    oemsRevision: oemsContract.revision,
    snapshotDigest: hash(row.snapshotDigest),
    evidenceDigest: hash(row.evidenceDigest),
    gapManifestDigest: hash(row.gapManifestDigest),
  };
}
export function producerIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4) throw new IdentityError(400, 'invalid_request');
  const ids = value.map(uuid).sort();
  if (new Set(ids).size !== ids.length) throw new IdentityError(400, 'invalid_request');
  return ids;
}
export function enqueueInput(value: unknown) {
  const row = exact(value, ['requestId', 'provider', 'basisRunId', 'producerIds']);
  return {
    requestId: uuid(row.requestId),
    provider: provider(row.provider),
    basisRunId: uuid(row.basisRunId),
    producerIds: producerIds(row.producerIds),
  };
}
export interface MeasurementJobInput {
  version: 1;
  workspaceId: string;
  serviceId: string;
  basis: MeasurementBasis;
  sourceScope: string;
  nativeFingerprint: string;
  window: ReturnType<typeof windowInput>;
  producerPins: { producerId: string; fingerprint: string; scopeDigest: string }[];
  receipts: { id: string; digest: string; producerId: string }[];
}
export function parseJobInput(value: unknown): MeasurementJobInput {
  const row = exact(value, [
    'version',
    'workspaceId',
    'serviceId',
    'basis',
    'sourceScope',
    'nativeFingerprint',
    'window',
    'producerPins',
    'receipts',
  ]);
  if (
    row.version !== 1 ||
    !Array.isArray(row.producerPins) ||
    row.producerPins.length > 4 ||
    !Array.isArray(row.receipts) ||
    row.receipts.length > 4
  )
    throw new Error('Invalid measurement input');
  const pins = row.producerPins.map((input: unknown) => {
    const p = exact(input, ['producerId', 'fingerprint', 'scopeDigest']);
    return {
      producerId: uuid(p.producerId),
      fingerprint: hash(p.fingerprint),
      scopeDigest: hash(p.scopeDigest),
    };
  });
  const receipts = row.receipts.map((input: unknown) => {
    const r = exact(input, ['id', 'digest', 'producerId']);
    return { id: uuid(r.id), digest: hash(r.digest), producerId: uuid(r.producerId) };
  });
  if (
    new Set(pins.map((p) => p.producerId)).size !== pins.length ||
    new Set(receipts.map((r) => r.id)).size !== receipts.length ||
    new Set(receipts.map((r) => r.producerId)).size !== receipts.length ||
    receipts.some((r) => !pins.some((p) => p.producerId === r.producerId))
  )
    throw new Error('Invalid measurement selection');
  const w = exact(row.window, ['start', 'end', 'timezone', 'calendarDays']);
  const window = windowInput({ start: w.start, end: w.end });
  if (w.timezone !== 'UTC' || w.calendarDays !== window.calendarDays)
    throw new Error('Invalid measurement window');
  return {
    version: 1,
    workspaceId: uuid(row.workspaceId),
    serviceId: uuid(row.serviceId),
    basis: parseBasis(row.basis),
    sourceScope: text(row.sourceScope, 4096),
    nativeFingerprint: hash(row.nativeFingerprint),
    window,
    producerPins: pins,
    receipts,
  };
}
export function historyCursor(value: unknown): { createdAt: string; id: string } | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new IdentityError(400, 'invalid_request');
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== value) throw new Error('Invalid cursor');
    const row = exact(JSON.parse(decoded), ['createdAt', 'id']);
    return { createdAt: timestamp(row.createdAt), id: uuid(row.id) };
  } catch {
    throw new IdentityError(400, 'invalid_request');
  }
}
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
}

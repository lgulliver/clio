import { IdentityError, object, uuid } from '../identity/input.ts';
import type { CollectionRequest, MappingRequest, OperationWindow } from './contract.ts';

function invalid(): never {
  throw new IdentityError(400, 'invalid_request');
}
export function instantMicros(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match?.[1]) invalid();
  const base = `${match[1]}.000Z`;
  const millis = Date.parse(base);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== base) invalid();
  return BigInt(millis) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}
export function parseWindow(value: unknown, now?: Date): OperationWindow {
  const body = object(value, ['windowStart', 'windowEnd']);
  const start = body.windowStart,
    end = body.windowEnd;
  if (
    typeof start !== 'string' ||
    typeof end !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(end)
  )
    invalid();
  const s = instantMicros(start),
    e = instantMicros(end);
  if (s >= e || e - s > 90n * 86400000000n) invalid();
  if (now) {
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    if (!Number.isFinite(today.getTime()) || e > BigInt(today.getTime()) * 1000n) invalid();
  }
  return { windowStart: start, windowEnd: end };
}
export function parseCollectionRequest(value: unknown, now = new Date()): CollectionRequest {
  const body = object(value, ['revision', 'requestId', 'windowStart', 'windowEnd']);
  return {
    ...parseWindow({ windowStart: body.windowStart, windowEnd: body.windowEnd }, now),
    requestId: uuid(body.requestId),
    revision: positive(body.revision),
  };
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}
export function parseMappingRequest(value: unknown): MappingRequest {
  const body = object(value, ['installationId', 'repositoryId', 'teamId']);
  return {
    installationId: positive(body.installationId),
    repositoryId: positive(body.repositoryId),
    teamId: uuid(body.teamId),
  };
}
export function parsePageQuery(value: unknown): { teamId?: string; cursor?: string } {
  const body = object(value, ['teamId', 'cursor']);
  if (
    body.cursor !== undefined &&
    (typeof body.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(body.cursor))
  )
    invalid();
  return {
    ...(body.teamId === undefined ? {} : { teamId: uuid(body.teamId) }),
    ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
  };
}

export function parseDisconnectRequest(value: unknown): { revision: number } {
  const body = object(value, ['revision']);
  return { revision: positive(body.revision) };
}
export function parseMappingUpdateRequest(value: unknown): { revision: number; teamId: string } {
  const body = object(value, ['revision', 'teamId']);
  return { revision: positive(body.revision), teamId: uuid(body.teamId) };
}

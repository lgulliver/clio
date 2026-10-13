import { IdentityError, object, uuid } from '../identity/input.ts';
import type { NotificationChannel, NotificationPolicy, OwnNotification } from './contract.ts';

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new IdentityError(400, 'invalid_request');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new IdentityError(400, 'invalid_request');
  return value;
}
export function parsePolicyInput(input: unknown): NotificationPolicy {
  const row = object(input, [
    'revision',
    'enabled',
    'invitations',
    'closures',
    'reminders',
    'firstReminderHours',
    'repeatHours',
    'maximumReminders',
  ]);
  return {
    revision: integer(row.revision, 0, 2147483646),
    enabled: boolean(row.enabled),
    invitations: boolean(row.invitations),
    closures: boolean(row.closures),
    reminders: boolean(row.reminders),
    firstReminderHours: integer(row.firstReminderHours, 24, 168),
    repeatHours: integer(row.repeatHours, 24, 168),
    maximumReminders: integer(row.maximumReminders, 1, 3),
  };
}
export function parseRevisionInput(input: unknown): { revision: number } {
  return { revision: integer(object(input, ['revision']).revision, 0, 2147483646) };
}
function batchFields(row: Record<string, unknown>): {
  requestId: string;
  revision: number;
  confirm: true;
} {
  if (row.confirm !== true) throw new IdentityError(400, 'invalid_request');
  return {
    requestId: uuid(row.requestId),
    revision: integer(row.revision, 0, 2147483646),
    confirm: true,
  };
}
export function parseReminderInput(input: unknown) {
  return batchFields(object(input, ['requestId', 'revision', 'confirm']));
}
export function parseRetryInput(input: unknown) {
  const row = object(input, ['requestId', 'revision', 'confirm', 'confirmUncertain']);
  return {
    ...batchFields(row),
    confirmUncertain: row.confirmUncertain === undefined ? false : boolean(row.confirmUncertain),
  };
}
export function parseTestInput(
  input: unknown,
): ReturnType<typeof parseReminderInput> & { channel: NotificationChannel } {
  const row = object(input, ['requestId', 'revision', 'confirm', 'channel']);
  if (row.channel !== 'slack' && row.channel !== 'email')
    throw new IdentityError(400, 'invalid_request');
  return { ...batchFields(row), channel: row.channel };
}
export function parseHistoryQuery(input: unknown): { cursor: string | null } {
  const row = object(input, ['cursor']);
  if (row.cursor === undefined) return { cursor: null };
  if (
    typeof row.cursor !== 'string' ||
    row.cursor.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/.test(row.cursor)
  )
    throw new IdentityError(400, 'invalid_request');
  return { cursor: row.cursor };
}
export function parseOwnNotification(row: Record<string, unknown>): OwnNotification {
  try {
    if (
      row.kind !== 'invitation' &&
      row.kind !== 'reminder' &&
      row.kind !== 'closure' &&
      row.kind !== 'test'
    )
      throw new Error();
    if (
      row.state !== 'pending' &&
      row.state !== 'leased' &&
      row.state !== 'retry_scheduled' &&
      row.state !== 'provider_accepted' &&
      row.state !== 'skipped' &&
      row.state !== 'failed' &&
      row.state !== 'uncertain'
    )
      throw new Error();
    if (row.channel !== null && row.channel !== 'slack' && row.channel !== 'email')
      throw new Error();
    if (
      row.channel === null &&
      (row.kind === 'test' || row.state === 'uncertain' || row.state === 'provider_accepted')
    )
      throw new Error();
    if (!(row.created_at instanceof Date) || !(row.updated_at instanceof Date)) throw new Error();
    if ((row.kind === 'test') !== (row.pulse_id === null)) throw new Error();
    if (row.updated_at.getTime() < row.created_at.getTime()) throw new Error();
    return {
      id: uuid(row.id),
      pulseId: row.pulse_id === null ? null : uuid(row.pulse_id),
      kind: row.kind,
      state: row.state,
      channel: row.channel,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  } catch {
    throw new IdentityError(500, 'invalid_notification_record');
  }
}

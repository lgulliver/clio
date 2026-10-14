import { ApiError, errorMessage, record } from '../identity/api';

// Public notification contracts. Every reply is parsed from unknown with exact keys and the
// expected workspace/pulse; anything else is an unverifiable response (ApiError status 0).

export type NotificationKind = 'invitation' | 'reminder' | 'closure' | 'test';
export type NotificationState =
  | 'pending'
  | 'leased'
  | 'retry_scheduled'
  | 'provider_accepted'
  | 'skipped'
  | 'failed'
  | 'uncertain';
export type NotificationChannel = 'slack' | 'email';

export type NotificationAvailability = Readonly<{
  workspaceId: string;
  emailConfigured: boolean;
  slackConfigured: boolean;
  linkingConfigured: boolean;
}>;
export type NotificationPolicy = Readonly<{
  revision: number;
  enabled: boolean;
  invitations: boolean;
  closures: boolean;
  reminders: boolean;
  firstReminderHours: number;
  repeatHours: number;
  maximumReminders: number;
}>;
export type OwnSlackLink = Readonly<{ linked: boolean; revision: number; linkedAt: string | null }>;
export type OwnNotification = Readonly<{
  id: string;
  pulseId: string | null;
  kind: NotificationKind;
  state: NotificationState;
  channel: NotificationChannel | null;
  createdAt: string;
  updatedAt: string;
}>;
export type OwnNotificationPage = Readonly<{
  workspaceId: string;
  items: readonly OwnNotification[];
  nextCursor: string | null;
}>;
export type DeliverySummary = Readonly<{
  workspaceId: string;
  pulseId: string;
  counts: Readonly<Record<NotificationState, number>>;
  remindersEnabled: boolean;
  revision: number;
}>;
export type NotificationBatch = Readonly<{ requestId: string; queued: boolean }>;

export const notificationStates: readonly NotificationState[] = [
  'pending',
  'leased',
  'retry_scheduled',
  'provider_accepted',
  'skipped',
  'failed',
  'uncertain',
];
const kinds: readonly NotificationKind[] = ['invitation', 'reminder', 'closure', 'test'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const cursorPattern = /^[A-Za-z0-9_-]{1,2048}$/;
const maxRevision = 2147483646;
/** Rows a history page may carry; a full page is the only one with a continuation cursor. */
export const historyPageSize = 25;

function invalid(): never {
  throw new ApiError(0);
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = record(value);
  const present = Object.keys(row);
  if (present.length !== keys.length || present.some((key) => !keys.includes(key))) invalid();
  return row;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) invalid();
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    invalid();
  return value;
}
function instant(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !instantPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid();
  return value;
}
function state(value: unknown): NotificationState {
  const found = notificationStates.find((item) => item === value);
  if (!found) invalid();
  return found;
}

export function parseNotificationAvailability(
  value: unknown,
  scope: { workspaceId: string },
): NotificationAvailability {
  const row = exact(value, [
    'workspaceId',
    'emailConfigured',
    'slackConfigured',
    'linkingConfigured',
  ]);
  if (row.workspaceId !== scope.workspaceId) invalid();
  const slackConfigured = flag(row.slackConfigured);
  const linkingConfigured = flag(row.linkingConfigured);
  // Slack linking exists only for a Slack-capable workspace.
  if (linkingConfigured && !slackConfigured) invalid();
  return {
    workspaceId: scope.workspaceId,
    emailConfigured: flag(row.emailConfigured),
    slackConfigured,
    linkingConfigured,
  };
}

function policy(value: unknown): NotificationPolicy {
  const row = exact(value, [
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
    revision: integer(row.revision, 0, maxRevision),
    enabled: flag(row.enabled),
    invitations: flag(row.invitations),
    closures: flag(row.closures),
    reminders: flag(row.reminders),
    firstReminderHours: integer(row.firstReminderHours, 24, 168),
    repeatHours: integer(row.repeatHours, 24, 168),
    maximumReminders: integer(row.maximumReminders, 1, 3),
  };
}
export function parseNotificationPolicy(value: unknown): NotificationPolicy {
  return policy(exact(value, ['policy']).policy);
}

export function parseOwnSlackLink(value: unknown): OwnSlackLink {
  const row = exact(exact(value, ['link']).link, ['linked', 'revision', 'linkedAt']);
  const linked = flag(row.linked);
  const linkedAt = row.linkedAt === null ? null : instant(row.linkedAt);
  if (linked !== (linkedAt !== null)) invalid();
  return { linked, revision: integer(row.revision, 0, maxRevision), linkedAt };
}

function ownNotification(value: unknown): OwnNotification {
  const row = exact(value, ['id', 'pulseId', 'kind', 'state', 'channel', 'createdAt', 'updatedAt']);
  const kind = kinds.find((item) => item === row.kind);
  if (!kind) invalid();
  const current = state(row.state);
  const channel =
    row.channel === null
      ? null
      : row.channel === 'slack' || row.channel === 'email'
        ? row.channel
        : invalid();
  const pulseId = row.pulseId === null ? null : uuid(row.pulseId);
  const createdAt = instant(row.createdAt);
  const updatedAt = instant(row.updatedAt);
  if (
    // A test has no pulse; every other kind names one. An accepted or unknown submission always
    // went through one channel.
    (kind === 'test') !== (pulseId === null) ||
    (channel === null &&
      (kind === 'test' || current === 'uncertain' || current === 'provider_accepted')) ||
    Date.parse(updatedAt) < Date.parse(createdAt)
  )
    invalid();
  return { id: uuid(row.id), pulseId, kind, state: current, channel, createdAt, updatedAt };
}

export function parseOwnNotificationPage(
  value: unknown,
  scope: { workspaceId: string; cursor?: string },
): OwnNotificationPage {
  const row = exact(value, ['workspaceId', 'items', 'nextCursor']);
  if (
    row.workspaceId !== scope.workspaceId ||
    !Array.isArray(row.items) ||
    row.items.length > historyPageSize
  )
    invalid();
  const items = row.items.map(ownNotification);
  if (new Set(items.map((item) => item.id)).size !== items.length) invalid();
  const nextCursor = row.nextCursor;
  if (nextCursor !== null) {
    // A continuation exists only after a full page and is never the cursor just used.
    if (
      typeof nextCursor !== 'string' ||
      !cursorPattern.test(nextCursor) ||
      items.length !== historyPageSize ||
      nextCursor === scope.cursor
    )
      invalid();
  }
  return { workspaceId: scope.workspaceId, items, nextCursor };
}

export function parseDeliverySummary(
  value: unknown,
  scope: { workspaceId: string; pulseId: string },
): DeliverySummary {
  const row = exact(value, ['workspaceId', 'pulseId', 'counts', 'remindersEnabled', 'revision']);
  if (row.workspaceId !== scope.workspaceId || row.pulseId !== scope.pulseId) invalid();
  const counts = exact(row.counts, notificationStates);
  const parsed = {
    pending: integer(counts.pending, 0, Number.MAX_SAFE_INTEGER),
    leased: integer(counts.leased, 0, Number.MAX_SAFE_INTEGER),
    retry_scheduled: integer(counts.retry_scheduled, 0, Number.MAX_SAFE_INTEGER),
    provider_accepted: integer(counts.provider_accepted, 0, Number.MAX_SAFE_INTEGER),
    skipped: integer(counts.skipped, 0, Number.MAX_SAFE_INTEGER),
    failed: integer(counts.failed, 0, Number.MAX_SAFE_INTEGER),
    uncertain: integer(counts.uncertain, 0, Number.MAX_SAFE_INTEGER),
  } satisfies Record<NotificationState, number>;
  return {
    workspaceId: scope.workspaceId,
    pulseId: scope.pulseId,
    counts: parsed,
    remindersEnabled: flag(row.remindersEnabled),
    revision: integer(row.revision, 0, maxRevision),
  };
}

export function parseNotificationBatch(value: unknown): NotificationBatch {
  const row = exact(value, ['requestId', 'queued']);
  return { requestId: uuid(row.requestId), queued: flag(row.queued) };
}

/** Only the fixed Slack OpenID authorization endpoint may be navigated to. */
export function parseSlackAuthorizeUrl(value: unknown): string {
  const row = exact(value, ['authorizeUrl']);
  if (typeof row.authorizeUrl !== 'string') invalid();
  try {
    const url = new URL(row.authorizeUrl);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'slack.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/openid/connect/authorize' ||
      url.hash
    )
      invalid();
    return url.href;
  } catch {
    return invalid();
  }
}

export const rateLimitedText =
  'Notifications are temporarily rate limited. Wait a while before trying again.';

/** Fixed safe text; provider bodies and delays are never shown or promised. */
export function notificationError(error: unknown): string {
  return error instanceof ApiError && error.status === 429 ? rateLimitedText : errorMessage(error);
}

/**
 * A write whose outcome the browser cannot know: no reply or transport failure, an unverifiable
 * reply or a server error. The same request identity must be reused so a repeat replays instead of sending again.
 */
export function unknownOutcome(error: unknown): boolean {
  // A rejected fetch (network failure, TypeError) never reaches ApiError: the request may still
  // have been processed, so anything that is not a definite client-side refusal is unknown.
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function historyPath(basePath: string, cursor: string | undefined): string {
  return `${basePath}/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
}

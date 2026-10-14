import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.ts';
import {
  type NotificationConfig,
  type NotificationGrant,
  notificationGrant,
  smtpPacingKey,
} from './config.ts';
import type {
  DispatchResult,
  NoticeMessage,
  NotificationChannel,
  NotificationKind,
} from './contract.ts';

/**
 * Durable, fenced notification job storage. Every state write is conditioned on the current lease
 * token. No provider call happens here and no database lock is held while callers use a provider.
 * Lock order is always workspace → event → attempt (→ pacing budget). Provider payloads, message
 * text and raw responses are never stored.
 *
 * Authority: every operation that decides whether a recipient/provider operation may happen
 * re-reads the private operator configuration (`read`, local file IO only) **after** the workspace
 * lock is held, and compares the stable scope fingerprint. Credentials are pinned by their HMAC.
 */

export const leaseSeconds = 120;
export const maximumTransportAttempts = 3;
/** Ten-second network deadline plus a two-second margin must fit in the remaining lease. */
const networkHeadroomMs = 12_000;
/** DM opening plus the begin transaction must fit in the remaining lease. */
const minimumOpenMs = 15_000;
/** A message submission needs at least this much lease left, or it is deferred uncharged. */
const minimumSendMs = 3_000;
const maximumBackoffMs = 15 * 60_000;
const maximumProviderCooldownMs = 24 * 60 * 60_000;
/** An older failed/uncertain notice for the same member blocks this younger reminder. */
const blockedDelayMs = 5 * 60_000;
/** Unreadable/absent operator configuration fails closed; retry later. */
const unreadableDelayMs = 60_000;
/** Provider pacing hold = call window + configured spacing; shortened early by the holder. */
const defaultCallWindowMs = 15_000;
/** The call must finish this long before its provider hold (call window) ends. */
const holdSafetyMs = 2_000;
/** ...and this long before the lease ends. */
const leaseSafetyMs = 3_000;
/** Dispatch is refused (never attempted) when less than this authorized time remains. */
export const minimumDispatchMs = 2_000;
const slackSpacingMs = 1000;
/** A started marker whose event is no longer leased is abandoned after this age. */
const abandonedMarkerMinutes = 5;

export type Read = () => Promise<NotificationConfig | null>;
export type NotificationLease = Readonly<{ id: string; workspaceId: string; token: string }>;
export type FailureReason =
  | 'recipient_unavailable'
  | 'provider_unavailable'
  | 'configuration_invalid';
export type SkipReason =
  | 'expired'
  | 'access_removed'
  | 'pulse_inactive'
  | 'response_received'
  | 'reminders_disabled'
  | 'integration_disabled'
  | 'no_destination';
export type SlackRoute = Readonly<{
  channel: 'slack';
  teamId: string;
  slackUserId: string;
  bindingRevision: number;
}>;
export type EmailRoute = Readonly<{ channel: 'email'; email: string }>;
export type Route = SlackRoute | EmailRoute;
export type Prepared =
  | Readonly<{ action: 'done' }>
  | Readonly<{
      action: 'send';
      route: Route;
      kind: NotificationKind;
      pulseId: string | null;
    }>;
/** Result of a pre-DM-open check: proceed, wait (cooldown) or stop (event already settled). */
export type Preflight =
  | Readonly<{ action: 'done' }>
  | Readonly<{ action: 'wait'; waitMs: number }>
  | Readonly<{
      action: 'ready';
      /** Monotonic (`performance.now()`) instant before which the DM open must finish. */
      notAfter: number;
      grant: NotificationGrant;
      config: NotificationConfig;
    }>;
type Pacing =
  | Readonly<{ kind: 'slack'; teamId: string; spacingMs: number }>
  | Readonly<{ kind: 'smtp'; key: string; spacingMs: number }>;
export type Started = Readonly<{
  action: 'started';
  attemptId: string;
  /**
   * Monotonic (`performance.now()`) instant by which the provider call must be complete. Anchored
   * before the final database statement so commit latency counts, and bounded by the DB-clock
   * hold window and lease; the worker re-checks it immediately before dispatch.
   */
  notAfter: number;
  grant: NotificationGrant;
  config: NotificationConfig;
  message: NoticeMessage;
  pacing: Pacing;
  hold: string;
}>;
export type Begin =
  | Readonly<{ action: 'done' }>
  | Readonly<{ action: 'cancelled' }>
  | Readonly<{ action: 'wait'; waitMs: number }>
  | Started;

type Row = Record<string, unknown>;
function bad(): never {
  throw new Error('Invalid notification job record');
}
function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') return bad();
  return value;
}
function textOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') return bad();
  return value;
}
function flag(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') return bad();
  return value;
}
function count(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return bad();
  return value;
}
function startedAt(row: Row): number {
  const value = row.started_at;
  if (!(value instanceof Date)) return bad();
  return value.getTime();
}
function channelOrNull(value: string | null): NotificationChannel | null {
  if (value === null || value === 'slack' || value === 'email') return value;
  return bad();
}
function kindOf(value: string): NotificationKind {
  if (value === 'invitation' || value === 'reminder' || value === 'closure' || value === 'test')
    return value;
  return bad();
}
function failureReason(value: string | null): FailureReason {
  return value === 'provider_unavailable' || value === 'configuration_invalid'
    ? value
    : 'recipient_unavailable';
}

/** Exponential backoff capped at 15 minutes; a provider cooldown may lengthen (never shorten) it. */
export function retryDelayMs(attempts: number, retryAfterMs?: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 16);
  const base = Math.min(maximumBackoffMs, 30_000 * 2 ** exponent);
  const cooldown = Math.min(Math.max(retryAfterMs ?? 0, 0), maximumProviderCooldownMs);
  return Math.max(base, cooldown);
}

export type Settlement =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'uncertain' }>
  | Readonly<{ kind: 'retry'; delayMs: number; reason: FailureReason }>
  | Readonly<{ kind: 'fallback'; reason: FailureReason }>
  | Readonly<{ kind: 'failed'; reason: FailureReason }>;

/**
 * Maps one transport result to the next durable event state. `fits` says whether the retry delay
 * stays inside the immutable event deadline. Uncertainty never retries and never falls back.
 */
export function settleDispatch(input: {
  result: DispatchResult;
  channel: NotificationChannel;
  attempts: number;
  fallbackAllowed: boolean;
  fits: boolean;
}): Settlement {
  const { result } = input;
  if (result.outcome === 'accepted') return { kind: 'accepted' };
  if (result.outcome === 'uncertain') return { kind: 'uncertain' };
  if (result.retryable && input.attempts < maximumTransportAttempts && input.fits)
    return {
      kind: 'retry',
      delayMs: retryDelayMs(input.attempts, result.retryAfterMs),
      reason: result.reason,
    };
  if (input.channel === 'slack' && input.fallbackAllowed)
    return { kind: 'fallback', reason: result.reason };
  return { kind: 'failed', reason: result.reason };
}

type EventRow = Readonly<{
  id: string;
  workspaceId: string;
  pulseId: string | null;
  userId: string;
  kind: NotificationKind;
  channel: NotificationChannel | null;
  grantFingerprint: string;
  slackAttempts: number;
  emailAttempts: number;
  uncertainReplays: number;
  reason: string | null;
  expired: boolean;
  leaseMs: number;
}>;
export type Facts = Readonly<{
  member: boolean;
  pulseState: string | null;
  submitted: boolean;
  frozenActive: boolean;
  remindersEnabled: boolean;
  workspaceEnabled: boolean;
  workspaceFingerprint: string | null;
  /** An older unexpired failed/uncertain invitation/reminder exists for the same member/pulse. */
  olderUnresolved: boolean;
  email: string | null;
  bindingRevision: number | null;
  slackUserId: string | null;
}>;

/** Current-context eligibility. Receipts, membership, pulse state and frozen fences decide. */
export function ineligibility(
  event: Pick<EventRow, 'kind' | 'grantFingerprint' | 'expired'>,
  facts: Facts,
  grant: Pick<NotificationGrant, 'fingerprint'> | null,
): SkipReason | null {
  if (event.expired) return 'expired';
  if (!facts.member) return 'access_removed';
  if (event.kind !== 'test') {
    if (event.kind === 'closure') {
      if (facts.pulseState !== 'closed') return 'pulse_inactive';
    } else {
      if (facts.pulseState !== 'open') return 'pulse_inactive';
      if (facts.submitted) return 'response_received';
      if (event.kind === 'reminder' && !facts.remindersEnabled) return 'reminders_disabled';
    }
    if (
      !facts.frozenActive ||
      !facts.workspaceEnabled ||
      facts.workspaceFingerprint !== event.grantFingerprint
    )
      return 'integration_disabled';
  }
  if (!grant || grant.fingerprint !== event.grantFingerprint) return 'integration_disabled';
  return null;
}

export type RouteDecision =
  | Readonly<{ kind: 'send'; route: Route }>
  | Readonly<{ kind: 'end'; state: 'skipped' | 'failed'; reason: SkipReason | FailureReason }>;

/**
 * Slack first, then verified email. A stored channel pins exact-channel work (tests, explicit
 * uncertainty replay) and records that Slack is finished once email is pinned.
 */
export function decideRoute(input: {
  kind: NotificationKind;
  channel: NotificationChannel | null;
  uncertainReplays: number;
  slackAttempts: number;
  emailAttempts: number;
  lastReason: string | null;
  slack: Readonly<{ teamId: string; slackUserId: string; bindingRevision: number }> | null;
  email: string | null;
}): RouteDecision {
  const slack: Route | null =
    input.slack && input.slackAttempts < maximumTransportAttempts
      ? { channel: 'slack', ...input.slack }
      : null;
  const email: Route | null =
    input.email && input.emailAttempts < maximumTransportAttempts
      ? { channel: 'email', email: input.email }
      : null;
  const exact = input.kind === 'test' || input.uncertainReplays > 0;
  const chosen = exact
    ? input.channel === 'slack'
      ? slack
      : input.channel === 'email'
        ? email
        : null
    : input.channel !== 'email' && slack
      ? slack
      : email;
  if (chosen) return { kind: 'send', route: chosen };
  const attempted = input.slackAttempts + input.emailAttempts > 0;
  return attempted
    ? { kind: 'end', state: 'failed', reason: failureReason(input.lastReason) }
    : { kind: 'end', state: 'skipped', reason: 'no_destination' };
}

function sameRoute(a: Route, b: Route): boolean {
  if (a.channel === 'email') return b.channel === 'email' && a.email === b.email;
  return (
    b.channel === 'slack' &&
    a.teamId === b.teamId &&
    a.slackUserId === b.slackUserId &&
    a.bindingRevision === b.bindingRevision
  );
}

type Authority =
  | Readonly<{ kind: 'unreadable' }>
  | Readonly<{ kind: 'current'; config: NotificationConfig; grant: NotificationGrant | null }>;
/** Fresh private-file read; any parse/IO failure or absent file fails closed (no cached fallback). */
async function authority(read: Read, workspaceId: string): Promise<Authority> {
  try {
    const config = await read();
    if (!config) return { kind: 'unreadable' };
    return { kind: 'current', config, grant: notificationGrant(config, workspaceId) };
  } catch {
    return { kind: 'unreadable' };
  }
}

async function lockWorkspace(client: PoolClient, workspaceId: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE', [
    workspaceId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

async function lockLease(client: PoolClient, lease: NotificationLease): Promise<EventRow | null> {
  // Same order as lifecycle hooks and workspace actions: workspace row, then event row.
  if (!(await lockWorkspace(client, lease.workspaceId))) return null;
  const result = await client.query<Row>(
    `SELECT e.id,e.workspace_id,e.pulse_id,e.user_id,e.kind,e.channel,e.grant_fingerprint,e.slack_attempts,e.email_attempts,e.uncertain_replays,e.reason,
      (e.expires_at IS NOT NULL AND e.expires_at<=clock_timestamp()) AS expired,
      (extract(epoch FROM (e.lease_until-clock_timestamp()))*1000)::double precision AS lease_ms
    FROM notification_events e WHERE e.workspace_id=$1 AND e.id=$2 AND e.state='leased' AND e.lease_token=$3 AND e.lease_until>clock_timestamp() FOR UPDATE`,
    [lease.workspaceId, lease.id, lease.token],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: text(row, 'id'),
    workspaceId: text(row, 'workspace_id'),
    pulseId: textOrNull(row, 'pulse_id'),
    userId: text(row, 'user_id'),
    kind: kindOf(text(row, 'kind')),
    channel: channelOrNull(textOrNull(row, 'channel')),
    grantFingerprint: text(row, 'grant_fingerprint'),
    slackAttempts: count(row, 'slack_attempts'),
    emailAttempts: count(row, 'email_attempts'),
    uncertainReplays: count(row, 'uncertain_replays'),
    reason: textOrNull(row, 'reason'),
    expired: flag(row, 'expired'),
    leaseMs: count(row, 'lease_ms'),
  };
}

async function loadFacts(
  client: PoolClient,
  event: EventRow,
  grant: NotificationGrant | null,
): Promise<Facts> {
  // Receipts are the only response fact read; the answers table is never touched here.
  const result = await client.query<Row>(
    `SELECT
      EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=$1 AND m.user_id=$2) AS member,
      (SELECT p.state FROM space_pulses p WHERE p.workspace_id=$1 AND p.id=$3::uuid) AS pulse_state,
      EXISTS(SELECT 1 FROM space_receipts s WHERE s.pulse_id=$3::uuid AND s.user_id=$2) AS submitted,
      COALESCE((SELECT f.enabled AND f.cancelled_at IS NULL FROM notification_pulse_policies f WHERE f.workspace_id=$1 AND f.pulse_id=$3::uuid),false) AS frozen_active,
      COALESCE((SELECT f.reminders_enabled FROM notification_pulse_policies f WHERE f.workspace_id=$1 AND f.pulse_id=$3::uuid),false) AS reminders_enabled,
      COALESCE((SELECT n.enabled FROM notification_policies n WHERE n.workspace_id=$1),false) AS workspace_enabled,
      (SELECT n.grant_fingerprint FROM notification_policies n WHERE n.workspace_id=$1) AS workspace_fingerprint,
      ($6::text='reminder' AND EXISTS(SELECT 1 FROM notification_events o JOIN notification_events cur ON cur.workspace_id=$1 AND cur.id=$7::uuid
        WHERE o.workspace_id=$1 AND o.pulse_id=cur.pulse_id AND o.user_id=cur.user_id AND o.id<>cur.id
          AND o.kind IN ('invitation','reminder') AND o.state IN ('failed','uncertain')
          AND (o.expires_at IS NULL OR o.expires_at>clock_timestamp())
          AND (o.created_at,o.id)<(cur.created_at,cur.id))) AS older_unresolved,
      (SELECT u.email FROM auth_users u WHERE u.id=$2 AND u.email_verified AND u.email !~ '[[:cntrl:][:space:]]' AND length(u.email)<=254 AND u.email ~ '^[^@]+@[^@]+\\.[^@]+$') AS email,
      (SELECT b.revision FROM notification_slack_bindings b WHERE b.workspace_id=$1 AND b.user_id=$2 AND b.slack_user_id IS NOT NULL AND b.team_id=$4::text AND b.grant_fingerprint=$5::text) AS binding_revision,
      (SELECT b.slack_user_id FROM notification_slack_bindings b WHERE b.workspace_id=$1 AND b.user_id=$2 AND b.slack_user_id IS NOT NULL AND b.team_id=$4::text AND b.grant_fingerprint=$5::text) AS slack_user_id`,
    [
      event.workspaceId,
      event.userId,
      event.pulseId,
      grant?.slack?.teamId ?? null,
      grant?.fingerprint ?? null,
      event.kind,
      event.id,
    ],
  );
  const row = result.rows[0];
  if (!row) return bad();
  const revision = row.binding_revision;
  return {
    member: flag(row, 'member'),
    pulseState: textOrNull(row, 'pulse_state'),
    submitted: flag(row, 'submitted'),
    frozenActive: flag(row, 'frozen_active'),
    remindersEnabled: flag(row, 'reminders_enabled'),
    workspaceEnabled: flag(row, 'workspace_enabled'),
    workspaceFingerprint: textOrNull(row, 'workspace_fingerprint'),
    olderUnresolved: flag(row, 'older_unresolved'),
    email: grant?.smtp ? textOrNull(row, 'email') : null,
    bindingRevision: typeof revision === 'number' ? revision : null,
    slackUserId: grant?.slack ? textOrNull(row, 'slack_user_id') : null,
  };
}

function routeFor(event: EventRow, facts: Facts, grant: NotificationGrant | null): RouteDecision {
  const slack =
    grant?.slack && facts.bindingRevision !== null && facts.slackUserId !== null
      ? {
          teamId: grant.slack.teamId,
          slackUserId: facts.slackUserId,
          bindingRevision: facts.bindingRevision,
        }
      : null;
  return decideRoute({
    kind: event.kind,
    channel: event.channel,
    uncertainReplays: event.uncertainReplays,
    slackAttempts: event.slackAttempts,
    emailAttempts: event.emailAttempts,
    lastReason: event.reason,
    slack,
    email: facts.email,
  });
}

async function finish(
  client: PoolClient,
  lease: NotificationLease,
  state: 'skipped' | 'failed',
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE notification_events SET state=$4,reason=$5,terminal_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
    WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='leased'`,
    [lease.workspaceId, lease.id, lease.token, state, reason],
  );
}
/** Return a lease uncharged. Past the immutable deadline the event expires instead. */
async function release(
  client: PoolClient,
  lease: NotificationLease,
  delayMs: number,
): Promise<void> {
  await client.query(
    `WITH due AS MATERIALIZED (
      SELECT e.id,(e.expires_at IS NOT NULL AND e.expires_at<=clock_timestamp()+make_interval(secs=>$4::double precision/1000.0)) AS late
      FROM notification_events e WHERE e.workspace_id=$1 AND e.id=$2 AND e.lease_token=$3 AND e.state='leased')
    UPDATE notification_events e SET
      state=CASE WHEN due.late THEN 'skipped' WHEN e.slack_attempts+e.email_attempts=0 THEN 'pending' ELSE 'retry_scheduled' END,
      reason=CASE WHEN due.late THEN 'expired' ELSE e.reason END,
      terminal_at=CASE WHEN due.late THEN clock_timestamp() ELSE NULL END,
      available_at=clock_timestamp()+make_interval(secs=>$4::double precision/1000.0),
      updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
    FROM due WHERE e.id=due.id`,
    [lease.workspaceId, lease.id, lease.token, delayMs],
  );
}

type Gate =
  | Readonly<{ kind: 'stop' }>
  | Readonly<{
      kind: 'go';
      event: EventRow;
      facts: Facts;
      config: NotificationConfig;
      grant: NotificationGrant;
      route: Route;
    }>;
/**
 * Workspace lock → event lock → fresh configuration → every current eligibility fact → route.
 * Anything that is not "go" has already been persisted (skip/fail/defer) under the lease.
 */
async function gate(client: PoolClient, lease: NotificationLease, read: Read): Promise<Gate> {
  const event = await lockLease(client, lease);
  if (!event) return { kind: 'stop' };
  const current = await authority(read, lease.workspaceId);
  if (current.kind === 'unreadable') {
    await release(client, lease, unreadableDelayMs);
    return { kind: 'stop' };
  }
  const facts = await loadFacts(client, event, current.grant);
  const blocked = ineligibility(event, facts, current.grant);
  if (blocked || !current.grant) {
    await finish(client, lease, 'skipped', blocked ?? 'integration_disabled');
    return { kind: 'stop' };
  }
  if (facts.olderUnresolved) {
    // A younger reminder never bypasses an older failed/uncertain notice for the same member.
    await release(client, lease, blockedDelayMs);
    return { kind: 'stop' };
  }
  const decision = routeFor(event, facts, current.grant);
  if (decision.kind === 'end') {
    await finish(client, lease, decision.state, decision.reason);
    return { kind: 'stop' };
  }
  return {
    kind: 'go',
    event,
    facts,
    config: current.config,
    grant: current.grant,
    route: decision.route,
  };
}

async function applySettlement(
  client: PoolClient,
  lease: NotificationLease,
  channel: NotificationChannel,
  settlement: Settlement,
): Promise<void> {
  const key = [lease.workspaceId, lease.id, lease.token];
  switch (settlement.kind) {
    case 'accepted':
      await client.query(
        `UPDATE notification_events SET state='provider_accepted',channel=$4,reason=NULL,terminal_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
        WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='leased'`,
        [...key, channel],
      );
      return;
    case 'uncertain':
      await client.query(
        `UPDATE notification_events SET state='uncertain',channel=$4,reason='acceptance_unknown',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
        WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='leased'`,
        [...key, channel],
      );
      return;
    case 'retry':
      await client.query(
        `UPDATE notification_events SET state='retry_scheduled',channel=$4,reason=$5,available_at=clock_timestamp()+make_interval(secs=>$6::double precision/1000.0),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
        WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='leased'`,
        [...key, channel, settlement.reason, settlement.delayMs],
      );
      return;
    case 'fallback':
      // The pinned email channel records that Slack is finished for this event.
      await client.query(
        `UPDATE notification_events SET state='pending',channel='email',reason=$4,available_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
        WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='leased'`,
        [...key, settlement.reason],
      );
      return;
    case 'failed':
      await client.query(
        `UPDATE notification_events SET state='failed',channel=$4,reason=$5,terminal_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
        WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='leased'`,
        [...key, channel, settlement.reason],
      );
  }
}

async function recordCooldown(
  client: PoolClient,
  teamId: string,
  method: 'conversations.open' | 'chat.postMessage',
  retryAfterMs: number,
): Promise<void> {
  await client.query(
    'INSERT INTO notification_slack_budgets(team_id) VALUES($1) ON CONFLICT DO NOTHING',
    [teamId],
  );
  await client.query(
    `INSERT INTO notification_slack_cooldowns(team_id,method,blocked_until)
    VALUES($1,$2,clock_timestamp()+make_interval(secs=>$3::double precision/1000.0))
    ON CONFLICT(team_id,method) DO UPDATE SET blocked_until=GREATEST(notification_slack_cooldowns.blocked_until,EXCLUDED.blocked_until)`,
    [teamId, method, Math.min(Math.max(retryAfterMs, 0), maximumProviderCooldownMs)],
  );
}

async function fits(
  client: PoolClient,
  lease: NotificationLease,
  delayMs: number,
): Promise<boolean> {
  const result = await client.query<Row>(
    `SELECT (expires_at IS NULL OR expires_at>clock_timestamp()+make_interval(secs=>$3::double precision/1000.0)) AS fits
    FROM notification_events WHERE workspace_id=$1 AND id=$2`,
    [lease.workspaceId, lease.id, delayMs],
  );
  const row = result.rows[0];
  return row ? flag(row, 'fits') : false;
}

async function cooldownMs(
  client: PoolClient,
  teamId: string,
  methods: readonly string[],
): Promise<number> {
  const result = await client.query<Row>(
    `SELECT COALESCE(max(GREATEST(0,extract(epoch FROM (blocked_until-clock_timestamp()))*1000)),0)::double precision AS ms
    FROM notification_slack_cooldowns WHERE team_id=$1 AND method=ANY($2::text[])`,
    [teamId, methods],
  );
  const row = result.rows[0];
  return row ? count(row, 'ms') : 0;
}

type BudgetCheck =
  | Readonly<{ kind: 'free'; pacing: Pacing }>
  | Readonly<{ kind: 'wait'; waitMs: number }>
  | Readonly<{ kind: 'defer'; waitMs: number }>;
export function pacingFor(route: Route, grant: NotificationGrant): Pacing {
  if (route.channel === 'slack')
    return { kind: 'slack', teamId: route.teamId, spacingMs: slackSpacingMs };
  if (!grant.smtp) return bad();
  // Spacing derives from the current configured rate; the key survives password rotation.
  return {
    kind: 'smtp',
    key: smtpPacingKey(grant.smtp),
    spacingMs: Math.ceil(60_000 / grant.smtp.ratePerMinute),
  };
}
function samePacing(a: Pacing, b: Pacing): boolean {
  return a.kind === 'slack'
    ? b.kind === 'slack' && a.teamId === b.teamId
    : b.kind === 'smtp' && a.key === b.key;
}
/**
 * Takes the provider budget row lock (the one place `begin` can block on other workspaces) and
 * reports whether a send may start now. Nothing is written; the caller must revalidate every
 * authority after this lock and only then take the hold (no further blocking statement follows).
 */
async function checkBudget(
  client: PoolClient,
  route: Route,
  grant: NotificationGrant,
  leaseMs: number,
): Promise<BudgetCheck> {
  const pacing = pacingFor(route, grant);
  let budgetMs: number;
  if (pacing.kind === 'slack') {
    await client.query(
      'INSERT INTO notification_slack_budgets(team_id) VALUES($1) ON CONFLICT DO NOTHING',
      [pacing.teamId],
    );
    const budget = await client.query<Row>(
      `SELECT GREATEST(0,extract(epoch FROM (next_send_at-clock_timestamp()))*1000)::double precision AS ms
      FROM notification_slack_budgets WHERE team_id=$1 FOR UPDATE`,
      [pacing.teamId],
    );
    const row = budget.rows[0];
    if (!row) return bad();
    budgetMs = Math.max(
      count(row, 'ms'),
      await cooldownMs(client, pacing.teamId, ['chat.postMessage']),
    );
  } else {
    await client.query(
      'INSERT INTO notification_smtp_budgets(pacing_key) VALUES($1) ON CONFLICT DO NOTHING',
      [pacing.key],
    );
    const budget = await client.query<Row>(
      `SELECT GREATEST(0,extract(epoch FROM (next_send_at-clock_timestamp()))*1000)::double precision AS ms
      FROM notification_smtp_budgets WHERE pacing_key=$1 FOR UPDATE`,
      [pacing.key],
    );
    const row = budget.rows[0];
    if (!row) return bad();
    budgetMs = count(row, 'ms');
  }
  if (budgetMs > 0) {
    const waitMs = Math.ceil(budgetMs);
    return waitMs > leaseMs - networkHeadroomMs
      ? { kind: 'defer', waitMs }
      : { kind: 'wait', waitMs };
  }
  return { kind: 'free', pacing };
}

/**
 * Serialized durable send hold per provider (Slack team / SMTP pacing key): a future
 * `next_send_at` of call window + configured spacing, so even a holder that dies mid-call (at any
 * rate, e.g. 1/min) leaves the full spacing in force. The holder shortens it to completion +
 * spacing. Sampled at this final statement: DB-authoritative window and lease remaining.
 */
async function takeHold(
  client: PoolClient,
  lease: NotificationLease,
  pacing: Pacing,
  callWindowMs: number,
): Promise<{ hold: string; usableMs: number }> {
  const table =
    pacing.kind === 'slack' ? 'notification_slack_budgets' : 'notification_smtp_budgets';
  const column = pacing.kind === 'slack' ? 'team_id' : 'pacing_key';
  const taken = await client.query<Row>(
    `UPDATE ${table} SET next_send_at=clock_timestamp()+make_interval(secs=>$2::double precision/1000.0)
    WHERE ${column}=$1
    RETURNING next_send_at::text AS hold,
      (extract(epoch FROM ((SELECT lease_until FROM notification_events WHERE workspace_id=$3 AND id=$4 AND lease_token=$5 AND state='leased')-clock_timestamp()))*1000)::double precision AS lease_ms`,
    [
      pacing.kind === 'slack' ? pacing.teamId : pacing.key,
      callWindowMs + pacing.spacingMs,
      lease.workspaceId,
      lease.id,
      lease.token,
    ],
  );
  const row = taken.rows[0];
  if (!row) return bad();
  return {
    hold: text(row, 'hold'),
    usableMs: Math.min(callWindowMs - holdSafetyMs, count(row, 'lease_ms') - leaseSafetyMs),
  };
}

/** Shorten our own hold to completion + spacing. Value-fenced: a later holder is never disturbed. */
async function releaseHold(client: PoolClient, started: Started): Promise<void> {
  const { pacing } = started;
  const table =
    pacing.kind === 'slack' ? 'notification_slack_budgets' : 'notification_smtp_budgets';
  const column = pacing.kind === 'slack' ? 'team_id' : 'pacing_key';
  await client.query(
    `UPDATE ${table} SET next_send_at=clock_timestamp()+make_interval(secs=>$3::double precision/1000.0) WHERE ${column}=$1 AND next_send_at=$2::timestamptz`,
    [pacing.kind === 'slack' ? pacing.teamId : pacing.key, started.hold, pacing.spacingMs],
  );
}

/** Thrown before COMMIT so marker, counter and hold roll back; the lease is then released. */
class BeginAbort extends Error {
  readonly cancelled: boolean;
  constructor(cancelled: boolean) {
    super('Notification begin aborted before the marker committed');
    this.cancelled = cancelled;
  }
}

/**
 * Authority after a provider result. Accepted/uncertain facts are always recorded honestly. A
 * known refusal may only drive retry/fallback while the operator configuration is still readable,
 * in the same stable scope and with the same credentials that produced it.
 */
async function postNetwork(
  client: PoolClient,
  lease: NotificationLease,
  event: Readonly<{ kind: string; uncertainReplays: number }>,
  channel: NotificationChannel,
  attempts: number,
  result: DispatchResult,
  used: NotificationGrant,
  read: Read,
): Promise<void> {
  const delay = result.outcome === 'not_accepted' ? retryDelayMs(attempts, result.retryAfterMs) : 0;
  let settlement = settleDispatch({
    result,
    channel,
    attempts,
    fallbackAllowed: event.kind !== 'test' && event.uncertainReplays === 0,
    fits: await fits(client, lease, delay),
  });
  if (
    settlement.kind === 'retry' ||
    settlement.kind === 'fallback' ||
    settlement.kind === 'failed'
  ) {
    const current = await authority(read, lease.workspaceId);
    const reason = result.outcome === 'not_accepted' ? result.reason : 'provider_unavailable';
    if (current.kind === 'unreadable')
      settlement = { kind: 'retry', delayMs: unreadableDelayMs, reason };
    else if (!current.grant || current.grant.fingerprint !== used.fingerprint) {
      await finish(client, lease, 'skipped', 'integration_disabled');
      return;
    } else if (current.grant.credentialFingerprint !== used.credentialFingerprint)
      // The refusal came from superseded credentials: never a basis for retry budget or fallback.
      settlement = { kind: 'retry', delayMs: 0, reason };
  }
  await applySettlement(client, lease, channel, settlement);
}

/** Lease remaining on the database clock, sampled by the caller's final statement. */
async function leaseRemainingMs(client: PoolClient, lease: NotificationLease): Promise<number> {
  const result = await client.query<Row>(
    `SELECT (extract(epoch FROM (lease_until-clock_timestamp()))*1000)::double precision AS ms
    FROM notification_events WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='leased'`,
    [lease.workspaceId, lease.id, lease.token],
  );
  const row = result.rows[0];
  return row ? count(row, 'ms') : 0;
}

export type NotificationJobOptions = Readonly<{
  /** Test seam: provider call window in ms (default 15 000). */
  callWindowMs?: number;
}>;

export function createNotificationJobs(pool: Pool, options: NotificationJobOptions = {}) {
  const callWindowMs = options.callWindowMs ?? defaultCallWindowMs;
  const jobs = {
    /** One logical event under a 120-second database-clock lease; never an unfinished-marker event. */
    async claim(): Promise<NotificationLease | null> {
      return withTransaction(pool, async (client) => {
        const token = randomUUID();
        const result = await client.query<Row>(
          `WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS t),
          next AS (
            SELECT e.id FROM notification_events e,stamp
            WHERE (e.state IN ('pending','retry_scheduled') AND e.available_at<=stamp.t)
              OR (e.state='leased' AND e.lease_until<=stamp.t
                AND NOT EXISTS(SELECT 1 FROM notification_attempts a WHERE a.workspace_id=e.workspace_id AND a.event_id=e.id AND a.outcome IS NULL))
            ORDER BY e.available_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED)
          UPDATE notification_events e SET state='leased',lease_token=$1,lease_until=stamp.t+make_interval(secs=>$2::double precision),updated_at=stamp.t
          FROM next,stamp WHERE e.id=next.id RETURNING e.id,e.workspace_id`,
          [token, leaseSeconds],
        );
        const row = result.rows[0];
        return row ? { id: text(row, 'id'), workspaceId: text(row, 'workspace_id'), token } : null;
      });
    },

    /** Eligibility and routing under the workspace lock; no provider call, no pacing reservation. */
    async prepare(lease: NotificationLease, read: Read): Promise<Prepared> {
      return withTransaction(pool, async (client): Promise<Prepared> => {
        const checked = await gate(client, lease, read);
        if (checked.kind === 'stop') return { action: 'done' };
        return {
          action: 'send',
          route: checked.route,
          kind: checked.event.kind,
          pulseId: checked.event.pulseId,
        };
      });
    },

    /**
     * Fresh pre-DM-open check after any waiting: current configuration, membership, receipts,
     * pulse state, binding revision/ID, lease budget and method cooldowns under the workspace
     * lock. The DM itself is opened afterwards, outside every SQL lock.
     */
    async preflight(
      lease: NotificationLease,
      read: Read,
      expected: SlackRoute,
    ): Promise<Preflight> {
      return withTransaction(pool, async (client): Promise<Preflight> => {
        const checked = await gate(client, lease, read);
        if (checked.kind === 'stop') return { action: 'done' };
        if (!sameRoute(checked.route, expected) || checked.event.leaseMs < minimumOpenMs) {
          await release(client, lease, 0);
          return { action: 'done' };
        }
        const open = await cooldownMs(client, expected.teamId, ['conversations.open']);
        const post = await cooldownMs(client, expected.teamId, ['chat.postMessage']);
        const longest = Math.max(open, post);
        if (longest > checked.event.leaseMs - minimumOpenMs) {
          await release(client, lease, Math.ceil(longest));
          return { action: 'done' };
        }
        if (open > 0) return { action: 'wait', waitMs: Math.ceil(open) };
        // Final statement: the lease is re-sampled after every read/wait above and anchored on the
        // monotonic clock before it is sent, so elapsed time until the DM open is accounted for.
        const anchor = performance.now();
        const remaining = await leaseRemainingMs(client, lease);
        if (remaining < minimumOpenMs) {
          await release(client, lease, 0);
          return { action: 'done' };
        }
        return {
          action: 'ready',
          notAfter: anchor + remaining - leaseSafetyMs,
          grant: checked.grant,
          config: checked.config,
        };
      });
    },

    /**
     * Last check before a message submission, then — atomically — the provider send hold, the
     * attempt-start marker (with scope + credential fingerprints) and the transport counter. If
     * `signal` aborts before COMMIT the whole transaction rolls back: nothing is charged.
     */
    async begin(
      lease: NotificationLease,
      read: Read,
      expected: Route,
      render: (config: NotificationConfig) => NoticeMessage,
      signal?: AbortSignal,
    ): Promise<Begin> {
      try {
        return await withTransaction(pool, async (client): Promise<Begin> => {
          const checked = await gate(client, lease, read);
          if (checked.kind === 'stop') return { action: 'done' };
          const { event, grant, route } = checked;
          // Never retarget an in-flight attempt: a changed destination restarts routing uncharged.
          if (!sameRoute(route, expected) || event.leaseMs < minimumSendMs) {
            await release(client, lease, 0);
            return { action: 'done' };
          }
          // The provider budget row lock is the final blocking lock (other workspaces may hold it).
          const slot = await checkBudget(client, route, grant, event.leaseMs);
          if (slot.kind === 'defer') {
            await release(client, lease, slot.waitMs);
            return { action: 'done' };
          }
          if (slot.kind === 'wait') return { action: 'wait', waitMs: slot.waitMs };
          // Everything that could have changed while blocked is revalidated under all held locks:
          // fresh configuration (removal/rotation), every eligibility fact, route, lease, cooldown.
          const again = await gate(client, lease, read);
          if (again.kind === 'stop') return { action: 'done' };
          // Pacing derives from the *fresh* grant (rate may have changed while blocked); the locked
          // budget row must be the one that fresh grant maps to, and hold/settlement use this value.
          const freshPacing = pacingFor(again.route, again.grant);
          if (
            !sameRoute(again.route, expected) ||
            again.event.leaseMs < minimumSendMs ||
            !samePacing(freshPacing, slot.pacing)
          ) {
            await release(client, lease, 0);
            return { action: 'done' };
          }
          if (again.route.channel === 'slack') {
            const cooled = await cooldownMs(client, again.route.teamId, ['chat.postMessage']);
            if (cooled > 0) {
              if (cooled > again.event.leaseMs - networkHeadroomMs) {
                await release(client, lease, Math.ceil(cooled));
                return { action: 'done' };
              }
              return { action: 'wait', waitMs: Math.ceil(cooled) };
            }
          }
          let message: NoticeMessage;
          try {
            message = render(again.config);
          } catch {
            await release(client, lease, unreadableDelayMs);
            return { action: 'done' };
          }
          const attempts =
            again.route.channel === 'slack' ? again.event.slackAttempts : again.event.emailAttempts;
          const marker = await client.query<Row>(
            `INSERT INTO notification_attempts(workspace_id,event_id,lease_token,channel,attempt_number,grant_fingerprint,credential_fingerprint,binding_revision,slack_team_id,slack_user_id,email)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [
              lease.workspaceId,
              lease.id,
              lease.token,
              again.route.channel,
              attempts + 1,
              again.grant.fingerprint,
              again.grant.credentialFingerprint,
              again.route.channel === 'slack' ? again.route.bindingRevision : null,
              again.route.channel === 'slack' ? again.route.teamId : null,
              again.route.channel === 'slack' ? again.route.slackUserId : null,
              again.route.channel === 'email' ? again.route.email : null,
            ],
          );
          const counter = again.route.channel === 'slack' ? 'slack_attempts' : 'email_attempts';
          await client.query(
            `UPDATE notification_events SET channel=$4,${counter}=${counter}+1,updated_at=clock_timestamp()
            WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='leased'`,
            [lease.workspaceId, lease.id, lease.token, again.route.channel],
          );
          const row = marker.rows[0];
          if (!row) return bad();
          // Final statement: hold + DB-authoritative window. Anchored before it is sent so the
          // statement and COMMIT latency count against the dispatch window.
          const anchor = performance.now();
          const taken = await takeHold(client, lease, freshPacing, callWindowMs);
          if (taken.usableMs < minimumDispatchMs) throw new BeginAbort(false);
          // Cancellation observed before COMMIT rolls marker, counter and hold back together.
          if (signal?.aborted) throw new BeginAbort(true);
          return {
            action: 'started',
            attemptId: text(row, 'id'),
            notAfter: anchor + taken.usableMs,
            grant: again.grant,
            config: again.config,
            message,
            pacing: freshPacing,
            hold: taken.hold,
          };
        });
      } catch (error) {
        if (!(error instanceof BeginAbort)) throw error;
        await jobs.release(lease, 0);
        return error.cancelled ? { action: 'cancelled' } : { action: 'done' };
      }
    },

    /**
     * A definitively failed Slack DM opening: no message exists, so it is a known-safe attempt.
     * `used` is the grant the call was made with; retry/fallback authority is re-checked fresh.
     */
    async openFailed(
      lease: NotificationLease,
      read: Read,
      route: SlackRoute,
      used: NotificationGrant,
      result: Extract<DispatchResult, { outcome: 'not_accepted' }>,
    ): Promise<void> {
      await withTransaction(pool, async (client) => {
        const event = await lockLease(client, lease);
        if (!event) return;
        const attempts = event.slackAttempts + 1;
        await client.query(
          `WITH s AS MATERIALIZED (SELECT clock_timestamp() AS t)
          INSERT INTO notification_attempts(workspace_id,event_id,lease_token,channel,attempt_number,grant_fingerprint,credential_fingerprint,binding_revision,slack_team_id,slack_user_id,started_at,completed_at,outcome,reason,retryable,retry_after_ms)
          SELECT $1,$2,$3,'slack',$4,$5,$6,$7,$8,$9,s.t,s.t,'not_accepted',$10,$11,$12 FROM s`,
          [
            lease.workspaceId,
            lease.id,
            lease.token,
            attempts,
            used.fingerprint,
            used.credentialFingerprint,
            route.bindingRevision,
            route.teamId,
            route.slackUserId,
            result.reason,
            result.retryable,
            result.retryAfterMs === undefined ? null : Math.round(result.retryAfterMs),
          ],
        );
        await client.query(
          `UPDATE notification_events SET channel='slack',slack_attempts=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='leased'`,
          [lease.workspaceId, lease.id, lease.token, attempts],
        );
        if (result.retryAfterMs !== undefined)
          await recordCooldown(client, route.teamId, 'conversations.open', result.retryAfterMs);
        await postNetwork(client, lease, event, 'slack', attempts, result, used, read);
      });
    },

    /**
     * Completes a started attempt (workspace → event → attempt lock order). If lifecycle hooks
     * already turned the event uncertain, the real provider outcome still finalizes the marker
     * (an accepted message is recorded honestly); an invalidated event is never restored to a
     * sendable state, and a stale-authority refusal never drives retry or fallback.
     */
    async settle(
      lease: NotificationLease,
      started: Started,
      route: Route,
      result: DispatchResult,
      read: Read,
    ): Promise<void> {
      await withTransaction(pool, async (client) => {
        if (!(await lockWorkspace(client, lease.workspaceId))) return;
        const current = await client.query<Row>(
          `SELECT state,lease_token,kind,uncertain_replays FROM notification_events WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [lease.workspaceId, lease.id],
        );
        const event = current.rows[0];
        const marker = await client.query<Row>(
          `SELECT attempt_number FROM notification_attempts WHERE id=$1 AND workspace_id=$2 AND event_id=$3 AND lease_token=$4 AND outcome IS NULL FOR UPDATE`,
          [started.attemptId, lease.workspaceId, lease.id, lease.token],
        );
        const attempt = marker.rows[0];
        if (event && attempt) {
          const owned = event.state === 'leased' && event.lease_token === lease.token;
          const attempts = count(attempt, 'attempt_number');
          await client.query(
            `UPDATE notification_attempts SET completed_at=GREATEST(clock_timestamp(),started_at),outcome=$2,reason=$3,retryable=$4,retry_after_ms=$5 WHERE id=$1 AND outcome IS NULL`,
            [
              started.attemptId,
              result.outcome,
              result.outcome === 'accepted'
                ? null
                : result.outcome === 'uncertain'
                  ? 'acceptance_unknown'
                  : result.reason,
              result.outcome === 'not_accepted' ? result.retryable : null,
              result.outcome === 'not_accepted' && result.retryAfterMs !== undefined
                ? Math.round(result.retryAfterMs)
                : null,
            ],
          );
          if (
            route.channel === 'slack' &&
            result.outcome === 'not_accepted' &&
            result.retryAfterMs !== undefined
          )
            await recordCooldown(client, route.teamId, 'chat.postMessage', result.retryAfterMs);
          if (owned)
            await postNetwork(
              client,
              lease,
              { kind: String(event.kind), uncertainReplays: Number(event.uncertain_replays) },
              route.channel,
              attempts,
              result,
              started.grant,
              read,
            );
          else if (event.state === 'uncertain' && result.outcome === 'accepted')
            await client.query(
              `UPDATE notification_events SET state='provider_accepted',channel=$3,reason=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='uncertain'`,
              [lease.workspaceId, lease.id, route.channel],
            );
        }
        await releaseHold(client, started);
      });
    },

    /** Return a lease without charging an attempt (shutdown, stale config, pacing). */
    async release(lease: NotificationLease, delayMs: number): Promise<void> {
      await withTransaction(pool, async (client) => {
        if (!(await lockWorkspace(client, lease.workspaceId))) return;
        await release(client, lease, delayMs);
      });
    },

    /**
     * Expired lease with an unfinished message marker: acceptance is unknown. Never requeued and
     * never retried or delivered through another transport without explicit owner confirmation.
     * Candidates are chosen before any lock; each is then locked workspace → event → attempt.
     */
    async recoverExpired(limit: number): Promise<number> {
      const candidates = await pool.query<Row>(
        `SELECT e.id,e.workspace_id FROM notification_events e
        WHERE e.state='leased' AND e.lease_until<=clock_timestamp()
          AND EXISTS(SELECT 1 FROM notification_attempts a WHERE a.workspace_id=e.workspace_id AND a.event_id=e.id AND a.lease_token=e.lease_token AND a.outcome IS NULL)
        ORDER BY e.lease_until,e.id LIMIT $1`,
        [limit],
      );
      let recovered = 0;
      for (const candidate of candidates.rows) {
        const id = text(candidate, 'id');
        const workspaceId = text(candidate, 'workspace_id');
        recovered += await withTransaction(pool, async (client) => {
          if (!(await lockWorkspace(client, workspaceId))) return 0;
          const locked = await client.query<Row>(
            `SELECT lease_token FROM notification_events WHERE workspace_id=$1 AND id=$2 AND state='leased' AND lease_until<=clock_timestamp() FOR UPDATE`,
            [workspaceId, id],
          );
          const row = locked.rows[0];
          if (!row) return 0;
          const marked = await client.query<Row>(
            `UPDATE notification_attempts SET completed_at=GREATEST(clock_timestamp(),started_at),outcome='uncertain',reason='acceptance_unknown'
            WHERE workspace_id=$1 AND event_id=$2 AND lease_token=$3 AND outcome IS NULL RETURNING channel,started_at`,
            [workspaceId, id, text(row, 'lease_token')],
          );
          const latest = marked.rows.reduce<Row | undefined>(
            (best, row) => (!best || startedAt(row) > startedAt(best) ? row : best),
            undefined,
          );
          if (!latest) return 0;
          await client.query(
            `UPDATE notification_events SET state='uncertain',channel=$3,reason='acceptance_unknown',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
            WHERE workspace_id=$1 AND id=$2 AND state='leased'`,
            [workspaceId, id, text(latest, 'channel')],
          );
          return 1;
        });
      }
      return recovered;
    },

    /**
     * Unfinished markers whose event is no longer leased (a hook made it uncertain/skipped, then
     * the worker was lost) are conservatively completed as uncertain after an upper bound on the
     * original lease, so 30-day retention can later purge them. The logical event, its counters
     * and its deduplication identity are never touched.
     */
    async finalizeAbandoned(limit: number): Promise<number> {
      const candidates = await pool.query<Row>(
        `SELECT a.id,a.workspace_id,a.event_id FROM notification_attempts a
        JOIN notification_events e ON e.workspace_id=a.workspace_id AND e.id=a.event_id
        WHERE a.outcome IS NULL AND e.state<>'leased' AND a.started_at<=clock_timestamp()-make_interval(mins=>$2::integer)
        ORDER BY a.started_at,a.id LIMIT $1`,
        [limit, abandonedMarkerMinutes],
      );
      let finalized = 0;
      for (const candidate of candidates.rows) {
        const workspaceId = text(candidate, 'workspace_id');
        finalized += await withTransaction(pool, async (client) => {
          if (!(await lockWorkspace(client, workspaceId))) return 0;
          const event = await client.query(
            `SELECT 1 FROM notification_events WHERE workspace_id=$1 AND id=$2 AND state<>'leased' FOR UPDATE`,
            [workspaceId, text(candidate, 'event_id')],
          );
          if (!event.rowCount) return 0;
          const done = await client.query(
            `UPDATE notification_attempts SET completed_at=GREATEST(clock_timestamp(),started_at),outcome='uncertain',reason='acceptance_unknown'
            WHERE id=$1 AND workspace_id=$2 AND outcome IS NULL`,
            [text(candidate, 'id'), workspaceId],
          );
          return done.rowCount ?? 0;
        });
      }
      return finalized;
    },
  };
  return jobs;
}
export type NotificationJobs = ReturnType<typeof createNotificationJobs>;

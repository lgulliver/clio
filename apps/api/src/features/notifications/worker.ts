import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';
import { readAuthConfig } from '../identity/config.ts';
import {
  type NotificationConfig,
  type NotificationGrant,
  readNotificationConfig,
} from './config.ts';
import type { DispatchResult, NoticeMessage } from './contract.ts';
import {
  createNotificationJobs,
  minimumDispatchMs,
  type NotificationLease,
  type SlackRoute,
} from './jobs.ts';
import { maintainNotifications } from './maintenance.ts';
import {
  buildPulseLink,
  buildWorkspaceLink,
  createNotificationProvider,
  type NotificationProvider,
  notificationNetworkTimeoutMs,
} from './provider.ts';
import { advanceNotificationSchedule } from './scheduler.ts';
import { renderNotice } from './templates.ts';

export type NotificationDependencies = Readonly<{
  provider?: NotificationProvider;
  signal?: AbortSignal;
  /** Authoritative current configuration. Without it the supplied snapshot is used as-is. */
  configNow?: () => Promise<NotificationConfig | null>;
  /** Test seams only; never set in production. */
  callWindowMs?: number;
  /** Runs after the attempt committed and before dispatch: models a paused process. */
  beforeDispatch?: () => Promise<void>;
  /** Runs after the preflight and before the Slack DM open: models a paused process. */
  beforeOpen?: () => Promise<void>;
}>;

/** A lease returned for a stale configuration or shutdown is retried after this delay. */
const staleConfigDelayMs = 60_000;
/** Waiting workers re-check durable state at least this often (holds are released early). */
const maximumPollMs = 1000;

/**
 * Production configuration authority: re-reads the validated private operator file on every call
 * and requires its fixed origin to equal the trusted application origin. Failure fails closed.
 */
export function createProductionConfigNow(
  env: NodeJS.ProcessEnv,
  read: (env: NodeJS.ProcessEnv) => Promise<NotificationConfig | null> = readNotificationConfig,
): () => Promise<NotificationConfig | null> {
  return async () => {
    const config = await read(env);
    if (!config) return null;
    const auth = readAuthConfig(env);
    if (!auth || auth.appOrigin !== config.publicOrigin)
      throw new Error('Invalid notification configuration');
    return config;
  };
}

class Cancelled extends Error {
  constructor() {
    super('Notification operation cancelled');
  }
}
/** Bound dependencies that ignore cancellation, so a hung provider cannot outlive its deadline. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Cancelled());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
function deadline(parent: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(ms)));
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
async function current(
  read: () => Promise<NotificationConfig | null>,
): Promise<NotificationConfig | null> {
  try {
    return await read();
  } catch {
    return null; // Missing or invalid new configuration fails closed; no cached authority.
  }
}
function render(
  config: NotificationConfig,
  kind: Parameters<typeof renderNotice>[0],
  workspaceId: string,
  pulseId: string | null,
): NoticeMessage {
  return renderNotice(
    kind,
    pulseId === null
      ? buildWorkspaceLink(config.publicOrigin, workspaceId)
      : buildPulseLink(config.publicOrigin, workspaceId, pulseId),
  );
}
function notAccepted(
  reason: 'provider_unavailable' | 'configuration_invalid',
  retryable: boolean,
): Extract<DispatchResult, { outcome: 'not_accepted' }> {
  return { outcome: 'not_accepted', retryable, reason };
}

function jobOptions(dependencies: NotificationDependencies) {
  return dependencies.callWindowMs === undefined ? {} : { callWindowMs: dependencies.callWindowMs };
}

/** Sleep that reports shutdown instead of throwing. */
async function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  try {
    await sleep(Math.max(1, Math.floor(ms)), undefined, signal ? { signal } : undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Processes at most one sendable event. Provider calls never occur inside a database transaction
 * or while any SQL lock is held: claim → prepare (eligibility, routing) → [Slack: fresh preflight
 * → DM open] → begin (fresh configuration + every current fact under the workspace lock, provider
 * send hold, attempt-start marker, counter — one transaction) → message submission → fenced
 * completion. A submission that cannot be completed leaves an unfinished marker, which recovery
 * turns into `uncertain`; it is never resent by any transport.
 */
export async function processOneNotification(
  pool: Pool,
  config: NotificationConfig | null,
  dependencies: NotificationDependencies = {},
): Promise<boolean> {
  const { signal } = dependencies;
  if (signal?.aborted) return false;
  const read = dependencies.configNow ?? (async () => config);
  const jobs = createNotificationJobs(pool, jobOptions(dependencies));
  if (!(await current(read))) return false;
  // Expired leases with an unfinished submission marker become uncertain, never claimable.
  await jobs.recoverExpired(10);
  const lease = await jobs.claim();
  if (!lease) return false;
  let marked = false;
  try {
    return await deliver(jobs, lease, read, dependencies, () => {
      marked = true;
    });
  } catch (error) {
    // Before a submission marker exists an unexpected failure is safe to return uncharged. With a
    // marker the lease is left to expire so recovery records acceptance as unknown.
    if (!marked) await jobs.release(lease, staleConfigDelayMs).catch(() => undefined);
    throw error;
  }
}

async function deliver(
  jobs: ReturnType<typeof createNotificationJobs>,
  lease: NotificationLease,
  read: () => Promise<NotificationConfig | null>,
  dependencies: NotificationDependencies,
  mark: () => void,
): Promise<true> {
  const { signal } = dependencies;
  const prepared = await jobs.prepare(lease, read);
  if (prepared.action !== 'send') return true;
  const route = prepared.route;
  let channelId: string | null = null;
  if (route.channel === 'slack') {
    // Every wait is followed by a fresh preflight; DM opening happens only after one passes.
    let ready: Extract<Awaited<ReturnType<typeof jobs.preflight>>, { action: 'ready' }> | null =
      null;
    while (!ready) {
      const gate = await jobs.preflight(lease, read, route);
      if (gate.action === 'done') return true;
      if (gate.action === 'ready') ready = gate;
      else if (!(await pause(Math.min(gate.waitMs, maximumPollMs), signal))) {
        await jobs.release(lease, 0);
        return true;
      }
    }
    const provider = dependencies.provider ?? createNotificationProvider(ready.config);
    await dependencies.beforeOpen?.();
    const opened = await openDirectMessage(provider, ready.grant, route, signal, ready.notAfter);
    if (opened === 'expired' || opened === 'cancelled') {
      await jobs.release(lease, 0);
      return true;
    }
    if (typeof opened !== 'string') {
      await jobs.openFailed(lease, read, route, ready.grant, opened);
      return true;
    }
    channelId = opened;
  }
  let started: Extract<Awaited<ReturnType<typeof jobs.begin>>, { action: 'started' }> | null = null;
  while (!started) {
    const begun = await jobs.begin(
      lease,
      read,
      route,
      (config) => render(config, prepared.kind, lease.workspaceId, prepared.pulseId),
      signal,
    );
    if (begun.action === 'done' || begun.action === 'cancelled') return true;
    if (begun.action === 'started') started = begun;
    else if (!(await pause(Math.min(begun.waitMs, maximumPollMs), signal))) {
      await jobs.release(lease, 0);
      return true;
    }
  }
  mark();
  const provider = dependencies.provider ?? createNotificationProvider(started.config);
  await dependencies.beforeDispatch?.();
  // The dispatch authorization is absolute (DB-clock window and lease, anchored before the final
  // statement). Elapsed time since then — including any process pause — is counted here. An
  // expired authorization is never used: the committed attempt is recorded as unknown, not sent.
  // Unavoidable boundary: a process paused *after* this check can still dispatch late; the
  // provider deadline below bounds the call and the hold/lease margins bound the overlap.
  const remaining = started.notAfter - performance.now();
  if (remaining < minimumDispatchMs) {
    await jobs.settle(
      lease,
      started,
      route,
      { outcome: 'uncertain', reason: 'acceptance_unknown' },
      read,
    );
    return true;
  }
  // The attempt is committed: the provider is genuinely invoked. A shutdown that already fired
  // does not cut this bounded submission short; one that fires later aborts it (uncertain).
  const submission = deadline(
    signal && !signal.aborted ? signal : undefined,
    Math.min(notificationNetworkTimeoutMs, remaining),
  );
  let outcome: DispatchResult;
  try {
    outcome = await abortable(
      route.channel === 'slack' && channelId !== null
        ? provider.sendSlack(started.grant, channelId, started.message, submission)
        : route.channel === 'email'
          ? provider.sendEmail(started.grant, route.email, started.message, submission)
          : Promise.reject(new Error('Invalid notification route')),
      submission,
    );
  } catch {
    // Thrown, cancelled or timed out after submission began: acceptance is unknown.
    outcome = { outcome: 'uncertain', reason: 'acceptance_unknown' };
  }
  await jobs.settle(lease, started, route, outcome, read);
  return true;
}

/** Authorized DM-open time must remain after the 5 s reserved for the begin transaction. */
const minimumOpenCallMs = 1000;
/**
 * Slack DM opening is idempotent and carries no message; any non-definitive result retries. The
 * preflight authorization is absolute: when elapsed time (including any pause) has consumed it,
 * the provider is NOT called ('expired') and the caller releases the lease uncharged.
 */
export async function openDirectMessage(
  provider: NotificationProvider,
  grant: NotificationGrant,
  route: SlackRoute,
  signal: AbortSignal | undefined,
  notAfter: number,
): Promise<
  string | 'cancelled' | 'expired' | Extract<DispatchResult, { outcome: 'not_accepted' }>
> {
  const budget = notAfter - performance.now() - 5000;
  if (budget < minimumOpenCallMs) return 'expired';
  const attempt = deadline(signal, Math.min(notificationNetworkTimeoutMs, budget));
  try {
    const result = await abortable(provider.openDm(grant, route.slackUserId, attempt), attempt);
    if ('channelId' in result) return result.channelId;
    if (result.outcome === 'not_accepted') return result;
    return notAccepted('provider_unavailable', true);
  } catch {
    return signal?.aborted ? 'cancelled' : notAccepted('provider_unavailable', true);
  }
}

export type NotificationCycle = Readonly<{
  scheduled: number;
  maintained: number;
  delivered: boolean;
}>;

/**
 * One bounded worker pass: a scheduler batch, a maintenance batch and at most one sendable event.
 * Absent configuration sends nothing and schedules nothing; bounded maintenance still runs.
 */
export async function runNotificationCycle(
  pool: Pool,
  config: NotificationConfig | null,
  dependencies: NotificationDependencies = {},
): Promise<NotificationCycle> {
  const read = dependencies.configNow ?? (async () => config);
  const live = await current(read);
  const maintained = await maintainNotifications(pool);
  if (!live || dependencies.signal?.aborted) return { scheduled: 0, maintained, delivered: false };
  const scheduled = await advanceNotificationSchedule(pool);
  const delivered = await processOneNotification(pool, live, { ...dependencies, configNow: read });
  return { scheduled, maintained, delivered };
}

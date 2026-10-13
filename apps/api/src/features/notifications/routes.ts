import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { IdentityError, object, uuid } from '../identity/input.ts';
import type { Actor } from '../identity/repository.ts';
import { type NotificationConfig, notificationGrant, readNotificationConfig } from './config.ts';
import { parsePolicyInput } from './input.ts';
import { createSlackLinkRepository, SlackLinkError } from './link-repository.ts';
import {
  createNotificationProvider,
  type NotificationProvider,
  notificationNetworkTimeoutMs,
  SlackVerificationError,
} from './provider.ts';
import { createNotificationRepository } from './repository.ts';
import type { SlackIdentityProvider } from './slack-identity.ts';

interface Dependencies {
  pool: Pool;
  /** Startup snapshot only. It is never fallback authority once `configNow` fails. */
  config: NotificationConfig | null;
  /** Trusted fixture seam; production re-reads the private operator file on every action. */
  configNow?: () => Promise<NotificationConfig | null>;
  actor: (request: FastifyRequest, reply: FastifyReply, write: boolean) => Promise<Actor>;
  provider?: NotificationProvider;
  identityProvider?: SlackIdentityProvider;
  /** Trusted APP_ORIGIN from identity configuration; never derived from a request. */
  appOrigin: string;
  /** Trusted AUTH_BASE_URL from identity configuration; owns the exact Slack callback URI. */
  callbackOrigin: string;
}

const defaultCooldownMs = 60_000;
const maximumCooldownMs = 3_600_000;

/** Register inside the identity plugin, which owns no-store and session/Origin handling. */
export function registerNotificationRoutes(server: FastifyInstance, dependencies?: Dependencies) {
  const readConfig = dependencies?.configNow ?? (() => readNotificationConfig(process.env));
  // Fail closed whenever the operator's public origin is not the trusted SPA origin.
  const configNow = async (): Promise<NotificationConfig | null> => {
    const current = await readConfig();
    if (current && current.publicOrigin !== dependencies?.appOrigin)
      throw new Error('Incompatible notification configuration');
    return current;
  };
  const repository = dependencies
    ? createNotificationRepository(dependencies.pool, dependencies.config, { configNow })
    : null;
  const link = dependencies
    ? createSlackLinkRepository(
        dependencies.pool,
        dependencies.config,
        dependencies.identityProvider,
        { configNow, callbackOrigin: dependencies.callbackOrigin },
      )
    : null;
  const base = '/api/workspaces/:workspaceId/notifications';

  async function context(
    request: FastifyRequest,
    reply: FastifyReply,
    write: boolean,
    extra: readonly string[] = [],
  ) {
    if (!dependencies || !repository || !link) throw new IdentityError(503, 'unavailable');
    const actor = await dependencies.actor(request, reply, write);
    const params = object(request.params, ['workspaceId', ...extra]);
    return { actor, workspaceId: uuid(params.workspaceId), params, repository, link };
  }
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === '23505' || error.code === '23503')
      )
        throw new IdentityError(409, 'conflict');
      throw new IdentityError(503, 'unavailable');
    }
  }

  // Durable per-Slack-workspace auth.test pause; metadata only, never provider text.
  async function cooldownSeconds(teamId: string): Promise<number | null> {
    if (!dependencies) throw new IdentityError(503, 'unavailable');
    const result = await dependencies.pool.query<{ seconds: number }>(
      `SELECT GREATEST(1,CEIL(EXTRACT(EPOCH FROM (blocked_until-clock_timestamp()))))::integer AS seconds
      FROM notification_slack_cooldowns WHERE team_id=$1 AND method='auth.test' AND blocked_until>clock_timestamp()`,
      [teamId],
    );
    const seconds = result.rows[0]?.seconds;
    return typeof seconds === 'number' && Number.isSafeInteger(seconds)
      ? Math.min(seconds, maximumCooldownMs / 1000)
      : null;
  }
  async function recordCooldown(teamId: string, retryAfterMs: number | null): Promise<void> {
    if (!dependencies) throw new IdentityError(503, 'unavailable');
    const delay = Math.min(Math.max(retryAfterMs ?? defaultCooldownMs, 1000), maximumCooldownMs);
    await dependencies.pool.query(
      'INSERT INTO notification_slack_budgets(team_id) VALUES($1) ON CONFLICT DO NOTHING',
      [teamId],
    );
    await dependencies.pool.query(
      `INSERT INTO notification_slack_cooldowns(team_id,method,blocked_until)
      VALUES($1,'auth.test',clock_timestamp()+($2::integer*interval '1 millisecond'))
      ON CONFLICT(team_id,method) DO UPDATE SET blocked_until=GREATEST(notification_slack_cooldowns.blocked_until,EXCLUDED.blocked_until)`,
      [teamId, delay],
    );
  }
  function rateLimited(reply: FastifyReply, seconds: number): never {
    reply.header('retry-after', String(seconds));
    throw new IdentityError(429, 'rate_limited');
  }

  /**
   * Server-only proof for enabling Slack. Network I/O happens here, outside any SQL
   * transaction; the repository then rechecks session, role, revision and fresh configuration.
   */
  async function slackProof(workspaceId: string, reply: FastifyReply) {
    if (!dependencies) throw new IdentityError(503, 'unavailable');
    let config: NotificationConfig | null;
    try {
      config = await configNow();
    } catch {
      throw new IdentityError(503, 'unavailable');
    }
    const grant = notificationGrant(config, workspaceId);
    if (!config || !grant) throw new IdentityError(409, 'conflict');
    if (!grant.slack) return undefined;
    const teamId = grant.slack.teamId;
    const paused = await safe(() => cooldownSeconds(teamId));
    if (paused !== null) rateLimited(reply, paused);
    const provider = dependencies.provider ?? createNotificationProvider(config);
    const signal = AbortSignal.timeout(notificationNetworkTimeoutMs);
    let outcome: { teamId: string } | SlackVerificationError | null = null;
    let onAbort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new SlackVerificationError('unavailable', null));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
      // The race also bounds an injected provider that ignores cancellation.
      outcome = await Promise.race([provider.verifySlack(grant, signal), aborted]);
    } catch (error) {
      outcome = error instanceof SlackVerificationError ? error : null;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (outcome === null) throw new IdentityError(503, 'unavailable');
    if (outcome instanceof SlackVerificationError) {
      const failure = outcome;
      if (failure.failure === 'unavailable') throw new IdentityError(503, 'unavailable');
      if (failure.failure === 'rate_limited') {
        await safe(() => recordCooldown(teamId, failure.retryAfterMs));
        const seconds = await safe(() => cooldownSeconds(teamId));
        return rateLimited(reply, seconds ?? 60);
      }
      throw new IdentityError(409, 'conflict');
    }
    if (outcome.teamId !== teamId) throw new IdentityError(409, 'conflict');
    return {
      teamId,
      grantFingerprint: grant.fingerprint,
      credentialFingerprint: grant.credentialFingerprint,
    };
  }

  server.get(`${base}/availability`, async (request, reply) => {
    const c = await context(request, reply, false);
    object(request.query, []);
    return safe(() => c.repository.availability(c.actor, c.workspaceId));
  });
  server.get(`${base}/policy`, async (request, reply) => {
    const c = await context(request, reply, false);
    object(request.query, []);
    return { policy: await safe(() => c.repository.policy(c.actor, c.workspaceId)) };
  });
  server.patch(`${base}/policy`, async (request, reply) => {
    const c = await context(request, reply, true);
    object(request.query, []);
    const body = parsePolicyInput(request.body);
    let proof: Awaited<ReturnType<typeof slackProof>>;
    if (body.enabled) {
      // Current owner and revision are proven before any provider contact.
      const current = await safe(() => c.repository.policy(c.actor, c.workspaceId));
      if (current.revision !== body.revision) throw new IdentityError(409, 'conflict');
      proof = await slackProof(c.workspaceId, reply);
    }
    return {
      policy: await safe(() => c.repository.updatePolicy(c.actor, c.workspaceId, body, proof)),
    };
  });
  server.get(`${base}/slack-link`, async (request, reply) => {
    const c = await context(request, reply, false);
    object(request.query, []);
    return { link: await safe(() => c.repository.ownLink(c.actor, c.workspaceId)) };
  });
  server.post(`${base}/slack-link/start`, async (request, reply) => {
    const c = await context(request, reply, true);
    object(request.query, []);
    object(request.body ?? {}, []);
    return safe(() => c.link.begin(c.actor, c.workspaceId));
  });
  server.post(`${base}/slack-link/unlink`, async (request, reply) => {
    const c = await context(request, reply, true);
    object(request.query, []);
    return { link: await safe(() => c.repository.unlink(c.actor, c.workspaceId, request.body)) };
  });
  server.get(`${base}/history`, async (request, reply) => {
    const c = await context(request, reply, false);
    return safe(() => c.repository.ownHistory(c.actor, c.workspaceId, request.query));
  });
  server.get(`${base}/pulses/:pulseId`, async (request, reply) => {
    const c = await context(request, reply, false, ['pulseId']);
    object(request.query, []);
    const pulseId = uuid(c.params.pulseId);
    return safe(() => c.repository.summary(c.actor, c.workspaceId, pulseId));
  });
  server.post(`${base}/pulses/:pulseId/remind`, async (request, reply) => {
    const c = await context(request, reply, true, ['pulseId']);
    object(request.query, []);
    const pulseId = uuid(c.params.pulseId);
    const batch = await safe(() =>
      c.repository.remind(c.actor, c.workspaceId, pulseId, request.body),
    );
    return reply.code(202).send(batch);
  });
  server.post(`${base}/pulses/:pulseId/reminders/disable`, async (request, reply) => {
    const c = await context(request, reply, true, ['pulseId']);
    object(request.query, []);
    const pulseId = uuid(c.params.pulseId);
    return safe(() => c.repository.disableReminders(c.actor, c.workspaceId, pulseId, request.body));
  });
  server.post(`${base}/pulses/:pulseId/retry`, async (request, reply) => {
    const c = await context(request, reply, true, ['pulseId']);
    object(request.query, []);
    const pulseId = uuid(c.params.pulseId);
    const batch = await safe(() =>
      c.repository.retryBatch(c.actor, c.workspaceId, pulseId, request.body),
    );
    return reply.code(202).send(batch);
  });
  server.post(`${base}/test`, async (request, reply) => {
    const c = await context(request, reply, true);
    object(request.query, []);
    const batch = await safe(() => c.repository.testDelivery(c.actor, c.workspaceId, request.body));
    return reply.code(202).send(batch);
  });

  // OAuth GET: session cookie plus single-use state/nonce authorize it; Origin is not available.
  server.get('/api/notifications/slack/callback', async (request, reply) => {
    if (!dependencies || !link) throw new IdentityError(503, 'unavailable');
    reply.header('referrer-policy', 'no-referrer');
    function redirect(workspaceId: string | undefined, outcome: 'success' | 'failed') {
      const target = new URL('/developer-experience', dependencies?.appOrigin);
      if (workspaceId !== undefined) target.searchParams.set('workspace', workspaceId);
      target.searchParams.set('notificationLink', outcome);
      return reply.redirect(target.href, 303);
    }
    let trusted: string | undefined;
    try {
      const actor = await dependencies.actor(request, reply, false);
      const result = await link.complete(actor, request.query);
      return redirect(uuid(result.workspaceId), 'success');
    } catch (error) {
      // Only a workspace proven by stored actor/session state may appear; nothing else is echoed.
      if (error instanceof SlackLinkError && error.workspaceId !== undefined) {
        try {
          trusted = uuid(error.workspaceId);
        } catch {
          trusted = undefined;
        }
      }
      return redirect(trusted, 'failed');
    }
  });
}

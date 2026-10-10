import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AdapterError,
  type ArgoNotification,
  argoNotificationDigest,
  parseArgoNotification,
} from '@clio/adapters';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool.ts';
import { IdentityError, object, uuid } from '../identity/input.ts';
import { type ArgoConfig, type ArgoGrant, digest, grantFor, scopeFor } from './config.ts';
import { boundedJson, maxBytes, maxRows, parseEvidence } from './history.ts';
import { count, timestamp } from './input.ts';
import { operationMetadata } from './metadata.ts';
import { ensureSource, latestConnection } from './repository.ts';

export const databaseTime = `to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function authenticate(request: FastifyRequest, config: ArgoConfig | null): ArgoGrant {
  let sourceId: string;
  try {
    sourceId = uuid(object(request.params, ['sourceId']).sourceId);
  } catch {
    throw new IdentityError(401, 'unauthorized');
  }
  const grant = grantFor(config, sourceId),
    authorization = request.headers.authorization;
  const token =
    typeof authorization === 'string' && /^Bearer [0-9a-f]{64}$/.test(authorization)
      ? authorization.slice(7)
      : '';
  const actual = Buffer.from(digest(token), 'hex'),
    expected = Buffer.from(grant?.tokenDigest ?? '0'.repeat(64), 'hex');
  if (!timingSafeEqual(actual, expected) || !grant || !token || request.url.includes('?'))
    throw new IdentityError(401, 'unauthorized');
  return grant;
}
export function registerArgoIngress(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    argo: ArgoConfig | null;
    configNow?: () => ArgoConfig | null;
    clock?: () => number;
  },
) {
  const configNow = dependencies.configNow ?? (() => dependencies.argo),
    clock = dependencies.clock ?? (() => Date.now());
  const authenticated = new WeakMap<FastifyRequest, ArgoGrant>();
  const buckets = new Map<string, { tokens: number; at: number }>();
  app.register(async (routes) => {
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    routes.setErrorHandler((error, _request, reply) => {
      const status =
        error instanceof IdentityError
          ? error.status
          : typeof error === 'object' &&
              error !== null &&
              'statusCode' in error &&
              (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)
            ? 400
            : 503;
      reply.code(status).send({
        error:
          error instanceof IdentityError
            ? error.message
            : status === 503
              ? 'unavailable'
              : 'invalid_request',
      });
    });
    routes.post(
      '/api/argo/sources/:sourceId/operations',
      {
        bodyLimit: 65536,
        onRequest: async (request, reply) => {
          const grant = authenticate(request, configNow());
          authenticated.set(request, grant);
          const now = clock(),
            old = buckets.get(grant.sourceId) ?? { tokens: 10, at: now };
          const tokens = Math.min(10, old.tokens + Math.max(0, now - old.at) / 2000);
          buckets.set(grant.sourceId, { tokens: tokens < 1 ? tokens : tokens - 1, at: now });
          if (tokens < 1) {
            reply.header('Retry-After', '2');
            throw new IdentityError(503, 'unavailable');
          }
          if (
            request.headers['content-type']?.toLowerCase() !== 'application/json' &&
            request.headers['content-type']?.toLowerCase() !== 'application/json; charset=utf-8'
          )
            throw new IdentityError(400, 'invalid_request');
        },
      },
      async (request, reply) => {
        const grant = authenticated.get(request);
        if (!grant) throw new IdentityError(401, 'unauthorized');
        const outcome = await acceptReceipt(dependencies.pool, grant, request.body, configNow);
        if ('error' in outcome) {
          if (outcome.error === 503) reply.header('Retry-After', '2');
          throw new IdentityError(
            outcome.error,
            outcome.error === 503 ? 'unavailable' : 'invalid_request',
          );
        }
        return reply.code(202).send(outcome);
      },
    );
  });
}
export async function acceptReceipt(
  pool: Pool,
  grant: ArgoGrant,
  input: unknown,
  configNow: () => ArgoConfig | null = () => ({ grants: [grant] }),
) {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [grant.workspaceId]);
    const current = await latestConnection(client, grant.workspaceId, grant.serviceId),
      fresh = grantFor(configNow(), grant.sourceId, grant.workspaceId, grant.serviceId);
    if (
      !current?.connection.active ||
      current.connection.sourceId !== grant.sourceId ||
      current.fingerprint !== grant.fingerprint ||
      fresh?.fingerprint !== grant.fingerprint ||
      !isDeepStrictEqual(current.scope, scopeFor(grant))
    )
      throw new IdentityError(409, 'conflict');
    const state = await ensureSource(client, grant),
      scope = scopeFor(grant);
    let key: string;
    try {
      key = argoNotificationDigest(input, scope);
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'argo_scope_drift')
        await client.query(
          'UPDATE argo_source_state SET scope_drift_count=LEAST(scope_drift_count::bigint+1,2147483647),first_observed_at=coalesce(first_observed_at,clock_timestamp()) WHERE source_id=$1',
          [grant.sourceId],
        );
      return { error: 400 };
    }
    const found = await client.query<Record<string, unknown>>(
      `SELECT id,to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed FROM argo_receipts WHERE source_id=$1 AND grant_fingerprint=$2 AND digest=$3`,
      [grant.sourceId, grant.fingerprint, key],
    );
    const replay = found.rows[0];
    if (replay) return { receiptId: uuid(replay.id), observedAt: timestamp(replay.observed) };
    const time = await client.query<Record<string, unknown>>(`SELECT ${databaseTime} AS observed`),
      observedAt = timestamp(time.rows[0]?.observed);
    let notification: ArgoNotification;
    try {
      notification = parseArgoNotification(input, scope, observedAt);
    } catch {
      return { error: 400 };
    }
    let reason: string | null = notification.kind === 'gap' ? notification.reason : null;
    let evidence =
      notification.kind === 'operation' ? parseEvidence(notification.evidence, scope) : null;
    const metadataInput = operationMetadata(notification);
    if (metadataInput) {
      const metadata = await client.query<Record<string, unknown>>(
        'SELECT metadata_digest FROM argo_operation_metadata WHERE source_id=$1 AND application_uid=$2 AND operation_id=$3',
        [grant.sourceId, grant.applicationUid, metadataInput.operationId],
      );
      if (metadata.rows[0] && metadata.rows[0].metadata_digest !== metadataInput.digest)
        throw new IdentityError(409, 'conflict');
    }
    if (notification.kind === 'operation') {
      const combos = await client.query<Record<string, unknown>>(
        'SELECT phase,health FROM argo_receipts WHERE source_id=$1 AND application_uid=$2 AND operation_id=$3 AND evidence IS NOT NULL',
        [grant.sourceId, grant.applicationUid, notification.operationId],
      );
      if (
        combos.rows.some((r) => r.phase === notification.phase && r.health === notification.health)
      )
        reason = 'status_combination_repeated';
      else if (combos.rows.length >= 30) reason = 'status_combination_limit';
      if (reason) evidence = null;
    }
    const evidenceJson = evidence ? boundedJson(evidence) : null;
    const storedSize = evidenceJson
      ? await client.query<Record<string, unknown>>(
          'SELECT octet_length($1::jsonb::text)::int AS bytes',
          [evidenceJson],
        )
      : null;
    const bytes = reason
      ? 64
      : Buffer.byteLength(notification.canonicalJson) + count(storedSize?.rows[0]?.bytes);
    const rows = 1 + (evidence ? evidence.deployments.length + evidence.statuses.length : 0);
    if (
      count(state.retained_rows) + rows > maxRows ||
      count(state.retained_bytes) + bytes > maxBytes
    ) {
      await client.query(
        'UPDATE argo_source_state SET rejection_count=LEAST(rejection_count::bigint+1,2147483647),first_observed_at=coalesce(first_observed_at,$2) WHERE source_id=$1',
        [grant.sourceId, observedAt],
      );
      return { error: 503 };
    }
    if (metadataInput)
      await client.query(
        'INSERT INTO argo_operation_metadata(source_id,application_uid,operation_id,metadata_digest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [grant.sourceId, grant.applicationUid, metadataInput.operationId, metadataInput.digest],
      );
    const receiptId = randomUUID();
    await client.query(
      `INSERT INTO argo_receipts(id,source_id,workspace_id,service_id,connection_revision,application_uid,grant_fingerprint,scope,digest,observed_at,started_at,operation_id,notification_revision,phase,health,reason,canonical_json,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        receiptId,
        grant.sourceId,
        grant.workspaceId,
        grant.serviceId,
        current.connection.revision,
        grant.applicationUid,
        grant.fingerprint,
        JSON.stringify(scope),
        key,
        observedAt,
        notification.startedAt,
        !reason && notification.kind === 'operation' ? notification.operationId : null,
        !reason && notification.kind === 'operation' ? notification.notificationRevision : null,
        !reason && notification.kind === 'operation' ? notification.phase : null,
        !reason && notification.kind === 'operation' ? notification.health : null,
        reason,
        reason ? null : notification.canonicalJson,
        evidenceJson,
      ],
    );
    await client.query(
      'UPDATE argo_source_state SET retained_rows=retained_rows+$2,retained_bytes=retained_bytes+$3,first_observed_at=coalesce(first_observed_at,$4) WHERE source_id=$1',
      [grant.sourceId, rows, bytes, observedAt],
    );
    return { receiptId, observedAt };
  });
}

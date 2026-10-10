import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ArgoEnrichment,
  type ArgoEnrichmentEvidence,
  identity,
  parseArgoEnrichment,
} from '@clio/adapters';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool.ts';
import { snapshotDigest } from '../github-collection/digest.ts';
import { IdentityError, object, uuid } from '../identity/input.ts';
import {
  type ArgoConfig,
  type ArgoProducerGrant,
  digest,
  grantFor,
  parseProducerScope,
  producerFor,
  producerScopeFor,
  scopeFor,
} from './config.ts';
import { enrichmentCaptureReserve } from './enrichment-budget.ts';
import { eligibleProducers } from './enrichment-grants.ts';
import { boundedJson, maxBytes, maxRows, parseEvidence } from './history.ts';
import { databaseTime } from './ingress.ts';
import { count, instant, timestamp } from './input.ts';
import { consumeIngressToken } from './rate-limit.ts';
import { ensureSource, latestConnection } from './repository.ts';

export function parseEnrichmentReceipt(
  row: Record<string, unknown>,
  grant: ArgoProducerGrant,
  nativeFingerprint: string,
): ArgoEnrichmentEvidence {
  const scope = parseProducerScope(row.scope),
    observedAt = timestamp(row.observed);
  if (
    !isDeepStrictEqual(scope, producerScopeFor(grant)) ||
    row.native_fingerprint !== nativeFingerprint ||
    row.producer_fingerprint !== grant.fingerprint
  )
    throw new Error('Invalid enrichment scope');
  const event = parseArgoEnrichment(row.event, scope, observedAt);
  if (
    row.workspace_id !== scope.workspaceId ||
    row.service_id !== scope.serviceId ||
    row.source_id !== scope.sourceId ||
    row.producer_id !== scope.producerId ||
    row.event_id !== event.event_id ||
    snapshotDigest(event) !== row.digest
  )
    throw new Error('Invalid enrichment receipt');
  return {
    scope,
    event,
    observedAt,
    sourceRef: `urn:clio:argo-enrichment:${scope.sourceId}:${scope.producerId}:${event.event_id}`,
  };
}
class MissingAnchor extends IdentityError {
  constructor() {
    super(409, 'conflict');
  }
}
export function registerEnrichmentIngress(
  routes: FastifyInstance,
  pool: Pool,
  configNow: () => ArgoConfig | null,
) {
  const authenticated = new WeakMap<FastifyRequest, ArgoProducerGrant>();
  routes.post(
    '/api/argo/sources/:sourceId/enrichments/:producerId',
    {
      bodyLimit: 65536,
      onRequest: async (request, reply) => {
        let grant: ArgoProducerGrant | null = null;
        try {
          const row = object(request.params, ['sourceId', 'producerId']);
          grant = producerFor(configNow(), uuid(row.sourceId), uuid(row.producerId));
        } catch {}
        const authorization = request.headers.authorization;
        const token =
          typeof authorization === 'string' && /^Bearer [a-f0-9]{64}$/.test(authorization)
            ? authorization.slice(7)
            : '';
        const equal = timingSafeEqual(
          Buffer.from(digest(token), 'hex'),
          Buffer.from(grant?.tokenDigest ?? '0'.repeat(64), 'hex'),
        );
        if (!equal || !grant || !token || request.url.includes('?'))
          throw new IdentityError(401, 'unauthorized');
        authenticated.set(request, grant);
        if (!(await consumeIngressToken(pool, grant.sourceId))) {
          reply.header('Retry-After', '2');
          throw new IdentityError(503, 'unavailable');
        }
        if (
          !['application/json', 'application/json; charset=utf-8'].includes(
            request.headers['content-type']?.toLowerCase() ?? '',
          )
        )
          throw new IdentityError(400, 'invalid_request');
      },
    },
    async (request, reply) => {
      const grant = authenticated.get(request);
      if (!grant) throw new IdentityError(401, 'unauthorized');
      const result = await acceptEnrichment(pool, grant, request.body, configNow).catch(
        (error: unknown) => {
          if (error instanceof MissingAnchor) reply.header('Retry-After', '2');
          throw error;
        },
      );
      if ('error' in result) {
        reply.header('Retry-After', '2');
        throw new IdentityError(503, 'unavailable');
      }
      return reply.code(202).send(result);
    },
  );
}
export async function acceptEnrichment(
  pool: Pool,
  grant: ArgoProducerGrant,
  input: unknown,
  configNow: () => ArgoConfig | null,
) {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [grant.workspaceId]);
    const time = await client.query<Record<string, unknown>>(`SELECT ${databaseTime} AS observed`);
    const observedAt = timestamp(time.rows[0]?.observed),
      scope = producerScopeFor(grant);
    let event: ArgoEnrichment;
    try {
      event = parseArgoEnrichment(input, scope, observedAt);
    } catch {
      throw new IdentityError(400, 'invalid_request');
    }
    const config = configNow(),
      native = grantFor(config, grant.sourceId, grant.workspaceId, grant.serviceId);
    const current = await latestConnection(client, grant.workspaceId, grant.serviceId);
    const selected = current
      ? eligibleProducers(config, current.connection, current.producers)
      : null;
    if (
      !native ||
      !current?.connection.active ||
      current.connection.sourceId !== grant.sourceId ||
      current.fingerprint !== native.fingerprint ||
      !isDeepStrictEqual(current.scope, scopeFor(native)) ||
      !isDeepStrictEqual(scopeFor(grant), scopeFor(native)) ||
      !selected?.some(
        (p) => p.producerId === grant.producerId && p.fingerprint === grant.fingerprint,
      )
    )
      throw new IdentityError(409, 'conflict');
    const state = await ensureSource(client, native);
    const key = snapshotDigest(event);
    const previous = await client.query<Record<string, unknown>>(
      `SELECT *,to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed FROM argo_enrichment_receipts WHERE source_id=$1 AND producer_id=$2 AND event_id=$3`,
      [grant.sourceId, grant.producerId, event.event_id],
    );
    const replay = previous.rows[0];
    if (replay) {
      if (
        replay.digest !== key ||
        replay.native_fingerprint !== native.fingerprint ||
        replay.producer_fingerprint !== grant.fingerprint
      )
        throw new IdentityError(409, 'conflict');
      parseEnrichmentReceipt(replay, grant, native.fingerprint);
      const freshConfig = configNow();
      if (
        grantFor(freshConfig, grant.sourceId)?.fingerprint !== native.fingerprint ||
        eligibleProducers(freshConfig, current.connection, current.producers) === null
      )
        throw new IdentityError(409, 'conflict');
      return { receiptId: uuid(replay.id), observedAt: timestamp(replay.observed) };
    }
    let lockRows = 0,
      lockJson: unknown = null;
    if (event.kind === 'consumer_exposure') {
      const anchors = await client.query<Record<string, unknown>>(
        'SELECT scope,evidence FROM argo_receipts WHERE source_id=$1 AND application_uid=$2 AND operation_id=$3 AND grant_fingerprint=$4 AND evidence IS NOT NULL ORDER BY observed_at,id LIMIT 31',
        [grant.sourceId, grant.applicationUid, event.operation_id, native.fingerprint],
      );
      const eligible = anchors.rows.some((row) => {
        if (!isDeepStrictEqual(row.scope, scopeFor(native)))
          throw new Error('Invalid native anchor scope');
        const deployment = parseEvidence(row.evidence, scopeFor(native)).deployments[0];
        return (
          deployment?.operationKind === 'rollout' &&
          deployment.sourceDeploymentId ===
            identity('application', native.applicationUid, 'operation', event.operation_id) &&
          deployment.reconciledConfigurationRevision === event.configuration_revision &&
          instant(deployment.eventAt) <= instant(event.effective_at)
        );
      });
      if (!eligible) {
        if (anchors.rows.length === 0) throw new MissingAnchor();
        throw new IdentityError(409, 'conflict');
      }
      const locks = await client.query<Record<string, unknown>>(
        'SELECT subject FROM argo_enrichment_subjects WHERE source_id=$1 AND application_uid=$2 AND operation_id=$3',
        [grant.sourceId, grant.applicationUid, event.operation_id],
      );
      if (locks.rows[0] && !isDeepStrictEqual(locks.rows[0].subject, event.subject))
        throw new IdentityError(409, 'conflict');
      lockRows = locks.rows.length ? 0 : 1;
      lockJson = {
        sourceId: grant.sourceId,
        applicationUid: grant.applicationUid,
        operationId: event.operation_id,
        subject: event.subject,
      };
    } else {
      const locks = await client.query<Record<string, unknown>>(
        'SELECT repository_id,commit_sha FROM argo_enrichment_artifacts WHERE source_id=$1 AND artifact_digest=$2',
        [grant.sourceId, event.artifact_digest],
      );
      if (
        locks.rows[0] &&
        (locks.rows[0].repository_id !== event.repository_id ||
          locks.rows[0].commit_sha !== event.commit_sha)
      )
        throw new IdentityError(409, 'conflict');
      lockRows = locks.rows.length ? 0 : 1;
      lockJson = {
        sourceId: grant.sourceId,
        artifactDigest: event.artifact_digest,
        repositoryId: event.repository_id,
        commitSha: event.commit_sha,
      };
    }
    const eventJson = boundedJson(event),
      scopeJson = boundedJson(scope);
    const size = await client.query<Record<string, unknown>>(
      'SELECT (octet_length($1::jsonb::text)+octet_length($2::jsonb::text)+octet_length($3::jsonb::text))::int AS bytes',
      [eventJson, scopeJson, lockRows ? boundedJson(lockJson) : '{}'],
    );
    let repositoryJsonBytes: number | undefined;
    if (event.kind === 'consumer_exposure' && event.subject.kind === 'artifact') {
      const artifact = await client.query<Record<string, unknown>>(
        'SELECT repository_id FROM argo_enrichment_artifacts WHERE source_id=$1 AND artifact_digest=$2',
        [grant.sourceId, event.subject.digest],
      );
      if (artifact.rows[0]) {
        const repository = artifact.rows[0].repository_id;
        if (typeof repository !== 'string' || [...repository].length > 2048)
          throw new Error('Invalid stored artifact identity');
        repositoryJsonBytes = Buffer.byteLength(JSON.stringify(repository));
      }
    }
    const bytes =
        count(size.rows[0]?.bytes) + 256 + enrichmentCaptureReserve(event, repositoryJsonBytes),
      rows = 1 + lockRows;
    if (
      count(state.retained_rows) + rows > maxRows ||
      count(state.retained_bytes) + bytes > maxBytes
    ) {
      await client.query(
        'UPDATE argo_source_state SET rejection_count=LEAST(rejection_count::bigint+1,2147483647),first_observed_at=coalesce(first_observed_at,$2) WHERE source_id=$1',
        [grant.sourceId, observedAt],
      );
      return { error: 503 as const };
    }
    if (lockRows) {
      if (event.kind === 'consumer_exposure')
        await client.query(
          'INSERT INTO argo_enrichment_subjects(source_id,application_uid,operation_id,subject) VALUES($1,$2,$3,$4)',
          [grant.sourceId, grant.applicationUid, event.operation_id, boundedJson(event.subject)],
        );
      else
        await client.query(
          'INSERT INTO argo_enrichment_artifacts(source_id,artifact_digest,repository_id,commit_sha) VALUES($1,$2,$3,$4)',
          [grant.sourceId, event.artifact_digest, event.repository_id, event.commit_sha],
        );
    }
    const receiptId = randomUUID();
    await client.query(
      'INSERT INTO argo_enrichment_receipts(id,source_id,workspace_id,service_id,connection_revision,producer_id,event_id,native_fingerprint,producer_fingerprint,scope,event,digest,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [
        receiptId,
        grant.sourceId,
        grant.workspaceId,
        grant.serviceId,
        current.connection.revision,
        grant.producerId,
        event.event_id,
        native.fingerprint,
        grant.fingerprint,
        scopeJson,
        eventJson,
        key,
        observedAt,
      ],
    );
    await client.query(
      'UPDATE argo_source_state SET retained_rows=retained_rows+$2,retained_bytes=retained_bytes+$3,first_observed_at=coalesce(first_observed_at,$4) WHERE source_id=$1',
      [grant.sourceId, rows, bytes, observedAt],
    );
    // Config is immutable in production; injected rotation hooks must also fence final acceptance.
    const freshConfig = configNow();
    if (
      grantFor(freshConfig, grant.sourceId)?.fingerprint !== native.fingerprint ||
      eligibleProducers(freshConfig, current.connection, current.producers) === null
    )
      throw new IdentityError(409, 'conflict');
    return { receiptId, observedAt };
  });
}

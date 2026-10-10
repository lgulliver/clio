import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AdapterError,
  type ArchiveRecord,
  type ArgoNotification,
  argoNotificationDigest,
  parseArchiveRecord,
  parseHistoricalArgoNotification,
} from '@clio/adapters';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.ts';
import { IdentityError, object, uuid } from '../identity/input.ts';
import { archiveFor, eligibleArchive } from './archive-grants.ts';
import {
  type ArgoArchiveGrant,
  type ArgoConfig,
  digest,
  grantFor,
  parseScope,
  scopeFor,
} from './config.ts';
import { boundedJson, maxBytes, maxRows, parseEvidence } from './history.ts';
import { databaseTime } from './ingress.ts';
import { count, instant, text, timestamp } from './input.ts';
import { operationMetadata } from './metadata.ts';
import { consumeArchiveToken } from './rate-limit.ts';
import { ensureSource, latestConnection } from './repository.ts';

function authenticate(request: FastifyRequest, config: ArgoConfig | null): ArgoArchiveGrant {
  let grant: ArgoArchiveGrant | null = null;
  try {
    const p = object(request.params, ['sourceId', 'producerId']);
    grant = archiveFor(config, uuid(p.sourceId), uuid(p.producerId));
  } catch {}
  const authorization = request.headers.authorization;
  const token =
    typeof authorization === 'string' && /^Bearer [0-9a-f]{64}$/.test(authorization)
      ? authorization.slice(7)
      : '';
  const valid = timingSafeEqual(
    Buffer.from(digest(token), 'hex'),
    Buffer.from(grant?.tokenDigest ?? '0'.repeat(64), 'hex'),
  );
  if (!valid || !grant || !token || request.url.includes('?'))
    throw new IdentityError(401, 'unauthorized');
  return grant;
}
export function registerArchiveIngress(
  app: FastifyInstance,
  pool: Pool,
  configNow: () => ArgoConfig | null,
) {
  const authenticated = new WeakMap<FastifyRequest, ArgoArchiveGrant>();
  app.post(
    '/api/argo/sources/:sourceId/archives/:producerId',
    {
      bodyLimit: 65536,
      onRequest: async (request, reply) => {
        const grant = authenticate(request, configNow());
        authenticated.set(request, grant);
        if (!(await consumeArchiveToken(pool, grant.sourceId))) {
          reply.header('Retry-After', '4');
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
      let record: ArchiveRecord;
      try {
        record = parseArchiveRecord(request.body);
      } catch {
        throw new IdentityError(400, 'invalid_request');
      }
      try {
        return reply.code(202).send(await acceptArchive(pool, grant, record, configNow));
      } catch (error) {
        if (error instanceof IdentityError && error.status === 503)
          reply.header('Retry-After', '4');
        throw error;
      }
    },
  );
}
async function reserve(client: PoolClient, sourceId: string, rows: number, bytes: number) {
  const reserved = await client.query(
    `UPDATE argo_source_state SET retained_rows=retained_rows+$2,retained_bytes=retained_bytes+$3,first_observed_at=coalesce(first_observed_at,clock_timestamp()) WHERE source_id=$1 AND retained_rows+$2<=5000 AND retained_bytes+$3<=8388608 RETURNING source_id`,
    [sourceId, rows, bytes],
  );
  if (!reserved.rowCount) throw new IdentityError(503, 'unavailable');
}
async function jsonBytes(client: PoolClient, value: unknown) {
  const found = await client.query<Record<string, unknown>>(
    'SELECT octet_length($1::jsonb::text)::int AS bytes',
    [boundedJson(value)],
  );
  return count(found.rows[0]?.bytes);
}
async function acceptArchive(
  pool: Pool,
  grant: ArgoArchiveGrant,
  record: ArchiveRecord,
  configNow: () => ArgoConfig | null,
) {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [grant.workspaceId]);
    const current = await latestConnection(client, grant.workspaceId, grant.serviceId),
      native = grantFor(configNow(), grant.sourceId, grant.workspaceId, grant.serviceId);
    const check = () => {
      const fresh = grantFor(configNow(), grant.sourceId, grant.workspaceId, grant.serviceId),
        archive = current
          ? eligibleArchive(configNow(), current.connection, current.archive)
          : null;
      if (
        !native ||
        !current?.connection.active ||
        current.connection.sourceId !== grant.sourceId ||
        current.fingerprint !== native.fingerprint ||
        fresh?.fingerprint !== native.fingerprint ||
        !archive ||
        archive.fingerprint !== grant.fingerprint ||
        !isDeepStrictEqual(scopeFor(native), scopeFor(grant)) ||
        !isDeepStrictEqual(current.scope, scopeFor(native))
      )
        throw new IdentityError(409, 'conflict');
    };
    check();
    if (!native || !current) throw new IdentityError(409, 'conflict');
    const state = await ensureSource(client, native);
    if (count(state.retained_rows) > maxRows || count(state.retained_bytes) > maxBytes)
      throw new IdentityError(503, 'unavailable');
    const received = timestamp(
      (await client.query<Record<string, unknown>>(`SELECT ${databaseTime} AS observed`)).rows[0]
        ?.observed,
    );
    if (
      record.source_id !== grant.sourceId ||
      record.producer_id !== grant.producerId ||
      record.journal_id !== grant.journalId ||
      record.policy_reference !== grant.policyReference ||
      instant(record.startup_at) > instant(received)
    )
      throw new IdentityError(409, 'conflict');
    const journalRows = await client.query<Record<string, unknown>>(
      `SELECT *,to_char(startup_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS startup,to_char(last_capture_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured,to_char(sealed_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sealed FROM argo_archive_journals WHERE source_id=$1 AND journal_id=$2 FOR UPDATE`,
      [grant.sourceId, grant.journalId],
    );
    let journal = journalRows.rows[0];
    if (!journal) {
      await reserve(
        client,
        grant.sourceId,
        1,
        (await jsonBytes(client, {
          sourceId: grant.sourceId,
          journalId: grant.journalId,
          producerId: grant.producerId,
          policyReference: grant.policyReference,
          startupAt: record.startup_at,
          scope: scopeFor(native),
        })) + 1024,
      );
      await client.query(
        'INSERT INTO argo_archive_journals(source_id,journal_id,producer_id,policy_reference,startup_at,registered_at,scope) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          grant.sourceId,
          grant.journalId,
          grant.producerId,
          grant.policyReference,
          record.startup_at,
          received,
          JSON.stringify(scopeFor(native)),
        ],
      );
      journal = {
        last_sequence: 0,
        last_digest: '0'.repeat(64),
        sealed_sequence: 0,
        startup: record.startup_at,
        captured: null,
        sealed: null,
        producer_id: grant.producerId,
        policy_reference: grant.policyReference,
        scope: scopeFor(native),
      };
    }
    if (
      !isDeepStrictEqual(parseScope(journal.scope), scopeFor(native)) ||
      journal.producer_id !== grant.producerId ||
      journal.policy_reference !== grant.policyReference ||
      instant(timestamp(journal.startup)) !== instant(record.startup_at)
    )
      throw new IdentityError(409, 'conflict');
    const replay = await client.query<Record<string, unknown>>(
      `SELECT id,digest,receipt_id,gap_reason,remaining_rows,remaining_bytes,to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed FROM argo_archive_records WHERE source_id=$1 AND journal_id=$2 AND ${record.kind === 'entry' ? 'sequence' : 'seal_id'}=$3`,
      [grant.sourceId, grant.journalId, record.kind === 'entry' ? record.sequence : record.seal_id],
    );
    const old = replay.rows[0];
    if (old) {
      if (old.digest !== record.digest) throw new IdentityError(409, 'conflict');
      check();
      return acknowledgment(old);
    }
    const id = randomUUID();
    let receiptId: string | null = null,
      gap: string | null = null;
    if (record.kind === 'entry') {
      if (
        record.sequence !== storedCount(journal.last_sequence) + 1 ||
        record.previous_digest !== journal.last_digest ||
        instant(record.captured_at) > instant(received) ||
        instant(record.captured_at) < instant(record.startup_at) ||
        (journal.captured !== null &&
          instant(record.captured_at) < instant(timestamp(journal.captured))) ||
        (journal.sealed !== null &&
          instant(record.captured_at) < instant(timestamp(journal.sealed)))
      )
        throw new IdentityError(409, 'conflict');
      const imported = await importNative(
        client,
        native,
        current.connection.revision,
        grant,
        record,
        received,
        id,
      );
      receiptId = imported.receiptId;
      gap = imported.gap;
    } else {
      await validateSeal(client, grant, record, journal, received);
    }
    await reserve(
      client,
      grant.sourceId,
      1,
      (await jsonBytes(client, record)) +
        (await jsonBytes(client, {
          id,
          nativeFingerprint: native.fingerprint,
          archiveFingerprint: grant.fingerprint,
          receiptId,
          gap,
          received,
          revision: current.connection.revision,
        })) +
        2048 +
        (record.kind === 'seal' ? 2 * Buffer.byteLength(JSON.stringify(record.interruptions)) : 0),
    );
    const remaining = (
      await client.query<Record<string, unknown>>(
        'SELECT 5000-retained_rows AS remaining_rows,8388608-retained_bytes AS remaining_bytes FROM argo_source_state WHERE source_id=$1',
        [grant.sourceId],
      )
    ).rows[0];
    if (!remaining) throw new Error('Missing archive budget');
    await client.query(
      'INSERT INTO argo_archive_records(id,source_id,journal_id,producer_id,native_fingerprint,archive_fingerprint,connection_revision,kind,sequence,seal_id,digest,record,captured_at,received_at,receipt_id,gap_reason,remaining_rows,remaining_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
      [
        id,
        grant.sourceId,
        grant.journalId,
        grant.producerId,
        native.fingerprint,
        grant.fingerprint,
        current.connection.revision,
        record.kind,
        record.kind === 'entry' ? record.sequence : null,
        record.kind === 'seal' ? record.seal_id : null,
        record.digest,
        JSON.stringify(record),
        record.kind === 'entry' ? record.captured_at : null,
        received,
        receiptId,
        gap,
        count(remaining.remaining_rows),
        count(remaining.remaining_bytes),
      ],
    );
    if (record.kind === 'entry')
      await client.query(
        'UPDATE argo_archive_journals SET last_sequence=$3,last_digest=$4,last_capture_at=$5 WHERE source_id=$1 AND journal_id=$2',
        [grant.sourceId, grant.journalId, record.sequence, record.digest, record.captured_at],
      );
    else
      await client.query(
        'UPDATE argo_archive_journals SET sealed_sequence=$3,sealed_end=$4 WHERE source_id=$1 AND journal_id=$2',
        [grant.sourceId, grant.journalId, record.last_sequence, record.end],
      );
    check();
    return acknowledgment({
      id,
      receipt_id: receiptId,
      gap_reason: gap,
      observed: received,
      ...remaining,
    });
  });
}
function acknowledgment(row: Record<string, unknown>) {
  return {
    remainingRows: count(row.remaining_rows),
    remainingBytes: count(row.remaining_bytes),
    archiveRecordId: uuid(row.id),
    receiptId: row.receipt_id === null ? null : uuid(row.receipt_id),
    gapReason: row.gap_reason === null ? null : text(row.gap_reason),
    observedAt: timestamp(row.observed),
  };
}
async function validateSeal(
  client: PoolClient,
  grant: ArgoArchiveGrant,
  record: Extract<ArchiveRecord, { kind: 'seal' }>,
  journal: Record<string, unknown>,
  received: string,
) {
  const previous = storedCount(journal.sealed_sequence),
    start = instant(record.start),
    end = instant(record.end);
  if (
    start < instant(record.startup_at) ||
    end > instant(received) ||
    (journal.sealed !== null && start < instant(timestamp(journal.sealed))) ||
    record.first_sequence !== previous + 1 ||
    record.last_sequence > storedCount(journal.last_sequence) ||
    record.last_sequence < previous ||
    record.entry_count !== record.last_sequence - previous
  )
    throw new IdentityError(409, 'conflict');
  const entries = await client.query<Record<string, unknown>>(
    `SELECT sequence,digest,to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured FROM argo_archive_records WHERE source_id=$1 AND journal_id=$2 AND kind='entry' AND sequence BETWEEN $3 AND $4 ORDER BY sequence`,
    [grant.sourceId, grant.journalId, record.first_sequence, record.last_sequence + 1],
  );
  const covered = entries.rows.filter((r) => storedCount(r.sequence) <= record.last_sequence);
  if (
    covered.length !== record.entry_count ||
    covered.some(
      (r) => instant(timestamp(r.captured)) < start || instant(timestamp(r.captured)) >= end,
    ) ||
    entries.rows.some(
      (r) =>
        storedCount(r.sequence) === record.last_sequence + 1 &&
        instant(timestamp(r.captured)) < end,
    )
  )
    throw new IdentityError(409, 'conflict');
  const last =
    record.last_sequence === 0
      ? '0'.repeat(64)
      : (
          await client.query<Record<string, unknown>>(
            'SELECT digest FROM argo_archive_records WHERE source_id=$1 AND journal_id=$2 AND sequence=$3',
            [grant.sourceId, grant.journalId, record.last_sequence],
          )
        ).rows[0]?.digest;
  if (last !== record.last_digest) throw new IdentityError(409, 'conflict');
  for (const i of record.interruptions)
    if (instant(i.start) < start || instant(i.end) > end) throw new IdentityError(409, 'conflict');
}
async function importNative(
  client: PoolClient,
  native: NonNullable<ReturnType<typeof grantFor>>,
  revision: number,
  archive: ArgoArchiveGrant,
  record: Extract<ArchiveRecord, { kind: 'entry' }>,
  received: string,
  authorityId: string,
): Promise<{ receiptId: string | null; gap: string | null }> {
  const scope = scopeFor(native);
  let notification: ArgoNotification, key: string;
  try {
    key = argoNotificationDigest(record.notification, scope);
    notification = parseHistoricalArgoNotification(
      record.notification,
      scope,
      record.captured_at,
      received,
    );
  } catch (error) {
    return {
      receiptId: null,
      gap:
        error instanceof AdapterError && error.code === 'argo_scope_drift'
          ? 'payload_scope'
          : 'payload_invalid',
    };
  }
  const metadata = operationMetadata(notification);
  if (metadata) {
    const found = await client.query<Record<string, unknown>>(
      'SELECT metadata_digest FROM argo_operation_metadata WHERE source_id=$1 AND application_uid=$2 AND operation_id=$3',
      [native.sourceId, native.applicationUid, metadata.operationId],
    );
    if (found.rows[0] && found.rows[0].metadata_digest !== metadata.digest)
      return { receiptId: null, gap: 'payload_metadata' };
  }
  if (notification.kind === 'gap') {
    if (metadata) {
      const found = await client.query(
        'SELECT operation_id FROM argo_operation_metadata WHERE source_id=$1 AND application_uid=$2 AND operation_id=$3',
        [native.sourceId, native.applicationUid, metadata.operationId],
      );
      if (!found.rowCount) {
        await reserve(
          client,
          native.sourceId,
          1,
          (await jsonBytes(client, {
            sourceId: native.sourceId,
            applicationUid: native.applicationUid,
            operationId: metadata.operationId,
            digest: metadata.digest,
          })) + 1024,
        );
        await client.query(
          'INSERT INTO argo_operation_metadata(source_id,application_uid,operation_id,metadata_digest) VALUES($1,$2,$3,$4)',
          [native.sourceId, native.applicationUid, metadata.operationId, metadata.digest],
        );
      }
    }
    return {
      receiptId: null,
      gap:
        notification.reason === 'future_timestamp' || notification.reason === 'observation_horizon'
          ? 'payload_temporal'
          : notification.reason,
    };
  }
  const existing = await client.query<Record<string, unknown>>(
    'SELECT id,grant_fingerprint,digest,canonical_json FROM argo_receipts WHERE source_id=$1 AND application_uid=$2 AND operation_id=$3 AND notification_revision=$4 AND evidence IS NOT NULL',
    [
      native.sourceId,
      native.applicationUid,
      notification.operationId,
      notification.notificationRevision,
    ],
  );
  const old = existing.rows[0];
  if (old && old.grant_fingerprint !== native.fingerprint)
    return { receiptId: null, gap: 'cross_native_fingerprint' };
  if (old && old.canonical_json !== notification.canonicalJson)
    return { receiptId: null, gap: 'payload_metadata' };
  const previousDigest = await client.query<Record<string, unknown>>(
    'SELECT id,evidence FROM argo_receipts WHERE source_id=$1 AND grant_fingerprint=$2 AND digest=$3',
    [native.sourceId, native.fingerprint, key],
  );
  // A retained live gap has no native operation identity. Keep that immutable diagnostic;
  // reserve a distinct storage key for the historically eligible canonical operation.
  const storageKey =
    !old && previousDigest.rows[0] ? digest(`clio:argo:archive-native:v1:${key}`) : key;
  let receiptId: string;
  if (old) receiptId = uuid(old.id);
  else {
    const combos = await client.query<Record<string, unknown>>(
      'SELECT phase,health FROM argo_receipts WHERE source_id=$1 AND application_uid=$2 AND operation_id=$3 AND evidence IS NOT NULL',
      [native.sourceId, native.applicationUid, notification.operationId],
    );
    if (combos.rows.some((r) => r.phase === notification.phase && r.health === notification.health))
      return { receiptId: null, gap: 'status_combination_repeated' };
    if (combos.rows.length >= 30) return { receiptId: null, gap: 'status_combination_limit' };
    const evidence = parseEvidence(notification.evidence, scope);
    const bytes =
      Buffer.byteLength(notification.canonicalJson) +
      (await jsonBytes(client, evidence)) +
      (await jsonBytes(client, {
        scope,
        key,
        received,
        revision,
        operationId: notification.operationId,
      })) +
      2048 +
      2 * Buffer.byteLength(JSON.stringify(evidence));
    await reserve(
      client,
      native.sourceId,
      1 + evidence.deployments.length + evidence.statuses.length,
      bytes,
    );
    if (metadata) {
      const exists = await client.query(
        'SELECT operation_id FROM argo_operation_metadata WHERE source_id=$1 AND application_uid=$2 AND operation_id=$3',
        [native.sourceId, native.applicationUid, metadata.operationId],
      );
      if (!exists.rowCount) {
        await reserve(
          client,
          native.sourceId,
          1,
          (await jsonBytes(client, {
            sourceId: native.sourceId,
            applicationUid: native.applicationUid,
            operationId: metadata.operationId,
            digest: metadata.digest,
          })) + 1024,
        );
        await client.query(
          'INSERT INTO argo_operation_metadata(source_id,application_uid,operation_id,metadata_digest) VALUES($1,$2,$3,$4)',
          [native.sourceId, native.applicationUid, metadata.operationId, metadata.digest],
        );
      }
    }
    receiptId = randomUUID();
    await client.query(
      `INSERT INTO argo_receipts(id,source_id,workspace_id,service_id,connection_revision,application_uid,grant_fingerprint,scope,digest,observed_at,started_at,operation_id,notification_revision,phase,health,reason,canonical_json,evidence,origin_transport) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NULL,$16,$17,'archive')`,
      [
        receiptId,
        native.sourceId,
        native.workspaceId,
        native.serviceId,
        revision,
        native.applicationUid,
        native.fingerprint,
        JSON.stringify(scope),
        storageKey,
        received,
        notification.startedAt,
        notification.operationId,
        notification.notificationRevision,
        notification.phase,
        notification.health,
        notification.canonicalJson,
        JSON.stringify(evidence),
      ],
    );
  }
  await reserve(client, native.sourceId, 1, 1536);
  await client.query(
    "INSERT INTO argo_receipt_authorities(receipt_id,kind,authority_id,native_fingerprint,archive_fingerprint,journal_id,producer_id,observed_at) VALUES($1,'archive',$2,$3,$4,$5,$6,$7)",
    [
      receiptId,
      authorityId,
      native.fingerprint,
      archive.fingerprint,
      archive.journalId,
      archive.producerId,
      received,
    ],
  );
  return { receiptId, gap: null };
}

function storedCount(value: unknown): number {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return count(Number(value));
  return count(value);
}

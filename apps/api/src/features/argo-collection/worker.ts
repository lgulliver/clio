import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.ts';
import { storedRevision } from '../github-collection/db-value.ts';
import { snapshotDigest } from '../github-collection/digest.ts';
import { name, uuid } from '../identity/input.ts';
import { eligibleArchive } from './archive-grants.ts';
import { archiveSummary } from './archive-summary.ts';
import { captureArgo } from './capture.ts';
import { type ArgoConfig, grantFor, parseScope, scopeFor } from './config.ts';
import { eligibleProducers } from './enrichment-grants.ts';
import { parseEnrichmentReceipt } from './enrichment-ingress.ts';
import { boundedJson, maxBytes, maxRows, mergeHistory, parseEvidence } from './history.ts';
import { databaseTime } from './ingress.ts';
import { count, parseConnection, timestamp } from './input.ts';
import { ensureSource, latestConnection } from './repository.ts';
import { gapReasons, storedWindow } from './result.ts';
export const leaseSeconds = 120;
interface Claim {
  id: string;
  token: string;
  workspaceId: string;
  serviceId: string;
}
interface WorkerDependencies {
  configNow?: () => ArgoConfig | null;
}
class LeaseLost extends Error {}
class Revoked extends Error {}
export function createArgoWorker(
  pool: Pool,
  argo: ArgoConfig | null,
  dependencies: WorkerDependencies = {},
) {
  const configNow = dependencies.configNow ?? (() => argo);
  async function current(client: PoolClient, claim: Claim) {
    // Same workspace-first lock order as connection writes, then lease row.
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [claim.workspaceId]);
    const found = await client.query<Record<string, unknown>>(
      `SELECT * FROM argo_collection_runs WHERE id=$1 AND workspace_id=$3 AND service_id=$4 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE`,
      [claim.id, claim.token, claim.workspaceId, claim.serviceId],
    );
    const row = found.rows[0];
    if (!row) throw new LeaseLost();
    const connection = parseConnection(row.connection_input),
      window = storedWindow(row.window_input),
      serviceName = name(row.service_name);
    if (
      connection.workspaceId !== claim.workspaceId ||
      connection.serviceId !== claim.serviceId ||
      storedRevision(row.connection_revision) !== connection.revision ||
      !connection.active
    )
      throw new Error('Invalid captured connection');
    const latest = await latestConnection(client, connection.workspaceId, connection.serviceId),
      config = configNow();
    const grant = grantFor(
      config,
      connection.sourceId,
      connection.workspaceId,
      connection.serviceId,
    );
    const archive = latest ? eligibleArchive(config, connection, latest.archive) : undefined;
    const producers = latest ? eligibleProducers(config, connection, latest.producers) : null;
    if (
      archive === undefined ||
      producers === null ||
      !config ||
      !grant ||
      grant.fingerprint !== row.grant_fingerprint ||
      latest?.fingerprint !== grant.fingerprint ||
      !latest.connection.active ||
      !isDeepStrictEqual(latest.connection, connection) ||
      !isDeepStrictEqual(latest.scope, scopeFor(grant))
    )
      throw new Revoked();
    return { connection, window, serviceName, config, grant, producers, archive };
  }
  async function locked<T>(
    claim: Claim,
    operation: (client: PoolClient, input: Awaited<ReturnType<typeof current>>) => Promise<T>,
  ) {
    return withTransaction(pool, async (client) => operation(client, await current(client, claim)));
  }
  const worker = {
    async claim(): Promise<Claim | null> {
      return withTransaction(pool, async (client) => {
        const expired = await client.query(
          `WITH expired AS (SELECT id FROM argo_collection_runs WHERE status='running' AND lease_until<=clock_timestamp() AND attempts=3 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE argo_collection_runs SET status='failed',failure_code='argo_processing_failed',completed_at=statement_timestamp(),updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id IN (SELECT id FROM expired)`,
        );
        if (expired.rowCount) return null;
        const token = randomUUID();
        const found = await client.query<Record<string, unknown>>(
          `WITH eligible AS (SELECT id FROM argo_collection_runs WHERE attempts<3 AND ((status='pending' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<=clock_timestamp())) ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE argo_collection_runs SET status='running',attempts=attempts+1,lease_token=$1,lease_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() WHERE id IN (SELECT id FROM eligible) RETURNING id,workspace_id,service_id`,
          [token],
        );
        const row = found.rows[0];
        return row
          ? {
              id: uuid(row.id),
              token,
              workspaceId: uuid(row.workspace_id),
              serviceId: uuid(row.service_id),
            }
          : null;
      });
    },
    preflight(claim: Claim) {
      return locked(claim, async (_client, input) => input);
    },
    async complete(claim: Claim) {
      try {
        return await locked(claim, async (client, input) => {
          const state = await ensureSource(client, input.grant);
          if (count(state.retained_rows) > maxRows || count(state.retained_bytes) > maxBytes)
            throw new Error('Argo storage limit');
          const time = await client.query<Record<string, unknown>>(
              `SELECT ${databaseTime} AS observed`,
            ),
            cutoff = timestamp(time.rows[0]?.observed);
          const scope = scopeFor(input.grant);
          const found = await client.query<Record<string, unknown>>(
            `SELECT r.evidence,r.reason,r.scope,to_char(a.available AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS available FROM argo_receipts r JOIN LATERAL (SELECT observed_at AS available FROM argo_receipt_authorities WHERE receipt_id=r.id AND native_fingerprint=$4 AND observed_at<=$5 AND (kind='live' OR (archive_fingerprint=$6 AND journal_id=$7 AND producer_id=$8)) UNION ALL SELECT r.observed_at WHERE r.origin_transport='live' AND r.observed_at<=$5 ORDER BY available LIMIT 1) a ON true WHERE r.source_id=$1 AND r.workspace_id=$2 AND r.service_id=$3 AND r.grant_fingerprint=$4 ORDER BY a.available,r.id LIMIT 5001`,
            [
              input.grant.sourceId,
              input.connection.workspaceId,
              input.connection.serviceId,
              input.grant.fingerprint,
              cutoff,
              input.archive?.fingerprint ?? null,
              input.archive?.journalId ?? null,
              input.archive?.producerId ?? null,
            ],
          );
          if (found.rows.length > maxRows) throw new Error('Argo storage limit');
          const batches = [];
          const reasons: Record<string, number> = {};
          let retainedEvidenceCount = 0;
          for (const row of found.rows) {
            if (!isDeepStrictEqual(parseScope(row.scope), scope))
              throw new Error('Argo scope mismatch');
            if (row.reason !== null) {
              if (typeof row.reason !== 'string' || !gapReasons.some((r) => r === row.reason))
                throw new Error('Invalid gap');
              reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
            } else {
              const batch = parseEvidence(row.evidence, scope);
              const observedAt = timestamp(row.available);
              batches.push({
                deployments: batch.deployments.map((r) => ({
                  ...r,
                  observedAt,
                })),
                statuses: batch.statuses.map((r) => ({
                  ...r,
                  observedAt,
                })),
              });
              retainedEvidenceCount += batch.deployments.length + batch.statuses.length;
            }
          }
          const enrichmentRows = await client.query<Record<string, unknown>>(
            `SELECT *,to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed FROM argo_enrichment_receipts WHERE source_id=$1 AND workspace_id=$2 AND service_id=$3 AND native_fingerprint=$4 AND observed_at<=$5 ORDER BY producer_id,event_id LIMIT 5001`,
            [
              input.grant.sourceId,
              input.connection.workspaceId,
              input.connection.serviceId,
              input.grant.fingerprint,
              cutoff,
            ],
          );
          if (enrichmentRows.rows.length > maxRows) throw new Error('Argo storage limit');
          const argoEnrichments = enrichmentRows.rows.flatMap((row) => {
            const producer = input.producers.find(
              (p) => p.producerId === row.producer_id && p.fingerprint === row.producer_fingerprint,
            );
            return producer ? [parseEnrichmentReceipt(row, producer, input.grant.fingerprint)] : [];
          });
          const boundaries = await client.query<Record<string, unknown>>(
            'SELECT count(*)::int AS count FROM argo_interruptions WHERE source_id=$1 AND grant_fingerprint=$2 AND observed_at<=$3',
            [input.grant.sourceId, input.grant.fingerprint, cutoff],
          );
          const interruptions = count(boundaries.rows[0]?.count);
          if (interruptions)
            reasons.connection_interruption =
              (reasons.connection_interruption ?? 0) + interruptions;
          const first = await client.query<Record<string, unknown>>(
            `SELECT to_char(first_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed FROM argo_source_state WHERE source_id=$1`,
            [input.grant.sourceId],
          );
          const archiveLineageRows = input.archive
            ? await client.query<Record<string, unknown>>(
                `SELECT receipt_id,sequence::text AS sequence,to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed,to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured FROM argo_archive_records WHERE source_id=$1 AND native_fingerprint=$2 AND archive_fingerprint=$3 AND journal_id=$4 AND producer_id=$5 AND received_at<=$6 AND receipt_id IS NOT NULL ORDER BY sequence LIMIT 5001`,
                [
                  input.grant.sourceId,
                  input.grant.fingerprint,
                  input.archive.fingerprint,
                  input.archive.journalId,
                  input.archive.producerId,
                  cutoff,
                ],
              )
            : null;
          if (archiveLineageRows && archiveLineageRows.rows.length > maxRows)
            throw new Error('Archive storage limit');
          const archiveLineages = archiveLineageRows?.rows.map((row) => ({
            receiptId: uuid(row.receipt_id),
            sourceRef: `urn:clio:argo-archive:${input.archive?.producerId}:${input.archive?.journalId}:${storedRevision(row.sequence)}`,
            observedAt: timestamp(row.observed),
            capturedAt: timestamp(row.captured),
          }));
          const capture = captureArgo({
            runId: claim.id,
            ...input,
            evidence: mergeHistory(batches),
            argoEnrichments,
            databaseObservedAt: cutoff,
            ...(archiveLineages ? { archiveLineages } : {}),
            ...(input.archive
              ? { archiveSummary: await archiveSummary(client, input.archive, cutoff) }
              : {}),
            stats: {
              retainedReceiptCount: found.rows.length,
              retainedEvidenceCount,
              recordedGapCount: Object.values(reasons).reduce((a, b) => a + b, 0),
              gapReasons: reasons,
              rejectionCount: count(state.rejection_count),
              scopeDriftCount: count(state.scope_drift_count),
              observationPeriod: {
                start: first.rows[0]?.observed === null ? null : timestamp(first.rows[0]?.observed),
                end: cutoff,
              },
            },
          });
          const digest = snapshotDigest({
            connection: input.connection,
            serviceName: input.serviceName,
            ...capture,
          });
          await client.query(
            'INSERT INTO argo_collection_snapshots(run_id,workspace_id,service_id,connection_revision,connection_input,service_name,evidence,snapshot,metrics,oems_revision,public_result,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [
              claim.id,
              input.connection.workspaceId,
              input.connection.serviceId,
              input.connection.revision,
              JSON.stringify(input.connection),
              input.serviceName,
              boundedJson(capture.evidence),
              boundedJson(capture.snapshot),
              boundedJson(capture.metrics),
              capture.oemsRevision,
              JSON.stringify(capture.result),
              digest,
            ],
          );
          const freshConfig = configNow();
          const fresh = grantFor(
            freshConfig,
            input.connection.sourceId,
            input.connection.workspaceId,
            input.connection.serviceId,
          );
          if (
            fresh?.fingerprint !== input.grant.fingerprint ||
            eligibleArchive(
              freshConfig,
              input.connection,
              (
                await latestConnection(
                  client,
                  input.connection.workspaceId,
                  input.connection.serviceId,
                )
              )?.archive ?? null,
            ) === undefined ||
            eligibleProducers(
              freshConfig,
              input.connection,
              (
                await latestConnection(
                  client,
                  input.connection.workspaceId,
                  input.connection.serviceId,
                )
              )?.producers ?? [],
            ) === null
          )
            throw new Revoked();
          const done = await client.query(
            `WITH stamp AS(SELECT GREATEST(clock_timestamp(),$4::timestamptz) AS t) UPDATE argo_collection_runs SET status='succeeded',result=$3,completed_at=stamp.t,updated_at=stamp.t,lease_token=NULL,lease_until=NULL FROM stamp WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp()`,
            [claim.id, claim.token, JSON.stringify(capture.result), cutoff],
          );
          if (!done.rowCount) throw new LeaseLost();
          return true;
        });
      } catch (error) {
        if (error instanceof LeaseLost) return false;
        throw error;
      }
    },
    async fail(claim: Claim, delay = 1, revoked = false) {
      const result = await pool.query(
        `UPDATE argo_collection_runs SET status=CASE WHEN attempts=3 OR $4 THEN 'failed' ELSE 'pending' END,failure_code=CASE WHEN $4 THEN 'argo_connection_revoked' WHEN attempts=3 THEN 'argo_processing_failed' ELSE NULL END,completed_at=CASE WHEN attempts=3 OR $4 THEN statement_timestamp() ELSE NULL END,available_at=clock_timestamp()+$3*interval '1 second',updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp()`,
        [
          claim.id,
          claim.token,
          Math.min(300, Math.max(1, Math.ceil(Number.isFinite(delay) ? delay : 1))),
          revoked,
        ],
      );
      return Boolean(result.rowCount);
    },
    async runOnce(): Promise<boolean> {
      const claim = await worker.claim();
      if (!claim) return false;
      try {
        await worker.complete(claim);
      } catch (error) {
        await worker.fail(claim, 1, error instanceof Revoked);
      }
      return true;
    },
  };
  return worker;
}

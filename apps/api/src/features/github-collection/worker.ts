import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AdapterError, type GitHubBatch, GitHubRateLimitError } from '@clio/adapters';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.ts';
import { name, uuid } from '../identity/input.ts';
import { captureGitHub } from './capture.ts';
import { type GitHubConfig, grantFor } from './config.ts';
import { storedRevision } from './db-value.ts';
import { abortable } from './deadline.ts';
import { snapshotDigest } from './digest.ts';
import {
  boundedJson,
  historyRecords,
  maxHistoryRecords,
  maxStoredBytes,
  mergeHistory,
  parseEvidence,
} from './history.ts';
import { instant, parseConnection, timestamp } from './input.ts';
import { createGitHubProvider, type GitHubProvider } from './provider.ts';
import {
  ensureQuota,
  pauseQuota,
  type QuotaLease,
  quotaRetryDelay,
  releaseQuota,
  retryDelay,
} from './quota.ts';
import { latestConnection } from './repository.ts';
import { storedWindow } from './result.ts';

export const leaseSeconds = 120;
export const acquisitionMs = 60000;
interface Claim {
  id: string;
  token: string;
  workspaceId: string;
  serviceId: string;
  quota: QuotaLease;
}
interface WorkerDependencies {
  provider?: GitHubProvider;
  clock?: () => Date;
  configNow?: () => GitHubConfig | null;
  acquisitionBudgetMs?: number;
}
class LeaseLost extends Error {}
class Revoked extends Error {}
class Retry extends Error {
  readonly delay: number;
  readonly providerThrottle: boolean;
  constructor(delay: number, providerThrottle = false) {
    super('GitHub acquisition incomplete');
    this.delay = delay;
    this.providerThrottle = providerThrottle;
  }
}

export function createGitHubWorker(
  pool: Pool,
  github: GitHubConfig | null,
  dependencies: WorkerDependencies = {},
) {
  const configNow = dependencies.configNow ?? (() => github);
  async function current(client: PoolClient, claim: Claim) {
    // Same workspace-first lock order as connection writes, then lease row.
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [claim.workspaceId]);
    const found = await client.query<Record<string, unknown>>(
      `SELECT * FROM github_collection_runs WHERE id=$1 AND workspace_id=$3 AND service_id=$4 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE`,
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
      connection.workspaceId,
      connection.installationId,
      connection.repositoryId,
    );
    if (
      !config ||
      !grant ||
      grant.fingerprint !== row.grant_fingerprint ||
      latest?.fingerprint !== grant.fingerprint ||
      !latest.connection.active ||
      !isDeepStrictEqual(latest.connection, connection)
    )
      throw new Revoked();
    return { connection, window, serviceName, config, grant };
  }
  async function locked<T>(
    claim: Claim,
    operation: (client: PoolClient, input: Awaited<ReturnType<typeof current>>) => Promise<T>,
  ) {
    return withTransaction(pool, async (client) => operation(client, await current(client, claim)));
  }
  return {
    async claim(): Promise<Claim | null> {
      return withTransaction(pool, async (client) => {
        const expired = await client.query(
          `WITH expired AS (SELECT id FROM github_collection_runs WHERE status='running' AND lease_until<=clock_timestamp() AND attempts=3 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE github_collection_runs SET status='failed',failure_code='github_processing_failed',completed_at=statement_timestamp(),updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id IN (SELECT id FROM expired)`,
        );
        if (expired.rowCount) return null;
        const config = configNow();
        if (!config) {
          await client.query(
            "WITH revoked AS (SELECT id FROM github_collection_runs WHERE status IN ('pending','running') ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE github_collection_runs SET status='failed',failure_code='github_connection_revoked',completed_at=statement_timestamp(),updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id IN (SELECT id FROM revoked)",
          );
          return null;
        }
        await ensureQuota(client, config.appId, 0);
        for (const grant of config.grants)
          await ensureQuota(client, config.appId, grant.installationId);
        await client.query(
          "INSERT INTO github_quota_state(app_id,installation_id) SELECT DISTINCT $1::bigint,(connection_input->>'installationId')::bigint FROM github_collection_runs WHERE status IN ('pending','running') ON CONFLICT DO NOTHING",
          [config.appId],
        );
        const token = randomUUID();
        const found = await client.query<Record<string, unknown>>(
          `WITH eligible AS (SELECT r.id FROM github_collection_runs r JOIN github_quota_state q ON q.app_id=$2 AND q.installation_id=(r.connection_input->>'installationId')::bigint WHERE r.attempts<3 AND ((r.status='pending' AND r.available_at<=clock_timestamp()) OR (r.status='running' AND r.lease_until<=clock_timestamp())) AND q.blocked_until<=clock_timestamp() AND (q.lease_until IS NULL OR q.lease_until<=clock_timestamp()) AND EXISTS(SELECT 1 FROM github_quota_state WHERE app_id=$2 AND installation_id=0 AND blocked_until<=clock_timestamp()) ORDER BY r.available_at,r.created_at,r.id FOR UPDATE OF r,q SKIP LOCKED LIMIT 1) UPDATE github_collection_runs SET status='running',attempts=attempts+1,quota_app_id=$2,lease_token=$1,lease_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() WHERE id IN (SELECT id FROM eligible) RETURNING id,workspace_id,service_id,connection_input`,
          [token, config.appId],
        );
        const row = found.rows[0];
        const installationId = row ? parseConnection(row.connection_input).installationId : null;
        if (installationId !== null)
          await client.query(
            "UPDATE github_quota_state SET lease_token=$3,lease_until=clock_timestamp()+interval '120 seconds' WHERE app_id=$1 AND installation_id=$2",
            [config.appId, installationId, token],
          );
        return row && installationId !== null
          ? {
              id: uuid(row.id),
              token,
              workspaceId: uuid(row.workspace_id),
              serviceId: uuid(row.service_id),
              quota: { appId: config.appId, installationId, token },
            }
          : null;
      });
    },
    preflight(claim: Claim) {
      return locked(claim, async (_client, input) => input);
    },
    async complete(
      claim: Claim,
      batch: GitHubBatch,
      acquiredAt: string,
      signal?: AbortSignal,
      quotaObserved = false,
    ) {
      const limits = batch.diagnostics.filter(
        (d) => d.code === 'rate_limited' || d.retryAfterSeconds !== null,
      );
      let delay: number | null = null;
      if (limits.length && quotaObserved) delay = await quotaRetryDelay(pool, claim.quota);
      else if (limits.length)
        delay = await pauseQuota(
          pool,
          claim.quota,
          Math.max(...limits.map((d) => d.retryAfterSeconds ?? 0)) || null,
        );
      try {
        return await locked(claim, async (client, input) => {
          if (signal?.aborted) throw new LeaseLost();
          const scope = [
            input.connection.workspaceId,
            input.connection.serviceId,
            input.connection.installationId,
            input.connection.repositoryId,
          ];
          const totals = await client.query<Record<string, unknown>>(
            'SELECT count(*)::int AS count,coalesce(sum(octet_length(payload::text)),0)::text AS bytes FROM github_collection_history WHERE workspace_id=$1 AND service_id=$2 AND installation_id=$3 AND repository_id=$4',
            scope,
          );
          if (
            Number(totals.rows[0]?.count) > maxHistoryRecords ||
            Number(totals.rows[0]?.bytes) > maxStoredBytes
          )
            throw new Error('Stored history limit');
          const history = await client.query<Record<string, unknown>>(
            'SELECT kind,payload FROM github_collection_history WHERE workspace_id=$1 AND service_id=$2 AND installation_id=$3 AND repository_id=$4 ORDER BY kind,record_key,observed_at LIMIT 5001',
            scope,
          );
          const previous = parseEvidence(
            {
              deployments: history.rows
                .filter((r) => r.kind === 'deployment')
                .map((r) => r.payload),
              statuses: history.rows.filter((r) => r.kind === 'status').map((r) => r.payload),
              completedStatusTraversals: history.rows
                .filter((r) => r.kind === 'traversal')
                .map((r) => r.payload),
            },
            input.connection,
          );
          const acquired = parseEvidence(
            {
              deployments: batch.deployments,
              statuses: batch.statuses,
              completedStatusTraversals: batch.completedStatusTraversals ?? [],
            },
            input.connection,
          );
          if (typeof batch.transportComplete !== 'boolean')
            throw new Error('Invalid transport completion');
          // Conflict diagnostics fail closed even if earlier pages were accepted.
          if (batch.diagnostics.some((d) => d.code === 'conflicting_source_record'))
            throw new Error('Conflicting source record');
          const evidence = mergeHistory(previous, acquired);
          if (!batch.transportComplete && evidence.deployments.length === 0)
            throw new Retry(delay ?? retryDelay(null), limits.length > 0);
          const time = await client.query<Record<string, unknown>>(
            `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed`,
          );
          const databaseObservedAt = timestamp(time.rows[0]?.observed);
          const capture = captureGitHub({
            runId: claim.id,
            ...input,
            evidence,
            transportComplete: batch.transportComplete,
            acquiredAt: timestamp(acquiredAt),
            databaseObservedAt,
          });
          const oldRecords = new Map(
            historyRecords(
              mergeHistory(
                { deployments: [], statuses: [], completedStatusTraversals: [] },
                previous,
              ),
            ).map((r) => [`${r.kind}:${r.key}`, r.record]),
          );
          // A repeated traversal need not create a new history row once the
          // retained deployment/status observations are already covered. The
          // immutable snapshot still records this run's actual traversal time.
          const relevantObservations = new Map<string, bigint>();
          for (const record of evidence.deployments) {
            const old = relevantObservations.get(record.id) ?? -1n;
            relevantObservations.set(
              record.id,
              instant(record.observedAt) > old ? instant(record.observedAt) : old,
            );
          }
          for (const record of evidence.statuses) {
            const old = relevantObservations.get(record.deploymentId) ?? -1n;
            relevantObservations.set(
              record.deploymentId,
              instant(record.observedAt) > old ? instant(record.observedAt) : old,
            );
          }
          let insertedBytes = Number(totals.rows[0]?.bytes),
            insertedCount = Number(totals.rows[0]?.count);
          for (const entry of historyRecords(evidence)) {
            const old = oldRecords.get(`${entry.kind}:${entry.key}`);
            if (
              old &&
              (entry.kind === 'traversal'
                ? instant(old.observedAt) >=
                  (relevantObservations.get(entry.key) ?? instant(entry.record.observedAt))
                : instant(old.observedAt) <= instant(entry.record.observedAt))
            )
              continue;
            const payload = boundedJson(entry.record);
            insertedBytes += Buffer.byteLength(payload) * 2; // Conservative JSONB whitespace/escaping budget.
            if (++insertedCount > maxHistoryRecords || insertedBytes > maxStoredBytes)
              throw new Error('Stored history limit');
            await client.query(
              'INSERT INTO github_collection_history(workspace_id,service_id,installation_id,repository_id,kind,record_key,observed_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
              [...scope, entry.kind, entry.key, entry.record.observedAt, payload],
            );
          }
          const digest = snapshotDigest({
            connection: input.connection,
            serviceName: input.serviceName,
            ...capture,
          });
          await client.query(
            `INSERT INTO github_collection_snapshots(run_id,workspace_id,service_id,connection_revision,connection_input,service_name,evidence,snapshot,metrics,oems_revision,public_result,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
          if (signal?.aborted) throw new LeaseLost();
          // Current in-memory grants are rechecked immediately before terminal write too.
          const config = configNow(),
            grant = grantFor(
              config,
              input.connection.workspaceId,
              input.connection.installationId,
              input.connection.repositoryId,
            );
          if (!grant || grant.fingerprint !== input.grant.fingerprint) throw new Revoked();
          const done = await client.query(
            `WITH stamp AS (SELECT GREATEST(clock_timestamp(),$4::timestamptz) AS t) UPDATE github_collection_runs SET status='succeeded',result=$3,completed_at=stamp.t,updated_at=stamp.t,lease_token=NULL,lease_until=NULL FROM stamp WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp()`,
            [claim.id, claim.token, JSON.stringify(capture.result), capture.result.evidenceCutoff],
          );
          if (!done.rowCount) throw new LeaseLost();
          return true;
        });
      } catch (error) {
        if (error instanceof LeaseLost) return false;
        throw error;
      } finally {
        await releaseQuota(pool, claim.quota);
      }
    },
    async deferQuota(claim: Claim) {
      const delay = await quotaRetryDelay(pool, claim.quota);
      const result = await pool.query(
        `UPDATE github_collection_runs SET status='pending',attempts=attempts-1,available_at=CASE WHEN $3::double precision>2147483647 THEN 'infinity'::timestamptz ELSE clock_timestamp()+$3*interval '1 second' END,updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp() AND quota_app_id=$4 AND EXISTS(SELECT 1 FROM github_quota_state WHERE app_id=$4 AND installation_id IN (0,$5) AND blocked_until>clock_timestamp())`,
        [claim.id, claim.token, delay, claim.quota.appId, claim.quota.installationId],
      );
      if (result.rowCount) await releaseQuota(pool, claim.quota);
      return Boolean(result.rowCount);
    },
    async fail(claim: Claim, delay: number | null = null, revoked = false) {
      const attempt = await pool.query<Record<string, unknown>>(
        'SELECT attempts FROM github_collection_runs WHERE id=$1 AND lease_token=$2',
        [claim.id, claim.token],
      );
      const result = await pool.query(
        `UPDATE github_collection_runs SET status=CASE WHEN attempts=3 OR $4 THEN 'failed' ELSE 'pending' END,failure_code=CASE WHEN $4 THEN 'github_connection_revoked' WHEN attempts=3 THEN 'github_processing_failed' ELSE NULL END,completed_at=CASE WHEN attempts=3 OR $4 THEN statement_timestamp() ELSE NULL END,available_at=CASE WHEN $3::double precision>2147483647 THEN 'infinity'::timestamptz ELSE clock_timestamp()+$3*interval '1 second' END,updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp()`,
        [
          claim.id,
          claim.token,
          delay ?? retryDelay(null, Number(attempt.rows[0]?.attempts ?? 1)),
          revoked,
        ],
      );
      await releaseQuota(pool, claim.quota);
      return Boolean(result.rowCount);
    },
  };
}

/** Provider acquisition happens between short claim/preflight and atomic completion transactions. */
export async function processOne(
  pool: Pool,
  github: GitHubConfig | null,
  dependencies: WorkerDependencies & { signal?: AbortSignal } = {},
) {
  if (dependencies.signal?.aborted) return false;
  const worker = createGitHubWorker(pool, github, dependencies),
    claim = await worker.claim();
  if (!claim) return false;
  const budget = dependencies.acquisitionBudgetMs ?? acquisitionMs;
  if (!Number.isInteger(budget) || budget < 100 || budget > acquisitionMs)
    throw new Error('Invalid acquisition budget');
  const started = performance.now();
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(budget)])
    : AbortSignal.timeout(budget);
  let provider = dependencies.provider;
  try {
    const input = await worker.preflight(claim);
    provider ??= createGitHubProvider(pool, input.config, claim.quota);
    const clock = dependencies.clock ?? (() => new Date());
    if (signal.aborted) throw new Error('Acquisition cancelled');
    const scope = await abortable(
      provider.verify({
        ...input,
        repositoryId: input.connection.repositoryId,
        clock,
        signal,
      }),
      signal,
    );
    if (signal.aborted || instant(timestamp(scope.expiresAt)) <= instant(clock().toISOString()))
      throw new Error('Credential expired');
    // Leave time for the adapter to return its accepted prefix before the hard deadline.
    const softBudget = Math.max(
      1,
      Math.floor(budget - (performance.now() - started) - Math.min(5000, budget / 4)),
    );
    const collectionSignal = AbortSignal.any([signal, AbortSignal.timeout(softBudget)]);
    const batch = await abortable(
      provider.collect({
        installationId: input.connection.installationId,
        repositoryId: input.connection.repositoryId,
        token: scope.token,
        clock,
        signal: collectionSignal,
      }),
      signal,
    );
    if (signal.aborted) throw new Error('Acquisition cancelled');
    await worker.complete(
      claim,
      batch,
      timestamp(clock().toISOString()),
      dependencies.signal,
      dependencies.provider === undefined,
    );
  } catch (error) {
    const canDefer =
      provider?.quotaContention?.() === true &&
      ((error instanceof Retry && !error.providerThrottle) ||
        (error instanceof AdapterError && error.code === 'transport_failed'));
    if (canDefer && (await worker.deferQuota(claim))) return true;
    const delay =
      error instanceof GitHubRateLimitError
        ? dependencies.provider === undefined
          ? await quotaRetryDelay(pool, claim.quota)
          : await pauseQuota(pool, claim.quota, error.retryAfterSeconds)
        : error instanceof Retry
          ? error.delay
          : null;
    await worker.fail(claim, delay, error instanceof Revoked);
  }
  return true;
}

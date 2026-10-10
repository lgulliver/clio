import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { githubRateLimit } from '@clio/adapters';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.ts';

export interface QuotaLease {
  appId: number;
  installationId: number;
  token: string;
}
export class QuotaUnavailable extends Error {
  constructor() {
    super('GitHub quota unavailable');
  }
}
export function retryDelay(providerDelay: number | null, failures = 1) {
  // Positive jitter is additive: never shorten a provider's minimum wait.
  const fallback = 60 * 2 ** Math.min(10, Math.max(0, failures - 1));
  return Math.max(60, providerDelay ?? fallback) + randomInt(1, 16);
}
export async function ensureQuota(client: PoolClient, appId: number, installationId: number) {
  await client.query(
    'INSERT INTO github_quota_state(app_id,installation_id) VALUES($1,0),($1,$2) ON CONFLICT DO NOTHING',
    [appId, installationId],
  );
}
export async function acquireQuota(
  pool: Pool,
  appId: number,
  installationId: number,
): Promise<QuotaLease> {
  return withTransaction(pool, async (client) => {
    await ensureQuota(client, appId, installationId);
    const token = randomUUID();
    const row = await client.query(
      `UPDATE github_quota_state SET lease_token=$3,lease_until=clock_timestamp()+interval '120 seconds' WHERE app_id=$1 AND installation_id=$2 AND blocked_until<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND EXISTS(SELECT 1 FROM github_quota_state WHERE app_id=$1 AND installation_id=0 AND blocked_until<=clock_timestamp()) RETURNING app_id`,
      [appId, installationId, token],
    );
    if (!row.rowCount) throw new QuotaUnavailable();
    return { appId, installationId, token };
  });
}
export async function releaseQuota(pool: Pool, lease: QuotaLease) {
  await pool.query(
    'UPDATE github_quota_state SET lease_token=NULL,lease_until=NULL WHERE app_id=$1 AND installation_id=$2 AND lease_token=$3',
    [lease.appId, lease.installationId, lease.token],
  );
}
export async function pauseQuota(
  pool: Pool,
  lease: QuotaLease,
  delay: number | null,
  appRequest = false,
  resetAtUnixSeconds: number | null = null,
) {
  return withTransaction(pool, async (client) => {
    await ensureQuota(client, lease.appId, lease.installationId);
    const id = appRequest ? 0 : lease.installationId;
    const state = await client.query<Record<string, unknown>>(
      'SELECT consecutive_throttles FROM github_quota_state WHERE app_id=$1 AND installation_id=$2 FOR UPDATE',
      [lease.appId, id],
    );
    const active = await client.query(
      'SELECT 1 FROM github_quota_state WHERE app_id=$1 AND installation_id=$2 AND lease_token=$3 AND lease_until>clock_timestamp()',
      [lease.appId, lease.installationId, lease.token],
    );
    const failures = Math.min(
      30,
      Number(state.rows[0]?.consecutive_throttles) + (active.rowCount ? 1 : 0),
    );
    const seconds = retryDelay(delay, failures);
    // Extreme untrusted waits fail closed rather than overflow PostgreSQL timestamps.
    const result = await client.query<Record<string, unknown>>(
      `UPDATE github_quota_state SET consecutive_throttles=$3,blocked_until=GREATEST(blocked_until,CASE WHEN $4::double precision>2147483647 THEN 'infinity'::timestamptz ELSE clock_timestamp()+$4*interval '1 second' END,CASE WHEN $5::double precision IS NULL THEN '-infinity'::timestamptz WHEN $5::double precision>253402300799 THEN 'infinity'::timestamptz ELSE to_timestamp($5::double precision)+interval '15 seconds' END) WHERE app_id=$1 AND installation_id=$2 RETURNING extract(epoch FROM blocked_until-clock_timestamp())::float AS delay`,
      [lease.appId, id, failures, seconds, resetAtUnixSeconds],
    );
    return Math.ceil(Number(result.rows[0]?.delay));
  });
}
export async function checkQuota(pool: Pool, lease: QuotaLease) {
  const row = await pool.query(
    `SELECT 1 FROM github_quota_state WHERE app_id=$1 AND installation_id=$2 AND lease_token=$3 AND lease_until>clock_timestamp() AND blocked_until<=clock_timestamp() AND EXISTS(SELECT 1 FROM github_quota_state WHERE app_id=$1 AND installation_id=0 AND blocked_until<=clock_timestamp())`,
    [lease.appId, lease.installationId, lease.token],
  );
  if (!row.rowCount) throw new QuotaUnavailable();
}
export async function observeQuota(
  pool: Pool,
  lease: QuotaLease,
  response: Response,
  appRequest: boolean,
) {
  const limit = await githubRateLimit(response, () => new Date());
  if (limit.limited || limit.exhausted || (!response.ok && limit.retryAfterSeconds !== null)) {
    await pauseQuota(pool, lease, limit.retryAfterSeconds, appRequest, limit.resetAtUnixSeconds);
  } else if (response.ok) {
    await pool.query(
      `UPDATE github_quota_state SET consecutive_throttles=0 WHERE app_id=$1 AND installation_id=$2 AND blocked_until<=clock_timestamp() AND EXISTS(SELECT 1 FROM github_quota_state WHERE app_id=$1 AND installation_id=$3 AND lease_token=$4 AND lease_until>clock_timestamp())`,
      [lease.appId, appRequest ? 0 : lease.installationId, lease.installationId, lease.token],
    );
  }
}

/** Conservative one-request/second App-wide pacing, without holding a DB transaction while waiting. */
export async function paceQuota(pool: Pool, lease: QuotaLease, signal?: AbortSignal | null) {
  await checkQuota(pool, lease);
  const delay = await withTransaction(pool, async (client) => {
    const row = await client.query<Record<string, unknown>>(
      `WITH stamp AS (SELECT clock_timestamp() AS now) UPDATE github_quota_state SET next_request_at=GREATEST(next_request_at,stamp.now)+interval '1 second' FROM stamp WHERE app_id=$1 AND installation_id=0 RETURNING GREATEST(0,extract(epoch FROM next_request_at-interval '1 second'-stamp.now)*1000)::float AS delay`,
      [lease.appId],
    );
    const ms = Number(row.rows[0]?.delay);
    if (!Number.isFinite(ms) || ms < 0) throw new QuotaUnavailable();
    return ms;
  });
  if (signal?.aborted) throw new Error('GitHub pacing cancelled');
  if (delay > 0) await setTimeout(Math.ceil(delay), undefined, { signal: signal ?? undefined });
  await checkQuota(pool, lease);
}

/** Reuse the observed cooldown; one provider response increments backoff only once. */
export async function quotaRetryDelay(pool: Pool, lease: QuotaLease) {
  const row = await pool.query<Record<string, unknown>>(
    `SELECT GREATEST(0,extract(epoch FROM max(blocked_until)-clock_timestamp()))::float AS delay FROM github_quota_state WHERE app_id=$1 AND installation_id IN (0,$2)`,
    [lease.appId, lease.installationId],
  );
  const delay = Number(row.rows[0]?.delay);
  return delay === Infinity
    ? Infinity
    : Number.isFinite(delay) && delay > 0
      ? Math.ceil(delay)
      : retryDelay(null);
}

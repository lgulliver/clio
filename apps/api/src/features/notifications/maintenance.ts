import type { Pool } from 'pg';
import { createNotificationJobs } from './jobs.ts';

const defaultLimit = 100;
const maximumLimit = 500;

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid maintenance limit');
  return Math.min(limit, maximumLimit);
}

/**
 * Bounded maintenance (default 100, maximum 500 per category). It never deletes events, batches or
 * link audit rows that outlive transport attempts: event identity, counters and `uncertain`/`failed`
 * state keep deduplication and blocking for the pulse lifetime. Only completed private attempt
 * rows 30 days past their event's terminal state, and unused expired link states, are removed.
 * Returns the number of rows changed or removed.
 */
export async function maintainNotifications(pool: Pool, limit?: number): Promise<number> {
  const bound = boundedLimit(limit);
  const jobs = createNotificationJobs(pool);
  let changed = await jobs.recoverExpired(bound);
  // Markers orphaned by a hook-invalidated event plus worker loss become completed (uncertain) so
  // the 30-day purge below can remove them; the logical event and its counters stay.
  changed += await jobs.finalizeAbandoned(bound);
  // Events past their immutable deadline end as skipped/expired; unfinished markers are excluded.
  const expired = await pool.query(
    `WITH picked AS (
      SELECT e.id FROM notification_events e
      WHERE e.expires_at IS NOT NULL AND e.expires_at<=clock_timestamp()
        AND (e.state IN ('pending','retry_scheduled')
          OR (e.state='leased' AND e.lease_until<=clock_timestamp()
            AND NOT EXISTS(SELECT 1 FROM notification_attempts a WHERE a.workspace_id=e.workspace_id AND a.event_id=e.id AND a.outcome IS NULL)))
      ORDER BY e.expires_at,e.id LIMIT $1 FOR UPDATE OF e SKIP LOCKED)
    UPDATE notification_events e SET state='skipped',reason='expired',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
    FROM picked WHERE e.id=picked.id`,
    [bound],
  );
  changed += expired.rowCount ?? 0;
  // Private attempt rows only; never rows that are still unfinished markers.
  const purged = await pool.query(
    `WITH old AS (
      SELECT e.workspace_id,e.id FROM notification_events e
      WHERE e.terminal_at IS NOT NULL AND e.terminal_at<=clock_timestamp()-interval '30 days'
        AND EXISTS(SELECT 1 FROM notification_attempts a WHERE a.workspace_id=e.workspace_id AND a.event_id=e.id AND a.completed_at IS NOT NULL)
      ORDER BY e.terminal_at,e.id LIMIT $1)
    DELETE FROM notification_attempts a USING old
    WHERE a.workspace_id=old.workspace_id AND a.event_id=old.id AND a.completed_at IS NOT NULL`,
    [bound],
  );
  changed += purged.rowCount ?? 0;
  // Unused, expired link states only. Consumed states stay as minimal security audit rows.
  const states = await pool.query(
    `DELETE FROM notification_oauth_states WHERE state_hash IN (
      SELECT state_hash FROM notification_oauth_states WHERE consumed_at IS NULL AND expires_at<=clock_timestamp()
      ORDER BY expires_at LIMIT $1)`,
    [bound],
  );
  changed += states.rowCount ?? 0;
  return changed;
}

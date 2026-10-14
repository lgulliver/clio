import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.ts';

const defaultPulses = 25;
const maximumPulses = 100;
const pageSize = 100;

type Row = Record<string, unknown>;
function whole(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('Invalid schedule');
  return value;
}
function wholeOrNull(row: Row, key: string): number | null {
  return row[key] === null ? null : whole(row, key);
}
function textOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Invalid schedule');
  return value;
}

function boundedPulseLimit(limit: number | undefined): number {
  if (limit === undefined) return defaultPulses;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid schedule limit');
  return Math.min(limit, maximumPulses);
}

/**
 * Advances at most one bounded recipient page for a pulse inside one transaction. All timing uses
 * the database clock. Only the latest due slot is sendable; earlier slots become compact missed
 * markers that consume no reminder ordinal. Returns whether the pulse made progress.
 */
async function advancePulse(
  client: PoolClient,
  workspaceId: string,
  pulseId: string,
): Promise<boolean> {
  // Same lock order as manual reminders and lifecycle hooks: workspace first, then pulse policy.
  const workspace = await client.query('SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE', [
    workspaceId,
  ]);
  if (!workspace.rowCount) return false;
  const current = await client.query<Row>(
    `WITH t AS MATERIALIZED (SELECT clock_timestamp() AS now)
    SELECT f.scheduler_slot,f.scheduler_active_slot,f.scheduler_recipient_cursor,
      CASE WHEN t.now<f.opened_at+f.first_reminder_hours*interval '1 hour' THEN 0
        ELSE LEAST(f.maximum_reminders,1+floor(extract(epoch FROM (t.now-(f.opened_at+f.first_reminder_hours*interval '1 hour')))/(f.repeat_hours*3600))::integer) END AS latest
    FROM notification_pulse_policies f JOIN space_pulses p ON p.workspace_id=f.workspace_id AND p.id=f.pulse_id
    JOIN notification_policies n ON n.workspace_id=f.workspace_id,t
    WHERE f.workspace_id=$1 AND f.pulse_id=$2 AND p.state='open' AND f.enabled AND f.reminders AND f.reminders_enabled
      AND f.cancelled_at IS NULL AND n.enabled AND n.grant_fingerprint=f.grant_fingerprint
    FOR UPDATE OF f`,
    [workspaceId, pulseId],
  );
  const row = current.rows[0];
  if (!row) return false;
  const completed = whole(row, 'scheduler_slot');
  const active = wholeOrNull(row, 'scheduler_active_slot');
  const latest = whole(row, 'latest');
  const target = Math.max(latest, active ?? 0);
  if (target <= completed) return false;
  let cursor = textOrNull(row, 'scheduler_recipient_cursor');
  if (active !== target) {
    // A newer latest slot restarts bounded traversal; the cursor is cleared with the slot change.
    await client.query(
      'UPDATE notification_pulse_policies SET scheduler_active_slot=$3,scheduler_recipient_cursor=NULL WHERE workspace_id=$1 AND pulse_id=$2',
      [workspaceId, pulseId, target],
    );
    cursor = null;
  }
  // Keyset over the frozen roster in default text collation, matching the stored cursor.
  const page = await client.query<Row>(
    `SELECT user_id FROM space_roster WHERE pulse_id=$1 AND ($2::text IS NULL OR user_id>$2) ORDER BY user_id LIMIT $3`,
    [pulseId, cursor, pageSize + 1],
  );
  const ids = page.rows.map((r) => {
    const id = r.user_id;
    if (typeof id !== 'string') throw new Error('Invalid schedule');
    return id;
  });
  const members = ids.slice(0, pageSize);
  if (members.length) {
    const eligible = `WITH members AS (
        SELECT u.user_id,
          COALESCE((SELECT max(e.reminder_slot) FROM notification_events e WHERE e.workspace_id=$1 AND e.pulse_id=$2 AND e.user_id=u.user_id),0) AS ordinal,
          EXISTS(SELECT 1 FROM notification_events e WHERE e.workspace_id=$1 AND e.pulse_id=$2 AND e.user_id=u.user_id
            AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp()) AND (
            (e.kind='reminder' AND e.state IN ('leased','retry_scheduled'))
            OR (e.kind='reminder' AND e.state='pending' AND NOT (COALESCE(CASE WHEN e.occurrence_key ~ '^auto:[1-3]$' THEN split_part(e.occurrence_key,':',2)::integer END<$3::integer,false) AND e.slack_attempts+e.email_attempts=0))
            OR (e.kind IN ('invitation','reminder') AND e.state IN ('failed','uncertain')))) AS blocked
        FROM unnest($4::text[]) AS u(user_id)
        WHERE EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=$1 AND m.user_id=u.user_id)
          AND NOT EXISTS(SELECT 1 FROM space_receipts s WHERE s.pulse_id=$2 AND s.user_id=u.user_id)),
      f AS (SELECT * FROM notification_pulse_policies WHERE workspace_id=$1 AND pulse_id=$2)`;
    // A never-attempted unsent older automatic slot is superseded by the latest slot (catch up
    // only the latest); its ordinal stays spent. Expired unfinished events never block.
    await client.query(
      `${eligible}
      UPDATE notification_events e SET state='skipped',reason='missed_slot',terminal_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM members m,f
      WHERE e.workspace_id=$1 AND e.pulse_id=$2 AND e.user_id=m.user_id AND NOT m.blocked AND m.ordinal<f.maximum_reminders
        AND e.kind='reminder' AND e.state='pending' AND e.slack_attempts+e.email_attempts=0
        AND COALESCE(CASE WHEN e.occurrence_key ~ '^auto:[1-3]$' THEN split_part(e.occurrence_key,':',2)::integer END<$3::integer,false)
        AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp())`,
      [workspaceId, pulseId, target, members],
    );
    // Latest slot: queued now, one ordinal, only when not blocked by unresolved failure/uncertainty.
    await client.query(
      `${eligible}
      INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,reminder_slot,policy_revision,grant_fingerprint,expires_at)
      SELECT f.workspace_id,f.pulse_id,m.user_id,'reminder','auto:'||$3::integer::text,m.ordinal+1,f.policy_revision,f.grant_fingerprint,
        f.opened_at+(f.first_reminder_hours+($3::integer-1)*f.repeat_hours)*interval '1 hour'+interval '48 hours'
      FROM f,members m
      WHERE NOT m.blocked AND m.ordinal<f.maximum_reminders
        AND f.opened_at+(f.first_reminder_hours+($3::integer-1)*f.repeat_hours)*interval '1 hour'+interval '48 hours'>clock_timestamp()
      ON CONFLICT DO NOTHING`,
      [workspaceId, pulseId, target, members],
    );
    // Earlier (or blocked/capped/expired latest) slots: history markers only, never an ordinal.
    await client.query(
      `${eligible}
      INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,reminder_slot,policy_revision,grant_fingerprint,state,reason,expires_at,terminal_at)
      SELECT f.workspace_id,f.pulse_id,m.user_id,'reminder','auto:'||s.slot::text,NULL,f.policy_revision,f.grant_fingerprint,'skipped','missed_slot',
        f.opened_at+(f.first_reminder_hours+(s.slot-1)*f.repeat_hours)*interval '1 hour'+interval '48 hours',clock_timestamp()
      FROM f,members m,generate_series($5::integer,$3::integer) AS s(slot)
      ON CONFLICT DO NOTHING`,
      [workspaceId, pulseId, target, members, completed + 1],
    );
  }
  if (ids.length > pageSize) {
    await client.query(
      'UPDATE notification_pulse_policies SET scheduler_recipient_cursor=$3 WHERE workspace_id=$1 AND pulse_id=$2',
      [workspaceId, pulseId, members.at(-1) ?? null],
    );
  } else {
    await client.query(
      'UPDATE notification_pulse_policies SET scheduler_slot=$3,scheduler_active_slot=NULL,scheduler_recipient_cursor=NULL WHERE workspace_id=$1 AND pulse_id=$2',
      [workspaceId, pulseId, target],
    );
  }
  return true;
}

/**
 * Creates due scheduled-reminder events from frozen policy for up to `limit` pulses (default 25,
 * hard maximum 100), one bounded 100-recipient page each. Returns the number of pulses advanced.
 */
export async function advanceNotificationSchedule(pool: Pool, limit?: number): Promise<number> {
  const pulses = boundedPulseLimit(limit);
  const candidates = await pool.query<Row>(
    `SELECT f.workspace_id,f.pulse_id FROM notification_pulse_policies f
    JOIN space_pulses p ON p.workspace_id=f.workspace_id AND p.id=f.pulse_id
    JOIN notification_policies n ON n.workspace_id=f.workspace_id AND n.enabled AND n.grant_fingerprint=f.grant_fingerprint
    WHERE f.enabled AND f.reminders AND f.reminders_enabled AND f.cancelled_at IS NULL AND p.state='open'
      AND (f.scheduler_active_slot IS NOT NULL OR (f.scheduler_slot<f.maximum_reminders AND clock_timestamp()>=
        f.opened_at+(f.first_reminder_hours+f.scheduler_slot*f.repeat_hours)*interval '1 hour'))
    ORDER BY f.opened_at,f.pulse_id LIMIT $1`,
    [pulses],
  );
  let advanced = 0;
  for (const candidate of candidates.rows) {
    const workspaceId = candidate.workspace_id;
    const pulseId = candidate.pulse_id;
    if (typeof workspaceId !== 'string' || typeof pulseId !== 'string')
      throw new Error('Invalid schedule');
    if (await withTransaction(pool, (client) => advancePulse(client, workspaceId, pulseId)))
      advanced += 1;
  }
  return advanced;
}

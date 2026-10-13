import type { PoolClient } from 'pg';
import { IdentityError, opaqueId, uuid } from '../identity/input.ts';

async function lock(client: PoolClient, workspaceId: string): Promise<void> {
  const found = await client.query('SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE', [
    uuid(workspaceId),
  ]);
  if (!found.rowCount) throw new IdentityError(404, 'not_found');
}
/** In-flight submissions cannot be recalled; preserve ambiguity instead of promising cancellation. */
export async function skipPendingNotifications(
  client: PoolClient,
  workspaceId: string,
  reason:
    | 'integration_disabled'
    | 'reminders_disabled'
    | 'pulse_inactive'
    | 'response_received'
    | 'access_removed',
  pulseId: string | null = null,
  userId: string | null = null,
  remindersOnly = false,
  responseOnly = false,
): Promise<void> {
  await client.query(
    `UPDATE notification_events e SET
      channel=COALESCE((SELECT a.channel FROM notification_attempts a WHERE e.state='leased' AND a.workspace_id=e.workspace_id AND a.event_id=e.id AND a.lease_token=e.lease_token AND a.outcome IS NULL ORDER BY a.started_at DESC,a.id DESC LIMIT 1),e.channel),
      state=CASE WHEN e.state='leased' AND EXISTS(SELECT 1 FROM notification_attempts a WHERE a.workspace_id=e.workspace_id AND a.event_id=e.id AND a.lease_token=e.lease_token AND a.outcome IS NULL) THEN 'uncertain' ELSE 'skipped' END,
      reason=CASE WHEN e.state='leased' AND EXISTS(SELECT 1 FROM notification_attempts a WHERE a.workspace_id=e.workspace_id AND a.event_id=e.id AND a.lease_token=e.lease_token AND a.outcome IS NULL) THEN 'acceptance_unknown' ELSE $2 END,
      terminal_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
    WHERE e.workspace_id=$1 AND ($3::uuid IS NULL OR e.pulse_id=$3)
      AND ($4::text IS NULL OR e.user_id=$4) AND (NOT $5::boolean OR e.kind='reminder')
      AND (NOT $6::boolean OR e.kind IN ('invitation','reminder'))
      AND e.state IN ('pending','leased','retry_scheduled')`,
    [workspaceId, reason, pulseId, userId, remindersOnly, responseOnly],
  );
}
export async function capturePulseNotifications(
  client: PoolClient,
  workspaceId: string,
  pulseId: string,
): Promise<void> {
  await lock(client, workspaceId);
  const id = uuid(pulseId);
  const pulse = await client.query(
    "SELECT 1 FROM space_pulses WHERE workspace_id=$1 AND id=$2 AND state='open'",
    [workspaceId, id],
  );
  if (!pulse.rowCount) throw new IdentityError(409, 'conflict');
  await client.query(
    'INSERT INTO notification_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',
    [workspaceId],
  );
  // Capture once, including disabled policies. Repeated hooks never backfill.
  const captured = await client.query(
    `INSERT INTO notification_pulse_policies(workspace_id,pulse_id,policy_revision,enabled,invitations,closures,reminders,first_reminder_hours,repeat_hours,maximum_reminders,grant_fingerprint,opened_at,reminders_enabled)
    SELECT p.workspace_id,p.id,n.revision,n.enabled,n.invitations,n.closures,n.reminders,n.first_reminder_hours,n.repeat_hours,n.maximum_reminders,n.grant_fingerprint,p.opened_at,n.enabled AND n.reminders
    FROM space_pulses p JOIN notification_policies n ON n.workspace_id=p.workspace_id
    WHERE p.workspace_id=$1 AND p.id=$2 AND p.state='open'
    ON CONFLICT DO NOTHING RETURNING pulse_id`,
    [workspaceId, id],
  );
  if (!captured.rowCount) return;
  await client.query(
    `INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,policy_revision,grant_fingerprint,expires_at)
    SELECT f.workspace_id,f.pulse_id,r.user_id,'invitation','open',f.policy_revision,f.grant_fingerprint,NULL
    FROM notification_pulse_policies f JOIN space_roster r ON r.pulse_id=f.pulse_id
    JOIN workspace_memberships m ON m.workspace_id=f.workspace_id AND m.user_id=r.user_id
    WHERE f.workspace_id=$1 AND f.pulse_id=$2 AND f.enabled AND f.invitations
    AND NOT EXISTS(SELECT 1 FROM space_receipts s WHERE s.pulse_id=f.pulse_id AND s.user_id=r.user_id)
    ON CONFLICT DO NOTHING`,
    [workspaceId, id],
  );
}
export async function closePulseNotifications(
  client: PoolClient,
  workspaceId: string,
  pulseId: string,
): Promise<void> {
  await lock(client, workspaceId);
  const id = uuid(pulseId);
  const pulse = await client.query(
    "SELECT 1 FROM space_pulses WHERE workspace_id=$1 AND id=$2 AND state='closed'",
    [workspaceId, id],
  );
  if (!pulse.rowCount) throw new IdentityError(409, 'conflict');
  await skipPendingNotifications(client, workspaceId, 'pulse_inactive', id, null, false, true);
  await client.query(
    `UPDATE notification_pulse_policies SET reminders_enabled=false,reminder_revision=reminder_revision+1
    WHERE workspace_id=$1 AND pulse_id=$2 AND reminders_enabled`,
    [workspaceId, id],
  );
  await client.query(
    `INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,policy_revision,grant_fingerprint,expires_at)
    SELECT f.workspace_id,f.pulse_id,r.user_id,'closure','close',f.policy_revision,f.grant_fingerprint,p.closed_at+interval '7 days'
    FROM notification_pulse_policies f JOIN space_pulses p ON p.workspace_id=f.workspace_id AND p.id=f.pulse_id
    JOIN notification_policies n ON n.workspace_id=f.workspace_id
    JOIN space_roster r ON r.pulse_id=f.pulse_id
    JOIN workspace_memberships m ON m.workspace_id=f.workspace_id AND m.user_id=r.user_id
    WHERE f.workspace_id=$1 AND f.pulse_id=$2 AND p.state='closed' AND f.enabled AND f.closures
      AND f.cancelled_at IS NULL AND n.enabled AND n.grant_fingerprint=f.grant_fingerprint
      AND p.closed_at+interval '7 days'>clock_timestamp()
    ON CONFLICT DO NOTHING`,
    [workspaceId, id],
  );
}
export async function cancelPulseNotifications(
  client: PoolClient,
  workspaceId: string,
  pulseId: string,
): Promise<void> {
  await lock(client, workspaceId);
  const id = uuid(pulseId);
  const pulse = await client.query(
    "SELECT 1 FROM space_pulses WHERE workspace_id=$1 AND id=$2 AND state='cancelled'",
    [workspaceId, id],
  );
  if (!pulse.rowCount) throw new IdentityError(409, 'conflict');
  await client.query(
    `UPDATE notification_pulse_policies SET reminders_enabled=false,reminder_revision=reminder_revision+1,cancelled_at=clock_timestamp()
    WHERE workspace_id=$1 AND pulse_id=$2 AND cancelled_at IS NULL`,
    [workspaceId, id],
  );
  await skipPendingNotifications(client, workspaceId, 'pulse_inactive', id);
}
export async function suppressMemberNotifications(
  client: PoolClient,
  workspaceId: string,
  userId: string,
  pulseId?: string,
): Promise<void> {
  await lock(client, workspaceId);
  const user = opaqueId(userId);
  if (pulseId !== undefined) {
    await skipPendingNotifications(
      client,
      workspaceId,
      'response_received',
      uuid(pulseId),
      user,
      false,
      true,
    );
    return;
  }
  await skipPendingNotifications(client, workspaceId, 'access_removed', null, user);
  await client.query(
    `UPDATE notification_slack_bindings SET revision=revision+1,team_id=NULL,slack_user_id=NULL,grant_fingerprint=NULL,linked_at=NULL,updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND user_id=$2 AND slack_user_id IS NOT NULL`,
    [workspaceId, user],
  );
  await client.query('DELETE FROM notification_oauth_states WHERE workspace_id=$1 AND user_id=$2', [
    workspaceId,
    user,
  ]);
}

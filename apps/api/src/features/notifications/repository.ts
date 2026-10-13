import type { Pool, PoolClient } from 'pg';
import { IdentityError, object, uuid } from '../identity/input.ts';
import { type Actor, authorizedWorkspaceTransaction } from '../identity/repository.ts';
import {
  type NotificationConfig,
  type NotificationGrant,
  notificationGrant,
  readNotificationConfig,
} from './config.ts';
import type {
  DeliverySummary,
  NotificationAvailability,
  NotificationBatch,
  NotificationPolicy,
  NotificationState,
  OwnNotificationPage,
  OwnSlackLink,
} from './contract.ts';
import { skipPendingNotifications } from './events.ts';
import {
  integer,
  parseHistoryQuery,
  parseOwnNotification,
  parsePolicyInput,
  parseReminderInput,
  parseRetryInput,
  parseRevisionInput,
  parseTestInput,
} from './input.ts';

function corrupt(): never {
  throw new IdentityError(500, 'invalid_notification_record');
}
function instant(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) corrupt();
  return value.toISOString();
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') corrupt();
  return value;
}
function count(value: unknown): number {
  try {
    return integer(value, 0, 2147483647);
  } catch {
    return corrupt();
  }
}
function fingerprint(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) corrupt();
  return value;
}
async function storedPolicy(
  client: PoolClient,
  workspaceId: string,
): Promise<{ policy: NotificationPolicy; grantFingerprint: string | null }> {
  await client.query(
    'INSERT INTO notification_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',
    [workspaceId],
  );
  const result = await client.query<Record<string, unknown>>(
    'SELECT * FROM notification_policies WHERE workspace_id=$1 FOR UPDATE',
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) corrupt();
  try {
    return {
      policy: parsePolicyInput({
        revision: row.revision,
        enabled: row.enabled,
        invitations: row.invitations,
        closures: row.closures,
        reminders: row.reminders,
        firstReminderHours: row.first_reminder_hours,
        repeatHours: row.repeat_hours,
        maximumReminders: row.maximum_reminders,
      }),
      grantFingerprint: fingerprint(row.grant_fingerprint),
    };
  } catch {
    return corrupt();
  }
}
async function frozen(client: PoolClient, workspaceId: string, pulseId: string) {
  const result = await client.query<Record<string, unknown>>(
    `SELECT f.*,p.state AS pulse_state FROM notification_pulse_policies f JOIN space_pulses p ON p.workspace_id=f.workspace_id AND p.id=f.pulse_id
    WHERE f.workspace_id=$1 AND f.pulse_id=$2 FOR UPDATE OF f`,
    [workspaceId, uuid(pulseId)],
  );
  const row = result.rows[0];
  if (!row) throw new IdentityError(404, 'not_found');
  if (row.pulse_state !== 'open' && row.pulse_state !== 'closed' && row.pulse_state !== 'cancelled')
    corrupt();
  return {
    enabled: bool(row.enabled),
    remindersEnabled: bool(row.reminders_enabled),
    revision: count(row.reminder_revision),
    policyRevision: count(row.policy_revision),
    maximumReminders: count(row.maximum_reminders),
    grantFingerprint: fingerprint(row.grant_fingerprint),
    cancelled: row.cancelled_at !== null,
    state: row.pulse_state,
  };
}
async function summary(
  client: PoolClient,
  workspaceId: string,
  pulseId: string,
): Promise<DeliverySummary> {
  const policy = await frozen(client, workspaceId, pulseId);
  const counts: Record<NotificationState, number> = {
    pending: 0,
    leased: 0,
    retry_scheduled: 0,
    provider_accepted: 0,
    skipped: 0,
    failed: 0,
    uncertain: 0,
  };
  const result = await client.query<Record<string, unknown>>(
    'SELECT state,count(*)::integer AS count FROM notification_events WHERE workspace_id=$1 AND pulse_id=$2 GROUP BY state',
    [workspaceId, pulseId],
  );
  for (const row of result.rows) {
    const state = row.state;
    if (
      state !== 'pending' &&
      state !== 'leased' &&
      state !== 'retry_scheduled' &&
      state !== 'provider_accepted' &&
      state !== 'skipped' &&
      state !== 'failed' &&
      state !== 'uncertain'
    )
      corrupt();
    counts[state] = count(row.count);
  }
  return {
    workspaceId,
    pulseId,
    counts,
    remindersEnabled: policy.remindersEnabled,
    revision: policy.revision,
  };
}
async function beginBatch(
  client: PoolClient,
  actor: Actor,
  workspaceId: string,
  pulseId: string | null,
  kind: 'remind' | 'retry' | 'test',
  input:
    | ReturnType<typeof parseReminderInput>
    | ReturnType<typeof parseRetryInput>
    | ReturnType<typeof parseTestInput>,
): Promise<NotificationBatch | null> {
  const existing = await client.query<Record<string, unknown>>(
    `SELECT queued,input,kind,channel,(pulse_id IS NOT DISTINCT FROM $3::uuid AND kind=$4 AND created_by=$5 AND input=$6::jsonb) AS matches
    FROM notification_batches WHERE workspace_id=$1 AND request_id=$2`,
    [workspaceId, input.requestId, pulseId, kind, actor.userId, JSON.stringify(input)],
  );
  const row = existing.rows[0];
  if (row) {
    try {
      if (row.kind === 'test') {
        if (parseTestInput(row.input).channel !== row.channel) corrupt();
      } else if (row.kind === 'remind') {
        parseReminderInput(row.input);
        if (row.channel !== null) corrupt();
      } else if (row.kind === 'retry') {
        parseRetryInput(row.input);
        if (row.channel !== null) corrupt();
      } else corrupt();
    } catch {
      corrupt();
    }
    if (row.matches !== true) throw new IdentityError(409, 'conflict');
    return { requestId: input.requestId, queued: bool(row.queued) };
  }
  await client.query(
    'INSERT INTO notification_batches(workspace_id,request_id,pulse_id,created_by,kind,input,channel) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',
    [
      workspaceId,
      input.requestId,
      pulseId,
      actor.userId,
      kind,
      JSON.stringify(input),
      'channel' in input ? input.channel : null,
    ],
  );
  return null;
}
async function finishBatch(
  client: PoolClient,
  workspaceId: string,
  requestId: string,
  queued: boolean,
): Promise<NotificationBatch> {
  await client.query(
    'UPDATE notification_batches SET queued=$3 WHERE workspace_id=$1 AND request_id=$2',
    [workspaceId, requestId, queued],
  );
  return { requestId, queued };
}
function historyCursor(workspaceId: string, actor: Actor, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: 1, workspaceId, actorUserId: actor.userId, kind: 'own', id }),
  ).toString('base64url');
}
function cursorId(cursor: string, workspaceId: string, actor: Actor): string {
  try {
    const row = object(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')), [
      'v',
      'workspaceId',
      'actorUserId',
      'kind',
      'id',
    ]);
    if (
      row.v !== 1 ||
      row.workspaceId !== workspaceId ||
      row.actorUserId !== actor.userId ||
      row.kind !== 'own'
    )
      throw new Error();
    return uuid(row.id);
  } catch {
    throw new IdentityError(404, 'not_found');
  }
}
async function ownLink(
  client: PoolClient,
  workspaceId: string,
  actor: Actor,
): Promise<OwnSlackLink> {
  const result = await client.query<Record<string, unknown>>(
    'SELECT revision,slack_user_id,linked_at FROM notification_slack_bindings WHERE workspace_id=$1 AND user_id=$2',
    [workspaceId, actor.userId],
  );
  const row = result.rows[0];
  if (!row) return { linked: false, revision: 0, linkedAt: null };
  const linked = row.slack_user_id !== null;
  if (
    linked &&
    (typeof row.slack_user_id !== 'string' || !/^[UW][A-Z0-9]+$/.test(row.slack_user_id))
  )
    corrupt();
  if (!linked && row.linked_at !== null) corrupt();
  return {
    linked,
    revision: count(row.revision),
    linkedAt: linked ? instant(row.linked_at) : null,
  };
}
export function createNotificationRepository(
  pool: Pool,
  _config: NotificationConfig | null,
  dependencies: { configNow?: () => Promise<NotificationConfig | null> } = {},
) {
  // Initial startup snapshot is never fallback authority after rotation/revocation.
  const configNow = dependencies.configNow ?? (() => readNotificationConfig(process.env));
  async function currentGrant(workspaceId: string): Promise<NotificationGrant | null> {
    try {
      return notificationGrant(await configNow(), workspaceId);
    } catch {
      throw new IdentityError(503, 'unavailable');
    }
  }
  function scoped<T>(
    actor: Actor,
    workspaceId: string,
    owner: boolean,
    operation: (client: PoolClient, id: string) => Promise<T>,
  ): Promise<T> {
    const id = uuid(workspaceId);
    return authorizedWorkspaceTransaction(pool, actor, id, owner, (client) =>
      operation(client, id),
    );
  }
  async function enabledGrant(
    client: PoolClient,
    workspaceId: string,
    frozenFingerprint: string | null,
  ): Promise<NotificationGrant> {
    const current = await storedPolicy(client, workspaceId);
    const grant = await currentGrant(workspaceId);
    if (
      !current.policy.enabled ||
      !grant ||
      grant.fingerprint !== frozenFingerprint ||
      current.grantFingerprint !== grant.fingerprint
    )
      throw new IdentityError(409, 'conflict');
    return grant;
  }
  return {
    availability(actor: Actor, workspaceId: string): Promise<NotificationAvailability> {
      return scoped(actor, workspaceId, false, async (_client, id) => {
        const grant = await currentGrant(id);
        return {
          workspaceId: id,
          emailConfigured: grant?.smtp !== null && grant?.smtp !== undefined,
          slackConfigured: grant?.slack !== null && grant?.slack !== undefined,
          linkingConfigured: grant?.slack !== null && grant?.slack !== undefined,
        };
      });
    },
    policy(actor: Actor, workspaceId: string): Promise<NotificationPolicy> {
      return scoped(
        actor,
        workspaceId,
        true,
        async (client, id) => (await storedPolicy(client, id)).policy,
      );
    },
    updatePolicy(
      actor: Actor,
      workspaceId: string,
      input: unknown,
      verification?: { teamId: string; grantFingerprint: string; credentialFingerprint: string },
    ): Promise<NotificationPolicy> {
      const body = parsePolicyInput(input);
      return scoped(actor, workspaceId, true, async (client, id) => {
        const before = await storedPolicy(client, id);
        if (before.policy.revision !== body.revision) throw new IdentityError(409, 'conflict');
        const grant = body.enabled ? await currentGrant(id) : null;
        if (
          body.enabled &&
          (!grant ||
            (grant.slack &&
              (verification?.teamId !== grant.slack.teamId ||
                verification.grantFingerprint !== grant.fingerprint ||
                verification.credentialFingerprint !== grant.credentialFingerprint)))
        )
          throw new IdentityError(409, 'conflict');
        const next = { ...body, revision: body.revision + 1 };
        await client.query(
          `UPDATE notification_policies SET revision=$2,enabled=$3,invitations=$4,closures=$5,reminders=$6,first_reminder_hours=$7,repeat_hours=$8,maximum_reminders=$9,grant_fingerprint=$10,slack_team_id=$11,updated_at=clock_timestamp() WHERE workspace_id=$1`,
          [
            id,
            next.revision,
            next.enabled,
            next.invitations,
            next.closures,
            next.reminders,
            next.firstReminderHours,
            next.repeatHours,
            next.maximumReminders,
            grant?.fingerprint ?? null,
            grant?.slack?.teamId ?? null,
          ],
        );
        if (!body.enabled) {
          await client.query(
            `UPDATE notification_pulse_policies SET reminders_enabled=false,reminder_revision=reminder_revision+1,cancelled_at=clock_timestamp() WHERE workspace_id=$1 AND cancelled_at IS NULL`,
            [id],
          );
          await skipPendingNotifications(client, id, 'integration_disabled');
        }
        return next;
      });
    },
    ownLink(actor: Actor, workspaceId: string): Promise<OwnSlackLink> {
      return scoped(actor, workspaceId, false, (client, id) => ownLink(client, id, actor));
    },
    async unlink(actor: Actor, workspaceId: string, input: unknown): Promise<OwnSlackLink> {
      const body = parseRevisionInput(input);
      return scoped(actor, workspaceId, false, async (client, id) => {
        const before = await ownLink(client, id, actor);
        if (body.revision !== before.revision) throw new IdentityError(409, 'conflict');
        await client.query(
          `INSERT INTO notification_slack_bindings(workspace_id,user_id,revision) VALUES($1,$2,1)
          ON CONFLICT(workspace_id,user_id) DO UPDATE SET revision=notification_slack_bindings.revision+1,team_id=NULL,slack_user_id=NULL,grant_fingerprint=NULL,linked_at=NULL,updated_at=clock_timestamp()`,
          [id, actor.userId],
        );
        await client.query(
          'DELETE FROM notification_oauth_states WHERE workspace_id=$1 AND user_id=$2',
          [id, actor.userId],
        );
        return ownLink(client, id, actor);
      });
    },
    ownHistory(actor: Actor, workspaceId: string, query: unknown): Promise<OwnNotificationPage> {
      const input = parseHistoryQuery(query);
      return scoped(actor, workspaceId, false, async (client, id) => {
        const cursor = input.cursor === null ? null : cursorId(input.cursor, id, actor);
        if (
          cursor !== null &&
          !(
            await client.query(
              'SELECT 1 FROM notification_events WHERE workspace_id=$1 AND user_id=$2 AND id=$3',
              [id, actor.userId, cursor],
            )
          ).rowCount
        )
          throw new IdentityError(404, 'not_found');
        const result = await client.query<Record<string, unknown>>(
          `SELECT id,pulse_id,kind,state,channel,created_at,updated_at FROM notification_events WHERE workspace_id=$1 AND user_id=$2
          AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM notification_events WHERE workspace_id=$1 AND user_id=$2 AND id=$3))
          ORDER BY created_at DESC,id DESC LIMIT 25`,
          [id, actor.userId, cursor],
        );
        const items = result.rows.map(parseOwnNotification);
        const last = items.at(-1);
        return {
          workspaceId: id,
          items,
          nextCursor: items.length === 25 && last ? historyCursor(id, actor, last.id) : null,
        };
      });
    },
    summary(actor: Actor, workspaceId: string, pulseId: string): Promise<DeliverySummary> {
      const pid = uuid(pulseId);
      return scoped(actor, workspaceId, true, (client, id) => summary(client, id, pid));
    },
    remind(
      actor: Actor,
      workspaceId: string,
      pulseId: string,
      input: unknown,
    ): Promise<NotificationBatch> {
      const body = parseReminderInput(input);
      const pid = uuid(pulseId);
      return scoped(actor, workspaceId, true, async (client, id) => {
        const pulse = await frozen(client, id, pid);
        const replay = await beginBatch(client, actor, id, pid, 'remind', body);
        if (replay) return replay;
        if (
          body.revision !== pulse.revision ||
          !pulse.remindersEnabled ||
          pulse.cancelled ||
          pulse.state !== 'open'
        )
          throw new IdentityError(409, 'conflict');
        await enabledGrant(client, id, pulse.grantFingerprint);
        const allowed = await client.query(
          `UPDATE notification_pulse_policies SET last_manual_at=clock_timestamp() WHERE workspace_id=$1 AND pulse_id=$2 AND (last_manual_at IS NULL OR last_manual_at<=clock_timestamp()-interval '24 hours') RETURNING pulse_id`,
          [id, pid],
        );
        if (!allowed.rowCount) throw new IdentityError(409, 'conflict');
        const result = await client.query(
          `INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,reminder_slot,policy_revision,grant_fingerprint,request_id,expires_at)
          SELECT f.workspace_id,f.pulse_id,r.user_id,'reminder','manual:'||$3::uuid::text,
            1+COALESCE((SELECT max(e.reminder_slot) FROM notification_events e WHERE e.workspace_id=f.workspace_id AND e.pulse_id=f.pulse_id AND e.user_id=r.user_id),0),
            f.policy_revision,f.grant_fingerprint,$3::uuid,clock_timestamp()+interval '48 hours'
          FROM notification_pulse_policies f JOIN space_roster r ON r.pulse_id=f.pulse_id
          JOIN workspace_memberships m ON m.workspace_id=f.workspace_id AND m.user_id=r.user_id
          WHERE f.workspace_id=$1 AND f.pulse_id=$2
            AND NOT EXISTS(SELECT 1 FROM space_receipts s WHERE s.pulse_id=f.pulse_id AND s.user_id=r.user_id)
            AND COALESCE((SELECT max(e.reminder_slot) FROM notification_events e WHERE e.workspace_id=f.workspace_id AND e.pulse_id=f.pulse_id AND e.user_id=r.user_id),0)<f.maximum_reminders
          ON CONFLICT DO NOTHING RETURNING id`,
          [id, pid, body.requestId],
        );
        return finishBatch(client, id, body.requestId, (result.rowCount ?? 0) > 0);
      });
    },
    disableReminders(
      actor: Actor,
      workspaceId: string,
      pulseId: string,
      input: unknown,
    ): Promise<DeliverySummary> {
      const body = parseRevisionInput(input);
      const pid = uuid(pulseId);
      return scoped(actor, workspaceId, true, async (client, id) => {
        const before = await frozen(client, id, pid);
        if (body.revision !== before.revision || before.state !== 'open')
          throw new IdentityError(409, 'conflict');
        await client.query(
          'UPDATE notification_pulse_policies SET reminders_enabled=false,reminder_revision=reminder_revision+1 WHERE workspace_id=$1 AND pulse_id=$2',
          [id, pid],
        );
        await skipPendingNotifications(client, id, 'reminders_disabled', pid, null, true);
        return summary(client, id, pid);
      });
    },
    retryBatch(
      actor: Actor,
      workspaceId: string,
      pulseId: string,
      input: unknown,
    ): Promise<NotificationBatch> {
      const body = parseRetryInput(input);
      const pid = uuid(pulseId);
      return scoped(actor, workspaceId, true, async (client, id) => {
        const pulse = await frozen(client, id, pid);
        const replay = await beginBatch(client, actor, id, pid, 'retry', body);
        if (replay) return replay;
        if (body.revision !== pulse.revision || pulse.cancelled)
          throw new IdentityError(409, 'conflict');
        const grant = await enabledGrant(client, id, pulse.grantFingerprint);
        const result = await client.query<{ id: string }>(
          `UPDATE notification_events e SET state='pending',available_at=clock_timestamp(),updated_at=clock_timestamp(),terminal_at=NULL,reason=NULL,
            uncertain_replays=uncertain_replays+CASE WHEN state='uncertain' THEN 1 ELSE 0 END
          WHERE e.workspace_id=$1 AND e.pulse_id=$2 AND e.grant_fingerprint=$3
            AND ((e.state='failed' AND NOT EXISTS(SELECT 1 FROM notification_attempts a WHERE a.workspace_id=e.workspace_id AND a.event_id=e.id AND a.outcome IS NULL)) OR (e.state='uncertain' AND $4::boolean AND e.uncertain_replays=0))
            AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp())
            AND EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=e.workspace_id AND m.user_id=e.user_id)
            AND EXISTS(SELECT 1 FROM space_roster r WHERE r.pulse_id=e.pulse_id AND r.user_id=e.user_id)
            AND ((e.kind='closure' AND $5::text='closed') OR (e.kind IN ('invitation','reminder') AND $5::text='open'
              AND (e.kind<>'reminder' OR $6::boolean) AND NOT EXISTS(SELECT 1 FROM space_receipts s WHERE s.pulse_id=e.pulse_id AND s.user_id=e.user_id)))
            AND ((e.state='uncertain' AND ((e.channel='slack' AND $7::boolean AND e.slack_attempts<3
                AND EXISTS(SELECT 1 FROM notification_slack_bindings b WHERE b.workspace_id=e.workspace_id AND b.user_id=e.user_id AND b.team_id=$9 AND b.grant_fingerprint=$3 AND b.slack_user_id IS NOT NULL))
              OR (e.channel='email' AND $8::boolean AND e.email_attempts<3 AND EXISTS(SELECT 1 FROM auth_users u WHERE u.id=e.user_id AND u.email_verified AND u.email !~ '[[:cntrl:][:space:]]' AND length(u.email)<=254 AND u.email ~ '^[^@]+@[^@]+\\.[^@]+$'))))
              OR (e.state='failed' AND (($7::boolean AND e.slack_attempts<3 AND EXISTS(SELECT 1 FROM notification_slack_bindings b WHERE b.workspace_id=e.workspace_id AND b.user_id=e.user_id AND b.team_id=$9 AND b.grant_fingerprint=$3 AND b.slack_user_id IS NOT NULL))
                OR ($8::boolean AND e.email_attempts<3 AND EXISTS(SELECT 1 FROM auth_users u WHERE u.id=e.user_id AND u.email_verified AND u.email !~ '[[:cntrl:][:space:]]' AND length(u.email)<=254 AND u.email ~ '^[^@]+@[^@]+\\.[^@]+$')))))
          RETURNING id`,
          [
            id,
            pid,
            grant.fingerprint,
            body.confirmUncertain,
            pulse.state,
            pulse.remindersEnabled,
            grant.slack !== null,
            grant.smtp !== null,
            grant.slack?.teamId ?? null,
          ],
        );
        const ids = result.rows.map((row) => row.id);
        if (ids.length)
          await client.query(
            `UPDATE notification_attempts SET completed_at=GREATEST(clock_timestamp(),started_at),outcome='uncertain',reason='acceptance_unknown',retryable=NULL,retry_after_ms=NULL
          WHERE workspace_id=$1 AND event_id=ANY($2::uuid[]) AND outcome IS NULL`,
            [id, ids],
          );
        return finishBatch(client, id, body.requestId, (result.rowCount ?? 0) > 0);
      });
    },
    async testDelivery(
      actor: Actor,
      workspaceId: string,
      input: unknown,
    ): Promise<NotificationBatch> {
      const body = parseTestInput(input);
      return scoped(actor, workspaceId, true, async (client, id) => {
        const replay = await beginBatch(client, actor, id, null, 'test', body);
        if (replay) return replay;
        const throttled = await client.query(
          `SELECT 1 FROM notification_batches WHERE workspace_id=$1 AND created_by=$2 AND kind='test' AND channel=$3 AND request_id<>$4 AND created_at>clock_timestamp()-interval '24 hours' LIMIT 1`,
          [id, actor.userId, body.channel, body.requestId],
        );
        if (throttled.rowCount) throw new IdentityError(409, 'conflict');
        const before = await storedPolicy(client, id);
        if (body.revision !== before.policy.revision) throw new IdentityError(409, 'conflict');
        const grant = await currentGrant(id);
        if (!grant) throw new IdentityError(409, 'conflict');
        const eligible = await client.query(
          `SELECT 1 FROM auth_users u WHERE u.id=$1 AND (($2::boolean AND u.email_verified AND u.email !~ '[[:cntrl:][:space:]]' AND length(u.email)<=254 AND u.email ~ '^[^@]+@[^@]+\\.[^@]+$')
          OR ($3::boolean AND EXISTS(SELECT 1 FROM notification_slack_bindings b WHERE b.workspace_id=$4 AND b.user_id=u.id AND b.team_id=$5 AND b.grant_fingerprint=$6 AND b.slack_user_id IS NOT NULL)))`,
          [
            actor.userId,
            grant.smtp !== null && body.channel === 'email',
            grant.slack !== null && body.channel === 'slack',
            id,
            grant.slack?.teamId ?? null,
            grant.fingerprint,
          ],
        );
        if (!eligible.rowCount) return finishBatch(client, id, body.requestId, false);
        await client.query(
          `INSERT INTO notification_events(workspace_id,user_id,kind,occurrence_key,policy_revision,grant_fingerprint,request_id,test_request_id,channel,expires_at)
          VALUES($1,$2,'test','manual:'||$3::uuid::text,$4,$5,$3::uuid,$3::uuid,$6,clock_timestamp()+interval '48 hours')`,
          [
            id,
            actor.userId,
            body.requestId,
            before.policy.revision,
            grant.fingerprint,
            body.channel,
          ],
        );
        return finishBatch(client, id, body.requestId, true);
      });
    },
  };
}

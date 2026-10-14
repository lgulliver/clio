import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../src/db/migrations.ts';
import { withTransaction } from '../src/db/pool.ts';
import { createIdentityRepository } from '../src/features/identity/repository.ts';
import type { NotificationConfig } from '../src/features/notifications/config.ts';
import {
  cancelPulseNotifications,
  capturePulseNotifications,
  closePulseNotifications,
  suppressMemberNotifications,
} from '../src/features/notifications/events.ts';
import { createNotificationRepository } from '../src/features/notifications/repository.ts';
import { createOrganizationRepository } from '../src/features/organization/repository.ts';
import { createSpaceRepository } from '../src/features/space/repository.ts';

if (!process.env.CLIO_TEST_DATABASE_URL) throw new Error('CLIO_TEST_DATABASE_URL required');
const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({
  connectionString: process.env.CLIO_TEST_DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
const pool = new Pool({
  connectionString: process.env.CLIO_TEST_DATABASE_URL,
  options: `-c search_path=${schema}`,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000,
});
const owner = { userId: 'notification-owner', sessionId: 'notification-owner-session' };
const member = { userId: 'notification-member', sessionId: 'notification-member-session' };
const outsider = { userId: 'notification-outsider', sessionId: 'notification-outsider-session' };
const enabledPolicy = {
  revision: 0,
  enabled: true,
  invitations: true,
  closures: true,
  reminders: true,
  firstReminderHours: 48,
  repeatHours: 72,
  maximumReminders: 2,
};
let created = false;
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool);
  for (const actor of [owner, member, outsider]) {
    await pool.query('INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,$1,$2,true)', [
      actor.userId,
      `${actor.userId}@example.com`,
    ]);
    await pool.query(
      "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$1,clock_timestamp()+interval '1 day')",
      [actor.sessionId, actor.userId],
    );
  }
});
afterAll(async () => {
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});
async function fixture() {
  const workspace = await createIdentityRepository(pool).createWorkspace(
    owner,
    `Notifications ${randomUUID()}`,
  );
  await pool.query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    [workspace.id, member.userId],
  );
  const team = await createOrganizationRepository(pool).createTeam(owner, workspace.id, 'Team');
  const space = createSpaceRepository(pool);
  await space.assign(owner, workspace.id, member.userId, { teamId: team.id });
  await space.assign(owner, workspace.id, owner.userId, { teamId: team.id });
  let config: NotificationConfig | null = {
    mode: 'local_capture',
    publicOrigin: 'http://localhost:5173',
    grants: [
      {
        workspaceId: workspace.id,
        fingerprint: 'a'.repeat(64),
        credentialFingerprint: 'c'.repeat(64),
        smtp: {
          host: '127.0.0.1',
          port: 1025,
          from: 'clio@example.com',
          user: null,
          password: null,
          ratePerMinute: 30,
        },
        slack: null,
      },
    ],
  };
  const notifications = createNotificationRepository(pool, config, {
    configNow: async () => config,
  });
  const pulse = await space.create(owner, workspace.id, {
    teamId: team.id,
    referenceStart: '2026-01-01T00:00:00.000Z',
    referenceEnd: '2026-01-08T00:00:00.000Z',
  });
  async function open(enabled = true) {
    if (enabled) await notifications.updatePolicy(owner, workspace.id, enabledPolicy);
    await space.transition(owner, workspace.id, pulse.id, 'open');
    await withTransaction(pool, (client) =>
      capturePulseNotifications(client, workspace.id, pulse.id),
    );
  }
  return {
    workspace,
    team,
    pulse,
    space,
    notifications,
    open,
    rotate: (next: NotificationConfig | null) => {
      config = next;
    },
    config,
  };
}
it('defaults disabled; restricts policy writes and hides workspace from outsiders', async () => {
  const f = await fixture();
  expect((await f.notifications.policy(owner, f.workspace.id)).enabled).toBe(false);
  await expect(f.notifications.policy(member, f.workspace.id)).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    f.notifications.updatePolicy(member, f.workspace.id, enabledPolicy),
  ).rejects.toMatchObject({ status: 403 });
  await expect(f.notifications.policy(outsider, f.workspace.id)).rejects.toMatchObject({
    status: 404,
  });
  const saved = await f.notifications.updatePolicy(owner, f.workspace.id, enabledPolicy);
  expect(saved.revision).toBe(1);
  await expect(
    f.notifications.updatePolicy(owner, f.workspace.id, enabledPolicy),
  ).rejects.toMatchObject({ status: 409 });
});
it('captures exact frozen policy/events once and separates owner aggregate from own history', async () => {
  const f = await fixture();
  await f.open();
  await withTransaction(pool, (client) =>
    capturePulseNotifications(client, f.workspace.id, f.pulse.id),
  );
  const own = await f.notifications.ownHistory(member, f.workspace.id, {});
  expect(own.items).toHaveLength(1);
  expect(own.items[0]?.kind).toBe('invitation');
  expect(
    JSON.stringify(await f.notifications.summary(owner, f.workspace.id, f.pulse.id)),
  ).not.toMatch(/userId|email|slackUserId|recipient/);
  await expect(f.notifications.summary(member, f.workspace.id, f.pulse.id)).rejects.toMatchObject({
    status: 403,
  });
  await f.notifications.updatePolicy(owner, f.workspace.id, {
    ...enabledPolicy,
    revision: 1,
    firstReminderHours: 24,
  });
  const frozen = await pool.query(
    'SELECT policy_revision,first_reminder_hours FROM notification_pulse_policies WHERE pulse_id=$1',
    [f.pulse.id],
  );
  expect(frozen.rows[0]).toEqual({ policy_revision: 1, first_reminder_hours: 48 });
});
it('captures disabled pulses without backfill after enable', async () => {
  const f = await fixture();
  await f.open(false);
  await f.notifications.updatePolicy(owner, f.workspace.id, enabledPolicy);
  await withTransaction(pool, (client) =>
    capturePulseNotifications(client, f.workspace.id, f.pulse.id),
  );
  expect((await f.notifications.ownHistory(member, f.workspace.id, {})).items).toHaveLength(0);
});
it('rolls back hook/outbox mutations in caller transaction', async () => {
  const f = await fixture();
  await f.notifications.updatePolicy(owner, f.workspace.id, enabledPolicy);
  await expect(
    withTransaction(pool, async (client) => {
      await client.query(
        "UPDATE space_pulses SET state='open',minimum_respondents=3,roster_size=2,opened_at=clock_timestamp() WHERE id=$1",
        [f.pulse.id],
      );
      await client.query(
        'INSERT INTO space_roster(pulse_id,user_id) SELECT $1,unnest($2::text[])',
        [f.pulse.id, [owner.userId, member.userId]],
      );
      await capturePulseNotifications(client, f.workspace.id, f.pulse.id);
      throw new Error('fixture rollback');
    }),
  ).rejects.toThrow('fixture rollback');
  expect(
    (await pool.query('SELECT 1 FROM notification_events WHERE pulse_id=$1', [f.pulse.id]))
      .rowCount,
  ).toBe(0);
  expect(
    (await pool.query('SELECT state FROM space_pulses WHERE id=$1', [f.pulse.id])).rows[0]?.state,
  ).toBe('draft');
  expect(
    (await pool.query('SELECT 1 FROM space_roster WHERE pulse_id=$1', [f.pulse.id])).rowCount,
  ).toBe(0);
});
it('serializes concurrent manual request replay, rejects changed bodies and applies shared member cap/cooldown', async () => {
  const f = await fixture();
  await f.open();
  const body = { requestId: randomUUID(), revision: 0, confirm: true };
  const [one, two] = await Promise.all([
    f.notifications.remind(owner, f.workspace.id, f.pulse.id, body),
    f.notifications.remind(owner, f.workspace.id, f.pulse.id, body),
  ]);
  expect(one).toEqual(two);
  expect(one.queued).toBe(true);
  await expect(
    f.notifications.remind(owner, f.workspace.id, f.pulse.id, { ...body, revision: 1 }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.notifications.remind(owner, f.workspace.id, f.pulse.id, { ...body, requestId: randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
  await pool.query(
    "UPDATE notification_pulse_policies SET last_manual_at=clock_timestamp()-interval '25 hours' WHERE pulse_id=$1",
    [f.pulse.id],
  );
  await f.notifications.remind(owner, f.workspace.id, f.pulse.id, {
    ...body,
    requestId: randomUUID(),
  });
  await pool.query(
    "UPDATE notification_pulse_policies SET last_manual_at=clock_timestamp()-interval '25 hours' WHERE pulse_id=$1",
    [f.pulse.id],
  );
  expect(
    (
      await f.notifications.remind(owner, f.workspace.id, f.pulse.id, {
        ...body,
        requestId: randomUUID(),
      })
    ).queued,
  ).toBe(false);
  const slots = await pool.query(
    "SELECT reminder_slot FROM notification_events WHERE pulse_id=$1 AND user_id=$2 AND kind='reminder' ORDER BY reminder_slot",
    [f.pulse.id, member.userId],
  );
  expect(slots.rows).toEqual([{ reminder_slot: 1 }, { reminder_slot: 2 }]);
});
it('skipped historical markers consume no sendable reminder ordinal; manual and automatic occurrences cannot collide', async () => {
  const f = await fixture();
  await f.open();
  await pool.query(
    "INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,policy_revision,grant_fingerprint,state,reason,terminal_at,expires_at) VALUES($1,$2,$3,'reminder','auto:1',1,$4,'skipped','missed_slot',clock_timestamp(),clock_timestamp())",
    [f.workspace.id, f.pulse.id, member.userId, 'a'.repeat(64)],
  );
  await f.notifications.remind(owner, f.workspace.id, f.pulse.id, {
    requestId: randomUUID(),
    revision: 0,
    confirm: true,
  });
  const rows = await pool.query(
    "SELECT reminder_slot FROM notification_events WHERE pulse_id=$1 AND user_id=$2 AND kind='reminder' ORDER BY created_at",
    [f.pulse.id, member.userId],
  );
  expect(rows.rows).toEqual([{ reminder_slot: null }, { reminder_slot: 1 }]);
});
it('current config fails closed and Slack enable needs server proof matching current grant/team', async () => {
  const f = await fixture();
  f.rotate(null);
  await expect(
    f.notifications.updatePolicy(owner, f.workspace.id, enabledPolicy),
  ).rejects.toMatchObject({ status: 409 });
  const config: NotificationConfig = {
    mode: 'live',
    publicOrigin: 'https://clio.example.com',
    grants: [
      {
        workspaceId: f.workspace.id,
        fingerprint: 'b'.repeat(64),
        credentialFingerprint: 'c'.repeat(64),
        smtp: null,
        slack: {
          teamId: 'T123',
          botToken: 'fixture',
          clientId: 'fixture',
          clientSecret: 'fixture',
        },
      },
    ],
  };
  f.rotate(config);
  await expect(
    f.notifications.updatePolicy(owner, f.workspace.id, enabledPolicy),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.notifications.updatePolicy(owner, f.workspace.id, enabledPolicy, {
      teamId: 'T123',
      grantFingerprint: 'old',
      credentialFingerprint: 'c'.repeat(64),
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await f.notifications.updatePolicy(owner, f.workspace.id, enabledPolicy, {
        teamId: 'T123',
        grantFingerprint: 'b'.repeat(64),
        credentialFingerprint: 'c'.repeat(64),
      })
    ).enabled,
  ).toBe(true);
});
it('tests queue initiating owner only, no caller-selected user or address and exact replay', async () => {
  const f = await fixture();
  const body = { requestId: randomUUID(), revision: 0, confirm: true, channel: 'email' };
  await f.notifications.testDelivery(owner, f.workspace.id, body);
  expect(await f.notifications.testDelivery(owner, f.workspace.id, body)).toEqual({
    requestId: body.requestId,
    queued: true,
  });
  const result = await pool.query(
    'SELECT user_id,pulse_id,kind FROM notification_events WHERE workspace_id=$1',
    [f.workspace.id],
  );
  expect(result.rows).toEqual([{ user_id: owner.userId, pulse_id: null, kind: 'test' }]);
  await expect(
    f.notifications.testDelivery(member, f.workspace.id, { ...body, requestId: randomUUID() }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    f.notifications.testDelivery(owner, f.workspace.id, { ...body, userId: member.userId }),
  ).rejects.toMatchObject({ status: 400 });
});
it('workspace disable cancels pending events permanently and disables future closure hooks', async () => {
  const f = await fixture();
  await f.open();
  await f.notifications.updatePolicy(owner, f.workspace.id, {
    ...enabledPolicy,
    enabled: false,
    revision: 1,
  });
  await f.notifications.updatePolicy(owner, f.workspace.id, { ...enabledPolicy, revision: 2 });
  expect((await f.notifications.ownHistory(member, f.workspace.id, {})).items[0]?.state).toBe(
    'skipped',
  );
  await f.space.transition(owner, f.workspace.id, f.pulse.id, 'close');
  await withTransaction(pool, (client) =>
    closePulseNotifications(client, f.workspace.id, f.pulse.id),
  );
  expect((await f.notifications.ownHistory(member, f.workspace.id, {})).items).toHaveLength(1);
});
it('closure remains deduplicated after team moves; response suppression skips only invitations/reminders', async () => {
  const f = await fixture();
  await f.open();
  await withTransaction(pool, (client) =>
    suppressMemberNotifications(client, f.workspace.id, member.userId, f.pulse.id),
  );
  await f.space.assign(owner, f.workspace.id, member.userId, { teamId: null });
  await f.space.transition(owner, f.workspace.id, f.pulse.id, 'close');
  await withTransaction(pool, async (client) => {
    await closePulseNotifications(client, f.workspace.id, f.pulse.id);
    await closePulseNotifications(client, f.workspace.id, f.pulse.id);
  });
  const items = (await f.notifications.ownHistory(member, f.workspace.id, {})).items;
  expect(items.filter((item) => item.kind === 'closure')).toHaveLength(1);
  expect(items.find((item) => item.kind === 'invitation')?.state).toBe('skipped');
});
it('cancel/reminder disable and membership removal retain roster/dedup but invalidate pending work and links', async () => {
  const f = await fixture();
  await f.open();
  await f.notifications.remind(owner, f.workspace.id, f.pulse.id, {
    requestId: randomUUID(),
    revision: 0,
    confirm: true,
  });
  expect(
    (await f.notifications.disableReminders(owner, f.workspace.id, f.pulse.id, { revision: 0 }))
      .remindersEnabled,
  ).toBe(false);
  await expect(
    f.notifications.disableReminders(owner, f.workspace.id, f.pulse.id, { revision: 0 }),
  ).rejects.toMatchObject({ status: 409 });
  await pool.query(
    "INSERT INTO notification_slack_bindings(workspace_id,user_id,revision,team_id,slack_user_id,linked_at,grant_fingerprint) VALUES($1,$2,1,'T123','U123',clock_timestamp(),$3)",
    [f.workspace.id, member.userId, 'a'.repeat(64)],
  );
  await withTransaction(pool, (client) =>
    suppressMemberNotifications(client, f.workspace.id, member.userId),
  );
  expect((await f.notifications.ownLink(member, f.workspace.id)).linked).toBe(false);
  expect(
    (
      await pool.query('SELECT 1 FROM space_roster WHERE pulse_id=$1 AND user_id=$2', [
        f.pulse.id,
        member.userId,
      ])
    ).rowCount,
  ).toBe(1);
  await f.space.transition(owner, f.workspace.id, f.pulse.id, 'cancel');
  await withTransaction(pool, (client) =>
    cancelPulseNotifications(client, f.workspace.id, f.pulse.id),
  );
  expect(
    (await f.notifications.ownHistory(member, f.workspace.id, {})).items.every(
      (item) => item.state === 'skipped',
    ),
  ).toBe(true);
});
it('bounds own history to 25 and binds cursors to actor/workspace/kind', async () => {
  const f = await fixture();
  await pool.query(
    `WITH batches AS (
    INSERT INTO notification_batches(workspace_id,request_id,created_by,kind,input,channel,created_at)
    SELECT $1,request_id,$2,'test',jsonb_build_object('requestId',request_id,'revision',0,'confirm',true,'channel','email'),'email',clock_timestamp()-interval '25 hours'
    FROM (SELECT gen_random_uuid() AS request_id FROM generate_series(1,26)) fixture
    RETURNING workspace_id,request_id,created_by
  ) INSERT INTO notification_events(workspace_id,user_id,kind,occurrence_key,policy_revision,grant_fingerprint,request_id,test_request_id,channel,expires_at)
    SELECT workspace_id,created_by,'test','manual:'||request_id::text,0,$3,request_id,request_id,'email',clock_timestamp()+interval '48 hours' FROM batches`,
    [f.workspace.id, owner.userId, 'a'.repeat(64)],
  );
  const first = await f.notifications.ownHistory(owner, f.workspace.id, {});
  expect(first.items).toHaveLength(25);
  expect(first.nextCursor).not.toBeNull();
  const second = await f.notifications.ownHistory(owner, f.workspace.id, {
    cursor: first.nextCursor,
  });
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  await expect(
    f.notifications.ownHistory(member, f.workspace.id, { cursor: first.nextCursor }),
  ).rejects.toMatchObject({ status: 404 });
  const other = await fixture();
  await expect(
    other.notifications.ownHistory(owner, other.workspace.id, { cursor: first.nextCursor }),
  ).rejects.toMatchObject({ status: 404 });
  if (!first.nextCursor) throw new Error('Missing cursor');
  const decoded: unknown = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
  if (typeof decoded !== 'object' || decoded === null) throw new Error('Invalid cursor');
  await expect(
    f.notifications.ownHistory(owner, f.workspace.id, {
      cursor: Buffer.from(JSON.stringify({ ...decoded, kind: 'other' })).toString('base64url'),
    }),
  ).rejects.toMatchObject({ status: 404 });
});
it('uncertain batch replay requires confirmation, permits one replay within ceilings and never requeues accepted events', async () => {
  const f = await fixture();
  await f.open();
  await pool.query(
    "UPDATE notification_events SET state='uncertain',terminal_at=clock_timestamp(),channel='email',email_attempts=1 WHERE pulse_id=$1",
    [f.pulse.id],
  );
  expect(
    (
      await f.notifications.retryBatch(owner, f.workspace.id, f.pulse.id, {
        requestId: randomUUID(),
        revision: 0,
        confirm: true,
      })
    ).queued,
  ).toBe(false);
  const body = { requestId: randomUUID(), revision: 0, confirm: true, confirmUncertain: true };
  expect((await f.notifications.retryBatch(owner, f.workspace.id, f.pulse.id, body)).queued).toBe(
    true,
  );
  expect(await f.notifications.retryBatch(owner, f.workspace.id, f.pulse.id, body)).toEqual({
    requestId: body.requestId,
    queued: true,
  });
  await pool.query(
    "UPDATE notification_events SET state='uncertain',terminal_at=clock_timestamp() WHERE pulse_id=$1",
    [f.pulse.id],
  );
  expect(
    (
      await f.notifications.retryBatch(owner, f.workspace.id, f.pulse.id, {
        ...body,
        requestId: randomUUID(),
      })
    ).queued,
  ).toBe(false);
  await pool.query(
    "UPDATE notification_events SET state='provider_accepted',terminal_at=clock_timestamp() WHERE pulse_id=$1",
    [f.pulse.id],
  );
  expect(
    (
      await f.notifications.retryBatch(owner, f.workspace.id, f.pulse.id, {
        ...body,
        requestId: randomUUID(),
      })
    ).queued,
  ).toBe(false);
});
it('SQL rejects cross-workspace event contexts, duplicate Slack owners and impossible state/lease/attempt combinations', async () => {
  const f = await fixture();
  await f.open();
  const other = await fixture();
  await expect(
    pool.query(
      "INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,policy_revision,grant_fingerprint,expires_at) VALUES($1,$2,$3,'invitation','open',1,$4,clock_timestamp())",
      [other.workspace.id, f.pulse.id, member.userId, 'a'.repeat(64)],
    ),
  ).rejects.toThrow();
  await expect(
    pool.query("UPDATE notification_events SET state='leased' WHERE pulse_id=$1", [f.pulse.id]),
  ).rejects.toThrow();
  await expect(
    pool.query('UPDATE notification_events SET email_attempts=4 WHERE pulse_id=$1', [f.pulse.id]),
  ).rejects.toThrow();
  await expect(
    pool.query("UPDATE notification_events SET state='uncertain' WHERE pulse_id=$1", [f.pulse.id]),
  ).rejects.toThrow();
  await pool.query(
    "INSERT INTO notification_slack_bindings(workspace_id,user_id,revision,team_id,slack_user_id,linked_at,grant_fingerprint) VALUES($1,$2,1,'T123','U123',clock_timestamp(),$3)",
    [f.workspace.id, member.userId, 'a'.repeat(64)],
  );
  await expect(
    pool.query(
      "INSERT INTO notification_slack_bindings(workspace_id,user_id,revision,team_id,slack_user_id,linked_at,grant_fingerprint) VALUES($1,$2,1,'T123','U123',clock_timestamp(),$3)",
      [f.workspace.id, owner.userId, 'a'.repeat(64)],
    ),
  ).rejects.toThrow();
});
it('redacts corrupt stored batch payloads', async () => {
  const f = await fixture();
  const body = { requestId: randomUUID(), revision: 0, confirm: true, channel: 'email' };
  await pool.query(
    "INSERT INTO notification_batches(workspace_id,request_id,created_by,kind,input,channel) VALUES($1,$2,$3,'test',$4::jsonb,'email')",
    [
      f.workspace.id,
      body.requestId,
      owner.userId,
      JSON.stringify({ recipient: 'private-fixture@example.com' }),
    ],
  );
  await expect(f.notifications.testDelivery(owner, f.workspace.id, body)).rejects.toMatchObject({
    status: 500,
    message: 'invalid_notification_record',
  });
});
it('own unlink advances binding revision and rejects stale writes without cancelling email-capable events', async () => {
  const f = await fixture();
  await f.open();
  expect(await f.notifications.ownLink(member, f.workspace.id)).toEqual({
    linked: false,
    revision: 0,
    linkedAt: null,
  });
  expect(await f.notifications.unlink(member, f.workspace.id, { revision: 0 })).toEqual({
    linked: false,
    revision: 1,
    linkedAt: null,
  });
  await expect(
    f.notifications.unlink(member, f.workspace.id, { revision: 0 }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.notifications.unlink(member, f.workspace.id, { revision: 1, userId: owner.userId }),
  ).rejects.toMatchObject({ status: 400 });
  expect((await f.notifications.ownHistory(member, f.workspace.id, {})).items[0]?.state).toBe(
    'pending',
  );
});
it('accepted response prevents reminders/retries; frozen roster survives membership removal', async () => {
  const f = await fixture();
  await f.open();
  await pool.query('INSERT INTO space_receipts(pulse_id,user_id) VALUES($1,$2)', [
    f.pulse.id,
    member.userId,
  ]);
  await f.notifications.remind(owner, f.workspace.id, f.pulse.id, {
    requestId: randomUUID(),
    revision: 0,
    confirm: true,
  });
  expect(
    (await f.notifications.ownHistory(member, f.workspace.id, {})).items.filter(
      (item) => item.kind === 'reminder',
    ),
  ).toHaveLength(0);
  await pool.query(
    "UPDATE notification_events SET state='failed',terminal_at=clock_timestamp(),channel='email',reason='provider_unavailable' WHERE pulse_id=$1 AND user_id=$2",
    [f.pulse.id, member.userId],
  );
  expect(
    (
      await f.notifications.retryBatch(owner, f.workspace.id, f.pulse.id, {
        requestId: randomUUID(),
        revision: 0,
        confirm: true,
      })
    ).queued,
  ).toBe(false);
  await pool.query(
    "INSERT INTO notification_slack_bindings(workspace_id,user_id,revision,team_id,slack_user_id,linked_at,grant_fingerprint) VALUES($1,$2,1,'T123','U123',clock_timestamp(),$3)",
    [f.workspace.id, member.userId, 'a'.repeat(64)],
  );
  await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
    f.workspace.id,
    member.userId,
  ]);
  expect(
    (
      await pool.query(
        'SELECT 1 FROM notification_slack_bindings WHERE workspace_id=$1 AND user_id=$2',
        [f.workspace.id, member.userId],
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query('SELECT 1 FROM space_roster WHERE pulse_id=$1 AND user_id=$2', [
        f.pulse.id,
        member.userId,
      ])
    ).rowCount,
  ).toBe(1);
  await expect(f.notifications.ownHistory(member, f.workspace.id, {})).rejects.toMatchObject({
    status: 404,
  });
});
it('configuration rotation and reminder disable fence new requests, without replaying cancelled events', async () => {
  const f = await fixture();
  await f.open();
  const config = f.config;
  if (!config) throw new Error('Fixture config required');
  f.rotate({
    ...config,
    grants: config.grants.map((grant) => ({ ...grant, fingerprint: 'b'.repeat(64) })),
  });
  await expect(
    f.notifications.remind(owner, f.workspace.id, f.pulse.id, {
      requestId: randomUUID(),
      revision: 0,
      confirm: true,
    }),
  ).rejects.toMatchObject({ status: 409 });
  f.rotate(config);
  await f.notifications.disableReminders(owner, f.workspace.id, f.pulse.id, { revision: 0 });
  await expect(
    f.notifications.remind(owner, f.workspace.id, f.pulse.id, {
      requestId: randomUUID(),
      revision: 1,
      confirm: true,
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it('submission markers survive cancellation as uncertainty; expired attempts can be purged without deleting dedup markers', async () => {
  const f = await fixture();
  await f.open();
  const token = randomUUID();
  await pool.query(
    "WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS t) UPDATE notification_events SET state='leased',lease_token=$3,updated_at=stamp.t,lease_until=stamp.t+interval '120 seconds',channel=NULL,email_attempts=1 FROM stamp WHERE pulse_id=$1 AND user_id=$2",
    [f.pulse.id, member.userId, token],
  );
  await pool.query(
    "INSERT INTO notification_attempts(workspace_id,event_id,lease_token,channel,attempt_number,grant_fingerprint,credential_fingerprint,email) SELECT workspace_id,id,$3,'email',1,grant_fingerprint,$4,'fixture@example.com' FROM notification_events WHERE pulse_id=$1 AND user_id=$2",
    [f.pulse.id, member.userId, token, 'c'.repeat(64)],
  );
  await withTransaction(pool, (client) =>
    suppressMemberNotifications(client, f.workspace.id, member.userId, f.pulse.id),
  );
  expect((await f.notifications.ownHistory(member, f.workspace.id, {})).items[0]?.state).toBe(
    'uncertain',
  );
  expect((await f.notifications.ownHistory(member, f.workspace.id, {})).items[0]?.channel).toBe(
    'email',
  );
  await pool.query('DELETE FROM notification_attempts WHERE workspace_id=$1', [f.workspace.id]);
  expect((await f.notifications.ownHistory(member, f.workspace.id, {})).items).toHaveLength(1);
  await withTransaction(pool, (client) =>
    capturePulseNotifications(client, f.workspace.id, f.pulse.id),
  );
  expect((await f.notifications.ownHistory(member, f.workspace.id, {})).items).toHaveLength(1);
});
it('SQL freezes pulse/event identities and bounds test recipient to request initiator', async () => {
  const f = await fixture();
  await f.open();
  await expect(
    pool.query('UPDATE notification_pulse_policies SET first_reminder_hours=24 WHERE pulse_id=$1', [
      f.pulse.id,
    ]),
  ).rejects.toThrow();
  await expect(
    pool.query('UPDATE notification_events SET user_id=$2 WHERE pulse_id=$1', [
      f.pulse.id,
      outsider.userId,
    ]),
  ).rejects.toThrow();
  const requestId = randomUUID();
  await pool.query(
    "INSERT INTO notification_batches(workspace_id,request_id,created_by,kind,input,channel) VALUES($1,$2,$3,'test',$4::jsonb,'email')",
    [
      f.workspace.id,
      requestId,
      owner.userId,
      JSON.stringify({ requestId, revision: 1, confirm: true, channel: 'email' }),
    ],
  );
  await expect(
    pool.query(
      "INSERT INTO notification_events(workspace_id,user_id,kind,occurrence_key,policy_revision,grant_fingerprint,request_id,test_request_id,channel,expires_at) VALUES($1,$2,'test','manual:'||$3::uuid::text,1,$4,$3::uuid,$3::uuid,'email',clock_timestamp()+interval '1 day')",
      [f.workspace.id, member.userId, requestId, 'a'.repeat(64)],
    ),
  ).rejects.toThrow();
  await pool.query(
    "UPDATE notification_events SET state='provider_accepted',channel='email',terminal_at=clock_timestamp() WHERE pulse_id=$1",
    [f.pulse.id],
  );
  await expect(
    pool.query(
      "UPDATE notification_events SET state='pending',terminal_at=NULL WHERE pulse_id=$1",
      [f.pulse.id],
    ),
  ).rejects.toThrow();
});
it('failed retry remains bounded by transport ceilings, expiry and verified current identity', async () => {
  const f = await fixture();
  await f.open();
  await pool.query(
    "UPDATE notification_events SET state='failed',channel='email',email_attempts=3,terminal_at=clock_timestamp(),reason='provider_unavailable' WHERE pulse_id=$1",
    [f.pulse.id],
  );
  expect(
    (
      await f.notifications.retryBatch(owner, f.workspace.id, f.pulse.id, {
        requestId: randomUUID(),
        revision: 0,
        confirm: true,
      })
    ).queued,
  ).toBe(false);
  const f2 = await fixture();
  await f2.open();
  await pool.query(
    "UPDATE notification_events SET state='failed',channel='email',email_attempts=1,terminal_at=clock_timestamp(),reason='provider_unavailable' WHERE pulse_id=$1 AND user_id=$2",
    [f2.pulse.id, member.userId],
  );
  await pool.query('UPDATE auth_users SET email_verified=false WHERE id=$1', [member.userId]);
  try {
    expect(
      (
        await f2.notifications.retryBatch(owner, f2.workspace.id, f2.pulse.id, {
          requestId: randomUUID(),
          revision: 0,
          confirm: true,
        })
      ).queued,
    ).toBe(false);
  } finally {
    await pool.query('UPDATE auth_users SET email_verified=true WHERE id=$1', [member.userId]);
  }
  await f2.notifications.remind(owner, f2.workspace.id, f2.pulse.id, {
    requestId: randomUUID(),
    revision: 0,
    confirm: true,
  });
  await pool.query(
    "UPDATE notification_events SET state='failed',channel='email',email_attempts=1,terminal_at=clock_timestamp(),reason='provider_unavailable' WHERE pulse_id=$1 AND kind='reminder'",
    [f2.pulse.id],
  );
  // Closure expiry uses database instants, not process time.
  await f2.space.transition(owner, f2.workspace.id, f2.pulse.id, 'close');
  await pool.query(
    "UPDATE space_pulses SET closed_at=clock_timestamp()-interval '8 days' WHERE id=$1",
    [f2.pulse.id],
  );
  // The real transition now creates closure events at close time (Task 4 wiring). Remove them so
  // this case still proves the hook itself refuses events once the seven-day window has elapsed.
  await pool.query("DELETE FROM notification_events WHERE pulse_id=$1 AND kind='closure'", [
    f2.pulse.id,
  ]);
  await withTransaction(pool, (client) =>
    closePulseNotifications(client, f2.workspace.id, f2.pulse.id),
  );
  expect(
    (await f2.notifications.ownHistory(member, f2.workspace.id, {})).items.filter(
      (item) => item.kind === 'closure',
    ),
  ).toHaveLength(0);
  expect(
    (
      await f2.notifications.retryBatch(owner, f2.workspace.id, f2.pulse.id, {
        requestId: randomUUID(),
        revision: 1,
        confirm: true,
      })
    ).queued,
  ).toBe(false);
});
it('SQL rejects reminders beyond frozen cap, wrong frozen grant and leases longer than 120 seconds', async () => {
  const f = await fixture();
  await f.open();
  await expect(
    pool.query(
      "INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,reminder_slot,policy_revision,grant_fingerprint,expires_at) VALUES($1,$2,$3,'reminder','auto:2',3,1,$4,clock_timestamp()+interval '48 hours')",
      [f.workspace.id, f.pulse.id, member.userId, 'a'.repeat(64)],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    pool.query(
      "INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,reminder_slot,policy_revision,grant_fingerprint,expires_at) VALUES($1,$2,$3,'reminder','auto:1',1,1,$4,clock_timestamp()+interval '48 hours')",
      [f.workspace.id, f.pulse.id, member.userId, 'b'.repeat(64)],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    pool.query(
      "WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS t) UPDATE notification_events SET state='leased',lease_token=$2,lease_until=stamp.t+interval '121 seconds',updated_at=stamp.t FROM stamp WHERE pulse_id=$1",
      [f.pulse.id, randomUUID()],
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
it('credential-only rotation preserves open-pulse reminders/closure while scope changes invalidate them', async () => {
  const f = await fixture();
  await f.open();
  if (!f.config) throw new Error('Fixture config required');
  f.rotate({
    ...f.config,
    grants: f.config.grants.map((grant) => ({ ...grant, credentialFingerprint: 'd'.repeat(64) })),
  });
  expect(
    (
      await f.notifications.remind(owner, f.workspace.id, f.pulse.id, {
        requestId: randomUUID(),
        revision: 0,
        confirm: true,
      })
    ).queued,
  ).toBe(true);
  await f.space.transition(owner, f.workspace.id, f.pulse.id, 'close');
  await withTransaction(pool, (client) =>
    closePulseNotifications(client, f.workspace.id, f.pulse.id),
  );
  expect(
    (await f.notifications.ownHistory(member, f.workspace.id, {})).items.filter(
      (item) => item.kind === 'closure',
    ),
  ).toHaveLength(1);
  const other = await fixture();
  await other.open();
  if (!other.config) throw new Error('Fixture config required');
  other.rotate({
    ...other.config,
    publicOrigin: 'http://127.0.0.1:5173',
    grants: other.config.grants.map((grant) => ({
      ...grant,
      fingerprint: 'b'.repeat(64),
      credentialFingerprint: 'd'.repeat(64),
    })),
  });
  await expect(
    other.notifications.remind(owner, other.workspace.id, other.pulse.id, {
      requestId: randomUUID(),
      revision: 0,
      confirm: true,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await other.notifications.updatePolicy(owner, other.workspace.id, {
    ...enabledPolicy,
    revision: 1,
  });
  await other.space.transition(owner, other.workspace.id, other.pulse.id, 'close');
  await withTransaction(pool, (client) =>
    closePulseNotifications(client, other.workspace.id, other.pulse.id),
  );
  expect(
    (await other.notifications.ownHistory(member, other.workspace.id, {})).items.filter(
      (item) => item.kind === 'closure',
    ),
  ).toHaveLength(0);
});
it('Slack enable rejects stale credential proof even when authorized scope/team remain unchanged', async () => {
  const f = await fixture();
  const grant = {
    workspaceId: f.workspace.id,
    fingerprint: 'a'.repeat(64),
    credentialFingerprint: 'c'.repeat(64),
    smtp: null,
    slack: {
      teamId: 'T123',
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
      botToken: 'fixture-token',
    },
  };
  const config: NotificationConfig = {
    mode: 'live',
    publicOrigin: 'https://clio.example.com',
    grants: [grant],
  };
  f.rotate({ ...config, grants: [{ ...grant, credentialFingerprint: 'd'.repeat(64) }] });
  await expect(
    f.notifications.updatePolicy(owner, f.workspace.id, enabledPolicy, {
      teamId: 'T123',
      grantFingerprint: grant.fingerprint,
      credentialFingerprint: grant.credentialFingerprint,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await f.notifications.updatePolicy(owner, f.workspace.id, enabledPolicy, {
        teamId: 'T123',
        grantFingerprint: grant.fingerprint,
        credentialFingerprint: 'd'.repeat(64),
      })
    ).revision,
  ).toBe(1);
});
it('own tests persist selected channel, serialize 24h throttle and replay before eligibility/throttle', async () => {
  const f = await fixture();
  if (!f.config) throw new Error('Fixture config required');
  const config: NotificationConfig = {
    ...f.config,
    mode: 'live',
    publicOrigin: 'https://clio.example.com',
    grants: f.config.grants.map((grant) => ({
      ...grant,
      slack: {
        teamId: 'T123',
        clientId: 'fixture-client',
        clientSecret: 'fixture-secret',
        botToken: 'fixture-token',
      },
    })),
  };
  f.rotate(config);
  await pool.query(
    "INSERT INTO notification_slack_bindings(workspace_id,user_id,revision,team_id,slack_user_id,linked_at,grant_fingerprint) VALUES($1,$2,1,'T123','U123',clock_timestamp(),$3)",
    [f.workspace.id, owner.userId, 'a'.repeat(64)],
  );
  const email = { requestId: randomUUID(), revision: 0, confirm: true, channel: 'email' };
  const slack = { ...email, requestId: randomUUID(), channel: 'slack' };
  const [first, replay] = await Promise.all([
    f.notifications.testDelivery(owner, f.workspace.id, email),
    f.notifications.testDelivery(owner, f.workspace.id, email),
  ]);
  expect(first).toEqual(replay);
  expect(first.queued).toBe(true);
  await expect(
    f.notifications.testDelivery(owner, f.workspace.id, { ...email, requestId: randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await f.notifications.testDelivery(owner, f.workspace.id, slack)).queued).toBe(true);
  await expect(
    f.notifications.testDelivery(owner, f.workspace.id, { ...email, channel: 'slack' }),
  ).rejects.toMatchObject({ status: 409 });
  const rows = await pool.query(
    'SELECT channel FROM notification_events WHERE workspace_id=$1 ORDER BY channel',
    [f.workspace.id],
  );
  expect(rows.rows).toEqual([{ channel: 'email' }, { channel: 'slack' }]);
  await f.notifications.unlink(owner, f.workspace.id, { revision: 1 });
  f.rotate(null);
  expect(await f.notifications.testDelivery(owner, f.workspace.id, slack)).toEqual({
    requestId: slack.requestId,
    queued: true,
  });
  expect(await f.notifications.testDelivery(owner, f.workspace.id, email)).toEqual(first);
  const another = await fixture();
  expect(
    (
      await another.notifications.testDelivery(owner, another.workspace.id, {
        ...email,
        requestId: randomUUID(),
      })
    ).queued,
  ).toBe(true);
});
it('selected own-test channel cannot fall back or retarget and wrong-channel attempt is rejected', async () => {
  const f = await fixture();
  const body = { requestId: randomUUID(), revision: 0, confirm: true, channel: 'slack' };
  // SMTP remains available, but cannot make a selected Slack test eligible.
  expect((await f.notifications.testDelivery(owner, f.workspace.id, body)).queued).toBe(false);
  expect((await f.notifications.ownHistory(owner, f.workspace.id, {})).items).toHaveLength(0);
  await expect(
    pool.query(
      "UPDATE notification_batches SET channel='email' WHERE workspace_id=$1 AND request_id=$2",
      [f.workspace.id, body.requestId],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  const email = { ...body, requestId: randomUUID(), channel: 'email' };
  await f.notifications.testDelivery(owner, f.workspace.id, email);
  await expect(
    pool.query(
      "UPDATE notification_events SET channel='slack' WHERE workspace_id=$1 AND kind='test'",
      [f.workspace.id],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    pool.query(
      "INSERT INTO notification_attempts(workspace_id,event_id,lease_token,channel,attempt_number,grant_fingerprint,credential_fingerprint,binding_revision,slack_team_id,slack_user_id) SELECT workspace_id,id,$2,'slack',1,grant_fingerprint,$3,1,'T123','U123' FROM notification_events WHERE workspace_id=$1",
      [f.workspace.id, randomUUID(), 'c'.repeat(64)],
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
it('blind uncertain requeue is forbidden; confirmed replay resolves old unfinished marker once; terminal invalidation stays legal', async () => {
  const f = await fixture();
  await f.open();
  const token = randomUUID();
  await pool.query(
    "WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS t) UPDATE notification_events SET state='leased',updated_at=stamp.t,lease_until=stamp.t+interval '120 seconds',lease_token=$3,email_attempts=1 FROM stamp WHERE pulse_id=$1 AND user_id=$2",
    [f.pulse.id, member.userId, token],
  );
  await pool.query(
    "INSERT INTO notification_attempts(workspace_id,event_id,lease_token,channel,attempt_number,grant_fingerprint,credential_fingerprint,email) SELECT workspace_id,id,$3,'email',1,grant_fingerprint,$4,'fixture@example.com' FROM notification_events WHERE pulse_id=$1 AND user_id=$2",
    [f.pulse.id, member.userId, token, 'c'.repeat(64)],
  );
  await withTransaction(pool, (client) =>
    suppressMemberNotifications(client, f.workspace.id, member.userId, f.pulse.id),
  );
  await expect(
    pool.query(
      "UPDATE notification_events SET state='pending',terminal_at=NULL WHERE pulse_id=$1 AND user_id=$2",
      [f.pulse.id, member.userId],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  const request = { requestId: randomUUID(), revision: 0, confirm: true, confirmUncertain: true };
  expect(
    (await f.notifications.retryBatch(owner, f.workspace.id, f.pulse.id, request)).queued,
  ).toBe(true);
  const attempts = await pool.query(
    'SELECT outcome,reason,completed_at IS NOT NULL AS completed FROM notification_attempts WHERE workspace_id=$1',
    [f.workspace.id],
  );
  expect(attempts.rows).toEqual([
    { outcome: 'uncertain', reason: 'acceptance_unknown', completed: true },
  ]);
  await pool.query(
    "UPDATE notification_events SET state='uncertain',terminal_at=clock_timestamp() WHERE pulse_id=$1 AND user_id=$2",
    [f.pulse.id, member.userId],
  );
  expect(
    (
      await f.notifications.retryBatch(owner, f.workspace.id, f.pulse.id, {
        ...request,
        requestId: randomUUID(),
      })
    ).queued,
  ).toBe(false);
  await pool.query(
    "UPDATE notification_events SET state='skipped',reason='access_removed' WHERE pulse_id=$1 AND user_id=$2",
    [f.pulse.id, member.userId],
  );
  expect((await f.notifications.ownHistory(member, f.workspace.id, {})).items[0]?.state).toBe(
    'skipped',
  );
});
it('uncertainty cannot be laundered through failed into an unconfirmed replay', async () => {
  const f = await fixture();
  await f.open();
  await pool.query(
    "UPDATE notification_events SET state='uncertain',channel='email',email_attempts=1,reason='acceptance_unknown',terminal_at=clock_timestamp() WHERE pulse_id=$1 AND user_id=$2",
    [f.pulse.id, member.userId],
  );
  const snapshot = () =>
    pool.query(
      'SELECT state,channel,email_attempts,uncertain_replays,reason,terminal_at FROM notification_events WHERE pulse_id=$1 AND user_id=$2',
      [f.pulse.id, member.userId],
    );
  const before = await snapshot();
  expect(before.rows[0]).toMatchObject({ state: 'uncertain', uncertain_replays: 0 });
  await expect(
    pool.query(
      "UPDATE notification_events SET state='failed',reason='provider_unavailable' WHERE pulse_id=$1 AND user_id=$2",
      [f.pulse.id, member.userId],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  expect((await snapshot()).rows).toEqual(before.rows);
  expect(
    (
      await f.notifications.retryBatch(owner, f.workspace.id, f.pulse.id, {
        requestId: randomUUID(),
        revision: 0,
        confirm: true,
      })
    ).queued,
  ).toBe(false);
  await expect(
    pool.query(
      "UPDATE notification_events SET state='pending',terminal_at=NULL WHERE pulse_id=$1 AND user_id=$2",
      [f.pulse.id, member.userId],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  expect((await snapshot()).rows).toEqual(before.rows);
});
it('OAuth state defaults share exactly one five-minute DB clock and require credential fence', async () => {
  const f = await fixture();
  const result = await pool.query(
    "INSERT INTO notification_oauth_states(state_hash,nonce_hash,workspace_id,user_id,session_id,team_id,grant_fingerprint,credential_fingerprint,binding_revision) VALUES($1,$2,$3,$4,$5,'T123',$6,$7,0) RETURNING expires_at-created_at=interval '5 minutes' AS exact",
    [
      '1'.repeat(64),
      '2'.repeat(64),
      f.workspace.id,
      owner.userId,
      owner.sessionId,
      'a'.repeat(64),
      'c'.repeat(64),
    ],
  );
  expect(result.rows[0]?.exact).toBe(true);
  await expect(
    pool.query(
      "INSERT INTO notification_oauth_states(state_hash,nonce_hash,workspace_id,user_id,session_id,team_id,grant_fingerprint,credential_fingerprint,binding_revision) VALUES($1,$2,$3,$4,$5,'T123',$6,'invalid',0)",
      [
        '3'.repeat(64),
        '4'.repeat(64),
        f.workspace.id,
        owner.userId,
        owner.sessionId,
        'a'.repeat(64),
      ],
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
it('scheduler recipient cursor persists independently of completed/latest slot and rejects invalid advancement; pulse-off reason stays private', async () => {
  const f = await fixture();
  await f.open();
  await pool.query(
    'UPDATE notification_pulse_policies SET scheduler_active_slot=2 WHERE pulse_id=$1',
    [f.pulse.id],
  );
  await pool.query(
    'UPDATE notification_pulse_policies SET scheduler_recipient_cursor=$2 WHERE pulse_id=$1',
    [f.pulse.id, member.userId],
  );
  expect(
    (
      await pool.query(
        'SELECT scheduler_slot,scheduler_active_slot,scheduler_recipient_cursor FROM notification_pulse_policies WHERE pulse_id=$1',
        [f.pulse.id],
      )
    ).rows[0],
  ).toEqual({
    scheduler_slot: 0,
    scheduler_active_slot: 2,
    scheduler_recipient_cursor: member.userId,
  });
  await expect(
    pool.query(
      'UPDATE notification_pulse_policies SET scheduler_active_slot=1,scheduler_recipient_cursor=NULL WHERE pulse_id=$1',
      [f.pulse.id],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    pool.query(
      'UPDATE notification_pulse_policies SET scheduler_recipient_cursor=$2 WHERE pulse_id=$1',
      [f.pulse.id, 'a'],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    pool.query('UPDATE notification_pulse_policies SET scheduler_slot=2 WHERE pulse_id=$1', [
      f.pulse.id,
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  await pool.query(
    'UPDATE notification_pulse_policies SET scheduler_slot=2,scheduler_active_slot=NULL,scheduler_recipient_cursor=NULL WHERE pulse_id=$1',
    [f.pulse.id],
  );
  await f.notifications.remind(owner, f.workspace.id, f.pulse.id, {
    requestId: randomUUID(),
    revision: 0,
    confirm: true,
  });
  await f.notifications.disableReminders(owner, f.workspace.id, f.pulse.id, { revision: 0 });
  expect(
    (
      await pool.query(
        "SELECT reason FROM notification_events WHERE pulse_id=$1 AND kind='reminder' LIMIT 1",
        [f.pulse.id],
      )
    ).rows[0]?.reason,
  ).toBe('reminders_disabled');
  expect(
    JSON.stringify(await f.notifications.summary(owner, f.workspace.id, f.pulse.id)),
  ).not.toContain('reminders_disabled');
  await pool.query(
    "INSERT INTO notification_slack_budgets(team_id) VALUES('T123') ON CONFLICT DO NOTHING",
  );
  await pool.query(
    "INSERT INTO notification_slack_cooldowns(team_id,method,blocked_until) VALUES('T123','auth.test',clock_timestamp()+interval '10 seconds')",
  );
});

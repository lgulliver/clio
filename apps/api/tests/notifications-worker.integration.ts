import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrations.ts';
import { withTransaction } from '../src/db/pool.ts';
import { createIdentityRepository } from '../src/features/identity/repository.ts';
import { type NotificationConfig, smtpPacingKey } from '../src/features/notifications/config.ts';
import type {
  DispatchResult,
  NoticeMessage,
  NotificationBatch,
} from '../src/features/notifications/contract.ts';
import { capturePulseNotifications } from '../src/features/notifications/events.ts';
import { createNotificationJobs } from '../src/features/notifications/jobs.ts';
import { maintainNotifications } from '../src/features/notifications/maintenance.ts';
import type { NotificationProvider } from '../src/features/notifications/provider.ts';
import { createNotificationRepository } from '../src/features/notifications/repository.ts';
import { advanceNotificationSchedule } from '../src/features/notifications/scheduler.ts';
import {
  processOneNotification,
  runNotificationCycle,
} from '../src/features/notifications/worker.ts';
import { createOrganizationRepository } from '../src/features/organization/repository.ts';
import { instrument } from '../src/features/space/contract.ts';
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
const owner = { userId: 'worker-owner', sessionId: 'worker-owner-session' };
const member = { userId: 'worker-member', sessionId: 'worker-member-session' };
const slackIds: Readonly<Record<string, string>> = {
  [owner.userId]: 'UOWNER0001',
  [member.userId]: 'UMEMBER0001',
};
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
const answer = {
  instrumentVersion: instrument.version,
  answers: {
    satisfaction: 4,
    sustainable_workload: null,
    useful_outcomes: null,
    contribution_frequency: null,
    useful_help: null,
    shared_context: null,
    effective_tools: null,
    focus_time: null,
  },
};
const identity = createIdentityRepository(pool);
const space = createSpaceRepository(pool);
let created = false;
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool);
  for (const actor of [owner, member]) {
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
  vi.useRealTimers();
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

type Script = Partial<{
  openDm: (slackUserId: string) => Promise<{ channelId: string } | DispatchResult>;
  sendSlack: (slackUserId: string) => Promise<DispatchResult>;
  sendEmail: (email: string) => Promise<DispatchResult>;
}>;
const accepted: DispatchResult = { outcome: 'accepted' };
const refused = (retryable: boolean, retryAfterMs?: number): DispatchResult => ({
  outcome: 'not_accepted',
  retryable,
  reason: 'provider_unavailable',
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});
const uncertain: DispatchResult = { outcome: 'uncertain', reason: 'acceptance_unknown' };
/** Private fixture only: never part of a provider or public API. */
function recorder(script: Script = {}) {
  const calls: string[] = [];
  const stamps: { call: string; at: number }[] = [];
  const credentials: string[] = [];
  const signals: boolean[] = [];
  const sent: { channel: 'slack' | 'email'; to: string; message: NoticeMessage }[] = [];
  const provider: NotificationProvider = {
    verifySlack: async (grant) => ({ teamId: grant.slack?.teamId ?? '' }),
    openDm: async (_grant, userId) => {
      calls.push('openDm');
      stamps.push({ call: 'openDm', at: Date.now() });
      return script.openDm ? script.openDm(userId) : { channelId: `D${userId}` };
    },
    sendSlack: async (grant, channelId, message, signal) => {
      credentials.push(grant.credentialFingerprint);
      signals.push(signal.aborted);
      calls.push('sendSlack');
      stamps.push({ call: 'sendSlack', at: Date.now() });
      const to = channelId.slice(1);
      sent.push({ channel: 'slack', to, message });
      return script.sendSlack ? script.sendSlack(to) : accepted;
    },
    sendEmail: async (grant, email, message, signal) => {
      credentials.push(grant.credentialFingerprint);
      signals.push(signal.aborted);
      calls.push('sendEmail');
      stamps.push({ call: 'sendEmail', at: Date.now() });
      sent.push({ channel: 'email', to: email, message });
      return script.sendEmail ? script.sendEmail(email) : accepted;
    },
  };
  return {
    provider,
    calls,
    stamps,
    credentials,
    signals,
    sent,
    messagesFor: (userId: string) =>
      sent.filter((item) => item.to === `${userId}@example.com` || item.to === slackIds[userId]),
  };
}
const never = <T>() => new Promise<T>(() => undefined);
async function until(check: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 200; index += 1) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error('Condition not reached');
}

async function world(
  options: { slack?: boolean; extra?: number; keep?: boolean; rate?: number } = {},
) {
  // Earlier fixtures must not leak work or schedules into this world's global worker queries.
  if (!options.keep) {
    await pool.query(
      "DELETE FROM notification_events WHERE state IN ('pending','retry_scheduled','leased')",
    );
    await pool.query('UPDATE notification_pulse_policies SET reminders_enabled=false');
  }
  const workspace = await identity.createWorkspace(owner, `Worker ${randomUUID()}`);
  await pool.query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    [workspace.id, member.userId],
  );
  const team = await createOrganizationRepository(pool).createTeam(owner, workspace.id, 'Team');
  await space.assign(owner, workspace.id, member.userId, { teamId: team.id });
  await space.assign(owner, workspace.id, owner.userId, { teamId: team.id });
  if (options.extra) {
    const prefix = `bulk-${randomUUID().slice(0, 8)}-`;
    await pool.query(
      "INSERT INTO auth_users(id,name,email,email_verified) SELECT $1||g,$1||g,$1||g||'@example.com',true FROM generate_series(1,$2::int) g",
      [prefix, options.extra],
    );
    await pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) SELECT $1,$2||g,'member' FROM generate_series(1,$3::int) g",
      [workspace.id, prefix, options.extra],
    );
    await pool.query(
      'INSERT INTO space_assignments(workspace_id,user_id,team_id) SELECT $1,$2||g,$3 FROM generate_series(1,$4::int) g',
      [workspace.id, prefix, team.id, options.extra],
    );
  }
  const teamId = `T${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  const fingerprint = randomBytes(32).toString('hex');
  const credentialFingerprint = randomBytes(32).toString('hex');
  const smtpHost = `smtp-${randomUUID()}.example.test`;
  const build = (
    scope: string,
    credentials: string,
    password = 'password',
    rate = options.rate ?? 60,
  ): NotificationConfig => ({
    mode: 'live',
    publicOrigin: 'https://clio.example.test',
    grants: [
      {
        workspaceId: workspace.id,
        fingerprint: scope,
        credentialFingerprint: credentials,
        smtp: {
          host: smtpHost,
          port: 465,
          user: 'user',
          password,
          from: 'clio@example.test',
          ratePerMinute: rate,
        },
        slack: options.slack
          ? { teamId, botToken: 'token', clientId: 'client', clientSecret: 'secret' }
          : null,
      },
    ],
  });
  let config: NotificationConfig | null = build(fingerprint, credentialFingerprint);
  const notifications = createNotificationRepository(pool, config, {
    configNow: async () => config,
  });
  const pulse = await space.create(owner, workspace.id, {
    teamId: team.id,
    referenceStart: '2026-01-01T00:00:00.000Z',
    referenceEnd: '2026-01-08T00:00:00.000Z',
  });
  const wid = workspace.id;
  const w = {
    wid,
    pulse,
    teamId,
    fingerprint,
    notifications,
    build,
    rotate(next: NotificationConfig | null) {
      config = next;
    },
    async enable(overrides: Partial<typeof enabledPolicy> = {}) {
      const before = await notifications.policy(owner, wid);
      return notifications.updatePolicy(
        owner,
        wid,
        { ...enabledPolicy, ...overrides, revision: before.revision },
        { teamId, grantFingerprint: fingerprint, credentialFingerprint },
      );
    },
    open: () => space.transition(owner, wid, pulse.id, 'open'),
    close: () => space.transition(owner, wid, pulse.id, 'close'),
    cancel: () => space.transition(owner, wid, pulse.id, 'cancel'),
    async link(userId: string) {
      await pool.query(
        `INSERT INTO notification_slack_bindings(workspace_id,user_id,revision,team_id,slack_user_id,grant_fingerprint,linked_at)
        VALUES($1,$2,1,$3,$4,$5,clock_timestamp()) ON CONFLICT(workspace_id,user_id) DO UPDATE SET revision=notification_slack_bindings.revision+1,team_id=EXCLUDED.team_id,slack_user_id=EXCLUDED.slack_user_id,grant_fingerprint=EXCLUDED.grant_fingerprint,linked_at=EXCLUDED.linked_at`,
        [wid, userId, teamId, slackIds[userId], fingerprint],
      );
    },
    read: async () => config,
    run: (
      provider: NotificationProvider,
      signal?: AbortSignal,
      configNow: () => Promise<NotificationConfig | null> = async () => config,
      seams: {
        callWindowMs?: number;
        beforeDispatch?: () => Promise<void>;
        beforeOpen?: () => Promise<void>;
      } = {},
    ) =>
      processOneNotification(pool, config, {
        provider,
        configNow,
        ...(signal ? { signal } : {}),
        ...seams,
      }),
    async pace(milliseconds: number) {
      const smtp = build(fingerprint, credentialFingerprint).grants[0]?.smtp;
      if (!smtp) throw new Error('fixture');
      await pool.query(
        'INSERT INTO notification_smtp_budgets(pacing_key,next_send_at) VALUES($1,clock_timestamp()+make_interval(secs=>$2::double precision/1000.0)) ON CONFLICT(pacing_key) DO UPDATE SET next_send_at=EXCLUDED.next_send_at',
        [smtpPacingKey(smtp), milliseconds],
      );
    },
    async unpace() {
      await pool.query(
        "UPDATE notification_slack_budgets SET next_send_at=clock_timestamp()-interval '1 second'",
      );
      await pool.query(
        "UPDATE notification_smtp_budgets SET next_send_at=clock_timestamp()-interval '1 second'",
      );
    },
    async drain(provider: NotificationProvider) {
      for (let index = 0; index < 40; index += 1) {
        await w.unpace();
        if (!(await w.run(provider))) return;
      }
      throw new Error('Worker did not drain');
    },
    async events(filter = '') {
      const result = await pool.query(
        `SELECT user_id,kind,state,channel,reason,occurrence_key,reminder_slot,slack_attempts,email_attempts,uncertain_replays
        FROM notification_events WHERE workspace_id=$1 ${filter} ORDER BY kind,occurrence_key,user_id`,
        [wid],
      );
      return result.rows;
    },
    async backdate(interval: string) {
      await withTransaction(pool, async (client) => {
        await client.query(
          'ALTER TABLE notification_pulse_policies DISABLE TRIGGER notification_freeze_pulse_policy_trigger',
        );
        await client.query(
          'UPDATE notification_pulse_policies SET opened_at=opened_at-$2::interval WHERE pulse_id=$1',
          [pulse.id, interval],
        );
        await client.query(
          'ALTER TABLE notification_pulse_policies ENABLE TRIGGER notification_freeze_pulse_policy_trigger',
        );
      });
    },
    async expireLease() {
      await pool.query(
        "UPDATE notification_events SET lease_until=created_at+interval '1 millisecond' WHERE workspace_id=$1 AND state='leased'",
        [wid],
      );
    },
  };
  return w;
}
async function count(sql: string, values: unknown[]): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count ${sql}`,
    values,
  );
  return result.rows[0]?.count ?? -1;
}
async function forceFailure(operation: 'INSERT' | 'UPDATE', run: () => Promise<unknown>) {
  await pool.query(
    "CREATE OR REPLACE FUNCTION fail_notification_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced outbox failure' USING ERRCODE='23514'; END; $$",
  );
  await pool.query(
    `CREATE TRIGGER force_notification_failure BEFORE ${operation} ON notification_events FOR EACH ROW EXECUTE FUNCTION fail_notification_write()`,
  );
  try {
    await expect(run()).rejects.toMatchObject({ code: '23514' });
  } finally {
    await pool.query('DROP TRIGGER force_notification_failure ON notification_events');
  }
}

it('keeps default-disabled pulses free of sendable events through open, response and close', async () => {
  const w = await world();
  await w.open();
  await space.submit(member, w.wid, w.pulse.id, answer);
  await w.close();
  expect(await w.events()).toEqual([]);
  const fake = recorder();
  expect(await w.run(fake.provider)).toBe(false);
  expect(fake.calls).toEqual([]);
});

it('delivers invitations for the frozen roster and suppresses a member who responded', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await space.submit(member, w.wid, w.pulse.id, answer);
  const recorded = recorder();
  await w.drain(recorded.provider);
  expect(recorded.messagesFor(member.userId)).toEqual([]);
  expect(recorded.messagesFor(owner.userId)).toHaveLength(1);
  expect(recorded.messagesFor(owner.userId)[0]?.message.text).toContain(
    `https://clio.example.test/developer-experience?workspace=${w.wid}&pulse=${w.pulse.id}`,
  );
  expect(await space.get(member, w.wid, w.pulse.id)).toMatchObject({ submitted: true });
  expect(await w.events("AND user_id='worker-member'")).toMatchObject([
    { kind: 'invitation', state: 'skipped', reason: 'response_received' },
  ]);
});

it('never joins respondents to raw answers and keeps replays from duplicating events', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  const columns = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='space_answers'",
  );
  expect(columns.rows.map((row: { column_name: string }) => row.column_name).join()).not.toMatch(
    /user/,
  );
  await space.submit(member, w.wid, w.pulse.id, answer);
  const afterSubmit = await w.events();
  await space.submit(member, w.wid, w.pulse.id, answer);
  expect(await w.events()).toEqual(afterSubmit);
  await w.close();
  const afterClose = await w.events();
  expect(afterClose.filter((row) => row.kind === 'closure')).toHaveLength(2);
  await w.close();
  expect(await w.events()).toEqual(afterClose);
  const other = await world();
  await other.enable();
  await other.open();
  await other.cancel();
  const afterCancel = await other.events();
  expect(afterCancel.every((row) => row.state === 'skipped')).toBe(true);
  await other.cancel();
  expect(await other.events()).toEqual(afterCancel);
});

it('rolls pulse opening back when the outbox rejects the invitation write', async () => {
  const w = await world();
  await w.enable();
  await forceFailure('INSERT', () => w.open());
  expect(
    (await pool.query('SELECT state FROM space_pulses WHERE id=$1', [w.pulse.id])).rows[0]?.state,
  ).toBe('draft');
  expect(await count('FROM space_roster WHERE pulse_id=$1', [w.pulse.id])).toBe(0);
  expect(await count('FROM notification_pulse_policies WHERE pulse_id=$1', [w.pulse.id])).toBe(0);
  await w.open();
  expect(await count('FROM notification_events WHERE pulse_id=$1', [w.pulse.id])).toBe(2);
});

it('rolls closing back with raw-answer retention intact, then closes normally', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await space.submit(member, w.wid, w.pulse.id, answer);
  await forceFailure('INSERT', () => w.close());
  expect(
    (await pool.query('SELECT state FROM space_pulses WHERE id=$1', [w.pulse.id])).rows[0]?.state,
  ).toBe('open');
  expect(await count('FROM space_answers WHERE pulse_id=$1', [w.pulse.id])).toBe(1);
  expect(
    await count("FROM notification_events WHERE pulse_id=$1 AND kind='closure'", [w.pulse.id]),
  ).toBe(0);
  await w.close();
  expect(await count('FROM space_answers WHERE pulse_id=$1', [w.pulse.id])).toBe(0);
  expect(
    await count("FROM notification_events WHERE pulse_id=$1 AND kind='closure'", [w.pulse.id]),
  ).toBe(2);
});

it('rolls a response back when suppression cannot commit, and cancellation likewise', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await forceFailure('UPDATE', () => space.submit(member, w.wid, w.pulse.id, answer));
  expect(await count('FROM space_receipts WHERE pulse_id=$1', [w.pulse.id])).toBe(0);
  expect(await count('FROM space_answers WHERE pulse_id=$1', [w.pulse.id])).toBe(0);
  await space.submit(member, w.wid, w.pulse.id, answer);
  expect(await count('FROM space_answers WHERE pulse_id=$1', [w.pulse.id])).toBe(1);
  await forceFailure('UPDATE', () => w.cancel());
  expect(
    (await pool.query('SELECT state FROM space_pulses WHERE id=$1', [w.pulse.id])).rows[0]?.state,
  ).toBe('open');
  expect(await count('FROM space_answers WHERE pulse_id=$1', [w.pulse.id])).toBe(1);
});

it('keeps a frozen roster member after a team move and invalidates work on member revocation', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await space.assign(owner, w.wid, member.userId, { teamId: null });
  const kept = recorder();
  await w.drain(kept.provider);
  expect(kept.messagesFor(member.userId)).toHaveLength(1);
  const gone = await world();
  await gone.enable();
  await gone.open();
  await gone.link(member.userId);
  await identity.revokeMember(owner, gone.wid, member.userId);
  const quiet = recorder();
  await gone.drain(quiet.provider);
  expect(quiet.messagesFor(member.userId)).toEqual([]);
  expect(await gone.events("AND user_id='worker-member'")).toMatchObject([
    { state: 'skipped', reason: 'access_removed' },
  ]);
  expect(await count('FROM notification_slack_bindings WHERE workspace_id=$1', [gone.wid])).toBe(0);
});

it('re-checks current receipts and membership before every attempt even when no hook ran', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  // Direct writes bypass lifecycle hooks, so only the worker's own current-context check can stop sends.
  await pool.query('INSERT INTO space_receipts(pulse_id,user_id) VALUES($1,$2)', [
    w.pulse.id,
    member.userId,
  ]);
  await pool.query("UPDATE notification_events SET state='pending' WHERE workspace_id=$1", [w.wid]);
  const fake = recorder();
  await w.drain(fake.provider);
  expect(fake.messagesFor(member.userId)).toEqual([]);
  expect(fake.messagesFor(owner.userId)).toHaveLength(1);
  expect(await w.events("AND user_id='worker-member'")).toMatchObject([
    { state: 'skipped', reason: 'response_received' },
  ]);
  const gone = await world();
  await gone.enable();
  await gone.open();
  await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
    gone.wid,
    member.userId,
  ]);
  const quiet = recorder();
  await gone.drain(quiet.provider);
  expect(quiet.messagesFor(member.userId)).toEqual([]);
  expect(await gone.events("AND user_id='worker-member'")).toMatchObject([
    { state: 'skipped', reason: 'access_removed' },
  ]);
});

it('routes Slack first, goes straight to email without a link, and never falls back after acceptance', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  const fake = recorder();
  await w.drain(fake.provider);
  expect(fake.messagesFor(member.userId).map((item) => item.channel)).toEqual(['slack']);
  expect(fake.messagesFor(owner.userId).map((item) => item.channel)).toEqual(['email']);
  expect(await w.events("AND user_id='worker-member'")).toMatchObject([
    { state: 'provider_accepted', channel: 'slack', slack_attempts: 1, email_attempts: 0 },
  ]);
});

it('falls back to verified email after a definitive Slack refusal', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  const fake = recorder({
    openDm: async () => refused(false),
  });
  await w.drain(fake.provider);
  expect(fake.calls).not.toContain('sendSlack');
  expect(await w.events("AND user_id='worker-member'")).toMatchObject([
    { state: 'provider_accepted', channel: 'email', slack_attempts: 1, email_attempts: 1 },
  ]);
});

it('does not requeue exhausted email fallback through unused Slack capacity and preserves exact batch replay', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  await onlyMember(w);
  const first = recorder({
    sendSlack: async () => refused(false),
    sendEmail: async () => refused(false),
  });
  await w.drain(first.provider);
  expect(first.calls).toEqual(['openDm', 'sendSlack', 'sendEmail']);
  expect(await w.events()).toMatchObject([
    { state: 'failed', channel: 'email', slack_attempts: 1, email_attempts: 1 },
  ]);
  const retryBody = { requestId: randomUUID(), revision: 0, confirm: true };
  const committed = await w.notifications.retryBatch(owner, w.wid, w.pulse.id, retryBody);
  expect(committed.queued).toBe(true);
  const more = recorder({ sendEmail: async () => refused(true) });
  await w.unpace();
  expect(await w.run(more.provider)).toBe(true);
  expect(await w.events()).toMatchObject([
    { state: 'retry_scheduled', channel: 'email', slack_attempts: 1, email_attempts: 2 },
  ]);
  await pool.query(
    "UPDATE notification_events SET available_at=clock_timestamp() WHERE workspace_id=$1 AND state='retry_scheduled'",
    [w.wid],
  );
  await w.drain(more.provider);
  expect(more.calls).toEqual(['sendEmail', 'sendEmail']);
  const before = await w.events();
  expect(before).toMatchObject([
    { state: 'failed', channel: 'email', slack_attempts: 1, email_attempts: 3 },
  ]);
  const attemptsBefore = await count('FROM notification_attempts WHERE workspace_id=$1', [w.wid]);
  expect(attemptsBefore).toBe(4);
  expect(
    (
      await w.notifications.retryBatch(owner, w.wid, w.pulse.id, {
        requestId: randomUUID(),
        revision: 0,
        confirm: true,
      })
    ).queued,
  ).toBe(false);
  expect(await w.events()).toEqual(before);
  const none = recorder();
  expect(await w.run(none.provider)).toBe(false);
  expect(none.calls).toEqual([]);
  expect(await count('FROM notification_attempts WHERE workspace_id=$1', [w.wid])).toBe(
    attemptsBefore,
  );
  // Current eligibility/configuration must not invalidate an already committed exact request.
  w.rotate(null);
  expect(await w.notifications.retryBatch(owner, w.wid, w.pulse.id, retryBody)).toEqual(committed);
  expect(await w.events()).toEqual(before);
});

it('retries terminal email fallback with remaining email capacity without returning to Slack', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  await onlyMember(w);
  await w.drain(
    recorder({ sendSlack: async () => refused(false), sendEmail: async () => refused(false) })
      .provider,
  );
  expect(
    (
      await w.notifications.retryBatch(owner, w.wid, w.pulse.id, {
        requestId: randomUUID(),
        revision: 0,
        confirm: true,
      })
    ).queued,
  ).toBe(true);
  expect(await w.events()).toMatchObject([
    { state: 'pending', channel: 'email', email_attempts: 1 },
  ]);
  const retry = recorder();
  await w.drain(retry.provider);
  expect(retry.calls).toEqual(['sendEmail']);
  expect(await w.events()).toMatchObject([
    { state: 'provider_accepted', channel: 'email', slack_attempts: 1, email_attempts: 2 },
  ]);
});

it('makes at most three known-safe Slack attempts with bounded backoff, then falls back', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    owner.userId,
  ]);
  const fake = recorder({ sendSlack: async () => refused(true, 5000) });
  await w.unpace();
  expect(await w.run(fake.provider)).toBe(true);
  const first = await pool.query(
    "SELECT state,(available_at>clock_timestamp()+interval '20 seconds') AS delayed FROM notification_events WHERE workspace_id=$1",
    [w.wid],
  );
  expect(first.rows[0]).toEqual({ state: 'retry_scheduled', delayed: true });
  const cooldown = await pool.query(
    "SELECT (blocked_until>clock_timestamp()+interval '3 seconds') AS blocked FROM notification_slack_cooldowns WHERE method='chat.postMessage' AND team_id=$1",
    [w.teamId],
  );
  expect(cooldown.rows[0]).toEqual({ blocked: true });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await pool.query(
      "UPDATE notification_events SET available_at=clock_timestamp() WHERE workspace_id=$1 AND state='retry_scheduled'",
      [w.wid],
    );
    await pool.query('UPDATE notification_slack_cooldowns SET blocked_until=clock_timestamp()');
    await w.unpace();
    await w.run(fake.provider);
  }
  expect(await w.events()).toMatchObject([
    { state: 'provider_accepted', channel: 'email', slack_attempts: 3, email_attempts: 1 },
  ]);
  expect(fake.calls.filter((call) => call === 'sendSlack')).toHaveLength(3);
});

it('treats uncertain Slack and uncertain SMTP as terminal uncertainty without blind fallback or retry', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  const fake = recorder({ sendSlack: async () => uncertain, sendEmail: async () => uncertain });
  await w.drain(fake.provider);
  expect(await w.events()).toMatchObject([
    {
      user_id: 'worker-member',
      state: 'uncertain',
      channel: 'slack',
      slack_attempts: 1,
      email_attempts: 0,
    },
    { user_id: 'worker-owner', state: 'uncertain', channel: 'email', email_attempts: 1 },
  ]);
  expect(fake.calls.filter((call) => call === 'sendEmail')).toHaveLength(1);
  expect(await w.run(fake.provider)).toBe(false);
  expect(
    await count("FROM notification_attempts WHERE workspace_id=$1 AND outcome='uncertain'", [
      w.wid,
    ]),
  ).toBe(2);
});

it('does not let a crash after provider acceptance cause either transport to be contacted again', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    member.userId,
  ]);
  const controller = new AbortController();
  const crashing = recorder({ sendEmail: () => never<DispatchResult>() });
  const first = w.run(crashing.provider, controller.signal).catch(() => undefined);
  await until(() => crashing.calls.includes('sendEmail'));
  expect(crashing.sent).toHaveLength(1);
  await w.expireLease();
  const next = recorder();
  expect(await w.run(next.provider)).toBe(false);
  await maintainNotifications(pool);
  expect(await w.run(next.provider)).toBe(false);
  expect(next.calls).toEqual([]);
  expect(await w.events()).toMatchObject([
    { state: 'uncertain', channel: 'email', email_attempts: 1 },
  ]);
  expect(
    await count("FROM notification_attempts WHERE workspace_id=$1 AND outcome='uncertain'", [
      w.wid,
    ]),
  ).toBe(1);
  controller.abort();
  await first;
  expect(await w.events()).toMatchObject([{ state: 'uncertain', channel: 'email' }]);
});

it('safely resumes a crash that only opened a Slack DM', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    owner.userId,
  ]);
  const controller = new AbortController();
  const hung = recorder({ openDm: () => never<{ channelId: string }>() });
  const first = w.run(hung.provider, controller.signal).catch(() => undefined);
  await until(() => hung.calls.includes('openDm'));
  expect(await count('FROM notification_attempts WHERE workspace_id=$1', [w.wid])).toBe(0);
  await w.expireLease();
  const resumed = recorder();
  await w.unpace();
  expect(await w.run(resumed.provider)).toBe(true);
  expect(resumed.messagesFor(member.userId)).toHaveLength(1);
  controller.abort();
  await first;
  expect(await w.events()).toMatchObject([
    { state: 'provider_accepted', channel: 'slack', slack_attempts: 1 },
  ]);
});

it('uses the current binding and scope at attempt time: unlink, credential rotation and scope change', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    owner.userId,
  ]);
  await w.notifications.unlink(member, w.wid, { revision: 1 });
  const fake = recorder();
  await w.drain(fake.provider);
  expect(fake.calls).toEqual(['sendEmail']);
  const rotated = await world();
  await rotated.enable();
  await rotated.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    rotated.wid,
    owner.userId,
  ]);
  const credentialOnly = rotated.build(rotated.fingerprint, randomBytes(32).toString('hex'));
  rotated.rotate(credentialOnly);
  const sent = recorder();
  await rotated.drain(sent.provider);
  expect(sent.messagesFor(member.userId)).toHaveLength(1);
  expect(
    await count('FROM notification_attempts WHERE workspace_id=$1 AND credential_fingerprint=$2', [
      rotated.wid,
      credentialOnly.grants[0]?.credentialFingerprint,
    ]),
  ).toBe(1);
  const moved = await world();
  await moved.enable();
  await moved.open();
  moved.rotate(moved.build(randomBytes(32).toString('hex'), randomBytes(32).toString('hex')));
  const none = recorder();
  await moved.drain(none.provider);
  expect(none.calls).toEqual([]);
  expect((await moved.events()).every((row) => row.reason === 'integration_disabled')).toBe(true);
  const absent = await world();
  await absent.enable();
  await absent.open();
  absent.rotate(null);
  expect(await absent.run(none.provider)).toBe(false);
  expect(await absent.events("AND state='pending'")).toHaveLength(2);
});

it('re-checks current context after pacing: disabling the integration while paced sends nothing', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    member.userId,
  ]);
  const fake = recorder();
  await w.pace(1500);
  const paced = w.run(fake.provider);
  await sleep(300);
  await w.notifications.updatePolicy(owner, w.wid, {
    ...enabledPolicy,
    enabled: false,
    revision: (await w.notifications.policy(owner, w.wid)).revision,
  });
  expect(await paced).toBe(true);
  expect(fake.calls).toEqual([]);
  expect(await w.events()).toMatchObject([{ state: 'skipped', reason: 'integration_disabled' }]);
});

it('defers cooldowns without charging attempts and never holds a lease beyond its budget', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    owner.userId,
  ]);
  await pool.query(
    'INSERT INTO notification_slack_budgets(team_id) VALUES($1) ON CONFLICT DO NOTHING',
    [w.teamId],
  );
  await pool.query(
    "INSERT INTO notification_slack_cooldowns(team_id,method,blocked_until) VALUES($1,'chat.postMessage',clock_timestamp()+interval '10 minutes')",
    [w.teamId],
  );
  const fake = recorder();
  const started = Date.now();
  expect(await w.run(fake.provider)).toBe(true);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(fake.calls).toEqual([]);
  const row = await pool.query(
    "SELECT state,slack_attempts,email_attempts,lease_token,(available_at>clock_timestamp()+interval '9 minutes') AS later FROM notification_events WHERE workspace_id=$1",
    [w.wid],
  );
  expect(row.rows[0]).toEqual({
    state: 'pending',
    slack_attempts: 0,
    email_attempts: 0,
    lease_token: null,
    later: true,
  });
});

it('paces shared SMTP sends durably and lets concurrent workers claim each event once', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await w.unpace();
  const fake = recorder();
  const started = Date.now();
  const results = await Promise.all([1, 2, 3, 4].map(() => w.run(fake.provider)));
  expect(results.filter(Boolean)).toHaveLength(2);
  expect(fake.messagesFor(owner.userId)).toHaveLength(1);
  expect(fake.messagesFor(member.userId)).toHaveLength(1);
  expect(Date.now() - started).toBeGreaterThanOrEqual(700);
});

it('rolls back and uncharges a shutdown seen before the marker commits, so repeated shutdowns never exhaust attempts', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    member.userId,
  ]);
  const fake = recorder();
  for (let round = 1; round <= 3; round += 1) {
    const controller = new AbortController();
    let reads = 0;
    await w.unpace();
    await pool.query(
      'UPDATE notification_events SET available_at=clock_timestamp() WHERE workspace_id=$1',
      [w.wid],
    );
    // Reads: worker start, prepare (after lock), begin (after lock, before COMMIT).
    expect(
      await w.run(fake.provider, controller.signal, async () => {
        reads += 1;
        if (reads === 3) controller.abort();
        return w.read();
      }),
    ).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(await count('FROM notification_attempts WHERE workspace_id=$1', [w.wid])).toBe(0);
    expect(await w.events()).toMatchObject([{ state: 'pending', email_attempts: 0 }]);
  }
  await w.unpace();
  expect(await w.run(fake.provider)).toBe(true);
  expect(await w.events()).toMatchObject([
    { state: 'provider_accepted', channel: 'email', email_attempts: 1 },
  ]);
});

it('aborts an in-flight submission conservatively as uncertain', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    member.userId,
  ]);
  const hung = recorder({ sendEmail: () => never<DispatchResult>() });
  const stopper = new AbortController();
  await w.unpace();
  const running = w.run(hung.provider, stopper.signal);
  await until(() => hung.calls.includes('sendEmail'));
  stopper.abort();
  await running;
  expect(await w.events()).toMatchObject([
    { state: 'uncertain', channel: 'email', email_attempts: 1 },
  ]);
});

it('records a message already in flight honestly when the member responds before completion', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    owner.userId,
  ]);
  let release: (value: DispatchResult) => void = () => undefined;
  const fake = recorder({
    sendEmail: () =>
      new Promise<DispatchResult>((resolve) => {
        release = resolve;
      }),
  });
  await w.unpace();
  const running = w.run(fake.provider);
  await until(() => fake.calls.includes('sendEmail'));
  await space.submit(member, w.wid, w.pulse.id, answer);
  expect(await w.events()).toMatchObject([
    { state: 'uncertain', channel: 'email', reason: 'acceptance_unknown' },
  ]);
  release(accepted);
  await running;
  expect(await w.events()).toMatchObject([{ state: 'provider_accepted', channel: 'email' }]);
  expect(
    await count("FROM notification_attempts WHERE workspace_id=$1 AND outcome='accepted'", [w.wid]),
  ).toBe(1);
  expect(await w.run(fake.provider)).toBe(false);
});

it('schedules only the latest due slot, records missed slots, and never pre-delivers future slots', async () => {
  const w = await world();
  await w.enable({ maximumReminders: 3 });
  await w.open();
  await w.backdate('40 hours');
  expect(await advanceNotificationSchedule(pool)).toBe(0);
  expect(await w.events("AND kind='reminder'")).toEqual([]);
  await w.backdate('160 hours');
  expect(await advanceNotificationSchedule(pool)).toBe(1);
  const reminders = await w.events("AND kind='reminder'");
  expect(reminders.filter((row) => row.state === 'pending')).toHaveLength(2);
  expect(
    reminders
      .filter((row) => row.state === 'pending')
      .every((row) => row.occurrence_key === 'auto:3' && row.reminder_slot === 1),
  ).toBe(true);
  const missed = reminders.filter((row) => row.state === 'skipped');
  expect(missed).toHaveLength(4);
  expect(missed.every((row) => row.reason === 'missed_slot' && row.reminder_slot === null)).toBe(
    true,
  );
  expect(await advanceNotificationSchedule(pool)).toBe(0);
});

it('stops reminders for receipts and closed pulses and blocks them behind unresolved uncertainty', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await space.submit(member, w.wid, w.pulse.id, answer);
  await pool.query(
    "UPDATE notification_events SET state='uncertain',channel='email',reason='acceptance_unknown',terminal_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",
    [w.wid, owner.userId],
  );
  await w.backdate('60 hours');
  await advanceNotificationSchedule(pool);
  const rows = await w.events("AND kind='reminder'");
  expect(rows.filter((row) => row.user_id === 'worker-member')).toEqual([]);
  expect(rows.filter((row) => row.user_id === 'worker-owner')).toMatchObject([
    { state: 'skipped', reason: 'missed_slot', reminder_slot: null },
  ]);
  const closed = await world();
  await closed.enable();
  await closed.open();
  await closed.backdate('60 hours');
  await closed.close();
  expect(await advanceNotificationSchedule(pool)).toBe(0);
  expect(await closed.events("AND kind='reminder'")).toEqual([]);
});

it('shares the per-member reminder cap between manual and scheduled reminders', async () => {
  const w = await world();
  await w.enable({ maximumReminders: 3 });
  await w.open();
  const recorded = recorder();
  const manual = await w.notifications.remind(owner, w.wid, w.pulse.id, {
    requestId: randomUUID(),
    revision: 0,
    confirm: true,
  });
  expect(manual.queued).toBe(true);
  await w.drain(recorded.provider);
  await w.backdate('60 hours');
  await advanceNotificationSchedule(pool);
  await w.drain(recorded.provider);
  await w.backdate('72 hours');
  await advanceNotificationSchedule(pool);
  await w.drain(recorded.provider);
  await w.backdate('72 hours');
  await advanceNotificationSchedule(pool);
  const slots = await pool.query(
    "SELECT user_id,array_agg(reminder_slot ORDER BY reminder_slot) AS slots FROM notification_events WHERE workspace_id=$1 AND kind='reminder' AND reminder_slot IS NOT NULL GROUP BY user_id ORDER BY user_id",
    [w.wid],
  );
  expect(slots.rows).toEqual([
    { user_id: 'worker-member', slots: [1, 2, 3] },
    { user_id: 'worker-owner', slots: [1, 2, 3] },
  ]);
  expect((await w.events("AND kind='reminder' AND state='pending'")).length).toBe(0);
});

it.each(['pending', 'leased', 'retry_scheduled'] as const)(
  'coalesces a manual batch with an unexpired %s automatic reminder without spending another ordinal',
  async (state) => {
    const w = await world();
    await w.enable();
    await w.open();
    await w.backdate('60 hours');
    await advanceNotificationSchedule(pool);
    if (state === 'leased') {
      await pool.query(
        `WITH t AS MATERIALIZED (SELECT clock_timestamp() AS now)
        UPDATE notification_events SET state='leased',lease_token=$2,updated_at=t.now,lease_until=t.now+interval '120 seconds'
        FROM t WHERE workspace_id=$1 AND kind='reminder'`,
        [w.wid, randomUUID()],
      );
    } else if (state === 'retry_scheduled') {
      await pool.query(
        "UPDATE notification_events SET state='retry_scheduled',channel='email',email_attempts=1 WHERE workspace_id=$1 AND kind='reminder'",
        [w.wid],
      );
    }
    const before = await w.events("AND kind='reminder'");
    expect(before).toMatchObject([
      { user_id: member.userId, occurrence_key: 'auto:1', reminder_slot: 1, state },
      { user_id: owner.userId, occurrence_key: 'auto:1', reminder_slot: 1, state },
    ]);
    const body = { requestId: randomUUID(), revision: 0, confirm: true };
    const batch = await w.notifications.remind(owner, w.wid, w.pulse.id, body);
    expect(batch.queued).toBe(false);
    expect(await w.events("AND kind='reminder'")).toEqual(before);
    await w.notifications.disableReminders(owner, w.wid, w.pulse.id, { revision: 0 });
    const afterDisable = await w.events("AND kind='reminder'");
    expect(await w.notifications.remind(owner, w.wid, w.pulse.id, body)).toEqual(batch);
    expect(await w.events("AND kind='reminder'")).toEqual(afterDisable);
  },
);

it.each(['invitation', 'reminder'] as const)(
  'coalesces manual reminders behind an older failed or uncertain %s',
  async (kind) => {
    for (const state of ['failed', 'uncertain'] as const) {
      const w = await world();
      await w.enable();
      await w.open();
      if (kind === 'reminder') {
        await w.backdate('60 hours');
        await advanceNotificationSchedule(pool);
      }
      await pool.query(
        "UPDATE notification_events SET state=$3,channel='email',email_attempts=1,reason=$4,terminal_at=clock_timestamp() WHERE workspace_id=$1 AND kind=$2",
        [w.wid, kind, state, state === 'uncertain' ? 'acceptance_unknown' : 'provider_unavailable'],
      );
      const before = await w.events();
      expect(
        (
          await w.notifications.remind(owner, w.wid, w.pulse.id, {
            requestId: randomUUID(),
            revision: 0,
            confirm: true,
          })
        ).queued,
      ).toBe(false);
      expect(await w.events()).toEqual(before);
    }
  },
);

it.each(['pending', 'leased', 'retry_scheduled', 'failed', 'uncertain'] as const)(
  'ignores an expired %s reminder when queuing a manual batch',
  async (state) => {
    const w = await world();
    await w.enable();
    await w.open();
    await pool.query(
      `WITH t AS MATERIALIZED (SELECT clock_timestamp() AS now)
      INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,reminder_slot,policy_revision,grant_fingerprint,
        state,channel,created_at,updated_at,expires_at,terminal_at,lease_token,lease_until)
      SELECT f.workspace_id,f.pulse_id,r.user_id,'reminder','auto:1',1,f.policy_revision,f.grant_fingerprint,
        $3,'email',t.now-interval '49 hours',t.now,t.now-interval '1 second',
        CASE WHEN $3 IN ('failed','uncertain') THEN t.now END,
        CASE WHEN $3='leased' THEN $4::uuid END,CASE WHEN $3='leased' THEN t.now+interval '120 seconds' END
      FROM notification_pulse_policies f JOIN space_roster r ON r.pulse_id=f.pulse_id,t WHERE f.workspace_id=$1 AND f.pulse_id=$2`,
      [w.wid, w.pulse.id, state, randomUUID()],
    );
    expect(
      (
        await w.notifications.remind(owner, w.wid, w.pulse.id, {
          requestId: randomUUID(),
          revision: 0,
          confirm: true,
        })
      ).queued,
    ).toBe(true);
    const rows = await w.events("AND kind='reminder'");
    for (const userId of [member.userId, owner.userId]) {
      expect(rows.filter((row) => row.user_id === userId)).toMatchObject([
        { occurrence_key: 'auto:1', reminder_slot: 1, state },
        { reminder_slot: 2, state: 'pending' },
      ]);
    }
  },
);

it.each(['1 hour', '24 hours'] as const)(
  'uses acceptance settlement, not creation time, for the manual 24-hour guard (%s ago)',
  async (settledAgo) => {
    const w = await world();
    await w.enable();
    await w.open();
    await pool.query(
      `WITH t AS MATERIALIZED (SELECT clock_timestamp() AS now)
      INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,reminder_slot,policy_revision,grant_fingerprint,
        state,channel,email_attempts,created_at,updated_at,expires_at,terminal_at)
      SELECT f.workspace_id,f.pulse_id,r.user_id,'reminder','auto:1',1,f.policy_revision,f.grant_fingerprint,
        'provider_accepted','email',1,t.now-interval '30 hours',t.now-$3::interval,t.now+interval '18 hours',t.now-$3::interval
      FROM notification_pulse_policies f JOIN space_roster r ON r.pulse_id=f.pulse_id,t WHERE f.workspace_id=$1 AND f.pulse_id=$2`,
      [w.wid, w.pulse.id, settledAgo],
    );
    const before = await w.events("AND kind='reminder'");
    const body = { requestId: randomUUID(), revision: 0, confirm: true };
    vi.useFakeTimers({ toFake: ['Date'] });
    let batch: NotificationBatch;
    try {
      vi.setSystemTime(Date.now() + 30 * 86_400_000);
      batch = await w.notifications.remind(owner, w.wid, w.pulse.id, body);
    } finally {
      vi.useRealTimers();
    }
    expect(batch.queued).toBe(settledAgo === '24 hours');
    const after = await w.events("AND kind='reminder'");
    if (settledAgo === '1 hour') expect(after).toEqual(before);
    else
      for (const userId of [member.userId, owner.userId]) {
        expect(after.filter((row) => row.user_id === userId)).toMatchObject([
          { occurrence_key: 'auto:1', reminder_slot: 1, state: 'provider_accepted' },
          { reminder_slot: 2, state: 'pending' },
        ]);
      }
    await w.notifications.disableReminders(owner, w.wid, w.pulse.id, { revision: 0 });
    const disabled = await w.events("AND kind='reminder'");
    expect(await w.notifications.remind(owner, w.wid, w.pulse.id, body)).toEqual(batch);
    expect(await w.events("AND kind='reminder'")).toEqual(disabled);
  },
);

it('coalesces manual reminders immediately after the worker accepts automatic reminders', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await w.backdate('60 hours');
  await advanceNotificationSchedule(pool);
  const fake = recorder();
  await w.drain(fake.provider);
  expect(await w.events("AND kind='reminder'")).toMatchObject([
    { user_id: member.userId, state: 'provider_accepted', reminder_slot: 1 },
    { user_id: owner.userId, state: 'provider_accepted', reminder_slot: 1 },
  ]);
  expect(
    (
      await w.notifications.remind(owner, w.wid, w.pulse.id, {
        requestId: randomUUID(),
        revision: 0,
        confirm: true,
      })
    ).queued,
  ).toBe(false);
  await w.drain(fake.provider);
  for (const userId of [member.userId, owner.userId])
    expect(fake.messagesFor(userId)).toHaveLength(2);
  expect(await w.events("AND kind='reminder'")).toHaveLength(2);
});

it.each(['automatic', 'manual'] as const)(
  'keeps exactly one reminder per member when %s insertion owns the workspace lock first',
  async (first) => {
    const w = await world();
    await w.enable();
    await w.open();
    await w.backdate('60 hours');
    const manual = () =>
      w.notifications.remind(owner, w.wid, w.pulse.id, {
        requestId: randomUUID(),
        revision: 0,
        confirm: true,
      });
    if (first === 'automatic') {
      await advanceNotificationSchedule(pool);
      expect((await manual()).queued).toBe(false);
    } else {
      expect((await manual()).queued).toBe(true);
      await advanceNotificationSchedule(pool);
    }
    const reminders = await w.events("AND kind='reminder' AND reminder_slot IS NOT NULL");
    expect(reminders).toHaveLength(2);
    for (const userId of [member.userId, owner.userId]) {
      expect(reminders.filter((row) => row.user_id === userId)).toMatchObject([
        { state: 'pending', reminder_slot: 1 },
      ]);
    }
  },
);

it('serializes a manual reminder racing the scheduler without exceeding the cap or duplicating', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await w.backdate('60 hours');
  await Promise.all([
    advanceNotificationSchedule(pool),
    w.notifications.remind(owner, w.wid, w.pulse.id, {
      requestId: randomUUID(),
      revision: 0,
      confirm: true,
    }),
  ]);
  await advanceNotificationSchedule(pool);
  const slots = await pool.query(
    "SELECT user_id,count(*)::integer AS count,max(reminder_slot) AS highest FROM notification_events WHERE workspace_id=$1 AND kind='reminder' AND reminder_slot IS NOT NULL GROUP BY user_id",
    [w.wid],
  );
  expect(slots.rows.length).toBe(2);
  for (const row of slots.rows) expect(row).toMatchObject({ count: 1, highest: 1 });
});

it('continues bounded 100-recipient traversal across calls with a durable cursor', async () => {
  const w = await world({ extra: 230 });
  await w.enable();
  await w.open();
  await w.backdate('50 hours');
  const reminders = () =>
    count(
      "FROM notification_events WHERE workspace_id=$1 AND kind='reminder' AND state='pending'",
      [w.wid],
    );
  expect(await advanceNotificationSchedule(pool, 1)).toBe(1);
  expect(await reminders()).toBe(100);
  const progress = await pool.query(
    'SELECT scheduler_slot,scheduler_active_slot,scheduler_recipient_cursor IS NOT NULL AS cursor FROM notification_pulse_policies WHERE pulse_id=$1',
    [w.pulse.id],
  );
  expect(progress.rows[0]).toEqual({ scheduler_slot: 0, scheduler_active_slot: 1, cursor: true });
  expect(await advanceNotificationSchedule(pool, 1000)).toBe(1);
  expect(await reminders()).toBe(200);
  expect(await advanceNotificationSchedule(pool)).toBe(1);
  expect(await reminders()).toBe(232);
  const done = await pool.query(
    'SELECT scheduler_slot,scheduler_active_slot,scheduler_recipient_cursor FROM notification_pulse_policies WHERE pulse_id=$1',
    [w.pulse.id],
  );
  expect(done.rows[0]).toEqual({
    scheduler_slot: 1,
    scheduler_active_slot: null,
    scheduler_recipient_cursor: null,
  });
  expect(await advanceNotificationSchedule(pool)).toBe(0);
  expect(await reminders()).toBe(232);
});

it('uses database time for scheduling and expiry regardless of host clock skew', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 30 * 86_400_000);
    expect(await advanceNotificationSchedule(pool)).toBe(0);
    const fake = recorder();
    await w.drain(fake.provider);
    expect(fake.sent).toHaveLength(2);
    vi.setSystemTime(Date.now() - 60 * 86_400_000);
    await w.backdate('60 hours');
    expect(await advanceNotificationSchedule(pool)).toBe(1);
  } finally {
    vi.useRealTimers();
  }
  expect(await w.events("AND kind='reminder' AND state='pending'")).toHaveLength(2);
});

it('preserves the event deadline across retries by falling back instead of waiting past expiry', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    owner.userId,
  ]);
  await w.drain(recorder().provider);
  await w.backdate('95 hours 59 minutes 40 seconds');
  await advanceNotificationSchedule(pool);
  const fake = recorder({ sendSlack: async () => refused(true) });
  await w.drain(fake.provider);
  expect(await w.events("AND kind='reminder' AND user_id='worker-member'")).toMatchObject([
    {
      state: 'provider_accepted',
      channel: 'email',
      slack_attempts: 1,
      email_attempts: 1,
      occurrence_key: 'auto:1',
    },
  ]);
});

it('purges only old private attempts while dedup markers and uncertain blocking survive', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  const fake = recorder({
    sendEmail: async (email) => (email.startsWith('worker-member') ? uncertain : accepted),
  });
  await w.drain(fake.provider);
  expect(await count('FROM notification_attempts WHERE workspace_id=$1', [w.wid])).toBe(2);
  const request = { requestId: randomUUID(), revision: 0, confirm: true } as const;
  expect((await w.notifications.remind(owner, w.wid, w.pulse.id, request)).queued).toBe(true);
  const before = await count('FROM notification_events WHERE workspace_id=$1', [w.wid]);
  await pool.query(
    "UPDATE notification_events SET terminal_at=clock_timestamp()-interval '31 days' WHERE workspace_id=$1 AND terminal_at IS NOT NULL",
    [w.wid],
  );
  expect(await maintainNotifications(pool)).toBeGreaterThanOrEqual(2);
  expect(await count('FROM notification_attempts WHERE workspace_id=$1', [w.wid])).toBe(0);
  // Purged private attempts cannot let a replayed request or a repeated hook recreate events.
  expect(await w.notifications.remind(owner, w.wid, w.pulse.id, request)).toEqual({
    requestId: request.requestId,
    queued: true,
  });
  await withTransaction(pool, (client) => capturePulseNotifications(client, w.wid, w.pulse.id));
  expect(await count('FROM notification_events WHERE workspace_id=$1', [w.wid])).toBe(before);
  expect(await w.events("AND kind='invitation'")).toMatchObject([
    { user_id: 'worker-member', state: 'uncertain' },
    { user_id: 'worker-owner', state: 'provider_accepted' },
  ]);
  // The old unresolved uncertain invitation still blocks a younger scheduled reminder.
  await w.backdate('60 hours');
  await advanceNotificationSchedule(pool);
  expect(
    await w.events("AND kind='reminder' AND user_id='worker-member' AND occurrence_key='auto:1'"),
  ).toMatchObject([{ state: 'skipped', reason: 'missed_slot', reminder_slot: null }]);
});

it('expires overdue events, removes unused link states and bounds each maintenance batch', async () => {
  const w = await world();
  await w.enable({ maximumReminders: 3 });
  await w.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1', [w.wid]);
  for (let index = 1; index <= 3; index += 1)
    await pool.query(
      "INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,reminder_slot,policy_revision,grant_fingerprint,expires_at) SELECT $1,$2,$3,'reminder','auto:'||$4::integer::text,$4::integer,policy_revision,grant_fingerprint,clock_timestamp()-interval '1 second' FROM notification_pulse_policies WHERE pulse_id=$2",
      [w.wid, w.pulse.id, member.userId, index],
    );
  await maintainNotifications(pool, 1);
  expect(
    await count(
      "FROM notification_events WHERE workspace_id=$1 AND state='skipped' AND reason='expired'",
      [w.wid],
    ),
  ).toBe(1);
  await maintainNotifications(pool, 500);
  expect(
    await count("FROM notification_events WHERE workspace_id=$1 AND state='pending'", [w.wid]),
  ).toBe(0);
  for (const [hash, consumed] of [
    ['1', false],
    ['2', true],
  ] as const)
    await pool.query(
      `WITH s AS MATERIALIZED (SELECT clock_timestamp() AS t)
      INSERT INTO notification_oauth_states(state_hash,nonce_hash,workspace_id,user_id,session_id,team_id,grant_fingerprint,credential_fingerprint,binding_revision,created_at,expires_at,consumed_at)
      SELECT repeat($1,64),repeat('a',64),$2,$3,$4,'T0TEAM',repeat('b',64),repeat('c',64),0,s.t-interval '10 minutes',s.t-interval '5 minutes',CASE WHEN $5::boolean THEN s.t-interval '9 minutes' END FROM s`,
      [hash, w.wid, owner.userId, owner.sessionId, consumed],
    );
  await maintainNotifications(pool);
  expect(await count('FROM notification_oauth_states WHERE workspace_id=$1', [w.wid])).toBe(1);
});

it('runs one bounded worker cycle: absent config only maintains, configured config sends at most one event', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  const fake = recorder();
  const idle = await runNotificationCycle(pool, null, { provider: fake.provider });
  expect(idle).toMatchObject({ scheduled: 0, delivered: false });
  expect(fake.calls).toEqual([]);
  await w.unpace();
  const live = await runNotificationCycle(pool, w.build(w.fingerprint, 'c'.repeat(64)), {
    provider: fake.provider,
  });
  expect(live.delivered).toBe(true);
  expect(fake.sent).toHaveLength(1);
  expect(await w.events("AND state='pending'")).toHaveLength(1);
});

it('worker entry stays disabled without configuration, fails redacted, and exits cleanly on SIGINT', async () => {
  const url = new URL(process.env.CLIO_TEST_DATABASE_URL ?? '');
  url.searchParams.set('options', `-c search_path=${schema}`);
  const cwd = join(import.meta.dirname, '..');
  const environment = { PATH: process.env.PATH ?? '', DATABASE_URL: url.toString() };
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['src/worker-notifications.ts', ...args], {
      cwd,
      env: { ...environment, ...extra },
      encoding: 'utf8',
      timeout: 30000,
    });
  const absent = run(['--once']);
  expect(absent.status).toBe(0);
  const invalid = run(['--unexpected']);
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain('Notification worker unavailable');
  const partial = run(['--once'], {
    NOTIFICATIONS_PRIVATE_CONFIG_FILE: '/nonexistent/private-secret.json',
  });
  expect(partial.status).toBe(1);
  expect(partial.stderr).not.toMatch(/private-secret|nonexistent|postgres|clio_test/);
  const child = spawn(process.execPath, ['src/worker-notifications.ts'], {
    cwd,
    env: environment,
    stdio: 'ignore',
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  await sleep(1500);
  child.kill('SIGINT');
  expect(await exited).toBe(0);
});

// ---- Fix round 1: dispatch fences, send-time blocking, pacing, authority, scheduler, retention ----

const notice: NoticeMessage = { subject: 's', text: 't', html: 'h', slackText: 'x' };
async function lockedNow(table: string, where: string, values: unknown[]): Promise<boolean> {
  try {
    await pool.query(`SELECT 1 FROM ${table} WHERE ${where} FOR UPDATE NOWAIT`, values);
    return false;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03')
      return true;
    throw error;
  }
}
async function holding(sql: string, values: unknown[]) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query(sql, values);
  return {
    async release() {
      await client.query('COMMIT');
      client.release();
    },
  };
}
async function started(w: Awaited<ReturnType<typeof world>>) {
  const jobs = createNotificationJobs(pool);
  await w.unpace();
  const lease = await jobs.claim();
  if (!lease) throw new Error('No event');
  const prepared = await jobs.prepare(lease, w.read);
  if (prepared.action !== 'send') throw new Error('Not sendable');
  const begun = await jobs.begin(lease, w.read, prepared.route, () => notice);
  if (begun.action !== 'started') throw new Error('Not started');
  return { jobs, lease, route: prepared.route, begun };
}
const onlyOwner = (w: Awaited<ReturnType<typeof world>>) =>
  pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    member.userId,
  ]);
const onlyMember = (w: Awaited<ReturnType<typeof world>>) =>
  pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    w.wid,
    owner.userId,
  ]);

it('never lets a younger reminder bypass an older unresolved notice, but ignores expired ones', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  const request = () => ({ requestId: randomUUID(), revision: 0, confirm: true }) as const;
  expect((await w.notifications.remind(owner, w.wid, w.pulse.id, request())).queued).toBe(true);
  await pool.query(
    "UPDATE notification_events SET state='uncertain',channel='email',reason='acceptance_unknown',terminal_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2 AND kind='invitation'",
    [w.wid, member.userId],
  );
  const fake = recorder();
  await w.drain(fake.provider);
  expect(fake.messagesFor(member.userId)).toEqual([]);
  expect(fake.messagesFor(owner.userId)).toHaveLength(2);
  const held = await pool.query(
    "SELECT state,email_attempts,(available_at>clock_timestamp()+interval '4 minutes') AS later FROM notification_events WHERE workspace_id=$1 AND user_id=$2 AND kind='reminder'",
    [w.wid, member.userId],
  );
  expect(held.rows).toEqual([{ state: 'pending', email_attempts: 0, later: true }]);
  // Resolving the older notice (owner-confirmed replay finished) releases the younger reminder.
  await pool.query(
    "UPDATE notification_events SET state='provider_accepted',terminal_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2 AND kind='invitation'",
    [w.wid, member.userId],
  );
  await pool.query(
    'UPDATE notification_events SET available_at=clock_timestamp() WHERE workspace_id=$1',
    [w.wid],
  );
  await w.drain(fake.provider);
  expect(fake.messagesFor(member.userId)).toHaveLength(1);

  // The older notice becomes uncertain only after the younger reminder was already queued.
  const later = await world();
  await later.enable();
  await later.open();
  await later.notifications.remind(owner, later.wid, later.pulse.id, request());
  await pool.query(
    "UPDATE notification_events SET state='uncertain',channel='email',reason='acceptance_unknown',terminal_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2 AND kind='invitation'",
    [later.wid, member.userId],
  );
  const queued = recorder();
  await later.drain(queued.provider);
  expect(queued.messagesFor(member.userId)).toEqual([]);

  // An expired older blocker no longer blocks.
  const expired = await world();
  await expired.enable();
  await expired.open();
  await pool.query('DELETE FROM notification_events WHERE workspace_id=$1 AND user_id=$2', [
    expired.wid,
    member.userId,
  ]);
  await pool.query(
    "INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,reminder_slot,policy_revision,grant_fingerprint,state,channel,reason,terminal_at,expires_at) SELECT $1,$2,$3,'reminder','auto:1',1,policy_revision,grant_fingerprint,'uncertain','email','acceptance_unknown',clock_timestamp(),clock_timestamp()-interval '1 second' FROM notification_pulse_policies WHERE pulse_id=$2",
    [expired.wid, expired.pulse.id, member.userId],
  );
  await expired.notifications.remind(owner, expired.wid, expired.pulse.id, request());
  const free = recorder();
  await expired.drain(free.provider);
  expect(free.messagesFor(member.userId)).toHaveLength(1);
});

it('performs a fresh full preflight after waiting and before any Slack DM is opened', async () => {
  const scenarios: [string, (w: Awaited<ReturnType<typeof world>>) => Promise<unknown>][] = [
    [
      'disable',
      async (w) =>
        w.notifications.updatePolicy(owner, w.wid, {
          ...enabledPolicy,
          enabled: false,
          revision: (await w.notifications.policy(owner, w.wid)).revision,
        }),
    ],
    ['revoke', (w) => identity.revokeMember(owner, w.wid, member.userId)],
    ['response', (w) => space.submit(member, w.wid, w.pulse.id, answer)],
    [
      'lease',
      async (w) =>
        pool.query(
          "UPDATE notification_events SET lease_until=created_at+interval '1 millisecond' WHERE workspace_id=$1 AND state='leased'",
          [w.wid],
        ),
    ],
    ['unlink', (w) => w.notifications.unlink(member, w.wid, { revision: 1 })],
    [
      'relink',
      (w) =>
        pool.query(
          "UPDATE notification_slack_bindings SET revision=revision+1,slack_user_id='UOTHER0001' WHERE workspace_id=$1 AND user_id=$2",
          [w.wid, member.userId],
        ),
    ],
  ];
  for (const [name, mutate] of scenarios) {
    const w = await world({ slack: true });
    await w.enable();
    await w.link(member.userId);
    await w.open();
    await onlyMember(w);
    await pool.query(
      'INSERT INTO notification_slack_budgets(team_id) VALUES($1) ON CONFLICT DO NOTHING',
      [w.teamId],
    );
    await pool.query(
      "INSERT INTO notification_slack_cooldowns(team_id,method,blocked_until) VALUES($1,'conversations.open',clock_timestamp()+interval '900 milliseconds')",
      [w.teamId],
    );
    const opened: string[] = [];
    const fake = recorder({
      openDm: async (id) => {
        opened.push(id);
        return { channelId: `D${id}` };
      },
    });
    const running = w.run(fake.provider);
    await sleep(250);
    await mutate(w);
    await running;
    // Nothing may touch the old recipient after the change was committed, even without a message.
    expect(
      opened.filter((id) => id === 'UMEMBER0001'),
      name,
    ).toEqual([]);
    expect(
      fake.calls.filter((call) => call === 'sendSlack'),
      name,
    ).toEqual([]);
    if (name === 'unlink' || name === 'lease' || name === 'relink') {
      await w.unpace();
      await pool.query(
        "UPDATE notification_events SET available_at=clock_timestamp() WHERE workspace_id=$1 AND state IN ('pending','retry_scheduled')",
        [w.wid],
      );
      await w.drain(fake.provider);
      expect(fake.calls.length, name).toBeGreaterThan(0);
    }
  }
});

it('reads the private configuration only after the workspace lock is held, and fails closed', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await onlyOwner(w);
  const locked: boolean[] = [];
  let reads = 0;
  await w.run(recorder().provider, undefined, async () => {
    reads += 1;
    if (reads >= 2) locked.push(await lockedNow('workspaces', 'id=$1', [w.wid]));
    return w.read();
  });
  // prepare, begin (first pass) and begin (second pass, after the provider budget lock).
  expect(locked).toEqual([true, true, true]);

  const waiting = async (change: (w: Awaited<ReturnType<typeof world>>) => void) => {
    const x = await world();
    await x.enable();
    await x.open();
    await onlyOwner(x);
    const fake = recorder();
    const lock = await holding('SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE', [x.wid]);
    const running = x.run(fake.provider);
    await sleep(300);
    change(x);
    await lock.release();
    await running;
    return { x, fake };
  };
  const removed = await waiting((x) => x.rotate(null));
  expect(removed.fake.calls).toEqual([]);
  expect(await removed.x.events()).toMatchObject([{ state: 'pending', email_attempts: 0 }]);
  const moved = await waiting((x) =>
    x.rotate(x.build(randomBytes(32).toString('hex'), randomBytes(32).toString('hex'))),
  );
  expect(moved.fake.calls).toEqual([]);
  expect(await moved.x.events()).toMatchObject([
    { state: 'skipped', reason: 'integration_disabled' },
  ]);
  const rotated = await waiting((x) => x.rotate(x.build(x.fingerprint, 'e'.repeat(64))));
  expect(rotated.fake.calls).toEqual(['sendEmail']);
  expect(
    await count('FROM notification_attempts WHERE workspace_id=$1 AND credential_fingerprint=$2', [
      rotated.x.wid,
      'e'.repeat(64),
    ]),
  ).toBe(1);

  const broken = await world();
  await broken.enable();
  await broken.open();
  await onlyOwner(broken);
  const quiet = recorder();
  let calls = 0;
  await broken.run(quiet.provider, undefined, async () => {
    calls += 1;
    if (calls >= 2) throw new Error('private-secret-path-parse-failure');
    return broken.read();
  });
  expect(quiet.calls).toEqual([]);
  expect(await broken.events()).toMatchObject([{ state: 'pending', email_attempts: 0 }]);
});

it('records accepted results honestly after rotation but never lets stale credentials drive retry or fallback', async () => {
  const a = await world();
  await a.enable();
  await a.open();
  await onlyOwner(a);
  await a.run(
    recorder({
      sendEmail: async () => {
        a.rotate(null);
        return accepted;
      },
    }).provider,
  );
  expect(await a.events()).toMatchObject([{ state: 'provider_accepted', channel: 'email' }]);

  const b = await world();
  await b.enable();
  await b.open();
  await onlyOwner(b);
  await b.run(
    recorder({
      sendEmail: async () => {
        b.rotate(null);
        return refused(true);
      },
    }).provider,
  );
  expect(
    (
      await pool.query(
        "SELECT state,email_attempts,(available_at>clock_timestamp()+interval '30 seconds') AS later FROM notification_events WHERE workspace_id=$1",
        [b.wid],
      )
    ).rows,
  ).toEqual([{ state: 'retry_scheduled', email_attempts: 1, later: true }]);

  const c = await world({ slack: true });
  await c.enable();
  await c.link(member.userId);
  await c.open();
  await onlyMember(c);
  const scope = recorder({
    sendSlack: async () => {
      c.rotate(c.build(randomBytes(32).toString('hex'), randomBytes(32).toString('hex')));
      return refused(false);
    },
  });
  await c.drain(scope.provider);
  expect(scope.calls).not.toContain('sendEmail');
  expect(await c.events()).toMatchObject([{ state: 'skipped', reason: 'integration_disabled' }]);

  const d = await world({ slack: true });
  await d.enable();
  await d.link(member.userId);
  await d.open();
  await onlyMember(d);
  let first = true;
  const credentials = recorder({
    sendSlack: async () => {
      if (!first) return accepted;
      first = false;
      d.rotate(d.build(d.fingerprint, 'f'.repeat(64)));
      return refused(false);
    },
  });
  await d.unpace();
  await d.run(credentials.provider);
  expect(await d.events()).toMatchObject([
    { state: 'retry_scheduled', channel: 'slack', slack_attempts: 1 },
  ]);
  await d.drain(credentials.provider);
  expect(credentials.calls).not.toContain('sendEmail');
  expect(await d.events()).toMatchObject([{ state: 'provider_accepted', channel: 'slack' }]);
});

it('keeps lock order workspace → event → attempt in settle and recovery', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await onlyOwner(w);
  const attempt = await started(w);
  const eventId = attempt.lease.id;
  const event = await holding('SELECT 1 FROM notification_events WHERE id=$1 FOR UPDATE', [
    eventId,
  ]);
  const settling = attempt.jobs.settle(
    attempt.lease,
    attempt.begun,
    attempt.route,
    accepted,
    w.read,
  );
  await sleep(250);
  // While waiting for the event lock, settle already owns the workspace and holds no attempt lock.
  expect(await lockedNow('workspaces', 'id=$1', [w.wid])).toBe(true);
  expect(await lockedNow('notification_attempts', 'id=$1', [attempt.begun.attemptId])).toBe(false);
  await event.release();
  await settling;
  expect(await w.events()).toMatchObject([{ state: 'provider_accepted' }]);

  const r = await world();
  await r.enable();
  await r.open();
  await onlyOwner(r);
  const lost = await started(r);
  await r.expireLease();
  const workspace = await holding('SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE', [r.wid]);
  const recovering = lost.jobs.recoverExpired(10);
  await sleep(250);
  // Candidates are chosen unlocked; recovery takes the workspace first and holds nothing else.
  expect(await lockedNow('notification_events', 'id=$1', [lost.lease.id])).toBe(false);
  expect(await lockedNow('notification_attempts', 'id=$1', [lost.begun.attemptId])).toBe(false);
  await workspace.release();
  expect(await recovering).toBe(1);
  expect(await r.events()).toMatchObject([{ state: 'uncertain', channel: 'email' }]);
});

it('spaces actual message calls from the previous call, not from preparation or DM latency', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.link(owner.userId);
  await w.open();
  await w.unpace();
  const fake = recorder({
    openDm: async (id) => {
      if (id === slackIds[member.userId]) await sleep(700);
      return { channelId: `D${id}` };
    },
  });
  await Promise.all([w.run(fake.provider), w.run(fake.provider)]);
  const posts = fake.stamps.filter((item) => item.call === 'sendSlack').map((item) => item.at);
  expect(posts).toHaveLength(2);
  expect(Math.abs((posts[1] ?? 0) - (posts[0] ?? 0))).toBeGreaterThanOrEqual(990);

  const m = await world();
  await m.enable();
  await m.open();
  await m.unpace();
  const mail = recorder();
  expect(await m.run(mail.provider)).toBe(true);
  // Password rotation changes credentials but not the stable pacing budget.
  const before = m.build(m.fingerprint, 'a'.repeat(64)).grants[0]?.smtp;
  m.rotate(m.build(m.fingerprint, 'b'.repeat(64), 'rotated-password'));
  const after = m.build(m.fingerprint, 'b'.repeat(64), 'rotated-password').grants[0]?.smtp;
  if (!before || !after) throw new Error('fixture');
  expect(smtpPacingKey(before)).toBe(smtpPacingKey(after));
  expect(await m.run(mail.provider)).toBe(true);
  const emails = mail.stamps.map((item) => item.at);
  expect((emails[1] ?? 0) - (emails[0] ?? 0)).toBeGreaterThanOrEqual(990);
});

it('shares a Slack method cooldown across workers using the same team', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.link(owner.userId);
  await w.open();
  await w.unpace();
  let throttled = false;
  const fake = recorder({
    sendSlack: async () => {
      if (throttled) return accepted;
      throttled = true;
      return refused(true, 1200);
    },
  });
  await w.run(fake.provider);
  await w.run(fake.provider);
  const posts = fake.stamps.filter((item) => item.call === 'sendSlack').map((item) => item.at);
  expect(posts).toHaveLength(2);
  expect((posts[1] ?? 0) - (posts[0] ?? 0)).toBeGreaterThanOrEqual(1150);
});

it('ignores expired blockers and supersedes unsent older automatic slots beyond the maintenance batch', async () => {
  const w = await world({ extra: 120 });
  await w.enable();
  await w.open();
  // 120+ expired unsent reminders: bounded maintenance (batch) cannot clear them before scheduling.
  await pool.query(
    "INSERT INTO notification_events(workspace_id,pulse_id,user_id,kind,occurrence_key,reminder_slot,policy_revision,grant_fingerprint,expires_at) SELECT $1,$2,r.user_id,'reminder','auto:2',1,f.policy_revision,f.grant_fingerprint,clock_timestamp()-interval '1 second' FROM space_roster r JOIN notification_pulse_policies f ON f.pulse_id=r.pulse_id WHERE r.pulse_id=$2",
    [w.wid, w.pulse.id],
  );
  await w.backdate('60 hours');
  await advanceNotificationSchedule(pool);
  await advanceNotificationSchedule(pool);
  expect(
    await count(
      "FROM notification_events WHERE workspace_id=$1 AND occurrence_key='auto:1' AND state='pending'",
      [w.wid],
    ),
  ).toBe(122);
  expect(
    await count("FROM notification_events WHERE workspace_id=$1 AND reason='missed_slot'", [w.wid]),
  ).toBe(0);

  const s = await world();
  await s.enable();
  await s.open();
  await s.backdate('60 hours');
  await advanceNotificationSchedule(pool);
  await s.backdate('72 hours');
  await advanceNotificationSchedule(pool);
  const rows = await s.events("AND kind='reminder' AND user_id='worker-member'");
  expect(rows).toMatchObject([
    { occurrence_key: 'auto:1', state: 'skipped', reason: 'missed_slot', reminder_slot: 1 },
    { occurrence_key: 'auto:2', state: 'pending', reminder_slot: 2 },
  ]);
});

it('does not let more than 25 stale-scope pulses starve a current pulse', async () => {
  await world();
  const stale: string[] = [];
  for (let index = 0; index < 26; index += 1) {
    const old = await world({ keep: true });
    await old.enable();
    await old.open();
    await old.backdate('60 hours');
    stale.push(old.wid);
  }
  await pool.query(
    "UPDATE notification_policies SET grant_fingerprint=encode(sha256(convert_to(workspace_id::text,'UTF8')),'hex') WHERE workspace_id=ANY($1::uuid[])",
    [stale],
  );
  const current = await world({ keep: true });
  await current.enable();
  await current.open();
  await current.backdate('60 hours');
  expect(await advanceNotificationSchedule(pool)).toBe(1);
  expect(await current.events("AND kind='reminder' AND state='pending'")).toHaveLength(2);
  expect(
    await count("FROM notification_events WHERE workspace_id=ANY($1::uuid[]) AND kind='reminder'", [
      stale,
    ]),
  ).toBe(0);
});

it('finalizes markers orphaned by a response or revocation plus worker loss, then purges them after 30 days', async () => {
  for (const cause of ['response', 'revocation'] as const) {
    const w = await world();
    await w.enable();
    await w.open();
    await onlyMember(w);
    const controller = new AbortController();
    const lost = recorder({ sendEmail: () => never<DispatchResult>() });
    await w.unpace();
    const crashed = w.run(lost.provider, controller.signal).catch(() => undefined);
    await until(() => lost.calls.includes('sendEmail'));
    if (cause === 'response') await space.submit(member, w.wid, w.pulse.id, answer);
    else await identity.revokeMember(owner, w.wid, member.userId);
    expect(await w.events()).toMatchObject([{ state: 'uncertain', email_attempts: 1 }]);
    expect(
      await count('FROM notification_attempts WHERE workspace_id=$1 AND outcome IS NULL', [w.wid]),
    ).toBe(1);
    // Too fresh to be abandoned.
    await maintainNotifications(pool);
    expect(
      await count('FROM notification_attempts WHERE workspace_id=$1 AND outcome IS NULL', [w.wid]),
    ).toBe(1);
    await pool.query(
      "UPDATE notification_attempts SET started_at=started_at-interval '31 days' WHERE workspace_id=$1",
      [w.wid],
    );
    await pool.query(
      "UPDATE notification_events SET terminal_at=clock_timestamp()-interval '31 days' WHERE workspace_id=$1",
      [w.wid],
    );
    await maintainNotifications(pool);
    expect(await count('FROM notification_attempts WHERE workspace_id=$1', [w.wid])).toBe(0);
    // Logical event, counters and dedup identity survive the purge.
    expect(await w.events("AND kind='invitation'")).toMatchObject([
      { state: 'uncertain', channel: 'email', email_attempts: 1 },
    ]);
    const invitations = await count(
      "FROM notification_events WHERE workspace_id=$1 AND kind='invitation'",
      [w.wid],
    );
    await withTransaction(pool, (client) => capturePulseNotifications(client, w.wid, w.pulse.id));
    expect(
      await count("FROM notification_events WHERE workspace_id=$1 AND kind='invitation'", [w.wid]),
    ).toBe(invitations);
    controller.abort();
    await crashed;
  }
});

it('treats worker health tests as exact-channel: no fallback, no cross-channel send', async () => {
  const w = await world({ slack: true });
  await w.link(owner.userId);
  const slack = recorder({ openDm: async () => refused(false) });
  const queued = await w.notifications.testDelivery(owner, w.wid, {
    requestId: randomUUID(),
    revision: 0,
    confirm: true,
    channel: 'slack',
  });
  expect(queued.queued).toBe(true);
  await w.drain(slack.provider);
  expect(slack.calls).not.toContain('sendEmail');
  expect(await w.events("AND kind='test'")).toMatchObject([
    { state: 'failed', channel: 'slack', slack_attempts: 1, email_attempts: 0 },
  ]);
  const mail = await world();
  await mail.notifications.testDelivery(owner, mail.wid, {
    requestId: randomUUID(),
    revision: 0,
    confirm: true,
    channel: 'email',
  });
  const email = recorder();
  await mail.drain(email.provider);
  expect(email.calls).toEqual(['sendEmail']);
  expect(email.messagesFor(owner.userId)[0]?.message.text).toContain(`workspace=${mail.wid}`);
});

it('replays an owner-confirmed uncertainty on its original channel without fallback', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  await onlyMember(w);
  const first = recorder({ sendSlack: async () => uncertain });
  await w.drain(first.provider);
  expect(await w.events()).toMatchObject([{ state: 'uncertain', channel: 'slack' }]);
  const replay = await w.notifications.retryBatch(owner, w.wid, w.pulse.id, {
    requestId: randomUUID(),
    revision: 0,
    confirm: true,
    confirmUncertain: true,
  });
  expect(replay.queued).toBe(true);
  const second = recorder({ sendSlack: async () => refused(false) });
  await w.drain(second.provider);
  // Email is available for this member, yet a confirmed replay stays on Slack.
  expect(second.calls).not.toContain('sendEmail');
  expect(await w.events()).toMatchObject([
    {
      state: 'failed',
      channel: 'slack',
      uncertain_replays: 1,
      slack_attempts: 2,
      email_attempts: 0,
    },
  ]);
});

it('keeps a failed confirmed uncertain replay pinned when its original channel budget is exhausted', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  await onlyMember(w);
  await w.drain(recorder({ sendSlack: async () => uncertain }).provider);
  const confirmed = { requestId: randomUUID(), revision: 0, confirm: true, confirmUncertain: true };
  expect((await w.notifications.retryBatch(owner, w.wid, w.pulse.id, confirmed)).queued).toBe(true);
  const refusedReplay = recorder({ sendSlack: async () => refused(false) });
  await w.drain(refusedReplay.provider);
  expect(
    (
      await w.notifications.retryBatch(owner, w.wid, w.pulse.id, {
        requestId: randomUUID(),
        revision: 0,
        confirm: true,
      })
    ).queued,
  ).toBe(true);
  await w.drain(refusedReplay.provider);
  const before = await w.events();
  expect(before).toMatchObject([
    {
      state: 'failed',
      channel: 'slack',
      uncertain_replays: 1,
      slack_attempts: 3,
      email_attempts: 0,
    },
  ]);
  expect(refusedReplay.calls).not.toContain('sendEmail');
  expect(
    (
      await w.notifications.retryBatch(owner, w.wid, w.pulse.id, {
        requestId: randomUUID(),
        revision: 0,
        confirm: true,
      })
    ).queued,
  ).toBe(false);
  expect(await w.events()).toEqual(before);
  const none = recorder();
  expect(await w.run(none.provider)).toBe(false);
  expect(none.calls).toEqual([]);
});

// ---- Fix round 2: final-lock revalidation, absolute dispatch deadlines, spacing across crashes ----

async function pause(milliseconds: number) {
  await sleep(milliseconds);
}

it('revalidates configuration and eligibility after the final provider-budget lock wait', async () => {
  const blocked = async (change: (w: Awaited<ReturnType<typeof world>>) => void) => {
    const w = await world();
    await w.enable();
    await w.open();
    await onlyOwner(w);
    await w.pace(0);
    await w.unpace();
    const smtp = w.build(w.fingerprint, 'a'.repeat(64)).grants[0]?.smtp;
    if (!smtp) throw new Error('fixture');
    // Another workspace holds the shared provider budget row while this worker waits for it.
    const other = await holding(
      'SELECT 1 FROM notification_smtp_budgets WHERE pacing_key=$1 FOR UPDATE',
      [smtpPacingKey(smtp)],
    );
    const fake = recorder();
    const running = w.run(fake.provider);
    await sleep(400);
    change(w);
    await other.release();
    await running;
    return { w, fake };
  };
  const removed = await blocked((w) => w.rotate(null));
  expect(removed.fake.calls).toEqual([]);
  expect(await removed.w.events()).toMatchObject([{ state: 'pending', email_attempts: 0 }]);
  expect(await count('FROM notification_attempts WHERE workspace_id=$1', [removed.w.wid])).toBe(0);
  const moved = await blocked((w) =>
    w.rotate(w.build(randomBytes(32).toString('hex'), randomBytes(32).toString('hex'))),
  );
  expect(moved.fake.calls).toEqual([]);
  expect(await moved.w.events()).toMatchObject([
    { state: 'skipped', reason: 'integration_disabled' },
  ]);
  const rotated = await blocked((w) => w.rotate(w.build(w.fingerprint, 'd'.repeat(64), 'new')));
  // The submission uses, and the marker pins, the credentials current after the final lock.
  expect(rotated.fake.credentials).toEqual(['d'.repeat(64)]);
  expect(
    await count('FROM notification_attempts WHERE workspace_id=$1 AND credential_fingerprint=$2', [
      rotated.w.wid,
      'd'.repeat(64),
    ]),
  ).toBe(1);
});

it('re-samples lease time after a blocked budget lock and never dispatches near expiry', async () => {
  const near = await world();
  await near.enable();
  await near.open();
  await onlyOwner(near);
  await near.pace(0);
  await near.unpace();
  const jobs = createNotificationJobs(pool);
  const lease = await jobs.claim();
  if (!lease) throw new Error('No event');
  const prepared = await jobs.prepare(lease, near.read);
  if (prepared.action !== 'send') throw new Error('Not sendable');
  // Lease nearly over once the budget lock wait ends: sampled before waiting it still looked fine.
  await pool.query(
    "UPDATE notification_events SET lease_until=clock_timestamp()+interval '5 seconds',updated_at=clock_timestamp() WHERE id=$1",
    [lease.id],
  );
  const smtp = near.build(near.fingerprint, 'a'.repeat(64)).grants[0]?.smtp;
  if (!smtp) throw new Error('fixture');
  const other = await holding(
    'SELECT 1 FROM notification_smtp_budgets WHERE pacing_key=$1 FOR UPDATE',
    [smtpPacingKey(smtp)],
  );
  const begin = jobs.begin(lease, near.read, prepared.route, () => notice);
  await sleep(2600);
  await other.release();
  expect(await begin).toEqual({ action: 'done' });
  expect(await count('FROM notification_attempts WHERE workspace_id=$1', [near.wid])).toBe(0);
  expect(await near.events()).toMatchObject([{ email_attempts: 0 }]);

  // With time left the window is derived from the fresh DB sample, not from earlier sampling.
  const ok = await world();
  await ok.enable();
  await ok.open();
  await onlyOwner(ok);
  await ok.pace(0);
  await ok.unpace();
  const lease2 = await jobs.claim();
  if (!lease2) throw new Error('No event');
  const prepared2 = await jobs.prepare(lease2, ok.read);
  if (prepared2.action !== 'send') throw new Error('Not sendable');
  await pool.query(
    "UPDATE notification_events SET lease_until=clock_timestamp()+interval '9 seconds',updated_at=clock_timestamp() WHERE id=$1",
    [lease2.id],
  );
  const smtp2 = ok.build(ok.fingerprint, 'a'.repeat(64)).grants[0]?.smtp;
  if (!smtp2) throw new Error('fixture');
  const holder = await holding(
    'SELECT 1 FROM notification_smtp_budgets WHERE pacing_key=$1 FOR UPDATE',
    [smtpPacingKey(smtp2)],
  );
  const slow = jobs.begin(lease2, ok.read, prepared2.route, () => notice);
  await sleep(1500);
  await holder.release();
  const begun = await slow;
  if (begun.action !== 'started') throw new Error('Expected a started attempt');
  // ~7.5 s of lease remained at COMMIT minus the 3 s safety: never the stale 9 s.
  expect(begun.notAfter - performance.now()).toBeLessThan(4600);
  await jobs.settle(lease2, begun, prepared2.route, accepted, ok.read);
});

it('does not dispatch with expired authorization after a pause and fences it from a competing worker', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await w.pace(0);
  await w.unpace();
  const windowMs = 5000;
  const paused = recorder();
  const competitor = recorder();
  // Worker A commits its attempt, then stalls past its hold (call window + spacing = 6 s).
  const first = w.run(paused.provider, undefined, undefined, {
    callWindowMs: windowMs,
    beforeDispatch: () => pause(7000),
  });
  await until(
    async () => (await count('FROM notification_attempts WHERE workspace_id=$1', [w.wid])) === 1,
  );
  const startedAt = Date.now();
  // Worker B must wait for the hold; once it expires B may send, A must not.
  const second = w.run(competitor.provider, undefined, undefined, { callWindowMs: windowMs });
  await Promise.all([first, second]);
  expect(paused.calls).toEqual([]);
  expect(competitor.calls).toEqual(['sendEmail']);
  expect((competitor.stamps[0]?.at ?? 0) - startedAt).toBeGreaterThanOrEqual(4500);
  const states = await w.events();
  expect(states.filter((row) => row.state === 'uncertain')).toHaveLength(1);
  expect(states.filter((row) => row.state === 'provider_accepted')).toHaveLength(1);
});

it('holds the configured spacing when a worker dies mid-call at a low SMTP rate', async () => {
  const w = await world({ rate: 1 });
  await w.enable();
  await w.open();
  await w.unpace();
  const controller = new AbortController();
  const crashed = recorder({ sendEmail: () => never<DispatchResult>() });
  const lost = w.run(crashed.provider, controller.signal).catch(() => undefined);
  await until(() => crashed.calls.includes('sendEmail'));
  const reserved = await pool.query(
    "SELECT (next_send_at>clock_timestamp()+interval '60 seconds') AS covered FROM notification_smtp_budgets WHERE next_send_at>clock_timestamp()",
  );
  // Call window plus the full 60 s spacing, not the old fixed 12 s.
  expect(reserved.rows).toContainEqual({ covered: true });
  const rival = recorder();
  const stopper = new AbortController();
  const waiting = w.run(rival.provider, stopper.signal);
  await sleep(1500);
  expect(rival.calls).toEqual([]);
  stopper.abort();
  await waiting;
  expect(rival.calls).toEqual([]);
  controller.abort();
  await lost;
});

it('still performs a real, bounded, unaborted submission when shutdown lands in the commit gap', async () => {
  const w = await world();
  await w.enable();
  await w.open();
  await onlyMember(w);
  await w.unpace();
  const controller = new AbortController();
  const fake = recorder();
  expect(
    await w.run(fake.provider, controller.signal, undefined, {
      beforeDispatch: async () => controller.abort(),
    }),
  ).toBe(true);
  // The committed attempt is genuinely invoked (not a pre-aborted call) under its own deadline.
  expect(fake.calls).toEqual(['sendEmail']);
  expect(fake.signals).toEqual([false]);
  expect(await w.events()).toMatchObject([{ state: 'provider_accepted', email_attempts: 1 }]);
});

// ---- Fix round 3: known-expired DM authorization, fresh SMTP spacing after the final lock ----

it('never calls the provider to open a DM once the preflight authorization has expired', async () => {
  const w = await world({ slack: true });
  await w.enable();
  await w.link(member.userId);
  await w.open();
  await onlyMember(w);
  await w.unpace();
  const fake = recorder();
  vi.useFakeTimers({ toFake: ['performance'] });
  try {
    // A process pause longer than the whole lease between the preflight and the DM open.
    expect(
      await w.run(fake.provider, undefined, undefined, {
        beforeOpen: async () => {
          vi.advanceTimersByTime(200_000);
        },
      }),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
  expect(fake.calls).toEqual([]);
  expect(await count('FROM notification_attempts WHERE workspace_id=$1', [w.wid])).toBe(0);
  // Released uncharged: still deliverable later.
  expect(await w.events()).toMatchObject([{ state: 'pending', slack_attempts: 0 }]);
  await w.unpace();
  await pool.query(
    'UPDATE notification_events SET available_at=clock_timestamp() WHERE workspace_id=$1',
    [w.wid],
  );
  await w.drain(fake.provider);
  expect(await w.events()).toMatchObject([{ state: 'provider_accepted', channel: 'slack' }]);
});

it('uses the fresh SMTP rate for hold and settlement when it changed during the budget lock wait', async () => {
  const w = await world({ rate: 60 });
  await w.enable();
  await w.open();
  await onlyOwner(w);
  await w.pace(0);
  await w.unpace();
  const smtp = w.build(w.fingerprint, 'a'.repeat(64)).grants[0]?.smtp;
  if (!smtp) throw new Error('fixture');
  const other = await holding(
    'SELECT 1 FROM notification_smtp_budgets WHERE pacing_key=$1 FOR UPDATE',
    [smtpPacingKey(smtp)],
  );
  const fake = recorder();
  const running = w.run(fake.provider);
  await sleep(400);
  // Rate 60/min → 1/min while blocked: same stable budget key, new spacing.
  w.rotate(w.build(w.fingerprint, 'a'.repeat(64), 'password', 1));
  await other.release();
  await running;
  expect(fake.calls).toEqual(['sendEmail']);
  const spaced = await pool.query(
    "SELECT (next_send_at>clock_timestamp()+interval '55 seconds') AS covered FROM notification_smtp_budgets WHERE pacing_key=$1",
    [smtpPacingKey(smtp)],
  );
  expect(spaced.rows).toEqual([{ covered: true }]);
});

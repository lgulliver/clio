import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../src/db/migrations.ts';
import { withTransaction } from '../src/db/pool.ts';
import { type Actor, createIdentityRepository } from '../src/features/identity/repository.ts';
import type { NotificationConfig } from '../src/features/notifications/config.ts';
import {
  createSlackLinkRepository,
  readSlackBinding,
  SlackLinkError,
} from '../src/features/notifications/link-repository.ts';
import { createNotificationRepository } from '../src/features/notifications/repository.ts';
import type { SlackIdentityProvider } from '../src/features/notifications/slack-identity.ts';

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
let created = false;
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});
async function actor(): Promise<Actor> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  await pool.query('INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,$1,$2,true)', [
    userId,
    `${userId}@example.com`,
  ]);
  await pool.query(
    "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$1,clock_timestamp()+interval '1 day')",
    [sessionId, userId],
  );
  return { userId, sessionId };
}
async function fixture() {
  const owner = await actor();
  const member = await actor();
  const outsider = await actor();
  const identity = createIdentityRepository(pool);
  const workspace = await identity.createWorkspace(owner, 'Link fixture');
  await pool.query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    [workspace.id, member.userId],
  );
  const initial: NotificationConfig = {
    mode: 'live',
    publicOrigin: 'https://app.example.com',
    grants: [
      {
        workspaceId: workspace.id,
        fingerprint: 'a'.repeat(64),
        credentialFingerprint: 'c'.repeat(64),
        smtp: null,
        slack: {
          teamId: 'T123',
          clientId: 'fixture-client',
          clientSecret: 'fixture-secret',
          botToken: 'fixture-bot',
        },
      },
    ],
  };
  let current: NotificationConfig | null = initial;
  let calls = 0;
  let configInvalid = false;
  let verification: SlackIdentityProvider['verifyCode'] = async () => ({
    teamId: 'T123',
    userId: 'U123',
  });
  const linking = createSlackLinkRepository(
    pool,
    initial,
    {
      async verifyCode(input) {
        calls++;
        return verification(input);
      },
    },
    {
      configNow: async () => {
        if (configInvalid) throw new Error('private-config');
        return current;
      },
      callbackOrigin: 'https://api.example.com',
    },
  );
  const notifications = createNotificationRepository(pool, initial, {
    configNow: async () => current,
  });
  return {
    owner,
    member,
    outsider,
    workspace,
    identity,
    linking,
    notifications,
    initial,
    calls: () => calls,
    invalidateConfig: () => {
      configInvalid = true;
    },
    rotate: (next: NotificationConfig | null) => {
      current = next;
    },
    verify: (next: SlackIdentityProvider['verifyCode']) => {
      verification = next;
    },
  };
}
function callback(start: { authorizeUrl: string }) {
  return { state: new URL(start.authorizeUrl).searchParams.get('state'), code: 'fixture-code' };
}
function hash(value: unknown) {
  if (typeof value !== 'string') throw new Error('Expected state');
  return createHash('sha256').update(value).digest('hex');
}
it('stores only state/nonce hashes with exact DB-clock five-minute expiry and separate API callback', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  const url = new URL(start.authorizeUrl);
  expect(url.origin + url.pathname).toBe('https://slack.com/openid/connect/authorize');
  expect(url.searchParams.get('scope')).toBe('openid profile');
  expect(url.searchParams.get('response_mode')).toBe('query');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('redirect_uri')).toBe(
    'https://api.example.com/api/notifications/slack/callback',
  );
  const state = await pool.query(
    "SELECT *,expires_at-created_at=interval '5 minutes' AS exact FROM notification_oauth_states WHERE state_hash=$1",
    [hash(url.searchParams.get('state'))],
  );
  expect(state.rows[0]).toMatchObject({
    nonce_hash: hash(url.searchParams.get('nonce')),
    user_id: f.member.userId,
    session_id: f.member.sessionId,
    workspace_id: f.workspace.id,
    grant_fingerprint: 'a'.repeat(64),
    credential_fingerprint: 'c'.repeat(64),
    exact: true,
  });
  f.verify(async (input) => {
    expect(input.nonceHash).toBe(hash(url.searchParams.get('nonce')));
    expect(input.signal.aborted).toBe(false);
    return { teamId: 'T123', userId: 'U123' };
  });
  expect(await f.linking.complete(f.member, callback(start))).toEqual({
    workspaceId: f.workspace.id,
    linked: true,
  });
  expect(await f.notifications.ownLink(f.member, f.workspace.id)).toMatchObject({
    linked: true,
    revision: 1,
  });
  expect(
    await withTransaction(pool, (client) =>
      readSlackBinding(client, f.workspace.id, f.member.userId),
    ),
  ).toMatchObject({
    teamId: 'T123',
    userId: 'U123',
    revision: 1,
    grantFingerprint: 'a'.repeat(64),
  });
});
it('rejects state replay without mutation and requires fresh proof to relink', async () => {
  const f = await fixture();
  const first = await f.linking.begin(f.member, f.workspace.id);
  await f.linking.complete(f.member, callback(first));
  const next = await f.linking.begin(f.member, f.workspace.id);
  f.verify(async () => ({ teamId: 'T123', userId: 'U456' }));
  await f.linking.complete(f.member, callback(next));
  await expect(f.linking.complete(f.member, callback(first))).rejects.toMatchObject({
    status: 400,
  });
  expect(f.calls()).toBe(2);
  expect(await f.notifications.ownLink(f.member, f.workspace.id)).toMatchObject({ revision: 2 });
  expect(
    await withTransaction(pool, (c) => readSlackBinding(c, f.workspace.id, f.member.userId)),
  ).toMatchObject({ userId: 'U456' });
});
it('rejects outsider and other-session state without disclosing workspace or consuming legitimate state', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  for (const caller of [f.outsider, { ...f.member, sessionId: f.owner.sessionId }]) {
    await expect(f.linking.complete(caller, callback(start))).rejects.toMatchObject({
      status: 404,
      workspaceId: undefined,
    });
  }
  await expect(f.linking.begin(f.outsider, f.workspace.id)).rejects.toMatchObject({ status: 404 });
  await f.linking.complete(f.member, callback(start));
});
it('expires DB state before verification', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  await pool.query(
    "WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS t) UPDATE notification_oauth_states SET created_at=stamp.t-interval '6 minutes',expires_at=stamp.t-interval '1 minute' FROM stamp WHERE state_hash=$1",
    [hash(callback(start).state)],
  );
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 400,
    message: 'invalid_slack_state',
  });
  expect(f.calls()).toBe(0);
});
it('consumes failed proof and denial exactly once with trusted body-free failure context', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  f.verify(async () => {
    throw new Error('private-code-token-profile');
  });
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 400,
    workspaceId: f.workspace.id,
    message: 'invalid_slack_identity',
  });
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 400,
  });
  expect(f.calls()).toBe(1);
  const denial = await f.linking.begin(f.member, f.workspace.id);
  await expect(
    f.linking.complete(f.member, {
      state: callback(denial).state,
      error: 'access_denied',
      error_description: 'private',
    }),
  ).rejects.toMatchObject({
    status: 400,
    workspaceId: f.workspace.id,
    message: 'slack_link_denied',
  });
  await expect(f.linking.complete(f.member, callback(denial))).rejects.toMatchObject({
    status: 400,
  });
});
it('current membership revocation before callback rejects 404 without disclosing deleted state workspace', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  await f.identity.revokeMember(f.owner, f.workspace.id, f.member.userId);
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 404,
    workspaceId: undefined,
  });
  expect(f.calls()).toBe(0);
});
it('session revoked during network prevents late binding', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  f.verify(async () => {
    await pool.query('DELETE FROM auth_sessions WHERE id=$1', [f.member.sessionId]);
    return { teamId: 'T123', userId: 'U123' };
  });
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 401,
    workspaceId: f.workspace.id,
  });
  expect(
    (
      await pool.query('SELECT 1 FROM notification_slack_bindings WHERE workspace_id=$1', [
        f.workspace.id,
      ])
    ).rowCount,
  ).toBe(0);
});
it('membership revoked during network prevents late binding', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  f.verify(async () => {
    await f.identity.revokeMember(f.owner, f.workspace.id, f.member.userId);
    return { teamId: 'T123', userId: 'U123' };
  });
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 404,
    workspaceId: f.workspace.id,
  });
});
it.each(['scope', 'credentials', 'missing'])(
  'rejects %s config rotation during proof and consumes state',
  async (change) => {
    const f = await fixture();
    const start = await f.linking.begin(f.member, f.workspace.id);
    f.verify(async () => {
      f.rotate(
        change === 'missing'
          ? null
          : {
              ...f.initial,
              grants: f.initial.grants.map((g) => ({
                ...g,
                ...(change === 'scope'
                  ? { fingerprint: 'd'.repeat(64) }
                  : { credentialFingerprint: 'd'.repeat(64) }),
              })),
            },
      );
      return { teamId: 'T123', userId: 'U123' };
    });
    await expect(f.linking.complete(f.member, callback(start))).rejects.toBeInstanceOf(
      SlackLinkError,
    );
    expect(
      (
        await pool.query('SELECT 1 FROM notification_slack_bindings WHERE workspace_id=$1', [
          f.workspace.id,
        ])
      ).rowCount,
    ).toBe(0);
    await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
      status: 400,
    });
  },
);
it('rereads credentials before verification and never falls back to constructor config', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  f.rotate({
    ...f.initial,
    grants: f.initial.grants.map((g) => ({ ...g, credentialFingerprint: 'd'.repeat(64) })),
  });
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 409,
  });
  expect(f.calls()).toBe(0);
  f.rotate(null);
  await expect(f.linking.begin(f.member, f.workspace.id)).rejects.toMatchObject({ status: 409 });
});
it('unlink during proof invalidates state and binding revision', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  f.verify(async () => {
    await f.notifications.unlink(f.member, f.workspace.id, { revision: 0 });
    return { teamId: 'T123', userId: 'U123' };
  });
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 409,
  });
  expect(await f.notifications.ownLink(f.member, f.workspace.id)).toEqual({
    linked: false,
    revision: 1,
    linkedAt: null,
  });
});
it('concurrent callbacks consume state once', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  const result = await Promise.allSettled([
    f.linking.complete(f.member, callback(start)),
    f.linking.complete(f.member, callback(start)),
  ]);
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.calls()).toBe(1);
});
it('concurrent members cannot claim same Slack identity; one wins, other 409', async () => {
  const f = await fixture();
  const one = await f.linking.begin(f.owner, f.workspace.id);
  const two = await f.linking.begin(f.member, f.workspace.id);
  const result = await Promise.allSettled([
    f.linking.complete(f.owner, callback(one)),
    f.linking.complete(f.member, callback(two)),
  ]);
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = result.find((r) => r.status === 'rejected');
  if (rejected?.status !== 'rejected') throw new Error('Expected collision');
  expect(rejected.reason).toMatchObject({ status: 409, message: 'conflict' });
  expect(
    (
      await pool.query('SELECT 1 FROM notification_slack_bindings WHERE workspace_id=$1', [
        f.workspace.id,
      ])
    ).rowCount,
  ).toBe(1);
});
it('rejects wrong provider team and cannot mutate binding', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  f.verify(async () => ({ teamId: 'T456', userId: 'U123' }));
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 400,
  });
  expect(await f.notifications.ownLink(f.member, f.workspace.id)).toMatchObject({
    linked: false,
    revision: 0,
  });
});
it('invalid config replacement fails closed with redacted 503 and no cached authority', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  f.invalidateConfig();
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 503,
    message: 'unavailable',
    workspaceId: f.workspace.id,
  });
  expect(f.calls()).toBe(0);
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 400,
  });
  await expect(f.linking.begin(f.member, f.workspace.id)).rejects.toMatchObject({
    status: 503,
    message: 'unavailable',
  });
});
it('config invalidated after proof prevents binding commit', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  f.verify(async () => {
    f.invalidateConfig();
    return { teamId: 'T123', userId: 'U123' };
  });
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 503,
    message: 'unavailable',
  });
  expect(
    (
      await pool.query('SELECT 1 FROM notification_slack_bindings WHERE workspace_id=$1', [
        f.workspace.id,
      ])
    ).rowCount,
  ).toBe(0);
});
it('expired original session prevents late binding', async () => {
  const f = await fixture();
  const start = await f.linking.begin(f.member, f.workspace.id);
  f.verify(async () => {
    await pool.query(
      "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.member.sessionId],
    );
    return { teamId: 'T123', userId: 'U123' };
  });
  await expect(f.linking.complete(f.member, callback(start))).rejects.toMatchObject({
    status: 401,
  });
});
it('superseding link commits cannot be overwritten by earlier in-flight proof', async () => {
  const f = await fixture();
  const first = await f.linking.begin(f.member, f.workspace.id);
  let release = () => {};
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const networkEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.verify(async () => {
    entered();
    await waiting;
    return { teamId: 'T123', userId: 'U123' };
  });
  const old = f.linking.complete(f.member, callback(first));
  const rejected = expect(old).rejects.toMatchObject({ status: 409 });
  await networkEntered;
  const next = await f.linking.begin(f.member, f.workspace.id);
  f.verify(async () => ({ teamId: 'T123', userId: 'U456' }));
  await f.linking.complete(f.member, callback(next));
  release();
  await rejected;
  expect(
    await withTransaction(pool, (c) => readSlackBinding(c, f.workspace.id, f.member.userId)),
  ).toMatchObject({ userId: 'U456', revision: 1 });
});
it('binding keeps stable scope across credential rotation while source rotation is visibly fenced', async () => {
  const f = await fixture();
  const first = await f.linking.begin(f.member, f.workspace.id);
  await f.linking.complete(f.member, callback(first));
  f.rotate({
    ...f.initial,
    grants: f.initial.grants.map((g) => ({ ...g, credentialFingerprint: 'd'.repeat(64) })),
  });
  const next = await f.linking.begin(f.member, f.workspace.id);
  await f.linking.complete(f.member, callback(next));
  expect(
    await withTransaction(pool, (c) => readSlackBinding(c, f.workspace.id, f.member.userId)),
  ).toMatchObject({ grantFingerprint: 'a'.repeat(64), revision: 2 });
  f.rotate({
    ...f.initial,
    grants: f.initial.grants.map((g) => ({
      ...g,
      fingerprint: 'e'.repeat(64),
      slack: g.slack ? { ...g.slack, teamId: 'T456' } : null,
    })),
  });
  const changed = await f.linking.begin(f.member, f.workspace.id);
  f.verify(async () => ({ teamId: 'T456', userId: 'U456' }));
  await f.linking.complete(f.member, callback(changed));
  expect(
    await withTransaction(pool, (c) => readSlackBinding(c, f.workspace.id, f.member.userId)),
  ).toMatchObject({ teamId: 'T456', grantFingerprint: 'e'.repeat(64), revision: 3 });
});

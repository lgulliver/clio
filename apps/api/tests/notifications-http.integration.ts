import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseUrl } from '../src/config.ts';
import { checkReadiness, loadMigrations, migrate } from '../src/db/migrations.ts';
import { withTransaction } from '../src/db/pool.ts';
import { type ClioAuth, createAuth } from '../src/features/identity/auth.ts';
import { readAuthConfig } from '../src/features/identity/config.ts';
import type { Actor } from '../src/features/identity/repository.ts';
import type {
  NotificationConfig,
  NotificationGrant,
} from '../src/features/notifications/config.ts';
import { capturePulseNotifications } from '../src/features/notifications/events.ts';
import {
  type NotificationProvider,
  SlackVerificationError,
} from '../src/features/notifications/provider.ts';
import type { SlackIdentityProvider } from '../src/features/notifications/slack-identity.ts';
import { createOrganizationRepository } from '../src/features/organization/repository.ts';
import { createSpaceRepository } from '../src/features/space/repository.ts';
import { createServer } from '../src/server.ts';

if (!process.env.CLIO_TEST_DATABASE_URL)
  throw new Error('CLIO_TEST_DATABASE_URL is required for PostgreSQL integration tests');
const connectionString = databaseUrl(process.env.CLIO_TEST_DATABASE_URL);
const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString, connectionTimeoutMillis: 3000 });
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000,
});
const appOrigin = 'https://clio.example.test';
const config = readAuthConfig({
  AUTH_SECRET: 'notifications-http-secret-random-fixture-only-123456789',
  AUTH_BASE_URL: 'http://localhost:3000',
  APP_ORIGIN: appOrigin,
  GITHUB_CLIENT_ID: 'fixture-client',
  GITHUB_CLIENT_SECRET: 'fixture-secret',
});
if (!config) throw new Error('Test configuration missing');
const callbackUri = 'http://localhost:3000/api/notifications/slack/callback';
let auth: ClioAuth;
let server: FastifyInstance;
let created = false;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object');
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value;
}
function cookieHeader(value: string | string[] | undefined): string {
  return (typeof value === 'string' ? [value] : (value ?? []))
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------- GitHub login fixture
// Real Better Auth OAuth protocol, state cookies, adapter, SQL and sessions run unchanged;
// every other outbound request fails the test.
let githubProfile = {
  id: '1',
  login: 'x',
  name: 'X',
  email: 'x@example.com',
  avatar_url: 'https://example.com/a',
};
function installGitHub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://github.com/login/oauth/access_token')
        return Response.json({
          access_token: 'transient-login-token',
          token_type: 'bearer',
          scope: 'read:user,user:email',
        });
      if (url === 'https://api.github.com/user') return Response.json(githubProfile);
      if (url === 'https://api.github.com/user/emails')
        return Response.json([
          { email: githubProfile.email, primary: true, verified: true, visibility: 'private' },
        ]);
      throw new Error('Unexpected external request in notification HTTP test');
    }),
  );
}
type Session = { cookie: string; userId: string; sessionId: string; actor: Actor };
async function login(id: string, email: string): Promise<Session> {
  githubProfile = { ...githubProfile, id, login: `login-${id}`, name: `Name ${id}`, email };
  const start = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: { origin: appOrigin },
    payload: { provider: 'github', callbackURL: appOrigin, disableRedirect: true },
  });
  expect(start.statusCode).toBe(200);
  const state = new URL(string(record(start.json()).url)).searchParams.get('state') ?? '';
  const callback = await server.inject({
    url: `/api/auth/callback/github?code=fixture-code&state=${encodeURIComponent(state)}`,
    headers: { cookie: cookieHeader(start.headers['set-cookie']) },
  });
  expect(callback.statusCode).toBe(302);
  const cookie = cookieHeader(callback.headers['set-cookie']);
  const current = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!current) throw new Error('OAuth fixture did not create a session');
  return {
    cookie,
    userId: current.user.id,
    sessionId: current.session.id,
    actor: { userId: current.user.id, sessionId: current.session.id },
  };
}

// ---------------------------------------------------------------- trusted notification seams
type GrantOptions = { smtp: boolean; slack: boolean; revision: string };
const grantOptions = new Map<string, GrantOptions>();
let configMode: 'present' | 'absent' | 'broken' | 'other_origin' = 'present';
function makeGrant(workspaceId: string, options: GrantOptions): NotificationGrant {
  return {
    workspaceId,
    fingerprint: digest(`scope:${workspaceId}:${options.smtp}:${options.slack}`),
    credentialFingerprint: digest(`credential:${workspaceId}:${options.revision}`),
    smtp: options.smtp
      ? {
          host: 'smtp.example.test',
          port: 465,
          user: null,
          password: null,
          from: 'clio@example.test',
          ratePerMinute: 30,
        }
      : null,
    slack: options.slack
      ? {
          teamId: 'T01SLACK',
          botToken: 'xoxb-fixture-never-real',
          clientId: 'fixture-slack-client',
          clientSecret: 'fixture-slack-secret',
        }
      : null,
  };
}
async function configNow(): Promise<NotificationConfig | null> {
  if (configMode === 'broken') throw new Error('unreadable');
  if (configMode === 'absent') return null;
  return {
    mode: 'live',
    publicOrigin: configMode === 'other_origin' ? 'https://other.example.test' : appOrigin,
    grants: [...grantOptions].map(([id, options]) => makeGrant(id, options)),
  };
}
function rotate(workspaceId: string) {
  const current = grantOptions.get(workspaceId);
  if (current) grantOptions.set(workspaceId, { ...current, revision: `r-${randomUUID()}` });
}
let verifyCalls = 0;
let verify: (grant: NotificationGrant) => Promise<{ teamId: string }> = async (grant) => ({
  teamId: grant.slack?.teamId ?? '',
});
const refused = {
  outcome: 'not_accepted',
  retryable: false,
  reason: 'configuration_invalid',
} as const;
const notificationProvider: NotificationProvider = {
  verifySlack: async (grant) => {
    verifyCalls += 1;
    return verify(grant);
  },
  openDm: async () => refused,
  sendSlack: async () => refused,
  sendEmail: async () => refused,
};
const verifyInputs: Array<{ code: string; nonceHash: string }> = [];
let slackUser = 'U01OWNER';
let identityHook: () => Promise<void> = async () => {};
const slackIdentityProvider: SlackIdentityProvider = {
  verifyCode: async (input) => {
    verifyInputs.push({ code: input.code, nonceHash: input.nonceHash });
    await identityHook();
    return { teamId: input.grant.slack?.teamId ?? '', userId: slackUser };
  },
};

// ---------------------------------------------------------------- HTTP helpers
async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  cookie: string | null,
  payload?: object,
  origin: string | null = method === 'GET' ? null : appOrigin,
) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  return server.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}
const nb = (workspaceId: string) => `/api/workspaces/${workspaceId}/notifications`;
const policyBody = (revision: number, enabled: boolean, extra: object = {}) => ({
  revision,
  enabled,
  invitations: true,
  closures: true,
  reminders: true,
  firstReminderHours: 48,
  repeatHours: 72,
  maximumReminders: 2,
  ...extra,
});
const reminderBody = (revision: number, extra: object = {}) => ({
  requestId: randomUUID(),
  revision,
  confirm: true,
  ...extra,
});
function done(workspaceId: string | null, outcome: 'success' | 'failed') {
  return workspaceId === null
    ? `${appOrigin}/developer-experience?notificationLink=${outcome}`
    : `${appOrigin}/developer-experience?workspace=${workspaceId}&notificationLink=${outcome}`;
}
function noStore(response: { headers: Record<string, unknown> }) {
  expect(response.headers['cache-control']).toBe('no-store');
}

let owner: Session;
let member: Session;
let outsider: Session;
async function world(options: Partial<GrantOptions> = {}) {
  const created = await call('POST', '/api/workspaces', owner.cookie, {
    name: `Workspace ${randomUUID()}`,
  });
  expect(created.statusCode).toBe(201);
  const id = string(record(record(created.json()).workspace).id);
  const invitation = await call('POST', `/api/workspaces/${id}/invitations`, owner.cookie, {
    email: 'member-http@example.com',
  });
  expect(invitation.statusCode).toBe(201);
  const token = string(record(record(invitation.json()).invitation).token);
  expect(
    (await call('POST', '/api/workspace-invitations/accept', member.cookie, { token })).statusCode,
  ).toBe(200);
  grantOptions.set(id, { smtp: true, slack: true, revision: 'r1', ...options });
  return id;
}
async function policyRevision(workspaceId: string): Promise<number> {
  const response = await call('GET', `${nb(workspaceId)}/policy`, owner.cookie);
  expect(response.statusCode).toBe(200);
  const revision = record(record(response.json()).policy).revision;
  if (typeof revision !== 'number') throw new Error('revision');
  return revision;
}
async function enable(workspaceId: string) {
  const response = await call(
    'PATCH',
    `${nb(workspaceId)}/policy`,
    owner.cookie,
    policyBody(await policyRevision(workspaceId), true),
  );
  expect(response.statusCode).toBe(200);
}
async function openedPulse(workspaceId: string) {
  await enable(workspaceId);
  const team = await createOrganizationRepository(pool).createTeam(
    owner.actor,
    workspaceId,
    'Team',
  );
  const space = createSpaceRepository(pool);
  await space.assign(owner.actor, workspaceId, owner.userId, { teamId: team.id });
  await space.assign(owner.actor, workspaceId, member.userId, { teamId: team.id });
  const pulse = await space.create(owner.actor, workspaceId, {
    teamId: team.id,
    referenceStart: '2026-01-01T00:00:00.000Z',
    referenceEnd: '2026-01-08T00:00:00.000Z',
  });
  await space.transition(owner.actor, workspaceId, pulse.id, 'open');
  await withTransaction(pool, (client) => capturePulseNotifications(client, workspaceId, pulse.id));
  return { pulseId: pulse.id, space };
}
async function startLink(workspaceId: string, session: Session) {
  const response = await call('POST', `${nb(workspaceId)}/slack-link/start`, session.cookie, {});
  expect(response.statusCode).toBe(200);
  const url = new URL(string(record(response.json()).authorizeUrl));
  return {
    url,
    state: url.searchParams.get('state') ?? '',
    nonce: url.searchParams.get('nonce') ?? '',
  };
}
function callback(cookie: string | null, query: string, headers: Record<string, string> = {}) {
  return server.inject({
    method: 'GET',
    url: `/api/notifications/slack/callback?${query}`,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
}
async function binding(workspaceId: string, userId: string) {
  const result = await pool.query(
    'SELECT slack_user_id,revision FROM notification_slack_bindings WHERE workspace_id=$1 AND user_id=$2',
    [workspaceId, userId],
  );
  return result.rows[0] ?? null;
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool);
  auth = createAuth(pool, config);
  await (await auth.$context).checkSchema?.();
  installGitHub();
  server = createServer(
    { ready: async () => checkReadiness(pool, await loadMigrations()), close: async () => {} },
    {
      auth,
      config,
      pool,
      notifications: null,
      notificationsConfigNow: configNow,
      notificationProvider,
      slackIdentityProvider,
    },
  );
  owner = await login('7001', 'owner-http@example.com');
  member = await login('7002', 'member-http@example.com');
  outsider = await login('7003', 'outsider-http@example.com');
});
beforeEach(() => {
  configMode = 'present';
  verifyCalls = 0;
  verifyInputs.length = 0;
  slackUser = 'U01OWNER';
  identityHook = async () => {};
  verify = async (grant) => ({ teamId: grant.slack?.teamId ?? '' });
});
afterAll(async () => {
  if (server) await server.close();
  await pool.end();
  try {
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await admin.end();
    vi.unstubAllGlobals();
  }
});

describe('authentication, Origin and workspace authorization through the production plugin', () => {
  it('rejects anonymous, forged-Origin, cross-workspace and member-owner requests on every route', async () => {
    const ws = await world();
    const { pulseId } = await openedPulse(ws);
    const other = await call('POST', '/api/workspaces', outsider.cookie, { name: 'Outsider' });
    const foreign = string(record(record(other.json()).workspace).id);
    const routes = [
      { m: 'GET', p: 'availability', owner: false },
      { m: 'GET', p: 'policy', owner: true },
      { m: 'PATCH', p: 'policy', owner: true, b: policyBody(0, false) },
      { m: 'GET', p: 'slack-link', owner: false },
      { m: 'POST', p: 'slack-link/start', owner: false, b: {} },
      { m: 'POST', p: 'slack-link/unlink', owner: false, b: { revision: 0 } },
      { m: 'GET', p: 'history', owner: false },
      { m: 'GET', p: `pulses/${pulseId}`, owner: true },
      { m: 'POST', p: `pulses/${pulseId}/remind`, owner: true, b: reminderBody(0) },
      { m: 'POST', p: `pulses/${pulseId}/reminders/disable`, owner: true, b: { revision: 0 } },
      { m: 'POST', p: `pulses/${pulseId}/retry`, owner: true, b: reminderBody(0) },
      { m: 'POST', p: 'test', owner: true, b: { ...reminderBody(0), channel: 'email' } },
    ] as const;
    for (const r of routes) {
      const body = 'b' in r ? r.b : undefined;
      const method = r.m;
      const label = `${method} ${r.p}`;
      const anonymous = await call(method, `${nb(ws)}/${r.p}`, null, body);
      expect(anonymous.statusCode, label).toBe(401);
      noStore(anonymous);
      if (method !== 'GET') {
        for (const origin of [
          null,
          'https://evil.example',
          'https://clio.example.test.evil.example',
        ]) {
          const forged = await call(method, `${nb(ws)}/${r.p}`, owner.cookie, body, origin);
          expect(forged.statusCode, `${label} origin ${origin}`).toBe(403);
          noStore(forged);
        }
      }
      for (const [who, path] of [
        [outsider, `${nb(ws)}/${r.p}`],
        [owner, `${nb(foreign)}/${r.p}`],
      ] as const) {
        const hidden = await call(method, path, who.cookie, body);
        expect(hidden.statusCode, `${label} hidden`).toBe(404);
        noStore(hidden);
      }
      if (r.owner) {
        const denied = await call(method, `${nb(ws)}/${r.p}`, member.cookie, body);
        expect(denied.statusCode, `${label} member`).toBe(403);
        expect(denied.json()).toEqual({ error: 'forbidden' });
        noStore(denied);
      }
    }
    expect(verifyCalls).toBe(1);
  });

  it('never contacts the provider for a member, outsider or stale enable request', async () => {
    const ws = await world();
    const before = verifyCalls;
    expect(
      (await call('PATCH', `${nb(ws)}/policy`, member.cookie, policyBody(0, true))).statusCode,
    ).toBe(403);
    expect(
      (await call('PATCH', `${nb(ws)}/policy`, outsider.cookie, policyBody(0, true))).statusCode,
    ).toBe(404);
    expect(
      (await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(5, true))).statusCode,
    ).toBe(409);
    expect(verifyCalls).toBe(before);
    expect(await policyRevision(ws)).toBe(0);
  });
});

describe('availability, policy and absent private configuration', () => {
  it('keeps stored history and unlink available while capabilities fail safely without configuration', async () => {
    const ws = await world();
    await openedPulse(ws);
    expect((await startLink(ws, owner)).state).not.toBe('');
    configMode = 'absent';
    const availability = await call('GET', `${nb(ws)}/availability`, member.cookie);
    expect(availability.statusCode).toBe(200);
    noStore(availability);
    expect(availability.json()).toEqual({
      workspaceId: ws,
      emailConfigured: false,
      slackConfigured: false,
      linkingConfigured: false,
    });
    const history = await call('GET', `${nb(ws)}/history`, member.cookie);
    expect(history.statusCode).toBe(200);
    const items = array(record(history.json()).items);
    expect(items).toHaveLength(1);
    expect(record(items[0])).toMatchObject({ kind: 'invitation', state: 'pending' });
    const link = await call('GET', `${nb(ws)}/slack-link`, member.cookie);
    expect(link.json()).toEqual({ link: { linked: false, revision: 0, linkedAt: null } });
    const unlinked = await call('POST', `${nb(ws)}/slack-link/unlink`, member.cookie, {
      revision: 0,
    });
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json()).toEqual({ link: { linked: false, revision: 1, linkedAt: null } });
    expect(
      (await call('POST', `${nb(ws)}/slack-link/unlink`, member.cookie, { revision: 0 }))
        .statusCode,
    ).toBe(409);
    const revision = await policyRevision(ws);
    expect(
      (await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(revision, true)))
        .statusCode,
    ).toBe(409);
    expect((await call('POST', `${nb(ws)}/slack-link/start`, owner.cookie, {})).statusCode).toBe(
      409,
    );
    const test = await call('POST', `${nb(ws)}/test`, owner.cookie, {
      ...reminderBody(revision),
      channel: 'email',
    });
    expect(test.statusCode).toBe(409);
    expect(verifyCalls).toBe(1);
    configMode = 'broken';
    expect((await call('GET', `${nb(ws)}/availability`, owner.cookie)).statusCode).toBe(503);
    expect((await call('GET', `${nb(ws)}/history`, owner.cookie)).statusCode).toBe(200);
    // Disabling needs no capability and never contacts a provider.
    const disabled = await call(
      'PATCH',
      `${nb(ws)}/policy`,
      owner.cookie,
      policyBody(revision, false),
    );
    expect(disabled.statusCode).toBe(200);
  });

  it('fails closed when the operator origin differs from the trusted application origin', async () => {
    const ws = await world();
    configMode = 'other_origin';
    expect((await call('GET', `${nb(ws)}/availability`, owner.cookie)).statusCode).toBe(503);
    expect(
      (await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(0, true))).statusCode,
    ).toBe(503);
    expect((await call('POST', `${nb(ws)}/slack-link/start`, owner.cookie, {})).statusCode).toBe(
      503,
    );
    expect(verifyCalls).toBe(0);
  });

  it('verifies Slack outside storage transactions and commits only the fresh proof', async () => {
    const ws = await world();
    let idleInTransaction = -1;
    verify = async (grant) => {
      const open = await pool.query(
        "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%' AND pid<>pg_backend_pid()",
      );
      idleInTransaction = Number(open.rows[0]?.n);
      return { teamId: grant.slack?.teamId ?? '' };
    };
    const response = await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(0, true));
    expect(response.statusCode).toBe(200);
    expect(idleInTransaction).toBe(0);
    expect(response.json()).toEqual({ policy: policyBody(1, true) });
    const serialized = JSON.stringify(response.json());
    for (const secret of [
      'xoxb-fixture',
      'fixture-slack-secret',
      digest(`scope:${ws}:true:true`),
      digest(`credential:${ws}:r1`),
      'T01SLACK',
    ])
      expect(serialized).not.toContain(secret);
    // Disabling never contacts Slack and re-enabling needs a new proof.
    const calls = verifyCalls;
    expect(
      (await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(1, false))).statusCode,
    ).toBe(200);
    expect(verifyCalls).toBe(calls);
    expect(
      (await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(2, true))).statusCode,
    ).toBe(200);
    expect(verifyCalls).toBe(calls + 1);
  });

  it('maps verification failures without exposing provider detail and stores nothing', async () => {
    const ws = await world();
    const cases: Array<[() => Promise<{ teamId: string }>, number]> = [
      [async () => ({ teamId: 'T99OTHER' }), 409],
      [
        async () => {
          throw new SlackVerificationError('rejected', null);
        },
        409,
      ],
      [
        async () => {
          throw new SlackVerificationError('team_mismatch', null);
        },
        409,
      ],
      [
        async () => {
          throw new SlackVerificationError('unavailable', null);
        },
        503,
      ],
      [
        async () => {
          throw new Error('xoxb-secret provider detail');
        },
        503,
      ],
    ];
    for (const [implementation, status] of cases) {
      verify = implementation;
      const response = await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(0, true));
      expect(response.statusCode).toBe(status);
      expect(response.payload).not.toContain('secret');
      expect(response.payload).not.toContain('provider');
    }
    expect(await policyRevision(ws)).toBe(0);
  });

  it('rejects the commit when configuration rotates between proof and write', async () => {
    const ws = await world();
    verify = async (grant) => {
      rotate(ws);
      return { teamId: grant.slack?.teamId ?? '' };
    };
    expect(
      (await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(0, true))).statusCode,
    ).toBe(409);
    expect(await policyRevision(ws)).toBe(0);
  });

  it('enables an email-only grant without any provider call', async () => {
    const ws = await world({ slack: false });
    expect(
      (await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(0, true))).statusCode,
    ).toBe(200);
    expect(verifyCalls).toBe(0);
  });

  it('persists Slack 429 metadata and honours it durably without more provider calls', async () => {
    const ws = await world();
    verify = async () => {
      throw new SlackVerificationError('rate_limited', 90_000);
    };
    const first = await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(0, true));
    expect(first.statusCode).toBe(429);
    expect(first.json()).toEqual({ error: 'rate_limited' });
    noStore(first);
    const wait = Number(first.headers['retry-after']);
    expect(wait).toBeGreaterThan(60);
    expect(wait).toBeLessThanOrEqual(90);
    const stored = await pool.query(
      "SELECT method,blocked_until>clock_timestamp() AS active FROM notification_slack_cooldowns WHERE team_id='T01SLACK'",
    );
    expect(stored.rows).toEqual([{ method: 'auth.test', active: true }]);
    const calls = verifyCalls;
    const second = await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(0, true));
    expect(second.statusCode).toBe(429);
    expect(verifyCalls).toBe(calls);
    // A shorter later response never shortens an active pause.
    await pool.query(
      "UPDATE notification_slack_cooldowns SET blocked_until=clock_timestamp()-interval '1 second' WHERE team_id='T01SLACK'",
    );
    verify = async (grant) => ({ teamId: grant.slack?.teamId ?? '' });
    expect(
      (await call('PATCH', `${nb(ws)}/policy`, owner.cookie, policyBody(0, true))).statusCode,
    ).toBe(200);
    expect(verifyCalls).toBe(calls + 1);
  });
});

describe('Slack account linking through the actual callback route', () => {
  it('starts with the fixed callback URI, then links once and replays safely', async () => {
    const ws = await world();
    const { url, state, nonce } = await startLink(ws, owner);
    expect(url.origin + url.pathname).toBe('https://slack.com/openid/connect/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe(callbackUri);
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('team')).toBe('T01SLACK');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      (await call('POST', `${nb(ws)}/slack-link/start`, owner.cookie, {}, 'https://evil.example'))
        .statusCode,
    ).toBe(403);
    const success = await callback(owner.cookie, `code=fixture-code&state=${state}`, {
      host: 'attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'http',
    });
    expect(success.statusCode).toBe(303);
    expect(success.headers.location).toBe(done(ws, 'success'));
    expect(success.headers['referrer-policy']).toBe('no-referrer');
    noStore(success);
    expect(success.payload).not.toContain('fixture-code');
    expect(verifyInputs).toEqual([{ code: 'fixture-code', nonceHash: digest(nonce) }]);
    const link = await call('GET', `${nb(ws)}/slack-link`, owner.cookie);
    expect(record(record(link.json()).link)).toMatchObject({ linked: true, revision: 1 });
    expect(link.payload).not.toContain('U01OWNER');
    const replay = await callback(owner.cookie, `code=fixture-code&state=${state}`);
    expect(replay.headers.location).toBe(done(ws, 'failed'));
    expect(verifyInputs).toHaveLength(1);
    const unlinked = await call('POST', `${nb(ws)}/slack-link/unlink`, owner.cookie, {
      revision: 1,
    });
    expect(unlinked.json()).toEqual({ link: { linked: false, revision: 2, linkedAt: null } });
    expect(
      (await call('POST', `${nb(ws)}/slack-link/unlink`, owner.cookie, { revision: 1 })).statusCode,
    ).toBe(409);
  });

  it('does not let another member or session consume a state or learn its workspace', async () => {
    const ws = await world();
    const { state } = await startLink(ws, owner);
    const stolen = await callback(member.cookie, `code=fixture-code&state=${state}`);
    expect(stolen.headers.location).toBe(done(null, 'failed'));
    const other = await login('7001', 'owner-http@example.com');
    expect(other.sessionId).not.toBe(owner.sessionId);
    expect(
      (await callback(other.cookie, `code=fixture-code&state=${state}`)).headers.location,
    ).toBe(done(null, 'failed'));
    const anonymous = await callback(null, `code=fixture-code&state=${state}`);
    expect(anonymous.statusCode).toBe(303);
    expect(anonymous.headers.location).toBe(done(null, 'failed'));
    expect(verifyInputs).toHaveLength(0);
    expect(
      (await callback(owner.cookie, `code=fixture-code&state=${state}`)).headers.location,
    ).toBe(done(ws, 'success'));
  });

  it('reports denial and hostile callback input without echoing provider values', async () => {
    const ws = await world();
    const { state } = await startLink(ws, owner);
    const denied = await callback(
      owner.cookie,
      `error=access_denied&error_description=leaky-detail&state=${state}`,
    );
    expect(denied.headers.location).toBe(done(ws, 'failed'));
    expect(JSON.stringify(denied.headers)).not.toContain('leaky-detail');
    const fresh = await startLink(ws, owner);
    for (const query of [
      `code=a&code=b&state=${fresh.state}`,
      `code=a&state=${fresh.state}&workspace=${randomUUID()}`,
      `state=${fresh.state}`,
      'code=a&state=short',
    ]) {
      const response = await callback(owner.cookie, query);
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe(done(null, 'failed'));
    }
    expect(verifyInputs).toHaveLength(0);
  });

  it('fails after session revocation, both before and during verification', async () => {
    const ws = await world();
    const before = await login('7001', 'owner-http@example.com');
    const first = await startLink(ws, before);
    await pool.query('DELETE FROM auth_sessions WHERE id=$1', [before.sessionId]);
    const revoked = await callback(before.cookie, `code=fixture-code&state=${first.state}`);
    expect(revoked.headers.location).toBe(done(null, 'failed'));
    expect(verifyInputs).toHaveLength(0);
    const during = await login('7001', 'owner-http@example.com');
    const second = await startLink(ws, during);
    identityHook = async () => {
      await pool.query('DELETE FROM auth_sessions WHERE id=$1', [during.sessionId]);
    };
    const response = await callback(during.cookie, `code=fixture-code&state=${second.state}`);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(done(ws, 'failed'));
    expect(await binding(ws, owner.userId)).toBeNull();
  });

  it('fails when membership is revoked before the callback', async () => {
    const ws = await world();
    const { state } = await startLink(ws, member);
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
      ws,
      member.userId,
    ]);
    const response = await callback(member.cookie, `code=fixture-code&state=${state}`);
    expect(response.headers.location).toBe(done(null, 'failed'));
    expect(verifyInputs).toHaveLength(0);
  });

  it('fails when private configuration rotates, disappears or breaks around the exchange', async () => {
    const ws = await world();
    const cases: Array<() => Promise<void> | void> = [
      () => {
        configMode = 'absent';
      },
      () => {
        configMode = 'broken';
      },
      () => {
        rotate(ws);
      },
    ];
    for (const change of cases) {
      configMode = 'present';
      const { state } = await startLink(ws, owner);
      change();
      const response = await callback(owner.cookie, `code=fixture-code&state=${state}`);
      expect(response.headers.location, 'before').toBe(done(ws, 'failed'));
      configMode = 'present';
      grantOptions.set(ws, { smtp: true, slack: true, revision: 'r1' });
    }
    for (const change of [
      () => {
        configMode = 'absent';
      },
      () => {
        rotate(ws);
      },
    ]) {
      configMode = 'present';
      grantOptions.set(ws, { smtp: true, slack: true, revision: 'r1' });
      const { state } = await startLink(ws, owner);
      identityHook = async () => change();
      const response = await callback(owner.cookie, `code=fixture-code&state=${state}`);
      expect(response.headers.location, 'during').toBe(done(ws, 'failed'));
      expect(await binding(ws, owner.userId)).toBeNull();
    }
  });

  it('rejects one Slack identity for two members and keeps the first link', async () => {
    const ws = await world();
    const first = await startLink(ws, owner);
    expect((await callback(owner.cookie, `code=a&state=${first.state}`)).headers.location).toBe(
      done(ws, 'success'),
    );
    const second = await startLink(ws, member);
    const response = await callback(member.cookie, `code=b&state=${second.state}`);
    expect(response.headers.location).toBe(done(ws, 'failed'));
    expect(await binding(ws, member.userId)).toBeNull();
    expect(await binding(ws, owner.userId)).toMatchObject({ slack_user_id: 'U01OWNER' });
  });

  it('forwards Better Auth session renewal cookies from the callback', async () => {
    const ws = await world();
    const session = await login('7001', 'owner-http@example.com');
    const { state } = await startLink(ws, session);
    await pool.query("UPDATE auth_sessions SET expires_at=now()+interval '1 day' WHERE id=$1", [
      session.sessionId,
    ]);
    const response = await callback(session.cookie, `code=fixture-code&state=${state}`);
    expect(response.headers.location).toBe(done(ws, 'success'));
    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('HttpOnly'),
        expect.stringContaining('Max-Age=604800'),
      ]),
    );
  });
});

describe('own history, owner summary and controls', () => {
  it('returns only the caller own scoped pages and rejects borrowed cursors', async () => {
    const ws = await world();
    const foreign = await world();
    const ids = Array.from({ length: 26 }, () => randomUUID());
    const memberId = randomUUID();
    const fingerprint = digest('history');
    async function seed(workspaceId: string, user: Session, requests: string[]) {
      await pool.query(
        `INSERT INTO notification_batches(workspace_id,request_id,created_by,kind,channel,input,queued,created_at)
        SELECT $1,r,$2,'test','email',jsonb_build_object('requestId',r::text,'revision',0,'confirm',true,'channel','email'),true,clock_timestamp()-interval '3 days' FROM unnest($3::uuid[]) r`,
        [workspaceId, user.userId, requests],
      );
      await pool.query(
        `INSERT INTO notification_events(workspace_id,user_id,kind,occurrence_key,policy_revision,grant_fingerprint,request_id,test_request_id,channel,expires_at)
        SELECT $1,$2,'test','manual:'||r::text,0,$4,r,r,'email',clock_timestamp()+interval '1 hour' FROM unnest($3::uuid[]) r`,
        [workspaceId, user.userId, requests, fingerprint],
      );
    }
    await seed(ws, owner, ids);
    await seed(ws, member, [memberId]);
    await seed(foreign, owner, [randomUUID()]);
    const first = await call('GET', `${nb(ws)}/history`, owner.cookie);
    expect(first.statusCode).toBe(200);
    noStore(first);
    const page = record(first.json());
    expect(Object.keys(page).sort()).toEqual(['items', 'nextCursor', 'workspaceId']);
    expect(array(page.items)).toHaveLength(25);
    const cursor = string(page.nextCursor);
    const second = record(
      (await call('GET', `${nb(ws)}/history?cursor=${cursor}`, owner.cookie)).json(),
    );
    expect(array(second.items)).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const seen = new Set(
      [...array(page.items), ...array(second.items)].map((item) => string(record(item).id)),
    );
    expect(seen.size).toBe(26);
    for (const item of array(page.items))
      expect(Object.keys(record(item)).sort()).toEqual([
        'channel',
        'createdAt',
        'id',
        'kind',
        'pulseId',
        'state',
        'updatedAt',
      ]);
    expect(
      (await call('GET', `${nb(ws)}/history?cursor=${cursor}`, member.cookie)).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `${nb(foreign)}/history?cursor=${cursor}`, owner.cookie)).statusCode,
    ).toBe(404);
    expect((await call('GET', `${nb(ws)}/history?cursor=***`, owner.cookie)).statusCode).toBe(400);
    expect((await call('GET', `${nb(ws)}/history?limit=1`, owner.cookie)).statusCode).toBe(400);
    const own = await call('GET', `${nb(ws)}/history`, member.cookie);
    expect(array(record(own.json()).items)).toHaveLength(1);
    expect(own.payload).not.toContain(owner.userId);
  });

  it('gives owners an aggregate pulse summary, idempotent reminders and replay-safe requests', async () => {
    const ws = await world();
    const { pulseId } = await openedPulse(ws);
    const summary = await call('GET', `${nb(ws)}/pulses/${pulseId}`, owner.cookie);
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toEqual({
      workspaceId: ws,
      pulseId,
      counts: {
        pending: 2,
        leased: 0,
        retry_scheduled: 0,
        provider_accepted: 0,
        skipped: 0,
        failed: 0,
        uncertain: 0,
      },
      remindersEnabled: true,
      revision: 0,
    });
    for (const secret of [member.userId, owner.userId, 'member-http@example.com', 'U01'])
      expect(summary.payload).not.toContain(secret);
    expect((await call('GET', `${nb(ws)}/pulses/${randomUUID()}`, owner.cookie)).statusCode).toBe(
      404,
    );
    expect((await call('GET', `${nb(ws)}/pulses/not-a-uuid`, owner.cookie)).statusCode).toBe(400);

    const bad = [
      reminderBody(0, { confirm: false }),
      reminderBody(0, { userId: member.userId }),
      reminderBody(0, { confirmUncertain: true }),
      { revision: 0, confirm: true },
      { ...reminderBody(0), requestId: 'nope' },
      { ...reminderBody(0), extra: 1 },
    ];
    for (const body of bad)
      expect(
        (await call('POST', `${nb(ws)}/pulses/${pulseId}/remind`, owner.cookie, body)).statusCode,
      ).toBe(400);
    expect(
      (await call('POST', `${nb(ws)}/pulses/${pulseId}/remind`, owner.cookie, reminderBody(9)))
        .statusCode,
    ).toBe(409);
    const request = reminderBody(0);
    const queued = await call('POST', `${nb(ws)}/pulses/${pulseId}/remind`, owner.cookie, request);
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toEqual({ requestId: request.requestId, queued: true });
    const replay = await call('POST', `${nb(ws)}/pulses/${pulseId}/remind`, owner.cookie, request);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ requestId: request.requestId, queued: true });
    expect(
      (
        await call('POST', `${nb(ws)}/pulses/${pulseId}/remind`, owner.cookie, {
          ...request,
          revision: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await call('POST', `${nb(ws)}/pulses/${pulseId}/remind`, owner.cookie, reminderBody(0)))
        .statusCode,
    ).toBe(409);
    const after = record((await call('GET', `${nb(ws)}/pulses/${pulseId}`, owner.cookie)).json());
    expect(record(after.counts).pending).toBe(4);

    expect(
      (
        await call('POST', `${nb(ws)}/pulses/${pulseId}/reminders/disable`, owner.cookie, {
          revision: 7,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('POST', `${nb(ws)}/pulses/${pulseId}/reminders/disable`, owner.cookie, {
          revision: 0,
          force: true,
        })
      ).statusCode,
    ).toBe(400);
    const disabled = await call(
      'POST',
      `${nb(ws)}/pulses/${pulseId}/reminders/disable`,
      owner.cookie,
      { revision: 0 },
    );
    expect(disabled.statusCode).toBe(200);
    expect(record(disabled.json())).toMatchObject({ remindersEnabled: false, revision: 1 });
    expect(record(record(disabled.json()).counts)).toMatchObject({ pending: 2, skipped: 2 });
    expect(
      (await call('POST', `${nb(ws)}/pulses/${pulseId}/remind`, owner.cookie, reminderBody(1)))
        .statusCode,
    ).toBe(409);
  });

  it('retries failed deliveries and only retries uncertain ones with explicit confirmation', async () => {
    const ws = await world();
    const { pulseId } = await openedPulse(ws);
    const url = `${nb(ws)}/pulses/${pulseId}/retry`;
    expect(
      (await call('POST', url, owner.cookie, reminderBody(0, { confirmUncertain: 'yes' })))
        .statusCode,
    ).toBe(400);
    expect((await call('POST', url, owner.cookie, reminderBody(4))).statusCode).toBe(409);
    expect(
      (await call('POST', url, owner.cookie, reminderBody(0, { confirm: false }))).statusCode,
    ).toBe(400);
    const none = await call('POST', url, owner.cookie, reminderBody(0));
    expect(none.statusCode).toBe(202);
    expect(record(none.json()).queued).toBe(false);
    await pool.query(
      "UPDATE notification_events SET state='failed',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),reason='provider_unavailable' WHERE workspace_id=$1 AND user_id=$2",
      [ws, member.userId],
    );
    await pool.query(
      "UPDATE notification_events SET state='uncertain',channel='email',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),reason='acceptance_unknown' WHERE workspace_id=$1 AND user_id=$2",
      [ws, owner.userId],
    );
    const retried = await call('POST', url, owner.cookie, reminderBody(0));
    expect(retried.statusCode).toBe(202);
    expect(record(retried.json()).queued).toBe(true);
    const states = await pool.query(
      'SELECT user_id,state FROM notification_events WHERE workspace_id=$1',
      [ws],
    );
    expect(Object.fromEntries(states.rows.map((row) => [row.user_id, row.state]))).toEqual({
      [member.userId]: 'pending',
      [owner.userId]: 'uncertain',
    });
    const confirmed = await call(
      'POST',
      url,
      owner.cookie,
      reminderBody(0, { confirmUncertain: true }),
    );
    expect(record(confirmed.json()).queued).toBe(true);
    const final = await pool.query(
      'SELECT state FROM notification_events WHERE workspace_id=$1 AND user_id=$2',
      [ws, owner.userId],
    );
    expect(final.rows[0]?.state).toBe('pending');
  });

  it('reads closed pulses directly and keeps pulses inside their workspace', async () => {
    const ws = await world();
    const { pulseId, space } = await openedPulse(ws);
    await space.transition(owner.actor, ws, pulseId, 'close');
    const summary = await call('GET', `${nb(ws)}/pulses/${pulseId}`, owner.cookie);
    expect(summary.statusCode).toBe(200);
    expect(record(summary.json()).pulseId).toBe(pulseId);
    const foreign = await world();
    expect((await call('GET', `${nb(foreign)}/pulses/${pulseId}`, owner.cookie)).statusCode).toBe(
      404,
    );
  });

  it('sends owner tests only to the initiating owner, once per channel per day', async () => {
    const ws = await world();
    const { pulseId } = await openedPulse(ws);
    const revision = await policyRevision(ws);
    const url = `${nb(ws)}/test`;
    for (const extra of [
      { userId: member.userId },
      { recipient: member.userId },
      { email: 'a@b.example' },
      { channel: 'sms' },
      { confirm: false },
    ])
      expect(
        (
          await call('POST', url, owner.cookie, {
            ...reminderBody(revision),
            channel: 'email',
            ...extra,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (await call('POST', url, owner.cookie, { ...reminderBody(revision + 3), channel: 'email' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call('POST', url, member.cookie, { ...reminderBody(revision), channel: 'email' }))
        .statusCode,
    ).toBe(403);
    const request = { ...reminderBody(revision), channel: 'email' };
    const sent = await call('POST', url, owner.cookie, request);
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toEqual({ requestId: request.requestId, queued: true });
    expect((await call('POST', url, owner.cookie, request)).json()).toEqual({
      requestId: request.requestId,
      queued: true,
    });
    expect(
      (await call('POST', url, owner.cookie, { ...reminderBody(revision), channel: 'email' }))
        .statusCode,
    ).toBe(409);
    const stored = await pool.query(
      "SELECT user_id,channel,pulse_id FROM notification_events WHERE workspace_id=$1 AND kind='test'",
      [ws],
    );
    expect(stored.rows).toEqual([{ user_id: owner.userId, channel: 'email', pulse_id: null }]);
    const slack = await call('POST', url, owner.cookie, {
      ...reminderBody(revision),
      channel: 'slack',
    });
    expect(slack.statusCode).toBe(202);
    expect(record(slack.json()).queued).toBe(false);
    const summary = await call('GET', `${nb(ws)}/pulses/${pulseId}`, owner.cookie);
    expect(record(record(summary.json()).counts).pending).toBe(2);
    const own = await call('GET', `${nb(ws)}/history`, owner.cookie);
    expect(array(record(own.json()).items).map((item) => record(item).kind)).toContain('test');
    const others = await call('GET', `${nb(ws)}/history`, member.cookie);
    expect(array(record(others.json()).items).map((item) => record(item).kind)).not.toContain(
      'test',
    );
  });
});

describe('production configuration reader', () => {
  it('re-reads the private operator file per action and never falls back to the startup snapshot', async () => {
    const ws = await world();
    const directory = await mkdtemp(join(tmpdir(), 'clio-notifications-http-'));
    const file = join(directory, 'notifications.json');
    const key = randomBytes(32).toString('base64url');
    const write = async (publicOrigin: string) => {
      await writeFile(
        file,
        JSON.stringify({
          mode: 'live',
          publicOrigin,
          fingerprintKey: key,
          grants: [
            {
              workspaceId: ws,
              smtp: {
                host: 'smtp.example.test',
                port: 465,
                tls: true,
                user: null,
                password: null,
                from: 'clio@example.test',
                credentialRevision: 'r1',
              },
              slack: null,
            },
          ],
        }),
      );
      await chmod(file, 0o600);
    };
    const snapshot = await configNow();
    const production = createServer(
      { ready: async () => {}, close: async () => {} },
      { auth, config, pool, notifications: snapshot },
    );
    const previous = process.env.NOTIFICATIONS_PRIVATE_CONFIG_FILE;
    try {
      process.env.NOTIFICATIONS_PRIVATE_CONFIG_FILE = file;
      await write(appOrigin);
      const read = () =>
        production.inject({
          method: 'GET',
          url: `${nb(ws)}/availability`,
          headers: { cookie: owner.cookie },
        });
      const current = await read();
      expect(current.json()).toEqual({
        workspaceId: ws,
        emailConfigured: true,
        slackConfigured: false,
        linkingConfigured: false,
      });
      await write('https://other.example.test');
      expect((await read()).statusCode).toBe(503);
      await rm(file);
      expect((await read()).statusCode).toBe(503);
      delete process.env.NOTIFICATIONS_PRIVATE_CONFIG_FILE;
      expect((await read()).json()).toEqual({
        workspaceId: ws,
        emailConfigured: false,
        slackConfigured: false,
        linkingConfigured: false,
      });
    } finally {
      if (previous === undefined) delete process.env.NOTIFICATIONS_PRIVATE_CONFIG_FILE;
      else process.env.NOTIFICATIONS_PRIVATE_CONFIG_FILE = previous;
      await production.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

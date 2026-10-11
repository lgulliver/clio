import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrl } from '../src/config.ts';
import { checkReadiness, migrate } from '../src/db/migrations.ts';
import { type ClioAuth, createAuth } from '../src/features/identity/auth.ts';
import { readAuthConfig } from '../src/features/identity/config.ts';
import { createIdentityRepository } from '../src/features/identity/repository.ts';
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
const config = readAuthConfig({
  AUTH_SECRET: 'identity-test-secret-random-fixture-only-123456789',
  AUTH_BASE_URL: 'http://localhost:3000',
  APP_ORIGIN: 'http://localhost:5173',
  GITHUB_CLIENT_ID: 'fixture-client',
  GITHUB_CLIENT_SECRET: 'fixture-secret',
});
if (!config) throw new Error('Test configuration missing');
let auth: ClioAuth;
const repository = createIdentityRepository(pool);
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
function cookieHeader(value: string | string[] | undefined): string {
  return (typeof value === 'string' ? [value] : (value ?? []))
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

// All external fetches fail unless explicitly mocked below. Real OAuth protocol,
// state cookies, adapter, SQL, sessions and authorization run unchanged.
let provider = {
  id: '1001',
  login: 'owner',
  name: 'Owner',
  email: 'owner@example.com',
  avatar_url: 'https://example.com/avatar',
};
let verified = true;
function installProvider() {
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
      if (url === 'https://api.github.com/user') return Response.json(provider);
      if (url === 'https://api.github.com/user/emails')
        return Response.json([
          { email: provider.email, primary: true, verified, visibility: 'private' },
        ]);
      throw new Error('Unexpected external request in identity test');
    }),
  );
}
async function login(id: string, email: string, isVerified = true) {
  provider = { ...provider, id, login: `login-${id}`, name: `Name ${id}`, email };
  verified = isVerified;
  const start = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: { origin: config?.appOrigin ?? '' },
    payload: { provider: 'github', callbackURL: 'http://localhost:5173', disableRedirect: true },
  });
  expect(start.statusCode).toBe(200);
  const url = new URL(string(record(start.json()).url));
  expect(url.origin).toBe('https://github.com');
  expect(url.searchParams.get('redirect_uri')).toBe(
    'http://localhost:3000/api/auth/callback/github',
  );
  expect(new Set(url.searchParams.get('scope')?.split(' '))).toEqual(
    new Set(['read:user', 'user:email']),
  );
  const state = url.searchParams.get('state');
  expect(state).toBeTruthy();
  const callback = await server.inject({
    url: `/api/auth/callback/github?code=fixture-code&state=${encodeURIComponent(state ?? '')}`,
    headers: { cookie: cookieHeader(start.headers['set-cookie']) },
  });
  expect(callback.statusCode).toBe(302);
  expect(new URL(string(callback.headers.location)).origin).toBe('http://localhost:5173');
  const cookie = cookieHeader(callback.headers['set-cookie']);
  const current = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!current) throw new Error(`OAuth did not create session: ${callback.headers.location}`);
  expect(callback.headers['set-cookie']).toEqual(
    expect.arrayContaining([
      expect.stringContaining('HttpOnly'),
      expect.stringContaining('SameSite=Lax'),
    ]),
  );
  return { cookie, userId: current.user.id, sessionId: current.session.id };
}
function headers(cookie: string) {
  return { cookie, origin: config?.appOrigin ?? '' };
}
async function workspace(cookie: string, name = 'Workspace') {
  const response = await server.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: headers(cookie),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return string(record(record(response.json()).workspace).id);
}
async function invite(cookie: string, workspaceId: string, email: string) {
  const response = await server.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/invitations`,
    headers: headers(cookie),
    payload: { email },
  });
  expect(response.statusCode).toBe(201);
  const invitation = record(record(response.json()).invitation);
  return { id: string(invitation.id), token: string(invitation.token) };
}
async function accept(cookie: string, token: string) {
  return server.inject({
    method: 'POST',
    url: '/api/workspace-invitations/accept',
    headers: headers(cookie),
    payload: { token },
  });
}

beforeAll(async () => {
  installProvider();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool);
  auth = createAuth(pool, config);
  const context = await auth.$context;
  await context.checkSchema?.();
  server = createServer(
    {
      ready: async () =>
        checkReadiness(
          pool,
          await import('../src/db/migrations.ts').then((m) => m.loadMigrations()),
        ),
      close: async () => {},
    },
    { auth, config, pool },
  );
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

describe('real identity/session/workspace boundary', () => {
  it('defaults login redirect to app origin and renews actual session cookies on protected requests', async () => {
    provider = { ...provider, id: '0901', email: 'renewal@example.com' };
    verified = true;
    const start = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: headers(''),
      payload: { provider: 'github', disableRedirect: true },
    });
    expect(start.statusCode).toBe(200);
    const state = new URL(string(record(start.json()).url)).searchParams.get('state');
    const callback = await server.inject({
      url: `/api/auth/callback/github?code=fixture&state=${state}`,
      headers: { cookie: cookieHeader(start.headers['set-cookie']) },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(config.appOrigin);
    const cookie = cookieHeader(callback.headers['set-cookie']);
    const current = await auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!current) throw new Error('Session absent');
    await pool.query(
      "UPDATE auth_sessions SET expires_at = now() + interval '1 day' WHERE id = $1",
      [current.session.id],
    );
    const me = await server.inject({ url: '/api/me', headers: headers(cookie) });
    expect(me.statusCode).toBe(200);
    expect(me.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('HttpOnly'),
        expect.stringContaining('Max-Age=604800'),
      ]),
    );
    const expiry = await pool.query<{ renewed: boolean }>(
      "SELECT expires_at > now() + interval '6 days' AS renewed FROM auth_sessions WHERE id = $1",
      [current.session.id],
    );
    expect(expiry.rows[0]?.renewed).toBe(true);
    const renewedCookie = cookieHeader(me.headers['set-cookie']);
    expect(
      (await server.inject({ url: '/api/workspaces', headers: headers(renewedCookie) })).statusCode,
    ).toBe(200);
  });

  it('fails closed on provider profile email collision without merging stable identities', async () => {
    const logging = vi.spyOn(console, 'error');
    try {
      const first = await login('0951', 'first-collision@example.com');
      const id = await workspace(first.cookie);
      const second = await login('0952', 'second-collision@example.com');
      provider = { ...provider, id: '0951', email: 'second-collision@example.com' };
      const start = await server.inject({
        method: 'POST',
        url: '/api/auth/sign-in/social',
        headers: headers(''),
        payload: { provider: 'github', disableRedirect: true },
      });
      const state = new URL(string(record(start.json()).url)).searchParams.get('state');
      const callback = await server.inject({
        url: `/api/auth/callback/github?code=fixture&state=${state}`,
        headers: { cookie: cookieHeader(start.headers['set-cookie']) },
      });
      expect(callback.statusCode).toBe(303);
      expect(callback.headers.location).toBe('http://localhost:5173/settings?authError=1');
      expect(callback.body).not.toContain('email');
      expect(logging).not.toHaveBeenCalled();
      const accounts = await pool.query(
        'SELECT account_id, user_id FROM auth_accounts WHERE account_id IN ($1, $2) ORDER BY account_id',
        ['0951', '0952'],
      );
      expect(accounts.rows).toEqual([
        { account_id: '0951', user_id: first.userId },
        { account_id: '0952', user_id: second.userId },
      ]);
      expect(
        (await repository.listWorkspaces({ userId: first.userId, sessionId: first.sessionId })).map(
          (w) => w.id,
        ),
      ).toEqual([id]);
      expect(
        await repository.listWorkspaces({ userId: second.userId, sessionId: second.sessionId }),
      ).toEqual([]);
    } finally {
      logging.mockRestore();
    }
  });

  it('runs GitHub OAuth with state binding, discards tokens on creation and update, preserves stable user membership', async () => {
    const owner = await login('1001', 'owner@example.com');
    const id = await workspace(owner.cookie);
    const account = await pool.query(
      'SELECT provider_id, account_id, user_id, access_token, refresh_token, id_token FROM auth_accounts WHERE user_id = $1',
      [owner.userId],
    );
    expect(account.rows).toEqual([
      {
        provider_id: 'github',
        account_id: '1001',
        user_id: owner.userId,
        access_token: null,
        refresh_token: null,
        id_token: null,
      },
    ]);
    const again = await login('1001', 'renamed-owner@example.com');
    expect(again.userId).toBe(owner.userId);
    const lists = await server.inject({ url: '/api/workspaces', headers: headers(again.cookie) });
    expect(lists.json()).toEqual({ workspaces: [{ id, name: 'Workspace', role: 'owner' }] });
    const unchanged = await pool.query(
      'SELECT access_token, refresh_token, id_token FROM auth_accounts WHERE user_id = $1',
      [owner.userId],
    );
    expect(unchanged.rows).toEqual([{ access_token: null, refresh_token: null, id_token: null }]);
    const me = await server.inject({ url: '/api/me', headers: headers(again.cookie) });
    expect(string(record(record(me.json()).user).id)).toBe(owner.userId);
    expect(record(record(me.json()).user).email).toBe('renamed-owner@example.com');
    expect(me.body).not.toContain('token');
    for (const endpoint of [
      'get-session',
      'get-access-token',
      'refresh-token',
      'list-accounts',
      'list-sessions',
    ]) {
      expect(
        (await server.inject({ url: `/api/auth/${endpoint}`, headers: headers(again.cookie) }))
          .statusCode,
      ).toBe(404);
    }
    const collide = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: headers(again.cookie),
      payload: { provider: 'github', scopes: ['repo'] },
    });
    expect(collide.statusCode).toBe(400);
  });

  it('requires state cookie, rejects invalid state/redirect/origin and prevents email account linking', async () => {
    const start = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: headers(''),
      payload: { provider: 'github', callbackURL: 'https://evil.example' },
    });
    expect(start.statusCode).toBe(403);
    const flow = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: headers(''),
      payload: { provider: 'github', callbackURL: 'http://localhost:5173', disableRedirect: true },
    });
    const state = new URL(string(record(flow.json()).url)).searchParams.get('state');
    for (const [cookie, suppliedState] of [
      ['', state],
      [cookieHeader(flow.headers['set-cookie']), 'invalid-state'],
    ]) {
      const rejected = await server.inject({
        url: `/api/auth/callback/github?code=fixture&state=${suppliedState}`,
        headers: { cookie: cookie ?? '' },
      });
      expect(rejected.statusCode).toBe(302);
      expect(rejected.headers.location).toContain('error=');
      expect(
        await auth.api.getSession({
          headers: new Headers({ cookie: cookieHeader(rejected.headers['set-cookie']) }),
        }),
      ).toBeNull();
    }
    const existing = await login('1100', 'collision@example.com');
    provider = { ...provider, id: '1101', email: 'collision@example.com' };
    const collisionStart = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: headers(''),
      payload: { provider: 'github', callbackURL: 'http://localhost:5173', disableRedirect: true },
    });
    const collisionState = new URL(string(record(collisionStart.json()).url)).searchParams.get(
      'state',
    );
    const collision = await server.inject({
      url: `/api/auth/callback/github?code=fixture&state=${collisionState}`,
      headers: { cookie: cookieHeader(collisionStart.headers['set-cookie']) },
    });
    expect(collision.statusCode).toBe(302);
    expect(collision.headers.location).toContain('error=');
    const account = await pool.query('SELECT account_id FROM auth_accounts WHERE user_id = $1', [
      existing.userId,
    ]);
    expect(account.rows).toEqual([{ account_id: '1100' }]);
  });

  it('isolates workspaces; owners write, members read; revocation affects next request', async () => {
    const owner = await login('2001', 'workspace-owner@example.com');
    const member = await login('2002', 'member@example.com');
    const outsider = await login('2003', 'outsider@example.com');
    const id = await workspace(owner.cookie, 'Scoped');
    const other = await workspace(outsider.cookie, 'Other');
    const service = await server.inject({
      method: 'POST',
      url: `/api/workspaces/${id}/services`,
      headers: headers(owner.cookie),
      payload: { name: 'Delivery' },
    });
    expect(service.statusCode).toBe(201);
    const invitation = await invite(owner.cookie, id, 'MEMBER@example.com');
    const pendingInvite = await invite(owner.cookie, id, 'member@example.com');
    expect((await accept(member.cookie, invitation.token)).statusCode).toBe(200);
    const visible = await server.inject({
      url: `/api/workspaces/${id}/services`,
      headers: headers(member.cookie),
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toEqual({ services: [record(service.json()).service] });
    for (const [cookie, workspaceId, status] of [
      [outsider.cookie, id, 404],
      [member.cookie, other, 404],
      [member.cookie, id, 403],
    ] as const) {
      expect(
        (
          await server.inject({
            method: 'POST',
            url: `/api/workspaces/${workspaceId}/services`,
            headers: headers(cookie),
            payload: { name: 'Forbidden' },
          })
        ).statusCode,
      ).toBe(status);
    }
    expect(
      (
        await server.inject({
          url: `/api/workspaces/${id}/services`,
          headers: headers(outsider.cookie),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `/api/workspaces/${id}/invitations`,
          headers: headers(member.cookie),
          payload: { email: 'new@example.com' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: `/api/workspaces/${id}/members/${owner.userId}`,
          headers: headers(owner.cookie),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: `/api/workspaces/${id}/members/${member.userId}`,
          headers: headers(owner.cookie),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await server.inject({
          url: `/api/workspaces/${id}/services`,
          headers: headers(member.cookie),
        })
      ).statusCode,
    ).toBe(404);
    expect((await accept(member.cookie, pendingInvite.token)).statusCode).toBe(404);
    const before = await pool.query('SELECT count(*)::int AS count FROM workspaces');
    for (const payload of [
      { name: 'Spoof', owner: outsider.userId },
      { name: 'Spoof', role: 'owner' },
      { name: '' },
    ])
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/api/workspaces',
            headers: headers(owner.cookie),
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect((await pool.query('SELECT count(*)::int AS count FROM workspaces')).rows).toEqual(
      before.rows,
    );
  });

  it('rolls back workspace bootstrap when membership insert fails', async () => {
    const user = await login('2501', 'rollback@example.com');
    const before = await pool.query('SELECT count(*)::int AS count FROM workspaces');
    // Fault injection only in this disposable schema, removed even if assertion fails.
    await pool.query(
      `ALTER TABLE workspace_memberships ADD CONSTRAINT test_reject_bootstrap CHECK (user_id <> '${user.userId.replaceAll("'", "''")}')`,
    );
    try {
      const result = await server.inject({
        method: 'POST',
        url: '/api/workspaces',
        headers: headers(user.cookie),
        payload: { name: 'Must roll back' },
      });
      expect(result.statusCode).toBe(503);
      expect((await pool.query('SELECT count(*)::int AS count FROM workspaces')).rows).toEqual(
        before.rows,
      );
    } finally {
      await pool.query('ALTER TABLE workspace_memberships DROP CONSTRAINT test_reject_bootstrap');
    }
  });

  it('checks membership under transaction lock after concurrent revocation', async () => {
    const user = await login('2601', 'transaction@example.com');
    const id = await workspace(user.cookie);
    const client = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [id]);
      await client.query(
        'DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [id, user.userId],
      );
      pending = repository.createService(
        { userId: user.userId, sessionId: user.sessionId },
        id,
        'Revoked writer',
      );
      // Attach rejection observer before commit to avoid an unhandled rejected promise.
      const denied = expect(pending).rejects.toMatchObject({ status: 404 });
      await client.query('COMMIT');
      await denied;
      expect(
        (await pool.query('SELECT id FROM services WHERE workspace_id = $1', [id])).rowCount,
      ).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('consumes hashed invitations once; rejects wrong/unverified/expired/cancelled invitations and scope cancellation', async () => {
    const owner = await login('3001', 'invite-owner@example.com');
    const user = await login('3002', 'invited@example.com');
    const wrong = await login('3003', 'wrong@example.com');
    const unverified = await login('3004', 'unverified@example.com', false);
    const id = await workspace(owner.cookie);
    const first = await invite(owner.cookie, id, 'invited@example.com');
    const stored = await pool.query(
      'SELECT token_hash, expires_at - created_at AS lifetime FROM workspace_invitations WHERE id = $1',
      [first.id],
    );
    expect(stored.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.token_hash).not.toBe(first.token);
    expect(stored.rows[0]?.lifetime).toMatchObject({ days: 7 });
    expect((await accept(wrong.cookie, first.token)).statusCode).toBe(404);
    const simultaneous = await Promise.all([
      accept(user.cookie, first.token),
      accept(user.cookie, first.token),
    ]);
    expect(simultaneous.map((r) => r.statusCode).sort()).toEqual([200, 404]);
    const unverifiedInvite = await invite(owner.cookie, id, 'unverified@example.com');
    expect((await accept(unverified.cookie, unverifiedInvite.token)).statusCode).toBe(404);
    const expired = await invite(owner.cookie, id, 'invited@example.com');
    await pool.query(
      "UPDATE workspace_invitations SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1",
      [expired.id],
    );
    expect((await accept(user.cookie, expired.token)).statusCode).toBe(404);
    const cancelled = await invite(owner.cookie, id, 'invited@example.com');
    const other = await workspace(owner.cookie, 'Different scope');
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: `/api/workspaces/${other}/invitations/${cancelled.id}`,
          headers: headers(owner.cookie),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: `/api/workspaces/${id}/invitations/${cancelled.id}`,
          headers: headers(owner.cookie),
        })
      ).statusCode,
    ).toBe(204);
    expect((await accept(user.cookie, cancelled.token)).statusCode).toBe(404);
    expect((await accept(user.cookie, 'malformed')).statusCode).toBe(400);
  });

  it('reads real DB session expiry/revocation and logout; blocks detached writes after session revocation', async () => {
    expect((await server.inject('/api/me')).statusCode).toBe(401);
    const user = await login('4001', 'session@example.com');
    const id = await workspace(user.cookie);
    await pool.query(
      "UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [user.sessionId],
    );
    expect(
      (await server.inject({ url: '/api/me', headers: headers(user.cookie) })).statusCode,
    ).toBe(401);
    const renewed = await login('4001', 'session@example.com');
    await pool.query('DELETE FROM auth_sessions WHERE id = $1', [renewed.sessionId]);
    expect(
      (await server.inject({ url: '/api/workspaces', headers: headers(renewed.cookie) }))
        .statusCode,
    ).toBe(401);
    await expect(
      repository.createService(
        { userId: renewed.userId, sessionId: renewed.sessionId },
        id,
        'Detached',
      ),
    ).rejects.toMatchObject({ status: 401 });
    const logout = await login('4001', 'session@example.com');
    const result = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: headers(logout.cookie),
      payload: {},
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('Max-Age=0')]),
    );
    expect(
      (await server.inject({ url: '/api/me', headers: headers(logout.cookie) })).statusCode,
    ).toBe(401);
    expect(
      (await pool.query('SELECT id FROM auth_sessions WHERE id = $1', [logout.sessionId])).rowCount,
    ).toBe(0);
  });
});

it('lists safe owner-only access, filters invitations, scopes writes and preserves immediate revocation', async () => {
  const owner = await login('8001', 'access-owner@example.com');
  const member = await login('8002', 'access-member@example.com');
  const outsider = await login('8003', 'access-outsider@example.com');
  const id = await workspace(owner.cookie, 'Access');
  const other = await workspace(outsider.cookie, 'Other access');
  const consumed = await invite(owner.cookie, id, 'access-member@example.com');
  expect((await accept(member.cookie, consumed.token)).statusCode).toBe(200);
  const cancelled = await invite(owner.cookie, id, 'cancelled-access@example.com');
  await repository.cancelInvitation(owner, id, cancelled.id);
  const expired = await invite(owner.cookie, id, 'expired-access@example.com');
  await pool.query(
    "UPDATE workspace_invitations SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1",
    [expired.id],
  );
  const pending = await invite(owner.cookie, id, 'pending-access@example.com');
  const cross = await invite(outsider.cookie, other, 'cross-access@example.com');
  for (const suffix of ['members', 'invitations']) {
    for (const [cookie, workspaceId, status] of [
      [member.cookie, id, 403],
      [outsider.cookie, id, 404],
      [owner.cookie, other, 404],
      [owner.cookie, randomUUID(), 404],
    ] as const) {
      expect(
        (
          await server.inject({
            url: `/api/workspaces/${workspaceId}/${suffix}`,
            headers: headers(cookie),
          })
        ).statusCode,
      ).toBe(status);
    }
  }
  const members = await server.inject({
    url: `/api/workspaces/${id}/members`,
    headers: headers(owner.cookie),
  });
  expect(members.statusCode).toBe(200);
  expect(members.headers['cache-control']).toBe('no-store');
  expect(record(members.json()).members).toEqual(
    expect.arrayContaining([
      {
        userId: member.userId,
        name: 'Name 8002',
        email: 'access-member@example.com',
        role: 'member',
        createdAt: expect.any(String),
      },
    ]),
  );
  const invitations = await server.inject({
    url: `/api/workspaces/${id}/invitations`,
    headers: headers(owner.cookie),
  });
  expect(invitations.json()).toEqual({
    workspaceId: id,
    invitations: [
      {
        id: pending.id,
        email: 'pending-access@example.com',
        status: 'pending',
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      },
    ],
    hasMore: false,
  });
  for (const response of [members, invitations]) {
    for (const privateField of ['token', 'hash', 'session', 'account', 'created_by'])
      expect(response.body).not.toContain(privateField);
  }
  for (const path of [`members/${member.userId}`, `invitations/${pending.id}`]) {
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: `/api/workspaces/${id}/${path}`,
          headers: headers(member.cookie),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: `/api/workspaces/${id}/${path}`,
          headers: { cookie: owner.cookie, origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
  }
  expect(
    (
      await server.inject({
        method: 'DELETE',
        url: `/api/workspaces/${id}/invitations/${cross.id}`,
        headers: headers(owner.cookie),
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await server.inject({
        method: 'DELETE',
        url: `/api/workspaces/${id}/members/${owner.userId}`,
        headers: headers(owner.cookie),
      })
    ).statusCode,
  ).toBe(409);
  await pool.query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [id, outsider.userId],
  );
  expect(
    (
      await server.inject({
        method: 'DELETE',
        url: `/api/workspaces/${id}/members/${outsider.userId}`,
        headers: headers(owner.cookie),
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await server.inject({
        method: 'DELETE',
        url: `/api/workspaces/${id}/invitations/${pending.id}`,
        headers: headers(owner.cookie),
      })
    ).statusCode,
  ).toBe(204);
  expect((await repository.listInvitations(owner, id)).invitations).toEqual([]);
  expect(
    (
      await server.inject({
        method: 'DELETE',
        url: `/api/workspaces/${id}/members/${member.userId}`,
        headers: headers(owner.cookie),
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (
      await server.inject({
        url: `/api/workspaces/${id}/services`,
        headers: headers(member.cookie),
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await repository.listMembers(owner, id)).members.some((row) => row.userId === member.userId),
  ).toBe(false);
  await pool.query('DELETE FROM auth_sessions WHERE id = $1', [owner.sessionId]);
  await expect(repository.listMembers(owner, id)).rejects.toMatchObject({ status: 401 });
  await expect(repository.listInvitations(owner, id)).rejects.toMatchObject({ status: 401 });
});

it('bounds member and invitation reads and reports overflow honestly', async () => {
  const owner = await login('8101', 'bounded-access@example.com');
  const id = await workspace(owner.cookie, 'Bounded access');
  for (let index = 0; index < 101; index += 1) {
    const userId = `bounded-${id}-${index}`;
    await pool.query(
      'INSERT INTO auth_users (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
      [userId, `Fixture ${index}`, `${userId}@example.com`],
    );
    await pool.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [id, userId],
    );
    await repository.invite(owner, id, `invite-${index}@example.com`);
  }
  const members = await repository.listMembers(owner, id);
  const invitations = await repository.listInvitations(owner, id);
  expect(members.members).toHaveLength(100);
  expect(members.hasMore).toBe(true);
  expect(invitations.invitations).toHaveLength(100);
  expect(invitations.hasMore).toBe(true);
});

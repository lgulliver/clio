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
    ).toBe(200);
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
  for (const unavailable of [consumed, cancelled, expired]) {
    await expect(repository.listInvitations(owner, id, unavailable.id)).rejects.toMatchObject({
      status: 404,
    });
  }
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
            url: `/api/workspaces/${workspaceId}/${suffix}?cursor=${encodeURIComponent(suffix === 'members' ? member.userId : pending.id)}`,
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
    nextCursor: null,
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
  ).toBe(200);
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

it('traverses bounded access pages with immutable ordering and scoped cursor validation', async () => {
  const owner = await login('8101', 'bounded-access@example.com');
  const id = await workspace(owner.cookie, 'Bounded access');
  for (let index = 0; index < 205; index += 1) {
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
  const memberIds = members.members.map((row) => row.userId);
  let memberPage = members;
  while (memberPage.nextCursor !== null) {
    memberPage = await repository.listMembers(owner, id, memberPage.nextCursor);
    expect(memberPage.members.length).toBeLessThanOrEqual(100);
    memberIds.push(...memberPage.members.map((row) => row.userId));
  }
  const expectedMembers = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 ORDER BY user_id',
    [id],
  );
  expect(memberIds).toEqual(expectedMembers.rows.map((row) => row.user_id));
  expect(new Set(memberIds).size).toBe(206);
  const invitationIds = invitations.invitations.map((row) => row.id);
  let invitationPage = invitations;
  while (invitationPage.nextCursor !== null) {
    invitationPage = await repository.listInvitations(owner, id, invitationPage.nextCursor);
    expect(invitationPage.invitations.length).toBeLessThanOrEqual(100);
    invitationIds.push(...invitationPage.invitations.map((row) => row.id));
  }
  const expectedInvitations = await pool.query<{ id: string }>(
    'SELECT id FROM workspace_invitations WHERE workspace_id = $1 ORDER BY id',
    [id],
  );
  expect(invitationIds).toEqual(expectedInvitations.rows.map((row) => row.id));
  expect(new Set(invitationIds).size).toBe(205);
  const outsider = await login('8102', 'cursor-outsider@example.com');
  const other = await workspace(outsider.cookie, 'Cursor isolation');
  const foreign = await repository.invite(outsider, other, 'foreign-cursor@example.com');
  for (const [kind, cursor] of [
    ['members', members.nextCursor],
    ['invitations', invitations.nextCursor],
  ]) {
    expect(cursor).not.toBeNull();
    const path = `/api/workspaces/${id}/${kind}`;
    for (const query of [
      '?unknown=x',
      '?cursor=',
      '?cursor=x&cursor=y',
      '?cursor=%00',
      `?cursor=${'x'.repeat(513)}`,
    ]) {
      expect(
        (await server.inject({ url: path + query, headers: { cookie: owner.cookie } })).statusCode,
      ).toBe(400);
    }
    const success = await server.inject({
      url: `${path}?cursor=${encodeURIComponent(String(cursor))}`,
      headers: { cookie: owner.cookie },
    });
    expect(success.statusCode).toBe(200);
    for (const field of ['token', 'tokenHash', 'token_hash', 'sessionId'])
      expect(success.body).not.toContain(field);
    expect(
      (
        await server.inject({
          url: `${path}?cursor=${encodeURIComponent(String(cursor))}`,
          headers: { cookie: outsider.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await server.inject({ url: `${path}?cursor=${encodeURIComponent(String(cursor))}` }))
        .statusCode,
    ).toBe(401);
  }
  await expect(repository.listMembers(owner, id, outsider.userId)).rejects.toMatchObject({
    status: 404,
  });
  await expect(repository.listMembers(owner, id, 'unknown-cursor')).rejects.toMatchObject({
    status: 404,
  });
  await expect(repository.listInvitations(owner, id, foreign.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(repository.listInvitations(owner, id, randomUUID())).rejects.toMatchObject({
    status: 404,
  });
  await expect(repository.listInvitations(owner, id, 'not-uuid')).rejects.toMatchObject({
    status: 400,
  });
  const targetId = memberIds.find((userId) => userId !== owner.userId);
  expect(targetId).toBeDefined();
  await repository.revokeMember(owner, id, targetId);
  expect(
    (await repository.listMembers(owner, id)).members.some((row) => row.userId === targetId),
  ).toBe(false);
  if (invitations.nextCursor === null) throw new Error('Expected overflow cursor');
  await repository.cancelInvitation(owner, id, invitations.nextCursor);
  await expect(repository.listInvitations(owner, id, invitations.nextCursor)).rejects.toMatchObject(
    { status: 404 },
  );
  await pool.query('DELETE FROM auth_sessions WHERE id = $1', [owner.sessionId]);
  await expect(repository.listMembers(owner, id, members.nextCursor)).rejects.toMatchObject({
    status: 401,
  });
  await expect(repository.listInvitations(owner, id, invitationIds[0])).rejects.toMatchObject({
    status: 401,
  });
});

it('returns bounded exact current-email cancellations, scopes status and preserves other grants', async () => {
  const owner = await login('7101', 'lineage-owner@example.com');
  const member = await login('7102', 'lineage-old@example.com');
  const other = await login('7103', 'lineage-other@example.com');
  const id = await workspace(owner.cookie);
  const foreign = await workspace(owner.cookie);
  await accept(member.cookie, (await invite(owner.cookie, id, 'lineage-old@example.com')).token);
  const old = await invite(owner.cookie, id, 'lineage-old@example.com');
  const current = await invite(owner.cookie, id, 'lineage-new@example.com');
  const cross = await invite(owner.cookie, foreign, 'lineage-new@example.com');
  expect((await repository.invitationStatus(owner, id, current.id)).pending).toBe(true);
  await expect(repository.invitationStatus(member, id, current.id)).rejects.toMatchObject({
    status: 403,
  });
  await pool.query('UPDATE auth_users SET email = $1 WHERE id = $2', [
    'lineage-new@example.com',
    member.userId,
  ]);
  const response = await server.inject({
    method: 'DELETE',
    url: `/api/workspaces/${id}/members/${member.userId}`,
    headers: headers(owner.cookie),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ cancelledInvitationIds: [current.id], hasMore: false });
  const status = (cookie: string, workspaceId: string, invitationId: string) =>
    server.inject({
      url: `/api/workspaces/${workspaceId}/invitations/${invitationId}/status`,
      headers: headers(cookie),
    });
  expect((await status(owner.cookie, id, current.id)).json()).toEqual({ pending: false });
  expect((await status(owner.cookie, id, old.id)).json()).toEqual({ pending: true });
  expect((await status(owner.cookie, foreign, cross.id)).json()).toEqual({ pending: true });
  expect((await status(owner.cookie, id, cross.id)).json()).toEqual({ pending: false });
  expect((await status(member.cookie, id, old.id)).statusCode).toBe(404);
  expect((await status(other.cookie, id, old.id)).statusCode).toBe(404);
  const fresh = await invite(owner.cookie, id, 'lineage-new@example.com');
  expect((await status(owner.cookie, id, fresh.id)).json()).toEqual({ pending: true });
  expect((await accept(member.cookie, fresh.token)).statusCode).toBe(200);
  expect((await status(owner.cookie, id, fresh.id)).json()).toEqual({ pending: false });
  for (let i = 0; i < 105; i++) await invite(owner.cookie, id, 'lineage-new@example.com');
  const bounded = await repository.revokeMember(owner, id, member.userId);
  expect(bounded.cancelledInvitationIds).toHaveLength(100);
  expect(bounded.hasMore).toBe(true);
  expect(new Set(bounded.cancelledInvitationIds).size).toBe(100);
  expect(
    (await repository.listInvitations(owner, id)).invitations.map((entry) => entry.id),
  ).toEqual([old.id]);
  await pool.query('DELETE FROM auth_sessions WHERE id = $1', [owner.sessionId]);
  expect((await status(owner.cookie, id, old.id)).statusCode).toBe(401);
});

it('registers measurement history under current authenticated workspace access and owner write Origin checks', async () => {
  const owner = await login('8301', 'measurement-route-owner@example.com');
  const member = await login('8302', 'measurement-route-member@example.com');
  const outsider = await login('8303', 'measurement-route-outsider@example.com');
  const wid = await workspace(owner.cookie, 'Measurement route boundaries');
  const service = await repository.createService(owner, wid, 'Measured service');
  const invitation = await invite(owner.cookie, wid, 'measurement-route-member@example.com');
  expect((await accept(member.cookie, invitation.token)).statusCode).toBe(200);
  const base = `/api/workspaces/${wid}/services/${service.id}`;
  for (const actor of [owner, member]) {
    const response = await server.inject({
      url: `${base}/measurement-runs?status=succeeded`,
      headers: { cookie: actor.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runs: [], nextCursor: null });
    expect(response.headers['cache-control']).toBe('no-store');
  }
  expect((await server.inject(`${base}/measurement-runs`)).statusCode).toBe(401);
  expect(
    (await server.inject({ url: `${base}/measurement-runs`, headers: { cookie: outsider.cookie } }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await server.inject({
        url: `${base}/measurement-runs?status=failed`,
        headers: { cookie: owner.cookie },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await server.inject({
        url: `${base}/measurement-authorities?provider=github&basisRunId=${randomUUID()}`,
        headers: { cookie: member.cookie },
      })
    ).statusCode,
  ).toBe(403);
  const payload = {
    requestId: randomUUID(),
    provider: 'github',
    basisRunId: randomUUID(),
    producerIds: [],
  };
  expect(
    (
      await server.inject({
        method: 'POST',
        url: `${base}/measurement-runs`,
        headers: { cookie: owner.cookie },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'POST',
        url: `${base}/measurement-runs`,
        headers: headers(member.cookie),
        payload,
      })
    ).statusCode,
  ).toBe(403);
  await pool.query('DELETE FROM auth_sessions WHERE id=$1', [member.sessionId]);
  expect(
    (await server.inject({ url: `${base}/measurement-runs`, headers: { cookie: member.cookie } }))
      .statusCode,
  ).toBe(401);
});

describe('workspace organization', () => {
  it('persists team/product hierarchy and assignments while enforcing current scope and owner policy', async () => {
    const owner = await login('organization-owner', 'organization-owner@example.com');
    const member = await login('organization-member', 'organization-member@example.com');
    const outsider = await login('organization-outsider', 'organization-outsider@example.com');
    const id = await workspace(owner.cookie, 'Engineering');
    const other = await workspace(outsider.cookie, 'Other Engineering');
    const base = `/api/workspaces/${id}`;
    await accept(
      member.cookie,
      (await invite(owner.cookie, id, 'organization-member@example.com')).token,
    );
    const write = (path: string, payload: Record<string, unknown>, cookie = owner.cookie) =>
      server.inject({ method: 'POST', url: `${base}${path}`, headers: headers(cookie), payload });
    const serviceResponse = await write('/services', { name: 'API' });
    const service = record(record(serviceResponse.json()).service);
    const serviceId = string(service.id);
    const initial = await server.inject({
      url: `${base}/organization`,
      headers: headers(member.cookie),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      workspaceId: id,
      teams: [],
      products: [],
      services: [service],
      assignments: [{ serviceId, productId: null }],
    });
    const createdTeam = await write('/teams', { name: '  Platform  ' });
    expect(createdTeam.statusCode).toBe(201);
    const team = record(record(createdTeam.json()).team);
    expect(team.name).toBe('Platform');
    expect((await write('/teams', { name: '\tPlatform\n' })).statusCode).toBe(409);
    const teamId = string(team.id);
    const createdProduct = await write('/products', { name: 'Delivery', teamId });
    expect(createdProduct.statusCode).toBe(201);
    const product = record(record(createdProduct.json()).product);
    const productId = string(product.id);
    const secondProduct = await write('/products', { name: 'Insights', teamId });
    expect(secondProduct.statusCode).toBe(201);
    expect((await write('/products', { name: ' Delivery ', teamId })).statusCode).toBe(409);
    const otherTeamResponse = await server.inject({
      method: 'POST',
      url: `/api/workspaces/${other}/teams`,
      headers: headers(outsider.cookie),
      payload: { name: 'Platform' },
    });
    const otherTeam = string(record(record(otherTeamResponse.json()).team).id);
    const otherProductResponse = await server.inject({
      method: 'POST',
      url: `/api/workspaces/${other}/products`,
      headers: headers(outsider.cookie),
      payload: { name: 'Delivery', teamId: otherTeam },
    });
    const otherProduct = string(record(record(otherProductResponse.json()).product).id);
    expect((await write('/products', { name: 'Intrusion', teamId: otherTeam })).statusCode).toBe(
      404,
    );
    expect(
      (await write(`/services/${serviceId}/product`, { productId: otherProduct })).statusCode,
    ).toBe(404);
    expect((await write(`/services/${randomUUID()}/product`, { productId })).statusCode).toBe(404);
    expect((await write('/products', { name: 'Missing', teamId: randomUUID() })).statusCode).toBe(
      404,
    );
    for (const [path, payload] of [
      ['/teams', { name: 'Member team' }],
      ['/products', { name: 'Member product', teamId }],
      [`/services/${serviceId}/product`, { productId }],
    ] as const)
      expect((await write(path, payload, member.cookie)).statusCode).toBe(403);
    for (const [path, payload] of [
      ['/teams', { name: '' }],
      ['/teams', { name: 'Good', extra: true }],
      ['/products', { name: 'No team' }],
      ['/products', { name: 'Good', teamId: 'bad' }],
      [`/services/${serviceId}/product`, {}],
      [`/services/${serviceId}/product`, { productId: 'bad' }],
      [`/services/${serviceId}/product`, { productId, role: 'owner' }],
    ] as const)
      expect((await write(path, payload)).statusCode).toBe(400);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `${base}/teams`,
          headers: { cookie: owner.cookie, origin: 'https://untrusted.example' },
          payload: { name: 'Bad origin' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await server.inject({ url: `${base}/organization`, headers: headers(outsider.cookie) }))
        .statusCode,
    ).toBe(404);
    expect((await server.inject(`${base}/organization`)).statusCode).toBe(401);
    expect(
      (await server.inject({ url: `${base}/organization?extra=1`, headers: headers(owner.cookie) }))
        .statusCode,
    ).toBe(400);
    await expect(
      pool.query('INSERT INTO products (id,workspace_id,team_id,name) VALUES ($1,$2,$3,$4)', [
        randomUUID(),
        id,
        otherTeam,
        'Cross team',
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      pool.query('UPDATE services SET product_id=$1 WHERE id=$2', [otherProduct, serviceId]),
    ).rejects.toMatchObject({ code: '23503' });
    const assigned = await write(`/services/${serviceId}/product`, { productId });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toEqual({ assignment: { serviceId, productId } });
    expect(
      (await server.inject({ url: `${base}/services`, headers: headers(owner.cookie) })).json(),
    ).toEqual({ services: [service] });
    const organization = await server.inject({
      url: `${base}/organization`,
      headers: headers(member.cookie),
    });
    expect(organization.headers['cache-control']).toBe('no-store');
    expect(organization.json()).toEqual({
      workspaceId: id,
      teams: [team],
      products: [product, record(record(secondProduct.json()).product)],
      services: [service],
      assignments: [{ serviceId, productId }],
    });
    const reassignedId = string(record(record(secondProduct.json()).product).id);
    expect(
      (await write(`/services/${serviceId}/product`, { productId: reassignedId })).json(),
    ).toEqual({ assignment: { serviceId, productId: reassignedId } });
    expect((await write(`/services/${serviceId}/product`, { productId: null })).json()).toEqual({
      assignment: { serviceId, productId: null },
    });
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
      id,
      member.userId,
    ]);
    expect(
      (await server.inject({ url: `${base}/organization`, headers: headers(member.cookie) }))
        .statusCode,
    ).toBe(404);
    await pool.query('DELETE FROM auth_sessions WHERE id=$1', [owner.sessionId]);
    expect((await write('/teams', { name: 'Revoked' })).statusCode).toBe(401);
  });
});

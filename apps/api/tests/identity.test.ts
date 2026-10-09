import { describe, expect, it } from 'vitest';
import { readAuthConfig } from '../src/features/identity/config.ts';
import { createServer } from '../src/server.ts';

const configured = {
  AUTH_SECRET: 'test-secret-only-not-for-deployment-123456789',
  AUTH_BASE_URL: 'http://localhost:3000',
  APP_ORIGIN: 'http://localhost:5173',
  GITHUB_CLIENT_ID: 'test-client',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
};

describe('identity configuration', () => {
  it('allows absent auth while rejecting partial and invalid settings', () => {
    expect(readAuthConfig({})).toBeNull();
    expect(() => readAuthConfig({ AUTH_SECRET: configured.AUTH_SECRET })).toThrow();
    expect(readAuthConfig(configured)?.appOrigin).toBe('http://localhost:5173');
    for (const invalid of [
      { AUTH_SECRET: 'short' },
      { AUTH_BASE_URL: 'http://user:secret@localhost:3000' },
      { APP_ORIGIN: 'http://localhost:5173/path' },
      { APP_ORIGIN: 'https://*.example.com' },
      { NODE_ENV: 'production' },
      { AUTH_BASE_URL: 'http://localhost:3000?redirect=evil' },
    ])
      expect(() => readAuthConfig({ ...configured, ...invalid })).toThrow();
    expect(
      readAuthConfig({
        ...configured,
        AUTH_BASE_URL: 'https://api.example.com',
        APP_ORIGIN: 'https://app.example.com',
        NODE_ENV: 'production',
      })?.secureCookies,
    ).toBe(true);
  });
});

describe('unconfigured identity boundary', () => {
  it('keeps health available and fails closed for every protected/auth route', async () => {
    const server = createServer({ ready: async () => {}, close: async () => {} });
    try {
      expect((await server.inject('/health/live')).statusCode).toBe(200);
      for (const [method, url] of [
        ['GET', '/api/me'],
        ['GET', '/api/workspaces'],
        ['POST', '/api/workspaces'],
        ['GET', '/api/workspaces/00000000-0000-0000-0000-000000000001/services'],
        ['POST', '/api/auth/sign-in/social'],
        ['GET', '/api/auth/get-session'],
        ['POST', '/api/workspace-invitations/accept'],
      ] as const) {
        const response = await server.inject({ method, url });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'unavailable' });
      }
    } finally {
      await server.close();
    }
  });
});

// Mocks isolate HTTP forwarding and dependency failures; PostgreSQL suite uses real auth.
import { Pool } from 'pg';
import { vi } from 'vitest';
import * as identityAuth from '../src/features/identity/auth.ts';
import { createAuth } from '../src/features/identity/auth.ts';

it('preserves callback cookies/status and constructs URLs from configuration', async () => {
  const config = readAuthConfig(configured);
  if (!config) throw new Error('Test config absent');
  const pool = new Pool();
  const auth = createAuth(pool, config);
  vi.spyOn(auth, 'handler').mockImplementation(async (request) => {
    expect(new URL(request.url).origin).toBe('http://localhost:3000');
    expect(request.headers.get('x-clio-client-ip')).toBe('127.0.0.1');
    const headers = new Headers({ location: 'http://localhost:5173' });
    headers.append('set-cookie', 'one=1; HttpOnly; SameSite=Lax');
    headers.append('set-cookie', 'two=2; HttpOnly; SameSite=Lax');
    return new Response(null, { status: 302, headers });
  });
  const server = createServer(
    { ready: async () => {}, close: async () => pool.end() },
    { auth, config, pool },
  );
  try {
    const response = await server.inject({
      url: '/api/auth/callback/github?code=test&state=test',
      headers: {
        host: 'attacker.example',
        'x-forwarded-host': 'attacker.example',
        'x-clio-client-ip': '203.0.113.1',
        'x-forwarded-for': '203.0.113.2',
      },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers['set-cookie']).toEqual([
      'one=1; HttpOnly; SameSite=Lax',
      'two=2; HttpOnly; SameSite=Lax',
    ]);
    expect(response.headers.location).toBe('http://localhost:5173');
  } finally {
    await server.close();
    vi.restoreAllMocks();
  }
});

it('rejects origin, scope escalation and public token/session endpoints', async () => {
  const config = readAuthConfig(configured);
  if (!config) throw new Error('Test config absent');
  const pool = new Pool();
  const auth = createAuth(pool, config);
  const server = createServer(
    { ready: async () => {}, close: async () => pool.end() },
    { auth, config, pool },
  );
  try {
    for (const origin of [undefined, 'https://evil.example', 'null']) {
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/api/auth/sign-in/social',
            headers: origin ? { origin } : {},
            payload: { provider: 'github' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/api/workspaces',
            headers: origin ? { origin } : {},
            payload: { name: 'Forged' },
          })
        ).statusCode,
      ).toBe(403);
    }
    for (const extra of [
      { scopes: ['repo'] },
      { idToken: { token: 'forged' } },
      { additionalParams: { scope: 'repo' } },
      { provider: 'google' },
    ]) {
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/api/auth/sign-in/social',
            headers: { origin: config.appOrigin },
            payload: { provider: 'github', ...extra },
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const path of [
      'get-access-token',
      'refresh-token',
      'list-accounts',
      'get-session',
      'list-sessions',
      'link-social',
      'sign-up/email',
    ]) {
      for (const method of ['GET', 'POST'] as const)
        expect(
          (
            await server.inject({
              method,
              url: `/api/auth/${path}`,
              headers: { origin: config.appOrigin },
            })
          ).statusCode,
        ).toBe(404);
    }
    const cors = await server.inject({
      method: 'OPTIONS',
      url: '/api/workspaces',
      headers: { origin: config.appOrigin, 'access-control-request-method': 'POST' },
    });
    expect(cors.headers['access-control-allow-origin']).toBe(config.appOrigin);
    expect(cors.headers['access-control-allow-credentials']).toBe('true');
    const foreign = await server.inject({
      url: '/health/live',
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  } finally {
    await server.close();
  }
});

it('returns safe identity and redacts library/dependency failures', async () => {
  const config = readAuthConfig(configured);
  if (!config) throw new Error('Test config absent');
  const pool = new Pool();
  const auth = createAuth(pool, config);
  const now = new Date();
  const session = vi.spyOn(identityAuth, 'readSession').mockResolvedValue({
    headers: new Headers(),
    response: {
      user: {
        id: 'stable-id',
        name: 'Test',
        email: 'test@example.com',
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: 'session-id',
        userId: 'stable-id',
        token: 'private-session-token',
        expiresAt: new Date(Date.now() + 10000),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const server = createServer(
    { ready: async () => {}, close: async () => pool.end() },
    { auth, config, pool },
  );
  try {
    const me = await server.inject('/api/me');
    expect(me.json()).toEqual({
      user: {
        id: 'stable-id',
        name: 'Test',
        email: 'test@example.com',
        emailVerified: true,
        image: null,
      },
    });
    expect(me.headers['cache-control']).toBe('no-store');
    session.mockResolvedValue({ response: null, headers: new Headers() });
    expect((await server.inject('/api/me')).statusCode).toBe(401);
    session.mockRejectedValue(new Error('private-db-payload'));
    const failed = await server.inject('/api/me');
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('private');
    vi.spyOn(auth, 'handler').mockResolvedValue(
      new Response('secret-provider-error', { status: 500 }),
    );
    const callback = await server.inject('/api/auth/callback/github?code=test&state=test');
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe('http://localhost:5173/settings?authError=1');
    expect(callback.body).not.toContain('secret');
    const error = await server.inject(
      '/api/auth/error?error=private&callbackURL=https://evil.example',
    );
    expect(error.statusCode).toBe(303);
    expect(error.headers.location).toBe('http://localhost:5173/settings?authError=1');
  } finally {
    await server.close();
    vi.restoreAllMocks();
  }
});

it('does not report logout success when database session remains active', async () => {
  const config = readAuthConfig(configured);
  if (!config) throw new Error('Test config absent');
  const pool = new Pool();
  const auth = createAuth(pool, config);
  const now = new Date();
  vi.spyOn(auth, 'handler').mockResolvedValue(Response.json({ success: true }));
  vi.spyOn(auth.api, 'getSession').mockResolvedValue({
    user: {
      id: 'stable-id',
      name: 'Test',
      email: 'test@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: 'session-id',
      userId: 'stable-id',
      token: 'private-session-token',
      expiresAt: new Date(Date.now() + 10000),
      createdAt: now,
      updatedAt: now,
    },
  });
  const server = createServer(
    { ready: async () => {}, close: async () => pool.end() },
    { auth, config, pool },
  );
  try {
    const result = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { origin: config.appOrigin },
      payload: {},
    });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ error: 'unavailable' });
  } finally {
    await server.close();
    vi.restoreAllMocks();
  }
});

it('preserves redacted client errors and does not check revocation after rejected logout', async () => {
  const config = readAuthConfig(configured);
  if (!config) throw new Error('Test config absent');
  const pool = new Pool();
  const auth = createAuth(pool, config);
  const handler = vi
    .spyOn(auth, 'handler')
    .mockResolvedValue(new Response('private-auth-error', { status: 403 }));
  const getSession = vi
    .spyOn(auth.api, 'getSession')
    .mockRejectedValue({ statusCode: 401, message: 'private-session-error' });
  const server = createServer(
    { ready: async () => {}, close: async () => pool.end() },
    { auth, config, pool },
  );
  try {
    const logout = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { origin: config.appOrigin },
      payload: {},
    });
    expect(logout.statusCode).toBe(403);
    expect(logout.json()).toEqual({ error: 'forbidden' });
    expect(getSession).not.toHaveBeenCalled();
    const me = await server.inject('/api/me');
    expect(me.statusCode).toBe(401);
    expect(me.json()).toEqual({ error: 'unauthorized' });
    for (const [contentType, payload, status] of [
      ['application/xml', '<xml/>', 415],
      ['application/json', JSON.stringify({ name: 'x'.repeat(1048576) }), 413],
    ] as const) {
      const result = await server.inject({
        method: 'POST',
        url: '/api/workspaces',
        headers: { origin: config.appOrigin, 'content-type': contentType },
        payload,
      });
      expect(result.statusCode).toBe(status);
      expect(result.json()).toEqual({ error: 'invalid_request' });
    }
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    await server.close();
    vi.restoreAllMocks();
  }
});

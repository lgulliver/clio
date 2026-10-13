import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityError } from '../src/features/identity/input.ts';
import type { Actor } from '../src/features/identity/repository.ts';
import { registerNotificationRoutes } from '../src/features/notifications/routes.ts';
import { createServer } from '../src/server.ts';

const appOrigin = 'https://clio.example.test';
const workspaceId = randomUUID();
const pulseId = randomUUID();
const base = `/api/workspaces/${workspaceId}/notifications`;
const actor: Actor = { userId: 'unit-user', sessionId: 'unit-session' };
// Never connected: every case below must be decided before storage is reached.
const unusedPool = new Pool({
  connectionString: 'postgresql://unit:unit@127.0.0.1:1/unused',
  connectionTimeoutMillis: 200,
});

const routes: ReadonlyArray<readonly ['GET' | 'POST' | 'PATCH', string]> = [
  ['GET', `${base}/availability`],
  ['GET', `${base}/policy`],
  ['PATCH', `${base}/policy`],
  ['GET', `${base}/slack-link`],
  ['POST', `${base}/slack-link/start`],
  ['POST', `${base}/slack-link/unlink`],
  ['GET', `${base}/history`],
  ['GET', `${base}/pulses/${pulseId}`],
  ['POST', `${base}/pulses/${pulseId}/remind`],
  ['POST', `${base}/pulses/${pulseId}/reminders/disable`],
  ['POST', `${base}/pulses/${pulseId}/retry`],
  ['POST', `${base}/test`],
  ['GET', '/api/notifications/slack/callback'],
];

afterAll(async () => {
  await unusedPool.end();
});

describe('notification routes without identity', () => {
  let server: FastifyInstance;
  beforeAll(async () => {
    server = createServer({ ready: async () => {}, close: async () => {} });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
  });
  it.each(routes)('%s %s is unavailable and never cacheable', async (method, url) => {
    const response = await server.inject({
      method,
      url,
      ...(method === 'GET' ? {} : { payload: {} }),
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ error: 'unavailable' });
  });
});

describe('notification route boundary before storage', () => {
  let server: FastifyInstance;
  let session: 'ok' | 'missing';
  beforeAll(async () => {
    server = Fastify({ logger: false });
    server.setErrorHandler((error, _request, reply) =>
      error instanceof IdentityError
        ? reply.code(error.status).send({ error: error.message })
        : reply.code(503).send({ error: 'unavailable' }),
    );
    registerNotificationRoutes(server, {
      pool: unusedPool,
      config: null,
      configNow: async () => null,
      actor: async () => {
        if (session === 'missing') throw new IdentityError(401, 'unauthorized');
        return actor;
      },
      appOrigin,
      callbackOrigin: 'http://localhost:3000',
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
  });

  it('rejects hostile identifiers, queries and bodies before any storage work', async () => {
    session = 'ok';
    const bad = [
      { method: 'GET', url: `/api/workspaces/not-a-uuid/notifications/availability` },
      { method: 'GET', url: `${base}/availability?workspaceId=${randomUUID()}` },
      { method: 'GET', url: `${base}/policy?x=1` },
      { method: 'GET', url: `${base}/pulses/not-a-uuid` },
      { method: 'PATCH', url: `${base}/policy`, payload: { enabled: true } },
      {
        method: 'PATCH',
        url: `${base}/policy`,
        payload: {
          revision: 0,
          enabled: false,
          invitations: true,
          closures: true,
          reminders: true,
          firstReminderHours: 48,
          repeatHours: 72,
          maximumReminders: 2,
          recipient: 'someone-else',
        },
      },
      { method: 'POST', url: `${base}/slack-link/start`, payload: { teamId: 'T01' } },
      { method: 'POST', url: `${base}/slack-link/start?next=https://evil.example`, payload: {} },
    ] as const;
    for (const request of bad) {
      const response = await server.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_request' });
    }
  });

  it('authenticates before parsing so anonymous callers learn nothing about payload validity', async () => {
    session = 'missing';
    for (const [method, url] of routes.filter(([, path]) => path.startsWith(base))) {
      const response = await server.inject({
        method,
        url,
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('sends every callback failure to the fixed SPA route without echoing query values', async () => {
    const secret = 'secret-code-value-that-must-not-reappear';
    const state = 'A'.repeat(43);
    const cases: Array<{ session: 'ok' | 'missing'; url: string }> = [
      {
        session: 'missing',
        url: `/api/notifications/slack/callback?code=${secret}&state=${state}`,
      },
      { session: 'ok', url: '/api/notifications/slack/callback' },
      { session: 'ok', url: `/api/notifications/slack/callback?code=${secret}` },
      {
        session: 'ok',
        url: `/api/notifications/slack/callback?code=${secret}&state=${state}&workspace=${workspaceId}`,
      },
      {
        session: 'ok',
        url: `/api/notifications/slack/callback?code=${secret}&code=${secret}&state=${state}`,
      },
      {
        session: 'ok',
        url: `/api/notifications/slack/callback?error=access_denied&error_description=${secret}&state=bad`,
      },
    ];
    for (const c of cases) {
      session = c.session;
      const response = await server.inject({
        method: 'GET',
        url: c.url,
        headers: { host: 'attacker.example', 'x-forwarded-host': 'attacker.example' },
      });
      expect(response.statusCode, c.url).toBe(303);
      expect(response.headers.location).toBe(
        `${appOrigin}/developer-experience?notificationLink=failed`,
      );
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.payload).not.toContain(secret);
      expect(String(response.headers.location)).not.toContain(secret);
      expect(String(response.headers.location)).not.toContain(workspaceId);
    }
  });

  it('treats storage failure during callback as the same fixed failure', async () => {
    session = 'ok';
    const response = await server.inject({
      method: 'GET',
      url: `/api/notifications/slack/callback?code=abc&state=${'B'.repeat(43)}`,
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      `${appOrigin}/developer-experience?notificationLink=failed`,
    );
  });

  it('maps unreachable storage to a redacted 503 on workspace routes', async () => {
    session = 'ok';
    const response = await server.inject({ method: 'GET', url: `${base}/history` });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'unavailable' });
  });
});

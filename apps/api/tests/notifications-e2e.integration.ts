import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { databaseUrl } from '../src/config.ts';
import { migrate } from '../src/db/migrations.ts';
import { createAuth } from '../src/features/identity/auth.ts';
import { readAuthConfig } from '../src/features/identity/config.ts';
import {
  type NotificationConfig,
  readNotificationConfig,
} from '../src/features/notifications/config.ts';
import type {
  NotificationChannel,
  NotificationState,
} from '../src/features/notifications/contract.ts';
import { createNotificationProvider } from '../src/features/notifications/provider.ts';
import { processOneNotification } from '../src/features/notifications/worker.ts';
import { createServer } from '../src/server.ts';
import { fixtureCaPem, startSmtpFixture } from './fixtures/notification-transports.ts';

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
function cookies(value: string | string[] | undefined): string {
  return (typeof value === 'string' ? [value] : (value ?? []))
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}
function decodeEmail(message: string): string {
  return message
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}
const response = {
  instrumentVersion: 'clio.space.pulse.v1',
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
type Mode = 'local_capture' | 'accepted' | 'refused' | 'uncertain' | 'paced';
type Session = { cookie: string; email: string; userId: string };
type SlackCall = { url: string; body: Record<string, unknown> };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function request(
  app: ReturnType<typeof createServer>,
  origin: string,
  method: Method,
  url: string,
  who: Session,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: { cookie: who.cookie, ...(method === 'GET' ? {} : { origin }) },
    ...(payload === undefined ? {} : { payload }),
  });
}
type Flow = {
  pool: Pool;
  smtp: Awaited<ReturnType<typeof startSmtpFixture>>;
  origin: string;
  workspaceId: string;
  base: string;
  notificationBase: string;
  owner: Session;
  member: Session;
  config: NotificationConfig;
  configNow: () => Promise<NotificationConfig | null>;
  provider: ReturnType<typeof createNotificationProvider>;
  call: (method: Method, url: string, who: Session, payload?: object) => ReturnType<typeof request>;
  openPulse: () => Promise<string>;
  link: (who: Session, slackUserId: string) => Promise<void>;
  slackCalls: SlackCall[];
  step: () => Promise<boolean>;
};

// Each case runs the real auth, HTTP, repositories, lifecycle hooks, worker and transports.
// Only fixed GitHub/Slack fetch endpoints are mocked; SMTP uses a disposable loopback listener.
async function withFlow(mode: Mode, run: (fixture: Flow) => Promise<void>): Promise<void> {
  if (!process.env.CLIO_TEST_DATABASE_URL) throw new Error('CLIO_TEST_DATABASE_URL required');
  const connectionString = databaseUrl(process.env.CLIO_TEST_DATABASE_URL);
  const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 3000 });
  const pool = new Pool({
    connectionString,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
  });
  const directory = await mkdtemp(join(tmpdir(), 'clio-notification-e2e-'));
  const file = join(directory, 'notifications.json');
  const capture = mode === 'local_capture';
  let smtp: Awaited<ReturnType<typeof startSmtpFixture>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let created = false;
  const origin = capture ? 'http://localhost:5173' : 'https://clio.example.test';
  const authConfig = readAuthConfig({
    AUTH_SECRET: 'notification-e2e-fixture-secret-12345678901234567890',
    AUTH_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: origin,
    GITHUB_CLIENT_ID: 'fixture-client',
    GITHUB_CLIENT_SECRET: 'fixture-secret',
  });
  if (!authConfig) throw new Error('Fixture auth config missing');
  const configNow = () => readNotificationConfig({ NOTIFICATIONS_PRIVATE_CONFIG_FILE: file });
  const slackCalls: SlackCall[] = [];
  const unexpected: string[] = [];
  let githubId = 8100;
  let email = '';
  const keys = await generateKeyPair('RS256');
  const jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'flow-key', alg: 'RS256', use: 'sig' }],
  };
  const proofs = new Map<string, { nonce: string; userId: string }>();
  let verifiedUserId = '';
  let opened = 0;
  const droppedPost = new TypeError('Disposable fixture connection dropped after submission');
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    try {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://github.com/login/oauth/access_token')
        return Response.json({
          access_token: 'fixture-only-login-token',
          token_type: 'bearer',
          scope: 'read:user,user:email',
        });
      if (url === 'https://api.github.com/user')
        return Response.json({
          id: githubId,
          login: `fixture-${githubId}`,
          name: 'Capture participant',
          email,
          avatar_url: 'https://example.test/avatar',
        });
      if (url === 'https://api.github.com/user/emails')
        return Response.json([{ email, primary: true, verified: true, visibility: 'private' }]);
      // An unknown endpoint remains a test failure even when a transport catches its exception.
      if (
        ![
          'https://slack.com/api/auth.test',
          'https://slack.com/api/openid.connect.token',
          'https://slack.com/openid/connect/keys',
          'https://slack.com/api/openid.connect.userInfo',
          'https://slack.com/api/conversations.open',
          'https://slack.com/api/chat.postMessage',
        ].includes(url) ||
        capture
      ) {
        unexpected.push(url);
        throw new Error('Unexpected outbound fetch in notification proof');
      }
      expect(init?.redirect).toBe('manual');
      if (url === 'https://slack.com/api/openid.connect.token') {
        const body = new URLSearchParams(string(init?.body));
        expect(body.get('client_id')).toBe('fixture-client');
        expect(body.get('client_secret')).toBe('fixture-only-client-secret');
        expect(body.get('redirect_uri')).toBe(
          'http://localhost:3000/api/notifications/slack/callback',
        );
        expect(body.get('grant_type')).toBe('authorization_code');
        const proof = proofs.get(body.get('code') ?? '');
        if (!proof) throw new Error('Unknown signed fixture code');
        verifiedUserId = proof.userId;
        const now = Math.floor(Date.now() / 1000);
        const accessToken = 'fixture-only-identity-token';
        const idToken = await new SignJWT({
          nonce: proof.nonce,
          'https://slack.com/team_id': 'TFLOW',
          'https://slack.com/user_id': proof.userId,
          at_hash: createHash('sha256')
            .update(accessToken)
            .digest()
            .subarray(0, 16)
            .toString('base64url'),
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'flow-key' })
          .setIssuer('https://slack.com')
          .setAudience('fixture-client')
          .setSubject(proof.userId)
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(keys.privateKey);
        return Response.json({
          ok: true,
          token_type: 'Bearer',
          access_token: accessToken,
          id_token: idToken,
        });
      }
      if (url === 'https://slack.com/openid/connect/keys') return Response.json(jwks);
      if (url === 'https://slack.com/api/openid.connect.userInfo') {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer fixture-only-identity-token',
        );
        return Response.json({
          ok: true,
          sub: verifiedUserId,
          'https://slack.com/team_id': 'TFLOW',
          'https://slack.com/user_id': verifiedUserId,
        });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xoxb-fixture-only');
      const body = record(JSON.parse(string(init?.body)));
      slackCalls.push({ url, body });
      if (url === 'https://slack.com/api/auth.test')
        return Response.json({ ok: true, team_id: 'TFLOW' });
      if (url === 'https://slack.com/api/conversations.open') {
        opened += 1;
        if (mode === 'paced' && opened === 1)
          return Response.json(
            { ok: false, error: 'ratelimited' },
            { status: 429, headers: { 'retry-after': '60' } },
          );
        return Response.json({ ok: true, channel: { id: 'DFLOW' } });
      }
      if (mode === 'uncertain') throw droppedPost;
      return Response.json(
        mode === 'refused' ? { ok: false, error: 'channel_not_found' } : { ok: true },
      );
    } catch (error) {
      if (error !== droppedPost) unexpected.push('Fetch fixture failure');
      throw error;
    }
  });
  try {
    smtp = await startSmtpFixture({}, { tls: !capture });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await migrate(pool);
    const auth = createAuth(pool, authConfig);
    await (await auth.$context).checkSchema?.();
    const app = createServer(
      { ready: async () => {}, close: async () => {} },
      {
        auth,
        config: authConfig,
        pool,
        notificationsConfigNow: configNow,
      },
    );
    server = app;
    const call = (method: Method, url: string, who: Session, payload?: object) =>
      request(app, origin, method, url, who, payload);
    async function login(): Promise<Session> {
      githubId += 1;
      email = `capture-${githubId}@example.test`;
      const start = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/social',
        headers: { origin },
        payload: { provider: 'github', callbackURL: origin, disableRedirect: true },
      });
      expect(start.statusCode).toBe(200);
      const state = string(new URL(string(record(start.json()).url)).searchParams.get('state'));
      const callback = await app.inject({
        url: `/api/auth/callback/github?code=fixture&state=${encodeURIComponent(state)}`,
        headers: { cookie: cookies(start.headers['set-cookie']) },
      });
      expect(callback.statusCode).toBe(302);
      const cookie = cookies(callback.headers['set-cookie']);
      const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
      if (!session) throw new Error('Fixture session absent');
      return { cookie, email, userId: session.user.id };
    }
    const owner = await login();
    const member = await login();
    const workspace = await call('POST', '/api/workspaces', owner, { name: 'Capture proof' });
    expect(workspace.statusCode).toBe(201);
    const workspaceId = string(record(record(workspace.json()).workspace).id);
    const base = `/api/workspaces/${workspaceId}`;
    const notificationBase = `${base}/notifications`;
    const invitation = await call('POST', `${base}/invitations`, owner, { email: member.email });
    expect(invitation.statusCode).toBe(201);
    const token = string(record(record(invitation.json()).invitation).token);
    expect(
      (await call('POST', '/api/workspace-invitations/accept', member, { token })).statusCode,
    ).toBe(200);
    await writeFile(
      file,
      JSON.stringify({
        mode: capture ? 'local_capture' : 'live',
        publicOrigin: origin,
        fingerprintKey: randomBytes(32).toString('base64url'),
        grants: [
          {
            workspaceId,
            slack: capture
              ? null
              : {
                  teamId: 'TFLOW',
                  botToken: 'xoxb-fixture-only',
                  clientId: 'fixture-client',
                  clientSecret: 'fixture-only-client-secret',
                  credentialRevision: 'flow-v1',
                },
            smtp: {
              host: smtp.host,
              port: smtp.port,
              tls: !capture,
              user: null,
              password: null,
              from: 'capture@example.test',
              ratePerMinute: 60,
              credentialRevision: 'capture-v1',
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const config = await configNow();
    if (!config) throw new Error('Private fixture config absent');
    const provider = createNotificationProvider(config, { tlsCa: fixtureCaPem });
    const enabled = await call('PATCH', `${notificationBase}/policy`, owner, {
      revision: 0,
      enabled: true,
      invitations: true,
      closures: true,
      reminders: true,
      firstReminderHours: 48,
      repeatHours: 72,
      maximumReminders: 2,
    });
    expect(enabled.statusCode).toBe(200);
    const team = await call('POST', `${base}/teams`, owner, { name: 'Capture team' });
    expect(team.statusCode).toBe(201);
    const teamId = string(record(record(team.json()).team).id);
    for (const who of capture ? [owner, member] : [member])
      expect(
        (await call('POST', `${base}/space/assignments/${who.userId}`, owner, { teamId }))
          .statusCode,
      ).toBe(200);
    async function openPulse() {
      const draft = await call('POST', `${base}/space/pulses`, owner, {
        teamId,
        referenceStart: '2026-01-01T00:00:00.000Z',
        referenceEnd: '2026-01-08T00:00:00.000Z',
      });
      expect(draft.statusCode).toBe(201);
      const pulseId = string(record(record(draft.json()).pulse).id);
      expect(
        (await call('POST', `${base}/space/pulses/${pulseId}/open`, owner, {})).statusCode,
      ).toBe(200);
      return pulseId;
    }
    async function link(who: Session, slackUserId: string) {
      const start = await call('POST', `${notificationBase}/slack-link/start`, who, {});
      expect(start.statusCode).toBe(200);
      const authorize = new URL(string(record(start.json()).authorizeUrl));
      const state = string(authorize.searchParams.get('state'));
      const nonce = string(authorize.searchParams.get('nonce'));
      expect(authorize.searchParams.get('scope')).toBe('openid profile');
      expect(authorize.searchParams.get('response_mode')).toBe('query');
      const code = `signed-fixture-${proofs.size}`;
      proofs.set(code, { nonce, userId: slackUserId });
      const callback = await call(
        'GET',
        `/api/notifications/slack/callback?${new URLSearchParams({ state, code })}`,
        who,
      );
      expect(callback.statusCode).toBe(303);
      expect(callback.headers.location).toBe(
        `${origin}/developer-experience?workspace=${workspaceId}&notificationLink=success`,
      );
      expect(callback.headers['referrer-policy']).toBe('no-referrer');
      const read = await call('GET', `${notificationBase}/slack-link`, who);
      expect(read.statusCode).toBe(200);
      expect(record(record(read.json()).link)).toEqual({
        linked: true,
        revision: 1,
        linkedAt: expect.any(String),
      });
      expect(read.payload).not.toContain(slackUserId);
    }
    const fixture = {
      pool,
      smtp,
      origin,
      workspaceId,
      base,
      notificationBase,
      owner,
      member,
      config,
      configNow,
      provider,
      call,
      openPulse,
      link,
      slackCalls,
      step: () => processOneNotification(pool, config, { configNow, provider }),
    };
    await run(fixture);
    expect(unexpected).toEqual([]);
  } finally {
    // Every resource belongs to this case, including the private file and random schema.
    try {
      await server?.close();
    } finally {
      try {
        await smtp?.close();
      } finally {
        await pool.end();
        try {
          if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin.end();
          await rm(directory, { recursive: true, force: true });
          vi.unstubAllGlobals();
        }
      }
    }
  }
}
function privateFree(payload: string, f: Flow) {
  for (const value of [
    f.owner.email,
    f.member.email,
    f.owner.userId,
    f.member.userId,
    'UMEMBER',
    'UOWNER',
    'TFLOW',
    'xoxb-fixture-only',
    'fixture-only-identity-token',
    'fixture-only-client-secret',
    'satisfaction',
    'answers',
    'answeredCount',
    'mean',
    'recipient',
    'slackUserId',
  ])
    expect(payload).not.toContain(value);
  expect(payload).not.toMatch(/"email"\s*:/);
}
async function history(f: Flow, who: Session) {
  const read = await f.call('GET', `${f.notificationBase}/history`, who);
  expect(read.statusCode).toBe(200);
  expect(read.headers['cache-control']).toBe('no-store');
  privateFree(read.payload, f);
  const page = record(read.json());
  expect(Object.keys(page).sort()).toEqual(['items', 'nextCursor', 'workspaceId']);
  expect(page.workspaceId).toBe(f.workspaceId);
  expect(page.nextCursor).toBeNull();
  return array(page.items).map((item) => {
    const notice = record(item);
    expect(Object.keys(notice).sort()).toEqual([
      'channel',
      'createdAt',
      'id',
      'kind',
      'pulseId',
      'state',
      'updatedAt',
    ]);
    return notice;
  });
}
async function summary(
  f: Flow,
  pulseId: string,
  counts: Partial<Record<NotificationState, number>>,
) {
  const read = await f.call('GET', `${f.notificationBase}/pulses/${pulseId}`, f.owner);
  expect(read.statusCode).toBe(200);
  expect(read.headers['cache-control']).toBe('no-store');
  privateFree(read.payload, f);
  const result = record(read.json());
  expect(Object.keys(result).sort()).toEqual([
    'counts',
    'pulseId',
    'remindersEnabled',
    'revision',
    'workspaceId',
  ]);
  expect(result.workspaceId).toBe(f.workspaceId);
  expect(result.pulseId).toBe(pulseId);
  expect(result.counts).toEqual({
    pending: 0,
    leased: 0,
    retry_scheduled: 0,
    provider_accepted: 0,
    skipped: 0,
    failed: 0,
    uncertain: 0,
    ...counts,
  });
}
function assertEmail(
  f: Flow,
  pulseId: string,
  who: Session,
  subject: 'A team pulse is open' | 'Pulse closed',
) {
  expect(f.smtp.commands().filter((command) => command.startsWith('RCPT TO:'))).toContain(
    `RCPT TO:<${who.email}>`,
  );
  expect(f.smtp.message()).toContain(`Subject: ${subject}`);
  const decoded = decodeEmail(f.smtp.message());
  const target = `${f.origin}/developer-experience?workspace=${f.workspaceId}&pulse=${pulseId}`;
  const lead =
    subject === 'Pulse closed'
      ? 'A team pulse has closed. You can find it in Clio.'
      : 'A team pulse is open and your input is welcome.';
  expect(decoded).toContain(`${lead}\r\n\r\nOpen the pulse in Clio: ${target}\r\n`);
  expect(decoded).toContain(
    `<p>${lead}</p><p><a href="${target.replaceAll('&', '&amp;')}">Open the pulse in Clio</a></p>`,
  );
  expect(decoded).not.toMatch(/^(cc|bcc):/im);
  for (const value of [
    'satisfaction',
    'answers',
    'respondent',
    'Capture team',
    'Capture proof',
    'fixture-only',
  ])
    expect(decoded).not.toContain(value);
}

it('runs local capture through authenticated lifecycle, receipt suppression, closure privacy and answer purge', async () => {
  await withFlow('local_capture', async (f) => {
    const pulseId = await f.openPulse();
    expect(
      (await f.call('POST', `${f.base}/space/pulses/${pulseId}/response`, f.member, response))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM space_answers WHERE pulse_id=$1',
          [pulseId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(await f.step()).toBe(true);
    expect(await f.step()).toBe(false);
    expect(f.smtp.connections()).toBe(1);
    expect(f.smtp.commands().filter((command) => command.startsWith('RCPT TO:'))).toEqual([
      `RCPT TO:<${f.owner.email}>`,
    ]);
    assertEmail(f, pulseId, f.owner, 'A team pulse is open');
    await summary(f, pulseId, { provider_accepted: 1, skipped: 1 });
    expect(await history(f, f.owner)).toEqual([
      expect.objectContaining({
        pulseId,
        kind: 'invitation',
        state: 'provider_accepted',
        channel: 'email',
      }),
    ]);
    expect(await history(f, f.member)).toEqual([
      expect.objectContaining({ pulseId, kind: 'invitation', state: 'skipped' }),
    ]);
    expect(
      (await f.call('GET', `${f.notificationBase}/pulses/${pulseId}`, f.member)).statusCode,
    ).toBe(403);
    expect(
      (await f.call('POST', `${f.base}/space/pulses/${pulseId}/close`, f.owner, {})).statusCode,
    ).toBe(200);
    expect(await f.step()).toBe(true);
    expect(await f.step()).toBe(true);
    expect(await f.step()).toBe(false);
    expect(f.smtp.connections()).toBe(3);
    assertEmail(f, pulseId, f.member, 'Pulse closed');
    await summary(f, pulseId, { provider_accepted: 3, skipped: 1 });
    expect(await history(f, f.member)).toEqual([
      expect.objectContaining({
        pulseId,
        kind: 'closure',
        state: 'provider_accepted',
        channel: 'email',
      }),
      expect.objectContaining({ pulseId, kind: 'invitation', state: 'skipped' }),
    ]);
    const pulseRead = await f.call('GET', `${f.base}/space/pulses/${pulseId}`, f.member);
    expect(pulseRead.statusCode).toBe(200);
    const saved = record(record(pulseRead.json()).pulse);
    expect(saved.state).toBe('closed');
    expect(saved.submittedCount).toBeNull();
    const questions = array(saved.questions);
    expect(questions).toHaveLength(8);
    for (const question of questions) {
      expect(record(question)).toEqual({
        questionId: expect.any(String),
        status: 'suppressed',
        mean: null,
      });
    }
    expect(
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM space_answers WHERE pulse_id=$1',
          [pulseId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });
}, 20000);

it.each(['accepted', 'refused', 'uncertain'] as const)(
  'proves signed Slack %s through the real worker and safe HTTP status',
  async (mode) => {
    await withFlow(mode, async (f) => {
      const pulseId = await f.openPulse();
      await f.link(f.member, 'UMEMBER');
      expect(await f.step()).toBe(true);
      const state = mode === 'uncertain' ? 'uncertain' : 'provider_accepted';
      const channel: NotificationChannel = mode === 'refused' ? 'email' : 'slack';
      if (mode === 'refused') {
        expect(f.smtp.connections()).toBe(0);
        expect(await history(f, f.member)).toEqual([
          expect.objectContaining({ pulseId, state: 'pending', channel: 'email' }),
        ]);
        expect(await f.step()).toBe(true);
        expect(f.smtp.connections()).toBe(1);
        expect(f.smtp.commands().filter((command) => command.startsWith('RCPT TO:'))).toEqual([
          `RCPT TO:<${f.member.email}>`,
        ]);
        assertEmail(f, pulseId, f.member, 'A team pulse is open');
      } else {
        expect(f.smtp.connections()).toBe(0);
        expect(f.smtp.commands()).toEqual([]);
        expect(f.smtp.message()).toBe('');
      }
      expect(await f.step()).toBe(false);
      expect(await f.step()).toBe(false);
      expect(f.smtp.connections()).toBe(mode === 'refused' ? 1 : 0);
      expect(f.slackCalls).toEqual([
        { url: 'https://slack.com/api/auth.test', body: {} },
        {
          url: 'https://slack.com/api/conversations.open',
          body: { users: 'UMEMBER', return_im: false },
        },
        {
          url: 'https://slack.com/api/chat.postMessage',
          body: {
            channel: 'DFLOW',
            text: `A team pulse is open. <${f.origin}/developer-experience?workspace=${f.workspaceId}&pulse=${pulseId}|Open the pulse in Clio>`,
            unfurl_links: false,
            unfurl_media: false,
          },
        },
      ]);
      expect(await history(f, f.member)).toEqual([
        expect.objectContaining({ pulseId, kind: 'invitation', state, channel }),
      ]);
      expect(await history(f, f.owner)).toEqual([]);
      await summary(f, pulseId, { [state]: 1 });
      expect(
        (await f.call('GET', `${f.notificationBase}/pulses/${pulseId}`, f.member)).statusCode,
      ).toBe(403);
      const attempts = await f.pool.query<{ channel: string; outcome: string }>(
        'SELECT channel,outcome FROM notification_attempts ORDER BY started_at,id',
      );
      expect(attempts.rows).toEqual(
        mode === 'refused'
          ? [
              { channel: 'slack', outcome: 'not_accepted' },
              { channel: 'email', outcome: 'accepted' },
            ]
          : [{ channel: 'slack', outcome: mode === 'uncertain' ? 'uncertain' : 'accepted' }],
      );
    });
  },
  20000,
);

it.each(['response', 'cancel', 'revoke'] as const)(
  'prevents Slack and SMTP when %s arrives during durable pacing',
  async (action) => {
    await withFlow('paced', async (f) => {
      // An actual owner-only test receives a parsed Slack 429. Its durable cooldown then
      // paces a distinct invitation; no SQL-crafted binding, cooldown or provider outcome.
      await f.link(f.owner, 'UOWNER');
      const test = await f.call('POST', `${f.notificationBase}/test`, f.owner, {
        revision: 1,
        requestId: randomUUID(),
        confirm: true,
        channel: 'slack',
      });
      expect(test.statusCode).toBe(202);
      expect(record(test.json()).queued).toBe(true);
      expect(await f.step()).toBe(true);
      expect(f.slackCalls).toEqual([
        { url: 'https://slack.com/api/auth.test', body: {} },
        {
          url: 'https://slack.com/api/conversations.open',
          body: { users: 'UOWNER', return_im: false },
        },
      ]);
      expect(await history(f, f.owner)).toEqual([
        expect.objectContaining({ kind: 'test', state: 'retry_scheduled', channel: 'slack' }),
      ]);
      const pulseId = await f.openPulse();
      await f.link(f.member, 'UMEMBER');
      const stop = new AbortController();
      let reads = 0;
      const pending = processOneNotification(f.pool, f.config, {
        provider: f.provider,
        signal: stop.signal,
        configNow: async () => {
          reads += 1;
          return f.configNow();
        },
      });
      void pending.catch(() => {});
      try {
        // Four authoritative reads include a repeated preflight after at least one pacing wait.
        await expect.poll(() => reads, { timeout: 5000 }).toBeGreaterThanOrEqual(4);
        expect(
          (
            await f.pool.query<{ state: string }>(
              'SELECT state FROM notification_events WHERE pulse_id=$1',
              [pulseId],
            )
          ).rows,
        ).toEqual([{ state: 'leased' }]);
        expect(
          (
            await f.pool.query(
              'SELECT 1 FROM notification_attempts a JOIN notification_events e ON e.id=a.event_id WHERE e.pulse_id=$1',
              [pulseId],
            )
          ).rowCount,
        ).toBe(0);
        expect(f.slackCalls).toHaveLength(2);
        expect(f.smtp.connections()).toBe(0);
        const mutation =
          action === 'response'
            ? await f.call('POST', `${f.base}/space/pulses/${pulseId}/response`, f.member, response)
            : action === 'cancel'
              ? await f.call('POST', `${f.base}/space/pulses/${pulseId}/cancel`, f.owner, {})
              : await f.call('DELETE', `${f.base}/members/${f.member.userId}`, f.owner);
        expect(mutation.statusCode).toBe(200);
        expect(await pending).toBe(true);
        expect(await f.step()).toBe(false);
        expect(f.slackCalls).toHaveLength(2);
        expect(f.smtp.connections()).toBe(0);
        expect(f.smtp.commands()).toEqual([]);
        expect(f.smtp.message()).toBe('');
        await summary(f, pulseId, { skipped: 1 });
        if (action === 'revoke') {
          expect((await f.call('GET', `${f.notificationBase}/history`, f.member)).statusCode).toBe(
            404,
          );
        } else {
          expect(await history(f, f.member)).toEqual([
            expect.objectContaining({ pulseId, kind: 'invitation', state: 'skipped' }),
          ]);
        }
        const events = await f.pool.query<{
          state: string;
          reason: string;
          slack_attempts: number;
          email_attempts: number;
        }>(
          'SELECT state,reason,slack_attempts,email_attempts FROM notification_events WHERE pulse_id=$1',
          [pulseId],
        );
        expect(events.rows).toEqual([
          {
            state: 'skipped',
            reason:
              action === 'response'
                ? 'response_received'
                : action === 'cancel'
                  ? 'pulse_inactive'
                  : 'access_removed',
            slack_attempts: 0,
            email_attempts: 0,
          },
        ]);
      } finally {
        stop.abort();
        await pending.catch(() => {});
      }
    });
  },
  20000,
);

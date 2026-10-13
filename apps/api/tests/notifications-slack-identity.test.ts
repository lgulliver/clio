import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { NotificationGrant } from '../src/features/notifications/config.ts';
import { createSlackLinkRepository } from '../src/features/notifications/link-repository.ts';
import {
  createSlackIdentityProvider,
  slackCallbackUri,
} from '../src/features/notifications/slack-identity.ts';

const grant: NotificationGrant = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  fingerprint: 'a'.repeat(64),
  credentialFingerprint: 'b'.repeat(64),
  smtp: null,
  slack: {
    teamId: 'T123',
    clientId: 'fixture-client',
    clientSecret: 'fixture-secret',
    botToken: 'fixture-bot',
  },
};
const nonce = 'fixture-nonce';
const nonceHash = createHash('sha256').update(nonce).digest('hex');
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: unknown;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  otherKeys = await generateKeyPair('RS256');
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture-key', alg: 'RS256', use: 'sig' }],
  };
});
afterEach(() => vi.unstubAllGlobals());
async function token(changes: Record<string, unknown> = {}, wrongKey = false) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: 'https://slack.com',
    aud: 'fixture-client',
    sub: 'U123',
    exp: now + 300,
    iat: now,
    nonce,
    'https://slack.com/team_id': 'T123',
    'https://slack.com/user_id': 'U123',
    ...changes,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .sign(wrongKey ? otherKeys.privateKey : keys.privateKey);
}
function fixtures(
  idToken: string,
  options: { info?: unknown; keys?: unknown; tokenResponse?: unknown; redirect?: boolean } = {},
) {
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    if (init.redirect !== 'manual') throw new Error('Redirects must be disabled');
    if (url.href === 'https://slack.com/api/openid.connect.token') {
      const body = new URLSearchParams(String(init.body));
      if (
        body.get('code') !== 'fixture-code' ||
        body.get('client_id') !== 'fixture-client' ||
        body.get('client_secret') !== 'fixture-secret' ||
        body.get('redirect_uri') !== 'https://api.example.com/api/notifications/slack/callback'
      )
        throw new Error('Wrong exchange context');
      if (options.redirect)
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.com' },
        });
      return Response.json(
        options.tokenResponse ?? {
          ok: true,
          id_token: idToken,
          access_token: 'fixture-access',
          token_type: 'Bearer',
        },
      );
    }
    if (url.href === 'https://slack.com/openid/connect/keys')
      return Response.json(options.keys ?? jwks);
    if (url.href === 'https://slack.com/api/openid.connect.userInfo') {
      if (new Headers(init.headers).get('authorization') !== 'Bearer fixture-access')
        throw new Error('Wrong identity credential');
      return Response.json(
        options.info ?? {
          ok: true,
          sub: 'U123',
          'https://slack.com/team_id': 'T123',
          'https://slack.com/user_id': 'U123',
        },
      );
    }
    throw new Error('Endpoint not allowlisted');
  });
}
function verify(hash = nonceHash, signal = new AbortController().signal) {
  return createSlackIdentityProvider('https://api.example.com').verifyCode({
    code: 'fixture-code',
    nonceHash: hash,
    grant,
    signal,
  });
}
it('verifies signed Slack identity through fixed token, JWKS and userInfo endpoints', async () => {
  fixtures(await token());
  expect(await verify()).toEqual({ teamId: 'T123', userId: 'U123' });
});
it.each([
  ['issuer', { iss: 'https://evil.example.com' }],
  ['audience', { aud: 'another-client' }],
  ['team', { 'https://slack.com/team_id': 'T456' }],
  ['subject', { sub: 'U456' }],
  ['nonce', { nonce: 'other-nonce' }],
  ['expiry', { exp: 1 }],
  ['missing expiry', { exp: undefined }],
  ['missing subject', { sub: undefined }],
  ['missing user', { 'https://slack.com/user_id': undefined }],
  ['missing team', { 'https://slack.com/team_id': undefined }],
  ['missing nonce', { nonce: undefined }],
  ['future issued-at', { iat: 9999999999 }],
])('rejects invalid %s without private error content', async (_label, changes) => {
  fixtures(await token(changes));
  await expect(verify()).rejects.toMatchObject({ status: 400, message: 'invalid_slack_identity' });
});
it.each([30, 60])('accepts signed future iat within %i seconds of clock skew', async (offset) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
  try {
    fixtures(await token({ iat: Math.floor(Date.now() / 1000) + offset }));
    expect(await verify()).toEqual({ teamId: 'T123', userId: 'U123' });
  } finally {
    vi.useRealTimers();
  }
});
it('rejects signed future iat beyond 60 seconds of clock skew', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
  try {
    fixtures(await token({ iat: Math.floor(Date.now() / 1000) + 61 }));
    await expect(verify()).rejects.toMatchObject({
      status: 400,
      message: 'invalid_slack_identity',
    });
  } finally {
    vi.useRealTimers();
  }
});
it.each(['exp', 'nbf'])('keeps signed %s strict despite tolerated future iat', async (claim) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
  try {
    const now = Math.floor(Date.now() / 1000);
    fixtures(await token({ iat: now + 30, [claim]: claim === 'exp' ? now - 1 : now + 1 }));
    await expect(verify()).rejects.toMatchObject({
      status: 400,
      message: 'invalid_slack_identity',
    });
  } finally {
    vi.useRealTimers();
  }
});
it('rejects invalid signature', async () => {
  fixtures(await token({}, true));
  await expect(verify()).rejects.toMatchObject({ status: 400 });
});
it('rejects nonce from another link flow', async () => {
  fixtures(await token());
  await expect(verify('c'.repeat(64))).rejects.toMatchObject({ status: 400 });
});
it.each([
  {
    ok: true,
    sub: 'U456',
    'https://slack.com/team_id': 'T123',
    'https://slack.com/user_id': 'U456',
  },
  {
    ok: true,
    sub: 'U123',
    'https://slack.com/team_id': 'T456',
    'https://slack.com/user_id': 'U123',
  },
  { ok: false, error: 'private-profile' },
])('rejects mismatched userInfo identity', async (info) => {
  fixtures(await token(), { info });
  await expect(verify()).rejects.toMatchObject({ status: 400 });
});
it.each(['JWT', 'JWKS', 'token', 'userInfo'])(
  'bounds %s before accepting identity',
  async (kind) => {
    fixtures(kind === 'JWT' ? 'x'.repeat(16385) : await token(), {
      ...(kind === 'JWKS' ? { keys: { padding: 'x'.repeat(262145) } } : {}),
      ...(kind === 'token' ? { tokenResponse: { padding: 'x'.repeat(65537) } } : {}),
      ...(kind === 'userInfo' ? { info: { padding: 'x'.repeat(65537) } } : {}),
    });
    await expect(verify()).rejects.toMatchObject({ status: 400 });
  },
);
it('rejects redirect and never follows provider-controlled endpoints', async () => {
  fixtures(await token(), { redirect: true });
  await expect(verify()).rejects.toMatchObject({ status: 400 });
});
it('aborted verification fails closed with body-free error', async () => {
  fixtures(await token());
  await expect(verify(nonceHash, AbortSignal.abort())).rejects.toMatchObject({ status: 400 });
});
it('ignores JWT header URLs and accepts only allowlisted signing keys', async () => {
  const signed = await new SignJWT({
    iss: 'https://slack.com',
    aud: 'fixture-client',
    sub: 'U123',
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce,
    'https://slack.com/team_id': 'T123',
    'https://slack.com/user_id': 'U123',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key', jku: 'https://evil.example.com/keys' })
    .sign(keys.privateKey);
  fixtures(signed);
  expect(await verify()).toEqual({ teamId: 'T123', userId: 'U123' });
});
it.each([
  { ok: false, error: 'private-token-error' },
  { ok: true, token_type: 'Basic', access_token: 'fixture-access', id_token: 'private' },
  { ok: true, token_type: 'Bearer', access_token: 123, id_token: 'private' },
])('rejects malformed token responses without exposing provider payload', async (tokenResponse) => {
  fixtures(await token(), { tokenResponse });
  await expect(verify()).rejects.toMatchObject({ status: 400, message: 'invalid_slack_identity' });
});
it.each([
  { keys: [] },
  { keys: [{ kty: 'RSA', n: 'invalid', e: 'AQAB', d: 'private' }] },
  { keys: [{ kty: 'EC', crv: 'P-256' }] },
  { keys: 'invalid' },
])('rejects malformed or private JWKS material', async (keysResponse) => {
  fixtures(await token(), { keys: keysResponse });
  await expect(verify()).rejects.toMatchObject({ status: 400 });
});
it('rejects HS256 even when issuer, audience, nonce and Slack claims match', async () => {
  const signed = await new SignJWT({
    iss: 'https://slack.com',
    aud: 'fixture-client',
    sub: 'U123',
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce,
    'https://slack.com/team_id': 'T123',
    'https://slack.com/user_id': 'U123',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new Uint8Array(32));
  fixtures(signed);
  await expect(verify()).rejects.toMatchObject({ status: 400 });
});
it('rejects changed transient access token when signed at_hash is present', async () => {
  fixtures(await token({ at_hash: 'wrong-hash' }));
  await expect(verify()).rejects.toMatchObject({ status: 400 });
});
it('accepts signed access-token hash without persisting transient token', async () => {
  fixtures(
    await token({
      at_hash: createHash('sha256')
        .update('fixture-access')
        .digest()
        .subarray(0, 16)
        .toString('base64url'),
    }),
  );
  expect(await verify()).toEqual({ teamId: 'T123', userId: 'U123' });
});
it('bounds stalled exchange to ten seconds even if fetch ignores abort', async () => {
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
  const started = performance.now();
  await expect(verify()).rejects.toMatchObject({ status: 400, message: 'invalid_slack_identity' });
  expect(performance.now() - started).toBeLessThan(12000);
}, 15000);
it.each([
  undefined,
  null,
  [],
  {},
  { state: 'bad', code: 'fixture-code' },
  { state: 'a'.repeat(43), code: 'fixture-code', workspaceId: grant.workspaceId },
  { state: 'a'.repeat(43), code: 'fixture-code', error: 'access_denied' },
  { state: 'a'.repeat(43), code: 'fixture-code', error_description: 'private' },
  { state: 'a'.repeat(43), code: ['fixture-code'] },
  { state: 'a'.repeat(43), code: 'code\nprivate' },
  { state: 'a'.repeat(43), code: 'x'.repeat(4097) },
  { state: 'a'.repeat(43), error: 123 },
])(
  'rejects malformed callback before database access without trusted workspace',
  async (callback) => {
    const pool = new Pool({ connectionString: 'postgresql://clio:clio@127.0.0.1:5432/clio' });
    try {
      const links = createSlackLinkRepository(pool, null);
      await expect(
        links.complete({ userId: 'fixture-user', sessionId: 'fixture-session' }, callback),
      ).rejects.toMatchObject({ status: 400, message: 'invalid_request', workspaceId: undefined });
    } finally {
      await pool.end();
    }
  },
);
it.each([
  'invalid-origin',
  'https://api.example.com/path',
  'https://user:private@api.example.com',
  'https://api.example.com?x=1',
  'http://api.example.com',
  'https://api.example.com/',
  'https://api.example.com#fragment',
])('refuses untrusted callback origin shape %s', (origin) => {
  expect(() => slackCallbackUri(origin)).toThrow('unavailable');
});

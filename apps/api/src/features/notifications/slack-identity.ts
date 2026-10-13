import { createHash, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import { IdentityError } from '../identity/input.ts';
import type { NotificationGrant } from './config.ts';
import { boundedNotificationJson, field, notificationDeadline } from './http.ts';

export interface SlackIdentityProvider {
  verifyCode(input: {
    code: string;
    nonceHash: string;
    grant: NotificationGrant;
    signal: AbortSignal;
  }): Promise<{ teamId: string; userId: string }>;
}

const maximumFutureIssuedAtSkewSeconds = 60;

function invalid(): never {
  throw new IdentityError(400, 'invalid_slack_identity');
}
function scalar(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    /\s/u.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    invalid();
  return value;
}
function identity(value: unknown): { teamId: string; userId: string; subject: string } {
  const teamId = scalar(field(value, 'https://slack.com/team_id'), 128);
  const userId = scalar(field(value, 'https://slack.com/user_id'), 128);
  const subject = scalar(field(value, 'sub'), 128);
  if (!/^T[A-Z0-9]+$/.test(teamId) || !/^[UW][A-Z0-9]+$/.test(userId) || subject !== userId)
    invalid();
  return { teamId, userId, subject };
}
function keySet(value: unknown): JSONWebKeySet {
  const keys = field(value, 'keys');
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 100) invalid();
  const parsed: JSONWebKeySet = { keys: [] };
  for (const key of keys) {
    // Only public RSA signing material from Slack's fixed endpoint is accepted.
    if (field(key, 'kty') !== 'RSA' || field(key, 'd') !== undefined) invalid();
    const alg = field(key, 'alg');
    const use = field(key, 'use');
    if ((alg !== undefined && alg !== 'RS256') || (use !== undefined && use !== 'sig')) invalid();
    parsed.keys.push({
      kty: 'RSA',
      alg: 'RS256',
      use: 'sig',
      n: scalar(field(key, 'n'), 4096),
      e: scalar(field(key, 'e'), 128),
      ...(field(key, 'kid') === undefined ? {} : { kid: scalar(field(key, 'kid'), 256) }),
    });
  }
  return parsed;
}

/** Origin comes only from trusted server configuration, never callback/Host input. */
export function slackCallbackUri(callbackOrigin: string): string {
  let origin: URL;
  try {
    origin = new URL(callbackOrigin);
  } catch {
    throw new IdentityError(503, 'unavailable');
  }
  if (
    origin.origin !== callbackOrigin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      ))
  )
    throw new IdentityError(503, 'unavailable');
  return new URL('/api/notifications/slack/callback', origin).href;
}

export function createSlackIdentityProvider(callbackOrigin: string): SlackIdentityProvider {
  const redirectUri = slackCallbackUri(callbackOrigin);
  return {
    async verifyCode({ code, nonceHash, grant, signal }) {
      try {
        const slack = grant.slack;
        if (!slack || !/^[0-9a-f]{64}$/.test(nonceHash)) invalid();
        const deadline = notificationDeadline(signal, 10_000);
        const response = await boundedNotificationJson(
          new URL('https://slack.com/api/openid.connect.token'),
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code: scalar(code, 4096),
              client_id: slack.clientId,
              client_secret: slack.clientSecret,
              grant_type: 'authorization_code',
              redirect_uri: redirectUri,
            }).toString(),
          },
          deadline,
          65_536,
        );
        if (field(response, 'ok') !== true || field(response, 'token_type') !== 'Bearer') invalid();
        const idToken = scalar(field(response, 'id_token'), 16_384);
        const accessToken = scalar(field(response, 'access_token'), 16_384);
        const jwks = await boundedNotificationJson(
          new URL('https://slack.com/openid/connect/keys'),
          { method: 'GET' },
          deadline,
          262_144,
        );
        const { payload } = await jwtVerify(idToken, createLocalJWKSet(keySet(jwks)), {
          issuer: 'https://slack.com',
          audience: slack.clientId,
          algorithms: ['RS256'],
          requiredClaims: [
            'exp',
            'sub',
            'nonce',
            'https://slack.com/team_id',
            'https://slack.com/user_id',
          ],
        });
        const signedNonce = scalar(payload.nonce, 512);
        const digest = createHash('sha256').update(signedNonce).digest();
        if (!timingSafeEqual(digest, Buffer.from(nonceHash, 'hex'))) invalid();
        if (
          payload.iat !== undefined &&
          (!Number.isFinite(payload.iat) ||
            payload.iat > Date.now() / 1000 + maximumFutureIssuedAtSkewSeconds)
        )
          invalid();
        if (payload.at_hash !== undefined) {
          const expected = createHash('sha256')
            .update(accessToken)
            .digest()
            .subarray(0, 16)
            .toString('base64url');
          if (payload.at_hash !== expected) invalid();
        }
        const verified = identity(payload);
        if (verified.teamId !== slack.teamId) invalid();
        const userInfo = await boundedNotificationJson(
          new URL('https://slack.com/api/openid.connect.userInfo'),
          { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } },
          deadline,
          65_536,
        );
        if (field(userInfo, 'ok') !== true) invalid();
        const current = identity(userInfo);
        if (
          current.subject !== verified.subject ||
          current.teamId !== verified.teamId ||
          current.userId !== verified.userId ||
          deadline.aborted
        )
          invalid();
        return { teamId: verified.teamId, userId: verified.userId };
      } catch {
        // Provider/library exceptions can contain tokens or response bodies.
        return invalid();
      }
    },
  };
}

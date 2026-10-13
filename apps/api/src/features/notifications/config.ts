import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { readPrivateFile } from '../../lib/private-file.ts';
import { email, object, uuid } from '../identity/input.ts';
import { integer } from './input.ts';

export type SmtpProfile = Readonly<{
  host: string;
  port: number;
  user: string | null;
  password: string | null;
  from: string;
  ratePerMinute: number;
}>;
export type SlackProfile = Readonly<{
  teamId: string;
  botToken: string;
  clientId: string;
  clientSecret: string;
}>;
export type NotificationGrant = Readonly<{
  workspaceId: string;
  fingerprint: string;
  credentialFingerprint: string;
  smtp: SmtpProfile | null;
  slack: SlackProfile | null;
}>;
export type NotificationConfig = Readonly<{
  mode: 'live' | 'local_capture';
  publicOrigin: string;
  grants: readonly NotificationGrant[];
}>;
function text(value: unknown, maximum = 1024): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('Invalid configuration');
  return value;
}
function loopback(host: string): boolean {
  const normalized = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    (isIP(normalized) === 4 && normalized.startsWith('127.')) ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(normalized)
  );
}
function origin(value: unknown, mode: NotificationConfig['mode']): string {
  const raw = text(value, 2048);
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    raw !== url.origin ||
    (mode === 'live'
      ? url.protocol !== 'https:' || loopback(url.hostname)
      : url.protocol !== 'http:' || !loopback(url.hostname))
  )
    throw new Error('Invalid configuration');
  return url.origin;
}
function smtp(value: unknown, mode: NotificationConfig['mode']): SmtpProfile | null {
  if (value === null || value === undefined) return null;
  const row = object(value, [
    'host',
    'port',
    'tls',
    'user',
    'password',
    'from',
    'ratePerMinute',
    'credentialRevision',
  ]);
  const host = text(row.host, 253);
  if (!isIP(host) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))
    throw new Error('Invalid configuration');
  if (mode === 'live' ? row.tls !== true : row.tls !== false || !loopback(host))
    throw new Error('Invalid configuration');
  text(row.credentialRevision, 128);
  const user = row.user === null ? null : text(row.user, 256);
  const password = row.password === null ? null : text(row.password, 4096);
  if ((user === null) !== (password === null)) throw new Error('Invalid configuration');
  return Object.freeze({
    host,
    port: integer(row.port, 1, 65535),
    user,
    password,
    from: email(row.from),
    ratePerMinute: row.ratePerMinute === undefined ? 30 : integer(row.ratePerMinute, 1, 60),
  });
}
function slack(value: unknown, mode: NotificationConfig['mode']): SlackProfile | null {
  if (value === null || value === undefined) return null;
  if (mode !== 'live') throw new Error('Invalid configuration');
  const row = object(value, [
    'teamId',
    'botToken',
    'clientId',
    'clientSecret',
    'credentialRevision',
  ]);
  const teamId = text(row.teamId, 64);
  if (!/^T[A-Z0-9]+$/.test(teamId)) throw new Error('Invalid configuration');
  text(row.credentialRevision, 128);
  return Object.freeze({
    teamId,
    botToken: text(row.botToken, 4096),
    clientId: text(row.clientId, 256),
    clientSecret: text(row.clientSecret, 4096),
  });
}
export async function readNotificationConfig(
  env: NodeJS.ProcessEnv,
): Promise<NotificationConfig | null> {
  const path = env.NOTIFICATIONS_PRIVATE_CONFIG_FILE;
  if (path === undefined) return null;
  try {
    const row = object(JSON.parse(await readPrivateFile(path, 262144)), [
      'mode',
      'publicOrigin',
      'grants',
      'fingerprintKey',
    ]);
    if (row.mode !== 'live' && row.mode !== 'local_capture')
      throw new Error('Invalid configuration');
    const encodedKey = text(row.fingerprintKey, 43);
    const fingerprintKey = Buffer.from(encodedKey, 'base64url');
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(encodedKey) ||
      fingerprintKey.length !== 32 ||
      fingerprintKey.toString('base64url') !== encodedKey
    )
      throw new Error('Invalid configuration');
    const mode = row.mode;
    const publicOrigin = origin(row.publicOrigin, mode);
    if (!Array.isArray(row.grants) || row.grants.length < 1 || row.grants.length > 100)
      throw new Error('Invalid configuration');
    const ids = new Set<string>();
    const grants = row.grants.map((value: unknown) => {
      const grant = object(value, ['workspaceId', 'smtp', 'slack']);
      const workspaceId = uuid(grant.workspaceId);
      if (ids.has(workspaceId)) throw new Error('Invalid configuration');
      ids.add(workspaceId);
      const smtpProfile = smtp(grant.smtp, mode);
      const slackProfile = slack(grant.slack, mode);
      if (!smtpProfile && !slackProfile) throw new Error('Invalid configuration');
      const scope = {
        mode,
        publicOrigin,
        workspaceId,
        smtp: smtpProfile
          ? {
              host: smtpProfile.host.toLowerCase(),
              port: smtpProfile.port,
              user: smtpProfile.user,
              from: smtpProfile.from,
            }
          : null,
        slack: slackProfile
          ? { teamId: slackProfile.teamId, clientId: slackProfile.clientId }
          : null,
      };
      const fingerprint = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
      const credentialFingerprint = createHmac('sha256', fingerprintKey)
        .update('clio.notifications.credentials.v1\n')
        .update(
          JSON.stringify({
            scope,
            smtp: smtpProfile
              ? {
                  password: smtpProfile.password,
                  revision: object(grant.smtp, [
                    'host',
                    'port',
                    'tls',
                    'user',
                    'password',
                    'from',
                    'ratePerMinute',
                    'credentialRevision',
                  ]).credentialRevision,
                }
              : null,
            slack: slackProfile
              ? {
                  botToken: slackProfile.botToken,
                  clientSecret: slackProfile.clientSecret,
                  revision: object(grant.slack, [
                    'teamId',
                    'botToken',
                    'clientId',
                    'clientSecret',
                    'credentialRevision',
                  ]).credentialRevision,
                }
              : null,
          }),
        )
        .digest('hex');
      return Object.freeze({
        workspaceId,
        fingerprint,
        credentialFingerprint,
        smtp: smtpProfile,
        slack: slackProfile,
      });
    });
    return Object.freeze({ mode, publicOrigin, grants: Object.freeze(grants) });
  } catch {
    throw new Error('Invalid notification configuration');
  }
}
export function notificationGrant(
  config: NotificationConfig | null,
  workspaceId: string,
): NotificationGrant | null {
  return config?.grants.find((grant) => grant.workspaceId === workspaceId) ?? null;
}

export function smtpPacingKey(profile: SmtpProfile): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        profile.host.toLowerCase(),
        profile.port,
        profile.user,
        profile.from.toLowerCase(),
      ]),
    )
    .digest('hex');
}

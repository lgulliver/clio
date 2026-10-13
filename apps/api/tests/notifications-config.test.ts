import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notificationGrant,
  readNotificationConfig,
  smtpPacingKey,
} from '../src/features/notifications/config.ts';
import { readPrivateFile } from '../src/lib/private-file.ts';

const directories: string[] = [];
const workspaceId = randomUUID();
function capture() {
  return {
    fingerprintKey: Buffer.alloc(32, 7).toString('base64url'),
    mode: 'local_capture',
    publicOrigin: 'http://localhost:5173',
    grants: [
      {
        workspaceId,
        smtp: {
          host: '127.0.0.1',
          port: 1025,
          tls: false,
          user: null,
          password: null,
          from: 'clio@example.com',
          ratePerMinute: 30,
          credentialRevision: 'fixture-1',
        },
        slack: null,
      },
    ],
  };
}
async function fixture(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'clio-notification-fixture-'));
  directories.push(directory);
  const file = join(directory, 'config.json');
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}
async function read(value: unknown) {
  return readNotificationConfig({ NOTIFICATIONS_PRIVATE_CONFIG_FILE: await fixture(value) });
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe('notification private configuration', () => {
  it('starts absent/disabled, permits explicit loopback capture and scopes grants', async () => {
    expect(await readNotificationConfig({})).toBeNull();
    const config = await read(capture());
    expect(config?.mode).toBe('local_capture');
    expect(notificationGrant(config, workspaceId)?.smtp?.host).toBe('127.0.0.1');
    expect(notificationGrant(config, randomUUID())).toBeNull();
  });
  it('rejects non-loopback capture, injection, fractional ranges, partial auth and unknown fields', async () => {
    for (const change of [
      { host: 'smtp.example.com' },
      { from: 'clio@example.com\r\nBcc: leak@example.com' },
      { user: 'x\nAUTH' },
      { ratePerMinute: 61 },
      { ratePerMinute: 1.5 },
      { port: 0 },
      { user: 'fixture', password: null },
      { tls: true },
      { recipient: 'other@example.com' },
    ]) {
      const value = capture();
      const changed = {
        ...value,
        grants: value.grants.map((grant) => ({ ...grant, smtp: { ...grant.smtp, ...change } })),
      };
      await expect(read(changed)).rejects.toThrow('Invalid notification configuration');
    }
    await expect(read({ ...capture(), publicOrigin: 'http://example.com' })).rejects.toThrow(
      'Invalid notification configuration',
    );
    await expect(read({ ...capture(), publicOrigin: 'http://localhost/path' })).rejects.toThrow(
      'Invalid notification configuration',
    );
    await expect(
      read({ ...capture(), grants: [...capture().grants, ...capture().grants] }),
    ).rejects.toThrow('Invalid notification configuration');
  });
  it('requires HTTPS and implicit TLS in live mode; fingerprints origin, identity and credential revisions', async () => {
    const value = capture();
    const live = {
      ...value,
      mode: 'live',
      publicOrigin: 'https://clio.example.com',
      grants: value.grants.map((grant) => ({
        ...grant,
        smtp: { ...grant.smtp, host: 'smtp.example.com', port: 465, tls: true },
      })),
    };
    const config = await read(live);
    expect(config?.mode).toBe('live');
    const fingerprint = notificationGrant(config, workspaceId)?.fingerprint;
    expect(
      notificationGrant(
        await read({ ...live, publicOrigin: 'https://other.example.com' }),
        workspaceId,
      )?.fingerprint,
    ).not.toBe(fingerprint);
    await expect(read({ ...live, publicOrigin: 'http://clio.example.com' })).rejects.toThrow(
      'Invalid notification configuration',
    );
    await expect(read({ ...live, grants: value.grants })).rejects.toThrow(
      'Invalid notification configuration',
    );
    await expect(
      read({
        ...capture(),
        grants: [
          {
            workspaceId,
            smtp: null,
            slack: {
              teamId: 'T123',
              botToken: 'fixture-token',
              clientId: 'fixture-client',
              clientSecret: 'fixture-secret',
              credentialRevision: '1',
            },
          },
        ],
      }),
    ).rejects.toThrow('Invalid notification configuration');
  });
  it('reloads atomically replaced config and never falls back to an earlier snapshot', async () => {
    const file = await fixture(capture());
    const env = { NOTIFICATIONS_PRIVATE_CONFIG_FILE: file };
    const first = notificationGrant(
      await readNotificationConfig(env),
      workspaceId,
    )?.credentialFingerprint;
    const value = capture();
    const replacement = {
      ...value,
      grants: value.grants.map((grant) => ({
        ...grant,
        smtp: { ...grant.smtp, credentialRevision: 'fixture-rotated' },
      })),
    };
    await writeFile(`${file}.new`, JSON.stringify(replacement), { mode: 0o600 });
    await rename(`${file}.new`, file);
    expect(
      notificationGrant(await readNotificationConfig(env), workspaceId)?.credentialFingerprint,
    ).not.toBe(first);
    await writeFile(file, '{invalid fixture-private-value', { mode: 0o600 });
    await expect(readNotificationConfig(env)).rejects.toThrow('Invalid notification configuration');
    await rm(file);
    await expect(readNotificationConfig(env)).rejects.toThrow('Invalid notification configuration');
  });
  it('rejects wrong file owner using harmless ownership fixture', async () => {
    const file = await fixture(capture());
    if (!process.getuid) throw new Error('Ownership fixture requires POSIX');
    const uid = process.getuid();
    const mock = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    try {
      await expect(readPrivateFile(file, 65536)).rejects.toThrow('Invalid private file');
    } finally {
      mock.mockRestore();
    }
  });
  it('reuses private-file ownership/mode/symlink/size and Git exclusion checks', async () => {
    const file = await fixture(capture());
    expect(await readPrivateFile(file, 65536)).toContain('local_capture');
    await expect(readPrivateFile(file, 1)).rejects.toThrow('Invalid private file');
    await chmod(file, 0o644);
    await expect(readPrivateFile(file, 65536)).rejects.toThrow('Invalid private file');
    await chmod(file, 0o600);
    const link = `${file}.link`;
    await symlink(file, link);
    await expect(readPrivateFile(link, 65536)).rejects.toThrow('Invalid private file');
    await expect(readPrivateFile('relative.json', 65536)).rejects.toThrow('Invalid private file');
    const git = join(file, '..', '.git');
    await mkdir(git);
    await writeFile(join(git, 'HEAD'), 'ref: refs/heads/fixture');
    await expect(readPrivateFile(file, 65536)).rejects.toThrow('Invalid private file');
  });
});

it('shares SMTP pacing across password, rate and grant rotations but separates endpoint identities', () => {
  const profile = {
    host: 'smtp.example.com',
    port: 465,
    user: 'fixture-user',
    password: 'fixture-password-1',
    from: 'clio@example.com',
    ratePerMinute: 30,
  };
  expect(smtpPacingKey({ ...profile, password: 'fixture-password-2', ratePerMinute: 10 })).toBe(
    smtpPacingKey(profile),
  );
  expect(smtpPacingKey({ ...profile, host: 'SMTP.EXAMPLE.COM' })).toBe(smtpPacingKey(profile));
  expect(smtpPacingKey({ ...profile, user: 'other-fixture' })).not.toBe(smtpPacingKey(profile));
});

it('keeps scope stable across credentials, revisions, rates and HMAC key rotation', async () => {
  const captureValue = capture();
  const value = {
    ...captureValue,
    mode: 'live',
    publicOrigin: 'https://clio.example.com',
    grants: captureValue.grants.map((grant) => ({
      ...grant,
      smtp: {
        ...grant.smtp,
        host: 'smtp.example.com',
        port: 465,
        tls: true,
        user: 'fixture-user',
        password: 'fixture-password-1',
      },
    })),
  };
  const original = notificationGrant(await read(value), workspaceId);
  expect(original?.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
  for (const patch of [{ password: 'fixture-password-2' }, { credentialRevision: 'fixture-2' }]) {
    const rotated = notificationGrant(
      await read({
        ...value,
        grants: value.grants.map((grant) => ({ ...grant, smtp: { ...grant.smtp, ...patch } })),
      }),
      workspaceId,
    );
    expect(rotated?.fingerprint).toBe(original?.fingerprint);
    expect(rotated?.credentialFingerprint).not.toBe(original?.credentialFingerprint);
  }
  const keyed = await read({ ...value, fingerprintKey: Buffer.alloc(32, 8).toString('base64url') });
  expect(notificationGrant(keyed, workspaceId)?.fingerprint).toBe(original?.fingerprint);
  expect(notificationGrant(keyed, workspaceId)?.credentialFingerprint).not.toBe(
    original?.credentialFingerprint,
  );
  const rate = notificationGrant(
    await read({
      ...value,
      grants: value.grants.map((grant) => ({
        ...grant,
        smtp: { ...grant.smtp, ratePerMinute: 10 },
      })),
    }),
    workspaceId,
  );
  expect(rate?.fingerprint).toBe(original?.fingerprint);
  expect(rate?.credentialFingerprint).toBe(original?.credentialFingerprint);
  expect(JSON.stringify(keyed)).not.toContain('fingerprintKey');
  expect(JSON.stringify(keyed)).not.toContain(value.fingerprintKey);
});
it('rejects absent, padded, noncanonical and wrong-sized fingerprint keys', async () => {
  for (const fingerprintKey of [
    undefined,
    '',
    'x'.repeat(42),
    'x'.repeat(44),
    `${Buffer.alloc(32, 7).toString('base64url')}=`,
    'x'.repeat(43),
  ])
    await expect(read({ ...capture(), fingerprintKey })).rejects.toThrow(
      'Invalid notification configuration',
    );
});
it('refuses live loopback origins including IPv4, IPv6 and localhost aliases', async () => {
  const value = capture();
  const live = {
    ...value,
    mode: 'live',
    grants: value.grants.map((grant) => ({
      ...grant,
      smtp: { ...grant.smtp, host: 'smtp.example.com', port: 465, tls: true },
    })),
  };
  for (const publicOrigin of [
    'https://localhost',
    'https://localhost.',
    'https://service.localhost',
    'https://service.localhost.',
    'https://127.0.0.1',
    'https://127.2.3.4',
    'https://[::1]',
    'https://127.1',
    'https://2130706433',
    'https://0x7f000001',
  ])
    await expect(read({ ...live, publicOrigin })).rejects.toThrow(
      'Invalid notification configuration',
    );
});
it('fences Slack credentials separately from authorized team/client scope', async () => {
  const value = {
    ...capture(),
    mode: 'live',
    publicOrigin: 'https://clio.example.com',
    grants: [
      {
        workspaceId,
        smtp: null,
        slack: {
          teamId: 'T123',
          clientId: 'fixture-client',
          clientSecret: 'fixture-secret',
          botToken: 'fixture-token',
          credentialRevision: 'fixture-1',
        },
      },
    ],
  };
  const original = notificationGrant(await read(value), workspaceId);
  for (const patch of [
    { botToken: 'fixture-token-2' },
    { clientSecret: 'fixture-secret-2' },
    { credentialRevision: 'fixture-2' },
  ]) {
    const changed = notificationGrant(
      await read({
        ...value,
        grants: value.grants.map((grant) => ({ ...grant, slack: { ...grant.slack, ...patch } })),
      }),
      workspaceId,
    );
    expect(changed?.fingerprint).toBe(original?.fingerprint);
    expect(changed?.credentialFingerprint).not.toBe(original?.credentialFingerprint);
  }
  for (const patch of [{ teamId: 'T456' }, { clientId: 'fixture-client-2' }])
    expect(
      notificationGrant(
        await read({
          ...value,
          grants: value.grants.map((grant) => ({ ...grant, slack: { ...grant.slack, ...patch } })),
        }),
        workspaceId,
      )?.fingerprint,
    ).not.toBe(original?.fingerprint);
});
it('explicit capture permits canonical loopback forms without accepting public hosts', async () => {
  for (const publicOrigin of [
    'http://127.2.3.4:5173',
    'http://[::1]:5173',
    'http://localhost.:5173',
  ])
    expect((await read({ ...capture(), publicOrigin }))?.mode).toBe('local_capture');
  await expect(
    read({ ...capture(), publicOrigin: 'http://public.example.com:5173' }),
  ).rejects.toThrow('Invalid notification configuration');
});

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('rejects configured notifications without identity before opening the API', async () => {
  await rejectsStartup({});
}, 15000);
it('rejects a notification link origin outside the trusted app origin before opening the API', async () => {
  await rejectsStartup({
    AUTH_SECRET: 'notification-startup-fixture-only-secret-123456789',
    AUTH_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: 'http://localhost:5173',
    GITHUB_CLIENT_ID: 'fixture-client',
    GITHUB_CLIENT_SECRET: 'fixture-client-secret',
  });
}, 15000);

async function rejectsStartup(identity: NodeJS.ProcessEnv) {
  const directory = await mkdtemp(join(tmpdir(), 'clio-notifications-startup-'));
  try {
    const path = join(directory, 'notifications.json');
    await writeFile(
      path,
      JSON.stringify({
        mode: 'local_capture',
        publicOrigin: 'http://127.0.0.1:5173',
        fingerprintKey: randomBytes(32).toString('base64url'),
        grants: [
          {
            workspaceId: '11111111-1111-4111-8111-111111111111',
            smtp: {
              host: '127.0.0.1',
              port: 2525,
              tls: false,
              user: null,
              password: null,
              from: 'fixture@example.com',
              credentialRevision: 'fixture-1',
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const port = await unusedPort();
    const result = spawnSync(process.execPath, ['src/main.ts'], {
      cwd: process.cwd(),
      env: {
        DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture',
        HOST: '127.0.0.1',
        PORT: String(port),
        NOTIFICATIONS_PRIVATE_CONFIG_FILE: path,
        ...identity,
      },
      timeout: 10000,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('API startup failed; check configuration and local dependencies\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function unusedPort(): Promise<number> {
  const socket = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => resolve());
  });
  const address = socket.address();
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === 'string') throw new Error('Fixture port missing');
  return address.port;
}

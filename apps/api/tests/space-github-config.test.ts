import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readGitHubConfig } from '../src/features/github-collection/config.ts';
import { readSpaceGitHubConfig } from '../src/features/space-github/config.ts';

it('keeps absent config disabled and rejects partial or identical Apps', async () => {
  expect(await readSpaceGitHubConfig({}, null)).toBeNull();
  await expect(readSpaceGitHubConfig({ GITHUB_SPACE_APP_ID: '12' }, null)).rejects.toThrow(
    'Invalid SPACE GitHub configuration',
  );
  await expect(readSpaceGitHubConfig({ GITHUB_SPACE_APP_ID: '12' }, 12)).rejects.toThrow(
    'Invalid SPACE GitHub configuration',
  );
});
it('loads owner-only files and fingerprints PR capability independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clio-space-config-'));
  try {
    const key = join(directory, 'key.pem'),
      grants = join(directory, 'grants.json');
    await writeFile(
      key,
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }),
      { mode: 0o600 },
    );
    await writeFile(
      grants,
      JSON.stringify([
        {
          workspaceId: '00000000-0000-4000-8000-000000000001',
          installationId: 10,
          accountId: 30,
          accountType: 'Organization',
          repositoryIds: [20],
        },
      ]),
      { mode: 0o600 },
    );
    const env = {
      GITHUB_SPACE_APP_ID: '12',
      GITHUB_SPACE_APP_PRIVATE_KEY_FILE: key,
      GITHUB_SPACE_APP_GRANTS_FILE: grants,
    };
    const config = await readSpaceGitHubConfig(env, 11);
    expect(config?.profile).toBe('pull_requests:read,metadata:read');
    await expect(readSpaceGitHubConfig({ ...env, SPACE_GITHUB_APP_ID: '12' }, 11)).rejects.toThrow(
      'Invalid SPACE GitHub configuration',
    );
    await expect(readSpaceGitHubConfig(env, 12)).rejects.toThrow(
      'Invalid SPACE GitHub configuration',
    );
    expect(config?.grants[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const deployment = await readGitHubConfig({
      GITHUB_APP_ID: '12',
      GITHUB_APP_PRIVATE_KEY_FILE: key,
      GITHUB_APP_GRANTS_FILE: grants,
    });
    expect(config?.grants[0]?.fingerprint).not.toBe(deployment?.grants[0]?.fingerprint);
    await chmod(grants, 0o644);
    await expect(readSpaceGitHubConfig(env, null)).rejects.toThrow(
      'Invalid SPACE GitHub configuration',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  'SPACE_GITHUB_APP_ID',
  'SPACE_GITHUB_APP_PRIVATE_KEY_FILE',
  'SPACE_GITHUB_APP_GRANTS_FILE',
])('rejects populated deprecated %s instead of disabling silently', async (key) => {
  await expect(readSpaceGitHubConfig({ [key]: 'populated' }, null)).rejects.toThrow(
    'Invalid SPACE GitHub configuration',
  );
});

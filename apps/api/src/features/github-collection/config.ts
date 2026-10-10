import { createHash, createPrivateKey } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { object, uuid } from '../identity/input.ts';
import { positive } from './input.ts';

export interface GitHubGrant {
  readonly workspaceId: string;
  readonly installationId: number;
  readonly accountId: number;
  readonly accountType: 'User' | 'Organization';
  readonly repositoryIds: readonly number[];
  readonly fingerprint: string;
}
export interface GitHubConfig {
  readonly appId: number;
  readonly privateKey: string;
  readonly grants: readonly GitHubGrant[];
}
export function parseGrants(value: unknown, appId: number): readonly GitHubGrant[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid grants');
  const installations = new Set<number>();
  return Object.freeze(
    value.map((entry: unknown) => {
      const row = object(entry, [
        'workspaceId',
        'installationId',
        'accountId',
        'accountType',
        'repositoryIds',
      ]);
      const installationId = positive(row.installationId);
      if (
        installations.has(installationId) ||
        (row.accountType !== 'User' && row.accountType !== 'Organization') ||
        !Array.isArray(row.repositoryIds) ||
        row.repositoryIds.length < 1 ||
        row.repositoryIds.length > 100
      )
        throw new Error('Invalid grants');
      installations.add(installationId);
      const repositoryIds = row.repositoryIds.map(positive).sort((a, b) => a - b);
      if (new Set(repositoryIds).size !== repositoryIds.length) throw new Error('Invalid grants');
      const accountType: GitHubGrant['accountType'] = row.accountType;
      const grant = {
        workspaceId: uuid(row.workspaceId),
        installationId,
        accountId: positive(row.accountId),
        accountType,
        repositoryIds: Object.freeze(repositoryIds),
      };
      return Object.freeze({
        ...grant,
        fingerprint: createHash('sha256')
          .update(JSON.stringify({ appId, ...grant }))
          .digest('hex'),
      });
    }),
  );
}
async function privateFile(path: string, maxBytes: number) {
  if (!isAbsolute(path)) throw new Error('Invalid private file');
  const resolved = await realpath(path);
  if (resolved !== path) throw new Error('Invalid private file');
  // Reject files in any Git checkout, including this isolated writer worktree.
  for (let directory = dirname(resolved); ; directory = dirname(directory)) {
    let checkout = false;
    try {
      const gitPath = join(directory, '.git');
      const git = await lstat(gitPath);
      if (git.isDirectory()) {
        await access(join(gitPath, 'HEAD'));
        checkout = true;
      } else if (git.isFile() && git.size < 4096)
        checkout = (await readFile(gitPath, 'utf8')).startsWith('gitdir: ');
    } catch {}
    if (checkout) throw new Error('Invalid private file');
    if (dirname(directory) === directory) break;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 1 ||
      stat.size > maxBytes
    )
      throw new Error('Invalid private file');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error('Invalid private file');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}
export async function readGitHubConfig(env: NodeJS.ProcessEnv): Promise<GitHubConfig | null> {
  const values = [env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY_FILE, env.GITHUB_APP_GRANTS_FILE];
  if (values.every((value) => value === undefined)) return null;
  try {
    const [id, keyPath, grantPath] = values;
    if (!id || !/^\d+$/.test(id) || !keyPath || !grantPath)
      throw new Error('Invalid configuration');
    const appId = positive(Number(id));
    const privateKey = await privateFile(keyPath, 32768);
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new Error('Invalid key');
    const grants = parseGrants(JSON.parse(await privateFile(grantPath, 262144)), appId);
    return Object.freeze({ appId, privateKey, grants });
  } catch {
    throw new Error('Invalid GitHub collection configuration');
  }
}
export function grantFor(
  config: GitHubConfig | null,
  workspaceId: string,
  installationId: number,
  repositoryId: number,
): GitHubGrant | null {
  return (
    config?.grants.find(
      (grant) =>
        grant.workspaceId === workspaceId &&
        grant.installationId === installationId &&
        grant.repositoryIds.includes(repositoryId),
    ) ?? null
  );
}

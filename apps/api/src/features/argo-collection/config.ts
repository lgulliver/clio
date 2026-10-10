import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { ArgoScope } from '@clio/adapters';
import { text } from '../github-collection/input.ts';
import { object, uuid } from '../identity/input.ts';

export interface ArgoGrant extends ArgoScope {
  readonly tokenDigest: string;
  readonly fingerprint: string;
}
export interface ArgoConfig {
  readonly grants: readonly ArgoGrant[];
}
export const scopeKeys = [
  'sourceId',
  'workspaceId',
  'serviceId',
  'instance',
  'applicationUid',
  'applicationName',
  'applicationNamespace',
  'project',
  'destinationClusterId',
  'destinationServer',
  'destinationName',
  'destinationNamespace',
  'configurationRepositoryId',
  'repoURL',
  'environment',
] as const;
export function parseScope(value: unknown): ArgoScope {
  const row = object(value, scopeKeys);
  return {
    sourceId: uuid(row.sourceId),
    workspaceId: uuid(row.workspaceId),
    serviceId: uuid(row.serviceId),
    instance: text(row.instance),
    applicationUid: text(row.applicationUid),
    applicationName: text(row.applicationName),
    applicationNamespace: text(row.applicationNamespace),
    project: text(row.project),
    destinationClusterId: text(row.destinationClusterId),
    destinationServer: row.destinationServer === null ? null : text(row.destinationServer, 2048),
    destinationName: row.destinationName === null ? null : text(row.destinationName),
    destinationNamespace: text(row.destinationNamespace),
    configurationRepositoryId: text(row.configurationRepositoryId),
    repoURL: text(row.repoURL, 2048),
    environment: text(row.environment),
  };
}
export function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function scopeFor(grant: ArgoGrant): ArgoScope {
  return parseScope(Object.fromEntries(scopeKeys.map((key) => [key, grant[key]])));
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

export async function readArgoConfig(env: NodeJS.ProcessEnv): Promise<ArgoConfig | null> {
  if (env.ARGO_INGESTION_GRANTS_FILE === undefined) return null;
  try {
    const path = env.ARGO_INGESTION_GRANTS_FILE;
    if (!path) throw new Error('Invalid config');
    const entries: unknown = JSON.parse(await privateFile(path, 262144));
    if (!Array.isArray(entries) || entries.length > 100) throw new Error('Invalid config');
    const sources = new Set<string>(),
      applications = new Set<string>(),
      tokens = new Set<string>();
    const grants: ArgoGrant[] = [];
    for (const entry of entries) {
      const row = object(entry, [...scopeKeys, 'tokenFile']);
      const { tokenFile, ...rawScope } = row,
        scope = parseScope(rawScope);
      const token = await privateFile(text(tokenFile, 4096), 65);
      if (!/^[0-9a-f]{64}\n?$/.test(token)) throw new Error('Invalid token');
      const tokenDigest = digest(token.trim()),
        application = JSON.stringify([scope.instance, scope.applicationUid]);
      if (sources.has(scope.sourceId) || applications.has(application) || tokens.has(tokenDigest))
        throw new Error('Duplicate grant');
      sources.add(scope.sourceId);
      applications.add(application);
      tokens.add(tokenDigest);
      grants.push(
        Object.freeze({
          ...scope,
          tokenDigest,
          fingerprint: digest(JSON.stringify({ ...scope, tokenDigest })),
        }),
      );
    }
    return Object.freeze({ grants: Object.freeze(grants) });
  } catch {
    throw new Error('Invalid Argo ingestion configuration');
  }
}
export function grantFor(
  config: ArgoConfig | null,
  sourceId: string,
  workspaceId?: string,
  serviceId?: string,
): ArgoGrant | null {
  return (
    config?.grants.find(
      (g) =>
        g.sourceId === sourceId &&
        (workspaceId === undefined || g.workspaceId === workspaceId) &&
        (serviceId === undefined || g.serviceId === serviceId),
    ) ?? null
  );
}

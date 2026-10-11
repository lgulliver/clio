import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  MeasurementAuthorityScope,
  MeasurementBasis,
  MeasurementCapability,
} from '@clio/adapters';
import { snapshotDigest } from '../github-collection/digest.ts';
import { positive, text } from '../github-collection/input.ts';
import { name, object, uuid } from '../identity/input.ts';

export type MeasurementSource =
  | { provider: 'github'; installationId: number; repositoryId: number }
  | { provider: 'argocd'; sourceId: string };
export interface MeasurementGrant {
  readonly workspaceId: string;
  readonly serviceId: string;
  readonly source: MeasurementSource;
  readonly producerId: string;
  readonly capability: MeasurementCapability;
  readonly name: string;
  readonly policyRef: string;
  readonly productionPaths: readonly string[];
  readonly repositoryIds: readonly string[];
  readonly tokenDigest: string;
  readonly fingerprint: string;
}
export interface MeasurementConfig {
  readonly grants: readonly MeasurementGrant[];
}
export const capabilities = ['population', 'change_links', 'classification', 'recovery'] as const;
export function capability(value: unknown): MeasurementCapability {
  if (
    value === 'population' ||
    value === 'change_links' ||
    value === 'classification' ||
    value === 'recovery'
  )
    return value;
  throw new Error('Invalid measurement capability');
}
export function sourceScope(source: MeasurementSource): string {
  return source.provider === 'github'
    ? JSON.stringify(['github', source.installationId, source.repositoryId])
    : JSON.stringify(['argocd', source.sourceId]);
}
function strings(value: unknown, repositories = false): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid measurement scope');
  const entries = value.map((entry: unknown) => text(entry, 2048)).sort();
  if (
    new Set(entries).size !== entries.length ||
    (repositories && entries.some((s) => !/^[a-z][a-z0-9._-]*:[^\s:]+(?::[^\s:]+)*$/.test(s)))
  )
    throw new Error('Invalid measurement scope');
  return Object.freeze(entries);
}
export function parseMeasurementGrant(value: unknown, tokenDigest: string): MeasurementGrant {
  const row = object(value, [
    'workspaceId',
    'serviceId',
    'provider',
    'source',
    'producerId',
    'capability',
    'name',
    'policyRef',
    'productionPaths',
    'repositoryIds',
  ]);
  if (!/^[a-f0-9]{64}$/.test(tokenDigest)) throw new Error('Invalid measurement credential');
  let source: MeasurementSource;
  if (row.provider === 'github') {
    const s = object(row.source, ['installationId', 'repositoryId']);
    source = {
      provider: 'github',
      installationId: positive(s.installationId),
      repositoryId: positive(s.repositoryId),
    };
  } else if (row.provider === 'argocd') {
    const s = object(row.source, ['sourceId']);
    source = { provider: 'argocd', sourceId: uuid(s.sourceId) };
  } else throw new Error('Invalid measurement provider');
  const productionPaths = strings(row.productionPaths),
    repositoryIds = strings(row.repositoryIds, true);
  if (!productionPaths.length) throw new Error('Invalid production paths');
  const grant = {
    workspaceId: uuid(row.workspaceId),
    serviceId: uuid(row.serviceId),
    source: Object.freeze(source),
    producerId: uuid(row.producerId),
    capability: capability(row.capability),
    name: text(name(row.name)),
    policyRef: text(row.policyRef, 4096),
    productionPaths,
    repositoryIds,
    tokenDigest,
  };
  if (grant.capability === 'change_links' && !repositoryIds.length)
    throw new Error('Missing repositories');
  return Object.freeze({ ...grant, fingerprint: snapshotDigest(grant) });
}
export function authorityScope(
  grant: MeasurementGrant,
  basis: MeasurementBasis,
): MeasurementAuthorityScope {
  return {
    producerId: grant.producerId,
    workspaceId: grant.workspaceId,
    serviceId: grant.serviceId,
    capability: grant.capability,
    policyRef: grant.policyRef,
    basis,
    productionPaths: grant.productionPaths,
    repositoryIds: grant.repositoryIds,
  };
}
export function measurementGrantFor(
  config: MeasurementConfig | null,
  producerId: string,
): MeasurementGrant | null {
  return config?.grants.find((g) => g.producerId === producerId) ?? null;
}
export function credentialDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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

export async function readMeasurementConfig(
  env: NodeJS.ProcessEnv,
): Promise<MeasurementConfig | null> {
  if (env.CLIO_MEASUREMENT_GRANTS_FILE === undefined) return null;
  try {
    const entries: unknown = JSON.parse(
      await privateFile(env.CLIO_MEASUREMENT_GRANTS_FILE, 262144),
    );
    if (!Array.isArray(entries) || entries.length > 100) throw new Error('Invalid grants');
    const ids = new Set<string>(),
      tokens = new Set<string>(),
      grants: MeasurementGrant[] = [];
    for (const entry of entries) {
      const row = object(entry, [
        'workspaceId',
        'serviceId',
        'provider',
        'source',
        'producerId',
        'capability',
        'name',
        'policyRef',
        'productionPaths',
        'repositoryIds',
        'tokenFile',
      ]);
      const { tokenFile, ...scope } = row;
      const token = await privateFile(text(tokenFile, 4096), 65);
      if (!/^[a-f0-9]{64}\n?$/.test(token)) throw new Error('Invalid token');
      const grant = parseMeasurementGrant(scope, credentialDigest(token.trim()));
      if (ids.has(grant.producerId) || tokens.has(grant.tokenDigest))
        throw new Error('Duplicate grant');
      ids.add(grant.producerId);
      tokens.add(grant.tokenDigest);
      grants.push(grant);
    }
    return Object.freeze({ grants: Object.freeze(grants) });
  } catch {
    throw new Error('Invalid measurement configuration');
  }
}

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { ArgoScope } from '../../../packages/adapters/src/argo-notification.ts';
import { outsideGit, privateDirectory, readPrivate } from '../journal/storage.ts';

export function fail(code: string): never {
  throw new Error(code);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('capture_invalid_input');
  return Object.fromEntries(Object.entries(value));
}
export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = object(value);
  if (Object.keys(row).sort().join(',') !== [...keys].sort().join(','))
    fail('capture_invalid_input');
  return row;
}
export function text(value: unknown, max = 200): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    Array.from(value).length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    fail('capture_invalid_input');
  return value;
}
function uuid(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result)) fail('capture_invalid_input');
  return result.toLowerCase();
}
function path(value: unknown): string {
  const result = text(value, 4096);
  if (!isAbsolute(result) || resolve(result) !== result) fail('capture_private_path');
  return result;
}
export function parseScope(value: unknown): ArgoScope {
  const row = exact(value, [
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
  ]);
  const scope: ArgoScope = {
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
  // These fields enter a fixed raw API path/selector, not a shell or arbitrary URL.
  if (
    ![scope.applicationName, scope.applicationNamespace].every((value) =>
      /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value),
    )
  )
    fail('capture_invalid_input');
  return scope;
}
export interface CaptureConfig {
  journalDirectory: string;
  kubectlPath: string;
  kubeconfig: string;
  context: string;
  scope: ArgoScope;
  producerId: string;
  journalId: string;
  policyReference: string;
  receiver: { baseUrl: string; tokenFile: string };
}
export function parseConfig(value: unknown): CaptureConfig {
  const row = exact(value, [
    'journalDirectory',
    'kubectlPath',
    'kubeconfig',
    'context',
    'scope',
    'producerId',
    'journalId',
    'policyReference',
    'receiver',
  ]);
  const receiver = exact(row.receiver, ['baseUrl', 'tokenFile']);
  const baseUrl = text(receiver.baseUrl, 2048);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return fail('capture_endpoint');
  }
  if (
    url.username ||
    url.password ||
    baseUrl.includes('?') ||
    baseUrl.includes('#') ||
    url.pathname !== '/' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    fail('capture_endpoint');
  return {
    journalDirectory: path(row.journalDirectory),
    kubectlPath: path(row.kubectlPath),
    kubeconfig: path(row.kubeconfig),
    context: text(row.context),
    scope: parseScope(row.scope),
    producerId: uuid(row.producerId),
    journalId: uuid(row.journalId),
    policyReference: text(row.policyReference),
    receiver: { baseUrl, tokenFile: path(receiver.tokenFile) },
  };
}
export function rejectProxy(env: NodeJS.ProcessEnv): void {
  if (Object.entries(env).some(([key, value]) => /^(?:https?|all|no)_proxy$/i.test(key) && value))
    fail('capture_proxy_environment');
}
export async function validateConfig(config: CaptureConfig, env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '24')
    fail('capture_platform');
  rejectProxy(env);
  await privateDirectory(config.journalDirectory);
  for (const [file, limit] of [
    [config.kubeconfig, 512 * 1024],
    [config.receiver.tokenFile, 4096],
  ] as const) {
    await outsideGit(file);
    await readPrivate(file, limit);
  }
  if (
    (await realpath(config.kubectlPath)) !== config.kubectlPath ||
    !(await lstat(config.kubectlPath)).isFile()
  )
    fail('capture_executable');
  await access(config.kubectlPath, constants.X_OK);
}
export async function loadConfig(file: string): Promise<CaptureConfig> {
  await outsideGit(file);
  let value: unknown;
  try {
    value = JSON.parse(await readPrivate(file, 16384));
  } catch {
    return fail('capture_config');
  }
  return parseConfig(value);
}
export function fingerprint(config: CaptureConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

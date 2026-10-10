import { IdentityError, object, uuid } from '../identity/input.ts';

export function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new IdentityError(400, 'invalid_request');
  return value;
}
export function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid count');
  return value;
}
export function text(value: unknown, max = 200): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    !value ||
    Array.from(value).length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new IdentityError(400, 'invalid_request');
  return value;
}
export function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  )
    throw new Error('Invalid timestamp');
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) throw new Error('Invalid timestamp');
  return value;
}
export function instant(value: string): bigint {
  timestamp(value);
  return (
    BigInt(Date.parse(value)) * 1000n +
    BigInt((/\.(\d+)/.exec(value)?.[1] ?? '').padEnd(6, '0').slice(3))
  );
}
export function windowInput(value: unknown, now?: Date) {
  const row = object(value, ['start', 'end']);
  let start: string, end: string;
  try {
    start = timestamp(row.start);
    end = timestamp(row.end);
  } catch {
    throw new IdentityError(400, 'invalid_request');
  }
  if (![start, end].every((s) => /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0{1,6})?Z$/.test(s)))
    throw new IdentityError(400, 'invalid_request');
  const calendarDays = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (
    !Number.isInteger(calendarDays) ||
    calendarDays < 1 ||
    calendarDays > 90 ||
    (now && Date.parse(end) > now.getTime())
  )
    throw new IdentityError(400, 'invalid_request');
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    timezone: 'UTC' as const,
    calendarDays,
  };
}
export function connectionInput(value: unknown) {
  const row = object(value, [
    'expectedRevision',
    'installationId',
    'repositoryId',
    'productionEnvironment',
    'exposurePolicyReference',
    'repositoryDeploymentsBelongToService',
  ]);
  if (row.repositoryDeploymentsBelongToService !== true)
    throw new IdentityError(400, 'invalid_request');
  return {
    expectedRevision: row.expectedRevision === null ? null : positive(row.expectedRevision),
    installationId: positive(row.installationId),
    repositoryId: positive(row.repositoryId),
    productionEnvironment: text(row.productionEnvironment),
    exposurePolicyReference:
      row.exposurePolicyReference === null ? null : text(row.exposurePolicyReference),
    repositoryDeploymentsBelongToService: true as const,
  };
}
export function enqueueInput(value: unknown, now: Date) {
  const row = object(value, ['connectionRevision', 'requestId', 'window']);
  return {
    connectionRevision: positive(row.connectionRevision),
    requestId: uuid(row.requestId),
    window: windowInput(row.window, now),
  };
}
export interface Connection {
  workspaceId: string;
  serviceId: string;
  mode: 'live';
  provider: 'github';
  revision: number;
  active: boolean;
  installationId: number;
  repositoryId: number;
  repositoryName: string;
  accountLogin: string;
  productionEnvironment: string;
  exposurePolicyReference: string | null;
  repositoryDeploymentsBelongToService: true;
  observedAt: string;
  verifiedAt: string;
}
export function parseConnection(value: unknown): Connection {
  try {
    const row = object(value, [
      'workspaceId',
      'serviceId',
      'mode',
      'provider',
      'revision',
      'active',
      'installationId',
      'repositoryId',
      'repositoryName',
      'accountLogin',
      'productionEnvironment',
      'exposurePolicyReference',
      'repositoryDeploymentsBelongToService',
      'observedAt',
      'verifiedAt',
    ]);
    if (
      row.mode !== 'live' ||
      row.provider !== 'github' ||
      typeof row.active !== 'boolean' ||
      row.repositoryDeploymentsBelongToService !== true
    )
      throw new Error('Invalid connection');
    const observedAt = timestamp(row.observedAt),
      verifiedAt = timestamp(row.verifiedAt);
    if (instant(verifiedAt) > instant(observedAt)) throw new Error('Invalid connection time order');
    return {
      workspaceId: uuid(row.workspaceId),
      serviceId: uuid(row.serviceId),
      mode: row.mode,
      provider: row.provider,
      revision: positive(row.revision),
      active: row.active,
      installationId: positive(row.installationId),
      repositoryId: positive(row.repositoryId),
      repositoryName: text(row.repositoryName),
      accountLogin: text(row.accountLogin),
      productionEnvironment: text(row.productionEnvironment),
      exposurePolicyReference:
        row.exposurePolicyReference === null ? null : text(row.exposurePolicyReference),
      repositoryDeploymentsBelongToService: true,
      observedAt,
      verifiedAt,
    };
  } catch {
    throw new Error('Invalid stored GitHub connection');
  }
}

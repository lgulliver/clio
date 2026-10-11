import type { MetricResult } from '@clio/oems';
import { oemsContract } from '@clio/oems/contract';
import { ApiError, record } from '../identity/api';
import { parseMetricResult } from '../measurements/metric-result';

export type Scope = { workspaceId: string; serviceId: string };
export type Connection = Scope & {
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
};
export type Window = { start: string; end: string };
export type Result = Scope & {
  metricResult?: MetricResult;
  mode: 'live';
  connectionRevision: number;
  oemsRevision: string;
  window: Window & { timezone: 'UTC'; calendarDays: number };
  evidenceCutoff: string;
  transportComplete: boolean;
  deploymentCount: number;
  qualifyingCount: number;
  unknownCount: number;
  coverage: {
    collectionComplete: false;
    deploymentHistoryComplete: false;
    recoveryEvidenceComplete: false;
  };
  deploymentFrequency: {
    count: number;
    status: 'provisional';
    deploymentsPerDay: null;
    qualityReasons: string[];
  };
  changeFailureRate: null;
  failedDeploymentRecoveryTime: number | null;
};
export type Run = Scope & {
  id: string;
  mode: 'live';
  provider: 'github';
  connectionRevision: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  failureCode: string | null;
  result: Result | null;
};
function fail(): never {
  throw new ApiError(0);
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const item = record(value);
  if (
    Object.keys(item).length !== keys.length ||
    Object.keys(item).some((key) => !keys.includes(key))
  )
    fail();
  return item;
}
function integer(value: unknown, minimum = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : fail();
}
function text(value: unknown): string {
  return typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    [...value].length <= 200 &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ? value
    : fail();
}
function uuid(value: unknown): string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : fail();
}
function bind(item: Record<string, unknown>, scope: Scope) {
  if (
    item.workspaceId !== uuid(scope.workspaceId) ||
    item.serviceId !== uuid(scope.serviceId) ||
    item.mode !== 'live'
  )
    fail();
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string') return fail();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/.exec(value);
  if (
    !match ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1] ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  )
    return fail();
  return value;
}
function instant(value: string): bigint {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}
function midnight(value: unknown): string {
  const time = timestamp(value);
  if (!/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0{1,6})?Z$/.test(time)) return fail();
  return time;
}
export function closedWindow(startDate: string, endDate: string, now = Date.now()): Window {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return fail();
  const start = midnight(`${startDate}T00:00:00Z`);
  const end = midnight(`${endDate}T00:00:00Z`);
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (days < 1 || days > 90 || Date.parse(end) > now) return fail();
  return { start, end };
}
export function positiveId(value: string): number {
  if (!/^[0-9]+$/.test(value)) return fail();
  return integer(Number(value), 1);
}
function connection(value: unknown, scope: Scope): Connection {
  const item = exact(value, [
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
  bind(item, scope);
  if (
    item.provider !== 'github' ||
    typeof item.active !== 'boolean' ||
    item.repositoryDeploymentsBelongToService !== true
  )
    return fail();
  const observedAt = timestamp(item.observedAt),
    verifiedAt = timestamp(item.verifiedAt);
  if (instant(verifiedAt) > instant(observedAt)) return fail();
  return {
    ...scope,
    mode: 'live',
    provider: 'github',
    revision: integer(item.revision, 1),
    active: item.active,
    installationId: integer(item.installationId, 1),
    repositoryId: integer(item.repositoryId, 1),
    repositoryName: text(item.repositoryName),
    accountLogin: text(item.accountLogin),
    productionEnvironment: text(item.productionEnvironment),
    exposurePolicyReference:
      item.exposurePolicyReference === null ? null : text(item.exposurePolicyReference),
    repositoryDeploymentsBelongToService: true,
    observedAt,
    verifiedAt,
  };
}
export function parseConnection(
  value: unknown,
  scope: Scope,
): { connection: Connection | null; configured: boolean } {
  const item = exact(value, ['connection', 'configured']);
  if (typeof item.configured !== 'boolean') return fail();
  return {
    connection: item.connection === null ? null : connection(item.connection, scope),
    configured: item.configured,
  };
}
export function parseSavedConnection(
  value: unknown,
  scope: Scope,
  previous: number | null,
  active: boolean,
): Connection {
  const parsed = connection(exact(value, ['connection']).connection, scope);
  if (parsed.revision !== (previous ?? 0) + 1 || parsed.active !== active) return fail();
  return parsed;
}
function result(value: unknown, scope: Scope, revision: number): Result {
  const raw = record(value);
  const item = exact(value, [
    ...(Object.hasOwn(raw, 'metricResult') ? ['metricResult'] : []),
    'mode',
    'workspaceId',
    'serviceId',
    'connectionRevision',
    'oemsRevision',
    'window',
    'evidenceCutoff',
    'transportComplete',
    'deploymentCount',
    'qualifyingCount',
    'unknownCount',
    'coverage',
    'deploymentFrequency',
    'changeFailureRate',
    'failedDeploymentRecoveryTime',
  ]);
  bind(item, scope);
  const window = exact(item.window, ['start', 'end', 'timezone', 'calendarDays']);
  const coverage = exact(item.coverage, [
    'collectionComplete',
    'deploymentHistoryComplete',
    'recoveryEvidenceComplete',
  ]);
  const frequency = exact(item.deploymentFrequency, [
    'count',
    'status',
    'deploymentsPerDay',
    'qualityReasons',
  ]);
  const start = midnight(window.start),
    end = midnight(window.end),
    evidenceCutoff = timestamp(item.evidenceCutoff);
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (
    item.connectionRevision !== revision ||
    item.oemsRevision !== oemsContract.revision ||
    window.timezone !== 'UTC' ||
    days < 1 ||
    days > 90 ||
    window.calendarDays !== days ||
    instant(evidenceCutoff) < instant(end) ||
    typeof item.transportComplete !== 'boolean' ||
    Object.values(coverage).some((value) => value !== false) ||
    frequency.status !== 'provisional' ||
    frequency.deploymentsPerDay !== null ||
    !Array.isArray(frequency.qualityReasons) ||
    frequency.qualityReasons.length === 0 ||
    frequency.qualityReasons.length > 50 ||
    item.changeFailureRate !== null ||
    (!Object.hasOwn(item, 'metricResult') && item.failedDeploymentRecoveryTime !== null)
  )
    return fail();
  const reasons = frequency.qualityReasons.map((reason: unknown) => text(reason));
  const deploymentCount = integer(item.deploymentCount),
    qualifyingCount = integer(item.qualifyingCount),
    unknownCount = integer(item.unknownCount),
    count = integer(frequency.count);
  if (
    qualifyingCount > deploymentCount ||
    unknownCount > deploymentCount - qualifyingCount ||
    count > qualifyingCount ||
    new Set(reasons).size !== reasons.length
  )
    return fail();
  const metricResult = Object.hasOwn(item, 'metricResult')
    ? parseMetricResult(item.metricResult, {
        serviceId: scope.serviceId,
        window: { start, end, calendarDays: days },
        evidenceCutoff,
        unknownCount,
        deploymentFrequency: {
          count,
          status: 'provisional',
          deploymentsPerDay: null,
          qualityReasons: reasons,
        },
        changeFailureRate: null,
        failedDeploymentRecoveryTime:
          typeof item.failedDeploymentRecoveryTime === 'number'
            ? item.failedDeploymentRecoveryTime
            : null,
      })
    : undefined;
  if (
    metricResult &&
    metricResult.failed_deployment_recovery_time.median_seconds !==
      item.failedDeploymentRecoveryTime
  )
    return fail();
  return {
    ...(metricResult ? { metricResult } : {}),
    ...scope,
    mode: 'live',
    connectionRevision: revision,
    oemsRevision: oemsContract.revision,
    window: { start, end, timezone: 'UTC', calendarDays: days },
    evidenceCutoff,
    transportComplete: item.transportComplete,
    deploymentCount,
    qualifyingCount,
    unknownCount,
    coverage: {
      collectionComplete: false,
      deploymentHistoryComplete: false,
      recoveryEvidenceComplete: false,
    },
    deploymentFrequency: {
      count,
      status: 'provisional',
      deploymentsPerDay: null,
      qualityReasons: reasons,
    },
    changeFailureRate: null,
    failedDeploymentRecoveryTime:
      metricResult?.failed_deployment_recovery_time.median_seconds ?? null,
  };
}
function run(value: unknown, scope: Scope): Run {
  const item = exact(value, [
    'id',
    'workspaceId',
    'serviceId',
    'mode',
    'provider',
    'connectionRevision',
    'status',
    'attempts',
    'createdAt',
    'updatedAt',
    'completedAt',
    'failureCode',
    'result',
  ]);
  bind(item, scope);
  if (
    item.provider !== 'github' ||
    (item.status !== 'pending' &&
      item.status !== 'running' &&
      item.status !== 'succeeded' &&
      item.status !== 'failed')
  )
    return fail();
  const revision = integer(item.connectionRevision, 1),
    attempts = integer(item.attempts),
    createdAt = timestamp(item.createdAt),
    updatedAt = timestamp(item.updatedAt),
    completedAt = item.completedAt === null ? null : timestamp(item.completedAt);
  const terminal = item.status === 'succeeded' || item.status === 'failed';
  if (
    attempts > 3 ||
    terminal !== (completedAt !== null) ||
    (item.status === 'failed'
      ? typeof item.failureCode !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(item.failureCode)
      : item.failureCode !== null) ||
    (item.status === 'succeeded' ? item.result === null : item.result !== null) ||
    instant(updatedAt) < instant(createdAt) ||
    (completedAt !== null &&
      (instant(completedAt) < instant(createdAt) || instant(completedAt) > instant(updatedAt)))
  )
    return fail();
  const parsedResult = item.status === 'succeeded' ? result(item.result, scope, revision) : null;
  if (
    parsedResult &&
    (completedAt === null ||
      instant(parsedResult.evidenceCutoff) > instant(completedAt) ||
      instant(parsedResult.evidenceCutoff) < instant(createdAt))
  )
    return fail();
  return {
    ...scope,
    id: uuid(item.id),
    mode: 'live',
    provider: 'github',
    connectionRevision: revision,
    status: item.status,
    attempts,
    createdAt,
    updatedAt,
    completedAt,
    failureCode: item.status === 'failed' ? text(item.failureCode) : null,
    result: parsedResult,
  };
}
export function parseRun(
  value: unknown,
  scope: Scope,
  expectedRevision?: number,
  expectedId?: string,
  expectedWindow?: Window,
): Run {
  const parsed = run(exact(value, ['run']).run, scope);
  if (
    (expectedRevision !== undefined && parsed.connectionRevision !== expectedRevision) ||
    (expectedId !== undefined && parsed.id !== expectedId)
  )
    return fail();
  if (
    expectedWindow &&
    parsed.result &&
    (instant(parsed.result.window.start) !== instant(expectedWindow.start) ||
      instant(parsed.result.window.end) !== instant(expectedWindow.end))
  )
    return fail();
  return parsed;
}
export function newestFirst(left: Run, right: Run): number {
  const difference = instant(right.createdAt) - instant(left.createdAt);
  return difference > 0n ? 1 : difference < 0n ? -1 : right.id.localeCompare(left.id);
}
export function parseRuns(value: unknown, scope: Scope): Run[] {
  const items = exact(value, ['runs']).runs;
  if (!Array.isArray(items) || items.length > 25) return fail();
  const runs = items.map((item: unknown) => run(item, scope));
  if (new Set(runs.map((item) => item.id.toLowerCase())).size !== runs.length) return fail();
  for (let index = 1; index < runs.length; index++) {
    const prior = runs[index - 1],
      current = runs[index];
    if (!prior || !current || instant(prior.createdAt) < instant(current.createdAt)) return fail();
  }
  return runs;
}

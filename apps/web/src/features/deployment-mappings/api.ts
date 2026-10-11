import type { MetricResult } from '@clio/oems';
import { oemsContract } from '@clio/oems/contract';
import { ApiError, record } from '../identity/api';
import { parseLifecycleResult } from './lifecycle-result';

export type Scope = { workspaceId: string; serviceId: string };
export type MockScenario = 'partial' | 'complete-lifecycle';
export function parseScenario(value: unknown): MockScenario {
  if (value === undefined) return 'partial';
  return value === 'partial' || value === 'complete-lifecycle' ? value : fail();
}
export type Draft = {
  scenario?: MockScenario;
  primaryProvider: 'github' | 'argocd';
  productionEnvironment: string;
  exposureAttested: boolean;
};
export type Mapping = Scope & Draft & { mode: 'mock'; revision: number; observedAt: string };
export type Preview = Scope & {
  mode: 'mock';
  scenario?: 'complete-lifecycle';
  resultVersion?: 'clio.mock.lifecycle.v1';
  metricResult?: MetricResult;
  mappingRevision: number;
  oemsRevision: string;
  window: { start: string; end: string; timezone: 'UTC'; calendarDays: number };
  evidenceCutoff: string;
  qualification: 'qualifying' | 'unknown' | 'excluded';
  rolloutCount: number;
  coverage: {
    collectionComplete: boolean;
    deploymentHistoryComplete: boolean;
    recoveryEvidenceComplete: boolean;
  };
  deploymentFrequency: {
    count: number;
    status: MetricResult['deployment_frequency']['status'];
    deploymentsPerDay: number | null;
    qualityReasons: string[];
  };
  changeFailureRate: number | null;
  failedDeploymentRecoveryTime: number | null;
};
// Response contract pin; validation/calculation remain server-side.
const oemsRevision = oemsContract.revision;
function fail(): never {
  throw new ApiError(0);
}
function integer(value: unknown, minimum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : fail();
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string') return fail();
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return fail();
  const calendarDate = new Date(`${match[1]}T00:00:00Z`);
  if (
    calendarDate.toISOString().slice(0, 10) !== match[1] ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  )
    return fail();
  return value;
}
function instant(value: string): bigint {
  const fractional = /\.(\d+)/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1000n + BigInt(fractional.padEnd(6, '0').slice(3));
}
function bind(item: Record<string, unknown>, scope: Scope) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    item.mode !== 'mock' ||
    item.workspaceId !== scope.workspaceId ||
    item.serviceId !== scope.serviceId ||
    !uuid.test(scope.workspaceId) ||
    !uuid.test(scope.serviceId)
  )
    fail();
}
export function parseMapping(value: unknown, scope: Scope): Mapping | null {
  const raw = record(value).mapping;
  if (raw === null) return null;
  const item = record(raw);
  bind(item, scope);
  if (
    (item.primaryProvider !== 'github' && item.primaryProvider !== 'argocd') ||
    typeof item.productionEnvironment !== 'string' ||
    item.productionEnvironment !== item.productionEnvironment.trim() ||
    [...item.productionEnvironment].length < 1 ||
    [...item.productionEnvironment].length > 200 ||
    typeof item.exposureAttested !== 'boolean'
  )
    return fail();
  const scenario = parseScenario(item.scenario);
  if (
    scenario === 'complete-lifecycle' &&
    (item.productionEnvironment !== 'production' || !item.exposureAttested)
  )
    return fail();
  return {
    ...(item.scenario === undefined ? {} : { scenario }),
    ...scope,
    mode: 'mock',
    revision: integer(item.revision, 1),
    primaryProvider: item.primaryProvider,
    productionEnvironment: item.productionEnvironment,
    exposureAttested: item.exposureAttested,
    observedAt: timestamp(item.observedAt),
  };
}
export function parseSavedMapping(value: unknown, scope: Scope, expectedRevision: number | null) {
  const mapping = parseMapping(value, scope);
  if (!mapping || mapping.revision !== (expectedRevision ?? 0) + 1) return fail();
  return mapping;
}
export function parsePreview(value: unknown, mapping: Mapping): Preview {
  const item = record(record(value).preview);
  bind(item, mapping);
  if (parseScenario(mapping.scenario) === 'complete-lifecycle')
    return parseLifecycleResult(item, mapping);
  if (
    item.scenario !== undefined ||
    item.resultVersion !== undefined ||
    item.metricResult !== undefined
  )
    return fail();
  const window = record(item.window);
  const coverage = record(item.coverage);
  const frequency = record(item.deploymentFrequency);
  if (
    item.mappingRevision !== mapping.revision ||
    item.oemsRevision !== oemsRevision ||
    window.timezone !== 'UTC' ||
    (item.qualification !== 'qualifying' &&
      item.qualification !== 'unknown' &&
      item.qualification !== 'excluded') ||
    coverage.collectionComplete !== false ||
    coverage.deploymentHistoryComplete !== false ||
    coverage.recoveryEvidenceComplete !== false ||
    frequency.status !== 'provisional' ||
    frequency.deploymentsPerDay !== null ||
    !Array.isArray(frequency.qualityReasons) ||
    item.changeFailureRate !== null ||
    item.failedDeploymentRecoveryTime !== null
  )
    return fail();
  const start = timestamp(window.start);
  const end = timestamp(window.end);
  const cutoff = timestamp(item.evidenceCutoff);
  if (instant(start) >= instant(end) || instant(cutoff) < instant(mapping.observedAt))
    return fail();
  return {
    workspaceId: mapping.workspaceId,
    serviceId: mapping.serviceId,
    mode: 'mock',
    mappingRevision: mapping.revision,
    oemsRevision,
    window: { start, end, timezone: 'UTC', calendarDays: integer(window.calendarDays, 1) },
    evidenceCutoff: cutoff,
    qualification: item.qualification,
    rolloutCount: integer(item.rolloutCount, 0),
    coverage: {
      collectionComplete: false,
      deploymentHistoryComplete: false,
      recoveryEvidenceComplete: false,
    },
    deploymentFrequency: {
      count: integer(frequency.count, 0),
      status: 'provisional',
      deploymentsPerDay: null,
      qualityReasons: frequency.qualityReasons.map((reason: unknown) =>
        typeof reason === 'string' && reason.trim() ? reason : fail(),
      ),
    },
    changeFailureRate: null,
    failedDeploymentRecoveryTime: null,
  };
}

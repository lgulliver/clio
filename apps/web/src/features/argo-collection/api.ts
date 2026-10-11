import { oemsContract } from '@clio/oems/contract';
import { ApiError, record } from '../identity/api';

export type Scope = { workspaceId: string; serviceId: string };
export type ArchiveProducer = {
  producerId: string;
  journalId: string;
  policyReference: string;
};
export type ArchiveSummary = ArchiveProducer & {
  lastSequence: number;
  lastSuccessfulReconciliationAt: string | null;
  sealedInterval: { start: string; end: string } | null;
  entryCount: number;
  gapCount: number;
  missingIntervalCount: number;
  missingIntervals: { start: string; end: string; reason: string }[];
  omittedIntervalCount: number;
};
export type EnrichmentProducer = {
  producerId: string;
  capability: 'consumer_exposure' | 'application_provenance';
  policyReference: string;
};
export type Connection = Scope & {
  mode: 'live';
  provider: 'argocd';
  revision: number;
  active: boolean;
  sourceId: string;
  applicationName: string;
  applicationNamespace: string;
  instance: string;
  productionEnvironment: string;
  exposurePolicyReference: string | null;
  enrichmentProducers?: EnrichmentProducer[];
  archiveProducer?: ArchiveProducer | null;
  applicationOperationsBelongToService: true;
  observedAt: string;
};
export type Source = {
  sourceId: string;
  applicationName: string;
  applicationNamespace: string;
  instance: string;
  environment: string;
  enrichmentProducers?: EnrichmentProducer[];
  archiveProducers?: ArchiveProducer[];
};
export type Window = { start: string; end: string };
export type CoverageAssessment = {
  version: 1;
  populationEvidence: 'not_supplied';
  firstDeploymentHistory: 'not_supplied';
  recoveryEvidence: 'not_supplied';
  unresolvedQualificationCount: number;
  historyQualifyingCount: number;
  incompleteChangeLinkCount: number;
  windowPopulationCount: number;
  unknownFailureCount: number;
  unknownReworkCount: number;
};
export type Result = Scope & {
  provider: 'argocd';
  mode: 'live';
  connectionRevision: number;
  oemsRevision: string;
  window: Window & { timezone: 'UTC'; calendarDays: number };
  evidenceCutoff: string;
  transportComplete: false;
  coverageAssessment?: CoverageAssessment;
  archiveSummary?: ArchiveSummary;
  enrichmentSummary?: {
    retainedReceiptCount: number;
    consumerExposureCount: number;
    applicationProvenanceCount: number;
    policies: EnrichmentProducer[];
  };
  retainedReceiptCount: number;
  retainedEvidenceCount: number;
  recordedGapCount: number;
  gapReasons: Record<string, number>;
  rejectionCount: number;
  scopeDriftCount: number;
  observationPeriod: { start: string | null; end: string };
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
  failedDeploymentRecoveryTime: null;
};
export type Run = Scope & {
  id: string;
  mode: 'live';
  provider: 'argocd';
  connectionRevision: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  failureCode: 'argo_processing_failed' | 'argo_connection_revoked' | null;
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
function producers(value: unknown): EnrichmentProducer[] {
  if (!Array.isArray(value) || value.length > 100) return fail();
  const result = value
    .map((entry: unknown): EnrichmentProducer => {
      const row = exact(entry, ['producerId', 'capability', 'policyReference']);
      if (row.capability !== 'consumer_exposure' && row.capability !== 'application_provenance')
        return fail();
      return {
        producerId: uuid(row.producerId),
        capability: row.capability,
        policyReference: text(row.policyReference),
      };
    })
    .sort((a, b) => a.producerId.localeCompare(b.producerId));
  if (new Set(result.map((entry) => entry.producerId.toLowerCase())).size !== result.length)
    return fail();
  return result;
}
function archiveProducer(value: unknown): ArchiveProducer {
  const row = exact(value, ['producerId', 'journalId', 'policyReference']);
  return {
    producerId: uuid(row.producerId),
    journalId: uuid(row.journalId),
    policyReference: text(row.policyReference),
  };
}
function archives(value: unknown): ArchiveProducer[] {
  if (!Array.isArray(value) || value.length > 100) return fail();
  const parsed = value.map((row: unknown) => archiveProducer(row));
  if (new Set(parsed.map((row) => row.producerId.toLowerCase())).size !== parsed.length)
    return fail();
  return parsed;
}
function archiveSummary(value: unknown, cutoff?: string): ArchiveSummary {
  const row = exact(value, [
    'producerId',
    'journalId',
    'policyReference',
    'lastSequence',
    'lastSuccessfulReconciliationAt',
    'sealedInterval',
    'entryCount',
    'gapCount',
    'missingIntervalCount',
    'missingIntervals',
    'omittedIntervalCount',
  ]);
  const producer = archiveProducer({
    producerId: row.producerId,
    journalId: row.journalId,
    policyReference: row.policyReference,
  });
  const lastSequence = integer(row.lastSequence),
    entryCount = integer(row.entryCount),
    gapCount = integer(row.gapCount);
  const missingIntervalCount = integer(row.missingIntervalCount),
    omittedIntervalCount = integer(row.omittedIntervalCount);
  const lastSuccessfulReconciliationAt =
    row.lastSuccessfulReconciliationAt === null
      ? null
      : timestamp(row.lastSuccessfulReconciliationAt);
  function interval(value: unknown) {
    const r = exact(value, ['start', 'end']),
      start = timestamp(r.start),
      end = timestamp(r.end);
    if (instant(start) >= instant(end) || (cutoff && instant(end) > instant(cutoff))) return fail();
    return { start, end };
  }
  const sealedInterval = row.sealedInterval === null ? null : interval(row.sealedInterval);
  if (!Array.isArray(row.missingIntervals) || row.missingIntervals.length > 32) return fail();
  const missingIntervals = row.missingIntervals.map((value: unknown) => {
    const r = exact(value, ['start', 'end', 'reason']);
    return { ...interval({ start: r.start, end: r.end }), reason: text(r.reason) };
  });
  if (
    lastSequence > 5000 ||
    entryCount > lastSequence ||
    gapCount > entryCount ||
    missingIntervalCount !== missingIntervals.length + omittedIntervalCount ||
    (sealedInterval === null) !== (lastSuccessfulReconciliationAt === null) ||
    (lastSuccessfulReconciliationAt !== null &&
      ((cutoff && instant(lastSuccessfulReconciliationAt) > instant(cutoff)) ||
        (sealedInterval !== null &&
          instant(sealedInterval.end) > instant(lastSuccessfulReconciliationAt))))
  )
    return fail();
  return {
    ...producer,
    lastSequence,
    lastSuccessfulReconciliationAt,
    sealedInterval,
    entryCount,
    gapCount,
    missingIntervalCount,
    missingIntervals,
    omittedIntervalCount,
  };
}
function enrichmentSummary(value: unknown) {
  const row = exact(value, [
    'retainedReceiptCount',
    'consumerExposureCount',
    'applicationProvenanceCount',
    'policies',
  ]);
  const retainedReceiptCount = integer(row.retainedReceiptCount),
    consumerExposureCount = integer(row.consumerExposureCount),
    applicationProvenanceCount = integer(row.applicationProvenanceCount);
  if (
    retainedReceiptCount > 5000 ||
    retainedReceiptCount !== consumerExposureCount + applicationProvenanceCount
  )
    return fail();
  return {
    retainedReceiptCount,
    consumerExposureCount,
    applicationProvenanceCount,
    policies: producers(row.policies),
  };
}
function connection(value: unknown, scope: Scope): Connection {
  const raw = record(value);
  const item = exact(value, [
    ...(Object.hasOwn(raw, 'enrichmentProducers') ? ['enrichmentProducers'] : []),
    ...(Object.hasOwn(raw, 'archiveProducer') ? ['archiveProducer'] : []),
    'workspaceId',
    'serviceId',
    'mode',
    'provider',
    'revision',
    'active',
    'sourceId',
    'applicationName',
    'applicationNamespace',
    'instance',
    'productionEnvironment',
    'exposurePolicyReference',
    'applicationOperationsBelongToService',
    'observedAt',
  ]);
  bind(item, scope);
  if (
    item.provider !== 'argocd' ||
    typeof item.active !== 'boolean' ||
    item.applicationOperationsBelongToService !== true
  )
    return fail();
  const observedAt = timestamp(item.observedAt);
  return {
    ...scope,
    mode: 'live',
    provider: 'argocd',
    revision: integer(item.revision, 1),
    active: item.active,
    sourceId: uuid(item.sourceId),
    applicationName: text(item.applicationName),
    applicationNamespace: text(item.applicationNamespace),
    instance: text(item.instance),
    productionEnvironment: text(item.productionEnvironment),
    exposurePolicyReference:
      item.exposurePolicyReference === null ? null : text(item.exposurePolicyReference),
    applicationOperationsBelongToService: true,
    observedAt,
    ...(Object.hasOwn(item, 'enrichmentProducers')
      ? { enrichmentProducers: producers(item.enrichmentProducers) }
      : {}),
    ...(Object.hasOwn(item, 'archiveProducer')
      ? {
          archiveProducer:
            item.archiveProducer === null ? null : archiveProducer(item.archiveProducer),
        }
      : {}),
  };
}
function source(value: unknown): Source {
  const raw = record(value);
  const item = exact(value, [
    ...(Object.hasOwn(raw, 'enrichmentProducers') ? ['enrichmentProducers'] : []),
    ...(Object.hasOwn(raw, 'archiveProducers') ? ['archiveProducers'] : []),
    'sourceId',
    'applicationName',
    'applicationNamespace',
    'instance',
    'environment',
  ]);
  return {
    sourceId: uuid(item.sourceId),
    applicationName: text(item.applicationName),
    applicationNamespace: text(item.applicationNamespace),
    instance: text(item.instance),
    environment: text(item.environment),
    ...(Object.hasOwn(item, 'enrichmentProducers')
      ? { enrichmentProducers: producers(item.enrichmentProducers) }
      : {}),
    ...(Object.hasOwn(item, 'archiveProducers')
      ? { archiveProducers: archives(item.archiveProducers) }
      : {}),
  };
}
export function parseConnection(
  value: unknown,
  scope: Scope,
): {
  connection: Connection | null;
  configured: boolean;
  sources: Source[];
  archiveStatus?: ArchiveSummary | null;
} {
  const raw = record(value);
  const item = exact(value, [
    'connection',
    'configured',
    'sources',
    ...(Object.hasOwn(raw, 'archiveStatus') ? ['archiveStatus'] : []),
  ]);
  if (
    typeof item.configured !== 'boolean' ||
    !Array.isArray(item.sources) ||
    item.sources.length > 100
  )
    return fail();
  const sources = item.sources.map((value: unknown) => source(value));
  if (
    new Set(sources.map((item) => item.sourceId.toLowerCase())).size !== sources.length ||
    item.configured !== sources.length > 0
  )
    return fail();
  return {
    connection: item.connection === null ? null : connection(item.connection, scope),
    configured: item.configured,
    sources,
    ...(Object.hasOwn(item, 'archiveStatus')
      ? { archiveStatus: item.archiveStatus === null ? null : archiveSummary(item.archiveStatus) }
      : {}),
  };
}
export function parseSavedConnection(
  value: unknown,
  scope: Scope,
  previous: number | null,
  active: boolean,
  expected?: Pick<
    Connection,
    | 'sourceId'
    | 'applicationName'
    | 'applicationNamespace'
    | 'instance'
    | 'productionEnvironment'
    | 'exposurePolicyReference'
    | 'enrichmentProducers'
    | 'archiveProducer'
  >,
): Connection {
  const parsed = connection(exact(value, ['connection']).connection, scope);
  if (parsed.revision !== (previous ?? 0) + 1 || parsed.active !== active) return fail();
  if (
    expected &&
    (parsed.sourceId !== expected.sourceId ||
      parsed.applicationName !== expected.applicationName ||
      parsed.applicationNamespace !== expected.applicationNamespace ||
      parsed.instance !== expected.instance ||
      parsed.productionEnvironment !== expected.productionEnvironment ||
      parsed.exposurePolicyReference !== expected.exposurePolicyReference ||
      (expected.enrichmentProducers !== undefined &&
        JSON.stringify(parsed.enrichmentProducers ?? []) !==
          JSON.stringify(expected.enrichmentProducers)) ||
      (expected.archiveProducer !== undefined &&
        JSON.stringify(parsed.archiveProducer ?? null) !==
          JSON.stringify(expected.archiveProducer)))
  )
    return fail();
  return parsed;
}
function coverageAssessment(
  value: unknown,
  totals: {
    unknownCount: number;
    qualifyingCount: number;
    frequencyCount: number;
  },
) {
  const row = exact(value, [
    'version',
    'populationEvidence',
    'firstDeploymentHistory',
    'recoveryEvidence',
    'unresolvedQualificationCount',
    'historyQualifyingCount',
    'incompleteChangeLinkCount',
    'windowPopulationCount',
    'unknownFailureCount',
    'unknownReworkCount',
  ]);
  const unresolvedQualificationCount = integer(row.unresolvedQualificationCount),
    historyQualifyingCount = integer(row.historyQualifyingCount),
    incompleteChangeLinkCount = integer(row.incompleteChangeLinkCount),
    windowPopulationCount = integer(row.windowPopulationCount),
    unknownFailureCount = integer(row.unknownFailureCount),
    unknownReworkCount = integer(row.unknownReworkCount);
  if (
    row.version !== 1 ||
    row.populationEvidence !== 'not_supplied' ||
    row.firstDeploymentHistory !== 'not_supplied' ||
    row.recoveryEvidence !== 'not_supplied' ||
    unresolvedQualificationCount !== totals.unknownCount ||
    historyQualifyingCount > totals.qualifyingCount ||
    windowPopulationCount !== totals.frequencyCount ||
    windowPopulationCount > historyQualifyingCount ||
    // Version 1 pins current adapter behavior: no complete links or known failure/rework.
    // Adding that evidence requires a new assessment version in both parsers, preserving old reads.
    incompleteChangeLinkCount !== historyQualifyingCount ||
    unknownFailureCount !== windowPopulationCount ||
    unknownReworkCount !== windowPopulationCount
  )
    return fail();
  return {
    version: 1 as const,
    populationEvidence: 'not_supplied' as const,
    firstDeploymentHistory: 'not_supplied' as const,
    recoveryEvidence: 'not_supplied' as const,
    unresolvedQualificationCount,
    historyQualifyingCount,
    incompleteChangeLinkCount,
    windowPopulationCount,
    unknownFailureCount,
    unknownReworkCount,
  };
}

function result(value: unknown, scope: Scope, revision: number): Result {
  const raw = record(value);
  const item = exact(value, [
    ...(Object.hasOwn(raw, 'coverageAssessment') ? ['coverageAssessment'] : []),
    ...(Object.hasOwn(raw, 'enrichmentSummary') ? ['enrichmentSummary'] : []),
    ...(Object.hasOwn(raw, 'archiveSummary') ? ['archiveSummary'] : []),
    'mode',
    'provider',
    'workspaceId',
    'serviceId',
    'connectionRevision',
    'oemsRevision',
    'window',
    'evidenceCutoff',
    'transportComplete',
    'retainedReceiptCount',
    'retainedEvidenceCount',
    'recordedGapCount',
    'gapReasons',
    'rejectionCount',
    'scopeDriftCount',
    'observationPeriod',
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
    item.provider !== 'argocd' ||
    item.connectionRevision !== revision ||
    item.oemsRevision !== oemsContract.revision ||
    window.timezone !== 'UTC' ||
    days < 1 ||
    days > 90 ||
    window.calendarDays !== days ||
    instant(evidenceCutoff) < instant(end) ||
    item.transportComplete !== false ||
    Object.values(coverage).some((value) => value !== false) ||
    frequency.status !== 'provisional' ||
    frequency.deploymentsPerDay !== null ||
    !Array.isArray(frequency.qualityReasons) ||
    frequency.qualityReasons.length === 0 ||
    frequency.qualityReasons.length > 50 ||
    item.changeFailureRate !== null ||
    item.failedDeploymentRecoveryTime !== null
  )
    return fail();
  const period = exact(item.observationPeriod, ['start', 'end']);
  const periodStart = period.start === null ? null : timestamp(period.start),
    periodEnd = timestamp(period.end);
  if (
    instant(periodEnd) > instant(evidenceCutoff) ||
    (periodStart !== null && instant(periodStart) > instant(periodEnd))
  )
    return fail();
  const retainedReceiptCount = integer(item.retainedReceiptCount),
    retainedEvidenceCount = integer(item.retainedEvidenceCount),
    recordedGapCount = integer(item.recordedGapCount),
    rejectionCount = integer(item.rejectionCount),
    scopeDriftCount = integer(item.scopeDriftCount);
  const gaps = record(item.gapReasons),
    gapReasons: Record<string, number> = {};
  const allowedReasons = [
    'unmarked_operation',
    'non_terminal',
    'missing_sync_result',
    'missing_health_timestamp',
    'multi_source',
    'source_hydrator',
    'future_timestamp',
    'invalid_operation_info',
    'observation_horizon',
    'status_combination_repeated',
    'status_combination_limit',
    'connection_interruption',
  ];
  let totalGaps = 0;
  for (const [reason, value] of Object.entries(gaps)) {
    if (!allowedReasons.includes(reason)) return fail();
    const count = integer(value);
    gapReasons[reason] = count;
    totalGaps += count;
  }
  if (!Number.isSafeInteger(totalGaps) || totalGaps !== recordedGapCount) return fail();
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
  return {
    ...scope,
    mode: 'live',
    connectionRevision: revision,
    oemsRevision: oemsContract.revision,
    window: { start, end, timezone: 'UTC', calendarDays: days },
    evidenceCutoff,
    provider: 'argocd',
    transportComplete: false,
    retainedReceiptCount,
    retainedEvidenceCount,
    recordedGapCount,
    gapReasons,
    rejectionCount,
    scopeDriftCount,
    observationPeriod: { start: periodStart, end: periodEnd },
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
    failedDeploymentRecoveryTime: null,
    ...(Object.hasOwn(item, 'coverageAssessment')
      ? {
          coverageAssessment: coverageAssessment(item.coverageAssessment, {
            unknownCount,
            qualifyingCount,
            frequencyCount: count,
          }),
        }
      : {}),
    ...(Object.hasOwn(item, 'enrichmentSummary')
      ? { enrichmentSummary: enrichmentSummary(item.enrichmentSummary) }
      : {}),
    ...(Object.hasOwn(item, 'archiveSummary')
      ? { archiveSummary: archiveSummary(item.archiveSummary, evidenceCutoff) }
      : {}),
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
    item.provider !== 'argocd' ||
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
      ? item.failureCode !== 'argo_processing_failed' &&
        item.failureCode !== 'argo_connection_revoked'
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
    provider: 'argocd',
    connectionRevision: revision,
    status: item.status,
    attempts,
    createdAt,
    updatedAt,
    completedAt,
    failureCode:
      item.failureCode === 'argo_processing_failed' ||
      item.failureCode === 'argo_connection_revoked'
        ? item.failureCode
        : null,
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

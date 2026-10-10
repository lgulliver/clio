import { oemsContract } from '@clio/oems';
import { type DeploymentMapping, revision } from '../deployment-mappings/input.ts';
import type { previewMapping } from '../deployment-mappings/preview.ts';
import { name, object, uuid } from '../identity/input.ts';

export function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 23) !== value.slice(0, 23)
  )
    throw new Error('Invalid stored timestamp');
  return value;
}
export function parseMapping(value: unknown): DeploymentMapping {
  const row = object(value, [
    'workspaceId',
    'serviceId',
    'mode',
    'revision',
    'primaryProvider',
    'productionEnvironment',
    'exposureAttested',
    'observedAt',
  ]);
  if (
    row.mode !== 'mock' ||
    (row.primaryProvider !== 'github' && row.primaryProvider !== 'argocd') ||
    typeof row.exposureAttested !== 'boolean'
  )
    throw new Error('Invalid captured mapping');
  return {
    workspaceId: uuid(row.workspaceId),
    serviceId: uuid(row.serviceId),
    mode: row.mode,
    revision: revision(row.revision),
    primaryProvider: row.primaryProvider,
    productionEnvironment: name(row.productionEnvironment),
    exposureAttested: row.exposureAttested,
    observedAt: timestamp(row.observedAt),
  };
}
function instant(value: string): bigint {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}
function storedRun(row: Record<string, unknown>) {
  const mapping = parseMapping(row.mapping_input);
  name(row.service_name);
  const status = row.status;
  if (status !== 'pending' && status !== 'running' && status !== 'succeeded' && status !== 'failed')
    throw new Error('Invalid run status');
  if (
    typeof row.attempts !== 'number' ||
    !Number.isInteger(row.attempts) ||
    row.attempts < 0 ||
    row.attempts > 3
  )
    throw new Error('Invalid run attempts');
  if (
    uuid(row.workspace_id) !== mapping.workspaceId ||
    uuid(row.service_id) !== mapping.serviceId ||
    Number(row.mapping_revision) !== mapping.revision
  )
    throw new Error('Invalid run scope');
  if ((status === 'pending' && row.attempts === 3) || (status !== 'pending' && row.attempts === 0))
    throw new Error('Invalid status attempts');
  const result = status === 'succeeded' ? parsePreview(row.result, mapping) : null;
  if (
    (status !== 'succeeded' && row.result !== null) ||
    row.failure_code !== (status === 'failed' ? 'mock_processing_failed' : null) ||
    (status === 'succeeded' || status === 'failed') !== (row.completed_at_text !== null)
  )
    throw new Error('Invalid stored run result');
  const createdAt = timestamp(row.created_at_text);
  const updatedAt = timestamp(row.updated_at_text);
  const completedAt = row.completed_at_text === null ? null : timestamp(row.completed_at_text);
  if (
    instant(createdAt) < instant(mapping.observedAt) ||
    instant(updatedAt) < instant(createdAt) ||
    (completedAt !== null &&
      (instant(completedAt) < instant(createdAt) || instant(completedAt) > instant(updatedAt))) ||
    (result !== null && instant(result.evidenceCutoff) < instant(mapping.observedAt))
  )
    throw new Error('Invalid stored run time order');
  return {
    id: uuid(row.id),
    workspaceId: mapping.workspaceId,
    serviceId: mapping.serviceId,
    mode: mapping.mode,
    mappingRevision: mapping.revision,
    mappingObservedAt: mapping.observedAt,
    primaryProvider: mapping.primaryProvider,
    status,
    attempts: row.attempts,
    createdAt,
    updatedAt,
    completedAt,
    failureCode: status === 'failed' ? 'mock_processing_failed' : null,
    result,
  };
}
export function run(row: Record<string, unknown>) {
  try {
    return storedRun(row);
  } catch {
    throw new Error('Invalid stored mock run');
  }
}

/** Public stored results are parsed without regenerating evidence or metrics. */
function parsePreview(
  value: unknown,
  mapping: DeploymentMapping,
): ReturnType<typeof previewMapping> {
  const row = object(value, [
    'mode',
    'workspaceId',
    'serviceId',
    'mappingRevision',
    'oemsRevision',
    'window',
    'evidenceCutoff',
    'qualification',
    'rolloutCount',
    'coverage',
    'deploymentFrequency',
    'changeFailureRate',
    'failedDeploymentRecoveryTime',
  ]);
  const window = object(row.window, ['start', 'end', 'timezone', 'calendarDays']);
  const coverage = object(row.coverage, [
    'collectionComplete',
    'deploymentHistoryComplete',
    'recoveryEvidenceComplete',
  ]);
  const frequency = object(row.deploymentFrequency, [
    'count',
    'status',
    'deploymentsPerDay',
    'qualityReasons',
  ]);
  if (
    row.mode !== 'mock' ||
    row.workspaceId !== mapping.workspaceId ||
    row.serviceId !== mapping.serviceId ||
    row.mappingRevision !== mapping.revision ||
    row.oemsRevision !== oemsContract.revision ||
    window.start !== '2026-01-01T00:00:00.000Z' ||
    window.end !== '2026-01-03T00:00:00.000Z' ||
    window.timezone !== 'UTC' ||
    window.calendarDays !== 2 ||
    coverage.collectionComplete !== false ||
    coverage.deploymentHistoryComplete !== false ||
    coverage.recoveryEvidenceComplete !== false ||
    (row.qualification !== 'qualifying' &&
      row.qualification !== 'unknown' &&
      row.qualification !== 'excluded') ||
    row.rolloutCount !== 1 ||
    frequency.status !== 'provisional' ||
    frequency.deploymentsPerDay !== null ||
    (frequency.count !== 0 && frequency.count !== 1) ||
    row.changeFailureRate !== null ||
    row.failedDeploymentRecoveryTime !== null ||
    !Array.isArray(frequency.qualityReasons) ||
    frequency.qualityReasons.length > 11
  )
    throw new Error('Invalid stored preview');
  const qualityReasons = frequency.qualityReasons.map((reason: unknown) => {
    if (
      reason !== 'incomplete_collection' &&
      reason !== 'unresolved_qualification' &&
      reason !== 'unknown_failure_classification' &&
      reason !== 'unknown_rework_classification' &&
      reason !== 'incomplete_history' &&
      reason !== 'incomplete_change_linkage' &&
      reason !== 'unresolved_change_links' &&
      reason !== 'incomplete_recovery_evidence' &&
      reason !== 'unresolved_causal_links' &&
      reason !== 'open_recovery_episodes' &&
      reason !== 'approximate_recovery_start'
    )
      throw new Error('Invalid stored quality reason');
    return reason;
  });
  if (!qualityReasons.includes('incomplete_collection'))
    throw new Error('Missing mock coverage warning');
  return {
    mode: row.mode,
    workspaceId: mapping.workspaceId,
    serviceId: mapping.serviceId,
    mappingRevision: mapping.revision,
    oemsRevision: row.oemsRevision,
    window: {
      start: window.start,
      end: window.end,
      timezone: window.timezone,
      calendarDays: window.calendarDays,
    },
    evidenceCutoff: timestamp(row.evidenceCutoff),
    qualification: row.qualification,
    rolloutCount: row.rolloutCount,
    coverage: {
      collectionComplete: false,
      deploymentHistoryComplete: false,
      recoveryEvidenceComplete: false,
    },
    deploymentFrequency: {
      count: frequency.count,
      status: frequency.status,
      deploymentsPerDay: null,
      qualityReasons,
    },
    changeFailureRate: null,
    failedDeploymentRecoveryTime: null,
  };
}
export const columns = `*, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_text, to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at_text`;
export function enqueueInput(value: unknown) {
  const body = object(value, ['revision', 'requestId']);
  return { revision: revision(body.revision), requestId: uuid(body.requestId) };
}

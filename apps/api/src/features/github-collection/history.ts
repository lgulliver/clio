import {
  type DeploymentEvidence,
  type EvidenceBatch,
  identity,
  type StatusEvidence,
} from '@clio/adapters';
import { object } from '../identity/input.ts';
import { snapshotDigest } from './digest.ts';
import { type Connection, instant, positive, text, timestamp } from './input.ts';

export const maxStoredBytes = 8 * 1024 * 1024;
export const maxHistoryRecords = 5000;
export function boundedJson(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > maxStoredBytes)
    throw new Error('Evidence size limit');
  return serialized;
}
function observations(row: Record<string, unknown>) {
  const eventAt = timestamp(row.eventAt),
    observedAt = timestamp(row.observedAt),
    revision = timestamp(row.revision);
  if (instant(eventAt) > instant(observedAt) || instant(revision) > instant(observedAt))
    throw new Error('Invalid evidence order');
  return { eventAt, observedAt, revision };
}
export function parseEvidence(value: unknown, connection: Connection): EvidenceBatch {
  const batch = object(value, ['deployments', 'statuses', 'completedStatusTraversals']);
  if (
    !Array.isArray(batch.deployments) ||
    !Array.isArray(batch.statuses) ||
    !Array.isArray(batch.completedStatusTraversals) ||
    batch.deployments.length + batch.statuses.length + batch.completedStatusTraversals.length >
      maxHistoryRecords
  )
    throw new Error('Evidence record limit');
  boundedJson(value);
  const sourceId = identity('github', String(connection.installationId)),
    repositoryId = connection.repositoryId;
  const deployments = batch.deployments.map((value: unknown): DeploymentEvidence => {
    const row = object(value, [
      'id',
      'sourceId',
      'sourceDeploymentId',
      'revision',
      'environment',
      'eventAt',
      'observedAt',
      'sourceRef',
      'repository',
      'reconciledConfigurationRevision',
      'configurationRepositoryId',
      'deploymentTask',
      'operationKind',
    ]);
    const operation = text(row.sourceDeploymentId, 2048);
    const match = /^repository:(\d+):deployment:(\d+)$/.exec(operation);
    if (!match || Number(match[1]) !== repositoryId) throw new Error('Evidence scope mismatch');
    const deploymentId = positive(Number(match[2]));
    const repository = object(row.repository, ['repositoryId', 'tipSha']);
    const tipSha = text(repository.tipSha);
    const sourceRef = `urn:clio:${identity('github', String(connection.installationId), 'repository', repositoryId, 'deployment', deploymentId)}`;
    if (
      operation !== identity('repository', repositoryId, 'deployment', deploymentId) ||
      row.sourceId !== sourceId ||
      row.id !== identity(sourceId, 'deployment', repositoryId, deploymentId) ||
      row.sourceRef !== sourceRef ||
      repository.repositoryId !==
        identity('github', String(connection.installationId), 'repository', repositoryId) ||
      !/^[0-9a-f]{40}$/.test(tipSha) ||
      row.reconciledConfigurationRevision !== null ||
      row.configurationRepositoryId !== null ||
      row.operationKind !== 'rollout'
    )
      throw new Error('Invalid GitHub deployment');
    return {
      id: text(row.id, 2048),
      sourceId,
      sourceDeploymentId: operation,
      ...observations(row),
      environment: text(row.environment),
      sourceRef,
      repository: { repositoryId: text(repository.repositoryId, 2048), tipSha },
      reconciledConfigurationRevision: null,
      configurationRepositoryId: null,
      deploymentTask: row.deploymentTask === null ? null : text(row.deploymentTask),
      operationKind: 'rollout',
    };
  });
  const statuses = batch.statuses.map((value: unknown): StatusEvidence => {
    const row = object(value, [
      'id',
      'deploymentId',
      'revision',
      'environment',
      'signal',
      'health',
      'consumerExposure',
      'eventAt',
      'observedAt',
      'sourceRef',
    ]);
    const id = text(row.id, 2048),
      statusId = positive(Number(id.split(':').at(-1))),
      signal = text(row.signal);
    const sourceRef = `urn:clio:${identity('github', String(connection.installationId), 'repository', repositoryId, 'status', statusId)}`;
    if (
      id !== identity(sourceId, 'status', repositoryId, statusId) ||
      row.sourceRef !== sourceRef ||
      row.health !== null ||
      row.consumerExposure !== false ||
      !['error', 'failure', 'inactive', 'in_progress', 'queued', 'pending', 'success'].includes(
        signal,
      )
    )
      throw new Error('Invalid GitHub status');
    return {
      id,
      deploymentId: text(row.deploymentId, 2048),
      ...observations(row),
      environment: text(row.environment),
      signal,
      health: null,
      consumerExposure: false,
      sourceRef,
    };
  });
  const completedStatusTraversals = batch.completedStatusTraversals.map((value: unknown) => {
    const row = object(value, ['deploymentId', 'observedAt']);
    return { deploymentId: text(row.deploymentId, 2048), observedAt: timestamp(row.observedAt) };
  });
  return { deployments, statuses, completedStatusTraversals };
}
function payload(record: DeploymentEvidence | StatusEvidence, ignoreRevision: boolean) {
  const { observedAt: _observed, ...rest } = record;
  if (ignoreRevision) {
    const { revision: _revision, ...payload } = rest;
    return snapshotDigest(payload);
  }
  return snapshotDigest(rest);
}
/** Retain every deployment metadata version, immutable status and earliest observation. */
export function mergeHistory(previous: EvidenceBatch, next: EvidenceBatch): EvidenceBatch {
  function merge<T extends DeploymentEvidence | StatusEvidence>(
    records: readonly T[],
    key: (record: T) => string,
    ignoreRevision = false,
  ) {
    const merged = new Map<string, T>();
    for (const record of records) {
      const k = key(record),
        old = merged.get(k);
      if (old && payload(old, ignoreRevision) !== payload(record, ignoreRevision))
        throw new Error('Conflicting source record');
      if (!old || instant(record.observedAt) < instant(old.observedAt)) merged.set(k, record);
    }
    return [...merged.values()].sort((a, b) => key(a).localeCompare(key(b)));
  }
  const deployments = merge([...previous.deployments, ...next.deployments], (record) =>
    identity(record.id, instant(record.revision).toString()),
  );
  const statuses = merge([...previous.statuses, ...next.statuses], (record) => record.id);
  const completed = new Map<string, { deploymentId: string; observedAt: string }>();
  for (const record of [
    ...(previous.completedStatusTraversals ?? []),
    ...(next.completedStatusTraversals ?? []),
  ]) {
    const old = completed.get(record.deploymentId);
    if (!old || instant(record.observedAt) > instant(old.observedAt))
      completed.set(record.deploymentId, record);
  }
  const known = new Map(deployments.map((record) => [record.id, record]));
  for (const record of statuses) {
    const deployment = known.get(record.deploymentId);
    if (!deployment || instant(record.eventAt) < instant(deployment.eventAt))
      throw new Error('Unresolved status deployment');
  }
  for (const record of completed.values())
    if (!known.has(record.deploymentId)) throw new Error('Unresolved traversal deployment');
  const result = {
    deployments,
    statuses,
    completedStatusTraversals: [...completed.values()].sort((a, b) =>
      a.deploymentId.localeCompare(b.deploymentId),
    ),
  };
  if (deployments.length + statuses.length + completed.size > maxHistoryRecords)
    throw new Error('Evidence record limit');
  boundedJson(result);
  return result;
}
export function historyRecords(batch: EvidenceBatch) {
  return [
    ...batch.deployments.map((record) => ({
      kind: 'deployment',
      key: identity(record.id, instant(record.revision).toString()),
      record,
    })),
    ...batch.statuses.map((record) => ({ kind: 'status', key: record.id, record })),
    ...(batch.completedStatusTraversals ?? []).map((record) => ({
      kind: 'traversal',
      key: record.deploymentId,
      record,
    })),
  ];
}

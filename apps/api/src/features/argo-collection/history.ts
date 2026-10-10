import {
  type ArgoScope,
  type DeploymentEvidence,
  type EvidenceBatch,
  identity,
  type StatusEvidence,
} from '@clio/adapters';
import { object, uuid } from '../identity/input.ts';
import { digest } from './config.ts';
import { instant, text, timestamp } from './input.ts';
export const maxRows = 5000,
  maxBytes = 8 * 1024 * 1024;
export function nativeText(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.length > 4096)
    throw new Error('Invalid native text');
  return value;
}
export function boundedJson(value: unknown) {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > maxBytes)
    throw new Error('Argo storage limit');
  return json;
}
function times(row: Record<string, unknown>) {
  const eventAt = timestamp(row.eventAt),
    observedAt = timestamp(row.observedAt);
  if (instant(eventAt) > instant(observedAt)) throw new Error('Argo evidence order');
  return { eventAt, observedAt };
}
/** Native operation revisions are opaque, never timestamps. Validate normalized storage from unknown. */
export function parseEvidence(value: unknown, scope: ArgoScope): EvidenceBatch {
  const row = object(value, ['deployments', 'statuses']);
  if (
    !Array.isArray(row.deployments) ||
    !Array.isArray(row.statuses) ||
    row.deployments.length !== 1 ||
    row.statuses.length !== 1
  )
    throw new Error('Invalid Argo evidence');
  const sourceId = identity('argocd', scope.instance);
  const deployments = row.deployments.map((value: unknown): DeploymentEvidence => {
    const r = object(value, [
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
    const operation = text(r.sourceDeploymentId, 2048),
      id = text(r.id, 2048),
      operationId = uuid(operation.split(':').at(-1));
    const sourceRef = `urn:clio:argocd:${identity(scope.instance, scope.applicationUid, operationId)}`;
    if (
      operation !== identity('application', scope.applicationUid, 'operation', operationId) ||
      id !== identity(sourceId, 'deployment', operation) ||
      r.sourceId !== sourceId ||
      r.revision !== 'v1' ||
      r.environment !== scope.environment ||
      r.sourceRef !== sourceRef ||
      r.repository !== null ||
      r.configurationRepositoryId !== scope.configurationRepositoryId ||
      r.deploymentTask !== null ||
      (r.operationKind !== 'rollout' &&
        r.operationKind !== 'self_heal' &&
        r.operationKind !== 'retry' &&
        r.operationKind !== 'unknown')
    )
      throw new Error('Invalid scoped Argo deployment');
    return {
      id,
      sourceId,
      sourceDeploymentId: operation,
      revision: 'v1',
      environment: scope.environment,
      ...times(r),
      sourceRef,
      repository: null,
      reconciledConfigurationRevision: nativeText(r.reconciledConfigurationRevision),
      configurationRepositoryId: scope.configurationRepositoryId,
      deploymentTask: null,
      operationKind: r.operationKind,
    };
  });
  const deployment = deployments[0];
  if (!deployment) throw new Error('Missing deployment');
  const statuses = row.statuses.map((value: unknown): StatusEvidence => {
    const r = object(value, [
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
    const revision = text(r.revision),
      id = text(r.id, 2048),
      sourceRef = `${deployment.sourceRef}:${identity('notification', revision)}`;
    if (
      !/^[0-9a-f]{64}$/.test(revision) ||
      id !== identity(deployment.id, 'notification', revision) ||
      r.deploymentId !== deployment.id ||
      r.environment !== scope.environment ||
      r.consumerExposure !== false ||
      r.sourceRef !== sourceRef ||
      (r.signal !== 'Succeeded' && r.signal !== 'Failed' && r.signal !== 'Error') ||
      (r.health !== 'Healthy' &&
        r.health !== 'Progressing' &&
        r.health !== 'Degraded' &&
        r.health !== 'Suspended' &&
        r.health !== 'Missing' &&
        r.health !== 'Unknown')
    )
      throw new Error('Invalid scoped Argo status');
    const t = times(r);
    if (instant(t.eventAt) < instant(deployment.eventAt) || t.observedAt !== deployment.observedAt)
      throw new Error('Invalid Argo status order');
    return {
      id,
      deploymentId: deployment.id,
      revision,
      environment: scope.environment,
      signal: r.signal,
      health: r.health,
      consumerExposure: false,
      ...t,
      sourceRef,
    };
  });
  return { deployments, statuses };
}
export function mergeHistory(batches: readonly EvidenceBatch[]): EvidenceBatch {
  const deployments = new Map<string, DeploymentEvidence>(),
    statuses = new Map<string, StatusEvidence>();
  function merge<T extends DeploymentEvidence | StatusEvidence>(target: Map<string, T>, record: T) {
    const old = target.get(record.id);
    if (old) {
      const { observedAt: _a, ...a } = old,
        { observedAt: _b, ...b } = record;
      if (digest(boundedJson(a)) !== digest(boundedJson(b)))
        throw new Error('Conflicting Argo evidence');
    }
    if (!old || instant(record.observedAt) < instant(old.observedAt)) target.set(record.id, record);
  }
  for (const batch of batches) {
    for (const record of batch.deployments) merge(deployments, record);
    for (const record of batch.statuses) merge(statuses, record);
  }
  return {
    deployments: [...deployments.values()].sort((a, b) => a.id.localeCompare(b.id)),
    statuses: [...statuses.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

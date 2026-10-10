import type { EvidenceBatch, RepositoryProvenance } from './model.ts';
import {
  AdapterError,
  eventBeforeObservation,
  identity,
  instant,
  object,
  sha,
  string,
  timestamp,
} from './value.ts';

/** Narrow, versioned notification contract. Caller authenticates provenance before normalization. */
export function normalizeArgoOperation(
  input: unknown,
  context: {
    instance: string;
    /** Trusted receiver observation time; payload cannot supply it. No receiver is implemented. */
    observedAt: string;
  },
): EvidenceBatch {
  const row = object(input);
  if (row.contract !== 'clio.argocd.operation.v1')
    throw new AdapterError('unsupported_argo_contract');
  const sourceId = identity('argocd', string(context.instance));
  const observedAt = timestamp(context.observedAt);
  const applicationUid = string(row.application_uid);
  const operationId = string(row.operation_id);
  const revision = string(row.notification_revision);
  const environment = string(row.environment);
  const eventAt = timestamp(row.started_at);
  const statusAt = timestamp(row.status_at);
  eventBeforeObservation(eventAt, observedAt);
  eventBeforeObservation(statusAt, observedAt);
  if (instant(statusAt) < instant(eventAt)) throw new AdapterError('status_before_operation');
  const operationKind = row.operation_kind;
  if (
    operationKind !== 'rollout' &&
    operationKind !== 'self_heal' &&
    operationKind !== 'retry' &&
    operationKind !== 'unknown'
  )
    throw new AdapterError('invalid_operation_kind');
  const signal = string(row.phase);
  if (!['Running', 'Succeeded', 'Failed', 'Error', 'Terminating'].includes(signal))
    throw new AdapterError('invalid_argo_phase');
  const health = string(row.health);
  if (!['Healthy', 'Progressing', 'Degraded', 'Suspended', 'Missing', 'Unknown'].includes(health))
    throw new AdapterError('invalid_argo_health');
  if (typeof row.consumer_exposure !== 'boolean')
    throw new AdapterError('invalid_exposure_attestation');
  const reconciledConfigurationRevision = string(row.reconciled_revision);
  const configurationRepositoryId = string(row.configuration_repository_id);
  let repository: RepositoryProvenance | null = null;
  if (row.application_provenance !== null) {
    const provenance = object(row.application_provenance);
    repository = Object.freeze({
      repositoryId: string(provenance.repository_id),
      tipSha: sha(provenance.commit_sha),
    });
  }
  const sourceDeploymentId = identity('application', applicationUid, 'operation', operationId);
  const deploymentId = identity(sourceId, 'deployment', sourceDeploymentId);
  const sourceRef = `urn:clio:argocd:${identity(context.instance, applicationUid, operationId)}`;
  return Object.freeze({
    deployments: Object.freeze([
      Object.freeze({
        id: deploymentId,
        sourceId,
        sourceDeploymentId,
        revision: string(row.operation_revision),
        environment,
        eventAt,
        observedAt,
        sourceRef,
        repository,
        reconciledConfigurationRevision,
        configurationRepositoryId,
        deploymentTask: null,
        operationKind,
      }),
    ]),
    statuses: Object.freeze([
      Object.freeze({
        id: identity(deploymentId, 'notification', revision),
        deploymentId,
        revision,
        environment,
        signal,
        health,
        consumerExposure: row.consumer_exposure,
        eventAt: statusAt,
        observedAt,
        sourceRef: `${sourceRef}:${identity('notification', revision)}`,
      }),
    ]),
  });
}

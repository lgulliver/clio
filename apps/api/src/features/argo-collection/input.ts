import { positive, text, timestamp } from '../github-collection/input.ts';
import { IdentityError, object, uuid } from '../identity/input.ts';

export {
  count,
  enqueueInput,
  instant,
  positive,
  text,
  timestamp,
  windowInput,
} from '../github-collection/input.ts';
export interface ArgoConnection {
  workspaceId: string;
  serviceId: string;
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
  applicationOperationsBelongToService: true;
  observedAt: string;
  enrichmentProducers?: EnrichmentProducer[];
}
export function connectionInput(value: unknown) {
  const row = object(value, [
    'enrichmentProducerIds',
    'expectedRevision',
    'sourceId',
    'applicationOperationsBelongToService',
    'exposurePolicyReference',
  ]);
  if (row.applicationOperationsBelongToService !== true)
    throw new IdentityError(400, 'invalid_request');
  return {
    enrichmentProducerIds: Object.hasOwn(row, 'enrichmentProducerIds')
      ? producerIds(row.enrichmentProducerIds)
      : [],
    expectedRevision: row.expectedRevision === null ? null : positive(row.expectedRevision),
    sourceId: uuid(row.sourceId),
    exposurePolicyReference:
      row.exposurePolicyReference === null ? null : text(row.exposurePolicyReference),
  };
}
export function parseConnection(value: unknown): ArgoConnection {
  const row = object(value, [
    'enrichmentProducers',
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
  if (
    row.mode !== 'live' ||
    row.provider !== 'argocd' ||
    typeof row.active !== 'boolean' ||
    row.applicationOperationsBelongToService !== true
  )
    throw new Error('Invalid stored Argo connection');
  return {
    ...(Object.hasOwn(row, 'enrichmentProducers')
      ? { enrichmentProducers: parseProducers(row.enrichmentProducers) }
      : {}),
    workspaceId: uuid(row.workspaceId),
    serviceId: uuid(row.serviceId),
    mode: row.mode,
    provider: row.provider,
    revision: positive(row.revision),
    active: row.active,
    sourceId: uuid(row.sourceId),
    applicationName: text(row.applicationName),
    applicationNamespace: text(row.applicationNamespace),
    instance: text(row.instance),
    productionEnvironment: text(row.productionEnvironment),
    exposurePolicyReference:
      row.exposurePolicyReference === null ? null : text(row.exposurePolicyReference),
    applicationOperationsBelongToService: true,
    observedAt: timestamp(row.observedAt),
  };
}

export interface EnrichmentProducer {
  producerId: string;
  capability: 'consumer_exposure' | 'application_provenance';
  policyReference: string;
}
export function producerIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new IdentityError(400, 'invalid_request');
  const ids = value.map((id: unknown) => uuid(id)).sort();
  if (new Set(ids).size !== ids.length) throw new IdentityError(400, 'invalid_request');
  return ids;
}
export function parseProducers(value: unknown): EnrichmentProducer[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid producers');
  const producers = value
    .map((value: unknown): EnrichmentProducer => {
      const row = object(value, ['producerId', 'capability', 'policyReference']);
      if (row.capability !== 'consumer_exposure' && row.capability !== 'application_provenance')
        throw new Error('Invalid capability');
      return {
        producerId: uuid(row.producerId),
        capability: row.capability,
        policyReference: text(row.policyReference),
      };
    })
    .sort((a, b) => a.producerId.localeCompare(b.producerId));
  producerIds(producers.map((p) => p.producerId));
  return producers;
}

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
}
export function connectionInput(value: unknown) {
  const row = object(value, [
    'expectedRevision',
    'sourceId',
    'applicationOperationsBelongToService',
    'exposurePolicyReference',
  ]);
  if (row.applicationOperationsBelongToService !== true)
    throw new IdentityError(400, 'invalid_request');
  return {
    expectedRevision: row.expectedRevision === null ? null : positive(row.expectedRevision),
    sourceId: uuid(row.sourceId),
    exposurePolicyReference:
      row.exposurePolicyReference === null ? null : text(row.exposurePolicyReference),
  };
}
export function parseConnection(value: unknown): ArgoConnection {
  const row = object(value, [
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

import type { ArgoNotification } from '@clio/adapters';
import { snapshotDigest } from '../github-collection/digest.ts';
import { object, uuid } from '../identity/input.ts';
import { parseScope } from './config.ts';
import { nativeText } from './history.ts';
import { timestamp } from './input.ts';

/** Inspect the adapter's validated canonical form, never parse native ingress again.
 * Gap outcomes still carry immutable native operation metadata when available.
 */
export function operationMetadata(
  notification: ArgoNotification,
): { operationId: string; digest: string } | null {
  const canonical: unknown = JSON.parse(notification.canonicalJson);
  const root = object(canonical, ['scope', 'notification']),
    scope = parseScope(root.scope);
  const native = object(root.notification, ['contract', 'application', 'operation', 'health']);
  const operation = object(native.operation, [
    'phase',
    'startedAt',
    'finishedAt',
    'retryCount',
    'info',
    'initiatedBy',
    'revision',
    'revisions',
  ]);
  if (!Array.isArray(operation.info)) throw new Error('Invalid canonical metadata');
  const info = operation.info.map((value: unknown) => {
    const row = object(value, ['name', 'value']);
    return { name: nativeText(row.name), value: nativeText(row.value, true) };
  });
  if (new Set(info.map((row) => row.name)).size !== info.length) return null;
  const id = info.find((row) => row.name === 'clio.operation-id')?.value,
    kind = info.find((row) => row.name === 'clio.operation-kind')?.value ?? 'unknown';
  if (
    !id ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) ||
    (kind !== 'rollout' && kind !== 'self_heal' && kind !== 'retry' && kind !== 'unknown') ||
    operation.startedAt === null ||
    operation.revision === null
  )
    return null;
  const operationId = uuid(id);
  const metadataDigest = snapshotDigest({
    scope,
    operationId,
    startedAt: timestamp(operation.startedAt),
    configurationRevision: nativeText(operation.revision),
    operationKind: kind,
    operationRevision: 'v1',
    info,
    initiatedBy: operation.initiatedBy,
  });
  if (notification.kind === 'operation' && metadataDigest !== notification.operationMetadataDigest)
    throw new Error('Inconsistent Argo metadata');
  return { operationId, digest: metadataDigest };
}

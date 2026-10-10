import { createHash } from 'node:crypto';
import { normalizeArgoOperation } from './argocd.ts';
import type { EvidenceBatch } from './model.ts';
import { AdapterError, instant, object, timestamp } from './value.ts';

export interface NativeArgoNotification {
  contract: 'clio.argocd.notification.v1';
  application: {
    uid: string;
    name: string;
    namespace: string;
    project: string;
    destination: { server: string | null; name: string | null; namespace: string };
    repoURL: string | null;
    hasSources: boolean;
    hasSourceHydrator: boolean;
  };
  operation: {
    phase: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    retryCount: number;
    info: { name: string; value: string }[];
    initiatedBy: { username: string | null; automated: boolean };
    revision: string | null;
    revisions: string[];
  };
  health: { status: string | null; lastTransitionTime: string | null };
}
export interface ArgoScope {
  sourceId: string;
  workspaceId: string;
  serviceId: string;
  instance: string;
  applicationUid: string;
  applicationName: string;
  applicationNamespace: string;
  project: string;
  destinationClusterId: string;
  destinationServer: string | null;
  destinationName: string | null;
  destinationNamespace: string;
  configurationRepositoryId: string;
  repoURL: string;
  environment: string;
}
export type ArgoGapReason =
  | 'unmarked_operation'
  | 'non_terminal'
  | 'missing_sync_result'
  | 'missing_health_timestamp'
  | 'multi_source'
  | 'source_hydrator'
  | 'future_timestamp'
  | 'invalid_operation_info'
  | 'observation_horizon'
  | 'status_combination_repeated'
  | 'status_combination_limit'
  | 'connection_interruption';
interface ArgoNotificationBase {
  digest: string;
  startedAt: string | null;
  canonicalJson: string;
}
export interface ArgoOperationNotification extends ArgoNotificationBase {
  kind: 'operation';
  operationId: string;
  operationMetadataDigest: string;
  notificationRevision: string;
  phase: string;
  health: string;
  evidence: EvidenceBatch;
}
export interface ArgoGapNotification extends ArgoNotificationBase {
  kind: 'gap';
  reason: ArgoGapReason;
}
export type ArgoNotification = ArgoOperationNotification | ArgoGapNotification;

function fail(): never {
  throw new AdapterError('invalid_argo_notification');
}
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = object(input);
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    fail();
  return row;
}
function text(input: unknown, empty = false): string {
  if (typeof input !== 'string' || (!empty && input.length === 0) || input.length > 4096) fail();
  return input;
}
function nullable(input: unknown): string | null {
  return input === null ? null : text(input);
}
function bool(input: unknown): boolean {
  if (typeof input !== 'boolean') fail();
  return input;
}
function time(input: unknown): string | null {
  if (input === null) return null;
  const value = text(input);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) fail();
  timestamp(value);
  // Canonical UTC spelling keeps replay stable across fractional padding differences.
  return value.replace(/\.(\d*?[1-9])0+Z$/, '.$1Z').replace(/\.0+Z$/, 'Z');
}
function list(input: unknown): unknown[] {
  if (!Array.isArray(input) || input.length > 100) fail();
  return input;
}
function canonical(input: unknown): string {
  function sort(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, sort(entry)]),
      );
    }
    return value;
  }
  return JSON.stringify(sort(input));
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function shape(input: unknown): NativeArgoNotification {
  const row = record(input, ['contract', 'application', 'operation', 'health']);
  if (row.contract !== 'clio.argocd.notification.v1') fail();
  const app = record(row.application, [
    'uid',
    'name',
    'namespace',
    'project',
    'destination',
    'repoURL',
    'hasSources',
    'hasSourceHydrator',
  ]);
  const destination = record(app.destination, ['server', 'name', 'namespace']);
  const op = record(row.operation, [
    'phase',
    'startedAt',
    'finishedAt',
    'retryCount',
    'info',
    'initiatedBy',
    'revision',
    'revisions',
  ]);
  const initiator = record(op.initiatedBy, ['username', 'automated']);
  const health = record(row.health, ['status', 'lastTransitionTime']);
  if (
    typeof op.retryCount !== 'number' ||
    !Number.isSafeInteger(op.retryCount) ||
    op.retryCount < 0
  )
    fail();
  const result: NativeArgoNotification = {
    contract: 'clio.argocd.notification.v1',
    application: {
      uid: text(app.uid),
      name: text(app.name),
      namespace: text(app.namespace),
      project: text(app.project),
      destination: {
        server: nullable(destination.server),
        name: nullable(destination.name),
        namespace: text(destination.namespace),
      },
      repoURL: nullable(app.repoURL),
      hasSources: bool(app.hasSources),
      hasSourceHydrator: bool(app.hasSourceHydrator),
    },
    operation: {
      phase: nullable(op.phase),
      startedAt: time(op.startedAt),
      finishedAt: time(op.finishedAt),
      retryCount: op.retryCount,
      info: list(op.info)
        .map((entry) => {
          const info = record(entry, ['name', 'value']);
          return { name: text(info.name), value: text(info.value, true) };
        })
        .sort((a, b) =>
          a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : a.value < b.value
                ? -1
                : a.value > b.value
                  ? 1
                  : 0,
        ),
      initiatedBy: { username: nullable(initiator.username), automated: bool(initiator.automated) },
      revision: nullable(op.revision),
      revisions: list(op.revisions).map((entry) => text(entry)),
    },
    health: {
      status: nullable(health.status),
      lastTransitionTime: time(health.lastTransitionTime),
    },
  };
  if (
    result.operation.startedAt !== null &&
    result.operation.finishedAt !== null &&
    instant(result.operation.finishedAt) < instant(result.operation.startedAt)
  )
    fail();
  if (
    result.health.status !== null &&
    !['Healthy', 'Progressing', 'Degraded', 'Suspended', 'Missing', 'Unknown'].includes(
      result.health.status,
    )
  )
    fail();
  if (Buffer.byteLength(canonical(result), 'utf8') > 64 * 1024) fail();
  return result;
}
function validateScope(notification: NativeArgoNotification, scope: ArgoScope): void {
  // Pick explicit fields: backend grants may also carry private fingerprints or credential digests.
  for (const value of [
    scope.sourceId,
    scope.workspaceId,
    scope.serviceId,
    scope.instance,
    scope.applicationUid,
    scope.applicationName,
    scope.applicationNamespace,
    scope.project,
    scope.destinationClusterId,
    scope.destinationNamespace,
    scope.configurationRepositoryId,
    scope.repoURL,
    scope.environment,
  ])
    text(value);
  nullable(scope.destinationServer);
  nullable(scope.destinationName);
  const app = notification.application;
  if (
    app.uid !== scope.applicationUid ||
    app.name !== scope.applicationName ||
    app.namespace !== scope.applicationNamespace ||
    app.project !== scope.project ||
    app.destination.server !== scope.destinationServer ||
    app.destination.name !== scope.destinationName ||
    app.destination.namespace !== scope.destinationNamespace ||
    (app.repoURL !== scope.repoURL &&
      !(app.repoURL === null && (app.hasSources || app.hasSourceHydrator)))
  ) {
    throw new AdapterError('argo_scope_drift');
  }
}
function prepared(input: unknown, scope: ArgoScope) {
  const notification = shape(input);
  validateScope(notification, scope);
  const normalizedScope: ArgoScope = {
    sourceId: scope.sourceId,
    workspaceId: scope.workspaceId,
    serviceId: scope.serviceId,
    instance: scope.instance,
    applicationUid: scope.applicationUid,
    applicationName: scope.applicationName,
    applicationNamespace: scope.applicationNamespace,
    project: scope.project,
    destinationClusterId: scope.destinationClusterId,
    destinationServer: scope.destinationServer,
    destinationName: scope.destinationName,
    destinationNamespace: scope.destinationNamespace,
    configurationRepositoryId: scope.configurationRepositoryId,
    repoURL: scope.repoURL,
    environment: scope.environment,
  };
  const canonicalJson = canonical({ scope: normalizedScope, notification });
  return {
    notification,
    normalizedScope,
    canonicalJson,
    digest: digest(canonicalJson),
    startedAt: notification.operation.startedAt,
  };
}
/** Validates shape and exact granted scope without arrival-age checks, for authorized replay lookup. */
export function argoNotificationDigest(input: unknown, scope: ArgoScope): string {
  return prepared(input, scope).digest;
}
/** Caller authenticates source credentials; unsupported native observations retain explicit gap identity. */
export function parseArgoNotification(
  input: unknown,
  scope: ArgoScope,
  observedAt: string,
): ArgoNotification {
  const preparedInput = prepared(input, scope);
  const {
    notification,
    normalizedScope,
    canonicalJson,
    digest: receiptDigest,
    startedAt,
  } = preparedInput;
  const observed = time(observedAt);
  if (observed === null) fail();
  const observedInstant = instant(observed);
  const base = { digest: receiptDigest, startedAt, canonicalJson };
  function gap(reason: ArgoGapReason): ArgoGapNotification {
    return Object.freeze({
      ...base,
      startedAt: startedAt !== null && instant(startedAt) <= observedInstant ? startedAt : null,
      kind: 'gap',
      reason,
    });
  }
  if (notification.application.hasSources || notification.operation.revisions.length > 0)
    return gap('multi_source');
  if (notification.application.hasSourceHydrator) return gap('source_hydrator');
  const op = notification.operation;
  if (new Set(op.info.map((entry) => entry.name)).size !== op.info.length)
    return gap('invalid_operation_info');
  const operationId = op.info.find((entry) => entry.name === 'clio.operation-id')?.value;
  if (!operationId) return gap('unmarked_operation');
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(operationId)
  )
    return gap('invalid_operation_info');
  const operationKind =
    op.info.find((entry) => entry.name === 'clio.operation-kind')?.value ?? 'unknown';
  if (
    operationKind !== 'rollout' &&
    operationKind !== 'self_heal' &&
    operationKind !== 'retry' &&
    operationKind !== 'unknown'
  )
    return gap('invalid_operation_info');
  if (
    startedAt === null ||
    (op.phase !== 'Succeeded' && op.phase !== 'Failed' && op.phase !== 'Error')
  )
    return gap('non_terminal');
  if (op.revision === null) return gap('missing_sync_result');
  const health = notification.health;
  if (op.finishedAt === null || health.lastTransitionTime === null || health.status === null)
    return gap('missing_health_timestamp');
  if (
    [startedAt, op.finishedAt, health.lastTransitionTime].some(
      (value) => instant(value) > instant(observed),
    )
  )
    return gap('future_timestamp');
  if (instant(observed) - instant(op.finishedAt) > 600_000_000n) return gap('observation_horizon');
  const statusAt =
    instant(op.finishedAt) >= instant(health.lastTransitionTime)
      ? op.finishedAt
      : health.lastTransitionTime;
  const normalizedId = operationId.toLowerCase();
  const sourceRef = `urn:clio:argocd:${[scope.instance, scope.applicationUid, normalizedId].map(encodeURIComponent).join(':')}`;
  const notificationRevision = digest(
    canonical({
      phase: op.phase,
      health: health.status,
      statusAt,
      consumerExposure: false,
      sourceRef,
    }),
  );
  const operationMetadataDigest = digest(
    canonical({
      scope: normalizedScope,
      operationId: normalizedId,
      startedAt,
      configurationRevision: op.revision,
      operationKind,
      operationRevision: 'v1',
      initiatedBy: op.initiatedBy,
      info: op.info,
    }),
  );
  const evidence = normalizeArgoOperation(
    {
      contract: 'clio.argocd.operation.v1',
      application_uid: scope.applicationUid,
      operation_id: normalizedId,
      notification_revision: notificationRevision,
      operation_revision: 'v1',
      environment: scope.environment,
      started_at: startedAt,
      status_at: statusAt,
      operation_kind: operationKind,
      phase: op.phase,
      health: health.status,
      consumer_exposure: false,
      application_provenance: null,
      reconciled_revision: op.revision,
      configuration_repository_id: scope.configurationRepositoryId,
    },
    { instance: scope.instance, observedAt: observed },
  );
  return Object.freeze({
    ...base,
    kind: 'operation',
    operationId: normalizedId,
    operationMetadataDigest,
    notificationRevision,
    phase: op.phase,
    health: health.status,
    evidence,
  });
}

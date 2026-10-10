import { object } from './storage.ts';

function optional(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? object(value) : {};
}
/** Select original Application fields, preserving unsupported native shapes for receiver gaps.
 * Never generates operation UUIDs, rewrites operation kind, or reconstructs status.history.
 */
export function applicationNotification(value: unknown): unknown {
  const app = object(value);
  if (app.kind !== 'Application' || app.apiVersion !== 'argoproj.io/v1alpha1')
    throw new Error('journal_not_application');
  const metadata = optional(app.metadata);
  const spec = optional(app.spec);
  const status = optional(app.status);
  const destination = optional(spec.destination);
  const source = optional(spec.source);
  const state = optional(status.operationState);
  const operation = optional(state.operation);
  const result = optional(state.syncResult);
  const initiator = optional(operation.initiatedBy);
  const health = optional(status.health);
  return {
    contract: 'clio.argocd.notification.v1',
    application: {
      uid: metadata.uid ?? null,
      name: metadata.name ?? null,
      namespace: metadata.namespace ?? null,
      project: spec.project ?? null,
      destination: {
        server: destination.server ?? null,
        name: destination.name ?? null,
        namespace: destination.namespace ?? null,
      },
      repoURL: source.repoURL ?? null,
      hasSources: Object.hasOwn(spec, 'sources'),
      hasSourceHydrator: Object.hasOwn(spec, 'sourceHydrator'),
    },
    operation: {
      phase: state.phase ?? null,
      startedAt: state.startedAt ?? null,
      finishedAt: state.finishedAt ?? null,
      retryCount: Object.hasOwn(state, 'retryCount') ? state.retryCount : 0,
      info: Object.hasOwn(operation, 'info') ? operation.info : [],
      initiatedBy:
        Object.hasOwn(operation, 'initiatedBy') &&
        (operation.initiatedBy === null ||
          typeof operation.initiatedBy !== 'object' ||
          Array.isArray(operation.initiatedBy))
          ? operation.initiatedBy
          : {
              username: initiator.username ?? null,
              automated: Object.hasOwn(initiator, 'automated') ? initiator.automated : false,
            },
      revision: result.revision ?? null,
      revisions: Object.hasOwn(result, 'revisions') ? result.revisions : [],
    },
    health: {
      status: health.status ?? null,
      lastTransitionTime: health.lastTransitionTime ?? null,
    },
  };
}

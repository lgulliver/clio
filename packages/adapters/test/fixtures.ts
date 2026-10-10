import type { FetchTransport, ServiceMapping } from '../src/index.ts';
import { identity } from '../src/index.ts';

export const observedAt = '2026-01-04T00:00:00Z';
export const tip = 'a'.repeat(40);
export const sourceId = identity('github', 'installation-1');
export const sourceDeploymentId = identity('repository', 11, 'deployment', 21);
export const argoSourceId = identity('argocd', 'cluster-1');
export const argoDeploymentId = identity('application', 'app-uid', 'operation', 'op-1');
export const repositoryId = identity('github', 'installation-1', 'repository', 11);
export const window = {
  start: '2026-01-01T00:00:00Z',
  end: '2026-01-03T00:00:00Z',
  timezone: 'UTC',
  calendar_days: 2,
} as const;
export function mapping(attested = false): ServiceMapping {
  return {
    serviceId: 'service:one',
    serviceName: 'One',
    revision: 'mapping-1',
    observedAt: '2026-01-01T00:00:00Z',
    sourceRef: 'urn:clio:mapping:1',
    primarySourceId: sourceId,
    deploymentBindings: [{ sourceId, sourceDeploymentId }],
    environments: [
      {
        sourceId,
        environment: 'prod',
        classification: 'production',
        exposurePolicy: attested
          ? { reference: 'urn:clio:exposure-policy:1', signal: 'success' }
          : null,
      },
      { sourceId, environment: 'staging', classification: 'non_production', exposurePolicy: null },
    ],
    correlations: [],
  };
}
export function deployment(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 21,
    sha: tip,
    environment: 'staging',
    task: 'deploy',
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-01T10:00:00Z',
    payload: { secret: 'discard-me' },
    description: 'discard-me',
    creator: { login: 'discard-me' },
    ...overrides,
  };
}
export function status(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 31,
    state: 'success',
    environment: 'prod',
    created_at: '2026-01-01T11:00:00Z',
    updated_at: '2026-01-01T11:00:00Z',
    ...overrides,
  };
}
export function argo(overrides: Record<string, unknown> = {}): unknown {
  return {
    contract: 'clio.argocd.operation.v1',
    application_uid: 'app-uid',
    operation_id: 'op-1',
    operation_revision: 'operation-1',
    notification_revision: 'notice-1',
    environment: 'prod',
    started_at: '2026-01-01T10:00:00Z',
    status_at: '2026-01-01T11:00:00Z',
    operation_kind: 'rollout',
    phase: 'Succeeded',
    health: 'Healthy',
    consumer_exposure: false,
    reconciled_revision: 'config-sha-1',
    configuration_repository_id: 'git:configuration-repository-1',
    application_provenance: { repository_id: repositoryId, commit_sha: tip },
    ...overrides,
  };
}
export function response(
  body: unknown,
  headers: Record<string, string> = {},
  code = 200,
): Response {
  return new Response(JSON.stringify(body), { status: code, headers });
}
export const metadata = { id: 11, owner: { login: 'renamed-owner' }, name: 'renamed-repo' };
export function transport(responses: readonly Response[]): {
  fetch: FetchTransport;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const result = responses[calls.length - 1];
      if (!result) throw new Error('Unexpected request');
      return result;
    },
  };
}

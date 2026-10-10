import { calculate } from '@clio/oems';
import {
  collectGitHubDeployments,
  type EvidenceBatch,
  normalizeArgoOperation,
  reconcileDeployments,
  type ServiceMapping,
} from '../src/index.ts';

// Entirely fictional. Injected transport cannot make network requests.
const argumentsList = process.argv.slice(2);
for (const argument of argumentsList) {
  if (
    !argument.startsWith('--source=') &&
    !argument.startsWith('--environment=') &&
    argument !== '--attest-exposure'
  )
    throw new Error('Unknown demo argument');
}
const source =
  argumentsList.find((argument) => argument.startsWith('--source='))?.slice(9) ?? 'both';
if (source !== 'github' && source !== 'argocd' && source !== 'both')
  throw new Error('Use --source=github, --source=argocd or --source=both');
const environment =
  argumentsList.find((argument) => argument.startsWith('--environment='))?.slice(14) ??
  'production';
if (!environment.trim()) throw new Error('Production environment selection must be nonempty');
const exposureAttested = argumentsList.includes('--attest-exposure');
const observedAt = '2026-10-03T00:00:00Z';
const startedAt = '2026-10-01T12:00:00Z';
const effectiveAt = '2026-10-01T12:05:00Z';
const sha = 'a'.repeat(40);
function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}
const github = await collectGitHubDeployments({
  instance: 'fictional-installation',
  repositoryId: 101,
  token: 'fixture-only',
  clock: () => new Date(observedAt),
  fetch: async (url) => {
    const path = new URL(url).pathname;
    if (path === '/repositories/101')
      return response({ id: 101, name: 'fictional-app', owner: { login: 'fictional-owner' } });
    if (path === '/repos/fictional-owner/fictional-app/deployments')
      return response([
        { id: 201, sha, environment: 'production', created_at: startedAt, updated_at: startedAt },
      ]);
    if (path === '/repos/fictional-owner/fictional-app/deployments/201/statuses')
      return response([
        {
          id: 301,
          state: 'success',
          environment: 'production',
          created_at: effectiveAt,
          updated_at: effectiveAt,
        },
      ]);
    throw new Error('Unrecognized fixture request; network is disabled');
  },
});
if (!github.transportComplete) throw new Error('Fictional GitHub collection failed');
const argocd = normalizeArgoOperation(
  {
    contract: 'clio.argocd.operation.v1',
    application_uid: 'fictional-application-uid',
    operation_id: 'rollout-201',
    operation_revision: 'operation-v1',
    notification_revision: 'notification-v1',
    environment: 'production',
    started_at: startedAt,
    status_at: effectiveAt,
    operation_kind: 'rollout',
    phase: 'Succeeded',
    health: 'Healthy',
    consumer_exposure: exposureAttested,
    reconciled_revision: 'b'.repeat(40),
    configuration_repository_id: 'git:fictional-manifests-repository',
    application_provenance: null,
  },
  { instance: 'fictional-argocd', observedAt },
);
const batches: EvidenceBatch[] =
  source === 'both' ? [github, argocd] : source === 'github' ? [github] : [argocd];
const primary = source === 'argocd' ? argocd.deployments[0] : github.deployments[0];
if (!primary) throw new Error('Missing primary fixture');
const deployments = batches.flatMap((batch) => [...batch.deployments]);
const mapping: ServiceMapping = {
  serviceId: 'fictional-service',
  serviceName: 'Fictional service',
  revision: 'mapping-v1',
  observedAt,
  sourceRef: 'urn:clio:fixture:service-mapping',
  primarySourceId: primary.sourceId,
  deploymentBindings: deployments.map((deployment) => ({
    sourceId: deployment.sourceId,
    sourceDeploymentId: deployment.sourceDeploymentId,
  })),
  environments: deployments.map((deployment) => ({
    sourceId: deployment.sourceId,
    environment,
    classification: 'production',
    exposurePolicy: exposureAttested
      ? {
          reference: 'urn:clio:fixture:explicit-exposure-policy',
          signal: deployment.sourceId.startsWith('github:') ? 'success' : 'Succeeded',
        }
      : null,
  })),
  correlations:
    source === 'both'
      ? deployments.map((deployment) => ({
          sourceId: deployment.sourceId,
          sourceDeploymentId: deployment.sourceDeploymentId,
          rolloutGroupId: 'fictional-shared-rollout-201',
        }))
      : [],
};
const snapshot = reconcileDeployments({
  datasetId: 'fictional-demo',
  mapping,
  batches,
  evidenceCutoff: observedAt,
  window: {
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-02T00:00:00Z',
    timezone: 'UTC',
    calendar_days: 1,
  },
});
if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.errors));
console.log(
  JSON.stringify(
    {
      mode: 'fictional fixtures only; no network or provider credentials',
      source,
      environment,
      exposureAttested,
      canonicalRollouts: snapshot.data.data.deployments.length,
      coverage: {
        collectionComplete: snapshot.data.data.collection_complete,
        deploymentHistoryComplete: snapshot.data.data.deployment_history_complete,
        recoveryEvidenceComplete: snapshot.data.data.recovery_evidence_complete,
      },
      diagnostics: snapshot.diagnostics,
      results: calculate(snapshot.data),
    },
    null,
    2,
  ),
);

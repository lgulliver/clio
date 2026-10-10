/** Server-only boundary. Never import this package from apps/web. */
export { normalizeArgoOperation } from './argocd.ts';
export type { CollectionDiagnostic, GitHubBatch } from './github.ts';
export { collectGitHubDeployments } from './github.ts';
export type { FetchTransport, InstallationToken } from './github-app.ts';
export { createInstallationToken, githubApiVersion } from './github-app.ts';
export type {
  DeploymentEvidence,
  DeploymentSource,
  EnvironmentMapping,
  EvidenceBatch,
  RepositoryProvenance,
  ServiceMapping,
  StatusEvidence,
} from './model.ts';
export type { ReconciliationDiagnostic } from './reconcile.ts';
export { reconcileDeployments } from './reconcile.ts';
export { AdapterError, identity } from './value.ts';

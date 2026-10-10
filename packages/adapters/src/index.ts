/** Server-only boundary. Never import this package from apps/web. */
export type {
  ArgoGapNotification,
  ArgoGapReason,
  ArgoNotification,
  ArgoOperationNotification,
  ArgoScope,
  NativeArgoNotification,
} from './argo-notification.ts';
export { argoNotificationDigest, parseArgoNotification } from './argo-notification.ts';
export { normalizeArgoOperation } from './argocd.ts';
export type { CollectionDiagnostic, GitHubBatch } from './github.ts';
export { collectGitHubDeployments } from './github.ts';
export type { FetchTransport, InstallationToken } from './github-app.ts';
export { createInstallationToken, githubApiVersion } from './github-app.ts';
export { GitHubRateLimitError, githubRateLimit } from './github-rate-limit.ts';
export { verifyGitHubScope } from './github-scope.ts';
export { createBoundedGitHubTransport } from './github-transport.ts';
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

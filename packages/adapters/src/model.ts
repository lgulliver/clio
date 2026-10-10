export type DeploymentSource = Readonly<{
  provider: 'github' | 'argocd';
  /** Stable connection/installation instance, never owner/name or mutable application name. */
  instance: string;
}>;
export type RepositoryProvenance = Readonly<{
  repositoryId: string;
  tipSha: string;
}>;
export type DeploymentEvidence = Readonly<{
  id: string;
  sourceId: string;
  sourceDeploymentId: string;
  revision: string;
  environment: string;
  eventAt: string;
  observedAt: string;
  sourceRef: string;
  repository: RepositoryProvenance | null;
  /** GitOps config revision is deliberately separate from deployed app provenance. */
  reconciledConfigurationRevision: string | null;
  configurationRepositoryId: string | null;
  /** Provider task is provenance, not an automatic service/exposure classification. */
  deploymentTask: string | null;
  operationKind: 'rollout' | 'self_heal' | 'retry' | 'unknown';
}>;
export type StatusEvidence = Readonly<{
  id: string;
  deploymentId: string;
  revision: string;
  environment: string;
  signal: string;
  health: string | null;
  consumerExposure: boolean;
  eventAt: string;
  observedAt: string;
  sourceRef: string;
}>;
export type EvidenceBatch = Readonly<{
  /** Transport traversal only, not OEMS history coverage. Trusted collector observation time. */
  completedStatusTraversals?: readonly Readonly<{ deploymentId: string; observedAt: string }>[];
  deployments: readonly DeploymentEvidence[];
  statuses: readonly StatusEvidence[];
}>;
export type EnvironmentMapping = Readonly<{
  sourceId: string;
  environment: string;
  classification: 'production' | 'non_production';
  /** Owner attests signal means real production consumer exposure; reference is auditable. */
  exposurePolicy: Readonly<{ reference: string; signal: 'success' | 'Succeeded' }> | null;
}>;
export type ServiceMapping = Readonly<{
  serviceId: string;
  serviceName: string;
  revision: string;
  observedAt: string;
  sourceRef: string;
  primarySourceId: string;
  /** Exact source operation bindings; no SHA/time/name matching. */
  deploymentBindings: readonly Readonly<{ sourceId: string; sourceDeploymentId: string }>[];
  environments: readonly EnvironmentMapping[];
  /** Each shared group must include primary source. Only explicit groups admit corroborators. */
  correlations: readonly Readonly<{
    sourceId: string;
    sourceDeploymentId: string;
    rolloutGroupId: string;
  }>[];
}>;

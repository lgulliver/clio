import { type Dataset, type Deployment, validateSnapshot } from '@clio/oems';
import type { DeploymentEvidence, EvidenceBatch, ServiceMapping, StatusEvidence } from './model.ts';
import { currentDeployments } from './observations.ts';
import { AdapterError, content, identity, instant, string, timestamp } from './value.ts';

function dedupe<T extends DeploymentEvidence | StatusEvidence>(
  records: readonly T[],
  cutoff: bigint,
): T[] {
  const result = new Map<string, T>();
  for (const record of records) {
    if (instant(record.observedAt) > cutoff) continue;
    const { observedAt: _observed, ...rest } = record;
    const previous = result.get(record.id);
    if (previous) {
      const { observedAt: _previousObserved, ...previousRest } = previous;
      // Different revisions need explicit reconciliation upstream, never last-write-wins.
      if (content(rest) !== content(previousRest))
        throw new AdapterError('conflicting_source_record');
    }
    if (!previous || instant(record.observedAt) < instant(previous.observedAt))
      result.set(record.id, record);
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function binding(sourceId: string, sourceDeploymentId: string): string {
  return identity(sourceId, sourceDeploymentId);
}
function latest(times: readonly string[]): string {
  let result = times[0];
  if (!result) throw new AdapterError('missing_observation');
  for (const time of times) if (instant(time) > instant(result)) result = time;
  return result;
}

export type ReconciliationDiagnostic = Readonly<{
  code: 'missing_primary_evidence';
  rolloutGroupId: string;
}>;

/** Pure one-service snapshot construction. Pinned OEMS validator owns window/context semantics. */
export function reconcileDeployments(input: {
  datasetId: string;
  window: Dataset['window'];
  evidenceCutoff: string;
  mapping: ServiceMapping;
  batches: readonly EvidenceBatch[];
}): ReturnType<typeof validateSnapshot> &
  Readonly<{ diagnostics: readonly ReconciliationDiagnostic[] }> {
  const cutoff = instant(input.evidenceCutoff);
  const mapping = input.mapping;
  string(mapping.revision);
  string(mapping.sourceRef);
  string(mapping.primarySourceId);
  timestamp(mapping.observedAt);
  if (instant(mapping.observedAt) > cutoff) throw new AdapterError('mapping_after_cutoff');
  const selected = new Set<string>();
  for (const entry of mapping.deploymentBindings) {
    const key = binding(string(entry.sourceId), string(entry.sourceDeploymentId));
    if (selected.has(key)) throw new AdapterError('duplicate_deployment_binding');
    selected.add(key);
  }
  const correlations = new Map<string, string>();
  const correlatedSources = new Map<string, Set<string>>();
  for (const entry of mapping.correlations) {
    const key = binding(entry.sourceId, entry.sourceDeploymentId);
    string(entry.rolloutGroupId);
    if (!selected.has(key) || correlations.has(key))
      throw new AdapterError('invalid_correlation_binding');
    correlations.set(key, entry.rolloutGroupId);
    const sources = correlatedSources.get(entry.rolloutGroupId) ?? new Set<string>();
    sources.add(entry.sourceId);
    correlatedSources.set(entry.rolloutGroupId, sources);
  }
  for (const sources of correlatedSources.values()) {
    if (!sources.has(mapping.primarySourceId))
      throw new AdapterError('correlation_without_primary');
  }
  const environments = new Map<string, ServiceMapping['environments'][number]>();
  for (const environment of mapping.environments) {
    const key = binding(environment.sourceId, environment.environment);
    if (environments.has(key)) throw new AdapterError('duplicate_environment_mapping');
    if (environment.exposurePolicy) string(environment.exposurePolicy.reference);
    environments.set(key, environment);
  }
  const deployments = currentDeployments(
    input.batches
      .flatMap((batch) => [...batch.deployments])
      .filter((record) => instant(record.observedAt) <= cutoff),
  );
  const statuses = dedupe(
    input.batches.flatMap((batch) => [...batch.statuses]),
    cutoff,
  );
  const completed = new Map<string, bigint>();
  for (const traversal of input.batches.flatMap((batch) => [
    ...(batch.completedStatusTraversals ?? []),
  ])) {
    const observed = instant(traversal.observedAt);
    if (observed <= cutoff && observed > (completed.get(traversal.deploymentId) ?? -1n))
      completed.set(traversal.deploymentId, observed);
  }
  const byDeployment = new Map<string, StatusEvidence[]>();
  const known = new Set(deployments.map((record) => record.id));
  for (const status of statuses) {
    if (!known.has(status.deploymentId)) throw new AdapterError('unresolved_status_deployment');
    const list = byDeployment.get(status.deploymentId) ?? [];
    list.push(status);
    byDeployment.set(status.deploymentId, list);
  }
  const groups = new Map<string, DeploymentEvidence[]>();
  for (const record of deployments) {
    const key = binding(record.sourceId, record.sourceDeploymentId);
    if (!selected.has(key)) continue;
    const sharedGroup = correlations.get(key);
    if (record.sourceId !== mapping.primarySourceId && !sharedGroup) continue;
    const groupId = sharedGroup
      ? identity('correlated', sharedGroup)
      : identity('source', record.sourceId, record.sourceDeploymentId);
    const group = groups.get(groupId) ?? [];
    group.push(record);
    groups.set(groupId, group);
  }
  const diagnostics: ReconciliationDiagnostic[] = [];
  const output: Deployment[] = [];
  for (const [groupId, records] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    // Secondary evidence cannot create a rollout absent its authoritative source operation.
    if (!records.some((record) => record.sourceId === mapping.primarySourceId)) {
      diagnostics.push(
        Object.freeze({ code: 'missing_primary_evidence', rolloutGroupId: groupId }),
      );
      continue;
    }
    const provenance = new Map<string, string>();
    const classes = new Set<string>();
    const accepted: string[] = [];
    const refs = new Set<string>([mapping.sourceRef]);
    const observations = [mapping.observedAt];
    const tips: { source_id: string; repository_id: string; tip_sha: string }[] = [];
    const configuration: { source_id: string; repository_id: string | null; revision: string }[] =
      [];
    for (const record of records) {
      observations.push(record.observedAt);
      refs.add(record.sourceRef);
      if (record.repository) {
        const previous = provenance.get(record.repository.repositoryId);
        if (previous && previous !== record.repository.tipSha)
          throw new AdapterError('incompatible_correlated_provenance');
        provenance.set(record.repository.repositoryId, record.repository.tipSha);
        tips.push({
          source_id: record.sourceId,
          repository_id: record.repository.repositoryId,
          tip_sha: record.repository.tipSha,
        });
      }
      if (record.reconciledConfigurationRevision)
        configuration.push({
          source_id: record.sourceId,
          repository_id: record.configurationRepositoryId,
          revision: record.reconciledConfigurationRevision,
        });
      const events = byDeployment.get(record.id) ?? [];
      const recordClasses = new Set<string>();
      // Status.environment is historical truth; deployment.environment only fallback when no statuses.
      const historicalEnvironments = events.length
        ? events.map((event) => event.environment)
        : [record.environment];
      for (const environment of historicalEnvironments) {
        recordClasses.add(
          environments.get(binding(record.sourceId, environment))?.classification ?? 'unknown',
        );
      }
      let classification = recordClasses.has('production')
        ? 'production'
        : recordClasses.has('unknown')
          ? 'unknown'
          : 'non_production';
      // Negative classification requires a completed current status traversal. Partial pages
      // may contain staging while unfetched pages contain historical production exposure.
      if (
        classification === 'non_production' &&
        record.sourceId.startsWith('github:') &&
        (completed.get(record.id) ?? -1n) < instant(record.observedAt)
      )
        classification = 'unknown';
      classes.add(classification);
      for (const event of events) {
        refs.add(event.sourceRef);
        observations.push(event.observedAt);
        const environment = environments.get(binding(record.sourceId, event.environment));
        const policy = environment?.exposurePolicy;
        if (
          environment?.classification !== 'production' ||
          !policy ||
          record.operationKind !== 'rollout' ||
          record.sourceId !== mapping.primarySourceId
        )
          continue;
        const githubExposure =
          record.sourceId.startsWith('github:') &&
          event.signal === 'success' &&
          policy.signal === 'success';
        const argoExposure =
          record.sourceId.startsWith('argocd:') &&
          event.signal === 'Succeeded' &&
          policy.signal === 'Succeeded' &&
          event.health === 'Healthy' &&
          event.consumerExposure;
        if (githubExposure || argoExposure) {
          accepted.push(event.eventAt);
          refs.add(policy.reference);
        }
      }
    }
    if (classes.has('production') && classes.has('non_production'))
      throw new AdapterError('incompatible_correlated_environment');
    const environment = classes.has('production')
      ? 'production'
      : classes.has('unknown')
        ? 'unknown'
        : 'non_production';
    const effectiveAt =
      accepted.sort((a, b) =>
        instant(a) < instant(b) ? -1 : instant(a) > instant(b) ? 1 : 0,
      )[0] ?? null;
    output.push({
      id: identity('deployment', mapping.serviceId, groupId),
      source_refs: [...refs].sort(),
      service_id: mapping.serviceId,
      rollout_group_id: groupId,
      environment,
      qualification: effectiveAt
        ? 'qualifying'
        : environment === 'non_production'
          ? 'excluded'
          : 'unknown',
      effective_at: effectiveAt,
      change_ids: [],
      failure: 'unknown',
      rework: 'unknown',
      observed_at: latest(observations),
      change_links_complete: false,
      qualification_window: null,
      failure_evidence_refs: [],
      rework_evidence_refs: [],
      extensions: {
        mapping_revision: mapping.revision,
        tip_provenance: tips,
        reconciled_configuration_revisions: configuration,
      },
    });
  }
  const validation = validateSnapshot({
    dataset_id: input.datasetId,
    profile_version: '0.1-draft',
    snapshot_as_of_cutoff: true,
    window: { ...input.window },
    evidence_cutoff: input.evidenceCutoff,
    collection_complete: false,
    deployment_history_complete: false,
    recovery_evidence_complete: false,
    services: [
      {
        id: mapping.serviceId,
        name: mapping.serviceName,
        observed_at: mapping.observedAt,
        source_refs: [mapping.sourceRef],
      },
    ],
    changes: [],
    deployments: output,
    incidents: [],
  });
  return Object.freeze({ ...validation, diagnostics: Object.freeze(diagnostics) });
}

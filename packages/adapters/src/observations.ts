import type { DeploymentEvidence } from './model.ts';
import { AdapterError, content, eventBeforeObservation, identity, instant } from './value.ts';

/** GitHub updated_at is an explicit revision order; opaque provider revisions have no order. */
export function deploymentVersions(records: readonly DeploymentEvidence[]): DeploymentEvidence[] {
  const versions = new Map<string, DeploymentEvidence>();
  const cores = new Map<string, string>();
  for (const record of records) {
    const github = record.sourceId.startsWith('github:');
    if (github) eventBeforeObservation(record.revision, record.observedAt);
    const {
      environment: _environment,
      revision: _revision,
      observedAt: _observedAt,
      ...core
    } = record;
    const coreContent = content(core);
    const previousCore = cores.get(record.id);
    if (previousCore !== undefined && previousCore !== coreContent)
      throw new AdapterError('conflicting_source_record');
    cores.set(record.id, coreContent);
    const key = identity(record.id, github ? instant(record.revision).toString() : record.revision);
    const previous = versions.get(key);
    const { observedAt: _observation, revision: _sourceRevision, ...payload } = record;
    if (previous) {
      const {
        observedAt: _previousObservation,
        revision: _previousRevision,
        ...previousPayload
      } = previous;
      if (content(payload) !== content(previousPayload))
        throw new AdapterError('conflicting_source_record');
    }
    if (
      !previous ||
      instant(record.observedAt) < instant(previous.observedAt) ||
      (instant(record.observedAt) === instant(previous.observedAt) &&
        record.revision < previous.revision)
    )
      versions.set(key, record);
  }
  return [...versions.values()].sort(
    (a, b) => a.id.localeCompare(b.id) || a.revision.localeCompare(b.revision),
  );
}

export function currentDeployments(records: readonly DeploymentEvidence[]): DeploymentEvidence[] {
  const result = new Map<string, DeploymentEvidence>();
  for (const record of deploymentVersions(records)) {
    const previous = result.get(record.id);
    if (previous && !record.sourceId.startsWith('github:') && previous.revision !== record.revision)
      throw new AdapterError('conflicting_source_record');
    if (
      !previous ||
      (record.sourceId.startsWith('github:') &&
        instant(record.revision) > instant(previous.revision))
    )
      result.set(record.id, record);
  }
  return [...result.values()];
}

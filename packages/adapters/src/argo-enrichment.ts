import { createHash } from 'node:crypto';
import type { ArgoScope } from './argo-notification.ts';
import { AdapterError, content, identity, instant, object, timestamp } from './value.ts';

export interface ArgoEnrichmentScope extends ArgoScope {
  readonly producerId: string;
  readonly capability: 'consumer_exposure' | 'application_provenance';
  readonly policyReference: string;
  readonly repositoryIds: readonly string[];
}
type Common = Readonly<{
  contract: 'clio.argocd.enrichment.v1';
  event_id: string;
  source_id: string;
  producer_id: string;
  policy_reference: string;
  evidence_ref: string;
}>;
export type ArgoEnrichment = Common &
  (
    | Readonly<{
        kind: 'consumer_exposure';
        application_uid: string;
        operation_id: string;
        configuration_revision: string;
        effective_at: string;
        subject:
          | Readonly<{ kind: 'artifact'; digest: string }>
          | Readonly<{ kind: 'configuration'; revision: string }>;
      }>
    | Readonly<{
        kind: 'application_provenance';
        repository_id: string;
        commit_sha: string;
        artifact_digest: string;
      }>
  );
export type ArgoEnrichmentEvidence = Readonly<{
  scope: ArgoEnrichmentScope;
  event: ArgoEnrichment;
  observedAt: string;
  sourceRef: string;
}>;
export type ArgoExposureEvidence = ArgoEnrichmentEvidence & {
  readonly event: Extract<ArgoEnrichment, { kind: 'consumer_exposure' }>;
};
export type ArgoProvenanceEvidence = ArgoEnrichmentEvidence & {
  readonly event: Extract<ArgoEnrichment, { kind: 'application_provenance' }>;
};
export interface ArgoProvenanceGroup {
  readonly sourceId: string;
  readonly artifactDigest: string;
  readonly repositoryId: string;
  readonly commitSha: string;
  readonly sourceRef: string;
  observedAt: string;
  readonly assertions: ArgoProvenanceEvidence[];
}
/** Opaque producer references become valid OEMS URIs; original text stays in assertions. */
export function enrichmentReference(kind: 'policy' | 'evidence', value: string): string {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return `urn:clio:argo-${kind}-reference:${digest}`;
}
function exact(value: unknown, keys: readonly string[]) {
  const row = object(value);
  if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row)))
    throw new AdapterError('invalid_enrichment');
  return row;
}
function text(value: unknown, max = 200): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    !value ||
    Array.from(value).length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new AdapterError('invalid_enrichment');
  return value;
}
function uuid(value: unknown) {
  const result = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result))
    throw new AdapterError('invalid_enrichment');
  return result;
}
function digest(value: unknown) {
  const result = text(value);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) throw new AdapterError('invalid_enrichment');
  return result;
}
/** Header authentication and receiver-clock capture are owned by the API, never this parser. */
export function parseArgoEnrichment(
  input: unknown,
  scope: ArgoEnrichmentScope,
  observedAt: string,
): ArgoEnrichment {
  const keys = [
    'contract',
    'event_id',
    'source_id',
    'producer_id',
    'policy_reference',
    'evidence_ref',
    'kind',
  ];
  const initial = object(input);
  const row = exact(
    input,
    initial.kind === 'consumer_exposure'
      ? [
          ...keys,
          'application_uid',
          'operation_id',
          'configuration_revision',
          'effective_at',
          'subject',
        ]
      : [...keys, 'repository_id', 'commit_sha', 'artifact_digest'],
  );
  if (row.contract !== 'clio.argocd.enrichment.v1' || row.kind !== scope.capability)
    throw new AdapterError('invalid_enrichment');
  const common: Common = {
    contract: 'clio.argocd.enrichment.v1',
    event_id: uuid(row.event_id),
    source_id: uuid(row.source_id),
    producer_id: uuid(row.producer_id),
    policy_reference: text(row.policy_reference),
    evidence_ref: text(row.evidence_ref),
  };
  if (
    common.source_id !== scope.sourceId ||
    common.producer_id !== scope.producerId ||
    common.policy_reference !== scope.policyReference
  )
    throw new AdapterError('enrichment_scope_mismatch');
  timestamp(observedAt);
  if (row.kind === 'consumer_exposure') {
    const application_uid = text(row.application_uid),
      operation_id = uuid(row.operation_id),
      configuration_revision = text(row.configuration_revision),
      effective_at = timestamp(row.effective_at);
    if (
      application_uid !== scope.applicationUid ||
      !effective_at.endsWith('Z') ||
      instant(effective_at) > instant(observedAt)
    )
      throw new AdapterError('invalid_enrichment');
    const raw = object(row.subject);
    const item = exact(raw, raw.kind === 'artifact' ? ['kind', 'digest'] : ['kind', 'revision']);
    let subject: Extract<ArgoEnrichment, { kind: 'consumer_exposure' }>['subject'];
    if (item.kind === 'artifact')
      subject = Object.freeze({ kind: 'artifact', digest: digest(item.digest) });
    else if (item.kind === 'configuration' && text(item.revision) === configuration_revision)
      subject = Object.freeze({ kind: 'configuration', revision: configuration_revision });
    else throw new AdapterError('invalid_enrichment');
    return Object.freeze({
      ...common,
      kind: 'consumer_exposure',
      application_uid,
      operation_id,
      configuration_revision,
      effective_at,
      subject,
    });
  }
  const repository_id = text(row.repository_id, 2048),
    commit_sha = text(row.commit_sha);
  if (
    !/^[^:\s]+:.+/.test(repository_id) ||
    !scope.repositoryIds.includes(repository_id) ||
    !/^[0-9a-f]{40}$/.test(commit_sha)
  )
    throw new AdapterError('invalid_enrichment');
  return Object.freeze({
    ...common,
    kind: 'application_provenance',
    repository_id,
    commit_sha,
    artifact_digest: digest(row.artifact_digest),
  });
}

/** Independently qualified facts are joined without altering immutable native operations. */
export function prepareArgoEnrichments(input: {
  sourceId: string | undefined;
  enrichments: readonly ArgoEnrichmentEvidence[];
  cutoff: bigint;
  serviceId: string;
}) {
  const candidates = input.enrichments
    .filter((entry) => instant(entry.observedAt) <= input.cutoff)
    .map((entry) => ({
      ...entry,
      event: parseArgoEnrichment(entry.event, entry.scope, entry.observedAt),
    }))
    .sort((a, b) =>
      identity(a.event.producer_id, a.event.event_id).localeCompare(
        identity(b.event.producer_id, b.event.event_id),
      ),
    );
  const subjects = new Map<string, string>(),
    builds = new Map<string, string>(),
    events = new Map<string, string>();
  const unique = new Map<string, (typeof candidates)[number]>();
  for (const entry of candidates) {
    const { event, scope } = entry;
    if (scope.serviceId !== input.serviceId) throw new AdapterError('enrichment_scope_mismatch');
    const key = identity(scope.sourceId, event.producer_id, event.event_id),
      value = content(event),
      old = events.get(key);
    if (old && old !== value) throw new AdapterError('conflicting_enrichment_event');
    events.set(key, value);
    const prior = unique.get(key);
    if (!prior || instant(entry.observedAt) < instant(prior.observedAt)) unique.set(key, entry);
    const locks = event.kind === 'consumer_exposure' ? subjects : builds;
    const lock =
      event.kind === 'consumer_exposure'
        ? identity(scope.sourceId, event.application_uid, event.operation_id)
        : identity(scope.sourceId, event.artifact_digest);
    const statement =
      event.kind === 'consumer_exposure'
        ? content(event.subject)
        : content([event.repository_id, event.commit_sha]);
    if (locks.has(lock) && locks.get(lock) !== statement)
      throw new AdapterError('conflicting_enrichment_subject');
    locks.set(lock, statement);
  }
  const eligible = [...unique.values()];
  if (eligible.length && !input.sourceId) throw new AdapterError('missing_enrichment_source');
  const exposuresByDeployment = new Map<string, ArgoExposureEvidence[]>();
  const buildsByDigest = new Map<string, ArgoProvenanceGroup>();
  for (const entry of eligible) {
    if (entry.scope.sourceId !== input.sourceId) continue;
    if (entry.event.kind === 'consumer_exposure') {
      const exposure: ArgoExposureEvidence = { ...entry, event: entry.event };
      const key = identity(
        'application',
        entry.scope.applicationUid,
        'operation',
        entry.event.operation_id,
      );
      const entries = exposuresByDeployment.get(key) ?? [];
      entries.push(exposure);
      exposuresByDeployment.set(key, entries);
    } else {
      const provenance: ArgoProvenanceEvidence = { ...entry, event: entry.event };
      const group = buildsByDigest.get(entry.event.artifact_digest) ?? {
        sourceId: entry.scope.sourceId,
        artifactDigest: entry.event.artifact_digest,
        repositoryId: entry.event.repository_id,
        commitSha: entry.event.commit_sha,
        sourceRef: `urn:clio:argo-provenance:${entry.scope.sourceId}:${entry.event.artifact_digest}`,
        observedAt: entry.observedAt,
        assertions: [],
      };
      group.assertions.push(provenance);
      if (instant(entry.observedAt) > instant(group.observedAt))
        group.observedAt = entry.observedAt;
      buildsByDigest.set(entry.event.artifact_digest, group);
    }
  }
  const assertionKey = (entry: ArgoEnrichmentEvidence) =>
    identity(entry.event.producer_id, entry.event.event_id);
  const ordered = <T extends ArgoEnrichmentEvidence>(entries: Map<string, T>): T[] =>
    [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry);
  return (records: readonly import('./model.ts').DeploymentEvidence[], primarySourceId: string) => {
    const selected = new Map<string, ArgoExposureEvidence>();
    for (const record of records) {
      for (const entry of exposuresByDeployment.get(record.sourceDeploymentId) ?? []) {
        if (
          record.sourceId === primarySourceId &&
          record.sourceId === identity('argocd', entry.scope.instance) &&
          record.configurationRepositoryId === entry.scope.configurationRepositoryId &&
          record.environment === entry.scope.environment &&
          record.operationKind === 'rollout' &&
          record.reconciledConfigurationRevision === entry.event.configuration_revision &&
          instant(record.eventAt) <= instant(entry.event.effective_at)
        )
          selected.set(assertionKey(entry), entry);
      }
    }
    const exposures = ordered(selected);
    const attached: ArgoProvenanceGroup[] = [];
    const artifactDigests = new Set(
      exposures.flatMap((exposure) =>
        exposure.event.subject.kind === 'artifact' ? [exposure.event.subject.digest] : [],
      ),
    );
    for (const digest of artifactDigests) {
      const group = buildsByDigest.get(digest);
      if (group) attached.push(group);
    }
    return { exposures, attached: attached.sort((a, b) => a.sourceRef.localeCompare(b.sourceRef)) };
  };
}

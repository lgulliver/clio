import { createHash } from 'node:crypto';
import {
  calculate,
  type Dataset,
  type Deployment,
  type MetricResult,
  type ValidatedSnapshot,
  validateSnapshot,
  validateStructure,
} from '@clio/oems';
import {
  demand,
  exact,
  list,
  type MeasurementAuthorityScope,
  type MeasurementBasisContext,
  type MeasurementCapability,
  type MeasurementGap,
  type MeasurementInterval,
  type MeasurementNativeRecord,
  type MeasurementReport,
  measurementJsonBytes,
  measurementLimits,
  nativeIdentity,
  nativeKey,
  parseMeasurementBasis,
  parseMeasurementGap,
  parseMeasurementReport,
  text,
  texts,
  unique,
  utc,
  uuid,
} from './measurement-evidence-contract.ts';
import { AdapterError, content, instant } from './value.ts';

export { parseMeasurementReport } from './measurement-evidence-contract.ts';

export type MeasurementBlocker =
  | 'population_missing'
  | 'population_interval'
  | 'population_paths'
  | 'population_roster_mismatch'
  | 'gap_manifest_missing'
  | 'gap_resolution_mismatch'
  | 'history_missing'
  | 'history_population'
  | 'history_origin'
  | 'history_change_links'
  | 'recovery_classification_missing'
  | 'recovery_missing'
  | 'recovery_interval';
export type MeasurementAssessment = {
  blockers: MeasurementBlocker[];
  collectionComplete: boolean;
  historyComplete: boolean;
  recoveryComplete: boolean;
};
export type ReceivedMeasurementReport = { report: unknown; observedAt: string };
export type MeasurementEvidenceInput = {
  basis: ValidatedSnapshot;
  context: MeasurementBasisContext;
  nativeIndex: readonly MeasurementNativeRecord[];
  /** null means server lacks an exact retained gap manifest; [] is exact and empty. */
  gapManifest: readonly MeasurementGap[] | null;
  authorityScopes: readonly MeasurementAuthorityScope[];
  reports: readonly ReceivedMeasurementReport[];
  measurementCutoff: string;
};
export type MeasurementEvidenceResult = {
  snapshot: ValidatedSnapshot;
  assessment: MeasurementAssessment;
  metrics: MetricResult[];
};
type Accepted = { report: MeasurementReport; observedAt: string; scope: MeasurementAuthorityScope };
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function ref(producerId: string, value: string): string {
  return `urn:clio:measurement:sha256:${hash(JSON.stringify([producerId, value]))}`;
}
function covers(outer: MeasurementInterval, inner: MeasurementInterval): boolean {
  return instant(outer.start) <= instant(inner.start) && instant(outer.end) >= instant(inner.end);
}
function overlaps(a: MeasurementInterval, b: MeasurementInterval): boolean {
  return instant(a.start) < instant(b.end) && instant(a.end) > instant(b.start);
}
function relevant(deployment: Deployment, bounds: MeasurementInterval): boolean {
  if (deployment.qualification === 'excluded') return false;
  if (deployment.qualification === 'unknown' && deployment.qualification_window !== null)
    return overlaps(deployment.qualification_window, bounds);
  if (deployment.effective_at === null) return true;
  return (
    instant(deployment.effective_at) >= instant(bounds.start) &&
    instant(deployment.effective_at) < instant(bounds.end)
  );
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry) => b.includes(entry));
}
function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}
function parseScope(input: unknown): MeasurementAuthorityScope {
  const v = exact(input, [
    'producerId',
    'workspaceId',
    'serviceId',
    'capability',
    'policyRef',
    'basis',
    'productionPaths',
    'repositoryIds',
  ]);
  demand(
    v.capability === 'population' ||
      v.capability === 'change_links' ||
      v.capability === 'classification' ||
      v.capability === 'recovery',
    'capability',
  );
  return {
    producerId: uuid(v.producerId),
    workspaceId: uuid(v.workspaceId),
    serviceId: uuid(v.serviceId),
    capability: v.capability,
    policyRef: text(v.policyRef),
    basis: parseMeasurementBasis(v.basis),
    productionPaths: texts(v.productionPaths),
    repositoryIds: texts(v.repositoryIds),
  };
}
function parseNative(input: unknown): MeasurementNativeRecord {
  const v = exact(input, ['sourceId', 'sourceDeploymentId', 'deploymentId', 'productionPath']);
  return {
    ...nativeIdentity(v),
    deploymentId: text(v.deploymentId),
    productionPath: text(v.productionPath),
  };
}
function lineage(deployment: Deployment, accepted: Accepted): void {
  const { report, observedAt } = accepted;
  // Lineage stays private in snapshot extensions. Only assessment/metric fields are public-safe.
  const existing = deployment.extensions?.clio_measurement_lineage;
  const records = Array.isArray(existing) ? [...existing] : [];
  records.push({
    eventId: report.eventId,
    producerId: report.producerId,
    capability: report.capability,
    policyRef: report.policyRef,
    evidenceRef: report.evidenceRef,
    basis: report.basis,
    observedAt,
  });
  deployment.extensions = { ...deployment.extensions, clio_measurement_lineage: records };
  deployment.source_refs = union(deployment.source_refs, [
    ref(report.producerId, report.evidenceRef),
  ]);
  if (instant(observedAt) > instant(deployment.observed_at)) deployment.observed_at = observedAt;
}

/** Pure server boundary. Does not authenticate ingress or recompute native digests/current
 * eligibility. Caller must supply authenticated grants, immutable basis/manifests, receiver
 * timestamps and current exact digests. Reports cannot supply native canonical identity. */
export function deriveMeasurementEvidence(
  input: MeasurementEvidenceInput,
): MeasurementEvidenceResult {
  // OEMS checks its unforgeable WeakMap capability before reading any basis data.
  calculate(input.basis);
  const cutoff = utc(input.measurementCutoff);
  demand(instant(cutoff) >= instant(input.basis.data.evidence_cutoff), 'cutoff');
  const c = exact(input.context, ['workspaceId', 'serviceId', 'canonicalServiceId', 'basis']);
  const context: MeasurementBasisContext = {
    workspaceId: uuid(c.workspaceId),
    serviceId: uuid(c.serviceId),
    canonicalServiceId: text(c.canonicalServiceId),
    basis: parseMeasurementBasis(c.basis),
  };
  const copy = validateStructure('dataset', input.basis.data);
  demand(copy.ok, 'basis');
  const data: Dataset = copy.data;
  demand(
    data.services.length === 1 &&
      data.services[0]?.id === context.canonicalServiceId &&
      data.deployments.every((d) => d.service_id === context.canonicalServiceId),
    'native_manifest',
  );
  const nativeIndex = list(input.nativeIndex, parseNative);
  const deploymentById = new Map(data.deployments.map((d) => [d.id, d]));
  demand(
    nativeIndex.length === data.deployments.length &&
      new Set(nativeIndex.map(nativeKey)).size === nativeIndex.length &&
      new Set(nativeIndex.map((n) => n.deploymentId)).size === nativeIndex.length &&
      nativeIndex.every(
        (n) => n.sourceId === context.basis.sourceId && deploymentById.has(n.deploymentId),
      ),
    'native_manifest',
  );
  const nativeByKey = new Map(nativeIndex.map((n) => [nativeKey(n), n]));
  const gaps = input.gapManifest === null ? null : list(input.gapManifest, parseMeasurementGap);
  if (gaps !== null) {
    unique(gaps, (g) => g.gapId);
    demand(
      gaps.every((g) => g.sourceId === context.basis.sourceId),
      'gap_manifest',
    );
  }
  const scopes = list(input.authorityScopes, parseScope);
  demand(input.reports.length <= 32, 'record_limit');
  let totalBytes = 0;
  const accepted = new Map<MeasurementCapability, Accepted>();
  const events = new Map<string, string>();
  for (const receipt of input.reports) {
    exact(receipt, ['report', 'observedAt']);
    totalBytes += measurementJsonBytes(receipt.report);
    demand(totalBytes <= measurementLimits.payloadBytes, 'payload_limit');
    const report = parseMeasurementReport(receipt.report);
    const observedAt = utc(receipt.observedAt);
    demand(
      instant(observedAt) <= instant(cutoff) &&
        instant(observedAt) >= instant(data.evidence_cutoff),
      'cutoff',
    );
    demand(
      report.workspaceId === context.workspaceId &&
        report.serviceId === context.serviceId &&
        content(report.basis) === content(context.basis),
      'scope_mismatch',
    );
    const matches = scopes.filter(
      (scope) =>
        scope.producerId === report.producerId &&
        scope.workspaceId === report.workspaceId &&
        scope.serviceId === report.serviceId &&
        scope.capability === report.capability &&
        scope.policyRef === report.policyRef &&
        content(scope.basis) === content(report.basis),
    );
    demand(matches.length === 1, 'scope_mismatch');
    const scope = matches[0];
    demand(scope !== undefined, 'scope_mismatch');
    const fingerprint = content(report);
    const event = events.get(report.eventId);
    demand(event === undefined || event === fingerprint, 'report_conflict');
    events.set(report.eventId, fingerprint);
    const prior = accepted.get(report.capability);
    if (prior) {
      demand(content(prior.report) === fingerprint, 'report_conflict');
      if (instant(observedAt) < instant(prior.observedAt)) prior.observedAt = observedAt;
    } else accepted.set(report.capability, { report, observedAt, scope });
  }
  const blockers: MeasurementBlocker[] = [];
  function block(code: MeasurementBlocker): void {
    if (!blockers.includes(code)) blockers.push(code);
  }
  function operation(
    identity: { sourceId: string; sourceDeploymentId: string },
    scope: MeasurementAuthorityScope,
  ): Deployment {
    const native = nativeByKey.get(nativeKey(identity));
    demand(native !== undefined, 'native_operation');
    demand(scope.productionPaths.includes(native.productionPath), 'operation_scope');
    const deployment = deploymentById.get(native.deploymentId);
    demand(deployment !== undefined, 'native_operation');
    return deployment;
  }
  function independent(report: MeasurementReport, evidenceRef: string): void {
    demand(evidenceRef !== report.evidenceRef, 'independent_reference');
  }
  function available(value: string, observedAt: string): void {
    demand(
      instant(value) <= instant(observedAt) && instant(value) <= instant(cutoff),
      'future_fact',
    );
  }

  const population = accepted.get('population');
  let collectionComplete = false;
  if (population?.report.capability !== 'population') block('population_missing');
  else {
    const { report, scope, observedAt } = population;
    const p = report.payload;
    const before = blockers.length;
    if (!covers(p.interval, data.window) || instant(p.interval.end) > instant(observedAt))
      block('population_interval');
    if (
      !p.productionPaths.length ||
      !sameSet(p.productionPaths, scope.productionPaths) ||
      nativeIndex.some((n) => {
        const d = deploymentById.get(n.deploymentId);
        return (
          d !== undefined &&
          relevant(d, p.interval) &&
          !scope.productionPaths.includes(n.productionPath)
        );
      })
    )
      block('population_paths');
    const relevantKeys = nativeIndex
      .filter((n) => {
        const deployment = deploymentById.get(n.deploymentId);
        return deployment !== undefined && relevant(deployment, p.interval);
      })
      .map(nativeKey);
    if (!sameSet(relevantKeys, p.operations.map(nativeKey))) block('population_roster_mismatch');
    if (gaps === null) block('gap_manifest_missing');
    else {
      const relevantGaps = gaps.filter((g) => g.bounds === null || overlaps(g.bounds, p.interval));
      if (
        !sameSet(
          relevantGaps.map((g) => g.gapId),
          p.gapResolutions.map((r) => r.gap.gapId),
        )
      )
        block('gap_resolution_mismatch');
      for (const resolution of p.gapResolutions) {
        const gap = relevantGaps.find((g) => g.gapId === resolution.gap.gapId);
        if (
          !gap ||
          content(gap) !== content(resolution.gap) ||
          !covers(resolution.scope, gap.bounds ?? p.interval) ||
          instant(resolution.scope.end) > instant(observedAt) ||
          resolution.evidenceRef === report.evidenceRef
        )
          block('gap_resolution_mismatch');
      }
    }
    collectionComplete = before === blockers.length;
  }

  const links = accepted.get('change_links');
  if (links?.report.capability === 'change_links') {
    const { report, scope, observedAt } = links;
    const byChangeKey = new Map(
      data.changes.map((change) => [
        JSON.stringify([change.repository_id, change.commit_id.toLowerCase()]),
        change,
      ]),
    );
    for (const assertion of report.payload.operations) {
      independent(report, assertion.evidenceRef);
      const deployment = operation(assertion, scope);
      const ids: string[] = [];
      for (const change of assertion.changes) {
        demand(scope.repositoryIds.includes(change.repositoryId), 'repository_scope');
        independent(report, change.evidenceRef);
        available(change.committedAt, observedAt);
        if (deployment.qualification === 'qualifying')
          demand(
            deployment.effective_at !== null &&
              instant(change.committedAt) <= instant(deployment.effective_at),
            'negative_lead_time',
          );
        const key = JSON.stringify([change.repositoryId, change.commitId]);
        let known = byChangeKey.get(key);
        if (known)
          demand(instant(known.committed_at) === instant(change.committedAt), 'change_conflict');
        else {
          known = {
            id: `change:clio:${hash(key)}`,
            repository_id: change.repositoryId,
            commit_id: change.commitId,
            committed_at: change.committedAt,
            source_refs: [ref(report.producerId, change.evidenceRef)],
            observed_at: observedAt,
            extensions: {
              clio_measurement_lineage: {
                producerId: report.producerId,
                eventId: report.eventId,
                policyRef: report.policyRef,
                evidenceRef: change.evidenceRef,
              },
            },
          };
          byChangeKey.set(key, known);
          data.changes.push(known);
        }
        ids.push(known.id);
      }
      demand(
        deployment.change_ids.every((id) => ids.includes(id)) &&
          (!deployment.change_links_complete || sameSet(deployment.change_ids, ids)),
        'change_links_conflict',
      );
      deployment.change_ids = ids;
      deployment.change_links_complete = true;
      lineage(deployment, links);
    }
  }
  let historyComplete = false;
  if (links?.report.capability !== 'change_links' || links.report.payload.history === null)
    block('history_missing');
  else {
    const h = links.report.payload.history;
    independent(links.report, h.evidenceRef);
    const before = blockers.length;
    if (
      !collectionComplete ||
      population?.report.capability !== 'population' ||
      !covers(population.report.payload.interval, h.interval)
    )
      block('history_population');
    if (
      instant(h.interval.start) > instant(data.window.start) ||
      instant(h.interval.end) < instant(data.window.end) ||
      instant(h.interval.end) > instant(links.observedAt) ||
      data.deployments.some(
        (d) =>
          d.qualification === 'qualifying' &&
          d.effective_at !== null &&
          instant(d.effective_at) < instant(h.interval.start),
      )
    )
      block('history_origin');
    // Require explicit assertions, including prewindow native observations and empty sets.
    const asserted = new Set(
      links.report.payload.operations.map((a) => operation(a, links.scope).id),
    );
    if (
      data.deployments.some(
        (d) =>
          d.qualification === 'qualifying' &&
          d.effective_at !== null &&
          instant(d.effective_at) < instant(data.window.end) &&
          (!d.change_links_complete || !asserted.has(d.id)),
      )
    )
      block('history_change_links');
    historyComplete = before === blockers.length;
  }
  const classification = accepted.get('classification');
  if (classification?.report.capability === 'classification') {
    const { report, observedAt, scope } = classification;
    for (const assertion of report.payload.operations) {
      const deployment = operation(assertion, scope);
      demand(
        assertion.failure !== 'failed' || deployment.qualification === 'qualifying',
        'failure_qualification',
      );
      for (const field of ['failure', 'rework'] as const) {
        const decision = assertion[field];
        const evidence =
          field === 'failure' ? assertion.failureEvidenceRef : assertion.reworkEvidenceRef;
        demand(
          deployment[field] === 'unknown' || deployment[field] === decision,
          'classification_conflict',
        );
        if (evidence !== null) independent(report, evidence);
        if (field === 'failure') {
          deployment.failure = assertion.failure;
          if (evidence !== null)
            deployment.failure_evidence_refs = union(deployment.failure_evidence_refs, [
              ref(report.producerId, evidence),
            ]);
        } else {
          deployment.rework = assertion.rework;
          if (evidence !== null)
            deployment.rework_evidence_refs = union(deployment.rework_evidence_refs, [
              ref(report.producerId, evidence),
            ]);
        }
      }
      available(deployment.effective_at ?? observedAt, observedAt);
      lineage(deployment, classification);
    }
  }
  let recoveryComplete = false;
  const recovery = accepted.get('recovery');
  if (recovery?.report.capability !== 'recovery') block('recovery_missing');
  else {
    const { report, observedAt } = recovery;
    const r = report.payload;
    recoveryComplete =
      covers(r.interval, data.window) && instant(r.interval.end) <= instant(observedAt);
    if (!recoveryComplete) block('recovery_interval');
    for (const episode of r.episodes) {
      independent(report, episode.evidenceRef);
      const causal = operation(episode, recovery.scope);
      if (causal.qualification === 'qualifying' && causal.failure === 'unknown') {
        recoveryComplete = false;
        block('recovery_classification_missing');
        continue;
      }
      demand(
        causal.qualification === 'qualifying' &&
          causal.failure === 'failed' &&
          causal.effective_at !== null,
        'recovery_causal',
      );
      demand(
        instant(episode.onset) >= instant(causal.effective_at) &&
          (!episode.approximate || instant(episode.onset) === instant(causal.effective_at)),
        'recovery_onset',
      );
      demand(
        instant(episode.onset) >= instant(r.interval.start) &&
          instant(episode.onset) < instant(r.interval.end),
        'recovery_interval',
      );
      available(episode.onset, observedAt);
      if (episode.restored !== null) available(episode.restored, observedAt);
      const id = `incident:clio:${hash(JSON.stringify([report.producerId, episode.episodeId]))}`;
      const known = data.incidents.find((i) => i.id === id);
      if (known) {
        demand(
          known.causal_deployment_id === causal.id &&
            instant(known.failure_started_at) === instant(episode.onset) &&
            known.restored_at === episode.restored &&
            known.start_is_approximate === episode.approximate &&
            known.source_refs.includes(ref(report.producerId, episode.evidenceRef)),
          'incident_conflict',
        );
      } else
        data.incidents.push({
          id,
          service_id: context.canonicalServiceId,
          causal_deployment_id: causal.id,
          failure_started_at: episode.onset,
          restored_at: episode.restored,
          start_is_approximate: episode.approximate,
          observed_at: observedAt,
          source_refs: [ref(report.producerId, episode.evidenceRef)],
          extensions: {
            clio_measurement_lineage: {
              producerId: report.producerId,
              eventId: report.eventId,
              policyRef: report.policyRef,
              episodeId: episode.episodeId,
              evidenceRef: episode.evidenceRef,
              basis: report.basis,
            },
          },
        });
    }
    // Exhaustive census cannot silently omit an existing onset in its interval.
    const reported = new Set(
      r.episodes.map(
        (e) => `incident:clio:${hash(JSON.stringify([report.producerId, e.episodeId]))}`,
      ),
    );
    demand(
      data.incidents.every(
        (i) =>
          !(
            instant(i.failure_started_at) >= instant(r.interval.start) &&
            instant(i.failure_started_at) < instant(r.interval.end)
          ) || reported.has(i.id),
      ),
      'incident_census_conflict',
    );
  }
  demand(
    data.changes.length <= measurementLimits.records &&
      data.incidents.length <= measurementLimits.records,
    'record_limit',
  );
  const service = data.services[0];
  demand(service !== undefined, 'native_manifest');
  const oldReports = service.extensions?.clio_measurement_reports;
  service.extensions = {
    ...service.extensions,
    clio_measurement_reports: [
      ...(Array.isArray(oldReports) ? oldReports : []),
      ...[...accepted.values()]
        .sort((a, b) => a.report.capability.localeCompare(b.report.capability))
        .map(({ report, observedAt }) => ({ report, observedAt })),
    ],
  };
  data.collection_complete = collectionComplete;
  data.deployment_history_complete = historyComplete;
  data.recovery_evidence_complete = recoveryComplete;
  data.evidence_cutoff = cutoff;
  data.dataset_id = `measurement:${hash(content({ context, cutoff, reports: [...accepted.values()].map(({ report, observedAt }) => ({ report, observedAt })).sort((a, b) => a.report.capability.localeCompare(b.report.capability)) }))}`;
  const validated = validateSnapshot(data);
  if (!validated.ok) throw new AdapterError('measurement_snapshot_invalid');
  return {
    snapshot: validated.data,
    assessment: {
      blockers: blockers.sort(),
      collectionComplete,
      historyComplete,
      recoveryComplete,
    },
    metrics: calculate(validated.data),
  };
}

import { isDeepStrictEqual } from 'node:util';
import {
  type ArgoScope,
  type EvidenceBatch,
  identity,
  type MeasurementBasisContext,
  type MeasurementGap,
  type MeasurementNativeRecord,
} from '@clio/adapters';
import { calculate, oemsContract, type ValidatedSnapshot, validateSnapshot } from '@clio/oems';
import {
  mergeHistory as mergeArgoHistory,
  parseEvidence as parseArgoEvidence,
} from '../argo-collection/history.ts';
import { parseConnection as parseArgoConnection } from '../argo-collection/input.ts';
import { snapshotDigest } from '../github-collection/digest.ts';
import { boundedJson, parseEvidence as parseGitHubEvidence } from '../github-collection/history.ts';
import {
  instant,
  parseConnection as parseGitHubConnection,
  positive,
  text,
  timestamp,
} from '../github-collection/input.ts';
import { name, object, uuid } from '../identity/input.ts';

export type RetainedMeasurementGap = MeasurementGap;
export interface RetainedGapManifest {
  version: 1;
  complete: boolean;
  gaps: RetainedMeasurementGap[];
}
export function parseRetainedGapManifest(input: unknown): RetainedGapManifest {
  boundedJson(input);
  const row = object(input, ['version', 'complete', 'gaps']);
  if (
    row.version !== 1 ||
    typeof row.complete !== 'boolean' ||
    !Array.isArray(row.gaps) ||
    row.gaps.length > 5000
  )
    throw new Error('Invalid retained measurement gaps');
  const gaps = row.gaps.map((input: unknown): RetainedMeasurementGap => {
    const gap = object(input, ['gapId', 'sourceId', 'reason', 'bounds']);
    let bounds: RetainedMeasurementGap['bounds'] = null;
    if (gap.bounds !== null) {
      const value = object(gap.bounds, ['start', 'end']);
      bounds = { start: timestamp(value.start), end: timestamp(value.end) };
      if (instant(bounds.start) >= instant(bounds.end)) throw new Error('Invalid gap bounds');
    }
    return {
      gapId: text(gap.gapId, 4096),
      sourceId: text(gap.sourceId, 4096),
      reason: text(gap.reason),
      bounds,
    };
  });
  if (new Set(gaps.map((gap) => gap.gapId)).size !== gaps.length)
    throw new Error('Duplicate retained measurement gap');
  return { version: 1, complete: row.complete, gaps };
}

/** Private parsing boundary, not authorization. Caller must select an immutable successful
 * run in an authorized transaction and fence its current source grant before using it.
 * Source IDs and paths come from private operator configuration, never report claims. */
export function readNativeMeasurementBasis(input: {
  provider: 'github' | 'argocd';
  runId: string;
  workspaceId: string;
  serviceId: string;
  sourceId: string;
  connectionRevision: number;
  productionPath: string;
  argoScope?: ArgoScope;
  capture: unknown;
}): {
  context: MeasurementBasisContext;
  snapshot: ValidatedSnapshot;
  nativeIndex: MeasurementNativeRecord[];
  gaps: MeasurementGap[];
  gapManifestComplete: boolean;
  gapManifest: MeasurementGap[] | null;
} {
  const workspaceId = uuid(input.workspaceId),
    serviceId = uuid(input.serviceId),
    runId = uuid(input.runId);
  const sourceId = text(input.sourceId, 4096),
    productionPath = text(input.productionPath, 4096);
  boundedJson(input.capture);
  const row = object(input.capture, [
    'connection',
    'serviceName',
    'evidence',
    'snapshot',
    'metrics',
    'oemsRevision',
    'result',
    'digest',
  ]);
  const connection =
    input.provider === 'github'
      ? parseGitHubConnection(row.connection)
      : parseArgoConnection(row.connection);
  if (
    connection.workspaceId !== workspaceId ||
    connection.serviceId !== serviceId ||
    connection.provider !== input.provider ||
    connection.revision !== positive(input.connectionRevision) ||
    !connection.active ||
    row.oemsRevision !== oemsContract.revision
  )
    throw new Error('Measurement basis scope mismatch');
  const expectedSource =
    connection.provider === 'github'
      ? identity('github', String(connection.installationId))
      : identity('argocd', connection.instance);
  if (sourceId !== expectedSource) throw new Error('Measurement source identity mismatch');
  const serviceName = name(row.serviceName);
  const digest = text(row.digest);
  const actualDigest = snapshotDigest({
    connection,
    serviceName,
    evidence: row.evidence,
    snapshot: row.snapshot,
    metrics: row.metrics,
    oemsRevision: row.oemsRevision,
    result: row.result,
  });
  if (!/^[0-9a-f]{64}$/.test(digest) || digest !== actualDigest)
    throw new Error('Measurement basis digest mismatch');
  const checked = validateSnapshot(row.snapshot);
  if (
    !checked.ok ||
    checked.data.data.services.length !== 1 ||
    checked.data.data.services[0]?.id !== serviceId ||
    checked.data.data.dataset_id !==
      identity(input.provider === 'github' ? 'live-github' : 'live-argocd', runId) ||
    !isDeepStrictEqual(calculate(checked.data), row.metrics)
  )
    throw new Error('Invalid native measurement snapshot');
  const snapshot = checked.data;
  if (instant(connection.observedAt) > instant(snapshot.data.evidence_cutoff))
    throw new Error('Measurement basis connection after cutoff');
  const evidenceRow = object(row.evidence, [
    'deployments',
    'statuses',
    'completedStatusTraversals',
    'argoArchiveLineages',
    'argoEnrichments',
    'argoEnrichmentScopes',
    'nativeGapManifest',
  ]);
  let evidence: EvidenceBatch;
  if (connection.provider === 'github') {
    if (Object.keys(evidenceRow).some((key) => key.startsWith('argo')))
      throw new Error('Foreign native measurement evidence');
    evidence = parseGitHubEvidence(
      {
        deployments: evidenceRow.deployments,
        statuses: evidenceRow.statuses,
        completedStatusTraversals: evidenceRow.completedStatusTraversals,
      },
      connection,
    );
  } else {
    const scope = input.argoScope;
    if (
      !scope ||
      scope.workspaceId !== workspaceId ||
      scope.serviceId !== serviceId ||
      scope.sourceId !== connection.sourceId ||
      scope.instance !== connection.instance ||
      scope.applicationName !== connection.applicationName ||
      scope.applicationNamespace !== connection.applicationNamespace ||
      scope.environment !== connection.productionEnvironment
    )
      throw new Error('Measurement basis Argo scope mismatch');
    if (
      !Array.isArray(evidenceRow.deployments) ||
      !Array.isArray(evidenceRow.statuses) ||
      evidenceRow.deployments.length + evidenceRow.statuses.length > 5000 ||
      evidenceRow.completedStatusTraversals !== undefined
    )
      throw new Error('Invalid native measurement evidence');
    const deployments = new Map<string, unknown>();
    for (const record of evidenceRow.deployments) {
      const value = object(record, [
        'id',
        'sourceId',
        'sourceDeploymentId',
        'revision',
        'environment',
        'eventAt',
        'observedAt',
        'sourceRef',
        'repository',
        'reconciledConfigurationRevision',
        'configurationRepositoryId',
        'deploymentTask',
        'operationKind',
      ]);
      const key = text(value.id, 2048);
      if (deployments.has(key)) throw new Error('Duplicate native measurement operation');
      deployments.set(key, record);
    }
    const used = new Set<string>();
    const batches = evidenceRow.statuses.map((record: unknown) => {
      const status = object(record, [
        'id',
        'deploymentId',
        'revision',
        'environment',
        'signal',
        'health',
        'consumerExposure',
        'eventAt',
        'observedAt',
        'sourceRef',
      ]);
      const key = text(status.deploymentId, 2048),
        deployment = deployments.get(key);
      if (!deployment) throw new Error('Unmatched native measurement status');
      used.add(key);
      // Aggregated history preserves each record's first receiver availability;
      // the per-notification parser requires matching observation times.
      const d = object(deployment, [
        'id',
        'sourceId',
        'sourceDeploymentId',
        'revision',
        'environment',
        'eventAt',
        'observedAt',
        'sourceRef',
        'repository',
        'reconciledConfigurationRevision',
        'configurationRepositoryId',
        'deploymentTask',
        'operationKind',
      ]);
      const observedAt = timestamp(status.observedAt);
      if (instant(timestamp(d.observedAt)) > instant(observedAt))
        throw new Error('Native status predates operation availability');
      return parseArgoEvidence({ deployments: [{ ...d, observedAt }], statuses: [status] }, scope);
    });
    if (used.size !== deployments.size) throw new Error('Native operation missing status');
    evidence = mergeArgoHistory(batches);
  }
  const native = new Map<
    string,
    { sourceId: string; sourceDeploymentId: string; deploymentId: string; productionPath: string }
  >();
  const primary =
    connection.provider === 'github'
      ? identity('github', String(connection.installationId))
      : identity('argocd', connection.instance);
  for (const record of evidence.deployments) {
    if (
      record.sourceId !== primary ||
      instant(record.observedAt) > instant(snapshot.data.evidence_cutoff)
    )
      throw new Error('Foreign or late native measurement operation');
    const groupId = identity('source', record.sourceId, record.sourceDeploymentId);
    const deploymentId = identity('deployment', serviceId, groupId);
    const deployment = snapshot.data.deployments.find((item) => item.id === deploymentId);
    if (!deployment || deployment.rollout_group_id !== groupId)
      throw new Error('Native measurement identity mismatch');
    native.set(deploymentId, {
      sourceId: record.sourceId,
      sourceDeploymentId: record.sourceDeploymentId,
      deploymentId,
      productionPath,
    });
  }
  if (native.size !== snapshot.data.deployments.length)
    throw new Error('Unmatched canonical measurement deployment');
  for (const record of [...evidence.statuses, ...(evidence.completedStatusTraversals ?? [])])
    if (instant(record.observedAt) > instant(snapshot.data.evidence_cutoff))
      throw new Error('Late native measurement evidence');
  let manifest: RetainedGapManifest;
  if (evidenceRow.nativeGapManifest !== undefined)
    manifest = parseRetainedGapManifest(evidenceRow.nativeGapManifest);
  else if (connection.provider === 'github') {
    const result = object(row.result, [
      'mode',
      'workspaceId',
      'serviceId',
      'connectionRevision',
      'oemsRevision',
      'window',
      'evidenceCutoff',
      'transportComplete',
      'deploymentCount',
      'qualifyingCount',
      'unknownCount',
      'coverage',
      'deploymentFrequency',
      'changeFailureRate',
      'failedDeploymentRecoveryTime',
      'metricResult',
    ]);
    if (typeof result.transportComplete !== 'boolean')
      throw new Error('Missing native transport assessment');
    manifest = {
      version: 1,
      complete: true,
      gaps: result.transportComplete
        ? []
        : [
            {
              gapId: identity('github-transport', runId),
              sourceId,
              reason: 'transport_incomplete',
              bounds: null,
            },
          ],
    };
  } else manifest = { version: 1, complete: false, gaps: [] };
  if (
    manifest.gaps.some(
      (gap) =>
        gap.sourceId !== sourceId ||
        (gap.bounds !== null && instant(gap.bounds.end) > instant(snapshot.data.evidence_cutoff)),
    )
  )
    throw new Error('Foreign or late retained measurement gap');
  if (
    connection.provider === 'argocd' &&
    manifest.complete &&
    !manifest.gaps.some((gap) => gap.reason === 'transport_incomplete' && gap.bounds === null)
  )
    throw new Error('Missing Argo transport uncertainty');
  return {
    context: {
      workspaceId,
      serviceId,
      canonicalServiceId: serviceId,
      basis: {
        provider: input.provider,
        runId,
        sourceId,
        connectionRevision: connection.revision,
        oemsRevision: oemsContract.revision,
        snapshotDigest: digest,
        evidenceDigest: snapshotDigest(row.evidence),
        gapManifestDigest: snapshotDigest(manifest),
      },
    },
    snapshot,
    nativeIndex: [...native.values()].sort((a, b) => a.deploymentId.localeCompare(b.deploymentId)),
    gaps: manifest.gaps,
    gapManifestComplete: manifest.complete,
    gapManifest: manifest.complete ? manifest.gaps : null,
  };
}

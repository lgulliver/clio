import {
  identity,
  type MeasurementCapability,
  type MeasurementReport,
  parseMeasurementReport,
} from '../../../packages/adapters/src/index.ts';
import {
  demand,
  exact,
  interval,
  list,
  measurementJsonBytes,
  parseMeasurementBasis,
  parseMeasurementGap,
  text,
  unique,
  utc,
  uuid,
} from '../../../packages/adapters/src/measurement-evidence-contract.ts';
import { content, instant, sha } from '../../../packages/adapters/src/value.ts';

export const lifecycleCapabilities = [
  'population',
  'change_links',
  'classification',
  'recovery',
] as const;
/** Strict operator ledger. HTTP polls support classifications, never exact outage onset. */
export function parseLifecycleLedger(input: unknown) {
  measurementJsonBytes(input);
  const row = exact(input, [
    'contract',
    'workspaceId',
    'serviceId',
    'applicationUid',
    'repositoryId',
    'startedAt',
    'closedAt',
    'operations',
  ]);
  demand(row.contract === 'clio.sandbox.lifecycle.v1', 'lifecycle_contract');
  const startedAt = utc(row.startedAt),
    closedAt = utc(row.closedAt);
  demand(instant(startedAt) < instant(closedAt), 'lifecycle_interval');
  const repositoryId = text(row.repositoryId);
  demand(/^[^:\s]+:.+/.test(repositoryId), 'lifecycle_repository');
  const operations = list(row.operations, (input) => {
    const op = exact(input, [
      'stage',
      'operationId',
      'commitSha',
      'committedAt',
      'effectiveAt',
      'healthObservedAt',
      'healthStatus',
      'evidenceRef',
    ]);
    const committedAt = utc(op.committedAt),
      effectiveAt = utc(op.effectiveAt),
      healthObservedAt = utc(op.healthObservedAt);
    demand(
      instant(startedAt) <= instant(effectiveAt) &&
        instant(committedAt) <= instant(effectiveAt) &&
        instant(effectiveAt) <= instant(healthObservedAt) &&
        instant(healthObservedAt) <= instant(closedAt),
      'lifecycle_order',
    );
    return {
      stage: text(op.stage),
      operationId: uuid(op.operationId),
      commitSha: sha(op.commitSha),
      committedAt,
      effectiveAt,
      healthObservedAt,
      healthStatus: op.healthStatus,
      evidenceRef: text(op.evidenceRef),
    };
  });
  demand(operations.length === 3, 'lifecycle_roster');
  operations.forEach((op, i) => {
    demand(
      op.stage === ['healthy', 'broken', 'recovery'][i] && op.healthStatus === [200, 503, 200][i],
      'lifecycle_stage',
    );
    const previous = operations[i - 1];
    if (previous)
      demand(
        instant(previous.healthObservedAt) < instant(op.healthObservedAt) &&
          instant(previous.healthObservedAt) < instant(op.effectiveAt),
        'lifecycle_order',
      );
  });
  unique(operations, (op) => op.operationId);
  unique(operations, (op) => op.commitSha);
  unique(operations, (op) => op.evidenceRef);
  return {
    workspaceId: uuid(row.workspaceId),
    serviceId: uuid(row.serviceId),
    applicationUid: text(row.applicationUid),
    repositoryId,
    startedAt,
    closedAt,
    operations,
  };
}

/** Input must be genuinely fetched by authenticated operator; shape validation is not authentication.
 * Event IDs supplied by caller keep builder pure. Persist reports once and replay retained files.
 * Review is independent census evidence, including any pre-service absence; never inferred here.
 */
export function buildLifecycleReports(
  ledgerInput: unknown,
  projectionInput: unknown,
  producersInput: unknown,
  eventIdsInput: unknown,
  reviewInput?: unknown,
): MeasurementReport[] {
  const ledger = parseLifecycleLedger(ledgerInput);
  measurementJsonBytes(projectionInput);
  measurementJsonBytes(producersInput);
  measurementJsonBytes(eventIdsInput);
  const projection = exact(projectionInput, [
    'contract',
    'workspaceId',
    'serviceId',
    'basis',
    'window',
    'evidenceCutoff',
    'operations',
    'gapManifest',
  ]);
  demand(projection.contract === 'clio.measurement.basis.v1', 'lifecycle_basis_contract');
  demand(
    uuid(projection.workspaceId) === ledger.workspaceId &&
      uuid(projection.serviceId) === ledger.serviceId,
    'lifecycle_scope',
  );
  const basis = parseMeasurementBasis(projection.basis);
  demand(basis.provider === 'argocd', 'lifecycle_provider');
  const windowRow = exact(projection.window, ['start', 'end', 'timezone', 'calendar_days']);
  const window = interval({ start: windowRow.start, end: windowRow.end });
  demand(
    windowRow.timezone === 'UTC' &&
      typeof windowRow.calendar_days === 'number' &&
      Number.isInteger(windowRow.calendar_days) &&
      windowRow.calendar_days > 0 &&
      instant(window.end) - instant(window.start) ===
        BigInt(windowRow.calendar_days) * 86400000000n &&
      /T00:00:00(?:\.0+)?Z$/.test(window.start) &&
      /T00:00:00(?:\.0+)?Z$/.test(window.end),
    'lifecycle_window',
  );
  const cutoff = utc(projection.evidenceCutoff);
  demand(
    instant(window.end) <= instant(cutoff) && instant(ledger.closedAt) <= instant(cutoff),
    'lifecycle_future',
  );
  const native = list(projection.operations, (input) => {
    const op = exact(input, [
      'sourceId',
      'sourceDeploymentId',
      'productionPath',
      'qualification',
      'effectiveAt',
      'qualificationWindow',
    ]);
    demand(
      op.qualification === 'qualifying' && op.qualificationWindow === null,
      'lifecycle_qualification',
    );
    const effectiveAt = utc(op.effectiveAt);
    demand(instant(effectiveAt) <= instant(cutoff), 'lifecycle_future');
    return {
      sourceId: text(op.sourceId),
      sourceDeploymentId: text(op.sourceDeploymentId),
      productionPath: text(op.productionPath),
      effectiveAt,
    };
  });
  demand(native.length === 3, 'lifecycle_roster');
  unique(native, (op) => identity(op.sourceId, op.sourceDeploymentId));
  const matched = ledger.operations.map((op) => {
    const sourceDeploymentId = identity(
      'application',
      ledger.applicationUid,
      'operation',
      op.operationId,
    );
    const found = native.find(
      (candidate) =>
        candidate.sourceDeploymentId === sourceDeploymentId &&
        candidate.sourceId === basis.sourceId,
    );
    demand(
      found !== undefined && instant(found.effectiveAt) === instant(op.effectiveAt),
      'lifecycle_native_binding',
    );
    return { sourceId: found.sourceId, sourceDeploymentId: found.sourceDeploymentId };
  });
  const productionPath = native[0]?.productionPath;
  demand(
    productionPath !== undefined && native.every((op) => op.productionPath === productionPath),
    'lifecycle_path',
  );
  const gaps =
    projection.gapManifest === null ? null : list(projection.gapManifest, parseMeasurementGap);
  if (gaps) unique(gaps, (gap) => gap.gapId);
  const producers = list(producersInput, (input) => {
    const row = exact(input, ['producerId', 'capability', 'policyRef']);
    const capability = lifecycleCapabilities.find((value) => value === row.capability);
    demand(capability !== undefined, 'lifecycle_capability');
    return { producerId: uuid(row.producerId), capability, policyRef: text(row.policyRef) };
  });
  demand(producers.length === 4, 'lifecycle_producers');
  unique(producers, (p) => p.producerId);
  unique(producers, (p) => p.capability);
  const eventRows = exact(eventIdsInput, lifecycleCapabilities);
  const eventIds = lifecycleCapabilities.map((capability) => uuid(eventRows[capability]));
  unique(eventIds, (id) => id);
  const envelopeRefs = eventIds.map((id) => `urn:clio:sandbox:lifecycle:report:${id}`);
  demand(
    ledger.operations.every((op) => !envelopeRefs.includes(op.evidenceRef)),
    'lifecycle_independent_refs',
  );
  let review:
    | {
        interval: { start: string; end: string };
        historyEvidenceRef: string;
        populationEvidenceRef: string;
        recoveryEvidenceRef: string;
        gapResolutions: {
          gap: NonNullable<typeof gaps>[number];
          scope: { start: string; end: string };
          evidenceRef: string;
        }[];
      }
    | undefined;
  if (reviewInput !== undefined) {
    measurementJsonBytes(reviewInput);
    const row = exact(reviewInput, [
      'interval',
      'productionPath',
      'historyEvidenceRef',
      'populationEvidenceRef',
      'recoveryEvidenceRef',
      'gapResolutions',
    ]);
    const reviewed = interval(row.interval);
    demand(
      row.productionPath === productionPath && gaps !== null,
      'lifecycle_review_path_manifest',
    );
    demand(
      instant(reviewed.start) <= instant(ledger.startedAt) &&
        instant(reviewed.start) <= instant(window.start) &&
        instant(reviewed.end) >= instant(ledger.closedAt) &&
        instant(reviewed.end) >= instant(window.end) &&
        instant(reviewed.end) <= instant(ledger.closedAt),
      'lifecycle_review_interval',
    );
    const relevantGaps = gaps.filter(
      (gap) =>
        gap.bounds === null ||
        (instant(gap.bounds.start) < instant(reviewed.end) &&
          instant(reviewed.start) < instant(gap.bounds.end)),
    );
    const gapResolutions = list(row.gapResolutions, (input) => {
      const resolution = exact(input, ['gap', 'scope', 'evidenceRef']);
      const gap = parseMeasurementGap(resolution.gap),
        scope = interval(resolution.scope);
      const original = relevantGaps.find((candidate) => candidate.gapId === gap.gapId);
      demand(original !== undefined && content(original) === content(gap), 'lifecycle_gap_copy');
      const bounds = gap.bounds ?? reviewed;
      demand(
        instant(scope.start) <= instant(bounds.start) &&
          instant(scope.end) >= instant(bounds.end) &&
          instant(scope.end) <= instant(ledger.closedAt),
        'lifecycle_gap_scope',
      );
      return { gap, scope, evidenceRef: text(resolution.evidenceRef) };
    });
    unique(gapResolutions, (resolution) => resolution.gap.gapId);
    demand(gapResolutions.length === relevantGaps.length, 'lifecycle_gap_set');
    review = {
      interval: reviewed,
      historyEvidenceRef: text(row.historyEvidenceRef),
      populationEvidenceRef: text(row.populationEvidenceRef),
      recoveryEvidenceRef: text(row.recoveryEvidenceRef),
      gapResolutions,
    };
    const refs = [
      review.historyEvidenceRef,
      review.populationEvidenceRef,
      review.recoveryEvidenceRef,
      ...gapResolutions.map((r) => r.evidenceRef),
    ];
    unique(refs, (ref) => ref);
    demand(
      refs.every(
        (ref) =>
          !envelopeRefs.includes(ref) && !ledger.operations.some((op) => op.evidenceRef === ref),
      ),
      'lifecycle_independent_refs',
    );
  }
  const broken = ledger.operations[1],
    recovered = ledger.operations[2],
    causal = matched[1];
  demand(
    broken !== undefined && recovered !== undefined && causal !== undefined,
    'lifecycle_roster',
  );
  function report(capability: MeasurementCapability, payload: unknown): MeasurementReport {
    const producer = producers.find((p) => p.capability === capability);
    demand(producer !== undefined, 'lifecycle_producer');
    const eventId = uuid(eventRows[capability]);
    return parseMeasurementReport({
      contract: 'clio.measurement.evidence.v1',
      eventId,
      ...producer,
      workspaceId: ledger.workspaceId,
      serviceId: ledger.serviceId,
      basis,
      // Population has no payload reference slot; its envelope retains actual census receipt.
      evidenceRef:
        capability === 'population' && review
          ? review.populationEvidenceRef
          : `urn:clio:sandbox:lifecycle:report:${eventId}`,
      payload,
    });
  }
  const reports = [
    report('change_links', {
      history: review
        ? {
            kind: 'service_history_origin',
            interval: review.interval,
            evidenceRef: review.historyEvidenceRef,
          }
        : null,
      operations: ledger.operations.map((op, i) => ({
        ...matched[i],
        evidenceRef: op.evidenceRef,
        changes: [
          {
            repositoryId: ledger.repositoryId,
            commitId: op.commitSha,
            committedAt: op.committedAt,
            evidenceRef: op.evidenceRef,
          },
        ],
      })),
    }),
    report('classification', {
      operations: ledger.operations.map((op, i) => ({
        ...matched[i],
        failure: i === 1 ? 'failed' : 'no_recorded_failure',
        rework: i === 2 ? 'incident_driven' : 'not_incident_driven',
        failureEvidenceRef: op.evidenceRef,
        reworkEvidenceRef: op.evidenceRef,
      })),
    }),
    report('recovery', {
      interval: review?.interval ?? { start: ledger.startedAt, end: ledger.closedAt },
      exhaustive: true,
      episodes: [
        {
          ...causal,
          episodeId: identity('lifecycle', broken.operationId, recovered.operationId),
          // Unknown onset uses the pinned deployment-time fallback; keep later probe facts intact.
          onset: broken.effectiveAt,
          restored: recovered.healthObservedAt,
          approximate: true,
          evidenceRef: review?.recoveryEvidenceRef ?? recovered.evidenceRef,
        },
      ],
    }),
  ];
  if (review)
    reports.unshift(
      report('population', {
        interval: review.interval,
        exhaustive: true,
        productionPaths: [productionPath],
        operations: matched,
        gapResolutions: review.gapResolutions,
      }),
    );
  return reports;
}

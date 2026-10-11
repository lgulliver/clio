import { readFileSync } from 'node:fs';
import { calculate, oemsContract, validateSnapshot, validateStructure } from '@clio/oems';
import { describe, expect, it } from 'vitest';
import { deriveMeasurementEvidence, parseMeasurementReport } from '../src/measurement-evidence.ts';
import type { MeasurementBasisContext } from '../src/measurement-evidence-contract.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const window = { start: '2026-10-01T00:00:00Z', end: '2026-10-11T00:00:00Z' };
const observedAt = '2026-10-13T00:00:00Z';
const basisContext: MeasurementBasisContext = {
  workspaceId: uuid(1),
  serviceId: uuid(2),
  canonicalServiceId: 'service:beacon',
  basis: {
    provider: 'argocd' as const,
    runId: uuid(3),
    sourceId: 'source:beacon',
    connectionRevision: 1,
    oemsRevision: oemsContract.revision,
    snapshotDigest: 'a'.repeat(64),
    evidenceDigest: 'b'.repeat(64),
    gapManifestDigest: 'c'.repeat(64),
  },
};
function setup() {
  const raw: unknown = JSON.parse(
    readFileSync(
      new URL('../../oems/vendor/conformance/v0.1/cases/complete.json', import.meta.url),
      'utf8',
    ),
  );
  const checked = validateStructure('dataset', raw);
  if (!checked.ok) throw new Error('fixture');
  const expected = checked.data;
  expected.changes.forEach((change, i) => {
    change.commit_id = String(i + 1).padStart(40, '0');
  });
  const basisData = structuredClone(expected);
  basisData.collection_complete = false;
  basisData.deployment_history_complete = false;
  basisData.recovery_evidence_complete = false;
  basisData.changes = [];
  basisData.incidents = [];
  basisData.deployments.forEach((deployment) => {
    deployment.change_ids = [];
    deployment.change_links_complete = false;
    deployment.failure = 'unknown';
    deployment.rework = 'unknown';
    deployment.failure_evidence_refs = [];
    deployment.rework_evidence_refs = [];
  });
  const checkedBasis = validateSnapshot(basisData);
  const checkedExpected = validateSnapshot(expected);
  if (!checkedBasis.ok || !checkedExpected.ok) throw new Error('fixture');
  const nativeIndex = expected.deployments.map((deployment) => ({
    sourceId: 'source:beacon',
    sourceDeploymentId: deployment.id,
    deploymentId: deployment.id,
    productionPath: 'production/main',
  }));
  const operations = nativeIndex.map(({ sourceId, sourceDeploymentId }) => ({
    sourceId,
    sourceDeploymentId,
  }));
  function envelope(
    capability: 'population' | 'change_links' | 'classification' | 'recovery',
    payload: unknown,
    n: number,
  ) {
    return {
      contract: 'clio.measurement.evidence.v1',
      eventId: uuid(10 + n),
      producerId: uuid(20 + n),
      workspaceId: uuid(1),
      serviceId: uuid(2),
      capability,
      policyRef: 'policy:独立',
      evidenceRef: `private report ${n}`,
      basis: basisContext.basis,
      payload,
    };
  }
  const population = envelope(
    'population',
    {
      interval: window,
      exhaustive: true,
      productionPaths: ['production/main'],
      operations,
      gapResolutions: [],
    },
    1,
  );
  const links = envelope(
    'change_links',
    {
      history: { kind: 'service_history_origin', evidenceRef: 'history origin', interval: window },
      operations: expected.deployments.map((d) => ({
        sourceId: 'source:beacon',
        sourceDeploymentId: d.id,
        changes: d.change_ids.map((id) => {
          const c = expected.changes.find((c) => c.id === id);
          if (!c) throw new Error('fixture');
          return {
            repositoryId: c.repository_id,
            commitId: c.commit_id,
            committedAt: c.committed_at,
            evidenceRef: c.source_refs[0],
          };
        }),
        evidenceRef: `links ${d.id}`,
      })),
    },
    2,
  );
  const classification = envelope(
    'classification',
    {
      operations: expected.deployments.map((d) => ({
        sourceId: 'source:beacon',
        sourceDeploymentId: d.id,
        failure: d.failure,
        rework: d.rework,
        failureEvidenceRef: `failure ${d.id}`,
        reworkEvidenceRef: `rework ${d.id}`,
      })),
    },
    3,
  );
  const recovery = envelope(
    'recovery',
    {
      interval: window,
      exhaustive: true,
      episodes: expected.incidents.map((i) => ({
        episodeId: i.id,
        sourceId: 'source:beacon',
        sourceDeploymentId: i.causal_deployment_id,
        onset: i.failure_started_at,
        restored: i.restored_at,
        approximate: i.start_is_approximate,
        evidenceRef: 'incident independent',
      })),
    },
    4,
  );
  const reports = [population, links, classification, recovery];
  const scopes = reports.map((r) => ({
    producerId: r.producerId,
    workspaceId: r.workspaceId,
    serviceId: r.serviceId,
    capability: r.capability,
    policyRef: r.policyRef,
    basis: r.basis,
    productionPaths: ['production/main'],
    repositoryIds: ['repository:beacon'],
  }));
  const input = {
    basis: checkedBasis.data,
    context: basisContext,
    nativeIndex,
    gapManifest: [],
    authorityScopes: scopes,
    reports: reports.map((report) => ({ report, observedAt })),
    measurementCutoff: observedAt,
  };
  return {
    input,
    reports,
    population,
    links,
    classification,
    recovery,
    expected: checkedExpected.data,
    basisData,
  };
}

describe('pure measurement evidence', () => {
  it('derives all five pinned complete metrics without mutating old basis', () => {
    const { input, expected } = setup();
    const old = JSON.stringify(input.basis.data);
    const result = deriveMeasurementEvidence(input);
    const metric = result.metrics[0];
    expect(metric?.deployment_frequency.deployments_per_day).toBe(1);
    expect(metric?.change_lead_time.median_seconds).toBe(9000);
    expect(metric?.change_fail_rate.ratio).toBe(0.1);
    expect(metric?.deployment_rework_rate.ratio).toBe(0.2);
    expect(metric?.failed_deployment_recovery_time.median_seconds).toBe(1800);
    const pinned = calculate(expected)[0];
    if (!metric || !pinned) throw new Error('metric');
    for (const key of [
      'deployment_frequency',
      'change_lead_time',
      'change_fail_rate',
      'deployment_rework_rate',
      'failed_deployment_recovery_time',
    ] as const)
      expect(metric[key]).toEqual(pinned[key]);
    expect(result.assessment.blockers).toEqual([]);
    expect(result.snapshot.data.evidence_cutoff).toBe(observedAt);
    expect(JSON.stringify(input.basis.data)).toBe(old);
    expect(Object.isFrozen(input.basis.data.deployments[0])).toBe(true);
  });
  it('keeps unsupported coverage false without reports', () => {
    const { input } = setup();
    input.reports = [];
    const result = deriveMeasurementEvidence(input);
    expect(result.snapshot.data.collection_complete).toBe(false);
    expect(result.snapshot.data.deployment_history_complete).toBe(false);
    expect(result.snapshot.data.recovery_evidence_complete).toBe(false);
    expect(result.metrics[0]?.change_fail_rate.ratio).toBeNull();
  });
  it('requires authenticated scope input', () => {
    const { input } = setup();
    input.authorityScopes = [];
    expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_scope_mismatch');
  });
  it('blocks incomplete native census in both directions', () => {
    const { input, population } = setup();
    const parsed = parseMeasurementReport(population);
    if (parsed.capability !== 'population') throw new Error('population');
    input.reports[0] = {
      report: {
        ...parsed,
        payload: { ...parsed.payload, operations: parsed.payload.operations.slice(1) },
      },
      observedAt,
    };
    expect(deriveMeasurementEvidence(input).assessment.blockers).toContain(
      'population_roster_mismatch',
    );
    input.reports[0] = {
      report: {
        ...parsed,
        payload: {
          ...parsed.payload,
          operations: [
            ...parsed.payload.operations,
            { sourceId: 'source:beacon', sourceDeploymentId: 'missing native' },
          ],
        },
      },
      observedAt,
    };
    expect(deriveMeasurementEvidence(input).snapshot.data.collection_complete).toBe(false);
  });
  it('does not infer completeness without exact gap manifest', () => {
    const { input } = setup();
    expect(
      deriveMeasurementEvidence({ ...input, gapManifest: null }).assessment.blockers,
    ).toContain('gap_manifest_missing');
  });
  it('rejects conflicting reports but accepts exact replay', () => {
    const { input } = setup();
    const first = input.reports[0];
    if (!first) throw new Error('report');
    const original = deriveMeasurementEvidence(input).snapshot.data;
    input.reports.push(first);
    expect(deriveMeasurementEvidence(input).snapshot.data).toEqual(original);
    input.reports.push({ ...first, report: { ...first.report, eventId: uuid(999) } });
    expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_report_conflict');
  });
  it('rejects non-bijective server native manifest', () => {
    const { input } = setup();
    input.nativeIndex.pop();
    expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_native_manifest');
  });
  it.each(['workspaceId', 'serviceId', 'producerId'] as const)('rejects foreign %s', (key) => {
    const { input } = setup();
    const first = input.reports[0];
    if (!first) throw new Error('report');
    first.report[key] = uuid(999);
    expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_scope_mismatch');
  });
  it.each([
    'sourceId',
    'snapshotDigest',
    'evidenceDigest',
    'gapManifestDigest',
    'oemsRevision',
  ] as const)('rejects stale basis %s', (key) => {
    const { input } = setup();
    const first = input.reports[0];
    if (!first) throw new Error('report');
    first.report = {
      ...first.report,
      basis: { ...first.report.basis, [key]: key.endsWith('Digest') ? 'd'.repeat(64) : 'foreign' },
    };
    expect(() => deriveMeasurementEvidence(input)).toThrow();
  });
  it('rejects cutoff rollback and receipt after cutoff', () => {
    const { input } = setup();
    expect(() =>
      deriveMeasurementEvidence({ ...input, measurementCutoff: '2026-10-11T00:00:00Z' }),
    ).toThrow('measurement_cutoff');
    expect(() =>
      deriveMeasurementEvidence({ ...input, measurementCutoff: '2026-10-12T00:00:00Z' }),
    ).toThrow('measurement_cutoff');
  });
  it('rejects unknown keys and control characters; safely accepts opaque unicode', () => {
    const { population } = setup();
    expect(() => parseMeasurementReport({ ...population, observedAt })).toThrow('measurement_keys');
    expect(() => parseMeasurementReport({ ...population, evidenceRef: 'bad\u0000ref' })).toThrow(
      'measurement_text',
    );
    expect(
      parseMeasurementReport({ ...population, evidenceRef: '私有 🔒 # ? /' }).evidenceRef,
    ).toBe('私有 🔒 # ? /');
  });
});

function rebuilt(data: ReturnType<typeof setup>['basisData']) {
  const result = validateSnapshot(data);
  if (!result.ok) throw new Error('test basis');
  return result.data;
}
function setReport(
  input: ReturnType<typeof setup>['input'],
  index: number,
  report: ReturnType<typeof parseMeasurementReport>,
) {
  input.reports[index] = { report, observedAt };
}

describe('measurement reconciliation regressions', () => {
  it('requires exact independently referenced bounded gap resolution', () => {
    const { input, population } = setup();
    const p = parseMeasurementReport(population);
    if (p.capability !== 'population') throw new Error('population');
    const gap = {
      gapId: 'retained:1',
      sourceId: 'source:beacon',
      reason: 'watch_lost',
      bounds: window,
    };
    expect(
      deriveMeasurementEvidence({ ...input, gapManifest: [gap] }).assessment.blockers,
    ).toContain('gap_resolution_mismatch');
    setReport(input, 0, {
      ...p,
      payload: {
        ...p.payload,
        gapResolutions: [{ gap, scope: window, evidenceRef: 'independent gap review' }],
      },
    });
    expect(
      deriveMeasurementEvidence({ ...input, gapManifest: [gap] }).snapshot.data.collection_complete,
    ).toBe(true);
    expect(
      deriveMeasurementEvidence({
        ...input,
        gapManifest: [{ ...gap, reason: 'unsupported_native' }],
      }).snapshot.data.collection_complete,
    ).toBe(false);
    setReport(input, 0, {
      ...p,
      payload: {
        ...p.payload,
        gapResolutions: [{ gap, scope: window, evidenceRef: p.evidenceRef }],
      },
    });
    expect(
      deriveMeasurementEvidence({ ...input, gapManifest: [gap] }).snapshot.data.collection_complete,
    ).toBe(false);
  });
  it('requires explicit full scope resolution for unbounded gaps', () => {
    const { input, population } = setup();
    const p = parseMeasurementReport(population);
    if (p.capability !== 'population') throw new Error('population');
    const gap = {
      gapId: 'retained:unknown',
      sourceId: 'source:beacon',
      reason: 'unbounded',
      bounds: null,
    };
    setReport(input, 0, {
      ...p,
      payload: {
        ...p.payload,
        gapResolutions: [
          {
            gap,
            scope: { ...window, start: '2026-10-02T00:00:00Z' },
            evidenceRef: 'gap scope review',
          },
        ],
      },
    });
    expect(
      deriveMeasurementEvidence({ ...input, gapManifest: [gap] }).snapshot.data.collection_complete,
    ).toBe(false);
    setReport(input, 0, {
      ...p,
      payload: {
        ...p.payload,
        gapResolutions: [{ gap, scope: window, evidenceRef: 'gap scope review' }],
      },
    });
    expect(
      deriveMeasurementEvidence({ ...input, gapManifest: [gap] }).snapshot.data.collection_complete,
    ).toBe(true);
  });
  it('separates authorized empty census from absent evidence', () => {
    const { input, population } = setup();
    const data = structuredClone(input.basis.data);
    const basis = validateSnapshot({ ...data, deployments: [], changes: [], incidents: [] });
    if (!basis.ok) throw new Error('basis');
    const p = parseMeasurementReport(population);
    if (p.capability !== 'population') throw new Error('population');
    const empty = {
      ...input,
      basis: basis.data,
      nativeIndex: [],
      reports: [{ report: { ...p, payload: { ...p.payload, operations: [] } }, observedAt }],
    };
    expect(
      deriveMeasurementEvidence(empty).metrics[0]?.deployment_frequency.deployments_per_day,
    ).toBe(0);
    expect(
      deriveMeasurementEvidence({ ...empty, reports: [] }).metrics[0]?.deployment_frequency
        .deployments_per_day,
    ).toBeNull();
    expect(() => deriveMeasurementEvidence({ ...empty, authorityScopes: [] })).toThrow(
      'measurement_scope_mismatch',
    );
  });
  it('retains unknown unbounded qualification and its effect on history', () => {
    const { input, basisData, links, recovery } = setup();
    const d = basisData.deployments[1];
    if (!d) throw new Error('deployment');
    d.qualification = 'unknown';
    d.environment = 'unknown';
    d.effective_at = null;
    input.basis = rebuilt(basisData);
    const result = deriveMeasurementEvidence(input);
    expect(result.snapshot.data.deployments[1]?.qualification).toBe('unknown');
    expect(result.metrics[0]?.deployment_frequency.quality_reasons).toContain(
      'unresolved_qualification',
    );
    expect(result.metrics[0]?.change_lead_time.quality_reasons).toContain('incomplete_history');
    const r = parseMeasurementReport(recovery);
    if (r.capability !== 'recovery') throw new Error('recovery');
    const e = r.payload.episodes[0];
    if (!e) throw new Error('episode');
    setReport(input, 3, {
      ...r,
      payload: { ...r.payload, episodes: [{ ...e, sourceDeploymentId: d.id }] },
    });
    expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_recovery_causal');
    const l = parseMeasurementReport(links);
    if (l.capability !== 'change_links') throw new Error('links');
    expect(() =>
      parseMeasurementReport({ ...l, payload: { ...l.payload, qualification: 'qualifying' } }),
    ).toThrow('measurement_keys');
  });
  it('does not infer history from first retained operation', () => {
    const { input, links } = setup();
    const l = parseMeasurementReport(links);
    if (l.capability !== 'change_links') throw new Error('links');
    setReport(input, 1, { ...l, payload: { ...l.payload, history: null } });
    expect(deriveMeasurementEvidence(input).metrics[0]?.change_lead_time.quality_reasons).toContain(
      'incomplete_history',
    );
    setReport(input, 1, {
      ...l,
      payload: { ...l.payload, operations: l.payload.operations.slice(1) },
    });
    const partial = deriveMeasurementEvidence(input);
    expect(partial.assessment.blockers).toContain('history_change_links');
    expect(partial.snapshot.data.deployments[0]?.change_links_complete).toBe(false);
  });
  it('includes prewindow redeployment change sets and excludes previously deployed change from lead cohort', () => {
    const { input, basisData, population, links } = setup();
    const prior = basisData.deployments[1];
    if (!prior) throw new Error('deployment');
    prior.effective_at = '2026-09-30T08:00:00Z';
    input.basis = rebuilt(basisData);
    const p = parseMeasurementReport(population),
      l = parseMeasurementReport(links);
    if (p.capability !== 'population' || l.capability !== 'change_links')
      throw new Error('reports');
    const historyInterval = { ...window, start: '2026-09-01T00:00:00Z' };
    const first = l.payload.operations[0];
    if (!first?.changes[0]) throw new Error('change');
    const change = { ...first.changes[0], committedAt: '2026-09-29T00:00:00Z' };
    const operations = l.payload.operations.map((o) =>
      o.sourceDeploymentId === first.sourceDeploymentId
        ? { ...o, changes: [change, ...o.changes.slice(1)] }
        : o.sourceDeploymentId === prior.id
          ? { ...o, changes: [change] }
          : o,
    );
    setReport(input, 0, { ...p, payload: { ...p.payload, interval: historyInterval } });
    setReport(input, 1, {
      ...l,
      payload: {
        ...l.payload,
        history: {
          kind: 'service_history_origin',
          interval: historyInterval,
          evidenceRef: 'full service origin',
        },
        operations,
      },
    });
    const result = deriveMeasurementEvidence(input);
    expect(result.metrics[0]?.deployment_frequency.count).toBe(9);
    expect(result.metrics[0]?.change_lead_time.observation_count).toBe(3);
    setReport(input, 1, {
      ...l,
      payload: {
        ...l.payload,
        history: {
          kind: 'service_history_origin',
          interval: window,
          evidenceRef: 'false retained origin',
        },
        operations,
      },
    });
    expect(deriveMeasurementEvidence(input).assessment.blockers).toContain('history_origin');
  });
  it('rejects foreign repository and conflicting canonical change timestamps', () => {
    const { input, links } = setup();
    const l = parseMeasurementReport(links);
    if (l.capability !== 'change_links') throw new Error('links');
    const first = l.payload.operations[0],
      second = l.payload.operations[1];
    if (!first || !second || !first.changes[0]) throw new Error('operation');
    setReport(input, 1, {
      ...l,
      payload: {
        ...l.payload,
        operations: [{ ...first, changes: [{ ...first.changes[0], repositoryId: 'foreign' }] }],
      },
    });
    expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_repository_scope');
    setReport(input, 1, {
      ...l,
      payload: {
        ...l.payload,
        operations: [
          first,
          { ...second, changes: [{ ...first.changes[0], committedAt: '2026-10-01T06:00:00Z' }] },
        ],
      },
    });
    expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_change_conflict');
  });
  it('preserves known baseline links when no new assertion arrives', () => {
    const { input, expected } = setup();
    input.basis = expected;
    input.reports = [];
    const result = deriveMeasurementEvidence(input);
    expect(result.snapshot.data.deployments[0]?.change_ids).toEqual(
      expected.data.deployments[0]?.change_ids,
    );
    expect(result.snapshot.data.incidents).toEqual(expected.data.incidents);
    expect(result.snapshot.data.collection_complete).toBe(false);
  });
  it('rejects known baseline classification contradictions', () => {
    const { input, basisData } = setup();
    const d = basisData.deployments[0];
    if (!d) throw new Error('deployment');
    d.failure = 'failed';
    d.failure_evidence_refs = ['urn:baseline:failure'];
    input.basis = rebuilt(basisData);
    expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_classification_conflict');
  });
  it('keeps population and history usable when recovery arrives before classification', () => {
    const { input } = setup();
    input.reports = input.reports.filter(
      (receipt) => parseMeasurementReport(receipt.report).capability !== 'classification',
    );
    const result = deriveMeasurementEvidence(input);
    expect(result.assessment.blockers).toContain('recovery_classification_missing');
    expect(result.assessment.collectionComplete).toBe(true);
    expect(result.assessment.historyComplete).toBe(true);
    expect(result.assessment.recoveryComplete).toBe(false);
    expect(result.metrics[0]?.deployment_frequency.status).toBe('complete');
    expect(result.metrics[0]?.failed_deployment_recovery_time.median_seconds).toBeNull();
    expect(result.snapshot.data.incidents).toEqual([]);
  });
  it('keeps recovery population independent of incomplete classification', () => {
    const { input, recovery } = setup();
    const r = parseMeasurementReport(recovery);
    if (r.capability !== 'recovery') throw new Error('recovery');
    input.reports = [{ report: { ...r, payload: { ...r.payload, episodes: [] } }, observedAt }];
    const result = deriveMeasurementEvidence(input);
    expect(result.snapshot.data.recovery_evidence_complete).toBe(true);
    expect(result.metrics[0]?.failed_deployment_recovery_time.quality_reasons).toContain(
      'unknown_failure_classification',
    );
    expect(result.snapshot.data.deployments.every((d) => d.failure === 'unknown')).toBe(true);
  });
  it('accepts restoration after window at new receiver cutoff; retains open and approximate episodes', () => {
    const { input, recovery } = setup();
    const r = parseMeasurementReport(recovery);
    if (r.capability !== 'recovery') throw new Error('recovery');
    const e = r.payload.episodes[0];
    if (!e) throw new Error('episode');
    setReport(input, 3, {
      ...r,
      payload: { ...r.payload, episodes: [{ ...e, restored: '2026-10-12T12:00:00Z' }] },
    });
    expect(deriveMeasurementEvidence(input).snapshot.data.incidents[0]?.restored_at).toBe(
      '2026-10-12T12:00:00Z',
    );
    setReport(input, 3, { ...r, payload: { ...r.payload, episodes: [{ ...e, restored: null }] } });
    expect(
      deriveMeasurementEvidence(input).metrics[0]?.failed_deployment_recovery_time.open_count,
    ).toBe(1);
    setReport(input, 3, {
      ...r,
      payload: {
        ...r.payload,
        episodes: [{ ...e, onset: '2026-10-05T08:00:00Z', approximate: true }],
      },
    });
    expect(
      deriveMeasurementEvidence(input).metrics[0]?.failed_deployment_recovery_time
        .approximate_count,
    ).toBe(1);
    setReport(input, 3, {
      ...r,
      payload: { ...r.payload, episodes: [{ ...e, approximate: true }] },
    });
    expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_recovery_onset');
    setReport(input, 3, {
      ...r,
      payload: { ...r.payload, episodes: [{ ...e, restored: '2026-10-14T00:00:00Z' }] },
    });
    expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_future_fact');
  });
  it('rejects foreign causal operation', () => {
    const { input, recovery } = setup();
    const r = parseMeasurementReport(recovery);
    if (r.capability !== 'recovery') throw new Error('recovery');
    const e = r.payload.episodes[0];
    if (!e) throw new Error('episode');
    setReport(input, 3, {
      ...r,
      payload: { ...r.payload, episodes: [{ ...e, sourceDeploymentId: 'foreign operation' }] },
    });
    expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_native_operation');
  });
  it('rejects duplicate native identity and duplicate gap resolutions', () => {
    const { population } = setup();
    const p = parseMeasurementReport(population);
    if (p.capability !== 'population') throw new Error('population');
    const op = p.payload.operations[0];
    if (!op) throw new Error('operation');
    expect(() =>
      parseMeasurementReport({ ...p, payload: { ...p.payload, operations: [op, op] } }),
    ).toThrow('measurement_duplicate');
    const r = {
      gap: { gapId: 'gap', sourceId: 'source:beacon', reason: 'missing', bounds: window },
      scope: window,
      evidenceRef: 'independent',
    };
    expect(() =>
      parseMeasurementReport({ ...p, payload: { ...p.payload, gapResolutions: [r, r] } }),
    ).toThrow('measurement_duplicate');
  });
  it('bounds records, bytes, cyclic/nonfinite data and rejects offset/date injection', () => {
    const { population } = setup();
    const p = parseMeasurementReport(population);
    if (p.capability !== 'population') throw new Error('population');
    expect(() =>
      parseMeasurementReport({
        ...p,
        payload: {
          ...p.payload,
          operations: Array.from({ length: 5001 }, (_, i) => ({
            sourceId: 'source:beacon',
            sourceDeploymentId: String(i),
          })),
        },
      }),
    ).toThrow('measurement_record_limit');
    expect(() =>
      parseMeasurementReport({ ...p, evidenceRef: 'x'.repeat(8 * 1024 * 1024 + 1) }),
    ).toThrow('measurement_payload_limit');
    expect(() =>
      parseMeasurementReport({ ...p, basis: { ...p.basis, connectionRevision: Number.NaN } }),
    ).toThrow('measurement_json');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => parseMeasurementReport(cycle)).toThrow('measurement_json');
    expect(() =>
      parseMeasurementReport({
        ...p,
        payload: { ...p.payload, interval: { ...window, start: '2026-10-01T01:00:00+01:00' } },
      }),
    ).toThrow('measurement_utc');
    expect(() =>
      parseMeasurementReport({
        ...p,
        payload: { ...p.payload, interval: { ...window, start: '2026-02-30T00:00:00Z' } },
      }),
    ).toThrow('invalid_timestamp');
  });
});

describe('operation authorization and deterministic lineage', () => {
  it.each(['change_links', 'classification', 'recovery'] as const)(
    'enforces operation production path grant for %s',
    (capability) => {
      const { input } = setup();
      input.authorityScopes = input.authorityScopes.map((s) =>
        s.capability === capability ? { ...s, productionPaths: ['foreign/path'] } : s,
      );
      expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_operation_scope');
    },
  );
  it('returns identical immutable snapshot regardless of receipt order', () => {
    const { input } = setup();
    const forward = deriveMeasurementEvidence(input);
    expect(
      deriveMeasurementEvidence({ ...input, reports: [...input.reports].reverse() }).snapshot.data,
    ).toEqual(forward.snapshot.data);
  });
  it('cannot mark excluded nonproduction operations as production path blockers', () => {
    const { input, basisData, population } = setup();
    const d = basisData.deployments[1];
    if (!d) throw new Error('deployment');
    d.qualification = 'excluded';
    d.environment = 'non_production';
    d.effective_at = null;
    input.basis = rebuilt(basisData);
    input.nativeIndex = input.nativeIndex.map((n) =>
      n.deploymentId === d.id ? { ...n, productionPath: 'staging' } : n,
    );
    const p = parseMeasurementReport(population);
    if (p.capability !== 'population') throw new Error('population');
    setReport(input, 0, {
      ...p,
      payload: {
        ...p.payload,
        operations: p.payload.operations.filter((o) => o.sourceDeploymentId !== d.id),
      },
    });
    // Only census supplied: excluded native records still retain their server identity.
    input.reports = input.reports.slice(0, 1);
    expect(deriveMeasurementEvidence(input).snapshot.data.collection_complete).toBe(true);
  });
});

describe('validated basis and JSON trust boundary', () => {
  it('requires actual pinned validated capability, not forged data wrapper', () => {
    const { input } = setup();
    expect(() =>
      Reflect.apply(deriveMeasurementEvidence, undefined, [
        { ...input, basis: { data: input.basis.data } },
      ]),
    ).toThrow('Calculation requires a validated snapshot');
  });
  it('rejects accessors before evaluating attacker code', () => {
    const { population } = setup();
    const malicious = { ...population };
    Object.defineProperty(malicious, 'evidenceRef', {
      enumerable: true,
      get() {
        throw new Error('PRIVATE getter error');
      },
    });
    expect(() => parseMeasurementReport(malicious)).toThrow('measurement_json');
  });
  it('rejects symbolic extra keys instead of silently dropping them', () => {
    const { population } = setup();
    expect(() => parseMeasurementReport({ ...population, [Symbol('extra')]: 'hidden' })).toThrow(
      'measurement_json',
    );
  });
  it('accepts prewindow failed causal deployment with in-window onset', () => {
    const { input, basisData, population, links } = setup();
    const causal = basisData.deployments[4];
    if (!causal) throw new Error('deployment');
    causal.effective_at = '2026-09-30T08:00:00Z';
    input.basis = rebuilt(basisData);
    const p = parseMeasurementReport(population),
      l = parseMeasurementReport(links);
    if (p.capability !== 'population' || l.capability !== 'change_links' || !l.payload.history)
      throw new Error('report');
    const interval = { ...window, start: '2026-09-01T00:00:00Z' };
    setReport(input, 0, { ...p, payload: { ...p.payload, interval } });
    setReport(input, 1, {
      ...l,
      payload: { ...l.payload, history: { ...l.payload.history, interval } },
    });
    expect(
      deriveMeasurementEvidence(input).metrics[0]?.failed_deployment_recovery_time.median_seconds,
    ).toBe(1800);
  });
  it('rejects stale run, provider and connection revision', () => {
    const { input, population } = setup();
    for (const basis of [
      { ...population.basis, runId: uuid(999) },
      { ...population.basis, provider: 'github' as const },
      { ...population.basis, connectionRevision: 2 },
    ]) {
      input.reports[0] = { report: { ...population, basis }, observedAt };
      expect(() => deriveMeasurementEvidence(input)).toThrow('measurement_scope_mismatch');
    }
  });
});

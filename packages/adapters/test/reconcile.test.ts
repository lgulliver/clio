import { calculate } from '@clio/oems';
import { describe, expect, it } from 'vitest';
import {
  collectGitHubDeployments,
  type EvidenceBatch,
  identity,
  normalizeArgoOperation,
  reconcileDeployments,
  type ServiceMapping,
} from '../src/index.ts';
import {
  argo,
  argoDeploymentId,
  argoSourceId,
  deployment,
  mapping,
  metadata,
  observedAt,
  repositoryId,
  response,
  sourceDeploymentId,
  sourceId,
  status,
  tip,
  transport,
  window,
} from './fixtures.ts';

async function github(
  rows: unknown[] = [status()],
  deploymentRows: unknown[] = [deployment()],
): Promise<EvidenceBatch> {
  return collectGitHubDeployments({
    instance: 'installation-1',
    repositoryId: 11,
    token: 'fictional-token',
    clock: () => new Date(observedAt),
    fetch: transport([
      response(metadata),
      response(deploymentRows),
      ...deploymentRows.map(() => response(rows)),
    ]).fetch,
  });
}
function snapshot(
  batches: readonly EvidenceBatch[],
  serviceMapping = mapping(),
  cutoff = observedAt,
) {
  const result = reconcileDeployments({
    datasetId: 'dataset:one',
    window,
    evidenceCutoff: cutoff,
    mapping: serviceMapping,
    batches,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.data;
}
function argoMapping(attested = true): ServiceMapping {
  return {
    ...mapping(),
    primarySourceId: argoSourceId,
    deploymentBindings: [{ sourceId: argoSourceId, sourceDeploymentId: argoDeploymentId }],
    environments: [
      {
        sourceId: argoSourceId,
        environment: 'prod',
        classification: 'production',
        exposurePolicy: attested
          ? { reference: 'urn:clio:argo-exposure-policy:1', signal: 'Succeeded' }
          : null,
      },
    ],
  };
}
function correlatedMapping(): ServiceMapping {
  return {
    ...mapping(true),
    deploymentBindings: [...mapping().deploymentBindings, ...argoMapping().deploymentBindings],
    environments: [...mapping(true).environments, ...argoMapping().environments],
    correlations: [
      { sourceId, sourceDeploymentId, rolloutGroupId: 'shared-rollout-1' },
      {
        sourceId: argoSourceId,
        sourceDeploymentId: argoDeploymentId,
        rolloutGroupId: 'shared-rollout-1',
      },
    ],
  };
}
describe('cutoff-safe one-service reconciliation', () => {
  it('defaults production exposure, failure/rework and linkage to unknown; calculations provisional/null', async () => {
    const result = snapshot([await github()]);
    expect(result.data.deployments[0]).toMatchObject({
      environment: 'production',
      qualification: 'unknown',
      effective_at: null,
      qualification_window: null,
      failure: 'unknown',
      rework: 'unknown',
      change_ids: [],
      change_links_complete: false,
      failure_evidence_refs: [],
      rework_evidence_refs: [],
    });
    expect(result.data.changes).toEqual([]);
    expect(result.data.incidents).toEqual([]);
    expect(result.data.collection_complete).toBe(false);
    expect(result.data.deployment_history_complete).toBe(false);
    expect(result.data.recovery_evidence_complete).toBe(false);
    const metric = calculate(result)[0];
    expect(metric?.deployment_frequency).toMatchObject({
      status: 'provisional',
      count: 0,
      deployments_per_day: null,
    });
    expect(metric?.qualification_unknown_count).toBe(1);
    expect(metric?.change_lead_time.median_seconds).toBeNull();
    expect(metric?.change_fail_rate.ratio).toBeNull();
    expect(metric?.deployment_rework_rate.ratio).toBeNull();
    expect(metric?.failed_deployment_recovery_time.median_seconds).toBeNull();
  });
  it('uses earliest attested exposure, status promotion and retains later inactive/failure', async () => {
    const batch = await github([
      status({
        id: 32,
        state: 'inactive',
        created_at: '2026-01-02T10:00:00Z',
        updated_at: '2026-01-02T10:00:00Z',
      }),
      status({
        id: 33,
        state: 'failure',
        created_at: '2026-01-02T11:00:00Z',
        updated_at: '2026-01-02T11:00:00Z',
      }),
      status({ id: 34, created_at: '2026-01-01T12:00:00Z', updated_at: '2026-01-01T12:00:00Z' }),
      status(),
    ]);
    const result = snapshot([batch], mapping(true));
    expect(batch.deployments[0]?.environment).toBe('staging');
    expect(result.data.deployments[0]).toMatchObject({
      qualification: 'qualifying',
      environment: 'production',
      effective_at: '2026-01-01T11:00:00Z',
      failure: 'unknown',
    });
    expect(calculate(result)[0]?.deployment_frequency).toMatchObject({
      count: 1,
      status: 'provisional',
      deployments_per_day: null,
    });
    expect(calculate(result)[0]?.change_fail_rate).toMatchObject({
      denominator: 1,
      unknown_count: 1,
      ratio: null,
    });
  });
  it('requires explicit non-production mapping; unmapped environment cannot exclude', async () => {
    const batch = await github([status({ environment: 'staging' })]);
    expect(snapshot([batch]).data.deployments[0]?.qualification).toBe('excluded');
    expect(snapshot([batch], { ...mapping(), environments: [] }).data.deployments[0]).toMatchObject(
      { qualification: 'unknown', environment: 'unknown' },
    );
  });
  it('empty and partial transport never grant OEMS coverage', async () => {
    const empty = snapshot([{ deployments: [], statuses: [] }]);
    expect(calculate(empty)[0]?.deployment_frequency).toMatchObject({
      status: 'provisional',
      count: 0,
      deployments_per_day: null,
    });
    const partial = snapshot(
      [await github([], [deployment({ environment: 'prod' })])],
      mapping(true),
    );
    expect(partial.data.deployments[0]?.qualification).toBe('unknown');
  });
  it('partial or cutoff-late status traversal cannot exclude non-production evidence', async () => {
    const partial = await collectGitHubDeployments({
      instance: 'installation-1',
      repositoryId: 11,
      token: 'fictional-token',
      clock: () => new Date(observedAt),
      fetch: transport([
        response(metadata),
        response([deployment()]),
        response([status({ environment: 'staging' })], {
          link: '<https://api.github.com/repos/renamed-owner/renamed-repo/deployments/21/statuses?per_page=100&page=2>; rel="next"',
        }),
        response({}, { 'retry-after': '30' }, 429),
      ]).fetch,
    });
    expect(partial.completedStatusTraversals).toEqual([]);
    expect(snapshot([partial]).data.deployments[0]?.qualification).toBe('unknown');
    const complete = await github([status({ environment: 'staging' })]);
    expect(snapshot([complete]).data.deployments[0]?.qualification).toBe('excluded');
    const late = {
      ...complete,
      completedStatusTraversals: (complete.completedStatusTraversals ?? []).map((record) => ({
        ...record,
        observedAt: '2026-01-05T00:00:00Z',
      })),
    };
    expect(snapshot([late]).data.deployments[0]?.qualification).toBe('unknown');
    const noStatuses = await github([]);
    expect(snapshot([noStatuses]).data.deployments[0]?.qualification).toBe('excluded');
    expect(
      snapshot([{ ...noStatuses, completedStatusTraversals: [] }]).data.deployments[0]
        ?.qualification,
    ).toBe('unknown');
  });
  it('dedupes full replay order-independently; opaque GitHub revisions reject', async () => {
    const batch = await github();
    const first = snapshot([batch, batch], mapping(true));
    expect(first.data.deployments).toHaveLength(1);
    const reversed = {
      deployments: [...batch.deployments].reverse(),
      statuses: [...batch.statuses].reverse(),
    };
    expect(snapshot([reversed, batch], mapping(true)).data).toEqual(first.data);
    const changed = {
      deployments: batch.deployments.map((record) => ({ ...record, revision: 'another-revision' })),
      statuses: [],
    };
    expect(() => snapshot([batch, changed])).toThrow('invalid_timestamp');
    const changedStatus = {
      deployments: [],
      statuses: batch.statuses.map((record) => ({ ...record, signal: 'failure' })),
    };
    expect(() => snapshot([batch, changedStatus])).toThrow('conflicting_source_record');
  });
  it('orders GitHub source revisions across backfills, preserving cutoffs and rename identity', async () => {
    const original = await github([], [deployment()]);
    const old = {
      deployments: original.deployments.map((record) => ({
        ...record,
        observedAt: '2026-01-02T00:00:00Z',
      })),
      statuses: [],
    };
    const renamed = transport([
      response({ ...metadata, owner: { login: 'another-owner' }, name: 'another-name' }),
      response([deployment({ environment: 'prod', updated_at: '2026-01-03T00:00:00Z' })]),
      response([]),
    ]);
    const recent = await collectGitHubDeployments({
      instance: 'installation-1',
      repositoryId: 11,
      token: 'fictional-token',
      clock: () => new Date(observedAt),
      fetch: renamed.fetch,
    });
    const before = snapshot([old, recent], mapping(), '2026-01-03T12:00:00Z');
    expect(before.data.deployments[0]?.qualification).toBe('unknown');
    const after = snapshot([old, recent], mapping());
    expect(after.data.deployments[0]?.environment).toBe('production');
    expect(snapshot([recent, old, recent], mapping()).data).toEqual(after.data);
    expect(recent.deployments[0]?.sourceRef).toBe(old.deployments[0]?.sourceRef);
    const replay = {
      deployments: old.deployments.map((record) => ({ ...record, observedAt })),
      statuses: [],
    };
    expect(snapshot([replay, old], mapping(), '2026-01-03T12:00:00Z').data).toEqual(before.data);
  });
  it('rejects immutable changes and conflicting payloads at same GitHub revision', async () => {
    const batch = await github();
    for (const changed of [
      { environment: 'prod' },
      { revision: '2026-01-02T00:00:00Z', repository: { repositoryId, tipSha: 'b'.repeat(40) } },
      { revision: '2026-01-02T00:00:00Z', eventAt: '2026-01-01T09:00:00Z' },
    ])
      expect(() =>
        snapshot([
          batch,
          {
            deployments: batch.deployments.map((record) => ({ ...record, ...changed })),
            statuses: [],
          },
        ]),
      ).toThrow('conflicting_source_record');
  });
  it('filters late observations, including old events, before conflict checking', async () => {
    const batch = await github([status()], [deployment({ environment: 'prod' })]);
    const early = {
      deployments: batch.deployments.map((record) => ({
        ...record,
        observedAt: '2026-01-02T00:00:00Z',
      })),
      statuses: [],
    };
    const before = snapshot([early, batch], mapping(true), '2026-01-03T00:00:00Z');
    expect(before.data.deployments[0]?.qualification).toBe('unknown');
    const lateConflict = {
      deployments: batch.deployments.map((record) => ({
        ...record,
        revision: 'changed',
        observedAt,
      })),
      statuses: [],
    };
    expect(snapshot([early, lateConflict], mapping(true), '2026-01-03T00:00:00Z').data).toEqual(
      before.data,
    );
    expect(snapshot([early, batch], mapping(true)).data.deployments[0]?.qualification).toBe(
      'qualifying',
    );
    expect(before.data.deployments[0]?.effective_at).toBeNull();
    expect(Object.isFrozen(before.data.deployments[0])).toBe(true);
  });
  it('does not redate replay observations or retain mutable input references', async () => {
    const batch = await github();
    const mutable = {
      deployments: batch.deployments.map((record) => ({ ...record })),
      statuses: batch.statuses.map((record) => ({ ...record })),
    };
    const beforeInput = JSON.stringify(mutable);
    const before = snapshot([mutable], mapping(true));
    expect(JSON.stringify(mutable)).toBe(beforeInput);
    const changed = mutable.statuses[0];
    if (!changed) throw new Error('missing fixture');
    changed.signal = 'failure';
    expect(before.data.deployments[0]?.qualification).toBe('qualifying');
    const early = {
      deployments: batch.deployments.map((record) => ({
        ...record,
        observedAt: '2026-01-02T00:00:00Z',
      })),
      statuses: batch.statuses.map((record) => ({ ...record, observedAt: '2026-01-02T00:00:00Z' })),
    };
    expect(snapshot([batch, early], mapping(true)).data.deployments[0]?.observed_at).toBe(
      '2026-01-02T00:00:00Z',
    );
    expect(snapshot([early, batch], mapping(true)).data).toEqual(
      snapshot([batch, early], mapping(true)).data,
    );
  });
  it('rejects mapping after cutoff and delegates invalid window to OEMS', () => {
    expect(() => snapshot([], { ...mapping(), observedAt: '2027-01-01T00:00:00Z' })).toThrow(
      'mapping_after_cutoff',
    );
    const result = reconcileDeployments({
      datasetId: 'dataset',
      batches: [],
      mapping: mapping(),
      evidenceCutoff: observedAt,
      window: { ...window, calendar_days: 99 },
    });
    expect(result.ok).toBe(false);
  });
  it('repeated SHA deployments retain separate rollout identities', async () => {
    const first = await github();
    const second: EvidenceBatch = {
      deployments: first.deployments.map((record) => ({
        ...record,
        id: `${record.id}:second`,
        sourceDeploymentId: identity('repository', 11, 'deployment', 22),
      })),
      statuses: first.statuses.map((record) => ({
        ...record,
        id: `${record.id}:second`,
        deploymentId: `${record.deploymentId}:second`,
      })),
    };
    const result = snapshot([first, second], {
      ...mapping(true),
      deploymentBindings: [
        ...mapping().deploymentBindings,
        { sourceId, sourceDeploymentId: identity('repository', 11, 'deployment', 22) },
      ],
    });
    expect(calculate(result)[0]?.deployment_frequency.count).toBe(2);
  });
});
describe('Argo supplied notification contract and correlation', () => {
  it('captures operation/UID/config/app provenance separately; sync+health do not prove exposure', () => {
    const batch = normalizeArgoOperation(argo(), { instance: 'cluster-1', observedAt });
    expect(batch.deployments[0]).toMatchObject({
      reconciledConfigurationRevision: 'config-sha-1',
      repository: { repositoryId, tipSha: tip },
      operationKind: 'rollout',
    });
    expect(snapshot([batch], argoMapping()).data.deployments[0]?.qualification).toBe('unknown');
    const exposed = normalizeArgoOperation(argo({ consumer_exposure: true }), {
      instance: 'cluster-1',
      observedAt,
    });
    expect(snapshot([exposed], argoMapping(false)).data.deployments[0]?.qualification).toBe(
      'unknown',
    );
    expect(snapshot([exposed], argoMapping()).data.deployments[0]?.qualification).toBe(
      'qualifying',
    );
  });
  it.each(['self_heal', 'retry', 'unknown'])(
    '%s never automatically qualifies',
    (operationKind) => {
      const batch = normalizeArgoOperation(
        argo({ operation_kind: operationKind, consumer_exposure: true }),
        { instance: 'cluster-1', observedAt },
      );
      expect(snapshot([batch], argoMapping()).data.deployments[0]?.qualification).toBe('unknown');
    },
  );
  it('dedupes notifications for same operation, keeps repeated SHA operations separate', () => {
    const first = normalizeArgoOperation(argo({ consumer_exposure: true }), {
      instance: 'cluster-1',
      observedAt,
    });
    const repeated = normalizeArgoOperation(
      argo({ consumer_exposure: true, notification_revision: 'notice-2' }),
      { instance: 'cluster-1', observedAt },
    );
    expect(snapshot([first, repeated, first], argoMapping()).data.deployments).toHaveLength(1);
    const second = normalizeArgoOperation(argo({ operation_id: 'op-2', consumer_exposure: true }), {
      instance: 'cluster-1',
      observedAt,
    });
    const serviceMapping = {
      ...argoMapping(),
      deploymentBindings: [
        ...argoMapping().deploymentBindings,
        {
          sourceId: argoSourceId,
          sourceDeploymentId: identity('application', 'app-uid', 'operation', 'op-2'),
        },
      ],
    };
    expect(
      calculate(snapshot([first, second], serviceMapping))[0]?.deployment_frequency.count,
    ).toBe(2);
  });
  it('normalizes no app provenance without inventing change records from config revision', () => {
    const batch = normalizeArgoOperation(argo({ application_provenance: null }), {
      instance: 'cluster-1',
      observedAt,
    });
    expect(batch.deployments[0]?.repository).toBeNull();
    expect(snapshot([batch], argoMapping()).data.changes).toEqual([]);
  });
  it('rejects unauditable/invalid operation contracts and payload cannot forge observation', () => {
    for (const overrides of [
      { contract: 'other' },
      { operation_id: '' },
      { health: 'other' },
      { phase: 'other' },
      { consumer_exposure: 'yes' },
      { status_at: '2027-01-01T00:00:00Z' },
    ]) {
      expect(() =>
        normalizeArgoOperation(argo(overrides), { instance: 'cluster-1', observedAt }),
      ).toThrow();
    }
    const batch = normalizeArgoOperation(argo({ observed_at: '2027-01-01T00:00:00Z' }), {
      instance: 'cluster-1',
      observedAt,
    });
    expect(batch.deployments[0]?.observedAt).toBe(observedAt);
  });
  it('correlated GitHub+Argo rollout counts once, independent of arrival order', async () => {
    const gh = await github();
    const arg = normalizeArgoOperation(argo({ consumer_exposure: true }), {
      instance: 'cluster-1',
      observedAt,
    });
    const result = snapshot([gh, arg], correlatedMapping());
    expect(result.data.deployments).toHaveLength(1);
    expect(calculate(result)[0]?.deployment_frequency.count).toBe(1);
    expect(snapshot([arg, gh], correlatedMapping()).data).toEqual(result.data);
    expect(
      result.data.deployments[0]?.source_refs.some((ref) => ref.startsWith('urn:clio:argocd:')),
    ).toBe(true);
  });
  it('rejects incompatible explicitly correlated app commit provenance', async () => {
    const gh = await github();
    const arg = normalizeArgoOperation(
      argo({ application_provenance: { repository_id: repositoryId, commit_sha: 'b'.repeat(40) } }),
      { instance: 'cluster-1', observedAt },
    );
    expect(() => snapshot([gh, arg], correlatedMapping())).toThrow(
      'incompatible_correlated_provenance',
    );
    expect(() => snapshot([arg, gh], correlatedMapping())).toThrow(
      'incompatible_correlated_provenance',
    );
  });
  it('rejects correlated environment conflicts but reports secondary-only evidence as a gap', async () => {
    const gh = await github();
    const arg = normalizeArgoOperation(argo(), { instance: 'cluster-1', observedAt });
    const conflicting = {
      ...correlatedMapping(),
      environments: [
        ...mapping(true).environments,
        {
          sourceId: argoSourceId,
          environment: 'prod',
          classification: 'non_production',
          exposurePolicy: null,
        } as const,
      ],
    };
    expect(() => snapshot([gh, arg], conflicting)).toThrow('incompatible_correlated_environment');
    const partial = reconcileDeployments({
      datasetId: 'partial',
      window,
      evidenceCutoff: observedAt,
      mapping: correlatedMapping(),
      batches: [arg],
    });
    expect(partial.ok).toBe(true);
    expect(partial.diagnostics).toMatchObject([{ code: 'missing_primary_evidence' }]);
    if (partial.ok) expect(partial.data.data.deployments).toHaveLength(0);
  });
  it('historical cutoff reports missing primary while preserving other primary rollouts', async () => {
    const gh = await github();
    const early = {
      ...gh,
      deployments: gh.deployments.map((row) => ({
        ...row,
        id: identity(row.id, 'other'),
        sourceDeploymentId: identity(row.sourceDeploymentId, 'other'),
        observedAt: '2026-01-02T00:00:00Z',
      })),
      statuses: [],
    };
    const arg = normalizeArgoOperation(argo(), {
      instance: 'cluster-1',
      observedAt: '2026-01-02T00:00:00Z',
    });
    const config = {
      ...correlatedMapping(),
      deploymentBindings: [
        ...correlatedMapping().deploymentBindings,
        ...early.deployments.map(({ sourceId, sourceDeploymentId }) => ({
          sourceId,
          sourceDeploymentId,
        })),
      ],
    };
    const result = reconcileDeployments({
      datasetId: 'historical',
      window,
      evidenceCutoff: '2026-01-03T00:00:00Z',
      mapping: config,
      batches: [gh, arg, early],
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toMatchObject([{ code: 'missing_primary_evidence' }]);
    if (result.ok) expect(result.data.data.deployments).toHaveLength(1);
  });
  it('secondary exposure cannot qualify an unattested primary source', async () => {
    const gh = await github();
    const arg = normalizeArgoOperation(argo({ consumer_exposure: true }), {
      instance: 'cluster-1',
      observedAt,
    });
    const config = {
      ...correlatedMapping(),
      environments: [...mapping(false).environments, ...argoMapping().environments],
    };
    const result = snapshot([gh, arg], config);
    expect(result.data.deployments[0]?.qualification).toBe('unknown');
    expect(result.data.deployments[0]?.effective_at).toBeNull();
  });
  it('same SHA/time cannot correlate or double-count secondary source', async () => {
    const gh = await github();
    const arg = normalizeArgoOperation(argo({ consumer_exposure: true }), {
      instance: 'cluster-1',
      observedAt,
    });
    const result = snapshot([gh, arg], { ...correlatedMapping(), correlations: [] });
    expect(result.data.deployments).toHaveLength(1);
    expect(
      result.data.deployments[0]?.source_refs.every((ref) => !ref.startsWith('urn:clio:argocd:')),
    ).toBe(true);
  });
});

it('compares normalized provenance independently of object key insertion order', async () => {
  const batch = await github();
  const reordered: EvidenceBatch = {
    deployments: batch.deployments.map((record) => ({
      ...record,
      repository: record.repository
        ? { tipSha: record.repository.tipSha, repositoryId: record.repository.repositoryId }
        : null,
    })),
    statuses: batch.statuses,
  };
  expect(snapshot([batch, reordered], mapping(true)).data).toEqual(
    snapshot([reordered, batch], mapping(true)).data,
  );
});

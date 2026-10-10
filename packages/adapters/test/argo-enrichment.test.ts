import { calculate } from '@clio/oems';
import { describe, expect, it } from 'vitest';
import {
  type ArgoEnrichmentEvidence,
  type ArgoEnrichmentScope,
  identity,
  parseArgoEnrichment,
  parseArgoNotification,
  reconcileDeployments,
} from '../src/index.ts';

const scope: ArgoEnrichmentScope = {
  sourceId: '14026b3a-1955-4b55-aeb0-eabf926b4614',
  workspaceId: '24026b3a-1955-4b55-aeb0-eabf926b4614',
  serviceId: '34026b3a-1955-4b55-aeb0-eabf926b4614',
  instance: 'sandbox',
  applicationUid: 'app-uid',
  applicationName: 'guestbook',
  applicationNamespace: 'argocd',
  project: 'default',
  destinationClusterId: 'cluster-1',
  destinationServer: 'https://kubernetes.default.svc',
  destinationName: null,
  destinationNamespace: 'guestbook',
  configurationRepositoryId: 'git:config',
  repoURL: 'https://example.test/config.git',
  environment: 'production',
  producerId: '44026b3a-1955-4b55-aeb0-eabf926b4614',
  capability: 'consumer_exposure',
  policyReference: 'urn:fixture:traffic-policy:v1',
  repositoryIds: [],
};
const buildScope: ArgoEnrichmentScope = {
  ...scope,
  producerId: '54026b3a-1955-4b55-aeb0-eabf926b4614',
  capability: 'application_provenance',
  policyReference: 'urn:fixture:build-policy:v1',
  repositoryIds: ['git:app'],
};
const operationId = 'a4026b3a-1955-4b55-aeb0-eabf926b4614',
  at = '2026-10-10T10:01:00.123456Z',
  later = '2026-10-11T00:01:00Z',
  artifact = `sha256:${'a'.repeat(64)}`;
function native(
  phase = 'Succeeded',
  health = 'Healthy',
  operation = operationId,
  kind = 'rollout',
) {
  const result = parseArgoNotification(
    {
      contract: 'clio.argocd.notification.v1',
      application: {
        uid: scope.applicationUid,
        name: scope.applicationName,
        namespace: scope.applicationNamespace,
        project: scope.project,
        destination: {
          server: scope.destinationServer,
          name: null,
          namespace: scope.destinationNamespace,
        },
        repoURL: scope.repoURL,
        hasSources: false,
        hasSourceHydrator: false,
      },
      operation: {
        phase,
        startedAt: '2026-10-10T10:00:00Z',
        finishedAt: '2026-10-10T10:00:02Z',
        retryCount: 0,
        info: [
          { name: 'clio.operation-id', value: operation },
          { name: 'clio.operation-kind', value: kind },
        ],
        initiatedBy: { username: 'operator', automated: false },
        revision: 'config-v1',
        revisions: [],
      },
      health: { status: health, lastTransitionTime: '2026-10-10T10:00:05Z' },
    },
    scope,
    at,
  );
  if (result.kind !== 'operation') throw new Error('Expected operation');
  return result.evidence;
}
function wire(overrides: Record<string, unknown> = {}) {
  return {
    contract: 'clio.argocd.enrichment.v1',
    event_id: '64026b3a-1955-4b55-aeb0-eabf926b4614',
    source_id: scope.sourceId,
    producer_id: scope.producerId,
    policy_reference: scope.policyReference,
    evidence_ref: 'urn:fixture:activation:one',
    kind: 'consumer_exposure',
    application_uid: scope.applicationUid,
    operation_id: operationId,
    configuration_revision: 'config-v1',
    effective_at: '2026-10-10T10:00:01.000001Z',
    subject: { kind: 'artifact', digest: artifact },
    ...overrides,
  };
}
function build(overrides: Record<string, unknown> = {}) {
  return {
    contract: 'clio.argocd.enrichment.v1',
    event_id: '74026b3a-1955-4b55-aeb0-eabf926b4614',
    source_id: scope.sourceId,
    producer_id: buildScope.producerId,
    policy_reference: buildScope.policyReference,
    evidence_ref: 'urn:fixture:build:one',
    kind: 'application_provenance',
    repository_id: 'git:app',
    commit_sha: 'b'.repeat(40),
    artifact_digest: artifact,
    ...overrides,
  };
}
function receipt(input: unknown = wire(), grant = scope, observedAt = at): ArgoEnrichmentEvidence {
  const event = parseArgoEnrichment(input, grant, observedAt);
  return {
    event,
    scope: grant,
    observedAt,
    sourceRef: `urn:clio:argo-enrichment:${grant.sourceId}:${grant.producerId}:${event.event_id}`,
  };
}
function snapshot(
  enrichments: readonly ArgoEnrichmentEvidence[] = [],
  batches = [native()],
  cutoff = '2026-10-11T00:00:00Z',
) {
  const source = identity('argocd', scope.instance);
  const result = reconcileDeployments({
    datasetId: 'dataset:enrichment',
    window: {
      start: '2026-10-10T00:00:00Z',
      end: '2026-10-11T00:00:00Z',
      timezone: 'UTC',
      calendar_days: 1,
    },
    evidenceCutoff: cutoff,
    mapping: {
      serviceId: scope.serviceId,
      serviceName: 'Guestbook',
      revision: '1',
      observedAt: '2026-10-10T09:00:00Z',
      sourceRef: 'urn:fixture:mapping',
      primarySourceId: source,
      deploymentBindings: batches.flatMap((batch) =>
        batch.deployments.map((deployment) => ({
          sourceId: source,
          sourceDeploymentId: deployment.sourceDeploymentId,
        })),
      ),
      environments: [
        {
          sourceId: source,
          environment: 'production',
          classification: 'production',
          exposurePolicy: null,
        },
      ],
      correlations: [],
    },
    batches,
    argoEnrichments: enrichments,
    argoSourceId: scope.sourceId,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.data;
}
describe('independent Argo enrichment', () => {
  it('keeps native healthy success and unbound build inventory unknown', () => {
    const baseline = snapshot(),
      inventory = snapshot([receipt(build(), buildScope)]);
    expect(inventory.data.deployments).toEqual(baseline.data.deployments);
    expect(inventory.data.deployments[0]?.qualification).toBe('unknown');
    expect(native().statuses[0]?.consumerExposure).toBe(false);
    expect(native().deployments[0]?.repository).toBeNull();
    expect(snapshot([receipt(build(), buildScope)], []).data.deployments).toEqual([]);
  });
  it('qualifies failed/degraded canary exposure at original microsecond instant without inventing causal failure', () => {
    const enriched = snapshot([receipt()], [native('Failed', 'Degraded')]);
    expect(enriched.data.deployments[0]).toMatchObject({
      qualification: 'qualifying',
      effective_at: '2026-10-10T10:00:01.000001Z',
      failure: 'unknown',
      rework: 'unknown',
      change_ids: [],
      change_links_complete: false,
    });
    const metrics = calculate(enriched)[0];
    expect(metrics?.deployment_frequency.count).toBe(1);
    expect(metrics?.deployment_frequency.deployments_per_day).toBeNull();
    expect(metrics?.change_fail_rate.ratio).toBeNull();
    expect(metrics?.failed_deployment_recovery_time.median_seconds).toBeNull();
    expect(enriched.data).toMatchObject({
      collection_complete: false,
      deployment_history_complete: false,
      recovery_evidence_complete: false,
      changes: [],
      incidents: [],
    });
  });
  it('attaches exact-digest build provenance only through artifact exposure and respects receiver cutoff', () => {
    const exposure = receipt(),
      provenance = receipt(build(), buildScope, later);
    const before = snapshot([exposure, provenance]),
      after = snapshot([exposure, provenance], undefined, later);
    expect(before.data.deployments[0]?.extensions).not.toHaveProperty('artifact_source_provenance');
    expect(after.data.deployments[0]?.extensions).toMatchObject({
      artifact_source_provenance: [
        { repository_id: 'git:app', commit_sha: 'b'.repeat(40), artifact_digest: artifact },
      ],
    });
    expect(after.data.deployments[0]?.effective_at).toBe(before.data.deployments[0]?.effective_at);
    expect(after.data.deployments[0]?.observed_at).toBe(later);
    expect(after.data.deployments[0]?.id).toBe(before.data.deployments[0]?.id);
    expect(after.data.deployments[0]?.extensions).toMatchObject({
      tip_provenance: [],
      reconciled_configuration_revisions: [{ repository_id: 'git:config', revision: 'config-v1' }],
    });
  });
  it('qualifies configuration exposure without attaching build inventory', () => {
    const exposure = receipt(wire({ subject: { kind: 'configuration', revision: 'config-v1' } }));
    const enriched = snapshot([exposure, receipt(build(), buildScope)]);
    expect(enriched.data.deployments[0]?.qualification).toBe('qualifying');
    expect(enriched.data.deployments[0]?.extensions).not.toHaveProperty(
      'artifact_source_provenance',
    );
  });
  it('keeps late exposure out of older snapshots', () => {
    const exposure = receipt(wire(), scope, later);
    expect(snapshot([exposure]).data.deployments[0]?.qualification).toBe('unknown');
    expect(snapshot([exposure], undefined, later).data.deployments[0]?.qualification).toBe(
      'qualifying',
    );
  });
  it('does not join wrong operation/configuration/source or exposure before operation start', () => {
    for (const event of [
      wire({ operation_id: 'b4026b3a-1955-4b55-aeb0-eabf926b4614' }),
      wire({ configuration_revision: 'config-v2' }),
      wire({ effective_at: '2026-10-10T09:59:59Z' }),
    ]) {
      expect(snapshot([receipt(event)]).data.deployments[0]?.qualification).toBe('unknown');
    }
    const other = { ...scope, sourceId: '84026b3a-1955-4b55-aeb0-eabf926b4614', instance: 'other' };
    expect(
      snapshot([receipt(wire({ source_id: other.sourceId }), other)]).data.deployments[0]
        ?.qualification,
    ).toBe('unknown');
  });
  it('retains distinct operation identities at same configuration and does not reassign by timing', () => {
    const second = 'b4026b3a-1955-4b55-aeb0-eabf926b4614';
    const enriched = snapshot(
      [receipt(wire({ effective_at: '2026-10-10T10:00:55Z' }))],
      [native(), native('Succeeded', 'Healthy', second)],
    );
    expect(enriched.data.deployments).toHaveLength(2);
    expect(
      enriched.data.deployments.filter((row) => row.qualification === 'qualifying'),
    ).toHaveLength(1);
  });
  it.each(['retry', 'self_heal', 'unknown'])('cannot qualify %s native operation', (kind) => {
    expect(
      snapshot([receipt()], [native('Succeeded', 'Healthy', operationId, kind)]).data.deployments[0]
        ?.qualification,
    ).toBe('unknown');
  });
  it('keeps agreeing producer order deterministic and earliest eligible exposure', () => {
    const other = { ...scope, producerId: '84026b3a-1955-4b55-aeb0-eabf926b4614' };
    const a = receipt(),
      b = receipt(
        wire({
          producer_id: other.producerId,
          event_id: '94026b3a-1955-4b55-aeb0-eabf926b4614',
          effective_at: '2026-10-10T10:00:00.000001Z',
          evidence_ref: 'urn:fixture:activation:two',
        }),
        other,
      );
    expect(snapshot([a, b]).data).toEqual(snapshot([b, a]).data);
    expect(snapshot([a, b]).data.deployments[0]?.extensions).toMatchObject({
      independent_consumer_exposure: expect.arrayContaining([
        expect.objectContaining({ event_id: a.event.event_id, evidence_ref: a.event.evidence_ref }),
        expect.objectContaining({ event_id: b.event.event_id, evidence_ref: b.event.evidence_ref }),
      ]),
    });
    expect(snapshot([a, b]).data.deployments[0]?.effective_at).toBe('2026-10-10T10:00:00.000001Z');
    expect(snapshot([a, b]).data.deployments[0]?.source_refs).toEqual(
      expect.arrayContaining([a.sourceRef, b.sourceRef]),
    );
  });
  it('rejects incompatible subject/provenance rather than choosing array order', () => {
    expect(() =>
      snapshot([
        receipt(),
        receipt(
          wire({
            event_id: '94026b3a-1955-4b55-aeb0-eabf926b4614',
            subject: { kind: 'configuration', revision: 'config-v1' },
          }),
        ),
      ]),
    ).toThrow('conflicting_enrichment_subject');
    expect(() =>
      snapshot([
        receipt(build(), buildScope),
        receipt(
          build({ event_id: '94026b3a-1955-4b55-aeb0-eabf926b4614', commit_sha: 'c'.repeat(40) }),
          buildScope,
        ),
      ]),
    ).toThrow('conflicting_enrichment_subject');
  });
  it('joins a source-sized history within a bounded processing interval', () => {
    // 1000 native receipt/deployment/status triples plus 1000 exposure/subject pairs = 5000 rows.
    const operations = Array.from(
      { length: 1000 },
      (_, index) => `a4026b3a-1955-4b55-aeb0-${index.toString(16).padStart(12, '0')}`,
    );
    const batches = operations.map((operation) => native('Failed', 'Degraded', operation));
    const enrichments = operations.map((operation, index) =>
      receipt(
        wire({
          operation_id: operation,
          event_id: `64026b3a-1955-4b55-aeb0-${index.toString(16).padStart(12, '0')}`,
        }),
      ),
    );
    const start = performance.now();
    const captured = snapshot(enrichments, batches);
    expect(captured.data.deployments).toHaveLength(1000);
    expect(
      captured.data.deployments.every((deployment) => deployment.qualification === 'qualifying'),
    ).toBe(true);
    expect(performance.now() - start).toBeLessThan(5000);
  });
  it('deduplicates exact producer replay and keeps first receiver observation', () => {
    const original = receipt();
    const repeated = { ...original, observedAt: '2026-10-10T10:02:00Z' };
    expect(snapshot([repeated, original])).toEqual(snapshot([original]));
  });
  it('does not join a different source with identical Argo instance and Application scope', () => {
    const other = { ...scope, sourceId: '84026b3a-1955-4b55-aeb0-eabf926b4614' };
    expect(
      snapshot([receipt(wire({ source_id: other.sourceId }), other)]).data.deployments[0]
        ?.qualification,
    ).toBe('unknown');
  });
  it.each([
    wire({ unexpected: true }),
    wire({ producer_id: buildScope.producerId }),
    wire({ policy_reference: 'wrong' }),
    wire({ application_uid: 'wrong' }),
    wire({ effective_at: '2026-10-10T10:04:00Z' }),
    wire({ effective_at: '2026-10-10T10:00:01+00:00' }),
    wire({ subject: { kind: 'configuration', revision: 'wrong' } }),
    wire({ subject: { kind: 'artifact', digest: 'latest' } }),
    wire({ subject: { kind: 'artifact', digest: artifact, extra: true } }),
  ])('rejects malformed or unauthorized exposure %#', (event) => {
    expect(() => receipt(event)).toThrow();
  });
  it('rejects capability misuse, ungranted repositories and uppercase commit aliases', () => {
    expect(() => receipt(wire(), buildScope)).toThrow();
    expect(() => receipt(build(), scope)).toThrow();
    expect(() => receipt(build({ repository_id: 'git:other' }), buildScope)).toThrow();
    expect(() => receipt(build({ commit_sha: 'A'.repeat(40) }), buildScope)).toThrow();
  });
});

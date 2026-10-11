import { validateSnapshot } from '@clio/oems';
import { describe, expect, it } from 'vitest';
import { settings } from '../src/features/deployment-mappings/input.ts';
import {
  completeLifecycle,
  lifecycleEvidence,
} from '../src/features/deployment-mappings/lifecycle-fixture.ts';
import { parseLifecycleResult } from '../src/features/deployment-mappings/lifecycle-result.ts';
import { captureMapping } from '../src/features/deployment-mappings/preview.ts';
import { parseMapping, run } from '../src/features/mock-collection/model.ts';

const mapping = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  serviceId: '00000000-0000-4000-8000-000000000002',
  mode: 'mock',
  revision: 1,
  scenario: 'complete-lifecycle',
  primaryProvider: 'github',
  productionEnvironment: 'production',
  exposureAttested: true,
  observedAt: '2026-10-10T00:00:00.000Z',
} as const;
const service = { id: mapping.serviceId, name: 'Fictional lifecycle demo' };
describe('complete fictional lifecycle', () => {
  it('rejects a different operation identity despite matching time, refs and source commit', () => {
    const capture = captureMapping(mapping, service);
    const mutated = validateSnapshot({
      ...capture.snapshot,
      deployments: capture.snapshot.deployments.map((deployment, index) =>
        index === 0 ? { ...deployment, rollout_group_id: 'fictional-other-operation' } : deployment,
      ),
    });
    if (!mutated.ok) throw new Error('Invalid negative fixture');
    expect(() => completeLifecycle(mutated.data, mapping.primaryProvider)).toThrow(
      'Fictional operation mismatch',
    );
  });
  for (const primaryProvider of ['github', 'argocd'] as const) {
    it(`calculates all five pinned metrics from ${primaryProvider} fictional facts`, () => {
      const saved = { ...mapping, primaryProvider };
      const capture = captureMapping(saved, service);
      const metric = capture.metrics[0];
      expect(metric).toMatchObject({
        deployment_frequency: { count: 3, deployments_per_day: 1.5 },
        change_fail_rate: { numerator: 1, denominator: 3, ratio: 1 / 3, unknown_count: 0 },
        deployment_rework_rate: { numerator: 1, denominator: 3, ratio: 1 / 3, unknown_count: 0 },
        change_lead_time: { observation_count: 3, median_seconds: 3600 },
        failed_deployment_recovery_time: {
          observation_count: 1,
          median_seconds: 1800,
          approximate_count: 0,
        },
      });
      expect(capture.snapshot).toMatchObject({
        collection_complete: true,
        deployment_history_complete: true,
        recovery_evidence_complete: true,
      });
      expect(capture.snapshot.changes).toHaveLength(3);
      expect(new Set(capture.snapshot.changes.map((c) => c.commit_id)).size).toBe(3);
      expect(
        capture.snapshot.deployments.filter((d) => d.failure === 'no_recorded_failure'),
      ).toHaveLength(2);
      expect(
        capture.snapshot.deployments.filter((d) => d.rework === 'not_incident_driven'),
      ).toHaveLength(2);
      expect(parseLifecycleResult(capture.preview, saved)).toEqual(capture.preview);
      expect(() =>
        captureMapping(saved, service, { ...lifecycleEvidence(primaryProvider), statuses: [] }),
      ).toThrow();
    });
  }
  it('rejects unknown scenarios and contradictory complete profiles; legacy stays partial', () => {
    const input = { ...mapping, expectedRevision: null };
    for (const change of [
      { scenario: 'other' },
      { scenario: null },
      { productionEnvironment: 'staging' },
      { exposureAttested: false },
    ]) {
      const {
        workspaceId: _w,
        serviceId: _s,
        mode: _m,
        revision: _r,
        observedAt: _o,
        ...body
      } = input;
      expect(() => settings({ ...body, ...change })).toThrow();
      expect(() => parseMapping({ ...mapping, ...change })).toThrow();
    }
    const { scenario: _scenario, ...legacy } = mapping;
    const capture = captureMapping(parseMapping(legacy), service);
    expect(capture.snapshot.collection_complete).toBe(false);
    expect(capture.preview.deploymentFrequency.deploymentsPerDay).toBeNull();
  });
  it('fails closed on scope, scenario, version, cutoff and private metric fields', () => {
    const result = captureMapping(mapping, service).preview;
    for (const change of [
      { serviceId: mapping.workspaceId },
      { scenario: 'partial' },
      { resultVersion: 'v2' },
      { mappingRevision: 2 },
      { oemsRevision: 'other' },
      { evidenceCutoff: '2025-01-01T00:00:00.000Z' },
      { metricResult: { ...result.metricResult, privateEvidence: 'forbidden' } },
      {
        metricResult: {
          ...result.metricResult,
          change_lead_time: { ...result.metricResult?.change_lead_time, median_seconds: 0 },
        },
      },
    ])
      expect(() => parseLifecycleResult({ ...result, ...change }, mapping)).toThrow();
  });
});

it('reads original captured complete run and rejects scenario loss or mutation', () => {
  const result = captureMapping(mapping, service).preview;
  const stored = {
    id: '00000000-0000-4000-8000-000000000003',
    workspace_id: mapping.workspaceId,
    service_id: mapping.serviceId,
    mapping_revision: 1,
    mapping_input: mapping,
    service_name: service.name,
    status: 'succeeded',
    attempts: 1,
    result,
    failure_code: null,
    created_at_text: mapping.observedAt,
    updated_at_text: mapping.observedAt,
    completed_at_text: mapping.observedAt,
  };
  expect(run(stored).result).toEqual(result);
  const { scenario: _scenario, ...legacy } = mapping;
  expect(() => run({ ...stored, mapping_input: legacy })).toThrow();
  expect(() => run({ ...stored, mapping_input: { ...mapping, scenario: 'partial' } })).toThrow();
});

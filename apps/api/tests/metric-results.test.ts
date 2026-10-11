import { type EvidenceBatch, identity } from '@clio/adapters';
import { calculate, validateSnapshot } from '@clio/oems';
import { describe, expect, it } from 'vitest';
import { captureArgo } from '../src/features/argo-collection/capture.ts';
import type { ArgoConnection } from '../src/features/argo-collection/input.ts';
import { parseResult as parseArgo } from '../src/features/argo-collection/result.ts';
import { captureGitHub } from '../src/features/github-collection/capture.ts';
import { type Connection, windowInput } from '../src/features/github-collection/input.ts';
import { parseResult as parseGitHub } from '../src/features/github-collection/result.ts';

const scope = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  serviceId: '33333333-3333-4333-8333-333333333333',
};
const github: Connection = {
  ...scope,
  mode: 'live',
  provider: 'github',
  revision: 1,
  active: true,
  installationId: 1,
  repositoryId: 2,
  repositoryName: 'fictional/repo',
  accountLogin: 'fictional',
  productionEnvironment: 'production',
  exposurePolicyReference: 'urn:fictional:exposure',
  repositoryDeploymentsBelongToService: true,
  observedAt: '2026-01-01T00:00:00Z',
  verifiedAt: '2026-01-01T00:00:00Z',
};
const argo: ArgoConnection = {
  ...scope,
  mode: 'live',
  provider: 'argocd',
  revision: 1,
  active: true,
  sourceId: '77777777-7777-4777-8777-777777777777',
  applicationName: 'fictional',
  applicationNamespace: 'argocd',
  instance: 'fictional',
  productionEnvironment: 'production',
  exposurePolicyReference: 'urn:fictional:exposure',
  applicationOperationsBelongToService: true,
  observedAt: github.observedAt,
};
const window = windowInput({ start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' });
const cutoff = '2026-01-04T00:00:00.000001Z';
function capture(provider: 'github' | 'argocd', empty = false) {
  const sourceId = identity(provider, provider === 'github' ? '1' : 'fictional');
  const evidence: EvidenceBatch = {
    deployments: empty
      ? []
      : [
          {
            id: 'fictional:deployment',
            sourceId,
            sourceDeploymentId: 'fictional:deployment',
            revision: '2026-01-02T01:00:00Z',
            environment: 'production',
            eventAt: '2026-01-02T01:00:00Z',
            observedAt: cutoff,
            sourceRef: 'urn:fictional:deployment',
            repository: null,
            reconciledConfigurationRevision: null,
            configurationRepositoryId: null,
            deploymentTask: null,
            operationKind: 'rollout',
          },
        ],
    statuses: empty
      ? []
      : [
          {
            id: 'fictional:status',
            deploymentId: 'fictional:deployment',
            revision: '2026-01-02T01:00:00Z',
            environment: 'production',
            signal: provider === 'github' ? 'success' : 'Succeeded',
            health: provider === 'github' ? null : 'Healthy',
            consumerExposure: true,
            eventAt: '2026-01-02T01:01:00Z',
            observedAt: cutoff,
            sourceRef: 'urn:fictional:status',
          },
        ],
  };
  const common = {
    runId: '55555555-5555-4555-8555-555555555555',
    serviceName: 'Fictional',
    window,
    evidence,
    databaseObservedAt: cutoff,
  };
  return provider === 'github'
    ? captureGitHub({ ...common, connection: github, transportComplete: true, acquiredAt: cutoff })
    : captureArgo({
        ...common,
        connection: argo,
        stats: {
          retainedReceiptCount: empty ? 0 : 1,
          retainedEvidenceCount: empty ? 0 : 1,
          recordedGapCount: 0,
          gapReasons: {},
          rejectionCount: 0,
          scopeDriftCount: 0,
          observationPeriod: { start: null, end: cutoff },
        },
      });
}
function parse(provider: 'github' | 'argocd', value: unknown) {
  return provider === 'github'
    ? parseGitHub(value, github, window)
    : parseArgo(value, argo, window);
}
describe.each(['github', 'argocd'] as const)('%s five-metric saved boundary', (provider) => {
  it.each([true, false])('saves exact actual calculated result, empty=%s', (empty) => {
    const captured = capture(provider, empty);
    expect(captured.result.metricResult).toEqual(captured.metrics[0]);
    expect(captured.result.metricResult).not.toBe(captured.metrics[0]);
    expect(captured.result.metricResult?.deployment_frequency.count).toBe(empty ? 0 : 1);
    expect(captured.result.coverage).toEqual({
      collectionComplete: false,
      deploymentHistoryComplete: false,
      recoveryEvidenceComplete: false,
    });
    const { metricResult, ...older } = captured.result;
    expect(parse(provider, older)).toEqual(older);
    expect(metricResult).toBeDefined();
  });
  it('rejects private fields, wrong context and contradictory summaries without truncation', () => {
    const saved = capture(provider).result;
    const metric = saved.metricResult;
    if (!metric) throw new Error('Missing metric');
    const mutations: unknown[] = [
      { ...metric, extensions: { token: 'private' } },
      { ...metric, dataset: {} },
      { ...metric, service_id: scope.workspaceId },
      { ...metric, profile_version: 'future' },
      { ...metric, evidence_cutoff: '2026-01-04T00:00:00.000002Z' },
      { ...metric, evidence_cutoff: '2026-01-04T00:00:00Z' },
      { ...metric, window: { ...metric.window, start: '2026-01-01T00:00:00.000001Z' } },
      { ...metric, window: { ...metric.window, end: '2026-01-04T00:00:00Z' } },
      { ...metric, window: { ...metric.window, calendar_days: 3 } },
      { ...metric, deployment_frequency: { ...metric.deployment_frequency, count: 2 } },
      {
        ...metric,
        deployment_frequency: {
          ...metric.deployment_frequency,
          quality_reasons: ['incomplete_history'],
        },
      },
      { ...metric, change_fail_rate: { ...metric.change_fail_rate, denominator: 2 } },
      { ...metric, change_fail_rate: { ...metric.change_fail_rate, lower_bound: 0.5 } },
      { ...metric, change_lead_time: { ...metric.change_lead_time, privateId: 'secret' } },
      { ...metric, change_lead_time: { ...metric.change_lead_time, median_seconds: 0 } },
      {
        ...metric,
        deployment_rework_rate: {
          ...metric.deployment_rework_rate,
          bounds_scope: 'full_population',
        },
      },
    ];
    for (const metricResult of mutations)
      expect(() => parse(provider, { ...saved, metricResult })).toThrow();
    expect(() => parse(provider, { ...saved, failedDeploymentRecoveryTime: 0 })).toThrow();
  });
  it('retains a provisional exact recovery value while preserving false coverage', () => {
    const captured = capture(provider);
    const deployment = captured.snapshot.deployments[0];
    if (!deployment) throw new Error('Missing fictional deployment');
    const snapshot = {
      ...captured.snapshot,
      deployments: [
        { ...deployment, failure: 'failed', failure_evidence_refs: ['urn:fictional:failure'] },
      ],
      incidents: [
        {
          id: 'fictional:incident',
          service_id: scope.serviceId,
          causal_deployment_id: deployment.id,
          source_refs: ['urn:fictional:incident'],
          observed_at: cutoff,
          failure_started_at: deployment.effective_at ?? '2026-01-02T01:01:00Z',
          restored_at: '2026-01-02T01:11:00Z',
          start_is_approximate: false,
        },
      ],
    };
    const checked = validateSnapshot(snapshot);
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
    const metricResult = calculate(checked.data)[0];
    if (!metricResult) throw new Error('Missing metric');
    const saved = parse(provider, {
      ...captured.result,
      metricResult,
      failedDeploymentRecoveryTime: metricResult.failed_deployment_recovery_time.median_seconds,
    });
    expect(saved.failedDeploymentRecoveryTime).toBe(600);
    expect(saved.metricResult?.failed_deployment_recovery_time.status).toBe('provisional');
    expect(saved.coverage.recoveryEvidenceComplete).toBe(false);
  });
  it('accepts equivalent timestamp spelling at exact microsecond precision', () => {
    const saved = capture(provider).result;
    const metric = saved.metricResult;
    if (!metric) throw new Error('Missing metric');
    expect(
      parse(provider, {
        ...saved,
        metricResult: { ...metric, evidence_cutoff: '2026-01-04T01:00:00.000001+01:00' },
      }).metricResult?.evidence_cutoff,
    ).toBe('2026-01-04T01:00:00.000001+01:00');
  });
});

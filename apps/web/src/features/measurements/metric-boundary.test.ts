import { describe, expect, it } from 'vitest';
import { parseRun as parseArgo } from '../argo-collection/api';
import {
  completed as argoCompleted,
  result as argoResult,
} from '../argo-collection/fixtures.test-support';
import { parseRun as parseGitHub } from '../github-collection/api';
import { completed, result, scope } from '../github-collection/fixtures.test-support';
import { withMetric } from './fixtures.test-support';

describe.each(['github', 'argocd'] as const)('%s calculated browser boundary', (provider) => {
  const parse = provider === 'github' ? parseGitHub : parseArgo;
  const run = provider === 'github' ? completed : argoCompleted;
  const summary = provider === 'github' ? result : argoResult;
  it('retains validated actual five-metric copy and older result unchanged', () => {
    const saved = withMetric(summary);
    expect(parse({ run: { ...run, result: saved } }, scope).result).toEqual(saved);
    expect(parse({ run: { ...run, result: saved } }, scope).result?.metricResult).not.toBe(
      saved.metricResult,
    );
    expect(parse({ run }, scope).result).toEqual(summary);
  });
  it('rejects extra private fields, future/different microsecond cutoff and inconsistent metrics', () => {
    const saved = withMetric(summary),
      metric = saved.metricResult;
    for (const metricResult of [
      { ...metric, token: 'private' },
      { ...metric, service_id: scope.workspaceId },
      { ...metric, window: { ...metric.window, start: '2026-01-01T00:00:00.000001Z' } },
      { ...metric, window: { ...metric.window, calendar_days: 3 } },
      { ...metric, evidence_cutoff: '2026-01-04T00:01:00.000002Z' },
      { ...metric, evidence_cutoff: '2026-01-04T00:01:00Z' },
      { ...metric, deployment_frequency: { ...metric.deployment_frequency, count: 0 } },
      { ...metric, change_fail_rate: { ...metric.change_fail_rate, ratio: 1 } },
      {
        ...metric,
        failed_deployment_recovery_time: {
          ...metric.failed_deployment_recovery_time,
          source_refs: ['private'],
        },
      },
    ])
      expect(() => parse({ run: { ...run, result: { ...saved, metricResult } } }, scope)).toThrow();
    expect(() =>
      parse({ run: { ...run, result: { ...saved, failedDeploymentRecoveryTime: null } } }, scope),
    ).toThrow();
  });
});

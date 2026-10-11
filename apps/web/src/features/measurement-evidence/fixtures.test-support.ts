import { calculate, type Dataset, validateSnapshot } from '@clio/oems';
import {
  completed as native,
  result as nativeResult,
  scope,
} from '../github-collection/fixtures.test-support';
import { metricFixture } from '../measurements/fixtures.test-support';
import type { Authority, MeasurementResult, Run } from './api';

export { json, scope } from '../github-collection/fixtures.test-support';
export const basis = {
  ...native,
  result: { ...nativeResult, evidenceCutoff: '2026-01-04T00:00:30.000001Z' },
};
export function resultFixture(complete = true, empty = false): MeasurementResult {
  const metric = metricFixture(complete, empty);
  return {
    contract: 'clio.measurement.result.v1',
    ...scope,
    provider: 'github',
    basisRunId: basis.id,
    connectionRevision: 1,
    oemsRevision: native.result?.oemsRevision ?? '',
    window: {
      start: metric.window.start,
      end: metric.window.end,
      timezone: 'UTC',
      calendarDays: metric.window.calendar_days,
    },
    basisEvidenceCutoff: basis.result.evidenceCutoff,
    evidenceCutoff: metric.evidence_cutoff,
    assessment: {
      blockers: complete ? [] : ['population_missing', 'history_missing', 'recovery_missing'],
      collectionComplete: complete,
      historyComplete: complete,
      recoveryComplete: complete,
    },
    coverage: {
      collectionComplete: complete,
      deploymentHistoryComplete: complete,
      recoveryEvidenceComplete: complete,
    },
    metricResult: metric,
  };
}
export function runFixture(complete = true, empty = false): Run {
  return {
    ...scope,
    id: '66666666-6666-4666-8666-666666666666',
    provider: 'github',
    basisRunId: basis.id,
    status: 'succeeded',
    attempts: 1,
    createdAt: '2026-01-04T00:00:31Z',
    updatedAt: '2026-01-04T00:02:00Z',
    completedAt: '2026-01-04T00:02:00Z',
    failureCode: null,
    result: resultFixture(complete, empty),
  };
}
export const queued: Run = {
  ...runFixture(),
  status: 'pending',
  result: null,
  attempts: 0,
  completedAt: null,
};
export const authorities: Authority[] = [
  {
    name: 'Fictional deployment census',
    capability: 'population',
    producerId: '77777777-7777-4777-8777-777777777777',
    receiptAvailable: true,
  },
  {
    name: 'Fictional second census',
    capability: 'population',
    producerId: '88888888-8888-4888-8888-888888888888',
    receiptAvailable: true,
  },
  {
    name: 'Fictional history',
    capability: 'change_links',
    producerId: '99999999-9999-4999-8999-999999999999',
    receiptAvailable: false,
  },
];
export function cursor(run: { createdAt: string; id: string }): string {
  return btoa(JSON.stringify({ createdAt: run.createdAt, id: run.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export const page = Array.from({ length: 25 }, (_, i) => ({
  ...runFixture(),
  id: `${String(100 - i).padStart(8, '0')}-1111-4111-8111-111111111111`,
}));
export const pageCursor = cursor(page[24] ?? runFixture());

// Exhaustive retained history can still contain unknown pre-window qualification.
export function prewindowUnknownFixture(): MeasurementResult {
  const result = resultFixture(true, true);
  const observed = result.evidenceCutoff;
  const dataset: Dataset = {
    dataset_id: 'urn:fictional:prewindow',
    profile_version: '0.1-draft',
    snapshot_as_of_cutoff: true,
    window: {
      start: result.window.start,
      end: result.window.end,
      timezone: 'UTC',
      calendar_days: result.window.calendarDays,
    },
    evidence_cutoff: observed,
    collection_complete: true,
    deployment_history_complete: true,
    recovery_evidence_complete: true,
    services: [
      {
        id: scope.serviceId,
        name: 'Fictional service',
        observed_at: observed,
        source_refs: ['urn:fictional:service'],
      },
    ],
    changes: [],
    incidents: [],
    deployments: [
      {
        id: 'deployment:unknown-history',
        service_id: scope.serviceId,
        rollout_group_id: 'rollout:unknown',
        source_refs: ['urn:fictional:unknown'],
        environment: 'production',
        qualification: 'unknown',
        effective_at: '2025-12-31T00:00:00Z',
        observed_at: observed,
        qualification_window: null,
        change_ids: [],
        change_links_complete: false,
        failure: 'unknown',
        rework: 'unknown',
        failure_evidence_refs: [],
        rework_evidence_refs: [],
      },
    ],
  };
  const checked = validateSnapshot(dataset);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  const metric = calculate(checked.data)[0];
  if (!metric) throw new Error('Missing fictional metric');
  return { ...result, metricResult: metric };
}

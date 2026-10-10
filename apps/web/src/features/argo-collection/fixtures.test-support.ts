import { oemsContract } from '@clio/oems/contract';
import type { Connection, Result, Run } from './api';
// Fictional evidence for browser boundary tests; no provider calls.
export const scope = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  serviceId: '33333333-3333-4333-8333-333333333333',
};
export const connection: Connection = {
  ...scope,
  mode: 'live',
  provider: 'argocd',
  revision: 1,
  active: true,
  sourceId: '77777777-7777-4777-8777-777777777777',
  applicationName: 'delivery',
  applicationNamespace: 'argocd',
  instance: 'sandbox',
  productionEnvironment: 'production',
  exposurePolicyReference: null,
  applicationOperationsBelongToService: true,
  observedAt: '2026-01-04T00:00:00.000002Z',
};
export const source = {
  sourceId: connection.sourceId,
  applicationName: 'delivery',
  applicationNamespace: 'argocd',
  instance: 'sandbox',
  environment: 'production',
};
export const result: Result = {
  ...scope,
  mode: 'live',
  provider: 'argocd',
  connectionRevision: 1,
  oemsRevision: oemsContract.revision,
  window: {
    start: '2026-01-01T00:00:00Z',
    end: '2026-01-03T00:00:00Z',
    timezone: 'UTC',
    calendarDays: 2,
  },
  evidenceCutoff: '2026-01-04T00:01:00.000001Z',
  transportComplete: false,
  retainedReceiptCount: 4,
  retainedEvidenceCount: 2,
  recordedGapCount: 2,
  gapReasons: { unmarked_operation: 1, connection_interruption: 1 },
  rejectionCount: 3,
  scopeDriftCount: 1,
  observationPeriod: { start: '2025-12-01T00:00:00Z', end: '2026-01-04T00:01:00.000001Z' },
  deploymentCount: 2,
  qualifyingCount: 0,
  unknownCount: 2,
  coverage: {
    collectionComplete: false,
    deploymentHistoryComplete: false,
    recoveryEvidenceComplete: false,
  },
  deploymentFrequency: {
    count: 0,
    status: 'provisional',
    deploymentsPerDay: null,
    qualityReasons: ['incomplete_collection'],
  },
  changeFailureRate: null,
  failedDeploymentRecoveryTime: null,
};
export const completed: Run = {
  ...scope,
  id: '55555555-5555-4555-8555-555555555555',
  mode: 'live',
  provider: 'argocd',
  connectionRevision: 1,
  status: 'succeeded',
  attempts: 1,
  createdAt: '2026-01-04T00:00:01Z',
  updatedAt: '2026-01-04T00:02:00Z',
  completedAt: '2026-01-04T00:02:00Z',
  failureCode: null,
  result,
};
export const queued: Run = {
  ...completed,
  status: 'pending',
  attempts: 0,
  result: null,
  completedAt: null,
};
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

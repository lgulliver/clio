import { oemsContract } from '@clio/oems/contract';
import type { Mapping, Preview } from '../deployment-mappings/api';
import type { Run } from './api';
export const scope = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  serviceId: '33333333-3333-4333-8333-333333333333',
};
export const mapping: Mapping = {
  ...scope,
  mode: 'mock',
  revision: 1,
  observedAt: '2026-10-10T00:00:00.000001Z',
  primaryProvider: 'github',
  productionEnvironment: 'production',
  exposureAttested: false,
};
export const preview: Preview = {
  ...scope,
  mode: 'mock',
  mappingRevision: 1,
  oemsRevision: oemsContract.revision,
  window: {
    start: '2026-01-01T00:00:00Z',
    end: '2026-01-03T00:00:00Z',
    timezone: 'UTC',
    calendarDays: 2,
  },
  evidenceCutoff: '2026-10-10T00:00:00.000001Z',
  qualification: 'unknown',
  rolloutCount: 1,
  coverage: {
    collectionComplete: false,
    deploymentHistoryComplete: false,
    recoveryEvidenceComplete: false,
  },
  deploymentFrequency: {
    count: 0,
    status: 'provisional',
    deploymentsPerDay: null,
    qualityReasons: ['incomplete_coverage'],
  },
  changeFailureRate: null,
  failedDeploymentRecoveryTime: null,
};
export const completed: Run = {
  ...scope,
  id: '55555555-5555-4555-8555-555555555555',
  mode: 'mock',
  mappingRevision: 1,
  mappingObservedAt: mapping.observedAt,
  primaryProvider: 'github',
  status: 'succeeded',
  attempts: 1,
  createdAt: '2026-10-10T00:01:00Z',
  updatedAt: '2026-10-10T00:02:00Z',
  completedAt: '2026-10-10T00:02:00Z',
  failureCode: null,
  result: preview,
};
export const queued: Run = {
  ...completed,
  status: 'pending',
  attempts: 0,
  completedAt: null,
  result: null,
};
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

import type { PullCheckpoint } from '@clio/adapters';
import { expect, it } from 'vitest';
import { calculateSignals } from '../src/features/space-github/calculate.ts';
import { contractVersion } from '../src/features/space-github/contract.ts';
import { resultFrom, runFrom } from '../src/features/space-github/repository.ts';

const id = '00000000-0000-4000-8000-000000000001';
const context = {
  workspaceId: id,
  mappingId: id,
  mappingRevision: 1,
  teamId: id,
  teamName: 'Team',
  appId: 12,
  installationId: 10,
  repositoryId: 20,
  repositoryLabel: 'fixture/repo',
  windowStart: '2026-01-01T00:00:00.000Z',
  windowEnd: '2026-01-03T00:00:00.000Z',
};
const evidence: PullCheckpoint = {
  version: 1,
  phase: 'ready',
  repositoryId: 20,
  repositoryOwner: 'fixture',
  repositoryName: 'repo',
  nextPullPage: null,
  nextReviewIndex: 0,
  nextReviewPage: 1,
  pulls: [],
  reviews: [],
  reviewTraversalComplete: [],
  discoveryTraversalComplete: true,
  gaps: [],
};
function row() {
  const result = {
    ...context,
    id,
    runId: id,
    acquisitionStartedAt: '2026-01-04T00:00:00.000001Z',
    acquisitionEndedAt: '2026-01-04T00:00:00.000002Z',
    completedAt: '2026-01-04T00:00:00.000003Z',
    contractVersion,
    calculated: calculateSignals(evidence, {
      windowStart: context.windowStart,
      windowEnd: context.windowEnd,
    }),
    discoveryTraversalComplete: true,
    reviewTraversalComplete: true,
    gaps: [],
  };
  return {
    id,
    run_id: id,
    workspace_id: id,
    mapping_id: id,
    context,
    evidence,
    result,
    acquisition_started_at: result.acquisitionStartedAt,
    acquisition_ended_at: result.acquisitionEndedAt,
    completed_at: result.completedAt,
  };
}
it('reads safe JSON without touching private evidence', () => {
  const stored = row();
  Object.defineProperty(stored, 'evidence', {
    get() {
      throw new Error('Private evidence fetched');
    },
  });
  expect(resultFrom(stored)).toEqual(stored.result);
});
it.each(['before-window', 'inverted-acquisition', 'after-completion'])(
  'rejects %s acquisition as redacted server failure',
  (kind) => {
    const stored = row();
    if (kind === 'before-window')
      stored.result.acquisitionStartedAt = stored.acquisition_started_at =
        '2026-01-02T00:00:00.000001Z';
    if (kind === 'inverted-acquisition')
      stored.result.acquisitionStartedAt = stored.acquisition_started_at =
        '2026-01-04T00:00:00.000003Z';
    if (kind === 'after-completion')
      stored.result.acquisitionEndedAt = stored.acquisition_ended_at =
        '2026-01-04T00:00:00.000004Z';
    expect(() => resultFrom(stored)).toThrowError(
      expect.objectContaining({ status: 500, message: 'invalid_stored_data' }),
    );
  },
);
it('redacts corrupt safe result JSON as 500, never request 400', () => {
  const stored = row();
  stored.result.id = 'private-corrupt-value';
  expect(() => resultFrom(stored)).toThrowError(
    expect.objectContaining({ status: 500, message: 'invalid_stored_data' }),
  );
});
it('redacts corrupt run context as 500', () => {
  expect(() =>
    runFrom({
      id,
      context: { ...context, teamId: 'bad' },
      state: 'queued',
      queued_at: '2026-01-04T00:00:00.000001Z',
      completed_at: null,
      reason: null,
      result_id: null,
    }),
  ).toThrowError(expect.objectContaining({ status: 500, message: 'invalid_stored_data' }));
});
it.each([
  { contractVersion: 'wrong' },
  { extra: 'private' },
  { repositoryLabel: 'invalid' },
  { teamName: ' Team ' },
  { teamName: 'Team\nName' },
  { discoveryTraversalComplete: 'true' },
  { discoveryTraversalComplete: true, gaps: ['discovery_limit'] },
  { gaps: ['unknown_actor', 'unknown_actor'] },
  { gaps: ['not-known'] },
  { acquisitionEndedAt: '2026-01-04T00:00:00.000002+00:00' },
  { acquisitionEndedAt: '2026-02-30T00:00:00Z' },
])('rejects malformed public shape %j without recalculation', (change) => {
  const stored = row();
  expect(() => resultFrom({ ...stored, result: { ...stored.result, ...change } })).toThrowError(
    expect.objectContaining({ status: 500, message: 'invalid_stored_data' }),
  );
});
it.each(['version', 'units', 'status', 'sample', 'context', 'traversal'])(
  'rejects invalid safe calculation %s',
  (kind) => {
    const stored = row(),
      calculated = stored.result.calculated;
    const signals = calculated.signals.map((s) => ({ ...s }));
    const first = signals[0];
    if (!first) throw new Error('Missing signal');
    let changed: unknown = calculated;
    if (kind === 'version') changed = { ...calculated, calculationVersion: 'wrong' };
    if (kind === 'units')
      changed = { ...calculated, signals: [{ ...first, unit: 'hours' }, ...signals.slice(1)] };
    if (kind === 'status')
      changed = {
        ...calculated,
        signals: [{ ...first, status: 'provisional', value: 0 }, ...signals.slice(1)],
      };
    if (kind === 'sample')
      changed = {
        ...calculated,
        signals: [
          { ...first, sampleCount: 1001, status: 'provisional', value: 1001 },
          ...signals.slice(1),
        ],
      };
    if (kind === 'context')
      changed = { ...calculated, reviewContext: { ...calculated.reviewContext, reviewed: 1 } };
    if (kind === 'traversal')
      changed = {
        ...calculated,
        signals: [
          { ...first, sampleCount: 1, status: 'provisional', value: 1 },
          ...signals.slice(1),
        ],
        reviewContext: { ...calculated.reviewContext, unknownTraversal: 1 },
      };
    expect(() =>
      resultFrom({ ...stored, result: { ...stored.result, calculated: changed } }),
    ).toThrowError(expect.objectContaining({ status: 500, message: 'invalid_stored_data' }));
  },
);

it('rejects stored run window ending after queue stamp as redacted 500', () => {
  expect(() =>
    runFrom({
      id,
      context,
      state: 'queued',
      queued_at: '2026-01-02T23:59:59.999999Z',
      completed_at: null,
      reason: null,
      result_id: null,
    }),
  ).toThrowError(expect.objectContaining({ status: 500, message: 'invalid_stored_data' }));
  expect(
    runFrom({
      id,
      context,
      state: 'queued',
      queued_at: context.windowEnd,
      completed_at: null,
      reason: null,
      result_id: null,
    }).queuedAt,
  ).toBe(context.windowEnd);
});

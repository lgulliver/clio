import { expect, expectTypeOf, it } from 'vitest';
import { parsePullCheckpoint } from '../../../../../packages/adapters/src/github-pulls-checkpoint.ts';
import type { PullCheckpoint } from '../../../../../packages/adapters/src/github-pulls-contract.ts';
import { calculateSignals } from '../../../../api/src/features/space-github/calculate.ts';
import type * as Server from '../../../../api/src/features/space-github/contract.ts';
import type { OperationResult } from '../../../../api/src/features/space-github/contract.ts';
import type * as Browser from './api';
import { parseOperationResult } from './api';

const ids = {
  workspaceId: '00000000-0000-0000-0000-000000000001',
  mappingId: '00000000-0000-0000-0000-000000000002',
  teamId: '00000000-0000-0000-0000-000000000003',
  resultId: '00000000-0000-0000-0000-000000000004',
  runId: '00000000-0000-0000-0000-000000000005',
};
function fixture(): OperationResult {
  const window = { windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-15T00:00:00.000Z' };
  const checkpoint: PullCheckpoint = {
    version: 1,
    phase: 'ready',
    repositoryId: 123,
    repositoryOwner: 'owner',
    repositoryName: 'repo',
    nextPullPage: null,
    nextReviewIndex: 3,
    nextReviewPage: 1,
    discoveryTraversalComplete: true,
    reviewTraversalComplete: [1, 2, 3],
    gaps: ['invalid_time'],
    pulls: [1, 2, 3].map((id) => ({
      id,
      number: id,
      createdAt: '2026-09-02T09:00:00.000Z',
      mergedAt: '2026-09-02T14:00:00.000Z',
      authorClass: 'human',
      observedAt: '2026-09-16T00:00:00.000Z',
    })),
    reviews: [1, 2, 3].map((id) => ({
      id,
      pullId: id,
      submittedAt: '2026-09-02T10:00:00.000Z',
      state: 'APPROVED',
      authorClass: 'human',
      reviewerClass: 'human',
      actorEligibilityKnown: true,
      isSelfReview: false,
      observedAt: '2026-09-16T00:00:00.000Z',
    })),
  };
  return {
    id: ids.resultId,
    runId: ids.runId,
    workspaceId: ids.workspaceId,
    mappingId: ids.mappingId,
    mappingRevision: 1,
    appId: 12,
    installationId: 34,
    repositoryId: 123,
    repositoryLabel: 'owner/repo',
    teamId: ids.teamId,
    teamName: 'Original team',
    ...window,
    acquisitionStartedAt: '2026-09-16T00:00:00.000Z',
    acquisitionEndedAt: '2026-09-16T00:01:00.000Z',
    completedAt: '2026-09-16T00:02:00.000Z',
    contractVersion: 'clio.space.github.v1',
    calculated: calculateSignals(
      parsePullCheckpoint(
        JSON.parse(
          JSON.stringify({ ...checkpoint, pulls: [...checkpoint.pulls].reverse() }).replaceAll(
            '.000Z',
            'Z',
          ),
        ),
      ),
      window,
    ),
    discoveryTraversalComplete: true,
    reviewTraversalComplete: true,
    gaps: checkpoint.gaps,
  };
}

it('actual server calculation serializes into strict browser result', () => {
  const server = fixture();
  const serialized: unknown = JSON.parse(JSON.stringify({ result: server }));
  const parsed = parseOperationResult(serialized, ids);
  expect(parsed.calculated.signals.map((s) => s.value)).toEqual([3, 3, 3, 1, 5]);
  expect(parsed).toEqual(server);
});
it('rejects mutated calculation version/status/frozen context after serialization', () => {
  const r = fixture();
  for (const result of [
    { ...r, teamId: '00000000-0000-0000-0000-000000000099' },
    { ...r, appId: 99 },
    { ...r, calculated: { ...r.calculated, calculationVersion: 'oems.v1' } },
    {
      ...r,
      calculated: {
        ...r.calculated,
        signals: r.calculated.signals.map((s) => ({ ...s, status: 'complete' })),
      },
    },
  ]) {
    const serialized: unknown = JSON.parse(JSON.stringify({ result }));
    expect(() => parseOperationResult(serialized, { ...ids, appId: 12 })).toThrow();
  }
});

it('keeps safe server and browser types assignable in both directions', () => {
  expectTypeOf<Server.OperationResult>().toExtend<Browser.OperationResult>();
  expectTypeOf<Browser.OperationResult>().toExtend<Server.OperationResult>();
  expectTypeOf<Server.OperationRun>().toExtend<Browser.OperationRun>();
  expectTypeOf<Browser.OperationRun>().toExtend<Server.OperationRun>();
  expectTypeOf<Server.OperationMapping>().toExtend<Browser.OperationMapping>();
  expectTypeOf<Browser.OperationMapping>().toExtend<Server.OperationMapping>();
  expectTypeOf<Server.OperationAvailability>().toExtend<Browser.OperationAvailability>();
  expectTypeOf<Browser.OperationAvailability>().toExtend<Server.OperationAvailability>();
  expectTypeOf<Server.OperationMappingPage>().toExtend<Browser.OperationMappingPage>();
  expectTypeOf<Browser.OperationMappingPage>().toExtend<Server.OperationMappingPage>();
  expectTypeOf<Server.OperationRunPage>().toExtend<Browser.OperationRunPage>();
  expectTypeOf<Browser.OperationRunPage>().toExtend<Server.OperationRunPage>();
  expectTypeOf<Server.OperationResultPage>().toExtend<Browser.OperationResultPage>();
  expectTypeOf<Browser.OperationResultPage>().toExtend<Server.OperationResultPage>();
});

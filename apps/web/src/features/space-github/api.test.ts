import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PullCheckpoint } from '../../../../../packages/adapters/src/github-pulls-contract.ts';
import { calculateSignals } from '../../../../api/src/features/space-github/calculate.ts';
import type { OperationResult } from '../../../../api/src/features/space-github/contract.ts';
import { apiOrigin } from '../identity/api';
import {
  collectOperation,
  disconnectOperation,
  getOperationResults,
  parseOperationAvailability,
  parseOperationMappingPage,
  parseOperationResult,
  parseOperationResultPage,
  parseOperationRun,
  saveOperationMapping,
  updateOperationMapping,
} from './api';

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
    calculated: calculateSignals(checkpoint, window),
    discoveryTraversalComplete: true,
    reviewTraversalComplete: true,
    gaps: checkpoint.gaps,
  };
}

afterEach(() => vi.unstubAllGlobals());
describe('safe operational boundary', () => {
  it('keeps original ownership and invalid-time qualification', () => {
    const r = fixture();
    expect(
      parseOperationResult(
        { result: r },
        { workspaceId: ids.workspaceId, mappingId: ids.mappingId },
      ),
    ).toEqual(r);
  });
  it.each(['contractVersion', 'mappingId', 'workspaceId', 'windowStart', 'acquisitionEndedAt'])(
    'rejects malformed %s',
    (key) => {
      expect(() =>
        parseOperationResult({ result: { ...fixture(), [key]: 'wrong' } }, ids),
      ).toThrow();
    },
  );
  it.each([
    { status: 'no_observations', value: 0 },
    { status: 'provisional', value: -1 },
    { unit: 'count' },
    { sampleCount: 2 },
    { status: 'complete' },
  ])('rejects malformed duration %j', (change) => {
    const r = fixture();
    expect(() =>
      parseOperationResult(
        {
          result: {
            ...r,
            calculated: {
              ...r.calculated,
              signals: r.calculated.signals.map((s, i) => (i === 3 ? { ...s, ...change } : s)),
            },
          },
        },
        ids,
      ),
    ).toThrow();
  });
  it('rejects duplicate/missing signals and provider fields', () => {
    const r = fixture();
    for (const signals of [
      r.calculated.signals.slice(1),
      r.calculated.signals.map(() => r.calculated.signals[0]),
    ])
      expect(() =>
        parseOperationResult({ result: { ...r, calculated: { ...r.calculated, signals } } }, ids),
      ).toThrow();
    expect(() => parseOperationResult({ result: { ...r, checkpoint: {} } }, ids)).toThrow();
  });
  it('validates canonical calendar dates and microsecond order', () => {
    for (const completedAt of ['2026-02-30T00:00:00.000Z', '2026-09-16T00:01:00.000001Z']) {
      const acquisitionEndedAt = '2026-09-16T00:01:00.000002Z';
      expect(() =>
        parseOperationResult({ result: { ...fixture(), acquisitionEndedAt, completedAt } }, ids),
      ).toThrow();
    }
  });
  it('bounds and binds historical result pages', () => {
    const r = fixture();
    const page = {
      workspaceId: ids.workspaceId,
      mappingId: ids.mappingId,
      teamId: ids.teamId,
      results: [r],
      nextCursor: null,
    };
    expect(parseOperationResultPage(page, ids).results).toEqual([r]);
    for (const bad of [
      { ...page, teamId: null },
      { ...page, results: [r, r] },
      { ...page, nextCursor: 'cursor' },
      { ...page, results: Array(26).fill(r) },
    ])
      expect(() => parseOperationResultPage(bad, ids)).toThrow();
  });
  it('does not demand current owner match historical mapping listings', () => {
    const r = fixture();
    const mapping = {
      id: r.mappingId,
      workspaceId: r.workspaceId,
      teamId: '00000000-0000-0000-0000-000000000099',
      teamName: 'Current owner',
      appId: r.appId,
      installationId: r.installationId,
      repositoryId: r.repositoryId,
      repositoryLabel: r.repositoryLabel,
      revision: 2,
      connected: true,
    };
    expect(
      parseOperationMappingPage(
        { workspaceId: r.workspaceId, teamId: r.teamId, mappings: [mapping], nextCursor: null },
        ids,
      ).mappings[0]?.teamName,
    ).toBe('Current owner');
  });
  it('member availability excludes owner grants', () => {
    expect(
      parseOperationAvailability(
        { workspaceId: ids.workspaceId, enabled: true },
        { workspaceId: ids.workspaceId, role: 'member' },
      ),
    ).toEqual({ workspaceId: ids.workspaceId, enabled: true });
    expect(() =>
      parseOperationAvailability(
        { workspaceId: ids.workspaceId, enabled: true, grants: [] },
        { workspaceId: ids.workspaceId, role: 'member' },
      ),
    ).toThrow();
    expect(
      parseOperationAvailability(
        { workspaceId: ids.workspaceId, enabled: false, grants: [] },
        { workspaceId: ids.workspaceId, role: 'owner' },
      ),
    ).toHaveProperty('grants', []);
  });
  it('enforces terminal run consistency', () => {
    const r = fixture();
    const {
      id: _id,
      runId: _runId,
      acquisitionStartedAt: _s,
      acquisitionEndedAt: _e,
      completedAt: _c,
      calculated: _calc,
      contractVersion: _v,
      gaps: _g,
      discoveryTraversalComplete: _d,
      reviewTraversalComplete: _rv,
      ...ctx
    } = r;
    const run = {
      ...ctx,
      id: ids.runId,
      state: 'queued',
      queuedAt: '2026-09-16T00:00:00.000Z',
      completedAt: null,
      resultId: null,
      reason: null,
    };
    expect(parseOperationRun({ run }, ids).state).toBe('queued');
    expect(() => parseOperationRun({ run: { ...run, state: 'succeeded' } }, ids)).toThrow();
    expect(() =>
      parseOperationRun(
        {
          run: {
            ...run,
            state: 'cancelled',
            completedAt: r.completedAt,
            reason: 'provider_unavailable',
          },
        },
        ids,
      ),
    ).toThrow();
  });
  it('uses credentialed no-store scoped history transport', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        workspaceId: ids.workspaceId,
        mappingId: ids.mappingId,
        teamId: ids.teamId,
        results: [fixture()],
        nextCursor: null,
      }),
    });
    vi.stubGlobal('fetch', fetch);
    await getOperationResults(ids);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/mappings/${ids.mappingId}/results?teamId=${ids.teamId}`),
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
  });
});

it('rejects cursor replay and missing filter envelope', () => {
  const r = fixture();
  const scope = {
    workspaceId: ids.workspaceId,
    mappingId: ids.mappingId,
    teamId: ids.teamId,
    cursor: 'same_cursor',
  };
  const page = {
    workspaceId: ids.workspaceId,
    mappingId: ids.mappingId,
    teamId: ids.teamId,
    results: Array.from({ length: 25 }, (_, i) => ({
      ...r,
      id: `00000000-0000-0000-0000-${String(i + 100).padStart(12, '0')}`,
    })),
    nextCursor: 'same_cursor',
  };
  expect(
    parseOperationResultPage({ ...page, nextCursor: 'new_cursor' }, scope).results,
  ).toHaveLength(25);
  expect(() => parseOperationResultPage(page, scope)).toThrow();
  expect(() =>
    parseOperationResultPage(
      { ...page, nextCursor: null, mappingId: '00000000-0000-0000-0000-000000000099' },
      scope,
    ),
  ).toThrow();
});
it('validates owner grant inventory without remote repository labels', () => {
  const grant = {
    appId: 12,
    installationId: 34,
    accountId: 56,
    accountType: 'Organization',
    repositoryIds: [1, 2],
  };
  const scope = { workspaceId: ids.workspaceId, role: 'owner' as const };
  expect(
    parseOperationAvailability(
      { workspaceId: ids.workspaceId, enabled: true, grants: [grant] },
      scope,
    ),
  ).toHaveProperty('grants', [grant]);
  expect(() =>
    parseOperationAvailability(
      {
        workspaceId: ids.workspaceId,
        enabled: true,
        grants: [{ ...grant, repositoryIds: [1, 1] }],
      },
      scope,
    ),
  ).toThrow();
  expect(() =>
    parseOperationAvailability(
      {
        workspaceId: ids.workspaceId,
        enabled: true,
        grants: [{ ...grant, repositoryLabel: 'secret/repo' }],
      },
      scope,
    ),
  ).toThrow();
});

it('rejects contradictory traversal qualification and accepts partial metadata without forced gaps', () => {
  const r = fixture();
  expect(() =>
    parseOperationResult({ result: { ...r, gaps: ['discovery_limit'] } }, ids),
  ).toThrow();
  const unknown = {
    ...r,
    calculated: {
      ...r.calculated,
      signals: r.calculated.signals.map((s) =>
        s.id === 'open_to_first_review'
          ? { ...s, status: 'insufficient_samples', value: null, sampleCount: 2 }
          : s,
      ),
      reviewContext: { ...r.calculated.reviewContext, reviewed: 2, unknownTraversal: 1 },
    },
  };
  expect(() => parseOperationResult({ result: unknown }, ids)).toThrow();
  expect(
    parseOperationResult(
      {
        result: {
          ...unknown,
          reviewTraversalComplete: false,
          discoveryTraversalComplete: false,
          gaps: [],
        },
      },
      ids,
    ),
  ).toHaveProperty('reviewTraversalComplete', false);
});
function mappingFixture() {
  const r = fixture();
  return {
    id: r.mappingId,
    workspaceId: r.workspaceId,
    teamId: r.teamId,
    teamName: r.teamName,
    appId: r.appId,
    installationId: r.installationId,
    repositoryId: r.repositoryId,
    repositoryLabel: r.repositoryLabel,
    revision: 1,
    connected: true,
  };
}
function runFixture() {
  const r = fixture();
  return {
    id: r.runId,
    workspaceId: r.workspaceId,
    mappingId: r.mappingId,
    mappingRevision: r.mappingRevision,
    teamId: r.teamId,
    teamName: r.teamName,
    appId: r.appId,
    installationId: r.installationId,
    repositoryId: r.repositoryId,
    repositoryLabel: r.repositoryLabel,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    state: 'queued',
    queuedAt: r.acquisitionStartedAt,
    completedAt: null,
    resultId: null,
    reason: null,
  };
}
function responseFetch(value: unknown) {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => value });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
it('sends approved create/enqueue/disconnect/update methods paths and exact bodies', async () => {
  const m = mappingFixture(),
    r = runFixture();
  const create = {
    teamId: m.teamId,
    installationId: m.installationId,
    repositoryId: m.repositoryId,
  };
  const enqueue = {
    revision: 1,
    requestId: '00000000-0000-0000-0000-000000000099',
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
  };
  let fetch = responseFetch({ mapping: m });
  await saveOperationMapping(ids.workspaceId, create);
  expect(fetch).toHaveBeenCalledWith(
    `${apiOrigin(import.meta.env.VITE_API_URL)}/api/workspaces/${ids.workspaceId}/space/github/mappings`,
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(create),
      credentials: 'include',
      cache: 'no-store',
    }),
  );
  fetch = responseFetch({ run: r });
  await collectOperation(ids, enqueue);
  expect(fetch).toHaveBeenCalledWith(
    `${apiOrigin(import.meta.env.VITE_API_URL)}/api/workspaces/${ids.workspaceId}/space/github/mappings/${ids.mappingId}/runs`,
    expect.objectContaining({ method: 'POST', body: JSON.stringify(enqueue) }),
  );
  fetch = responseFetch({ mapping: { ...m, connected: false } });
  await disconnectOperation(ids, { revision: 1 });
  expect(fetch).toHaveBeenCalledWith(
    `${apiOrigin(import.meta.env.VITE_API_URL)}/api/workspaces/${ids.workspaceId}/space/github/mappings/${ids.mappingId}/disconnect`,
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ revision: 1 }) }),
  );
  const update = { revision: 1, teamId: '00000000-0000-0000-0000-000000000099' };
  fetch = responseFetch({ mapping: { ...m, teamId: update.teamId, revision: 2 } });
  await updateOperationMapping(ids, update);
  expect(fetch).toHaveBeenCalledWith(
    `${apiOrigin(import.meta.env.VITE_API_URL)}/api/workspaces/${ids.workspaceId}/space/github/mappings/${ids.mappingId}`,
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify(update) }),
  );
});
it('rejects create response team/install/repository/connection mismatches', async () => {
  const m = mappingFixture();
  const create = {
    teamId: m.teamId,
    installationId: m.installationId,
    repositoryId: m.repositoryId,
  };
  for (const change of [
    { teamId: '00000000-0000-0000-0000-000000000099' },
    { installationId: 99 },
    { repositoryId: 99 },
    { connected: false },
  ]) {
    responseFetch({ mapping: { ...m, ...change } });
    await expect(saveOperationMapping(ids.workspaceId, create)).rejects.toThrow();
  }
});
it('rejects stale enqueue revision/window and inconsistent disconnect/update responses', async () => {
  const m = mappingFixture(),
    r = runFixture();
  const enqueue = {
    revision: 1,
    requestId: '00000000-0000-0000-0000-000000000099',
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
  };
  for (const change of [
    { mappingRevision: 2 },
    { windowStart: '2026-09-02T00:00:00.000Z' },
    { windowEnd: '2026-09-14T00:00:00.000Z' },
  ]) {
    responseFetch({ run: { ...r, ...change } });
    await expect(collectOperation(ids, enqueue)).rejects.toThrow();
  }
  responseFetch({ mapping: m });
  await expect(disconnectOperation(ids, { revision: 1 })).rejects.toThrow();
  responseFetch({ mapping: m });
  await expect(
    updateOperationMapping(ids, { revision: 1, teamId: '00000000-0000-0000-0000-000000000099' }),
  ).rejects.toThrow();
});

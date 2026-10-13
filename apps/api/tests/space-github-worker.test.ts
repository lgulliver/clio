import { performance } from 'node:perf_hooks';
import {
  AdapterError,
  type PullCheckpoint,
  PullSliceError,
  PullSliceRateLimitError,
} from '@clio/adapters';
import { Pool } from 'pg';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spaceConfig } from '../src/features/space-github/config.ts';
import type { createSpaceGitHubJobs } from '../src/features/space-github/jobs.ts';
import type { SpaceGitHubProvider } from '../src/features/space-github/provider.ts';
import { processOneSpaceGitHub } from '../src/features/space-github/worker.ts';

const state = vi.hoisted(() => ({
  claim: vi.fn(),
  preflight: vi.fn(),
  finish: vi.fn<ReturnType<typeof createSpaceGitHubJobs>['finish']>(),
  quota: vi.fn(),
  delay: vi.fn(),
}));
vi.mock('../src/features/space-github/jobs.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/space-github/jobs.ts')>()),
  createSpaceGitHubJobs: () => ({
    claim: state.claim,
    preflight: state.preflight,
    finish: state.finish,
  }),
}));
vi.mock('../src/features/github-collection/quota.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/github-collection/quota.ts')>()),
  acquireQuota: state.quota,
  releaseQuota: vi.fn(async () => {}),
  quotaRetryDelay: state.delay,
}));
const pool = new Pool();
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
const checkpoint: PullCheckpoint = {
  version: 1,
  phase: 'discovery',
  repositoryId: 20,
  repositoryOwner: 'fixture',
  repositoryName: 'repo',
  nextPullPage: 2,
  nextReviewIndex: 0,
  nextReviewPage: 1,
  pulls: [
    {
      id: 101,
      number: 1,
      createdAt: '2026-01-01T00:00:00Z',
      mergedAt: null,
      authorClass: 'human',
      observedAt: '2026-01-04T00:00:00Z',
    },
  ],
  reviews: [],
  reviewTraversalComplete: [],
  discoveryTraversalComplete: false,
  gaps: [],
};
const config = spaceConfig({
  appId: 12,
  privateKey: 'fixture',
  grants: [
    {
      workspaceId: id,
      installationId: 10,
      accountId: 30,
      accountType: 'Organization',
      repositoryIds: [20],
      fingerprint: 'f'.repeat(64),
    },
  ],
});
const claim = {
  id,
  workspaceId: id,
  mappingId: id,
  token: id,
  claimedAt: '2026-01-04T00:00:00.000123Z',
};
const provider: SpaceGitHubProvider = {
  verify: async () => ({
    accountLogin: 'fixture',
    repositoryName: 'repo',
    token: 'fixture',
    expiresAt: '2026-01-04T01:00:00Z',
  }),
  collect: async () => ({
    checkpoint: { ...checkpoint, phase: 'ready', nextPullPage: null, gaps: ['active_time_limit'] },
    done: true,
    requests: 0,
    activeMillis: 0,
  }),
};
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  state.claim.mockResolvedValue(claim);
  state.preflight.mockResolvedValue({ context, checkpoint, active_millis: 0 });
  state.finish.mockResolvedValue(true);
  state.quota.mockResolvedValue({ appId: 12, installationId: 10, token: id });
  state.delay.mockResolvedValue(60);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it('retains accepted facts when final pacing/transport yield spends total active budget', async () => {
  state.preflight.mockResolvedValue({ context, checkpoint, active_millis: 1799990 });
  await processOneSpaceGitHub(pool, config, {
    provider: {
      ...provider,
      collect: async () => {
        vi.mocked(performance.now).mockReturnValue(20);
        throw new PullSliceError('transport_failed', checkpoint);
      },
    },
  });
  expect(state.finish).toHaveBeenLastCalledWith(
    claim,
    expect.objectContaining({
      done: true,
      checkpoint: expect.objectContaining({
        phase: 'ready',
        pulls: checkpoint.pulls,
        discoveryTraversalComplete: false,
        gaps: ['active_time_limit'],
      }),
    }),
  );
});
it('retries infrastructure failure before preflight instead of calling provider data invalid', async () => {
  state.preflight.mockRejectedValueOnce(new Error('private database detail'));
  await processOneSpaceGitHub(pool, config, { provider });
  expect(state.finish).toHaveBeenLastCalledWith(
    claim,
    expect.objectContaining({ retryable: true }),
  );
  expect(state.finish.mock.calls[0]?.[1].failure).toBeUndefined();
});
it.each(['github_http_401', 'github_http_403', 'github_http_404', 'token_http_401'])(
  'redacts remote authorization failure %s as unavailable',
  async (code) => {
    await processOneSpaceGitHub(pool, config, {
      provider: {
        ...provider,
        verify: async () => {
          throw new AdapterError(code);
        },
      },
    });
    expect(state.finish).toHaveBeenLastCalledWith(
      claim,
      expect.objectContaining({ failure: 'provider_unavailable' }),
    );
  },
);
it('quota-delay database failure still records retry and accepted checkpoint', async () => {
  state.delay.mockRejectedValueOnce(new Error('private database detail'));
  await processOneSpaceGitHub(pool, config, {
    provider: {
      ...provider,
      collect: async () => {
        throw new PullSliceRateLimitError(60, checkpoint);
      },
    },
  });
  expect(state.finish).toHaveBeenLastCalledWith(
    claim,
    expect.objectContaining({ checkpoint, retryable: true }),
  );
});
it('provider clock derives from database claim stamp despite local future or behind wall clocks', async () => {
  for (const skew of [new Date('2040-01-01T00:00:00Z'), new Date('1990-01-01T00:00:00Z')]) {
    vi.spyOn(Date, 'now').mockReturnValue(skew.getTime());
    let observed: Date | undefined;
    await processOneSpaceGitHub(pool, config, {
      provider: {
        ...provider,
        verify: async (input) => {
          observed = input.clock();
          return provider.verify(input);
        },
      },
    });
    expect(observed?.toISOString()).toBe('2026-01-04T00:00:00.000Z');
  }
});
it('malformed provider carrier becomes redacted invalid data instead of escaping finish', async () => {
  const error = new PullSliceError('transport_failed', checkpoint);
  Object.defineProperty(error, 'checkpoint', { value: { ...checkpoint, version: 2 } });
  await processOneSpaceGitHub(pool, config, {
    provider: {
      ...provider,
      collect: async () => {
        throw error;
      },
    },
  });
  expect(state.finish).toHaveBeenLastCalledWith(
    claim,
    expect.objectContaining({ failure: 'invalid_provider_data' }),
  );
});

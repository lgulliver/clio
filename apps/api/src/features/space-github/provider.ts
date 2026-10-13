import {
  collectGitHubPullSlice,
  createBoundedGitHubTransport,
  type FetchTransport,
  type PullSliceInput,
  verifyGitHubPullScope,
} from '@clio/adapters';
import type { Pool } from 'pg';
import type { GitHubGrant } from '../github-collection/config.ts';
import {
  acquireQuota,
  observeQuota,
  paceQuota,
  type QuotaLease,
  releaseQuota,
} from '../github-collection/quota.ts';
import type { SpaceGitHubConfig } from './config.ts';
export interface SpaceGitHubProvider {
  verify(input: {
    config: SpaceGitHubConfig;
    grant: GitHubGrant;
    repositoryId: number;
    clock: () => Date;
    signal: AbortSignal;
    fetch?: FetchTransport;
  }): ReturnType<typeof verifyGitHubPullScope>;
  collect(input: PullSliceInput): ReturnType<typeof collectGitHubPullSlice>;
}
export class SliceYield extends Error {
  constructor() {
    super('SPACE GitHub slice yielded');
  }
}
export interface SliceBudget {
  requests: number;
  deadline: Date;
  yielded: boolean;
  fetch: FetchTransport;
}
/** One counter/deadline covers scope verification, collection and author re-fetches. */
export function createSliceTransport(
  pool: Pool,
  lease: QuotaLease,
  signal: AbortSignal,
  deadline: Date,
  clock: () => Date = () => new Date(),
  network: FetchTransport = globalThis.fetch,
): SliceBudget {
  const bounded = createBoundedGitHubTransport({
    fetch: network,
    timeoutMs: 10000,
    maxBytes: 2000000,
  });
  const budget: SliceBudget = {
    requests: 0,
    deadline,
    yielded: false,
    fetch: async (url, init) => {
      function check() {
        if (budget.requests >= 40 || clock().getTime() >= deadline.getTime() || signal.aborted) {
          budget.yielded = true;
          throw new SliceYield();
        }
      }
      check();
      await paceQuota(pool, lease, signal);
      check();
      budget.requests++;
      const response = await bounded(url, { ...init, signal });
      await observeQuota(pool, lease, response, new URL(url).pathname.startsWith('/app/'));
      return response;
    },
  };
  return budget;
}
export function createSpaceGitHubProvider(pool: Pool): SpaceGitHubProvider {
  return {
    async verify(input) {
      const operation = (fetch: FetchTransport) =>
        verifyGitHubPullScope({
          appId: String(input.config.appId),
          privateKey: input.config.privateKey,
          installationId: input.grant.installationId,
          accountId: input.grant.accountId,
          accountType: input.grant.accountType,
          repositoryId: input.repositoryId,
          clock: input.clock,
          signal: input.signal,
          fetch,
        });
      if (input.fetch) return operation(input.fetch);
      const lease = await acquireQuota(pool, input.config.appId, input.grant.installationId);
      try {
        return await operation(
          createSliceTransport(
            pool,
            lease,
            input.signal,
            new Date(input.clock().getTime() + 60000),
            input.clock,
          ).fetch,
        );
      } finally {
        await releaseQuota(pool, lease);
      }
    },
    collect: collectGitHubPullSlice,
  };
}

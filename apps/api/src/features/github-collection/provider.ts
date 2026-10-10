import {
  collectGitHubDeployments,
  createBoundedGitHubTransport,
  type FetchTransport,
  verifyGitHubScope,
} from '@clio/adapters';
import type { Pool } from 'pg';
import type { GitHubConfig, GitHubGrant } from './config.ts';
import { maxStoredBytes } from './history.ts';
import {
  acquireQuota,
  observeQuota,
  paceQuota,
  type QuotaLease,
  QuotaUnavailable,
  releaseQuota,
} from './quota.ts';

export interface Scope {
  accountLogin: string;
  repositoryName: string;
  token: string;
  expiresAt: string;
}
export interface GitHubProvider {
  quotaContention?(): boolean;
  verify(input: {
    config: GitHubConfig;
    grant: GitHubGrant;
    repositoryId: number;
    clock: () => Date;
    signal: AbortSignal;
    fetch?: FetchTransport;
  }): Promise<Scope>;
  collect(input: {
    installationId: number;
    repositoryId: number;
    token: string;
    clock: () => Date;
    signal: AbortSignal;
    fetch?: FetchTransport;
    incremental?: NonNullable<Parameters<typeof collectGitHubDeployments>[0]['incremental']>;
  }): ReturnType<typeof collectGitHubDeployments>;
}
function transport(
  observe?: (response: Response, url: string) => Promise<void>,
  check?: (signal?: AbortSignal | null) => Promise<void>,
): FetchTransport {
  const bounded = createBoundedGitHubTransport({
    fetch: globalThis.fetch,
    timeoutMs: 10000,
    maxBytes: 1048576,
  });
  let total = 0;
  return async (url, init) => {
    await check?.(init.signal);
    const response = await bounded(url, init);
    await observe?.(response, url);
    // Bounded helper has already drained the network body; enforce whole traversal budget.
    const bytes = await response.arrayBuffer();
    total += bytes.byteLength;
    if (total > maxStoredBytes) throw new Error('Collection byte limit');
    return new Response(response.body === null ? null : bytes, {
      status: response.status,
      headers: response.headers,
    });
  };
}
export const githubProvider: GitHubProvider = {
  verify: ({ config, grant, repositoryId, clock, signal, fetch }) =>
    verifyGitHubScope({
      appId: String(config.appId),
      privateKey: config.privateKey,
      installationId: grant.installationId,
      accountId: grant.accountId,
      accountType: grant.accountType,
      repositoryId,
      clock,
      fetch: fetch ?? transport(),
      signal,
    }),
  collect: ({ installationId, fetch, ...input }) =>
    collectGitHubDeployments({
      ...input,
      instance: String(installationId),
      fetch: fetch ?? transport(),
      maxPages: 100,
      maxRecords: 5000,
    }),
};

/** Production network paths share durable budgets; injected providers remain test seams. */
export function createGitHubProvider(
  pool: Pool,
  config: GitHubConfig | null,
  held?: QuotaLease,
): GitHubProvider {
  let blocked = false;
  async function guarded<T>(
    appId: number,
    installationId: number,
    operation: (fetch: FetchTransport) => Promise<T>,
  ) {
    const lease = held ?? (await acquireQuota(pool, appId, installationId));
    try {
      if (lease.appId !== appId || lease.installationId !== installationId)
        throw new Error('Invalid quota scope');
      return await operation(
        transport(
          (response, url) =>
            observeQuota(pool, lease, response, new URL(url).pathname.startsWith('/app/')),
          async (signal) => {
            try {
              await paceQuota(pool, lease, signal);
            } catch (error) {
              if (error instanceof QuotaUnavailable) blocked = true;
              throw error;
            }
          },
        ),
      );
    } finally {
      if (!held) await releaseQuota(pool, lease);
    }
  }
  return {
    quotaContention: () => blocked,
    verify: (input) =>
      guarded(input.config.appId, input.grant.installationId, (fetch) =>
        githubProvider.verify({ ...input, fetch }),
      ),
    collect: (input) => {
      if (!config) throw new Error('GitHub configuration unavailable');
      return guarded(config.appId, input.installationId, (fetch) =>
        githubProvider.collect({ ...input, fetch }),
      );
    },
  };
}

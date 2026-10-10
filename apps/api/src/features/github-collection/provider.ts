import {
  collectGitHubDeployments,
  createBoundedGitHubTransport,
  type FetchTransport,
  verifyGitHubScope,
} from '@clio/adapters';
import type { GitHubConfig, GitHubGrant } from './config.ts';
import { maxStoredBytes } from './history.ts';

export interface Scope {
  accountLogin: string;
  repositoryName: string;
  token: string;
  expiresAt: string;
}
export interface GitHubProvider {
  verify(input: {
    config: GitHubConfig;
    grant: GitHubGrant;
    repositoryId: number;
    clock: () => Date;
    signal: AbortSignal;
  }): Promise<Scope>;
  collect(input: {
    installationId: number;
    repositoryId: number;
    token: string;
    clock: () => Date;
    signal: AbortSignal;
  }): ReturnType<typeof collectGitHubDeployments>;
}
function transport(): FetchTransport {
  const bounded = createBoundedGitHubTransport({
    fetch: globalThis.fetch,
    timeoutMs: 10000,
    maxBytes: 1048576,
  });
  let total = 0;
  return async (url, init) => {
    const response = await bounded(url, init);
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
  verify: ({ config, grant, repositoryId, clock, signal }) =>
    verifyGitHubScope({
      appId: String(config.appId),
      privateKey: config.privateKey,
      installationId: grant.installationId,
      accountId: grant.accountId,
      accountType: grant.accountType,
      repositoryId,
      clock,
      fetch: transport(),
      signal,
    }),
  collect: ({ installationId, ...input }) =>
    collectGitHubDeployments({
      ...input,
      instance: String(installationId),
      fetch: transport(),
      maxPages: 100,
      maxRecords: 5000,
    }),
};

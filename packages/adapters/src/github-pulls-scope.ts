import { type FetchTransport, githubApiVersion, signGitHubAppJwt } from './github-app.ts';
import { repositorySegment } from './github-pulls-checkpoint.ts';
import { GitHubRateLimitError, githubRateLimit } from './github-rate-limit.ts';
import { createBoundedGitHubTransport } from './github-transport.ts';
import { AdapterError, instant, object, positiveId, string, timestamp } from './value.ts';

function permissions(value: unknown): void {
  const row = object(value);
  if (Object.keys(row).length !== 2 || row.pull_requests !== 'read' || row.metadata !== 'read')
    throw new AdapterError('github_permissions_mismatch');
}

/** Operator grant and Clio owner authorization remain caller preconditions. */
export async function verifyGitHubPullScope(input: {
  appId: string;
  privateKey: string;
  installationId: number;
  accountId: number;
  accountType: 'User' | 'Organization';
  repositoryId: number;
  clock: () => Date;
  fetch: FetchTransport;
  signal?: AbortSignal;
}): Promise<
  Readonly<{ accountLogin: string; repositoryName: string; token: string; expiresAt: string }>
> {
  positiveId(input.installationId);
  positiveId(input.accountId);
  positiveId(input.repositoryId);
  if (!/^[1-9]\d*$/.test(input.appId) || !Number.isSafeInteger(Number(input.appId)))
    throw new AdapterError('invalid_app_id');
  if (input.accountType !== 'User' && input.accountType !== 'Organization')
    throw new AdapterError('invalid_account_type');
  const jwt = signGitHubAppJwt(input);
  let wrapperQuota: GitHubRateLimitError | undefined;
  const fetch = createBoundedGitHubTransport({
    fetch: async (url, init) => {
      try {
        return await input.fetch(url, init);
      } catch (error) {
        if (error instanceof GitHubRateLimitError)
          wrapperQuota = new GitHubRateLimitError(error.retryAfterSeconds);
        throw error;
      }
    },
  });
  async function request(path: string, token: string, body?: object): Promise<unknown> {
    wrapperQuota = undefined;
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: input.signal ?? null,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': githubApiVersion,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (wrapperQuota) throw wrapperQuota;
      throw error;
    }
    if (!response.ok) {
      const limit = await githubRateLimit(response, input.clock);
      if (limit.limited) throw new GitHubRateLimitError(limit.retryAfterSeconds);
      throw new AdapterError(`github_http_${response.status}`);
    }
    if (path.startsWith('/installation/repositories?') && response.headers.get('link'))
      throw new AdapterError('github_repository_scope_mismatch');
    try {
      return await response.json();
    } catch {
      throw new AdapterError('invalid_github_json');
    }
  }
  const installation = object(await request(`/app/installations/${input.installationId}`, jwt));
  const account = object(installation.account);
  if (
    positiveId(installation.id) !== input.installationId ||
    positiveId(installation.app_id) !== Number(input.appId) ||
    positiveId(account.id) !== input.accountId ||
    account.type !== input.accountType ||
    installation.suspended_at !== null ||
    installation.suspended_by !== null ||
    installation.repository_selection !== 'selected'
  )
    throw new AdapterError('github_installation_mismatch');
  permissions(installation.permissions);
  const accountLogin = repositorySegment(account.login);
  const issued = object(
    await request(`/app/installations/${input.installationId}/access_tokens`, jwt, {
      repository_ids: [input.repositoryId],
      permissions: { pull_requests: 'read', metadata: 'read' },
    }),
  );
  permissions(issued.permissions);
  if (issued.repository_selection !== 'selected')
    throw new AdapterError('github_repository_scope_mismatch');
  const token = string(issued.token);
  const expiresAt = timestamp(issued.expires_at);
  const now = input.clock().getTime();
  if (!Number.isSafeInteger(now)) throw new AdapterError('invalid_clock');
  if (instant(expiresAt) <= BigInt(now + 60_000) * 1000n) throw new AdapterError('expired_token');
  function repository(value: unknown): string {
    const row = object(value);
    const owner = object(row.owner);
    const name = repositorySegment(row.name);
    if (
      positiveId(row.id) !== input.repositoryId ||
      positiveId(owner.id) !== input.accountId ||
      owner.type !== input.accountType ||
      repositorySegment(owner.login) !== accountLogin ||
      row.full_name !== `${accountLogin}/${name}`
    )
      throw new AdapterError('github_repository_scope_mismatch');
    return name;
  }
  const repositoryName = repository(await request(`/repositories/${input.repositoryId}`, token));
  const list = object(await request('/installation/repositories?per_page=100&page=1', token));
  if (
    list.total_count !== 1 ||
    !Array.isArray(list.repositories) ||
    list.repositories.length !== 1 ||
    repository(list.repositories[0]) !== repositoryName
  )
    throw new AdapterError('github_repository_scope_mismatch');
  return Object.freeze({ accountLogin, repositoryName, token, expiresAt });
}

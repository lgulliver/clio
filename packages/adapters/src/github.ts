import { type FetchTransport, githubApiVersion } from './github-app.ts';
import { githubRateLimit } from './github-rate-limit.ts';
import type { DeploymentEvidence, EvidenceBatch, StatusEvidence } from './model.ts';
import { currentDeployments, deploymentVersions } from './observations.ts';
import {
  AdapterError,
  content,
  eventBeforeObservation,
  identity,
  instant,
  object,
  positiveId,
  sha,
  string,
  timestamp,
} from './value.ts';

export type CollectionDiagnostic = Readonly<{
  code: string;
  resource: string;
  retryAfterSeconds: number | null;
}>;
export type GitHubBatch = EvidenceBatch &
  Readonly<{
    /** REST traversal only; never an OEMS coverage assertion or durable checkpoint. */
    transportComplete: boolean;
    diagnostics: readonly CollectionDiagnostic[];
  }>;

function nextPage(header: string | null, current: URL, expectedPath: string): URL | null {
  if (!header) return null;
  const next: string[] = [];
  for (const part of header.split(',')) {
    const link = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
    if (!link?.[1] || !link[2]) throw new AdapterError('invalid_pagination');
    if (link[2] === 'next') next.push(link[1]);
  }
  if (next.length === 0) return null;
  if (next.length !== 1 || !next[0]) throw new AdapterError('invalid_pagination');
  let url: URL;
  try {
    url = new URL(next[0]);
  } catch {
    throw new AdapterError('invalid_pagination');
  }
  const allowed = [...url.searchParams.keys()].every((key) => key === 'page' || key === 'per_page');
  const page = Number(url.searchParams.get('page'));
  if (
    url.origin !== 'https://api.github.com' ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== expectedPath ||
    !allowed ||
    url.searchParams.getAll('page').length !== 1 ||
    url.searchParams.getAll('per_page').length !== 1 ||
    url.searchParams.get('per_page') !== '100' ||
    !Number.isSafeInteger(page) ||
    page !== Number(current.searchParams.get('page')) + 1
  ) {
    throw new AdapterError('unsafe_pagination');
  }
  return url;
}
function duplicateContent(record: DeploymentEvidence | StatusEvidence): string {
  const { observedAt: _observation, ...rest } = record;
  return content(rest);
}
function merge<T extends DeploymentEvidence | StatusEvidence>(
  target: Map<string, T>,
  page: readonly T[],
): void {
  const pending = new Map(target);
  for (const record of page) {
    const previous = pending.get(record.id);
    if (previous && duplicateContent(previous) !== duplicateContent(record))
      throw new AdapterError('conflicting_source_record');
    if (!previous || instant(record.observedAt) < instant(previous.observedAt))
      pending.set(record.id, record);
  }
  target.clear();
  for (const [key, value] of pending) target.set(key, value);
}

export async function collectGitHubDeployments(input: {
  instance: string;
  repositoryId: number;
  /** Optional selected binding; metadata must still confirm stable numeric identity. */
  binding?: Readonly<{ owner: string; name: string }>;
  token: string;
  clock: () => Date;
  fetch: FetchTransport;
  signal?: AbortSignal;
  maxPages?: number;
  maxRecords?: number;
}): Promise<GitHubBatch> {
  const sourceId = identity('github', string(input.instance));
  const repositoryId = positiveId(input.repositoryId);
  string(input.token);
  const maxPages = input.maxPages ?? 1000;
  const maxRecords = input.maxRecords ?? 100_000;
  positiveId(maxPages);
  positiveId(maxRecords);
  const deployments = new Map<string, DeploymentEvidence>();
  const statuses = new Map<string, StatusEvidence>();
  const diagnostics: CollectionDiagnostic[] = [];
  const completedStatusTraversals: { deploymentId: string; observedAt: string }[] = [];
  let pages = 0;
  let records = 0;
  let resource = 'repository';
  let retryAfterSeconds: number | null = null;
  async function request(url: URL): Promise<Response> {
    if (input.signal?.aborted) throw new AdapterError('cancelled');
    if (++pages > maxPages) throw new AdapterError('page_limit');
    let response: Response;
    try {
      response = await input.fetch(url.href, {
        redirect: 'error',
        signal: input.signal ?? null,
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': githubApiVersion,
        },
      });
    } catch {
      throw new AdapterError(input.signal?.aborted ? 'cancelled' : 'transport_failed');
    }
    if (!response.ok) {
      const limit = await githubRateLimit(response, input.clock);
      retryAfterSeconds = limit.retryAfterSeconds;
      const limited = limit.limited;
      throw new AdapterError(limited ? 'rate_limited' : `http_${response.status}`);
    }
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new AdapterError('invalid_json');
    }
  }
  async function traverse<T>(
    path: string,
    parse: (value: unknown, observedAt: string) => T,
    accept: (page: T[]) => void,
  ): Promise<void> {
    resource = path;
    let url: URL | null = new URL(`https://api.github.com${path}?per_page=100&page=1`);
    while (url) {
      const current: URL = url;
      const response = await request(current);
      const body = await json(response);
      const observedAt = timestamp(input.clock().toISOString());
      if (input.signal?.aborted) throw new AdapterError('cancelled');
      if (!Array.isArray(body)) throw new AdapterError('invalid_page');
      records += body.length;
      if (records > maxRecords) throw new AdapterError('record_limit');
      const page = body.map((value: unknown) => parse(value, observedAt));
      // Reject malicious pagination before accepting this page; a retry starts full backfill.
      const next = nextPage(response.headers.get('link'), current, path);
      accept(page);
      url = next;
    }
  }
  try {
    const metadata = object(
      await json(await request(new URL(`https://api.github.com/repositories/${repositoryId}`))),
    );
    if (positiveId(metadata.id) !== repositoryId)
      throw new AdapterError('repository_binding_mismatch');
    const owner = string(object(metadata.owner).login);
    const name = string(metadata.name);
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name))
      throw new AdapterError('invalid_repository_binding');
    if (input.binding && (input.binding.owner !== owner || input.binding.name !== name))
      throw new AdapterError('repository_binding_mismatch');
    const repoPath = `/repos/${owner}/${name}`;
    const repositoryKey = identity('github', input.instance, 'repository', repositoryId);
    await traverse(
      `${repoPath}/deployments`,
      (value, observedAt): DeploymentEvidence => {
        const row = object(value);
        const deploymentId = positiveId(row.id);
        const eventAt = timestamp(row.created_at);
        const revision = timestamp(row.updated_at);
        eventBeforeObservation(eventAt, observedAt);
        eventBeforeObservation(revision, observedAt);
        return Object.freeze({
          id: identity(sourceId, 'deployment', repositoryId, deploymentId),
          sourceId,
          sourceDeploymentId: identity('repository', repositoryId, 'deployment', deploymentId),
          revision,
          environment: string(row.environment),
          eventAt,
          observedAt,
          sourceRef: `urn:clio:${identity('github', input.instance, 'repository', repositoryId, 'deployment', deploymentId)}`,
          repository: Object.freeze({ repositoryId: repositoryKey, tipSha: sha(row.sha) }),
          reconciledConfigurationRevision: null,
          configurationRepositoryId: null,
          deploymentTask: row.task === undefined || row.task === null ? null : string(row.task),
          operationKind: 'rollout',
        });
      },
      (page) => {
        const accepted = deploymentVersions([...deployments.values(), ...page]);
        deployments.clear();
        for (const record of accepted)
          deployments.set(identity(record.id, record.revision), record);
      },
    );
    // Query every deployment, including those whose current environment is staging.
    for (const deployment of currentDeployments([...deployments.values()])) {
      const deploymentId = deployment.sourceDeploymentId.split(':').at(-1);
      await traverse(
        `${repoPath}/deployments/${deploymentId}/statuses`,
        (value, observedAt): StatusEvidence => {
          const row = object(value);
          const statusId = positiveId(row.id);
          const eventAt = timestamp(row.created_at);
          const revision = timestamp(row.updated_at);
          eventBeforeObservation(eventAt, observedAt);
          eventBeforeObservation(revision, observedAt);
          if (instant(eventAt) < instant(deployment.eventAt))
            throw new AdapterError('status_before_deployment');
          const signal = string(row.state);
          if (
            ![
              'error',
              'failure',
              'inactive',
              'in_progress',
              'queued',
              'pending',
              'success',
            ].includes(signal)
          )
            throw new AdapterError('invalid_deployment_state');
          return Object.freeze({
            id: identity(sourceId, 'status', repositoryId, statusId),
            deploymentId: deployment.id,
            revision,
            environment: string(row.environment),
            signal,
            health: null,
            consumerExposure: false,
            eventAt,
            observedAt,
            sourceRef: `urn:clio:${identity('github', input.instance, 'repository', repositoryId, 'status', statusId)}`,
          });
        },
        (page) => merge(statuses, page),
      );
      completedStatusTraversals.push(
        Object.freeze({
          deploymentId: deployment.id,
          observedAt: timestamp(input.clock().toISOString()),
        }),
      );
    }
  } catch (error) {
    diagnostics.push(
      Object.freeze({
        code: error instanceof AdapterError ? error.code : 'invalid_provider_response',
        resource,
        retryAfterSeconds,
      }),
    );
  }
  return Object.freeze({
    deployments: Object.freeze([...deployments.values()]),
    statuses: Object.freeze([...statuses.values()]),
    completedStatusTraversals: Object.freeze(completedStatusTraversals),
    transportComplete: diagnostics.length === 0,
    diagnostics: Object.freeze(diagnostics),
  });
}

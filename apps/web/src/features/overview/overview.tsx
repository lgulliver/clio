import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Run as ArgoRun, parseRuns as parseArgoRuns } from '../argo-collection/api';
import { type Run as GitHubRun, parseRuns as parseGitHubRuns } from '../github-collection/api';
import { ApiError, errorMessage, parseServices, parseWorkspaces, request } from '../identity/api';
import { useSession } from '../identity/session';
import { type Run as MockRun, parseRuns as parseMockRuns } from '../mock-collection/api';

type StoredRun = GitHubRun | ArgoRun | MockRun;

// Each mounted scope owns its cache. Abandoned selection results must never return.
function useStoredRead<T>(
  scope: string,
  path: string,
  parse: (value: unknown) => T,
  enabled = true,
) {
  const session = useSession();
  const client = useQueryClient();
  const mounted = useRef(true);
  const revision = session.revision;
  const key = useMemo(
    () => ['identity', session.user?.id, revision, 'overview', scope],
    [session.user?.id, revision, scope],
  );
  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: async ({ signal }) => {
      const value = await request(path, parse, { signal });
      if (signal.aborted || !mounted.current || !session.current(revision)) throw new ApiError(0);
      return value;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void client.cancelQueries({ queryKey: key });
      client.removeQueries({ queryKey: key });
    };
  }, [client, key]);
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) session.expire(revision);
  }, [query.error, session.expire, revision]);
  return query;
}

export function Overview() {
  const session = useSession();
  return (
    <section>
      <p className="text-sm font-medium text-indigo-700">Engineering delivery, made clearer</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">Delivery overview</h1>
      <p className="mt-5 max-w-2xl leading-7 text-slate-600">
        Inspect saved service results. Sources stay separate; incomplete evidence does not establish
        complete delivery measurements.
      </p>
      {session.status === 'ready' && session.user ? (
        <WorkspaceSelection key={`${session.user.id}:${session.revision}`} />
      ) : (
        <div className="panel">
          <h2 className="text-xl font-semibold">Stored service evidence</h2>
          <p className="mt-3" role={session.status === 'checking' ? 'status' : undefined}>
            {session.status === 'checking'
              ? 'Checking your session…'
              : session.status === 'error'
                ? 'Stored results are unavailable until your session can be checked.'
                : 'Sign in with GitHub to inspect stored service evidence.'}
          </p>
        </div>
      )}
      <Link to="/settings" className="control mt-6 inline-flex">
        View workspace
      </Link>
    </section>
  );
}

function WorkspaceSelection() {
  const [selected, setSelected] = useState('');
  const query = useStoredRead('workspaces', '/api/workspaces', parseWorkspaces);
  if (query.isPending) return <p role="status">Loading workspaces…</p>;
  if (query.isError)
    return <ReadError error={query.error} retry={() => void query.refetch()} label="workspaces" />;
  const active = query.data.find((workspace) => workspace.id === selected);
  return (
    <div className="mt-8">
      {query.data.length === 0 ? (
        <p>No accessible workspaces. Create one or accept an invitation in Workspace.</p>
      ) : (
        <>
          <label htmlFor="overview-workspace">Workspace</label>
          <select
            id="overview-workspace"
            className="field"
            value={active?.id ?? ''}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Choose a workspace</option>
            {query.data.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </>
      )}
      {active && <ServiceSelection key={active.id} workspaceId={active.id} />}
    </div>
  );
}

function ServiceSelection({ workspaceId }: { workspaceId: string }) {
  const [selected, setSelected] = useState('');
  const query = useStoredRead(
    `${workspaceId}/services`,
    `/api/workspaces/${workspaceId}/services`,
    (value) => parseServices(value, workspaceId),
  );
  if (query.isPending) return <p role="status">Loading services…</p>;
  if (query.isError)
    return <ReadError error={query.error} retry={() => void query.refetch()} label="services" />;
  const active = query.data.find((service) => service.id === selected);
  return (
    <div className="mt-6">
      {query.data.length === 0 ? (
        <p>No services in this workspace. Add a service in Workspace.</p>
      ) : (
        <>
          <label htmlFor="overview-service">Service</label>
          <select
            id="overview-service"
            className="field"
            value={active?.id ?? ''}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Choose a service</option>
            {query.data.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
        </>
      )}
      {active && <StoredResults key={active.id} workspaceId={workspaceId} serviceId={active.id} />}
    </div>
  );
}

function ReadError({ error, retry, label }: { error: unknown; retry: () => void; label: string }) {
  return (
    <div className="panel">
      <p role="alert">{errorMessage(error)}</p>
      <button className="control mt-3" type="button" onClick={retry}>
        Retry {label}
      </button>
    </div>
  );
}

function StoredResults({ workspaceId, serviceId }: { workspaceId: string; serviceId: string }) {
  const client = useQueryClient();
  const session = useSession();
  const [blocked, setBlocked] = useState(false);
  const scope = { workspaceId, serviceId };
  const path = `/api/workspaces/${workspaceId}/services/${serviceId}`;
  const github = useStoredRead(
    `${path}/github`,
    `${path}/github-collection-runs`,
    (value) => parseGitHubRuns(value, scope),
    !blocked,
  );
  const argo = useStoredRead(
    `${path}/argo`,
    `${path}/argo-collection-runs`,
    (value) => parseArgoRuns(value, scope),
    !blocked,
  );
  const mock = useStoredRead(
    `${path}/mock`,
    `${path}/mock-collection-runs`,
    (value) => parseMockRuns(value, scope),
    !blocked,
  );
  const errors = [github.error, argo.error, mock.error];
  const accessLost = errors.some(
    (error) => error instanceof ApiError && [401, 403, 404].includes(error.status),
  );
  useEffect(() => {
    if (!accessLost) return;
    setBlocked(true);
    for (const provider of ['github', 'argo', 'mock']) {
      void client.cancelQueries({
        queryKey: [
          'identity',
          session.user?.id,
          session.revision,
          'overview',
          `${path}/${provider}`,
        ],
      });
    }
  }, [accessLost, client, path, session.user?.id, session.revision]);
  // A scoped permission failure hides every source, including previous successes.
  if (accessLost || blocked)
    return (
      <div className="panel" role="alert">
        Stored results are no longer accessible. Select another service or refresh your workspace
        access.
      </div>
    );
  return (
    <div className="mt-8">
      <p className="text-slate-600">
        Each source shows up to 25 newest collection requests. Saved results belong to their
        original window and connection or mapping revision; they may differ from current settings.
        Counts across sources must not be added together.
      </p>
      {[
        { title: 'Live GitHub', query: github },
        { title: 'Live Argo CD', query: argo },
        { title: 'Mock — fictional evidence', query: mock },
      ].map(({ title, query }) => (
        <section key={title} aria-label={`${title} stored results`} className="panel">
          <h2 className="text-xl font-semibold">{title}</h2>
          {query.isPending ? (
            <p role="status" className="mt-3">
              Loading stored requests…
            </p>
          ) : query.isError ? (
            <ReadError error={query.error} retry={() => void query.refetch()} label={title} />
          ) : (
            <ResultHistory runs={query.data} />
          )}
          <button
            className="control mt-4"
            type="button"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh {title} history
          </button>
        </section>
      ))}
    </div>
  );
}

function ResultHistory({ runs }: { runs: StoredRun[] }) {
  const newest = runs[0];
  // Stored history is ordered by created_at DESC, id DESC in each server repository.
  const success = runs.find((run) => run.status === 'succeeded' && run.result !== null);
  const result = success?.result;
  return (
    <div className="mt-3 space-y-3">
      {newest ? (
        <p>
          Newest request in this history: <strong>{newest.status}</strong>. Requested{' '}
          <time dateTime={newest.createdAt}>{newest.createdAt}</time>.
          {newest.status === 'failed' &&
            ' Collection failed; this request produced no saved result.'}
          {(newest.status === 'running' || newest.status === 'pending') &&
            ' This request has no saved result yet. Refresh history to check progress.'}
        </p>
      ) : (
        <p>No collection requests in this recent history.</p>
      )}
      {success && result ? (
        <>
          <h3 className="font-semibold">Newest successful stored result in this history</h3>
          {success.id !== newest?.id && (
            <p>This older saved result does not describe the newest request.</p>
          )}
          {success.mode === 'mock' && (
            <p>
              Fictional {success.primaryProvider === 'github' ? 'GitHub' : 'Argo CD'} sample. Does
              not measure this service's live delivery.
            </p>
          )}
          <dl className="space-y-2 break-words">
            <div>
              <dt className="font-medium">Window (UTC, end exclusive)</dt>
              <dd>
                {result.window.start} to {result.window.end}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Evidence cutoff</dt>
              <dd>{result.evidenceCutoff}</dd>
            </div>
            <div>
              <dt className="font-medium">Saved result completed</dt>
              <dd>{success.completedAt}</dd>
            </div>
            <div>
              <dt className="font-medium">
                {success.mode === 'mock' ? 'Mapping revision' : 'Connection revision'}
              </dt>
              <dd>
                {success.mode === 'mock' ? success.mappingRevision : success.connectionRevision}
              </dd>
            </div>
            <div>
              <dt className="font-medium">OEMS revision</dt>
              <dd>{result.oemsRevision}</dd>
            </div>
          </dl>
          {result.mode === 'live' ? (
            <>
              <p>
                Provisional deployment frequency count:{' '}
                <strong>{result.deploymentFrequency.count}</strong>. Not a complete deployment
                measurement.
              </p>
              <p>
                Retained deployments: {result.deploymentCount}. Qualifying classifications:{' '}
                {result.qualifyingCount}. Unknown qualification: {result.unknownCount}.
              </p>
              <p>
                {result.transportComplete
                  ? 'GitHub history retrieval complete for this capture; metric coverage remains incomplete.'
                  : 'Source transport coverage is incomplete.'}
              </p>
            </>
          ) : (
            <p>Fictional sample qualification: {result.qualification}. No live measurement.</p>
          )}
          {'provider' in result && result.provider === 'argocd' && (
            <>
              <p>
                Receipt observation period: {result.observationPeriod.start ?? 'Unknown start'} to{' '}
                {result.observationPeriod.end}. Receipt observation does not prove continuous
                coverage of this reporting window.
              </p>
              <p>
                Recorded gaps: {result.recordedGapCount}. Rejected receipts: {result.rejectionCount}
                . Scope drift: {result.scopeDriftCount}. Zero recorded gaps does not prove complete
                operation history.
              </p>
            </>
          )}
          <p>Coverage incomplete: collection, deployment history and recovery evidence.</p>
          <p>
            Deployment rate, change failure rate and failed deployment recovery time: unavailable.
            Change lead time and deployment rework rate: unavailable from these stored results.
          </p>
        </>
      ) : (
        <p>
          No successful saved result in this recent history. Older results may exist beyond these 25
          requests.
        </p>
      )}
    </div>
  );
}

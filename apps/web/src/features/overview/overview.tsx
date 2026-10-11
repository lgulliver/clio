import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { type Run as ArgoRun, parseHistoryPage as parseArgoPage } from '../argo-collection/api';
import { ArchiveHistory } from '../argo-collection/archive-history';
import { CoverageAssessment } from '../argo-collection/coverage-assessment';
import {
  type Run as GitHubRun,
  parseHistoryPage as parseGitHubPage,
} from '../github-collection/api';
import { errorMessage, parseServices, parseWorkspaces } from '../identity/api';
import { useSession } from '../identity/session';
import { MeasurementHistory } from '../measurement-evidence/measurement-history';
import { MetricResults } from '../measurements/metric-results';
import { type Run as MockRun, parseHistoryPage as parseMockPage } from '../mock-collection/api';
import { HistoryBrowser, useStoredRead } from '../result-history/history-browser';

type StoredRun = GitHubRun | ArgoRun | MockRun;

export function Overview() {
  const session = useSession();
  return (
    <section>
      <header className="page-header">
        <h1>Delivery overview</h1>
        <p>Understand service delivery through saved measurements and their evidence.</p>
      </header>
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
    <div className="overview-scope">
      {query.data.length === 0 ? (
        <p>No accessible workspaces. Create one or accept an invitation in Workspace.</p>
      ) : (
        <div className="scope-filter">
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
        </div>
      )}
      {active && (
        <ServiceSelection key={active.id} workspaceId={active.id} workspaceName={active.name} />
      )}
    </div>
  );
}

function ServiceSelection({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const [selected, setSelected] = useState('');
  const query = useStoredRead(
    `${workspaceId}/services`,
    `/api/workspaces/${workspaceId}/services`,
    (value) => parseServices(value, workspaceId),
  );
  if (query.isPending)
    return (
      <p className="col-span-full" role="status">
        Loading services…
      </p>
    );
  if (query.isError)
    return <ReadError error={query.error} retry={() => void query.refetch()} label="services" />;
  const active = query.data.find((service) => service.id === selected);
  return (
    <>
      {query.data.length === 0 ? (
        <p>No services in this workspace. Add a service in Workspace.</p>
      ) : (
        <div className="scope-filter">
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
        </div>
      )}
      {active && (
        <StoredResults
          key={active.id}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          serviceId={active.id}
          serviceName={active.name}
        />
      )}
    </>
  );
}

function ReadError({ error, retry, label }: { error: unknown; retry: () => void; label: string }) {
  return (
    <div className="panel col-span-full">
      <p role="alert">{errorMessage(error)}</p>
      <button className="control mt-3" type="button" onClick={retry}>
        Retry {label}
      </button>
    </div>
  );
}

function StoredResults({
  workspaceId,
  serviceId,
  workspaceName,
  serviceName,
}: {
  workspaceId: string;
  serviceId: string;
  workspaceName: string;
  serviceName: string;
}) {
  const [blocked, setBlocked] = useState(false);
  const scope = { workspaceId, serviceId };
  const path = `/api/workspaces/${workspaceId}/services/${serviceId}`;
  if (blocked)
    return (
      <div className="panel col-span-full" role="alert">
        Stored results are no longer accessible. Select another service or refresh your workspace
        access.
      </div>
    );
  return (
    <div className="col-span-full mt-5">
      <div className="service-heading">
        <div>
          <h2>{serviceName}</h2>
          <p>{workspaceName}</p>
        </div>
        <Link to="/settings" className="text-action">
          Manage workspace and sources
        </Link>
      </div>
      <MeasurementHistory {...scope} onAccessLost={() => setBlocked(true)} />
      <div className="mt-10 mb-4">
        <p className="text-lg font-semibold">Native collection history</p>
        <p className="mt-2 text-sm text-clio-muted">
          Inspect source observations separately from independent measurements.
        </p>
      </div>
      <p className="max-w-3xl text-sm leading-6 text-clio-muted">
        Each source shows up to 25 requests per page and independently finds its newest saved
        result. Saved results belong to their original window and connection or mapping revision;
        they may differ from current settings. Counts across sources must not be added together.
      </p>
      {[
        { title: 'Live GitHub', provider: 'github', parse: parseGitHubPage },
        { title: 'Live Argo CD', provider: 'argo', parse: parseArgoPage },
        { title: 'Mock — fictional evidence', provider: 'mock', parse: parseMockPage },
      ].map(({ title, provider, parse }) => (
        <HistoryBrowser<StoredRun>
          key={title}
          title={title}
          path={`${path}/${provider}-collection-runs`}
          parse={(value, options) => parse(value, scope, options)}
          onAccessLost={() => setBlocked(true)}
          renderResult={(newest, success) => <ResultHistory newest={newest} success={success} />}
        />
      ))}
    </div>
  );
}

function ResultHistory({
  newest,
  success,
}: {
  newest: StoredRun | undefined;
  success: StoredRun | undefined;
}) {
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
          <h3 className="font-semibold">Selected saved result</h3>
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
              {result.archiveSummary && <ArchiveHistory summary={result.archiveSummary} />}
              <CoverageAssessment assessment={result.coverageAssessment} />
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
          {result.mode === 'live' ? (
            <MetricResults
              result={result.metricResult}
              sourceLabel={
                'provider' in result && result.provider === 'argocd' ? 'Argo CD' : 'GitHub'
              }
            />
          ) : (
            <p>
              Deployment rate, change failure rate and failed deployment recovery time: unavailable.
              Change lead time and deployment rework rate: unavailable from these stored results.
            </p>
          )}
        </>
      ) : (
        <p>No successful saved result found.</p>
      )}
    </div>
  );
}

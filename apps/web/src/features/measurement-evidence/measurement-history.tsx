import { MetricResults } from '../measurements/metric-results';
import { comparableSamples, MetricTrends } from '../measurements/metric-trends';
import { HistoryBrowser } from '../result-history/history-browser';
import {
  blockerLabels,
  type MeasurementResult,
  parseHistoryPage,
  type Run,
  type Scope,
} from './api';

export function MeasurementDetails({ result }: { result: MeasurementResult }) {
  const coverage = [
    { label: 'Collection', complete: result.coverage.collectionComplete },
    { label: 'Deployment history', complete: result.coverage.deploymentHistoryComplete },
    { label: 'Recovery evidence', complete: result.coverage.recoveryEvidenceComplete },
  ];
  return (
    <div className="mt-5 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Selected saved measurement</h3>
        <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
          {result.provider === 'github' ? 'GitHub' : 'Argo CD'}
        </span>
      </div>
      <dl className="measurement-context">
        <div>
          <dt>Window (UTC, end exclusive)</dt>
          <dd>
            {result.window.start.slice(0, 10)} to {result.window.end.slice(0, 10)}
          </dd>
        </div>
        <div>
          <dt>Measurement evidence cutoff</dt>
          <dd>{result.evidenceCutoff}</dd>
        </div>
        <div>
          <dt>Original collection evidence cutoff</dt>
          <dd>{result.basisEvidenceCutoff}</dd>
        </div>
      </dl>
      <ul className="coverage-strip" aria-label="Saved measurement coverage">
        {coverage.map(({ label, complete }) => (
          <li
            key={label}
            className={`coverage-chip ${complete ? 'coverage-complete' : 'coverage-incomplete'}`}
          >
            {label}: {complete ? 'complete' : 'incomplete'}
          </li>
        ))}
      </ul>
      <MetricResults result={result.metricResult} sourceLabel="Independent measurement" />
      {result.assessment.blockers.length > 0 ? (
        <div className="evidence-needed">
          <h3 className="font-semibold">Missing measurement evidence</h3>
          <ul>
            {result.assessment.blockers.map((blocker) => (
              <li key={blocker}>{blockerLabels[blocker]}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-clio-muted">
          No saved assessment blockers. Metric quality and observation status are shown above.
        </p>
      )}
      <details className="saved-context">
        <summary>Saved measurement context</summary>
        <p className="mt-3 text-clio-muted">
          This independent measurement preserves its saved evidence. Native collection results
          remain separate.
        </p>
        <dl className="mt-3 grid grid-cols-1 gap-4 break-words sm:grid-cols-2">
          <div>
            <dt className="font-medium">Basis provider</dt>
            <dd>{result.provider === 'github' ? 'GitHub' : 'Argo CD'}</dd>
          </div>
          <div>
            <dt className="font-medium">Connection revision</dt>
            <dd>{result.connectionRevision}</dd>
          </div>
          <div>
            <dt className="font-medium">Exact reporting window (UTC)</dt>
            <dd>
              {result.window.start} to {result.window.end}
            </dd>
          </div>
          <div>
            <dt className="font-medium">OEMS revision</dt>
            <dd>{result.oemsRevision}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

export function MeasurementHistory({
  workspaceId,
  serviceId,
  onAccessLost,
}: Scope & { onAccessLost: () => void }) {
  return (
    <HistoryBrowser<Run>
      title="Independent measurements"
      path={`/api/workspaces/${workspaceId}/services/${serviceId}/measurement-runs`}
      parse={(value, options) => parseHistoryPage(value, { workspaceId, serviceId }, options)}
      onAccessLost={onAccessLost}
      renderResult={(newest, selected, page) => (
        <>
          {newest ? (
            <p className="mt-3">
              Newest measurement request: <strong>{newest.status}</strong>. Requested{' '}
              {newest.createdAt}.
              {(newest.status === 'pending' || newest.status === 'running') &&
                ' No saved measurement yet. Refresh history to check progress.'}
              {newest.status === 'failed' && ' Measurement failed; no result was saved.'}
            </p>
          ) : (
            <p className="mt-3">No measurement requests in this recent history.</p>
          )}
          {selected?.result ? (
            <>
              {selected.id !== newest?.id && (
                <p>This saved measurement does not describe the newest request.</p>
              )}
              <MeasurementDetails result={selected.result} />
              <MetricTrends
                sourceLabel="Independent measurements"
                samples={comparableSamples(
                  page.flatMap((run) =>
                    run.result
                      ? [
                          {
                            id: run.id,
                            result: run.result.metricResult,
                            source: run.provider,
                            revision: run.result.connectionRevision,
                            oemsRevision: run.result.oemsRevision,
                          },
                        ]
                      : [],
                  ),
                  {
                    id: selected.id,
                    result: selected.result.metricResult,
                    source: selected.provider,
                    revision: selected.result.connectionRevision,
                    oemsRevision: selected.result.oemsRevision,
                  },
                )}
              />
            </>
          ) : (
            <p>No successful saved measurement found.</p>
          )}
        </>
      )}
    />
  );
}

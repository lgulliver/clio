import { MetricResults } from '../measurements/metric-results';
import { HistoryBrowser } from '../result-history/history-browser';
import {
  blockerLabels,
  type MeasurementResult,
  parseHistoryPage,
  type Run,
  type Scope,
} from './api';

export function MeasurementDetails({ result }: { result: MeasurementResult }) {
  return (
    <div className="mt-3 space-y-3">
      <h3 className="font-semibold">Selected saved measurement</h3>
      <p>
        This independent measurement preserves its saved evidence. Native collection results remain
        separate.
      </p>
      <dl className="space-y-2 break-words">
        <div>
          <dt className="font-medium">Basis provider</dt>
          <dd>{result.provider === 'github' ? 'GitHub' : 'Argo CD'}</dd>
        </div>
        <div>
          <dt className="font-medium">Window (UTC, end exclusive)</dt>
          <dd>
            {result.window.start} to {result.window.end}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Original collection evidence cutoff</dt>
          <dd>{result.basisEvidenceCutoff}</dd>
        </div>
        <div>
          <dt className="font-medium">Measurement evidence cutoff</dt>
          <dd>{result.evidenceCutoff}</dd>
        </div>
        <div>
          <dt className="font-medium">Connection revision</dt>
          <dd>{result.connectionRevision}</dd>
        </div>
        <div>
          <dt className="font-medium">OEMS revision</dt>
          <dd>{result.oemsRevision}</dd>
        </div>
      </dl>
      <p>
        Saved coverage: collection {result.coverage.collectionComplete ? 'complete' : 'incomplete'},{' '}
        deployment history {result.coverage.deploymentHistoryComplete ? 'complete' : 'incomplete'},{' '}
        recovery evidence {result.coverage.recoveryEvidenceComplete ? 'complete' : 'incomplete'}.
      </p>
      {result.assessment.blockers.length > 0 ? (
        <div>
          <h3 className="font-semibold">Missing measurement evidence</h3>
          <ul className="list-disc pl-6">
            {result.assessment.blockers.map((blocker) => (
              <li key={blocker}>{blockerLabels[blocker]}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p>No saved assessment blockers. Metric quality and observation status are shown below.</p>
      )}
      <MetricResults result={result.metricResult} sourceLabel="Independent measurement" />
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
      renderResult={(newest, selected) => (
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
            </>
          ) : (
            <p>No successful saved measurement found.</p>
          )}
        </>
      )}
    />
  );
}

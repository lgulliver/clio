import type { ComparisonRow, SavedCapture } from './comparison-data';
import { sourceLabel, windowKey, windowLabel } from './comparison-data';
import { comparePeriods, deltaNumber, metricNumber, periodMetrics } from './period-comparison-data';

export type PeriodRow = ComparisonRow & {
  previous: SavedCapture | undefined;
  error?: string;
  retry?: () => void;
};
function context(capture: SavedCapture | undefined, label: string) {
  return (
    <div>
      <h5 className="font-semibold">{label}</h5>
      {capture ? (
        <>
          <p>
            {windowLabel(windowKey(capture.window))} · {sourceLabel(capture.source)}
          </p>
          <p>
            Connection/mapping revision: {capture.revision}. OEMS: {capture.oemsRevision}.
          </p>
          <p>
            Result evidence cutoff: {capture.evidenceCutoff}. Collection evidence cutoff:{' '}
            {capture.collectionEvidenceCutoff}.
          </p>
          <p>
            Saved: {capture.completedAt ?? 'Unavailable'}. Collection completed:{' '}
            {capture.collectionCompletedAt ?? 'Unavailable'}.
          </p>
          <p>
            Collection: {capture.coverage.collectionComplete ? 'complete' : 'incomplete'} · History:{' '}
            {capture.coverage.deploymentHistoryComplete ? 'complete' : 'incomplete'} · Recovery:{' '}
            {capture.coverage.recoveryEvidenceComplete ? 'complete' : 'incomplete'}.
          </p>
        </>
      ) : (
        <p>No exact matching result in loaded history.</p>
      )}
    </div>
  );
}
export function PeriodComparison({
  rows,
  currentPeriod,
  previousPeriod,
  select,
}: {
  rows: PeriodRow[];
  currentPeriod: string;
  previousPeriod: string;
  select: (id: string) => void;
}) {
  const evaluated = rows.map((row) => ({
    ...row,
    comparison: row.state === 'ready' ? comparePeriods(row.selected, row.previous) : undefined,
  }));
  const increased = evaluated.filter((row) => row.comparison?.increased);
  return (
    <section aria-label="Reporting window comparison" className="period-comparison">
      <h4 className="font-semibold">Window comparison</h4>
      <p className="text-clio-muted">
        Current: {windowLabel(currentPeriod)}. Previous: {windowLabel(previousPeriod)}. Covers{' '}
        {rows.length} services on this page.
      </p>
      <p className="text-clio-muted">
        Deltas use complete metrics from matching source and revisions, with equal-length
        chronological windows. Failure/rework deltas are percentage points (pp). Changes describe
        saved results, not causes or service health. Provisional and missing metrics stay separate;
        no group metric is calculated.
      </p>
      <details>
        <summary>
          Services with increases in time or failure/rework rates ({increased.length})
        </summary>
        {increased.length ? (
          <ul className="summary-service-links">
            {increased.map((row) => (
              <li key={row.id}>
                <button
                  className="text-action"
                  type="button"
                  aria-label={`Inspect ${row.name}: metric increases`}
                  onClick={() => select(row.id)}
                >
                  {row.name}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            No increases among comparable complete pairs on this page. Other pairs may remain
            unknown.
          </p>
        )}
      </details>
      <section className="comparison-scroll" aria-label="Scrollable reporting window comparison">
        <table>
          <caption>Per-service saved metrics · previous → current</caption>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Saved context</th>
              {periodMetrics.map((metric) => (
                <th key={metric.key} scope="col">
                  {metric.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {evaluated.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <button
                    className="text-action"
                    type="button"
                    aria-label={`Inspect ${row.name}: window comparison`}
                    onClick={() => select(row.id)}
                  >
                    {row.name}
                  </button>
                </th>
                {!row.comparison ? (
                  <td colSpan={6} role={row.state === 'loading' ? 'status' : undefined}>
                    {row.state === 'loading' ? (
                      'Loading saved results…'
                    ) : (
                      <>
                        <p role="alert">
                          {row.error ?? 'Saved history unavailable. Refresh comparisons to retry.'}
                        </p>
                        {row.retry && (
                          <button type="button" className="text-action" onClick={row.retry}>
                            Retry {row.name}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                ) : (
                  <>
                    <td>
                      {row.comparison.contextReason && <p>{row.comparison.contextReason}</p>}
                      <details>
                        <summary>Both saved contexts</summary>
                        {context(row.previous, 'Previous')}
                        {context(row.selected, 'Current')}
                        <p>Open service for full saved history and evidence.</p>
                      </details>
                    </td>
                    {row.comparison.metrics.map((metric) => (
                      <td key={metric.key}>
                        <span className="comparison-meta">
                          Previous: {metricNumber(metric.previousValue, metric.unit)} ·{' '}
                          {metric.previousQuality?.status.replaceAll('_', ' ') ?? 'unknown'}
                        </span>
                        <span className="comparison-meta">
                          Current: {metricNumber(metric.currentValue, metric.unit)} ·{' '}
                          {metric.currentQuality?.status.replaceAll('_', ' ') ?? 'unknown'}
                        </span>
                        <strong>{deltaNumber(metric.delta, metric.deltaUnit)}</strong>
                        {metric.reason && <span className="comparison-meta">{metric.reason}</span>}
                        <details>
                          <summary>{metric.label} quality for both windows</summary>
                          <p>
                            Previous:{' '}
                            {metric.previousQuality
                              ? metric.previousQuality.quality_reasons
                                  .map((reason) => reason.replaceAll('_', ' '))
                                  .join(', ') || 'No quality blockers.'
                              : 'Metric details unavailable.'}
                          </p>
                          <p>
                            Current:{' '}
                            {metric.currentQuality
                              ? metric.currentQuality.quality_reasons
                                  .map((reason) => reason.replaceAll('_', ' '))
                                  .join(', ') || 'No quality blockers.'
                              : 'Metric details unavailable.'}
                          </p>
                        </details>
                      </td>
                    ))}
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}

import { useEffect, useState } from 'react';
import { type ComparisonRow, windowLabel } from './comparison-data';
import { coverageSummary, evidenceAge } from './coverage-summary-data';

export function CoverageSummary({
  rows,
  totalServices,
  page,
  period,
  source,
  select,
}: {
  rows: ComparisonRow[];
  totalServices: number;
  page: number;
  period: string;
  source: string;
  select: (id: string) => void;
}) {
  const [ageDays, setAgeDays] = useState(7);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const summary = coverageSummary(rows, now, ageDays);
  function links(services: ComparisonRow[], label: string) {
    return services.length ? (
      <ul className="summary-service-links" aria-label={label}>
        {services.map((service) => (
          <li key={service.id}>
            <button
              type="button"
              className="text-action"
              aria-label={`Inspect ${service.name}: ${label}`}
              onClick={() => select(service.id)}
            >
              {service.name}
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <p>None among the selected results.</p>
    );
  }
  function timestamp(label: string, value: string | undefined) {
    return (
      <div>
        <dt>{label}</dt>
        <dd>{value ? <time dateTime={value}>{value}</time> : 'Unavailable'}</dd>
      </div>
    );
  }
  return (
    <section className="coverage-summary" aria-label="Coverage and freshness">
      <div className="comparison-heading">
        <h3>Coverage and freshness</h3>
        <label>
          Highlight collection evidence older than
          <select
            className="field"
            value={ageDays}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value === 1 || value === 7 || value === 30) {
                setAgeDays(value);
                setNow(Date.now());
              }
            }}
          >
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
          </select>
        </label>
      </div>
      <p className="text-clio-muted">
        {source} · {period === 'latest' ? 'Latest per service' : windowLabel(period)}. Page{' '}
        {page + 1}: {rows.length} of {totalServices} services. Summary covers this page’s selected
        results.
      </p>
      <dl className="coverage-overview">
        <div>
          <dt>Services with saved results</dt>
          <dd>
            {summary.saved.length} of {rows.length}
          </dd>
        </div>
        <div>
          <dt>{period === 'latest' ? 'Without saved results' : 'Without matching results'}</dt>
          <dd>{summary.missing.length}</dd>
        </div>
        <div>
          <dt>Reads pending / unavailable</dt>
          <dd>
            {summary.loading.length} / {summary.failed.length}
          </dd>
        </div>
        <div>
          <dt>
            Collection evidence older than {ageDays} {ageDays === 1 ? 'day' : 'days'}
          </dt>
          <dd>
            {summary.old.length} of {summary.saved.length} saved results
          </dd>
        </div>
      </dl>
      <dl className="freshness-times">
        {timestamp('Oldest collection evidence cutoff', summary.oldestCollection)}
        {timestamp('Oldest result evidence cutoff', summary.oldestResult)}
        {timestamp('Latest saved result completed', summary.latestSaved)}
        {timestamp('Latest collection completed', summary.latestCollection)}
      </dl>
      <p className="text-clio-muted">
        Times are UTC for selected saved results. Independent measurements can be newer than their
        collection basis; collection completion is unavailable for them. Evidence age uses this
        device’s clock and updates each minute. Historical windows naturally have older evidence.
        Recent evidence does not establish complete coverage.
      </p>
      <p role="status">
        {summary.loading.length > 0
          ? `Summary is still loading ${summary.loading.length} service histories.`
          : null}
      </p>
      {summary.failed.length > 0 && (
        <p>
          Coverage unknown for {summary.failed.length} unavailable histories; retry their reads
          below.
        </p>
      )}
      <div className="summary-details-grid">
        <details>
          <summary>Missing results ({summary.missing.length})</summary>
          <p>
            {period === 'latest'
              ? 'No successful saved result in loaded history.'
              : 'No exact matching window in loaded history; older results may exist.'}
          </p>
          {links(summary.missing, 'missing results')}
        </details>
        <details>
          <summary>Older collection evidence ({summary.old.length})</summary>
          {summary.old.length ? (
            <ul className="summary-service-links" aria-label="Older collection evidence">
              {summary.old.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className="text-action"
                    aria-label={`Inspect ${row.name}: older collection evidence`}
                    onClick={() => select(row.id)}
                  >
                    {row.name}
                  </button>
                  {row.selected && (
                    <span className="comparison-meta">
                      {evidenceAge(row.selected.collectionEvidenceCutoff, now)} ·{' '}
                      {row.selected.collectionEvidenceCutoff}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>No selected collection evidence exceeds this threshold.</p>
          )}
        </details>
        <details>
          <summary>Unavailable metric details ({summary.legacy.length})</summary>
          {links(summary.legacy, 'unavailable metric details')}
        </details>
        {summary.ahead.length > 0 && (
          <details>
            <summary>Cutoffs ahead of device clock ({summary.ahead.length})</summary>
            <p>Age cannot be assessed against this device’s clock for these results.</p>
            {links(summary.ahead, 'cutoff ahead of device clock')}
          </details>
        )}
      </div>
      <section className="coverage-declarations" aria-label="Saved coverage declarations">
        {summary.coverage.map((item) => (
          <details key={item.key}>
            <summary>
              {item.label}: {item.incomplete.length} incomplete / {summary.saved.length} saved
              results
            </summary>
            <p>
              {item.complete.length} declare complete coverage; {item.incomplete.length} declare
              incomplete coverage. Missing or unreadable results remain unknown.
            </p>
            {links(item.incomplete, `${item.label.toLowerCase()} evidence incomplete`)}
          </details>
        ))}
      </section>
      <section aria-label="Metric evidence status" className="metric-evidence-status">
        <h4>Evidence by metric</h4>
        <p className="text-clio-muted">
          Saved OEMS statuses stay separate from coverage declarations. No observations is a saved
          result, not missing evidence.
        </p>
        {summary.metrics.map((metric) => (
          <details key={metric.key}>
            <summary>
              {metric.label}: {metric.provisional.length} provisional · {metric.unknown.length}{' '}
              unknown
            </summary>
            <p>
              {metric.complete.length} complete · {metric.provisional.length} provisional ·{' '}
              {metric.noObservations.length} no observations · {metric.unknown.length} unknown.
            </p>
            {metric.provisional.length > 0 && (
              <ul
                className="summary-service-links"
                aria-label={`${metric.label} provisional services`}
              >
                {metric.provisional.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className="text-action"
                      aria-label={`Inspect ${row.name}: ${metric.label} provisional`}
                      onClick={() => select(row.id)}
                    >
                      {row.name}
                    </button>
                    <span className="comparison-meta">
                      {row.selected?.result?.[metric.key].quality_reasons
                        .map((reason) => reason.replaceAll('_', ' '))
                        .join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {metric.unknown.length > 0 && (
              <details>
                <summary>Services with unknown status</summary>
                {links(metric.unknown, `${metric.label} unknown`)}
              </details>
            )}
          </details>
        ))}
      </section>
    </section>
  );
}

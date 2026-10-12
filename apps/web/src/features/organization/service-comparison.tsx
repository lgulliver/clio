import type { MetricResult } from '@clio/oems';
import type { UseQueryResult } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { errorMessage, type Service } from '../identity/api';
import {
  type ComparisonSource,
  comparisonSeries,
  reportingWindows,
  type SavedCapture,
  selectedCapture,
  sourceLabel,
  windowLabel,
} from './comparison-data';
import { useComparisonHistories } from './comparison-history';
import { CoverageSummary } from './coverage-summary';
import { GroupTrends, type ServiceSeries } from './group-trends';
import { PeriodComparison } from './period-comparison';

export type { ComparisonSource } from './comparison-data';

function text(value: number | null, unit = '') {
  return value === null
    ? 'Unavailable'
    : `${value.toLocaleString('en-GB', { maximumFractionDigits: 2 })}${unit}`;
}
function metrics(result: MetricResult) {
  return [
    {
      label: 'Deployment frequency',
      metric: result.deployment_frequency,
      value: text(result.deployment_frequency.deployments_per_day, '/day'),
    },
    {
      label: 'Lead time',
      metric: result.change_lead_time,
      value: text(
        result.change_lead_time.median_seconds === null
          ? null
          : result.change_lead_time.median_seconds / 3600,
        ' h',
      ),
    },
    {
      label: 'Failure rate',
      metric: result.change_fail_rate,
      value: text(
        result.change_fail_rate.ratio === null ? null : result.change_fail_rate.ratio * 100,
        '%',
      ),
    },
    {
      label: 'Rework rate',
      metric: result.deployment_rework_rate,
      value: text(
        result.deployment_rework_rate.ratio === null
          ? null
          : result.deployment_rework_rate.ratio * 100,
        '%',
      ),
    },
    {
      label: 'Recovery time',
      metric: result.failed_deployment_recovery_time,
      value: text(
        result.failed_deployment_recovery_time.median_seconds === null
          ? null
          : result.failed_deployment_recovery_time.median_seconds / 60,
        ' min',
      ),
    },
  ];
}

function ServiceRow({
  service,
  ownership,
  select,
  query,
  period,
}: {
  service: Service;
  ownership: string;
  select: () => void;
  query: UseQueryResult<SavedCapture[], Error>;
  period: string;
}) {
  const selected = selectedCapture(query.data ?? [], period);
  const values = selected?.result ? metrics(selected.result) : [];
  return (
    <tr>
      <th scope="row">
        <button type="button" className="text-action" onClick={select}>
          {service.name}
        </button>
        <span className="comparison-meta">{ownership}</span>
      </th>
      {query.isPending ? (
        <td colSpan={7} role="status">
          Loading saved results…
        </td>
      ) : query.isError ? (
        <td colSpan={7}>
          <p role="alert">{errorMessage(query.error)}</p>
          <button type="button" className="text-action" onClick={() => void query.refetch()}>
            Retry {service.name}
          </button>
        </td>
      ) : !selected?.result ? (
        <td colSpan={7}>
          {selected
            ? 'Metric details unavailable for this saved result.'
            : period !== 'latest'
              ? 'No saved result for selected reporting window in loaded history.'
              : 'No successful saved result for this source.'}
        </td>
      ) : (
        <>
          <td>
            <span>
              {selected.window.start.slice(0, 10)} to {selected.window.end.slice(0, 10)}
            </span>
            <span className="comparison-meta">UTC · end exclusive</span>
            <span className="comparison-meta">{sourceLabel(selected.source)}</span>
            <details>
              <summary>Saved context</summary>
              <p>
                End exclusive, UTC. Evidence cutoff: {selected.evidenceCutoff}. Saved:{' '}
                {selected.completedAt}.
              </p>
              <p>
                Revision: {selected.revision}. OEMS: {selected.oemsRevision}.
              </p>
              <p>Open service for full trends and evidence.</p>
            </details>
          </td>
          {values.map(({ label, metric, value }) => (
            <td key={label}>
              <strong>{value}</strong>
              <span className="comparison-meta">{metric.status.replaceAll('_', ' ')}</span>
              {metric.quality_reasons.length > 0 && (
                <details>
                  <summary>{label} quality</summary>
                  <p>
                    {metric.quality_reasons.map((reason) => reason.replaceAll('_', ' ')).join(', ')}
                  </p>
                </details>
              )}
            </td>
          ))}
          <td>
            <span className="comparison-meta">
              Collection: {selected.coverage.collectionComplete ? 'complete' : 'incomplete'}
            </span>
            <span className="comparison-meta">
              History: {selected.coverage.deploymentHistoryComplete ? 'complete' : 'incomplete'}
            </span>
            <span className="comparison-meta">
              Recovery: {selected.coverage.recoveryEvidenceComplete ? 'complete' : 'incomplete'}
            </span>
          </td>
        </>
      )}
    </tr>
  );
}
export function ServiceComparison({
  services,
  ownership,
  select,
  source,
  onSourceChange,
  onAccessLost,
  period,
  onPeriodChange,
  previousPeriod,
  onPreviousPeriodChange,
  compact = false,
  pageContext,
}: {
  previousPeriod: string;
  onPreviousPeriodChange: (period: string) => void;
  compact?: boolean;
  pageContext?: string | undefined;
  onAccessLost: () => void;
  period: string;
  onPeriodChange: (period: string) => void;
  source: ComparisonSource;
  onSourceChange: (source: ComparisonSource) => void;
  services: Service[];
  ownership: (serviceId: string) => string;
  select: (serviceId: string) => void;
}) {
  const [paging, setPaging] = useState({ context: pageContext, page: 0 });
  const page = paging.context === pageContext ? paging.page : 0;
  // Reset before forming queries, including when history returns to an earlier filter.
  if (paging.context !== pageContext) setPaging({ context: pageContext, page: 0 });
  const totalPages = Math.ceil(services.length / 10);
  const activePage = Math.min(page, Math.max(0, totalPages - 1));
  const visible = useMemo(
    () => services.slice(activePage * 10, (activePage + 1) * 10),
    [services, activePage],
  );
  const queries = useComparisonHistories(visible, source, onAccessLost);
  const windows = reportingWindows(queries.map((query) => query.data ?? []));
  const series: ServiceSeries[] = visible.map((service, index) => {
    const query = queries[index];
    const selected = selectedCapture(query?.data ?? [], period);
    return {
      id: service.id,
      name: service.name,
      state: !query || query.isPending ? 'loading' : query.isError ? 'error' : 'ready',
      selected,
      samples:
        selected && !query?.isError ? comparisonSeries(query?.data ?? [], selected, period) : [],
    };
  });
  const refreshing = queries.some((query) => query.isFetching);
  return (
    <section className="panel service-comparison" aria-label="Service comparisons">
      <div className="comparison-heading">
        <h3>Service comparisons</h3>
        <label>
          Result source
          <select
            className="field"
            value={source}
            onChange={(e) => {
              const value = e.target.value;
              if (
                value === 'measurement' ||
                value === 'github' ||
                value === 'argo' ||
                value === 'mock'
              )
                onSourceChange(value);
            }}
          >
            <option value="measurement">Independent measurements</option>
            <option value="github">GitHub Deployments</option>
            <option value="argo">Argo CD</option>
            <option value="mock">Demo data</option>
          </select>
        </label>
        <label>
          Reporting window
          <select
            className="field"
            value={period}
            onChange={(event) => onPeriodChange(event.target.value)}
          >
            <option value="latest">Latest per service</option>
            {period !== 'latest' && !windows.includes(period) && (
              <option value={period}>{windowLabel(period)} · not in loaded history</option>
            )}
            {windows.map((window) => (
              <option key={window} value={window}>
                {windowLabel(window)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Previous reporting window
          <select
            className="field"
            value={previousPeriod}
            disabled={period === 'latest'}
            onChange={(event) => onPreviousPeriodChange(event.target.value)}
          >
            <option value="">No comparison</option>
            {previousPeriod && !windows.includes(previousPeriod) && (
              <option value={previousPeriod}>
                {windowLabel(previousPeriod)} · not in loaded history
              </option>
            )}
            {(period === 'latest' ? [] : windows).map((window) => (
              <option key={window} value={window}>
                {windowLabel(window)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="control comparison-refresh"
          type="button"
          aria-disabled={refreshing}
          onClick={() => {
            if (!refreshing) void Promise.allSettled(queries.map((query) => query.refetch()));
          }}
        >
          {refreshing ? 'Refreshing comparisons…' : 'Refresh comparisons'}
        </button>
      </div>
      <p className="text-clio-muted">
        {period === 'latest'
          ? 'Latest saved result per service; windows may differ.'
          : 'Matching exact reporting window across services; missing matches remain unavailable.'}{' '}
        Options come from up to 25 saved results per service on this page. Revisions may differ;
        open a service to inspect full evidence.
      </p>
      {services.length ? (
        <>
          {!compact && (
            <CoverageSummary
              rows={series}
              totalServices={services.length}
              page={activePage}
              period={period}
              source={
                source === 'measurement'
                  ? 'Independent measurements'
                  : source === 'mock'
                    ? 'Demo data'
                    : source === 'argo'
                      ? 'Argo CD'
                      : 'GitHub Deployments'
              }
              select={select}
            />
          )}
          {previousPeriod && period !== 'latest' && (
            <PeriodComparison
              rows={series.map((row, index) => ({
                ...row,
                previous: selectedCapture(queries[index]?.data ?? [], previousPeriod),
                ...(queries[index]?.isError ? { error: errorMessage(queries[index].error) } : {}),
                retry: () => {
                  void queries[index]?.refetch();
                },
              }))}
              currentPeriod={period}
              previousPeriod={previousPeriod}
              select={select}
            />
          )}
          {!previousPeriod && !compact && (
            <section className="comparison-scroll" aria-label="Scrollable service comparison table">
              <table>
                <caption>
                  Current service ownership · {services.length} services in this scope
                </caption>
                <thead>
                  <tr>
                    {[
                      'Service',
                      'Reporting window',
                      'Deployments',
                      'Lead time',
                      'Failure rate',
                      'Rework rate',
                      'Recovery time',
                      'Coverage',
                    ].map((heading) => (
                      <th key={heading} scope="col">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((service, index) => {
                    const query = queries[index];
                    return query ? (
                      <ServiceRow
                        key={service.id}
                        service={service}
                        query={query}
                        period={period}
                        ownership={ownership(service.id)}
                        select={() => select(service.id)}
                      />
                    ) : null;
                  })}
                </tbody>
              </table>
            </section>
          )}
          {period === 'latest' && (
            <p className="mt-3 text-clio-muted">
              Choose an exact reporting window to compare with a previous window.
            </p>
          )}
          <GroupTrends series={series} period={period} />
          {totalPages > 1 && (
            <div className="history-controls mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                className="control"
                disabled={activePage === 0}
                onClick={() => setPaging({ context: pageContext, page: activePage - 1 })}
              >
                Previous services
              </button>
              <p role="status">
                Page {activePage + 1} of {totalPages}
              </p>
              <button
                type="button"
                className="control"
                disabled={activePage + 1 >= totalPages}
                onClick={() => setPaging({ context: pageContext, page: activePage + 1 })}
              >
                Next services
              </button>
            </div>
          )}
        </>
      ) : (
        <p>No services in this scope. Assign services to products in Workspace.</p>
      )}
    </section>
  );
}

import type { MetricResult } from '@clio/oems';
import { useLayoutEffect, useState } from 'react';
import { parseHistoryPage as parseArgoPage } from '../argo-collection/api';
import { parseHistoryPage as parseGitHubPage } from '../github-collection/api';
import { ApiError, errorMessage, type Service } from '../identity/api';
import { parseHistoryPage as parseMeasurementPage } from '../measurement-evidence/api';
import { comparableSamples, type TrendCapture } from '../measurements/metric-trends';
import { parseHistoryPage as parseMockPage } from '../mock-collection/api';
import { useStoredRead } from '../result-history/history-browser';

export type ComparisonSource = 'measurement' | 'github' | 'argo' | 'mock';
type Saved = TrendCapture & {
  completedAt: string | null;
  evidenceCutoff: string;
  coverage: {
    collectionComplete: boolean;
    deploymentHistoryComplete: boolean;
    recoveryEvidenceComplete: boolean;
  };
};
export function parseComparison(
  value: unknown,
  scope: { workspaceId: string; serviceId: string },
  source: ComparisonSource,
) {
  const options = { succeeded: true };
  if (source === 'measurement') {
    const page = parseMeasurementPage(value, scope, options);
    return page.runs.flatMap((run): Saved[] =>
      run.result
        ? [
            {
              id: run.id,
              result: run.result.metricResult,
              source: run.provider,
              revision: run.result.connectionRevision,
              oemsRevision: run.result.oemsRevision,
              completedAt: run.completedAt,
              evidenceCutoff: run.result.evidenceCutoff,
              coverage: run.result.coverage,
            },
          ]
        : [],
    );
  }
  const page =
    source === 'github'
      ? parseGitHubPage(value, scope, options)
      : source === 'argo'
        ? parseArgoPage(value, scope, options)
        : parseMockPage(value, scope, options);
  return page.runs
    .map((run) => {
      const result = run.result;
      if (!result) throw new ApiError(0);
      return {
        capture: result.metricResult
          ? {
              id: run.id,
              result: result.metricResult,
              source: run.mode === 'mock' ? `demo:${run.primaryProvider}` : source,
              revision: run.mode === 'mock' ? run.mappingRevision : run.connectionRevision,
              oemsRevision: result.oemsRevision,
              completedAt: run.completedAt,
              evidenceCutoff: result.evidenceCutoff,
              coverage: result.coverage,
            }
          : null,
      };
    })
    .map((row) => row.capture);
}

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
  source,
  ownership,
  select,
  onAccessLost,
}: {
  onAccessLost: () => void;
  service: Service;
  source: ComparisonSource;
  ownership: string;
  select: () => void;
}) {
  const scope = { workspaceId: service.workspaceId, serviceId: service.id };
  const path = `/api/workspaces/${service.workspaceId}/services/${service.id}/${source === 'measurement' ? 'measurement' : `${source}-collection`}-runs?status=succeeded`;
  const query = useStoredRead(path, path, (value) => parseComparison(value, scope, source));
  const denied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
  useLayoutEffect(() => {
    if (denied) onAccessLost();
  }, [denied, onAccessLost]);
  const selected = query.data?.[0];
  const values = selected ? metrics(selected.result) : [];
  const samples = selected
    ? comparableSamples(
        (query.data ?? []).flatMap((sample) => (sample ? [sample] : [])),
        selected,
      )
    : [];
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
      ) : !selected ? (
        <td colSpan={7}>
          {query.data?.length
            ? 'Metric details unavailable for latest saved result.'
            : 'No successful saved result for this source.'}
        </td>
      ) : (
        <>
          <td>
            <span>
              {selected.result.window.start.slice(0, 10)} to{' '}
              {selected.result.window.end.slice(0, 10)}
            </span>
            <span className="comparison-meta">UTC · end exclusive</span>
            <span className="comparison-meta">
              {selected.source.startsWith('demo:')
                ? 'Demo data'
                : selected.source === 'argocd' || selected.source === 'argo'
                  ? 'Argo CD'
                  : 'GitHub'}
            </span>
            <details>
              <summary>Saved context</summary>
              <p>
                End exclusive, UTC. Evidence cutoff: {selected.evidenceCutoff}. Saved:{' '}
                {selected.completedAt}.
              </p>
              <p>
                Revision: {selected.revision}. OEMS: {selected.oemsRevision}.
              </p>
              <p>
                {samples.length} comparable saved reporting periods on this page. Open service for
                trends and evidence.
              </p>
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
}: {
  onAccessLost: () => void;
  source: ComparisonSource;
  onSourceChange: (source: ComparisonSource) => void;
  services: Service[];
  ownership: (serviceId: string) => string;
  select: (serviceId: string) => void;
}) {
  const [page, setPage] = useState(0);
  const totalPages = Math.ceil(services.length / 10);
  const activePage = Math.min(page, Math.max(0, totalPages - 1));
  const visible = services.slice(activePage * 10, (activePage + 1) * 10);
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
      </div>
      <p className="text-clio-muted">
        Latest saved result per service. Windows and revisions may differ. Metrics are
        service-level; open a service to inspect trends and evidence.
      </p>
      {services.length ? (
        <>
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
                {visible.map((service) => (
                  <ServiceRow
                    key={`${service.id}/${source}`}
                    service={service}
                    source={source}
                    ownership={ownership(service.id)}
                    select={() => select(service.id)}
                    onAccessLost={onAccessLost}
                  />
                ))}
              </tbody>
            </table>
          </section>
          {totalPages > 1 && (
            <div className="history-controls mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                className="control"
                disabled={activePage === 0}
                onClick={() => setPage(activePage - 1)}
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
                onClick={() => setPage(activePage + 1)}
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

import type { MetricResult } from '@clio/oems';
import { useId, useState } from 'react';
import { trendMetrics } from '../measurements/metric-trends';
import {
  type ComparisonRow,
  type SavedCapture,
  sourceLabel,
  windowKey,
  windowLabel,
} from './comparison-data';

export type ServiceSeries = ComparisonRow & { samples: SavedCapture[] };

const colors = [
  '#60a5fa',
  '#2dd4bf',
  '#fbbf24',
  '#fb7185',
  '#a78bfa',
  '#38bdf8',
  '#fb923c',
  '#e879f9',
  '#a3e635',
  '#f8fafc',
];
function quality(result: MetricResult, key: (typeof trendMetrics)[number]['key']) {
  switch (key) {
    case 'deployments':
      return result.deployment_frequency;
    case 'lead':
      return result.change_lead_time;
    case 'failure':
      return result.change_fail_rate;
    case 'rework':
      return result.deployment_rework_rate;
    case 'recovery':
      return result.failed_deployment_recovery_time;
  }
}
function valueText(value: number | null) {
  return value === null
    ? 'Unavailable'
    : value.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}

export function GroupTrends({ series, period }: { series: ServiceSeries[]; period: string }) {
  const [active, setActive] = useState(0);
  const [dataOpen, setDataOpen] = useState(false);
  const chartId = useId();
  const metric = trendMetrics[active] ?? trendMetrics[0];
  const periods = [
    ...new Set(
      series.flatMap((service) => service.samples.map((capture) => windowKey(capture.window))),
    ),
  ].sort();
  const rows = series.map((service) => {
    const byWindow = new Map(service.samples.map((sample) => [windowKey(sample.window), sample]));
    return {
      ...service,
      points: periods.map((key) => {
        const sample = byWindow.get(key);
        return { key, sample, value: sample?.result ? metric.value(sample.result) : null };
      }),
    };
  });
  const available = rows.some((row) => row.points.some((point) => point.value !== null));
  const maximum =
    metric.unit === '%'
      ? 100
      : Math.max(1, ...rows.flatMap((row) => row.points.map((point) => point.value ?? 0)));
  const starts = periods.map((key) => Date.parse(key.split('|')[0] ?? ''));
  const first = starts.length ? Math.min(...starts) : 0;
  const last = starts.length ? Math.max(...starts) : 0;
  const x = (key: string) =>
    first === last
      ? 350
      : 58 + ((Date.parse(key.split('|')[0] ?? '') - first) / (last - first)) * 584;
  const y = (value: number) => 176 - (value / maximum) * 132;
  const loading = series.some((service) => service.state === 'loading');
  const failed = series.some((service) => service.state === 'error');
  return (
    <section className="metric-trends group-trends" aria-label="Group delivery trends">
      <div className="trend-heading">
        <h3>Delivery trends by service</h3>
        <span>{series.length} services on this page</span>
      </div>
      <fieldset className="trend-controls" aria-label="Group chart metric">
        {trendMetrics.map((item, index) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={active === index}
            aria-controls={chartId}
            onClick={() => setActive(index)}
          >
            {item.label}
          </button>
        ))}
      </fieldset>
      <p>
        {period === 'latest'
          ? 'Saved history within each service’s selected source and revision.'
          : `History through ${windowLabel(period)}.`}{' '}
        Each line is one service. Provisional values retain their saved quality; windows may
        overlap.
      </p>
      <div id={chartId}>
        {available ? (
          <svg
            viewBox="0 0 700 236"
            role="img"
            aria-label={`${metric.label} by saved reporting window; ${metric.unit}. Separate service series; values and quality in chart data.`}
          >
            {[0, 0.5, 1].map((fraction) => (
              <g key={fraction}>
                <line
                  x1="58"
                  x2="642"
                  y1={y(maximum * fraction)}
                  y2={y(maximum * fraction)}
                  stroke="currentColor"
                  opacity=".15"
                />
                <text x="48" y={y(maximum * fraction) + 4} textAnchor="end">
                  {valueText(maximum * fraction)}
                </text>
              </g>
            ))}
            {rows.map((row, index) => {
              const color = colors[index % colors.length];
              const segments: { id: string; path: string }[] = [];
              let segment = '';
              let segmentId = '';
              let previous: SavedCapture | undefined;
              for (const sample of row.samples) {
                const value = sample.result ? metric.value(sample.result) : null;
                if (value === null) {
                  if (segment) segments.push({ id: segmentId, path: segment });
                  segment = '';
                } else {
                  const adjacent =
                    previous && Date.parse(previous.window.end) === Date.parse(sample.window.start);
                  if (!adjacent && segment) {
                    segments.push({ id: segmentId, path: segment });
                    segment = '';
                  }
                  if (!segment) segmentId = sample.id;
                  segment += `${segment ? ' L' : 'M'} ${x(windowKey(sample.window))} ${y(value)}`;
                }
                previous = sample;
              }
              if (segment) segments.push({ id: segmentId, path: segment });
              return (
                <g key={row.id} aria-label={row.name}>
                  {segments.map(({ id, path }) => (
                    <path
                      key={id}
                      d={path}
                      stroke={color}
                      strokeWidth="2.5"
                      strokeDasharray={index % 2 ? '6 4' : undefined}
                      fill="none"
                    />
                  ))}
                  {row.points.map((point) =>
                    point.value === null ? null : (
                      <circle
                        key={point.key}
                        cx={x(point.key)}
                        cy={y(point.value)}
                        r="4"
                        fill={color}
                      >
                        <title>
                          {row.name}: {valueText(point.value)} {metric.unit};{' '}
                          {windowLabel(point.key)};{' '}
                          {point.sample?.result
                            ? quality(point.sample.result, metric.key).status.replaceAll('_', ' ')
                            : ''}
                        </title>
                      </circle>
                    ),
                  )}
                </g>
              );
            })}
            <text x="58" y="209">
              {windowLabel(periods[0] ?? '').replace(' (UTC, end exclusive)', '')}
            </text>
            <text x="642" y="209" textAnchor="end">
              {periods.length > 1
                ? windowLabel(periods.at(-1) ?? '').replace(' (UTC, end exclusive)', '')
                : ''}
            </text>
            <text x="350" y="229" textAnchor="middle">
              Saved reporting windows (UTC, end exclusive)
            </text>
          </svg>
        ) : (
          <p>
            {loading
              ? 'Loading saved service trends…'
              : failed && !periods.length
                ? 'Saved service trends are unavailable until history reads succeed.'
                : periods.length
                  ? 'No values for this metric in loaded periods. Unavailable observations remain gaps.'
                  : period === 'latest'
                    ? 'No comparable saved metric history for these services in loaded results.'
                    : 'No matching saved results for selected reporting window on this page.'}
          </p>
        )}
        {periods.length === 1 && (
          <p>One saved reporting period. Collect another period to see a trend.</p>
        )}
        <ul className="group-trend-legend" aria-label="Service series">
          {series.map((service, index) => (
            <li key={service.id}>
              <span
                aria-hidden="true"
                className="series-swatch"
                style={{
                  borderColor: colors[index % colors.length],
                  borderStyle: index % 2 ? 'dashed' : 'solid',
                }}
              />
              <span>
                {service.name}
                <small>
                  {service.state === 'loading'
                    ? 'Loading history'
                    : service.state === 'error'
                      ? 'History unavailable'
                      : service.selected
                        ? `${sourceLabel(service.selected.source)} · revision ${service.selected.revision}`
                        : period === 'latest'
                          ? 'No saved result'
                          : 'No result for selected window'}
                </small>
              </span>
            </li>
          ))}
        </ul>
        <p>
          Lines join only adjacent, non-overlapping saved windows. Gaps and unavailable values break
          lines. Only recorded windows are shown; unsaved intervals are unknown. Up to 25 saved
          results per service on this page.
        </p>
        {periods.length > 0 && (
          <details onToggle={(event) => setDataOpen(event.currentTarget.open)}>
            <summary>Chart data and quality</summary>
            {dataOpen && (
              <div className="comparison-scroll">
                <table>
                  <caption>
                    {metric.label} ({metric.unit}) · separate service observations
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Service</th>
                      <th scope="col">Reporting window (UTC, end exclusive)</th>
                      <th scope="col">Value</th>
                      <th scope="col">Quality</th>
                      <th scope="col">Saved context</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.flatMap((row) =>
                      row.points.map((point) => (
                        <tr key={`${row.id}/${point.key}`}>
                          <th scope="row">{row.name}</th>
                          <td>{windowLabel(point.key)}</td>
                          <td>{valueText(point.value)}</td>
                          <td>
                            {row.state !== 'ready' ? (
                              row.state === 'loading' ? (
                                'History loading'
                              ) : (
                                'History unavailable'
                              )
                            ) : !point.sample ? (
                              'No saved result for this window'
                            ) : point.sample.result ? (
                              <>
                                {quality(point.sample.result, metric.key).status.replaceAll(
                                  '_',
                                  ' ',
                                )}
                                {quality(point.sample.result, metric.key).quality_reasons.length >
                                  0 && (
                                  <span className="comparison-meta">
                                    {quality(point.sample.result, metric.key)
                                      .quality_reasons.map((reason) => reason.replaceAll('_', ' '))
                                      .join(', ')}
                                  </span>
                                )}
                              </>
                            ) : (
                              'Metric details unavailable'
                            )}
                          </td>
                          <td>
                            {point.sample && (
                              <>
                                {sourceLabel(point.sample.source)} · revision{' '}
                                {point.sample.revision}
                                <span className="comparison-meta">
                                  OEMS: {point.sample.oemsRevision}
                                </span>
                                <span className="comparison-meta">
                                  Saved: {point.sample.completedAt}
                                </span>
                                <span className="comparison-meta">
                                  Evidence cutoff: {point.sample.evidenceCutoff}
                                </span>
                              </>
                            )}
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        )}
      </div>
    </section>
  );
}

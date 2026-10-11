import type { MetricResult } from '@clio/oems';
import { useId, useState } from 'react';

export type TrendSample = { id: string; result: MetricResult };
const metrics = [
  {
    key: 'deployments',
    label: 'Deployments',
    unit: 'per day',
    value: (r: MetricResult) => r.deployment_frequency.deployments_per_day,
  },
  {
    key: 'lead',
    label: 'Lead time',
    unit: 'hours',
    value: (r: MetricResult) =>
      r.change_lead_time.median_seconds === null ? null : r.change_lead_time.median_seconds / 3600,
  },
  {
    key: 'failure',
    label: 'Failure rate',
    unit: '%',
    value: (r: MetricResult) =>
      r.change_fail_rate.ratio === null ? null : r.change_fail_rate.ratio * 100,
  },
  {
    key: 'rework',
    label: 'Rework rate',
    unit: '%',
    value: (r: MetricResult) =>
      r.deployment_rework_rate.ratio === null ? null : r.deployment_rework_rate.ratio * 100,
  },
  {
    key: 'recovery',
    label: 'Recovery time',
    unit: 'minutes',
    value: (r: MetricResult) =>
      r.failed_deployment_recovery_time.median_seconds === null
        ? null
        : r.failed_deployment_recovery_time.median_seconds / 60,
  },
] as const;

export type TrendCapture = TrendSample & { source: string; revision: number; oemsRevision: string };
export function comparableSamples(captures: TrendCapture[], selected: TrendCapture): TrendSample[] {
  const matching = captures.filter(
    (c) =>
      c.source === selected.source &&
      c.revision === selected.revision &&
      c.oemsRevision === selected.oemsRevision,
  );
  // The selected capture owns its reporting window, even when an older capture was chosen.
  return distinctPeriods([selected, ...matching]);
}

/** History arrives newest first. Repeated captures replace their reporting window. */
export function distinctPeriods(samples: TrendSample[]): TrendSample[] {
  const periods = new Map<string, TrendSample>();
  for (const sample of samples) {
    const key = `${sample.result.window.start}/${sample.result.window.end}`;
    if (!periods.has(key)) periods.set(key, sample);
  }
  return [...periods.values()].sort(
    (a, b) => Date.parse(a.result.window.start) - Date.parse(b.result.window.start),
  );
}

export function MetricTrends({
  samples,
  sourceLabel = 'Service',
}: {
  samples: TrendSample[];
  sourceLabel?: string;
}) {
  const [active, setActive] = useState(0);
  const [range, setRange] = useState('all');
  const chartId = useId();
  const metric = metrics[active] ?? metrics[0];
  const periods = distinctPeriods(samples);
  const end = Math.max(...periods.map((s) => Date.parse(s.result.window.end)));
  const shown = periods.filter(
    (s) => range === 'all' || Date.parse(s.result.window.end) > end - Number(range) * 86400000,
  );
  const points = shown.map((s) => ({ ...s, value: metric.value(s.result) }));
  const max = metric.unit === '%' ? 100 : Math.max(0, ...points.map((p) => p.value ?? 0)) || 1;
  const first = Date.parse(shown[0]?.result.window.start ?? '');
  const last = Date.parse(shown.at(-1)?.result.window.start ?? '');
  const x = (index: number) =>
    last === first
      ? 340
      : 48 +
        ((Date.parse(points[index]?.result.window.start ?? '') - first) / (last - first)) * 584;
  const y = (value: number) => 170 - (value / max) * 132;
  const segments: string[] = [];
  let segment = '';
  points.forEach((p, i) => {
    if (p.value === null) {
      if (segment) segments.push(segment);
      segment = '';
    } else segment += `${segment ? ' L' : 'M'} ${x(i)} ${y(p.value)}`;
  });
  if (segment) segments.push(segment);
  if (!samples.length) return <p>No saved metric history for charts.</p>;
  return (
    <section className="metric-trends" aria-label={`${sourceLabel}: Delivery trends`}>
      <div className="trend-heading">
        <h4>Delivery trends</h4>
        <label>
          Reporting periods
          <select className="field" value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="all">Saved periods on this page</option>
            <option value="30">Latest 30 days of saved periods</option>
            <option value="90">Latest 90 days of saved periods</option>
          </select>
        </label>
      </div>
      <fieldset className="trend-controls" aria-label="Chart metric">
        {metrics.map((m, i) => (
          <button
            key={m.key}
            type="button"
            aria-pressed={active === i}
            aria-controls={chartId}
            onClick={() => setActive(i)}
          >
            {m.label}
          </button>
        ))}
      </fieldset>
      <p>
        Saved reporting windows on this page. Date ranges end at the newest saved period; windows
        may overlap. Provisional values retain their recorded quality.
      </p>
      <div id={chartId}>
        {points.length ? (
          <>
            <svg
              viewBox="0 0 680 220"
              role="img"
              aria-label={`${metric.label} by reporting period; ${metric.unit}. Values available in chart data.`}
            >
              {[0, 0.5, 1].map((f) => (
                <g key={f}>
                  <line
                    x1="48"
                    x2="632"
                    y1={y(max * f)}
                    y2={y(max * f)}
                    stroke="currentColor"
                    opacity="0.15"
                  />
                  <text x="38" y={y(max * f) + 4} textAnchor="end">
                    {(max * f).toLocaleString('en-GB', { maximumFractionDigits: 1 })}
                  </text>
                </g>
              ))}
              {metric.key === 'deployments' ? (
                points.map((p, i) =>
                  p.value === null ? null : (
                    <rect
                      key={p.id}
                      x={x(i) - 8}
                      y={y(p.value)}
                      width="16"
                      height={170 - y(p.value)}
                      rx="2"
                      fill="#60a5fa"
                    >
                      <title>
                        {p.result.window.start.slice(0, 10)}: {p.value} {metric.unit}
                      </title>
                    </rect>
                  ),
                )
              ) : (
                <>
                  {segments.map((s) => (
                    <path key={s} d={s} fill="none" stroke="#2dd4bf" strokeWidth="2.5" />
                  ))}
                  {points.map((p, i) =>
                    p.value === null ? null : (
                      <circle key={p.id} cx={x(i)} cy={y(p.value)} r="4" fill="#2dd4bf">
                        <title>
                          {p.result.window.start.slice(0, 10)}: {p.value} {metric.unit}
                        </title>
                      </circle>
                    ),
                  )}
                </>
              )}
              <text x="48" y="202">
                {shown[0]?.result.window.start.slice(0, 10)}
              </text>
              <text x="632" y="202" textAnchor="end">
                {shown.length > 1 ? shown.at(-1)?.result.window.start.slice(0, 10) : ''}
              </text>
            </svg>
            {points.length === 1 && (
              <p>One saved reporting period. Collect another period to see a trend.</p>
            )}
            <details>
              <summary>Chart data and quality</summary>
              <table>
                <caption>
                  {metric.label} ({metric.unit}) · saved reporting periods on this page
                </caption>
                <thead>
                  <tr>
                    <th>Start (UTC)</th>
                    <th>End (exclusive)</th>
                    <th>Value</th>
                    <th>Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {points.map((p) => (
                    <tr key={p.id}>
                      <td>{p.result.window.start.slice(0, 10)}</td>
                      <td>{p.result.window.end.slice(0, 10)}</td>
                      <td>
                        {p.value === null
                          ? 'Unavailable'
                          : p.value.toLocaleString('en-GB', { maximumFractionDigits: 2 })}
                      </td>
                      <td>
                        {metric.key === 'deployments'
                          ? p.result.deployment_frequency.status
                          : metric.key === 'lead'
                            ? p.result.change_lead_time.status
                            : metric.key === 'failure'
                              ? p.result.change_fail_rate.status
                              : metric.key === 'rework'
                                ? p.result.deployment_rework_rate.status
                                : p.result.failed_deployment_recovery_time.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        ) : (
          <p>No saved metric values for these reporting periods.</p>
        )}
      </div>
    </section>
  );
}

export function MetricSparkline({ name, samples }: { name: string; samples: TrendSample[] }) {
  const index = [
    'Deployment frequency',
    'Change lead time',
    'Change failure rate',
    'Deployment rework rate',
    'Failed deployment recovery time',
  ].indexOf(name);
  const metric = metrics[index];
  if (!metric) return null;
  const periods = distinctPeriods(samples);
  const points = periods.map((s) => metric.value(s.result));
  const first = Date.parse(periods[0]?.result.window.start ?? '');
  const last = Date.parse(periods.at(-1)?.result.window.start ?? '');
  const x = (i: number) =>
    first === last
      ? 70
      : 6 + ((Date.parse(periods[i]?.result.window.start ?? '') - first) / (last - first)) * 128;
  const max = metric.unit === '%' ? 100 : Math.max(0, ...points.map((p) => p ?? 0)) || 1;
  const segments: string[] = [];
  let segment = '';
  points.forEach((p, i) => {
    if (p === null) {
      if (segment) segments.push(segment);
      segment = '';
    } else segment += `${segment ? ' L' : 'M'} ${x(i)} ${36 - (p / max) * 28}`;
  });
  if (segment) segments.push(segment);
  return (
    <svg className="metric-sparkline" viewBox="0 0 140 42" aria-hidden="true">
      {segments.map((s) => (
        <path key={s} d={s} fill="none" stroke="#60a5fa" strokeWidth="2" />
      ))}
      {points.map((p, i) =>
        p === null ? null : (
          <circle key={periods[i]?.id} cx={x(i)} cy={36 - (p / max) * 28} r="2.5" fill="#60a5fa" />
        ),
      )}
    </svg>
  );
}

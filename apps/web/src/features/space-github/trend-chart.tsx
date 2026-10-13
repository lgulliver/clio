import { useId, useState } from 'react';
import { formatDay, formatReferencePeriod, formatTimestamp } from '../space/period';
import { type OperationResult, type SignalId, signalIds, signalLabels } from './api';
import { buildOperationalPoints, type OperationalPoint, type OperationalSeries } from './trends';

const colors = ['#60a5fa', '#2dd4bf', '#fbbf24', '#fb7185', '#a78bfa', '#a3e635'];
const hours = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function valueText(series: OperationalSeries, point: OperationalPoint) {
  if (point.value === null)
    return point.status === 'insufficient_samples'
      ? `Insufficient samples (${point.sampleCount} timed ${
          point.sampleCount === 1 ? 'PR' : 'PRs'
        }; minimum 3)`
      : 'No observations';
  return series.unit === 'hours' ? `${hours.format(point.value)} h` : String(point.value);
}

export function operationalSeriesLabel(series: OperationalSeries) {
  return `${series.repositoryLabel} · ${series.teamName} · connection ${series.mappingId.slice(
    0,
    8,
  )} revision ${series.mappingRevision} · ${series.lengthDays}-day windows`;
}

function pointText(series: OperationalSeries, point: OperationalPoint) {
  return [
    operationalSeriesLabel(series),
    formatReferencePeriod(point.windowStart, point.windowEnd),
    `recorded team ${point.teamName}`,
    valueText(series, point),
    point.value === null ? null : 'provisional',
    `saved ${formatTimestamp(point.completedAt)}`,
  ]
    .filter(Boolean)
    .join('; ');
}

/**
 * Qualified points for one signal, positioned by window start. Points are never joined: saved
 * windows are separate acquisitions, not a continuous population. Null values sit on a gap lane.
 */
export function OperationalTrendChart({
  results,
  hasOlder,
}: {
  results: readonly OperationResult[];
  hasOlder: boolean;
}) {
  const id = useId();
  const [signalId, setSignalId] = useState<SignalId>('open_to_merge');
  const [dataOpen, setDataOpen] = useState(false);
  const label = signalLabels[signalId];
  const series = buildOperationalPoints(results, signalId);
  const points = series.flatMap((item) => item.points);
  const starts = points.map((point) => Date.parse(point.windowStart));
  const first = starts.length ? Math.min(...starts) : 0;
  const last = starts.length ? Math.max(...starts) : 0;
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const top = Math.max(1, ...values) * 1.1;
  const x = (value: string) =>
    first === last ? 380 : 70 + ((Date.parse(value) - first) / (last - first)) * 620;
  const y = (value: number) => 190 - (value / top) * 160;
  const lane = 222;
  const unit = series[0]?.unit ?? (signalId.startsWith('open_to') ? 'hours' : 'count');
  const ticks = [0, top / 2, top];
  return (
    <section className="space-trends" aria-labelledby={`${id}-heading`}>
      <div className="space-section-heading">
        <h4 id={`${id}-heading`}>Saved result trend</h4>
        <div>
          <label htmlFor={`${id}-signal`}>Trend signal</label>
          <select
            id={`${id}-signal`}
            className="field"
            value={signalId}
            onChange={(event) => {
              const next = signalIds.find((item) => item === event.target.value);
              if (next) setSignalId(next);
            }}
          >
            {signalIds.map((item) => (
              <option key={item} value={item}>
                {signalLabels[item]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="space-muted">
        Built only from saved results on this page (up to 25).{' '}
        {hasOlder ? 'Older results are on later pages and are not included. ' : ''}Points are not
        joined: each window is a separate provisional observation. Separate series are kept for each
        repository connection, revision, recorded team and window length. Empty or under-minimum
        windows are gaps, not zero. Higher or lower is not graded as better.
      </p>
      {!points.length ? (
        <p>No saved results to chart.</p>
      ) : (
        <>
          <svg
            viewBox="0 0 720 262"
            role="img"
            aria-label={`${label} by window start (UTC). ${series.length} separate series. ${values.length ? '' : 'No provisional values on this page. '}Values and context are in trend data.`}
          >
            {ticks.map((value) => (
              <g key={value}>
                <line
                  x1="70"
                  x2="690"
                  y1={y(value)}
                  y2={y(value)}
                  stroke="currentColor"
                  opacity=".15"
                />
                <text x="60" y={y(value) + 4} textAnchor="end">
                  {unit === 'hours' ? `${hours.format(value)} h` : Math.round(value)}
                </text>
              </g>
            ))}
            <text x="60" y={lane + 4} textAnchor="end">
              No value
            </text>
            <line
              x1="70"
              x2="690"
              y1={lane}
              y2={lane}
              stroke="currentColor"
              opacity=".1"
              strokeDasharray="2 4"
            />
            {series.map((item, index) => {
              const color = colors[index % colors.length];
              return (
                <g key={item.key}>
                  {item.points.map((point) =>
                    point.value === null ? (
                      <rect
                        key={point.resultId}
                        x={x(point.windowStart) - 4}
                        y={lane - 4}
                        width="8"
                        height="8"
                        fill="none"
                        stroke={color}
                      >
                        <title>{pointText(item, point)}</title>
                      </rect>
                    ) : index % 2 ? (
                      <rect
                        key={point.resultId}
                        x={x(point.windowStart) - 4.5}
                        y={y(point.value) - 4.5}
                        width="9"
                        height="9"
                        fill={color}
                      >
                        <title>{pointText(item, point)}</title>
                      </rect>
                    ) : (
                      <circle
                        key={point.resultId}
                        cx={x(point.windowStart)}
                        cy={y(point.value)}
                        r="4.5"
                        fill={color}
                      >
                        <title>{pointText(item, point)}</title>
                      </circle>
                    ),
                  )}
                </g>
              );
            })}
            <text x="70" y="250">
              {formatDay(first)}
            </text>
            {first !== last && (
              <text x="690" y="250" textAnchor="end">
                {formatDay(last)}
              </text>
            )}
          </svg>
          <p className="space-muted">
            X-axis: window start (UTC). Y-axis: {unit === 'hours' ? 'hours' : 'observed count'}.
            Hollow squares on the lowest lane are windows without a value.
          </p>
          <ul className="space-legend" aria-label="Trend series">
            {series.map((item, index) => (
              <li key={item.key}>
                <span
                  aria-hidden="true"
                  className="series-swatch"
                  style={{ borderColor: colors[index % colors.length] }}
                />
                <span>
                  {operationalSeriesLabel(item)}
                  <small>
                    {index % 2 ? 'Squares' : 'Circles'} · {item.points.length}{' '}
                    {item.points.length === 1 ? 'window' : 'windows'} on this page · calculation{' '}
                    {item.calculationVersion}
                  </small>
                </span>
              </li>
            ))}
          </ul>
          <details onToggle={(event) => setDataOpen(event.currentTarget.open)}>
            <summary>Trend data and context</summary>
            {dataOpen && (
              <div className="comparison-scroll">
                <table className="space-table">
                  <caption>{label} · separate repository, revision, team and window series</caption>
                  <thead>
                    <tr>
                      <th scope="col">Series</th>
                      <th scope="col">Window</th>
                      <th scope="col">Team recorded</th>
                      <th scope="col">Result</th>
                      <th scope="col">Samples</th>
                      <th scope="col">Saved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.flatMap((item) =>
                      item.points.map((point) => (
                        <tr key={`${item.key}/${point.resultId}`}>
                          <th scope="row">{operationalSeriesLabel(item)}</th>
                          <td>{formatReferencePeriod(point.windowStart, point.windowEnd)}</td>
                          <td>{point.teamName}</td>
                          <td>{valueText(item, point)}</td>
                          <td>{point.sampleCount}</td>
                          <td>{formatTimestamp(point.completedAt)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </>
      )}
    </section>
  );
}

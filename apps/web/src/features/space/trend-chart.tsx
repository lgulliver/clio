import { useId, useState } from 'react';
import { dimensions, instrument, type Pulse, type QuestionId, scaleLabel } from './api';
import { formatDay, formatReferencePeriod, formatTimestamp } from './period';
import { formatMean } from './pulse-results';
import { buildTrendSeries, type TrendPoint, type TrendSeries } from './trends';

const colors = ['#60a5fa', '#2dd4bf', '#fbbf24', '#fb7185', '#a78bfa', '#a3e635'];
const statusText: Record<TrendPoint['status'], string> = {
  published: 'Published',
  suppressed: 'Suppressed (fewer than minimum answered)',
  open: 'Open; no results yet',
  cancelled: 'Cancelled; no results',
};

function teamText(point: TrendPoint) {
  return `${point.teamName} (${point.opened ? 'name at opening' : 'name captured at cancellation'})`;
}
function rosterText(point: TrendPoint) {
  return point.opened
    ? `frozen roster ${point.rosterSize}`
    : `team size captured at cancellation ${point.rosterSize}`;
}

/** Per-point context: recorded team name, period, value or gap reason and cohort counts. */
export function pointText(point: TrendPoint) {
  return [
    teamText(point),
    formatReferencePeriod(point.referenceStart, point.referenceEnd),
    point.mean === null ? statusText[point.status] : `mean ${formatMean(point.mean)} on 1–5`,
    point.answeredCount === null ? null : `${point.answeredCount} answered`,
    rosterText(point),
    `minimum ${point.minimumRespondents}`,
    point.closedAt ? `closed ${formatTimestamp(point.closedAt)}` : null,
  ]
    .filter(Boolean)
    .join('; ');
}

export function seriesLabel(series: TrendSeries, currentName: string | undefined) {
  return `${currentName ?? series.points.at(-1)?.teamName ?? 'Team'} · ${series.lengthDays}-day reference periods`;
}

export function TrendChart({
  pulses,
  currentTeamNames,
  hasOlder,
}: {
  pulses: readonly Pulse[];
  currentTeamNames: ReadonlyMap<string, string>;
  hasOlder: boolean;
}) {
  const [questionId, setQuestionId] = useState<QuestionId>('satisfaction');
  const [dataOpen, setDataOpen] = useState(false);
  const id = useId();
  const question =
    instrument.questions.find((item) => item.id === questionId) ?? instrument.questions[0];
  const series = question ? buildTrendSeries(pulses, question.id) : [];
  const points = series.flatMap((item) => item.points);
  const starts = points.map((point) => Date.parse(point.referenceStart));
  const first = starts.length ? Math.min(...starts) : 0;
  const last = starts.length ? Math.max(...starts) : 0;
  const x = (value: string) =>
    first === last ? 380 : 70 + ((Date.parse(value) - first) / (last - first)) * 620;
  const y = (mean: number) => 190 - ((mean - 1) / 4) * 160;
  const lane = 222;
  const published = points.some((point) => point.status === 'published');
  return (
    <section className="space-trends" aria-labelledby={`${id}-heading`}>
      <div className="space-section-heading">
        <h3 id={`${id}-heading`}>Question trend</h3>
        <div>
          <label htmlFor={`${id}-question`}>Question</label>
          <select
            id={`${id}-question`}
            className="field"
            value={questionId}
            onChange={(event) => {
              const next = instrument.questions.find((item) => item.id === event.target.value);
              if (next) setQuestionId(next.id);
            }}
          >
            {dimensions.map((dimension) => (
              <optgroup key={dimension.id} label={dimension.label}>
                {instrument.questions
                  .filter((item) => item.dimension === dimension.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.prompt}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>
      <p className="space-muted">
        Built only from pulses on this page (up to 25).{' '}
        {hasOlder
          ? 'Older pulses are on later pages and are not included.'
          : 'No older pulses for this team.'}{' '}
        Lines join only consecutive published reference periods that touch. Suppressed, open and
        cancelled periods and unrecorded intervals break lines. Cohorts can change between pulses;
        differences are descriptive, not causal.
      </p>
      {!points.length ? (
        <p>No open, closed or cancelled pulses for this team on this page.</p>
      ) : (
        <>
          <svg
            viewBox="0 0 720 262"
            role="img"
            aria-label={`${question?.prompt ?? ''} Mean answers on the original 1 to 5 ${
              question?.scale ?? ''
            } scale by reference-period start. ${series.length} separate series. ${published ? '' : 'No published values on this page. '}Values and context are in chart data.`}
          >
            {[1, 2, 3, 4, 5].map((value) => (
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
                  {value}
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
                  {item.segments.map((segment) =>
                    segment.length > 1 ? (
                      <path
                        key={segment[0]?.pulseId}
                        d={segment
                          .map(
                            (point, position) =>
                              `${position ? 'L' : 'M'} ${x(point.referenceStart)} ${y(point.mean ?? 1)}`,
                          )
                          .join(' ')}
                        stroke={color}
                        strokeWidth="2.5"
                        strokeDasharray={index % 2 ? '6 4' : undefined}
                        fill="none"
                      />
                    ) : null,
                  )}
                  {item.points.map((point) =>
                    point.mean === null ? (
                      <rect
                        key={point.pulseId}
                        x={x(point.referenceStart) - 4}
                        y={lane - 4}
                        width="8"
                        height="8"
                        fill="none"
                        stroke={color}
                      >
                        <title>{pointText(point)}</title>
                      </rect>
                    ) : (
                      <circle
                        key={point.pulseId}
                        cx={x(point.referenceStart)}
                        cy={y(point.mean)}
                        r="4.5"
                        fill={color}
                      >
                        <title>{pointText(point)}</title>
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
          {question && (
            <p className="space-muted">
              Scale: 1 {scaleLabel(question.scale, 1).toLowerCase()} to 5{' '}
              {scaleLabel(question.scale, 5).toLowerCase()}. X-axis: reference-period start (UTC).
              Closure times are listed separately.
            </p>
          )}
          <ul className="space-legend" aria-label="Trend series">
            {series.map((item, index) => {
              const current = currentTeamNames.get(item.teamId);
              return (
                <li key={item.key}>
                  <span
                    aria-hidden="true"
                    className="series-swatch"
                    style={{
                      borderColor: colors[index % colors.length],
                      borderStyle: index % 2 ? 'dashed' : 'solid',
                    }}
                  />
                  <span>
                    {seriesLabel(item, current)}
                    <small>
                      {current ? `Current team name: ${current}` : 'Team no longer exists'} ·{' '}
                      {item.points.length} {item.points.length === 1 ? 'pulse' : 'pulses'} on this
                      page
                    </small>
                  </span>
                </li>
              );
            })}
          </ul>
          <details onToggle={(event) => setDataOpen(event.currentTarget.open)}>
            <summary>Chart data and context</summary>
            {dataOpen && (
              <div className="comparison-scroll">
                <table className="space-table">
                  <caption>{question?.prompt} · separate team and period-length series</caption>
                  <thead>
                    <tr>
                      <th scope="col">Series</th>
                      <th scope="col">Reference period</th>
                      <th scope="col">Team name recorded</th>
                      <th scope="col">Result</th>
                      <th scope="col">Answered</th>
                      <th scope="col">Roster or team size</th>
                      <th scope="col">Minimum</th>
                      <th scope="col">Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.flatMap((item) =>
                      item.points.map((point) => (
                        <tr key={`${item.key}/${point.pulseId}`}>
                          <th scope="row">
                            {seriesLabel(item, currentTeamNames.get(item.teamId))}
                          </th>
                          <td>{formatReferencePeriod(point.referenceStart, point.referenceEnd)}</td>
                          <td>{teamText(point)}</td>
                          <td>
                            {point.mean === null
                              ? statusText[point.status]
                              : `${formatMean(point.mean)} on 1–5`}
                          </td>
                          <td>
                            {point.answeredCount ??
                              (point.status === 'suppressed' ? 'Withheld' : 'Not applicable')}
                          </td>
                          <td>
                            {point.rosterSize}{' '}
                            {point.opened ? '(frozen at opening)' : '(captured at cancellation)'}
                          </td>
                          <td>{point.minimumRespondents}</td>
                          <td>{point.closedAt ? formatTimestamp(point.closedAt) : 'Not closed'}</td>
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

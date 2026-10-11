import type { MetricResult } from '@clio/oems';
import { createContext, type ReactNode, useContext } from 'react';

import { MetricSparkline, type TrendSample } from './metric-trends';

const CompactMetrics = createContext<{ compact: boolean; history: TrendSample[] }>({
  compact: false,
  history: [],
});

function durationText(seconds: number): string {
  if (seconds >= 3600) return `${numberText(seconds / 3600, 1)} h`;
  if (seconds >= 60) return `${numberText(seconds / 60, 1)} min`;
  return `${numberText(seconds, 1)} s`;
}
function numberText(number: number, maximumFractionDigits = 6): string {
  return number.toLocaleString('en-GB', { maximumFractionDigits });
}
function value(number: number | null, unit: string): string {
  return number === null ? 'Unavailable' : `${numberText(number, 20)}${unit ? ` ${unit}` : ''}`;
}
function percent(number: number | null): string {
  return number === null
    ? 'Unavailable'
    : `${(number * 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}%`;
}
type QualityMetric =
  | MetricResult['deployment_frequency']
  | MetricResult['change_lead_time']
  | MetricResult['change_fail_rate']
  | MetricResult['failed_deployment_recovery_time'];

function MetricCard({
  name,
  sourceLabel,
  headingLevel = 4,
  metric,
  primary,
  unit,
  primaryLabel,
  children,
  evidence,
}: {
  name: string;
  sourceLabel: string | undefined;
  headingLevel?: 4 | 5 | 6;
  metric: QualityMetric;
  primary: string;
  unit?: string;
  primaryLabel: string;
  children: ReactNode;
  evidence: ReactNode;
}) {
  const { compact, history } = useContext(CompactMetrics);
  const Heading = headingLevel === 6 ? 'h6' : headingLevel === 5 ? 'h5' : 'h4';
  const provisional = metric.status === 'provisional';
  return (
    <section
      aria-label={sourceLabel ? `${sourceLabel}: ${name}` : name}
      className="metric-card flex h-full min-w-0 flex-col rounded-xl border border-slate-200 bg-white p-5 sm:p-6"
    >
      <Heading className="text-base font-semibold text-slate-900">{name}</Heading>
      <p
        className={`mt-3 self-start rounded-md px-2 py-1 text-xs font-medium ${
          provisional ? 'bg-amber-50 text-amber-900' : 'bg-slate-100 text-slate-700'
        }`}
      >
        Status: {metric.status.replaceAll('_', ' ')}.
      </p>
      <p className="mt-5 text-sm text-slate-600">{primaryLabel}</p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={`break-words font-semibold tracking-tight tabular-nums ${
            primary === 'Unavailable' ? 'text-2xl text-slate-500' : 'text-3xl text-blue-700'
          }`}
        >
          {primary}
        </span>
        {primary !== 'Unavailable' && unit && (
          <span className="text-sm text-slate-600">{unit}</span>
        )}
      </p>
      {compact && <MetricSparkline name={name} samples={history} />}
      {!compact && (
        <>
          <div className="mt-4 space-y-1 text-sm leading-6 text-slate-700">{children}</div>
          <p className="mt-4 text-xs leading-5 text-slate-600">
            Quality:{' '}
            {metric.quality_reasons.length
              ? metric.quality_reasons.map((reason) => reason.replaceAll('_', ' ')).join(', ')
              : 'No recorded quality issues'}
            .
          </p>
        </>
      )}
      {provisional && (
        <p className="mt-2 text-xs leading-5 text-amber-900">
          Observed evidence only; incomplete quality keeps this metric provisional.
        </p>
      )}
      <div aria-hidden="true" className="metric-evidence-spacer" />
      <details className="metric-evidence border-t border-slate-200 pt-3 text-sm text-slate-700">
        <summary className="cursor-pointer rounded-sm font-medium text-blue-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600">
          Evidence details
        </summary>
        <div className="mt-3 space-y-2 leading-6">
          {compact && (
            <>
              {children}
              <p className="mt-4 text-xs leading-5 text-slate-600">
                Quality:{' '}
                {metric.quality_reasons.length
                  ? metric.quality_reasons.map((reason) => reason.replaceAll('_', ' ')).join(', ')
                  : 'No recorded quality issues'}
                .
              </p>
            </>
          )}
          {evidence}
        </div>
      </details>
    </section>
  );
}
function Ratio({
  label,
  sourceLabel,
  headingLevel = 4,
  metric,
}: {
  label: string;
  sourceLabel?: string | undefined;
  headingLevel?: 4 | 5 | 6;
  metric: MetricResult['change_fail_rate'];
}) {
  return (
    <MetricCard
      name={label}
      sourceLabel={sourceLabel}
      headingLevel={headingLevel}
      metric={metric}
      primary={percent(metric.ratio)}
      primaryLabel="Rate"
      evidence={
        <>
          <p>
            Rate: {percent(metric.ratio)}. Numerator: {metric.numerator}. Denominator:{' '}
            {metric.denominator}. Unknown classifications: {metric.unknown_count}.
          </p>
          <p>
            Bounds: {percent(metric.lower_bound)} to {percent(metric.upper_bound)}. Bounds scope:{' '}
            {metric.bounds_scope.replaceAll('_', ' ')}.
          </p>
          <p>
            Raw ratio: {value(metric.ratio, '')}. Raw bounds: {value(metric.lower_bound, '')} to{' '}
            {value(metric.upper_bound, '')}.
          </p>
        </>
      }
    >
      <p>
        {metric.numerator} of {metric.denominator} deployments; {metric.unknown_count} unknown
        classifications.
      </p>
      <p>
        Bounds: {percent(metric.lower_bound)} to {percent(metric.upper_bound)} (
        {metric.bounds_scope.replaceAll('_', ' ')}).
      </p>
    </MetricCard>
  );
}
export function MetricResults({
  result,
  compact = false,
  history = [],
  sourceLabel,
  headingLevel = 4,
}: {
  result: MetricResult | undefined;
  compact?: boolean;
  history?: TrendSample[];
  sourceLabel?: string | undefined;
  headingLevel?: 4 | 5 | 6;
}) {
  const label = (name: string) => (sourceLabel ? `${sourceLabel}: ${name}` : name);
  if (!result)
    return (
      <p>
        All five metric details unavailable for this older saved result. No measurements were
        recalculated.
      </p>
    );
  const frequency = result.deployment_frequency,
    lead = result.change_lead_time,
    recovery = result.failed_deployment_recovery_time;
  return (
    <CompactMetrics value={{ compact, history }}>
      <section
        className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 lg:grid-cols-5"
        aria-label={label('Engineering metrics')}
      >
        <MetricCard
          name="Deployment frequency"
          sourceLabel={sourceLabel}
          headingLevel={headingLevel}
          metric={frequency}
          primary={
            frequency.deployments_per_day === null
              ? 'Unavailable'
              : numberText(frequency.deployments_per_day)
          }
          unit="deployments per day"
          primaryLabel="Deployment rate"
          evidence={
            <p>
              Observed deployment count: {frequency.count}. Rate:{' '}
              {value(frequency.deployments_per_day, 'deployments per day')}. Unknown qualification
              in window: {result.qualification_unknown_count}.
            </p>
          }
        >
          <p>Observed deployment count: {frequency.count}.</p>
          <p>Unknown qualification in window: {result.qualification_unknown_count}.</p>
        </MetricCard>
        <MetricCard
          name="Change lead time"
          sourceLabel={sourceLabel}
          headingLevel={headingLevel}
          metric={lead}
          primary={
            lead.median_seconds === null
              ? 'Unavailable'
              : compact
                ? durationText(lead.median_seconds)
                : numberText(lead.median_seconds)
          }
          unit={compact ? '' : 'seconds'}
          primaryLabel="Confirmed median"
          evidence={
            <>
              <p>
                Confirmed median: {value(lead.median_seconds, 'seconds')}. Confirmed observations:{' '}
                {lead.observation_count}. Observed candidates: {lead.candidate_count}.
              </p>
              <p>
                Unresolved changes: {lead.unresolved_change_count}. Unknown linkage:{' '}
                {lead.linkage_unknown_count}.
              </p>
            </>
          }
        >
          <p>
            Confirmed observations: {lead.observation_count}; observed candidates:{' '}
            {lead.candidate_count}.
          </p>
          <p>
            Unresolved changes: {lead.unresolved_change_count}; unknown linkage:{' '}
            {lead.linkage_unknown_count}.
          </p>
        </MetricCard>
        <Ratio
          label="Change failure rate"
          sourceLabel={sourceLabel}
          headingLevel={headingLevel}
          metric={result.change_fail_rate}
        />
        <Ratio
          label="Deployment rework rate"
          sourceLabel={sourceLabel}
          headingLevel={headingLevel}
          metric={result.deployment_rework_rate}
        />
        <MetricCard
          name="Failed deployment recovery time"
          sourceLabel={sourceLabel}
          headingLevel={headingLevel}
          metric={recovery}
          primary={
            recovery.median_seconds === null
              ? 'Unavailable'
              : compact
                ? durationText(recovery.median_seconds)
                : numberText(recovery.median_seconds)
          }
          unit={compact ? '' : 'seconds'}
          primaryLabel="Observed exact recovery median"
          evidence={
            <>
              <p>
                Observed exact recovery median: {value(recovery.median_seconds, 'seconds')}. Exact
                completed observations: {recovery.observation_count}.
              </p>
              <p>
                Observed approximate recovery median:{' '}
                {value(recovery.approximate_median_seconds, 'seconds')}. Approximate episodes:{' '}
                {recovery.approximate_count}. Open episodes: {recovery.open_count}. Unresolved
                episodes: {recovery.unresolved_count}. Unknown failure classification:{' '}
                {recovery.unknown_failure_count}.
              </p>
            </>
          }
        >
          <p>Exact completed observations: {recovery.observation_count}.</p>
          <p>
            Approximate episodes: {recovery.approximate_count}; median:{' '}
            {value(recovery.approximate_median_seconds, 'seconds')}.
          </p>
          <p>
            Open episodes: {recovery.open_count}; unresolved episodes: {recovery.unresolved_count}.
          </p>
          <p>Unknown failure classification: {recovery.unknown_failure_count}.</p>
        </MetricCard>
      </section>
    </CompactMetrics>
  );
}

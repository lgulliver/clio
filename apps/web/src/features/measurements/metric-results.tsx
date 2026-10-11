import type { MetricResult } from '@clio/oems';

function value(number: number | null, unit: string): string {
  return number === null
    ? 'Unavailable'
    : `${number.toLocaleString('en-GB', { maximumFractionDigits: 6 })} ${unit}`;
}
function percent(number: number | null): string {
  return number === null
    ? 'Unavailable'
    : `${(number * 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}%`;
}
function Quality({
  metric,
}: {
  metric:
    | MetricResult['deployment_frequency']
    | MetricResult['change_lead_time']
    | MetricResult['change_fail_rate']
    | MetricResult['failed_deployment_recovery_time'];
}) {
  return (
    <>
      <p>Status: {metric.status.replaceAll('_', ' ')}.</p>
      <p>
        Quality:{' '}
        {metric.quality_reasons.length
          ? metric.quality_reasons.map((reason) => reason.replaceAll('_', ' ')).join(', ')
          : 'No recorded quality issues'}
        .
      </p>
    </>
  );
}
function Ratio({
  label,
  sourceLabel,
  metric,
}: {
  label: string;
  sourceLabel?: string | undefined;
  metric: MetricResult['change_fail_rate'];
}) {
  return (
    <section aria-label={sourceLabel ? `${sourceLabel}: ${label}` : label}>
      <h4 className="font-medium">{label}</h4>
      <Quality metric={metric} />
      <p>
        Rate: {percent(metric.ratio)}. Numerator: {metric.numerator}. Denominator:{' '}
        {metric.denominator}. Unknown classifications: {metric.unknown_count}.
      </p>
      <p>
        Bounds: {percent(metric.lower_bound)} to {percent(metric.upper_bound)}. Bounds scope:{' '}
        {metric.bounds_scope.replaceAll('_', ' ')}.
      </p>
    </section>
  );
}
export function MetricResults({
  result,
  sourceLabel,
}: {
  result: MetricResult | undefined;
  sourceLabel?: string | undefined;
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
    <section className="space-y-4" aria-label={label('Engineering metrics')}>
      <section aria-label={label('Deployment frequency')}>
        <h4 className="font-medium">Deployment frequency</h4>
        <Quality metric={frequency} />
        <p>
          Observed deployment count: {frequency.count}. Rate:{' '}
          {value(frequency.deployments_per_day, 'deployments per day')}. Unknown qualification in
          window: {result.qualification_unknown_count}.
        </p>
      </section>
      <section aria-label={label('Change lead time')}>
        <h4 className="font-medium">Change lead time</h4>
        <Quality metric={lead} />
        <p>
          Confirmed median: {value(lead.median_seconds, 'seconds')}. Confirmed observations:{' '}
          {lead.observation_count}. Observed candidates: {lead.candidate_count}.
        </p>
        <p>
          Unresolved changes: {lead.unresolved_change_count}. Unknown linkage:{' '}
          {lead.linkage_unknown_count}.
        </p>
      </section>
      <Ratio
        label="Change failure rate"
        sourceLabel={sourceLabel}
        metric={result.change_fail_rate}
      />
      <Ratio
        label="Deployment rework rate"
        sourceLabel={sourceLabel}
        metric={result.deployment_rework_rate}
      />
      <section aria-label={label('Failed deployment recovery time')}>
        <h4 className="font-medium">Failed deployment recovery time</h4>
        <Quality metric={recovery} />
        <p>
          Observed exact recovery median: {value(recovery.median_seconds, 'seconds')}. Exact
          completed observations: {recovery.observation_count}.
        </p>
        <p>
          Observed approximate recovery median:{' '}
          {value(recovery.approximate_median_seconds, 'seconds')}. Approximate episodes:{' '}
          {recovery.approximate_count}. Open episodes: {recovery.open_count}. Unresolved episodes:{' '}
          {recovery.unresolved_count}. Unknown failure classification:{' '}
          {recovery.unknown_failure_count}.
        </p>
      </section>
    </section>
  );
}

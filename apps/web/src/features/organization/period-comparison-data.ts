import { trendMetrics } from '../measurements/metric-trends';
import type { SavedCapture } from './comparison-data';

export const periodMetrics = trendMetrics;

export function comparePeriods(
  current: SavedCapture | undefined,
  previous: SavedCapture | undefined,
) {
  let contextReason: string | undefined;
  if (!current || !previous) contextReason = 'Missing exact window in loaded history.';
  else if (
    current.result &&
    previous.result &&
    current.result.service_id !== previous.result.service_id
  )
    contextReason = 'Saved results belong to different services.';
  else if (
    current.source !== previous.source ||
    current.revision !== previous.revision ||
    current.oemsRevision !== previous.oemsRevision
  )
    contextReason = 'Source or revision differs between saved results.';
  else {
    const currentStart = Date.parse(current.window.start);
    const currentEnd = Date.parse(current.window.end);
    const previousStart = Date.parse(previous.window.start);
    const previousEnd = Date.parse(previous.window.end);
    if (previousEnd > currentStart)
      contextReason = 'Previous window must end before or at current window start.';
    else if (currentEnd - currentStart !== previousEnd - previousStart)
      contextReason = 'Reporting windows have different lengths.';
  }
  const metrics = periodMetrics.map((metric) => {
    const currentQuality = current?.result?.[metric.resultKey];
    const previousQuality = previous?.result?.[metric.resultKey];
    const currentValue = current?.result ? metric.value(current.result) : null;
    const previousValue = previous?.result ? metric.value(previous.result) : null;
    const reason =
      contextReason ??
      (!currentQuality || !previousQuality
        ? 'Metric details unavailable.'
        : currentQuality.status !== 'complete' || previousQuality.status !== 'complete'
          ? 'Both metric results must be complete.'
          : currentValue === null ||
              previousValue === null ||
              !Number.isFinite(currentValue) ||
              !Number.isFinite(previousValue)
            ? 'Numeric result unavailable.'
            : undefined);
    return {
      ...metric,
      currentQuality,
      previousQuality,
      currentValue,
      previousValue,
      reason,
      delta:
        reason || currentValue === null || previousValue === null
          ? null
          : currentValue - previousValue,
    };
  });
  return {
    contextReason,
    metrics,
    increased: metrics.some(
      (metric) => metric.key !== 'deployments' && metric.delta !== null && metric.delta > 0,
    ),
  };
}
export function metricNumber(value: number | null, unit: string): string {
  if (value === null) return 'Unavailable';
  return `${value.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${unit}`;
}
export function deltaNumber(value: number | null, unit: string): string {
  if (value === null) return 'No comparable delta';
  if (value === 0) return `0 ${unit}`;
  const magnitude =
    Math.abs(value) < 0.01
      ? '<0.01'
      : Math.abs(value).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  return `${value > 0 ? '+' : '−'}${magnitude} ${unit}`;
}

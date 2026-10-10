import type { ArchiveSummary } from './api';

export function ArchiveHistory({ summary }: { summary: ArchiveSummary }) {
  return (
    <section className="mt-3" aria-label="Source archive history">
      <p>Source history archive policy: {summary.policyReference}.</p>
      <p>
        Retained archive entries: {summary.entryCount}. Last acknowledged sequence:{' '}
        {summary.lastSequence}.
      </p>
      <p>
        {summary.sealedInterval
          ? `Sealed capture interval: ${summary.sealedInterval.start} to ${summary.sealedInterval.end} (UTC).`
          : 'No sealed capture interval available.'}
      </p>
      <p>
        Last successful sealed reconciliation:{' '}
        {summary.lastSuccessfulReconciliationAt ?? 'Unavailable'}.
      </p>
      <p>
        Archive gaps: {summary.gapCount}. Missing capture intervals: {summary.missingIntervalCount}.
      </p>
      {summary.missingIntervals.length > 0 && (
        <ul aria-label="Missing archive capture intervals">
          {summary.missingIntervals.map((interval) => (
            <li key={`${interval.start}:${interval.end}:${interval.reason}`}>
              {interval.start} to {interval.end} (UTC): {archiveGapLabel(interval.reason)}.
            </li>
          ))}
        </ul>
      )}
      {summary.omittedIntervalCount > 0 && (
        <p>Additional missing intervals not shown: {summary.omittedIntervalCount}.</p>
      )}
      <p>
        Archive counts and seals describe retained journal history across credential periods. Metric
        evidence uses current grants and may include fewer observations.
      </p>
      <p>
        Seals report trusted producer capture bounds, distinct from reporting window and evidence
        cutoff. Coverage remains incomplete.
      </p>
    </section>
  );
}

function archiveGapLabel(reason: string) {
  const labels: Record<string, string> = {
    producer_outage: 'Producer interruption',
    unsealed_interval: 'Capture interval not sealed',
    capture_interruption: 'Capture interruption',
    unsealed: 'Capture interval not sealed',
    interval_gap: 'Gap between sealed intervals',
  };
  return labels[reason] ?? 'Reported capture interruption';
}

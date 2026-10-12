import { instant } from '../measurement-evidence/api';
import type { ComparisonRow } from './comparison-data';

export const metricEvidence = [
  { key: 'deployment_frequency', label: 'Deployment frequency' },
  { key: 'change_lead_time', label: 'Change lead time' },
  { key: 'change_fail_rate', label: 'Change failure rate' },
  { key: 'deployment_rework_rate', label: 'Deployment rework rate' },
  { key: 'failed_deployment_recovery_time', label: 'Failed deployment recovery time' },
] as const;
const day = 86400000000n;

function oldest(values: string[]): string | undefined {
  return values.reduce<string | undefined>(
    (earliest, value) =>
      earliest === undefined || instant(value) < instant(earliest) ? value : earliest,
    undefined,
  );
}
function latest(values: string[]): string | undefined {
  return values.reduce<string | undefined>(
    (last, value) => (last === undefined || instant(value) > instant(last) ? value : last),
    undefined,
  );
}

export function coverageSummary(rows: ComparisonRow[], now: number, ageDays: number) {
  const saved = rows.filter((row) => row.state === 'ready' && row.selected !== undefined);
  const loading = rows.filter((row) => row.state === 'loading');
  const failed = rows.filter((row) => row.state === 'error');
  const missing = rows.filter((row) => row.state === 'ready' && row.selected === undefined);
  const legacy = saved.filter((row) => !row.selected?.result);
  const current = BigInt(now) * 1000n;
  const old = saved.filter(
    (row) =>
      row.selected &&
      current - instant(row.selected.collectionEvidenceCutoff) > BigInt(ageDays) * day,
  );
  const ahead = saved.filter(
    (row) => row.selected && instant(row.selected.collectionEvidenceCutoff) > current,
  );
  const captures = saved.flatMap((row) => (row.selected ? [row.selected] : []));
  const coverage = [
    { key: 'collectionComplete', label: 'Collection' },
    { key: 'deploymentHistoryComplete', label: 'Change history' },
    { key: 'recoveryEvidenceComplete', label: 'Recovery evidence' },
  ] as const;
  return {
    saved,
    loading,
    failed,
    missing,
    legacy,
    old,
    ahead,
    oldestCollection: oldest(captures.map((capture) => capture.collectionEvidenceCutoff)),
    oldestResult: oldest(captures.map((capture) => capture.evidenceCutoff)),
    latestSaved: latest(
      captures.flatMap((capture) => (capture.completedAt ? [capture.completedAt] : [])),
    ),
    latestCollection: latest(
      captures.flatMap((capture) =>
        capture.collectionCompletedAt ? [capture.collectionCompletedAt] : [],
      ),
    ),
    coverage: coverage.map(({ key, label }) => ({
      key,
      label,
      complete: saved.filter((row) => row.selected?.coverage[key] === true),
      incomplete: saved.filter((row) => row.selected?.coverage[key] === false),
    })),
    metrics: metricEvidence.map(({ key, label }) => ({
      key,
      label,
      complete: rows.filter(
        (row) => row.state === 'ready' && row.selected?.result?.[key].status === 'complete',
      ),
      provisional: rows.filter(
        (row) => row.state === 'ready' && row.selected?.result?.[key].status === 'provisional',
      ),
      noObservations: rows.filter(
        (row) => row.state === 'ready' && row.selected?.result?.[key].status === 'no_observations',
      ),
      unknown: rows.filter((row) => row.state !== 'ready' || !row.selected?.result),
    })),
  };
}

export function evidenceAge(cutoff: string, now: number): string {
  const delta = BigInt(now) * 1000n - instant(cutoff);
  if (delta < 0n) return 'Ahead of this device’s clock';
  const hours = Number(delta) / 3600000000;
  return hours < 24
    ? `${hours.toLocaleString('en-GB', { maximumFractionDigits: 1 })} h old`
    : `${(hours / 24).toLocaleString('en-GB', { maximumFractionDigits: 1 })} days old`;
}

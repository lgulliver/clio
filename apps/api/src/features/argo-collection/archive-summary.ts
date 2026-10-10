import { parseArchiveRecord } from '@clio/adapters';
import type { PoolClient } from 'pg';
import { object, uuid } from '../identity/input.ts';
import type { ArgoArchiveGrant } from './config.ts';
import { count, instant, text, timestamp } from './input.ts';
export interface ArchiveSummary {
  journalId: string;
  producerId: string;
  policyReference: string;
  lastSequence: number;
  lastSuccessfulReconciliationAt: string | null;
  sealedInterval: { start: string; end: string } | null;
  entryCount: number;
  gapCount: number;
  missingIntervalCount: number;
  missingIntervals: { start: string; end: string; reason: string }[];
  omittedIntervalCount: number;
}
export function parseArchiveSummary(value: unknown): ArchiveSummary {
  const r = object(value, [
    'journalId',
    'producerId',
    'policyReference',
    'lastSequence',
    'lastSuccessfulReconciliationAt',
    'sealedInterval',
    'entryCount',
    'gapCount',
    'missingIntervalCount',
    'missingIntervals',
    'omittedIntervalCount',
  ]);
  if (!Array.isArray(r.missingIntervals) || r.missingIntervals.length > 32)
    throw new Error('Invalid archive intervals');
  const interval = (value: unknown) => {
    const i = object(value, ['start', 'end']);
    const start = timestamp(i.start),
      end = timestamp(i.end);
    if (instant(start) >= instant(end)) throw new Error('Invalid archive interval');
    return { start, end };
  };
  const missingIntervals = r.missingIntervals.map((value: unknown) => {
    const i = object(value, ['start', 'end', 'reason']);
    return { ...interval({ start: i.start, end: i.end }), reason: reasonText(i.reason) };
  });
  const missingIntervalCount = count(r.missingIntervalCount),
    omittedIntervalCount = count(r.omittedIntervalCount),
    entryCount = count(r.entryCount),
    gapCount = count(r.gapCount),
    lastSequence = count(r.lastSequence);
  if (
    missingIntervals.length + omittedIntervalCount !== missingIntervalCount ||
    gapCount > entryCount ||
    entryCount !== lastSequence
  )
    throw new Error('Invalid archive totals');
  return {
    journalId: uuid(r.journalId),
    producerId: uuid(r.producerId),
    policyReference: text(r.policyReference),
    lastSequence,
    entryCount,
    gapCount,
    missingIntervalCount,
    missingIntervals,
    omittedIntervalCount,
    sealedInterval: r.sealedInterval === null ? null : interval(r.sealedInterval),
    lastSuccessfulReconciliationAt:
      r.lastSuccessfulReconciliationAt === null
        ? null
        : timestamp(r.lastSuccessfulReconciliationAt),
  };
}
export async function archiveSummary(
  client: PoolClient,
  grant: ArgoArchiveGrant,
  cutoff?: string,
): Promise<ArchiveSummary> {
  const time =
    cutoff ??
    timestamp(
      (
        await client.query<Record<string, unknown>>(
          `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`,
        )
      ).rows[0]?.t,
    );
  const found = await client.query<Record<string, unknown>>(
    `SELECT record,gap_reason,to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received FROM argo_archive_records WHERE source_id=$1 AND journal_id=$2 AND received_at<=$3 ORDER BY received_at,id LIMIT 5001`,
    [grant.sourceId, grant.journalId, time],
  );
  if (found.rows.length > 5000) throw new Error('Archive storage limit');
  let entryCount = 0,
    gapCount = 0,
    lastSequence = 0,
    lastSuccessfulReconciliationAt: string | null = null,
    sealedInterval: { start: string; end: string } | null = null,
    end: string | null = null,
    startup: string | null = null;
  const missing: ArchiveSummary['missingIntervals'] = [];
  const records = found.rows.map((row) => ({
    record: parseArchiveRecord(row.record),
    gap: row.gap_reason,
    received: timestamp(row.received),
  }));
  for (const row of records) {
    const record = row.record;
    startup = record.startup_at;
    if (record.kind === 'entry') {
      entryCount++;
      lastSequence = Math.max(lastSequence, record.sequence);
      if (row.gap !== null) {
        gapCount++;
      }
    }
  }
  const seals = records
    .flatMap((row) =>
      row.record.kind === 'seal' ? [{ record: row.record, received: row.received }] : [],
    )
    .sort((a, b) => {
      const first = instant(a.record.start),
        second = instant(b.record.start);
      return first < second ? -1 : first > second ? 1 : 0;
    });
  for (const row of seals) {
    const record = row.record;
    const previous = end ?? record.startup_at;
    if (instant(record.start) > instant(previous))
      missing.push({ start: previous, end: record.start, reason: 'unsealed_interval' });
    for (const interval of record.interruptions) missing.push({ ...interval });
    end = record.end;
    sealedInterval = { start: record.start, end: record.end };
    lastSuccessfulReconciliationAt = row.received;
  }
  if (startup && instant(end ?? startup) < instant(time))
    missing.push({ start: end ?? startup, end: time, reason: 'unsealed_interval' });
  return parseArchiveSummary({
    journalId: grant.journalId,
    producerId: grant.producerId,
    policyReference: grant.policyReference,
    lastSequence,
    lastSuccessfulReconciliationAt,
    sealedInterval,
    entryCount,
    gapCount,
    missingIntervalCount: missing.length,
    missingIntervals: missing.slice(0, 32),
    omittedIntervalCount: Math.max(0, missing.length - 32),
  });
}

function reasonText(value: unknown): string {
  if (typeof value !== 'string' || !value.length || Array.from(value).length > 200)
    throw new Error('Invalid archive reason');
  return value;
}

import { periodLengthDays } from '../space/period';
import type { CalculatedSignals, OperationResult, Signal, SignalId } from './api';

export type OperationalPoint = Readonly<{
  resultId: string;
  windowStart: string;
  windowEnd: string;
  completedAt: string;
  /** Team name copied when the result was saved; never today's name. */
  teamName: string;
  status: Signal['status'];
  /** Null for no observations or insufficient samples: a gap, never zero. */
  value: number | null;
  sampleCount: number;
}>;

export type OperationalSeries = Readonly<{
  key: string;
  repositoryId: number;
  repositoryLabel: string;
  mappingId: string;
  mappingRevision: number;
  /** Original team captured with the results, not the mapping's current owner. */
  teamId: string;
  teamName: string;
  calculationVersion: CalculatedSignals['calculationVersion'];
  signalId: SignalId;
  unit: Signal['unit'];
  lengthDays: number;
  points: readonly OperationalPoint[];
}>;

/**
 * Independently qualified points for one signal. Series never mix repositories, mapping
 * (reconnections restart at revision 1, so the mapping ID is part of identity), mapping revision,
 * original team, calculation version or window length. Points are positioned by window start and
 * are never joined into segments: these results are not a continuous historical population.
 */
export function buildOperationalPoints(
  results: readonly OperationResult[],
  signalId: SignalId,
): OperationalSeries[] {
  const groups = new Map<string, { series: OperationalSeries; points: OperationalPoint[] }>();
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.id)) continue;
    seen.add(result.id);
    const signal = result.calculated.signals.find((item) => item.id === signalId);
    if (!signal) continue;
    const lengthDays = periodLengthDays(result.windowStart, result.windowEnd);
    const key = [
      result.repositoryId,
      result.mappingId,
      result.mappingRevision,
      result.teamId,
      result.calculated.calculationVersion,
      signalId,
      lengthDays,
    ].join('|');
    const group = groups.get(key) ?? {
      series: {
        key,
        repositoryId: result.repositoryId,
        repositoryLabel: result.repositoryLabel,
        mappingId: result.mappingId,
        mappingRevision: result.mappingRevision,
        teamId: result.teamId,
        teamName: result.teamName,
        calculationVersion: result.calculated.calculationVersion,
        signalId,
        unit: signal.unit,
        lengthDays,
        points: [],
      },
      points: [],
    };
    group.points.push({
      resultId: result.id,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      completedAt: result.completedAt,
      teamName: result.teamName,
      status: signal.status,
      value: signal.status === 'provisional' ? signal.value : null,
      sampleCount: signal.sampleCount,
    });
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ series, points }) => ({
      ...series,
      points: points.sort(
        (a, b) =>
          Date.parse(a.windowStart) - Date.parse(b.windowStart) ||
          Date.parse(a.completedAt) - Date.parse(b.completedAt) ||
          a.resultId.localeCompare(b.resultId),
      ),
    }))
    .sort(
      (a, b) =>
        a.repositoryLabel.localeCompare(b.repositoryLabel) ||
        a.mappingId.localeCompare(b.mappingId) ||
        a.mappingRevision - b.mappingRevision ||
        a.lengthDays - b.lengthDays ||
        a.teamId.localeCompare(b.teamId),
    );
}

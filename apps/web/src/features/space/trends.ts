import { type Pulse, type QuestionId, questionById, type Scale } from './api';
import { periodLengthDays } from './period';

export type TrendStatus = 'published' | 'suppressed' | 'open' | 'cancelled';
export type TrendPoint = {
  pulseId: string;
  teamName: string;
  referenceStart: string;
  referenceEnd: string;
  closedAt: string | null;
  /** False for cancelled pulses that never opened: name/size were captured at cancellation. */
  opened: boolean;
  status: TrendStatus;
  mean: number | null;
  answeredCount: number | null;
  rosterSize: number;
  minimumRespondents: number;
  submittedCount: number | null;
};
export type TrendSeries = {
  key: string;
  teamId: string;
  instrumentVersion: Pulse['instrumentVersion'];
  questionId: QuestionId;
  scale: Scale;
  lengthDays: number;
  points: TrendPoint[];
  /** Runs of published points that may be joined by a line. */
  segments: TrendPoint[][];
};

function point(pulse: Pulse, questionId: QuestionId): TrendPoint | null {
  if (pulse.state === 'draft') return null;
  const result = pulse.questions?.find((item) => item.questionId === questionId);
  const status: TrendStatus =
    pulse.state === 'closed'
      ? result?.status === 'published'
        ? 'published'
        : 'suppressed'
      : pulse.state;
  return {
    pulseId: pulse.id,
    teamName: pulse.teamName,
    referenceStart: pulse.referenceStart,
    referenceEnd: pulse.referenceEnd,
    closedAt: pulse.closedAt,
    opened: pulse.openedAt !== null,
    status,
    mean: result?.status === 'published' ? result.mean : null,
    answeredCount: result?.status === 'published' ? result.answeredCount : null,
    rosterSize: pulse.rosterSize,
    minimumRespondents: pulse.minimumRespondents,
    submittedCount: pulse.submittedCount,
  };
}

function overlaps(item: TrendPoint, start: number, end: number) {
  return Date.parse(item.referenceStart) < end && Date.parse(item.referenceEnd) > start;
}

/**
 * Separate series by original team, instrument, question, scale and reference length. Published
 * points join only when their windows touch exactly and no unpublished window intersects the span.
 * Drafts reserve no period and are not plotted.
 */
export function buildTrendSeries(pulses: readonly Pulse[], questionId: QuestionId): TrendSeries[] {
  const scale = questionById(questionId).scale;
  const groups = new Map<string, TrendSeries>();
  for (const pulse of pulses) {
    const item = point(pulse, questionId);
    if (!item) continue;
    const lengthDays = periodLengthDays(pulse.referenceStart, pulse.referenceEnd);
    const key = [pulse.teamId, pulse.instrumentVersion, questionId, scale, lengthDays].join('|');
    const series = groups.get(key) ?? {
      key,
      teamId: pulse.teamId,
      instrumentVersion: pulse.instrumentVersion,
      questionId,
      scale,
      lengthDays,
      points: [],
      segments: [],
    };
    series.points.push(item);
    groups.set(key, series);
  }
  return [...groups.values()]
    .map((series) => {
      const points = [...series.points].sort(
        (a, b) =>
          Date.parse(a.referenceStart) - Date.parse(b.referenceStart) ||
          a.pulseId.localeCompare(b.pulseId),
      );
      const unpublished = points.filter((item) => item.status !== 'published');
      const segments: TrendPoint[][] = [];
      let current: TrendPoint[] = [];
      for (const item of points.filter((entry) => entry.status === 'published')) {
        const previous = current.at(-1);
        const joined =
          previous !== undefined &&
          previous.referenceEnd === item.referenceStart &&
          !unpublished.some((gap) =>
            overlaps(gap, Date.parse(previous.referenceStart), Date.parse(item.referenceEnd)),
          );
        if (!joined && current.length) {
          segments.push(current);
          current = [];
        }
        current.push(item);
      }
      if (current.length) segments.push(current);
      return { ...series, points, segments };
    })
    .sort((a, b) => a.teamId.localeCompare(b.teamId) || a.lengthDays - b.lengthDays);
}

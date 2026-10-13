import { describe, expect, it } from 'vitest';
import { type Pulse, parsePulse } from './api';
import {
  cancelledPulse,
  closedQuestions,
  draftPulse,
  openPulse,
  type PulseFixture,
  pulse,
  pulseId,
  questionIds,
  suppressed,
  teamA,
  teamB,
  workspaceId,
} from './fixtures.test-support';
import { pointText } from './trend-chart';
import { buildTrendSeries } from './trends';

const day = 86_400_000;
function iso(dayOffset: number) {
  return new Date(Date.UTC(2026, 6, 1) + dayOffset * day).toISOString();
}
let next = 100;
function window(start: number, length: number, overrides: Partial<PulseFixture> = {}): Pulse {
  next += 1;
  const fixture =
    overrides.state === 'cancelled'
      ? cancelledPulse({ id: pulseId(next), openedAt: iso(start + length), ...overrides })
      : overrides.state === 'open'
        ? openPulse({
            id: pulseId(next),
            openedAt: iso(start + length),
            submittedCount: 1,
            ...overrides,
          })
        : overrides.state === 'draft'
          ? draftPulse({ id: pulseId(next), ...overrides })
          : pulse({
              id: pulseId(next),
              openedAt: iso(start + length),
              closedAt: `${iso(start + length + 3).slice(0, 10)}T12:00:00.000Z`,
              ...overrides,
            });
  return parsePulse(
    {
      pulse: {
        ...fixture,
        referenceStart: iso(start),
        referenceEnd: iso(start + length),
        ...(fixture.state === 'cancelled'
          ? { cancelledAt: `${iso(start + length + 1).slice(0, 10)}T12:00:00.000Z` }
          : {}),
      },
    },
    { workspaceId, role: 'owner' },
  );
}
function suppressedSatisfaction() {
  return closedQuestions().map((item) =>
    item.questionId === 'satisfaction' ? suppressed('satisfaction') : item,
  );
}

describe('SPACE question trends', () => {
  it('joins only adjacent published windows and breaks at suppressed periods', () => {
    const series = buildTrendSeries(
      [
        window(0, 14),
        window(14, 14),
        window(28, 14, { questions: suppressedSatisfaction() }),
        window(42, 14),
      ],
      'satisfaction',
    );
    expect(series).toHaveLength(1);
    expect(series[0]?.points.map((point) => point.status)).toEqual([
      'published',
      'published',
      'suppressed',
      'published',
    ]);
    expect(series[0]?.segments.map((segment) => segment.length)).toEqual([2, 1]);
    expect(series[0]?.points[2]?.mean).toBeNull();
  });
  it('breaks lines across missing intervals and intersecting open or cancelled windows', () => {
    const gap = buildTrendSeries([window(0, 14), window(21, 14)], 'satisfaction');
    expect(gap[0]?.segments.map((segment) => segment.length)).toEqual([1, 1]);
    const cancelled = buildTrendSeries(
      [window(0, 14), window(7, 14, { state: 'cancelled' }), window(14, 14)],
      'satisfaction',
    );
    expect(cancelled[0]?.segments.map((segment) => segment.length)).toEqual([1, 1]);
    expect(cancelled[0]?.points.map((point) => point.status)).toContain('cancelled');
    const open = buildTrendSeries(
      [window(0, 14), window(14, 14), window(28, 14, { state: 'open' })],
      'satisfaction',
    );
    expect(open[0]?.segments.map((segment) => segment.length)).toEqual([2]);
    expect(open[0]?.points.at(-1)?.status).toBe('open');
  });
  it('separates teams and reference-period lengths into their own series', () => {
    const series = buildTrendSeries(
      [
        window(0, 14),
        window(14, 7),
        window(0, 14, { teamId: teamB, teamName: 'Mobile' }),
        window(14, 14, { teamId: teamB, teamName: 'Mobile' }),
      ],
      'satisfaction',
    );
    expect(
      series.map((item) => [
        item.teamId,
        item.lengthDays,
        item.points.length,
        item.segments.length,
      ]),
    ).toEqual([
      [teamA, 7, 1, 1],
      [teamA, 14, 1, 1],
      [teamB, 14, 2, 1],
    ]);
  });
  it('keeps historical team names per point and excludes drafts', () => {
    const series = buildTrendSeries(
      [
        window(0, 14, { teamName: 'Platform' }),
        window(14, 14, { teamName: 'Platform Core' }),
        window(28, 14, { state: 'draft' }),
      ],
      'contribution_frequency',
    );
    expect(series[0]?.points.map((point) => point.teamName)).toEqual(['Platform', 'Platform Core']);
    expect(series[0]?.scale).toBe('frequency');
    expect(series[0]?.questionId).toBe('contribution_frequency');
  });
  it('never turns missing answers into zero values', () => {
    const series = buildTrendSeries(
      [window(0, 14, { questions: questionIds.map((id) => suppressed(id)) })],
      'focus_time',
    );
    expect(series[0]?.points[0]).toMatchObject({ status: 'suppressed', mean: null });
    expect(series[0]?.segments).toEqual([]);
  });
});

describe('trend point captured context', () => {
  it('distinguishes cancelled pulses that never opened from opened cohorts', () => {
    const never = window(0, 14, { state: 'cancelled', rosterSize: 5 });
    const neverOpened = parsePulse(
      {
        pulse: {
          ...cancelledPulse({ id: never.id, rosterSize: 5 }),
          referenceStart: never.referenceStart,
          referenceEnd: never.referenceEnd,
          openedAt: null,
          cancelledAt: never.cancelledAt,
        },
      },
      { workspaceId, role: 'owner' },
    );
    const opened = window(14, 14, { state: 'cancelled', rosterSize: 6 });
    const series = buildTrendSeries([neverOpened, opened], 'satisfaction');
    const [first, second] = series[0]?.points ?? [];
    expect(first?.opened).toBe(false);
    expect(second?.opened).toBe(true);
    const neverText = first ? pointText(first) : '';
    expect(neverText).toContain('Platform (name captured at cancellation)');
    expect(neverText).toContain('team size captured at cancellation 5');
    expect(neverText).not.toMatch(/frozen roster|at opening|answered|mean/);
    const openedText = second ? pointText(second) : '';
    expect(openedText).toContain('Platform (name at opening)');
    expect(openedText).toContain('frozen roster 6');
  });
});

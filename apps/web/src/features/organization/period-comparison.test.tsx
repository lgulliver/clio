import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { metricFixture } from '../measurements/fixtures.test-support';
import { type SavedCapture, windowKey } from './comparison-data';
import { PeriodComparison } from './period-comparison';
import { comparePeriods, deltaNumber } from './period-comparison-data';

function capture(
  start = '2026-01-03T00:00:00Z',
  end = '2026-01-05T00:00:00Z',
  result = metricFixture(true),
): SavedCapture {
  result.window = { ...result.window, start, end };
  return {
    id: start,
    window: { start, end },
    result,
    source: 'github',
    revision: 1,
    oemsRevision: 'pinned',
    completedAt: '2026-01-06T00:02:00Z',
    evidenceCutoff: result.evidence_cutoff,
    collectionEvidenceCutoff: result.evidence_cutoff,
    collectionCompletedAt: '2026-01-06T00:02:00Z',
    coverage: {
      collectionComplete: true,
      deploymentHistoryComplete: true,
      recoveryEvidenceComplete: true,
    },
  };
}
function previous(result = metricFixture(true)) {
  return capture('2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z', result);
}

describe('saved period differences', () => {
  it('uses normalized metric units and signed absolute differences, including zero baseline', () => {
    const current = capture();
    const before = previous();
    if (!current.result || !before.result) throw new Error('Missing metric fixture');
    current.result.deployment_frequency.deployments_per_day = 1.5;
    before.result.deployment_frequency.deployments_per_day = 0;
    current.result.change_lead_time.median_seconds = 10800;
    before.result.change_lead_time.median_seconds = 3600;
    current.result.change_fail_rate.ratio = 0.15;
    before.result.change_fail_rate.ratio = 0.1;
    current.result.deployment_rework_rate.ratio = 0.05;
    before.result.deployment_rework_rate.ratio = 0.15;
    current.result.failed_deployment_recovery_time.median_seconds = 1200;
    before.result.failed_deployment_recovery_time.median_seconds = 600;
    const result = comparePeriods(current, before);
    expect(result.metrics.map((metric) => metric.delta)).toEqual([1.5, 2, 5, -10, 10]);
    expect(deltaNumber(result.metrics[2]?.delta ?? null, 'pp')).toBe('+5 pp');
    expect(result.increased).toBe(true);
  });
  it('keeps zero complete and no-observations null distinct', () => {
    const result = comparePeriods(
      capture(undefined, undefined, metricFixture(true, true)),
      previous(metricFixture(true, true)),
    );
    expect(result.metrics[0]?.delta).toBe(0);
    expect(result.metrics[1]?.currentQuality?.status).toBe('no_observations');
    expect(result.metrics.slice(1).every((metric) => metric.delta === null)).toBe(true);
    expect(result.increased).toBe(false);
  });
  it('refuses numeric provisional recovery, legacy metrics and missing matches', () => {
    const result = comparePeriods(
      capture(undefined, undefined, metricFixture(false, false, true)),
      previous(),
    );
    expect(result.metrics[4]?.currentValue).not.toBeNull();
    expect(result.metrics[4]?.currentQuality?.status).toBe('provisional');
    expect(result.metrics[4]?.delta).toBeNull();
    expect(result.metrics[4]?.currentQuality?.quality_reasons.length).toBeGreaterThan(0);
    expect(
      comparePeriods({ ...capture(), result: undefined }, previous()).metrics.every(
        (metric) => metric.delta === null,
      ),
    ).toBe(true);
    expect(comparePeriods(capture(), undefined).contextReason).toMatch('Missing exact window');
  });
  it.each([{ source: 'argocd' }, { revision: 2 }, { oemsRevision: 'other' }])(
    'refuses context mismatch %j without substituting older captures',
    (patch) => {
      const result = comparePeriods(capture(), { ...previous(), ...patch });
      expect(result.contextReason).toMatch('Source or revision differs');
      expect(result.metrics.every((metric) => metric.delta === null)).toBe(true);
    },
  );
  it('accepts equivalent UTC spellings and separated equal windows; rejects overlaps, reversals, same and unequal windows', () => {
    expect(
      comparePeriods(capture(), capture('2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'))
        .contextReason,
    ).toBeUndefined();
    expect(
      comparePeriods(capture('2026-01-10T00:00:00Z', '2026-01-12T00:00:00Z'), previous())
        .contextReason,
    ).toBeUndefined();
    for (const before of [
      capture(),
      capture('2026-01-02T00:00:00Z', '2026-01-04T00:00:00Z'),
      capture('2026-01-05T00:00:00Z', '2026-01-07T00:00:00Z'),
    ])
      expect(comparePeriods(capture(), before).contextReason).toMatch('Previous window must end');
    expect(
      comparePeriods(capture(), capture('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'))
        .contextReason,
    ).toMatch('different lengths');
  });
  it('does not grade deployment-frequency direction or round tiny increases to zero', () => {
    const current = capture();
    const before = previous();
    if (!current.result) throw new Error('Missing metric fixture');
    current.result.deployment_frequency.deployments_per_day = 10;
    expect(comparePeriods(current, before).increased).toBe(false);
    expect(deltaNumber(0.0001, 'pp')).toBe('+<0.01 pp');
    expect(deltaNumber(-0.0001, 'h')).toBe('−<0.01 h');
  });
});

describe('period comparison presentation', () => {
  it('shows quality and saved clocks for both results and links affected service history', () => {
    const current = capture();
    const before = previous();
    const select = vi.fn();
    if (!current.result) throw new Error('Missing metric fixture');
    current.result.change_lead_time.median_seconds = 100000;
    render(
      <PeriodComparison
        rows={[
          { id: 'service', name: 'Payments', state: 'ready', selected: current, previous: before },
        ]}
        currentPeriod={windowKey(current.window)}
        previousPeriod={windowKey(before.window)}
        select={select}
      />,
    );
    fireEvent.click(
      screen.getByText('Services with increases in time or failure/rework rates (1)'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Payments: metric increases' }));
    expect(select).toHaveBeenCalledWith('service');
    fireEvent.click(screen.getByText('Both saved contexts'));
    expect(screen.getByRole('heading', { name: 'Previous' }).parentElement).toHaveTextContent(
      before.evidenceCutoff,
    );
    expect(screen.getByRole('heading', { name: 'Current' }).parentElement).toHaveTextContent(
      'Connection/mapping revision: 1',
    );
  });
  it('hides cached numeric values during loading or failed history reads', () => {
    const current = capture();
    const before = previous();
    const retry = vi.fn();
    render(
      <PeriodComparison
        rows={[
          {
            id: 'loading',
            name: 'Loading service',
            state: 'loading',
            selected: current,
            previous: before,
          },
          {
            id: 'failed',
            name: 'Failed service',
            state: 'error',
            error: 'Saved history unavailable.',
            retry,
            selected: current,
            previous: before,
          },
        ]}
        currentPeriod={windowKey(current.window)}
        previousPeriod={windowKey(before.window)}
        select={vi.fn()}
      />,
    );
    const table = screen.getByRole('table');
    expect(table).toHaveTextContent('Loading saved results');
    expect(table).toHaveTextContent('Saved history unavailable');
    expect(screen.getByRole('status')).toHaveTextContent('Loading saved results');
    expect(screen.getByRole('alert')).toHaveTextContent('Saved history unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry Failed service' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(within(table).queryByText(/Previous:/)).not.toBeInTheDocument();
    expect(
      screen.getByText('Services with increases in time or failure/rework rates (0)'),
    ).toBeVisible();
  });
});

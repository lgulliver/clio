import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { metricFixture } from './fixtures.test-support';
import { comparableSamples, distinctPeriods, MetricTrends } from './metric-trends';

function sample(id: string, start: string, end: string) {
  const result = metricFixture(true);
  result.window = { ...result.window, start, end };
  return { id, result };
}
describe('reporting-period trends', () => {
  it('uses newest capture once per window and sorts by reporting time', () => {
    const recent = sample('new', '2026-02-01T00:00:00.000Z', '2026-02-03T00:00:00.000Z');
    const old = { ...recent, id: 'old' };
    const earlier = sample('earlier', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
    expect(distinctPeriods([recent, old, earlier]).map((s) => s.id)).toEqual(['earlier', 'new']);
  });
  it('shows one-period state and lets metric controls switch metric', () => {
    render(
      <MetricTrends
        samples={[sample('one', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z')]}
      />,
    );
    expect(screen.getByText(/One saved reporting period/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Recovery time' }));
    expect(screen.getByRole('button', { name: 'Recovery time' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('img')).toHaveAccessibleName(
      /Recovery time by reporting period; minutes/,
    );
  });
  it('retains unavailable values as gaps rather than zeroes in accessible chart data', () => {
    const missing = sample('missing', '2026-02-01T00:00:00.000Z', '2026-02-03T00:00:00.000Z');
    missing.result.change_lead_time.median_seconds = null;
    render(
      <MetricTrends
        samples={[
          missing,
          sample('earlier', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Lead time' }));
    fireEvent.click(screen.getByText('Chart data and quality', { selector: 'summary' }));
    expect(within(screen.getByRole('table')).getByText('Unavailable')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Reporting periods'), { target: { value: '30' } });
    expect(screen.getByText(/One saved reporting period/)).toBeVisible();
  });
});

it('separates sources, revisions and standards while honoring selected capture', () => {
  const selected = {
    ...sample('selected', '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z'),
    source: 'github',
    revision: 1,
    oemsRevision: 'pinned',
  };
  const older = {
    ...selected,
    id: 'old',
    result: {
      ...selected.result,
      window: {
        ...selected.result.window,
        start: '2025-12-01T00:00:00Z',
        end: '2025-12-03T00:00:00Z',
      },
    },
  };
  const captures = [
    { ...selected, id: 'newer' },
    { ...older, id: 'other-provider', source: 'argocd' },
    { ...older, id: 'other-revision', revision: 2 },
    { ...older, id: 'other-standard', oemsRevision: 'other' },
    older,
  ];
  expect(comparableSamples(captures, selected).map((s) => s.id)).toEqual(['old', 'selected']);
});

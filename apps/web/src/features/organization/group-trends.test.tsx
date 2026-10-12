import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { metricFixture } from '../measurements/fixtures.test-support';
import {
  comparisonSeries,
  reportingWindows,
  type SavedCapture,
  selectedCapture,
  windowKey,
} from './comparison-data';
import { GroupTrends } from './group-trends';

function capture(id: string, month: string, complete = true): SavedCapture {
  const result = metricFixture(complete);
  const window = { start: `2025-${month}-01T00:00:00Z`, end: `2025-${month}-03T00:00:00Z` };
  result.window = { ...result.window, ...window };
  return {
    id,
    window,
    result,
    source: 'github',
    revision: 1,
    oemsRevision: 'pinned',
    completedAt: '2026-01-04T00:02:00Z',
    evidenceCutoff: result.evidence_cutoff,
    collectionEvidenceCutoff: result.evidence_cutoff,
    collectionCompletedAt: '2026-01-04T00:02:00Z',
    coverage: {
      collectionComplete: complete,
      deploymentHistoryComplete: complete,
      recoveryEvidenceComplete: complete,
    },
  };
}
describe('shared reporting periods', () => {
  it('selects newest exact capture, normalizes timestamp spellings and preserves different end bounds', () => {
    const recent = capture('latest-period', '12');
    const selected = capture('newest-selected', '10');
    const equivalent = {
      ...selected,
      id: 'older-selected',
      window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-03T00:00:00.000Z' },
    };
    const different = {
      ...selected,
      id: 'different-end',
      window: { ...selected.window, end: '2025-10-04T00:00:00Z' },
    };
    const history = [recent, selected, equivalent, different];
    expect(reportingWindows([history])).toHaveLength(3);
    expect(selectedCapture(history, windowKey(selected.window))?.id).toBe('newest-selected');
    expect(selectedCapture(history, 'latest')?.id).toBe('latest-period');
    expect(selectedCapture([recent], windowKey(selected.window))).toBeUndefined();
  });
  it('keeps revision/provider/standard fences, cutoff period and latest legacy gaps', () => {
    const selected = capture('selected', '12');
    const earlier = capture('earlier', '10');
    const legacy = { ...capture('legacy', '11'), result: undefined };
    const history = [
      selected,
      legacy,
      { ...legacy, id: 'older-with-metrics', result: metricFixture() },
      earlier,
      { ...earlier, id: 'wrong-revision', revision: 2 },
      { ...earlier, id: 'wrong-provider', source: 'argocd' },
      { ...earlier, id: 'wrong-standard', oemsRevision: 'different' },
      capture('future-period', '12'),
    ];
    expect(comparisonSeries(history, selected).map((sample) => sample.id)).toEqual([
      'earlier',
      'legacy',
      'selected',
    ]);
    expect(comparisonSeries(history, earlier).map((sample) => sample.id)).toEqual([
      'earlier',
      'legacy',
      'selected',
    ]);
    expect(
      comparisonSeries(history, earlier, windowKey(earlier.window)).map((sample) => sample.id),
    ).toEqual(['earlier']);
    expect(comparisonSeries(history, selected)[1]?.result).toBeUndefined();
  });
});

describe('group service trends', () => {
  it('keeps separate series, breaks at unavailable values and exposes quality and exact windows', async () => {
    const first = capture('first', '10');
    const unavailable = capture('gap', '11', false);
    const last = capture('last', '12');
    if (!first.result) throw new Error('Missing metric fixture');
    first.result.change_lead_time.median_seconds = 0;
    render(
      <GroupTrends
        period="latest"
        series={[
          {
            id: 'payments',
            name: 'Payments',
            state: 'ready',
            selected: last,
            samples: [first, unavailable, last],
          },
          {
            id: 'customers',
            name: 'Customers',
            state: 'ready',
            selected: last,
            samples: [first, capture('middle', '11'), last],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Lead time' }));
    const image = screen.getByRole('img');
    expect(image).toHaveAccessibleName(/Lead time.*hours.*Separate service series/);
    const payments = image.querySelector('g[aria-label="Payments"]');
    expect(payments?.querySelectorAll('circle')).toHaveLength(2);
    expect(payments?.querySelectorAll('path')).toHaveLength(2);
    expect(
      [...(payments?.querySelectorAll('path') ?? [])].every(
        (path) => !path.getAttribute('d')?.includes('L'),
      ),
    ).toBe(true);
    expect(payments?.querySelector('circle')).toHaveAttribute('cy', '176');
    fireEvent.click(screen.getByText('Chart data and quality', { selector: 'summary' }));
    const table = await screen.findByRole('table');
    const gap = within(table)
      .getAllByRole('row')
      .find(
        (row) => row.textContent?.includes('Payments') && row.textContent.includes('2025-11-01'),
      );
    expect(gap).toHaveTextContent('Unavailable');
    expect(gap).toHaveTextContent('provisional');
    expect(gap).toHaveTextContent('incomplete history');
    expect(gap).toHaveTextContent('OEMS: pinned');
    expect(gap).toHaveTextContent('Evidence cutoff:');
  });
  it('discloses absent exact windows and one-period history without interpolating a missing service', async () => {
    const only = capture('only', '10');
    render(
      <GroupTrends
        period={windowKey(only.window)}
        series={[
          { id: 'present', name: 'Present', state: 'ready', selected: only, samples: [only] },
          { id: 'missing', name: 'Missing', state: 'ready', selected: undefined, samples: [] },
        ]}
      />,
    );
    expect(screen.getByText(/One saved reporting period/)).toBeVisible();
    expect(screen.getByText('No result for selected window')).toBeVisible();
    fireEvent.click(screen.getByText('Chart data and quality', { selector: 'summary' }));
    const row = within(await screen.findByRole('table'))
      .getAllByRole('row')
      .find((item) => item.textContent?.startsWith('Missing'));
    expect(row).toHaveTextContent('No saved result for this window');
    expect(row).toHaveTextContent('Unavailable');
  });
  it('keeps failed and pending reads distinct from empty saved history', () => {
    const series = { id: 'service', name: 'Service', selected: undefined, samples: [] };
    const view = render(<GroupTrends period="latest" series={[{ ...series, state: 'loading' }]} />);
    expect(screen.getByText('Loading saved service trends…')).toBeVisible();
    view.rerender(<GroupTrends period="latest" series={[{ ...series, state: 'error' }]} />);
    expect(screen.getByText(/unavailable until history reads succeed/)).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

it('uses elapsed time and never connects unknown intervals just because no other service recorded them', () => {
  const first = capture('jan', '01');
  const middle = capture('feb', '02');
  const last = capture('sep', '09');
  const service = {
    id: 'time',
    name: 'Time series',
    state: 'ready' as const,
    selected: last,
    samples: [first, middle, last],
  };
  const view = render(<GroupTrends period="latest" series={[service]} />);
  const graphic = screen.getByRole('img').querySelector('g[aria-label="Time series"]');
  expect(graphic?.querySelectorAll('path')).toHaveLength(3);
  const positions = [...(graphic?.querySelectorAll('circle') ?? [])].map((point) =>
    Number(point.getAttribute('cx')),
  );
  expect((positions[1] ?? 0) - (positions[0] ?? 0)).toBeLessThan(
    ((positions[2] ?? 0) - (positions[1] ?? 0)) / 4,
  );
  view.rerender(
    <GroupTrends
      period="latest"
      series={[
        service,
        {
          id: 'other',
          name: 'Other service',
          state: 'ready',
          selected: capture('june', '06'),
          samples: [capture('june', '06')],
        },
      ]}
    />,
  );
  expect(
    screen.getByRole('img').querySelector('g[aria-label="Time series"]')?.querySelectorAll('path'),
  ).toHaveLength(3);
});

it('connects adjacent windows but leaves overlapping windows as separate observations', () => {
  const first = capture('first', '10');
  const next = capture('next', '10');
  next.window = { start: first.window.end, end: '2025-10-05T00:00:00Z' };
  const service = {
    id: 'adjacent',
    name: 'Adjacent',
    state: 'ready' as const,
    selected: next,
    samples: [first, next],
  };
  const view = render(<GroupTrends period="latest" series={[service]} />);
  expect(screen.getByRole('img').querySelector('g[aria-label="Adjacent"] path')).toHaveAttribute(
    'd',
    expect.stringContaining(' L'),
  );
  const overlapping = {
    ...next,
    window: { start: first.window.start, end: '2025-10-31T00:00:00Z' },
  };
  view.rerender(
    <GroupTrends
      period="latest"
      series={[{ ...service, selected: overlapping, samples: [first, overlapping] }]}
    />,
  );
  const paths = screen.getByRole('img').querySelectorAll('g[aria-label="Adjacent"] path');
  expect(paths).toHaveLength(2);
  expect([...paths].every((path) => !path.getAttribute('d')?.includes(' L'))).toBe(true);
});

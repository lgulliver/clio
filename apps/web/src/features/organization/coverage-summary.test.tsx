import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFixture, scope } from '../measurement-evidence/fixtures.test-support';
import { metricFixture } from '../measurements/fixtures.test-support';
import { type ComparisonRow, parseComparison, type SavedCapture } from './comparison-data';
import { CoverageSummary } from './coverage-summary';
import { coverageSummary } from './coverage-summary-data';

const now = Date.parse('2026-01-20T00:00:00Z');
function capture(result = metricFixture(true)): SavedCapture {
  return {
    id: 'capture',
    window: result.window,
    result,
    source: 'github',
    revision: 1,
    oemsRevision: 'pinned',
    completedAt: '2026-01-19T00:00:00Z',
    evidenceCutoff: '2026-01-18T00:00:00Z',
    collectionEvidenceCutoff: '2026-01-18T00:00:00Z',
    collectionCompletedAt: '2026-01-19T00:00:00Z',
    coverage: {
      collectionComplete: true,
      deploymentHistoryComplete: true,
      recoveryEvidenceComplete: true,
    },
  };
}
function row(
  id: string,
  selected: SavedCapture | undefined,
  state: ComparisonRow['state'] = 'ready',
): ComparisonRow {
  return { id, name: id, state, selected };
}
afterEach(() => vi.useRealTimers());
describe('coverage and freshness summary', () => {
  it('normalizes independent measurement clocks from parsed source data', () => {
    const run = runFixture();
    const parsed = parseComparison({ runs: [run], nextCursor: null }, scope, 'measurement')[0];
    expect(parsed?.collectionEvidenceCutoff).toBe(run.result?.basisEvidenceCutoff);
    expect(parsed?.evidenceCutoff).toBe(run.result?.evidenceCutoff);
    expect(parsed?.collectionCompletedAt).toBeNull();
    expect(parsed?.completedAt).toBe(run.completedAt);
  });
  it('partitions unknown reads, missing results, legacy and empty observations without claiming coverage', () => {
    const rows = [
      row('complete', capture()),
      row('empty', capture(metricFixture(true, true))),
      row('legacy', { ...capture(), result: undefined }),
      row('missing', undefined),
      row('loading', capture(), 'loading'),
      row('failed', capture(), 'error'),
    ];
    const summary = coverageSummary(rows, now, 7);
    expect(summary.saved.map((item) => item.id)).toEqual(['complete', 'empty', 'legacy']);
    expect(summary.missing.map((item) => item.id)).toEqual(['missing']);
    expect(summary.legacy.map((item) => item.id)).toEqual(['legacy']);
    expect(summary.metrics[0]?.complete.map((item) => item.id)).toEqual(['complete', 'empty']);
    expect(summary.metrics[1]?.noObservations.map((item) => item.id)).toEqual(['empty']);
    expect(summary.metrics[0]?.unknown.map((item) => item.id)).toEqual([
      'legacy',
      'missing',
      'loading',
      'failed',
    ]);
    expect(coverageSummary([], now, 7).oldestCollection).toBeUndefined();
    expect(coverageSummary([], now, 7).coverage[0]?.complete).toEqual([]);
  });
  it('keeps fresh independent measurement separate from old collection basis and completion', () => {
    const measured = {
      ...capture(),
      collectionEvidenceCutoff: '2026-01-01T00:00:00Z',
      collectionCompletedAt: null,
    };
    const summary = coverageSummary(
      [row('measurement', measured), row('failed', capture(), 'error')],
      now,
      7,
    );
    expect(summary.old.map((item) => item.id)).toEqual(['measurement']);
    expect(summary.oldestCollection).toBe('2026-01-01T00:00:00Z');
    expect(summary.oldestResult).toBe('2026-01-18T00:00:00Z');
    expect(summary.latestSaved).toBe('2026-01-19T00:00:00Z');
    expect(summary.latestCollection).toBeUndefined();
  });
  it('does not upgrade provisional metrics from complete coverage declarations', () => {
    const summary = coverageSummary([row('provisional', capture(metricFixture(false)))], now, 7);
    expect(summary.coverage[0]?.complete).toHaveLength(1);
    expect(summary.metrics[0]?.provisional).toHaveLength(1);
    expect(summary.metrics[0]?.complete).toHaveLength(0);
  });
  it('orders microsecond cutoffs and separates future clock values from older evidence', () => {
    const summary = coverageSummary(
      [
        row('boundary', { ...capture(), collectionEvidenceCutoff: '2026-01-13T00:00:00Z' }),
        row('old', { ...capture(), collectionEvidenceCutoff: '2026-01-12T23:59:59.999999Z' }),
        row('future', { ...capture(), collectionEvidenceCutoff: '2026-01-20T00:00:00.000001Z' }),
      ],
      now,
      7,
    );
    expect(summary.old.map((item) => item.id)).toEqual(['old']);
    expect(summary.ahead.map((item) => item.id)).toEqual(['future']);
    expect(summary.oldestCollection).toBe('2026-01-12T23:59:59.999999Z');
  });
  it('changes age threshold locally and drills into affected services with exact page context', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const select = vi.fn();
    render(
      <CoverageSummary
        rows={[row('Payments', capture()), row('Missing', undefined)]}
        totalServices={12}
        page={1}
        period="latest"
        source="GitHub Deployments"
        select={select}
      />,
    );
    const region = screen.getByRole('region', { name: 'Coverage and freshness' });
    expect(region).toHaveTextContent('Page 2: 2 of 12 services');
    expect(region).toHaveTextContent('Older collection evidence (0)');
    fireEvent.change(screen.getByLabelText('Highlight collection evidence older than'), {
      target: { value: '1' },
    });
    expect(region).toHaveTextContent('Older collection evidence (1)');
    expect(region).toHaveTextContent('Collection evidence older than 1 day');
    expect(region).not.toHaveTextContent('1 days');
    fireEvent.click(within(region).getByText('Older collection evidence (1)'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect Payments: older collection evidence' }),
    );
    expect(select).toHaveBeenCalledWith('Payments');
    fireEvent.click(within(region).getByText('Missing results (1)'));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Missing: missing results' }));
    expect(select).toHaveBeenLastCalledWith('Missing');
  });
});

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { metricFixture } from './fixtures.test-support';
import { MetricResults } from './metric-results';

describe('five engineering metrics', () => {
  it('distinguishes provider regions when multiple source results are visible', () => {
    render(
      <>
        <MetricResults result={metricFixture(true)} sourceLabel="GitHub" />
        <MetricResults result={metricFixture(true)} sourceLabel="Argo CD" />
      </>,
    );
    expect(screen.getByRole('region', { name: 'GitHub: Engineering metrics' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Argo CD: Engineering metrics' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'GitHub: Change lead time' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Argo CD: Change lead time' })).toBeVisible();
  });
  it('shows calculated complete values with units and per-metric quality', () => {
    render(<MetricResults result={metricFixture(true)} />);
    expect(screen.getAllByText('Status: complete.')).toHaveLength(5);
    expect(screen.getByRole('region', { name: 'Deployment frequency' })).toHaveTextContent(
      '0.5 deployments per day',
    );
    expect(screen.getByRole('region', { name: 'Change lead time' })).toHaveTextContent(
      'Confirmed median: 86,400 seconds',
    );
    expect(screen.getByRole('region', { name: 'Change failure rate' })).toHaveTextContent(
      'Rate: 100%',
    );
    expect(screen.getByRole('region', { name: 'Deployment rework rate' })).toHaveTextContent(
      'Rate: 0%',
    );
    expect(
      screen.getByRole('region', { name: 'Failed deployment recovery time' }),
    ).toHaveTextContent('Observed exact recovery median: 600 seconds');
  });
  it('shows provisional bounds/candidates and separates exact, approximate and open recovery', () => {
    const result = metricFixture(false, false, true);
    render(<MetricResults result={result} />);
    expect(screen.getAllByText('Status: provisional.')).toHaveLength(5);
    const lead = screen.getByRole('region', { name: 'Change lead time' });
    expect(lead).toHaveTextContent(
      'Confirmed median: Unavailable. Confirmed observations: 0. Observed candidates: 1',
    );
    const ratio = screen.getByRole('region', { name: 'Change failure rate' });
    expect(ratio).toHaveTextContent(
      'Rate: Unavailable. Numerator: 1. Denominator: 1. Unknown classifications: 0',
    );
    expect(ratio).toHaveTextContent('Bounds: 100% to 100%. Bounds scope: observed population');
    const recovery = screen.getByRole('region', { name: 'Failed deployment recovery time' });
    expect(recovery).toHaveTextContent('Observed exact recovery median: 600 seconds');
    expect(recovery).toHaveTextContent(
      'Observed approximate recovery median: 120 seconds. Approximate episodes: 1. Open episodes: 1',
    );
  });
  it('shows unknown classification bounds without turning missing rates into zero', () => {
    render(<MetricResults result={metricFixture(false, false, false, true)} />);
    for (const name of ['Change failure rate', 'Deployment rework rate']) {
      const ratio = screen.getByRole('region', { name });
      expect(ratio).toHaveTextContent(
        'Rate: Unavailable. Numerator: 0. Denominator: 1. Unknown classifications: 1',
      );
      expect(ratio).toHaveTextContent('Bounds: 0% to 100%. Bounds scope: observed population');
    }
  });
  it.each([true, false])('keeps empty complete=%s ratios and durations unavailable', (complete) => {
    render(<MetricResults result={metricFixture(complete, true)} />);
    expect(screen.getByRole('region', { name: 'Change failure rate' })).toHaveTextContent(
      'Rate: Unavailable. Numerator: 0. Denominator: 0',
    );
    expect(screen.getByRole('region', { name: 'Change lead time' })).toHaveTextContent(
      'Confirmed median: Unavailable',
    );
    if (complete) expect(screen.getAllByText('Status: no observations.')).toHaveLength(4);
    else expect(screen.getAllByText('Status: provisional.')).toHaveLength(5);
    expect(
      within(screen.getByRole('region', { name: 'Failed deployment recovery time' })).getByText(
        /Observed exact recovery median/,
      ),
    ).toHaveTextContent('Unavailable');
  });
  it('identifies older results without recalculation', () => {
    render(<MetricResults result={undefined} />);
    expect(screen.getByText(/older saved result/)).toHaveTextContent(
      'No measurements were recalculated',
    );
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { metricFixture } from './fixtures.test-support';
import { MetricResults } from './metric-results';

describe('five engineering metrics', () => {
  it('preserves ratio precision in evidence when percentage display rounds', async () => {
    const user = userEvent.setup();
    const result = metricFixture(true);
    result.change_fail_rate = {
      ...result.change_fail_rate,
      ratio: 0.99996,
      numerator: 24999,
      denominator: 25000,
      lower_bound: 0.99996,
      upper_bound: 0.99996,
    };
    render(<MetricResults result={result} />);
    const card = screen.getByRole('region', { name: 'Change failure rate' });
    expect(within(card).getByText('100%')).toBeVisible();
    const raw = within(card).getByText('Raw ratio: 0.99996. Raw bounds: 0.99996 to 0.99996.');
    expect(raw).not.toBeVisible();
    await user.click(within(card).getByText('Evidence details', { selector: 'summary' }));
    expect(raw).toBeVisible();
  });
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
    expect(
      within(screen.getByRole('region', { name: 'Change failure rate' })).getByText('100%'),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Deployment rework rate' })).getByText('0%'),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Change failure rate' })).getByText(
        'Bounds: 100% to 100% (full population).',
      ),
    ).toBeVisible();
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
    expect(
      within(lead).getByText('Confirmed observations: 0; observed candidates: 1.'),
    ).toBeVisible();
    expect(within(lead).getByText('Unavailable')).toBeVisible();
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
        /Observed exact recovery median:/,
      ),
    ).toHaveTextContent('Unavailable');
  });
  it('keeps complete zero deployment counts distinct from absent duration and ratio observations', () => {
    render(<MetricResults result={metricFixture(true, true)} />);
    const frequency = screen.getByRole('region', { name: 'Deployment frequency' });
    expect(within(frequency).getByText('Status: complete.')).toBeVisible();
    expect(within(frequency).getByText('0')).toBeVisible();
    expect(within(frequency).getByText('deployments per day')).toBeVisible();
    for (const name of [
      'Change lead time',
      'Change failure rate',
      'Deployment rework rate',
      'Failed deployment recovery time',
    ]) {
      const metric = screen.getByRole('region', { name });
      expect(within(metric).getByText('Status: no observations.')).toBeVisible();
      expect(within(metric).getByText('Unavailable')).toBeVisible();
    }
  });
  it('keeps partial nonnull recovery values and all quality reasons visible before disclosure', () => {
    const result = metricFixture(false, false, true);
    render(<MetricResults result={result} />);
    const recovery = screen.getByRole('region', { name: 'Failed deployment recovery time' });
    expect(within(recovery).getByText('600')).toBeVisible();
    expect(within(recovery).getByText('Status: provisional.')).toBeVisible();
    expect(within(recovery).getByText(/Observed evidence only/)).toBeVisible();
    expect(
      within(recovery).getByText('Approximate episodes: 1; median: 120 seconds.'),
    ).toBeVisible();
    expect(within(recovery).getByText('Open episodes: 1; unresolved episodes: 0.')).toBeVisible();
    for (const region of screen.getAllByRole('region').slice(1)) {
      const quality = within(region).getByText(/^Quality:/);
      expect(quality).toBeVisible();
    }
    for (const reason of result.failed_deployment_recovery_time.quality_reasons) {
      expect(within(recovery).getByText(/^Quality:/)).toHaveTextContent(
        reason.replaceAll('_', ' '),
      );
    }
  });
  it('shows unknown classifications and observed bounds without disclosure', () => {
    render(<MetricResults result={metricFixture(false, false, false, true)} />);
    for (const name of ['Change failure rate', 'Deployment rework rate']) {
      const ratio = screen.getByRole('region', { name });
      expect(within(ratio).getByText('Unavailable')).toBeVisible();
      expect(
        within(ratio).getByText('0 of 1 deployments; 1 unknown classifications.'),
      ).toBeVisible();
      expect(within(ratio).getByText('Bounds: 0% to 100% (observed population).')).toBeVisible();
    }
  });
  it('keeps native disclosures focusable and independently opens and closes source evidence', async () => {
    const user = userEvent.setup();
    render(
      <>
        <MetricResults result={metricFixture(true)} sourceLabel="GitHub" />
        <MetricResults result={metricFixture(false)} sourceLabel="Argo CD" />
      </>,
    );
    const github = screen.getByRole('region', { name: 'GitHub: Deployment frequency' });
    const argo = screen.getByRole('region', { name: 'Argo CD: Deployment frequency' });
    const summary = within(github).getByText('Evidence details');
    const evidence = within(github).getByText(/Observed deployment count: 1. Rate:/);
    expect(evidence).not.toBeVisible();
    await user.tab();
    expect(summary).toHaveFocus();
    // jsdom does not implement Enter/Space activation for native summaries.
    // Real-browser keyboard verification remains required; clicks exercise disclosure here.
    await user.click(summary);
    expect(evidence).toBeVisible();
    expect(within(argo).getByText(/Observed deployment count: 1. Rate:/)).not.toBeVisible();
    await user.click(summary);
    expect(evidence).not.toBeVisible();
    expect(summary).toHaveFocus();
  });
  it('preserves fractional raw seconds in evidence rather than rounding away precision', () => {
    const result = metricFixture(true);
    result.change_lead_time.median_seconds = 0.123456789;
    render(<MetricResults result={result} />);
    expect(screen.getByRole('region', { name: 'Change lead time' })).toHaveTextContent(
      'Confirmed median: 0.123456789 seconds',
    );
  });
  it('identifies older results without recalculation', () => {
    render(<MetricResults result={undefined} />);
    expect(screen.getByText(/older saved result/)).toHaveTextContent(
      'No measurements were recalculated',
    );
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});

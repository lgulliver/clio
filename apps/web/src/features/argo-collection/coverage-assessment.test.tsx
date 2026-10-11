import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CoverageAssessment } from './coverage-assessment';

it('older saved result cannot be mistaken for zero missing evidence', () => {
  render(<CoverageAssessment assessment={undefined} />);
  expect(screen.getByRole('region', { name: 'Coverage evidence needed' })).toHaveTextContent(
    'This older result has no saved coverage assessment.',
  );
  expect(screen.getByText(/Missing assessment does not mean complete coverage/)).toBeVisible();
  expect(
    screen.queryByText(/Unknown qualification across retained history: 0/),
  ).not.toBeInTheDocument();
});

import { describe, expect, it } from 'vitest';
import {
  defaultReferenceInputs,
  formatReferencePeriod,
  inputsFromReference,
  referenceFromInputs,
} from './period';

const now = new Date('2026-10-13T15:30:00.000Z');

describe('pulse reference periods', () => {
  it('defaults to the previous 14 UTC calendar days with an exclusive end', () => {
    const inputs = defaultReferenceInputs(now);
    expect(inputs).toEqual({ firstDay: '2026-09-29', lastDay: '2026-10-12' });
    expect(referenceFromInputs(inputs.firstDay, inputs.lastDay, now)).toEqual({
      referenceStart: '2026-09-29T00:00:00.000Z',
      referenceEnd: '2026-10-13T00:00:00.000Z',
    });
  });
  it('rejects periods that include today, run backwards or use invalid dates', () => {
    expect(referenceFromInputs('2026-10-01', '2026-10-13', now)).toEqual({
      error: 'The reference period must end before today (UTC).',
    });
    expect(referenceFromInputs('2026-10-05', '2026-10-01', now)).toEqual({
      error: 'The first day must be on or before the last day.',
    });
    expect(referenceFromInputs('2026-02-30', '2026-03-02', now)).toEqual({
      error: 'Enter valid first and last days.',
    });
    expect(referenceFromInputs('', '2026-10-01', now)).toEqual({
      error: 'Enter valid first and last days.',
    });
  });
  it('round-trips saved bounds and describes the exclusive end', () => {
    expect(inputsFromReference('2026-09-29T00:00:00.000Z', '2026-10-13T00:00:00.000Z')).toEqual({
      firstDay: '2026-09-29',
      lastDay: '2026-10-12',
    });
    expect(formatReferencePeriod('2026-09-29T00:00:00.000Z', '2026-10-13T00:00:00.000Z')).toBe(
      '29 Sept 2026 to 12 Oct 2026 (14 UTC days; ends before 13 Oct 2026)',
    );
  });
});

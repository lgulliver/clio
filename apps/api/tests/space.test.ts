import { describe, expect, it } from 'vitest';
import { aggregateQuestion, aggregateResponses } from '../src/features/space/contract.ts';
import { parseDraft, parseMinimum, parseResponse } from '../src/features/space/input.ts';

const answers = {
  satisfaction: null,
  sustainable_workload: null,
  useful_outcomes: null,
  contribution_frequency: null,
  useful_help: null,
  shared_context: null,
  effective_tools: null,
  focus_time: null,
};
const body = { instrumentVersion: 'clio.space.pulse.v1', answers };
describe('SPACE confidential contract', () => {
  it('does not distinguish zero from small non-null cohorts and never borrows skipped answers', () => {
    expect(aggregateQuestion([null, null, null], 3)).toEqual({ status: 'suppressed', mean: null });
    expect(aggregateQuestion([1, 5, null], 3)).toEqual({ status: 'suppressed', mean: null });
    expect(aggregateQuestion([1, 5, 3], 3)).toEqual({
      status: 'published',
      mean: 3,
      answeredCount: 3,
    });
    const result = aggregateResponses(
      [
        { ...answers, satisfaction: 1 },
        { ...answers, satisfaction: 5 },
        { ...answers, satisfaction: 3 },
      ],
      3,
    );
    expect(result).toHaveLength(8);
    expect(result[0]).toEqual({
      questionId: 'satisfaction',
      status: 'published',
      mean: 3,
      answeredCount: 3,
    });
    expect(result.slice(1).every((q) => q.status === 'suppressed' && !('answeredCount' in q))).toBe(
      true,
    );
  });
  it('accepts all-null responses but rejects missing, additional and invalid data', () => {
    expect(parseResponse(body)).toEqual(answers);
    for (const value of [
      undefined,
      [],
      {},
      { ...body, userId: 'someone' },
      { ...body, instrumentVersion: 'other' },
      { ...body, answers: { ...answers, extra: null } },
      { ...body, answers: { satisfaction: null } },
      ...[0, 6, 1.5, '3', false].map((value) => ({
        ...body,
        answers: { ...answers, focus_time: value },
      })),
    ])
      expect(() => parseResponse(value)).toThrow();
  });
  it('requires bounded integer minimum and past UTC calendar periods', () => {
    expect(parseMinimum(3)).toBe(3);
    expect(parseMinimum(1000)).toBe(1000);
    for (const value of [null, undefined, 2, 1001, 3.1, '3'])
      expect(() => parseMinimum(value)).toThrow();
    const draft = {
      teamId: '00000000-0000-0000-0000-000000000001',
      referenceStart: '2026-09-01T00:00:00.000Z',
      referenceEnd: '2026-09-15T00:00:00.000Z',
    };
    expect(parseDraft(draft, new Date('2026-10-01T15:00:00Z'))).toEqual(draft);
    for (const value of [
      { ...draft, referenceEnd: '2026-10-02T00:00:00.000Z' },
      { ...draft, referenceStart: draft.referenceEnd },
      { ...draft, referenceEnd: '2026-09-15T01:00:00.000Z' },
      { ...draft, referenceEnd: '2026-02-30T00:00:00.000Z' },
      { ...draft, referenceEnd: '2026-09-15' },
      { ...draft, unexpected: true },
    ])
      expect(() => parseDraft(value, new Date('2026-10-01T15:00:00Z'))).toThrow();
  });
});

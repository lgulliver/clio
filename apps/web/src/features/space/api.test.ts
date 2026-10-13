import { describe, expect, it } from 'vitest';
import {
  emptyAnswers,
  parseAssignmentPage,
  parseAssignmentUpdate,
  parseInstrument,
  parseOwnAssignment,
  parsePreferences,
  parsePulse,
  parsePulsePage,
  parseSubmission,
  responseBody,
} from './api';
import {
  cancelledPulse,
  closedQuestions,
  draftPulse,
  historyId,
  instrumentBody,
  openPulse,
  page,
  published,
  pulse,
  pulseId,
  questionIds,
  suppressed,
  teamA,
  teamB,
  workspaceId,
} from './fixtures.test-support';

const owner = { workspaceId, role: 'owner' as const };
const member = { workspaceId, role: 'member' as const };

describe('SPACE instrument parsing', () => {
  it('accepts only the eight original items in their fixed order', () => {
    const instrument = parseInstrument(instrumentBody());
    expect(instrument.questions.map((question) => question.id)).toEqual([...questionIds]);
    expect(instrument.scales.frequency).toEqual([
      'never',
      'rarely',
      'sometimes',
      'often',
      'very often',
    ]);
  });
  it('rejects altered prompts, reordered items, extra fields and other versions', () => {
    const altered = instrumentBody();
    const first = altered.instrument.questions[0];
    if (first) first.prompt = 'I was productive.';
    expect(() => parseInstrument(altered)).toThrow();
    const reordered = instrumentBody();
    reordered.instrument.questions.reverse();
    expect(() => parseInstrument(reordered)).toThrow();
    expect(() =>
      parseInstrument({ instrument: { ...instrumentBody().instrument, score: 4 } }),
    ).toThrow();
    expect(() =>
      parseInstrument({ instrument: { ...instrumentBody().instrument, version: 'v2' } }),
    ).toThrow();
  });
});

describe('SPACE pulse result parsing', () => {
  it('represents zero and small below-minimum answers identically with no count', () => {
    const zero = parsePulse({ pulse: pulse() }, owner);
    const small = parsePulse(
      {
        pulse: pulse({
          questions: closedQuestions().map((item) =>
            item.questionId === 'focus_time' ? suppressed('focus_time') : item,
          ),
        }),
      },
      owner,
    );
    expect(zero.questions?.[7]).toEqual({
      questionId: 'focus_time',
      status: 'suppressed',
      mean: null,
    });
    expect(small.questions?.[7]).toEqual(zero.questions?.[7]);
    expect(zero.questions?.[7]).not.toHaveProperty('answeredCount');
  });
  it('rejects suppressed results that leak a count or value', () => {
    const leaking = closedQuestions().map((item) =>
      item.questionId === 'focus_time' ? { ...suppressed('focus_time'), answeredCount: 0 } : item,
    );
    expect(() => parsePulse({ pulse: pulse({ questions: leaking }) }, owner)).toThrow();
    const valued = closedQuestions().map((item) =>
      item.questionId === 'focus_time' ? { ...suppressed('focus_time'), mean: 2 } : item,
    );
    expect(() => parsePulse({ pulse: pulse({ questions: valued }) }, owner)).toThrow();
  });
  it('rejects published results below the frozen minimum or outside the original scale', () => {
    const below = questionIds.map((id) => published(id, 3, 2));
    expect(() => parsePulse({ pulse: pulse({ questions: below }) }, owner)).toThrow();
    const outside = questionIds.map((id) => published(id, 5.5, 4));
    expect(() => parsePulse({ pulse: pulse({ questions: outside }) }, owner)).toThrow();
    const zero = questionIds.map((id) => published(id, 0, 4));
    expect(() => parsePulse({ pulse: pulse({ questions: zero }) }, owner)).toThrow();
    const moreThanSubmitted = questionIds.map((id) => published(id, 3, 6));
    expect(() => parsePulse({ pulse: pulse({ questions: moreThanSubmitted }) }, owner)).toThrow();
  });
  it('requires exactly eight results in instrument order', () => {
    expect(() =>
      parsePulse({ pulse: pulse({ questions: closedQuestions().slice(1) }) }, owner),
    ).toThrow();
    expect(() =>
      parsePulse({ pulse: pulse({ questions: [...closedQuestions()].reverse() }) }, owner),
    ).toThrow();
  });
  it('applies owner and member count visibility', () => {
    expect(parsePulse({ pulse: openPulse({ submittedCount: 2 }) }, owner).submittedCount).toBe(2);
    expect(parsePulse({ pulse: openPulse() }, member).submittedCount).toBeNull();
    expect(() => parsePulse({ pulse: openPulse({ submittedCount: 2 }) }, member)).toThrow();
    expect(() => parsePulse({ pulse: openPulse({ submittedCount: null }) }, owner)).toThrow();
    const hidden = questionIds.map((id) => suppressed(id));
    expect(
      parsePulse({ pulse: pulse({ submittedCount: null, questions: hidden }) }, member)
        .submittedCount,
    ).toBeNull();
    expect(() =>
      parsePulse({ pulse: pulse({ submittedCount: 2, questions: hidden }) }, member),
    ).toThrow();
    expect(() => parsePulse({ pulse: pulse({ submittedCount: null }) }, member)).toThrow();
    expect(() => parsePulse({ pulse: cancelledPulse({ submittedCount: 3 }) }, owner)).toThrow();
  });
  it('keeps drafts owner-only and rejects lifecycle inconsistencies', () => {
    expect(parsePulse({ pulse: draftPulse() }, owner).state).toBe('draft');
    expect(() => parsePulse({ pulse: draftPulse() }, member)).toThrow();
    expect(() =>
      parsePulse({ pulse: openPulse({ questions: closedQuestions() }) }, owner),
    ).toThrow();
    expect(() => parsePulse({ pulse: pulse({ closedAt: null }) }, owner)).toThrow();
    expect(() =>
      parsePulse({ pulse: pulse({ closedAt: '2026-09-28T00:00:00.000Z' }) }, owner),
    ).toThrow();
    expect(() => parsePulse({ pulse: openPulse({ rosterSize: 0 }) }, owner)).toThrow();
    expect(() => parsePulse({ pulse: { ...pulse(), state: 'reopened' } }, owner)).toThrow();
  });
  it('rejects wrong scope, identity, version, dates and extra fields', () => {
    expect(() => parsePulse({ pulse: pulse() }, { ...owner, pulseId: pulseId(9) })).toThrow();
    expect(() => parsePulse({ pulse: pulse({ workspaceId: teamB }) }, owner)).toThrow();
    expect(() =>
      parsePulse({ pulse: pulse({ id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }) }, owner),
    ).toThrow();
    expect(() => parsePulse({ pulse: pulse({ instrumentVersion: 'v0' }) }, owner)).toThrow();
    expect(() =>
      parsePulse({ pulse: pulse({ referenceStart: '2026-09-15T01:00:00.000Z' }) }, owner),
    ).toThrow();
    expect(() =>
      parsePulse({ pulse: pulse({ referenceStart: '2026-02-30T00:00:00.000Z' }) }, owner),
    ).toThrow();
    expect(() =>
      parsePulse({ pulse: pulse({ referenceEnd: '2026-09-15T00:00:00.000Z' }) }, owner),
    ).toThrow();
    expect(() => parsePulse({ pulse: { ...pulse(), answers: [] } }, owner)).toThrow();
    expect(() => parsePulse({ pulse: { ...pulse(), roster: ['alice'] } }, owner)).toThrow();
    expect(() => parsePulse({ pulse: pulse(), extra: true }, owner)).toThrow();
    expect(() => parsePulse({ pulse: pulse({ minimumRespondents: 2 }) }, owner)).toThrow();
  });
});

describe('SPACE pages', () => {
  it('requires bounded pages whose cursor is the last item', () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      cancelledPulse({ id: pulseId(index + 10) }),
    );
    expect(parsePulsePage(page(items, pulseId(34)), owner).nextCursor).toBe(pulseId(34));
    expect(() => parsePulsePage(page(items, pulseId(10)), owner)).toThrow();
    expect(() => parsePulsePage(page(items.slice(1), pulseId(34)), owner)).toThrow();
    expect(() =>
      parsePulsePage(page([...items, cancelledPulse({ id: pulseId(99) })]), owner),
    ).toThrow();
    expect(() => parsePulsePage(page([pulse(), pulse()]), owner)).toThrow();
  });
  it('rejects pulses outside the requested original team filter', () => {
    expect(parsePulsePage(page([pulse()]), { ...owner, teamId: teamA }).pulses).toHaveLength(1);
    expect(() => parsePulsePage(page([pulse()]), { ...owner, teamId: teamB })).toThrow();
  });
  it('parses assignment management and own history pages strictly', () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      userId: `user-${index.toString().padStart(3, '0')}`,
      teamId: index % 2 ? teamA : null,
      teamName: index % 2 ? 'Platform' : null,
    }));
    expect(
      parseAssignmentPage({ workspaceId, assignments: rows, nextCursor: 'user-099' }, workspaceId)
        .nextCursor,
    ).toBe('user-099');
    expect(() =>
      parseAssignmentPage({ workspaceId, assignments: rows, nextCursor: 'user-000' }, workspaceId),
    ).toThrow();
    expect(() =>
      parseAssignmentPage(
        {
          workspaceId,
          assignments: [{ userId: 'u', teamId: teamA, teamName: null }],
          nextCursor: null,
        },
        workspaceId,
      ),
    ).toThrow();
    expect(
      parseAssignmentUpdate(
        { workspaceId, assignment: { userId: 'u', teamId: teamA, teamName: 'Platform' } },
        workspaceId,
        'u',
        teamA,
      ).teamName,
    ).toBe('Platform');
    expect(() =>
      parseAssignmentUpdate(
        { workspaceId, assignment: { userId: 'u', teamId: teamB, teamName: 'Other' } },
        workspaceId,
        'u',
        teamA,
      ),
    ).toThrow();
    const own = parseOwnAssignment(
      {
        workspaceId,
        teamId: null,
        teamName: null,
        history: [
          {
            id: historyId(1),
            teamId: null,
            teamName: 'Platform',
            changedAt: '2026-10-01T10:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
      workspaceId,
    );
    expect(own.history[0]?.teamName).toBe('Platform');
    expect(() =>
      parseOwnAssignment(
        { workspaceId, teamId: null, teamName: null, history: [], nextCursor: historyId(1) },
        workspaceId,
      ),
    ).toThrow();
  });
  it('parses preferences within the accepted minimum bounds', () => {
    expect(parsePreferences({ workspaceId, minimumRespondents: 3 }, workspaceId)).toBe(3);
    expect(() => parsePreferences({ workspaceId, minimumRespondents: 2 }, workspaceId)).toThrow();
    expect(() =>
      parsePreferences({ workspaceId, minimumRespondents: 1001 }, workspaceId),
    ).toThrow();
    expect(() => parsePreferences({ workspaceId, minimumRespondents: 3.5 }, workspaceId)).toThrow();
  });
});

describe('SPACE responses', () => {
  it('sends the version and all eight nullable answers without extra fields', () => {
    const answers = { ...emptyAnswers(), satisfaction: 4, contribution_frequency: 2 };
    expect(responseBody(answers)).toEqual({
      instrumentVersion: 'clio.space.pulse.v1',
      answers: {
        satisfaction: 4,
        sustainable_workload: null,
        useful_outcomes: null,
        contribution_frequency: 2,
        useful_help: null,
        shared_context: null,
        effective_tools: null,
        focus_time: null,
      },
    });
    expect(Object.keys(responseBody(emptyAnswers()).answers)).toEqual([...questionIds]);
  });
  it('accepts only the exact safe submission acknowledgement', () => {
    expect(
      parseSubmission(
        { workspaceId, pulseId: pulseId(2), submitted: true },
        workspaceId,
        pulseId(2),
      ),
    ).toBe(true);
    expect(() =>
      parseSubmission(
        { workspaceId, pulseId: pulseId(2), submitted: true, answers: {} },
        workspaceId,
        pulseId(2),
      ),
    ).toThrow();
    expect(() =>
      parseSubmission(
        { workspaceId, pulseId: pulseId(3), submitted: true },
        workspaceId,
        pulseId(2),
      ),
    ).toThrow();
  });
});

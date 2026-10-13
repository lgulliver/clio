import { describe, expect, it } from 'vitest';
import {
  type Answers,
  aggregateResponses,
  type Pulse as ServerPulse,
  instrument as serverInstrument,
} from '../../../../api/src/features/space/contract.ts';
import { parseResponse } from '../../../../api/src/features/space/input.ts';
import { emptyAnswers, parseInstrument, parsePulse, responseBody } from './api';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const owner = { workspaceId, role: 'owner' as const };
const member = { workspaceId, role: 'member' as const };

function closed(responses: Answers[]): ServerPulse {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    workspaceId,
    teamId: '33333333-3333-4333-8333-333333333333',
    teamName: 'Platform',
    instrumentVersion: serverInstrument.version,
    referenceStart: '2026-09-01T00:00:00.000Z',
    referenceEnd: '2026-09-15T00:00:00.000Z',
    state: 'closed',
    minimumRespondents: 3,
    rosterSize: 3,
    openedAt: '2026-09-16T09:00:00.000Z',
    closedAt: '2026-09-17T09:00:00.000Z',
    cancelledAt: null,
    eligible: true,
    submitted: responses.length > 0,
    submittedCount: responses.length,
    questions: aggregateResponses(responses, 3),
  };
}

describe('SPACE server/browser contract parity', () => {
  it('accepts the actual server instrument without a browser-only fixture', () => {
    expect(parseInstrument({ instrument: serverInstrument })).toEqual(serverInstrument);
  });

  it('admits the browser response body through the actual server validator', () => {
    const answers = { ...emptyAnswers(), satisfaction: 5, contribution_frequency: 2 };
    expect(parseResponse(responseBody(answers))).toEqual(answers);
  });

  it('accepts real per-question aggregation while preserving zero and small count suppression', () => {
    const result = closed([{ ...emptyAnswers(), satisfaction: 1 }, emptyAnswers()]);
    const safeOwner = parsePulse({ pulse: result }, owner);
    const safeMember = parsePulse({ pulse: { ...result, submittedCount: null } }, member);
    expect(safeOwner.questions?.[0]).toEqual({
      questionId: 'satisfaction',
      status: 'suppressed',
      mean: null,
    });
    expect(safeOwner.questions?.[1]).toEqual({
      questionId: 'sustainable_workload',
      status: 'suppressed',
      mean: null,
    });
    expect(safeMember.questions).toEqual(safeOwner.questions);
    expect(safeMember.submittedCount).toBeNull();
  });

  it('accepts published server arithmetic means without releasing other skipped questions', () => {
    const result = closed([1, 5, 3].map((satisfaction) => ({ ...emptyAnswers(), satisfaction })));
    const safe = parsePulse({ pulse: result }, member);
    expect(safe.questions?.[0]).toEqual({
      questionId: 'satisfaction',
      status: 'published',
      mean: 3,
      answeredCount: 3,
    });
    expect(safe.questions?.slice(1).every((question) => question.status === 'suppressed')).toBe(
      true,
    );
  });
});

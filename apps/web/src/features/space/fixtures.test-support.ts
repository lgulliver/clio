// Fictional SPACE pulse fixtures for tests only. They are not real survey results.
export const workspaceId = '11111111-1111-4111-8111-111111111111';
export const otherWorkspaceId = '99999999-9999-4999-8999-999999999999';
export const teamA = '22222222-2222-4222-8222-222222222222';
export const teamB = '33333333-3333-4333-8333-333333333333';
export const archivedTeam = '44444444-4444-4444-8444-444444444444';

export function pulseId(index: number) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}
export function historyId(index: number) {
  return `66666666-6666-4666-8666-${index.toString(16).padStart(12, '0')}`;
}

export const questionIds = [
  'satisfaction',
  'sustainable_workload',
  'useful_outcomes',
  'contribution_frequency',
  'useful_help',
  'shared_context',
  'effective_tools',
  'focus_time',
] as const;

export function instrumentBody() {
  return {
    instrument: {
      version: 'clio.space.pulse.v1',
      questions: [
        {
          id: 'satisfaction',
          prompt: 'I felt satisfied with my work.',
          dimension: 'satisfaction_and_wellbeing',
          scale: 'agreement',
        },
        {
          id: 'sustainable_workload',
          prompt: 'My workload felt sustainable.',
          dimension: 'satisfaction_and_wellbeing',
          scale: 'agreement',
        },
        {
          id: 'useful_outcomes',
          prompt: 'My work contributed to useful outcomes for users or stakeholders.',
          dimension: 'performance',
          scale: 'agreement',
        },
        {
          id: 'contribution_frequency',
          prompt:
            'How frequently did you contribute to implementation, design, testing, reviews, documentation or operational support?',
          dimension: 'activity',
          scale: 'frequency',
        },
        {
          id: 'useful_help',
          prompt: 'I could get useful help when I needed it.',
          dimension: 'communication_and_collaboration',
          scale: 'agreement',
        },
        {
          id: 'shared_context',
          prompt: 'People shared enough context for us to work effectively.',
          dimension: 'communication_and_collaboration',
          scale: 'agreement',
        },
        {
          id: 'effective_tools',
          prompt: 'Our tools and processes helped me make progress.',
          dimension: 'efficiency_and_flow',
          scale: 'agreement',
        },
        {
          id: 'focus_time',
          prompt: 'I had enough uninterrupted time for focused work.',
          dimension: 'efficiency_and_flow',
          scale: 'agreement',
        },
      ],
      scales: {
        agreement: [
          'strongly disagree',
          'disagree',
          'neither agree nor disagree',
          'agree',
          'strongly agree',
        ],
        frequency: ['never', 'rarely', 'sometimes', 'often', 'very often'],
      },
    },
  };
}

export type PulseFixture = {
  id: string;
  workspaceId: string;
  teamId: string;
  teamName: string;
  instrumentVersion: string;
  referenceStart: string;
  referenceEnd: string;
  state: 'draft' | 'open' | 'closed' | 'cancelled';
  minimumRespondents: number;
  rosterSize: number;
  openedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  eligible: boolean;
  submitted: boolean;
  submittedCount: number | null;
  questions: Array<Record<string, unknown>> | null;
};

export function suppressed(questionId: string) {
  return { questionId, status: 'suppressed', mean: null };
}
export function published(questionId: string, mean: number, answeredCount: number) {
  return { questionId, status: 'published', mean, answeredCount };
}
/** Default closed result: every question published except focus_time. */
export function closedQuestions(mean = 3.5, answeredCount = 4) {
  return questionIds.map((id) =>
    id === 'focus_time' ? suppressed(id) : published(id, mean, answeredCount),
  );
}

export function pulse(overrides: Partial<PulseFixture> = {}): PulseFixture {
  return {
    id: pulseId(1),
    workspaceId,
    teamId: teamA,
    teamName: 'Platform',
    instrumentVersion: 'clio.space.pulse.v1',
    referenceStart: '2026-09-15T00:00:00.000Z',
    referenceEnd: '2026-09-29T00:00:00.000Z',
    state: 'closed',
    minimumRespondents: 3,
    rosterSize: 6,
    openedAt: '2026-09-29T09:00:00.000Z',
    closedAt: '2026-10-03T17:00:00.000Z',
    cancelledAt: null,
    eligible: true,
    submitted: true,
    submittedCount: 5,
    questions: closedQuestions(),
    ...overrides,
  };
}
export function openPulse(overrides: Partial<PulseFixture> = {}) {
  return pulse({
    id: pulseId(2),
    state: 'open',
    referenceStart: '2026-09-29T00:00:00.000Z',
    referenceEnd: '2026-10-13T00:00:00.000Z',
    openedAt: '2026-10-13T08:00:00.000Z',
    closedAt: null,
    submitted: false,
    submittedCount: null,
    questions: null,
    ...overrides,
  });
}
export function draftPulse(overrides: Partial<PulseFixture> = {}) {
  return pulse({
    id: pulseId(3),
    state: 'draft',
    referenceStart: '2026-09-29T00:00:00.000Z',
    referenceEnd: '2026-10-13T00:00:00.000Z',
    openedAt: null,
    closedAt: null,
    eligible: false,
    submitted: false,
    submittedCount: null,
    questions: null,
    rosterSize: 4,
    ...overrides,
  });
}
export function cancelledPulse(overrides: Partial<PulseFixture> = {}) {
  return pulse({
    id: pulseId(4),
    state: 'cancelled',
    closedAt: null,
    cancelledAt: '2026-10-02T12:00:00.000Z',
    submittedCount: null,
    questions: null,
    ...overrides,
  });
}
export function page(
  pulses: PulseFixture[],
  nextCursor: string | null = null,
  scope = workspaceId,
) {
  return { workspaceId: scope, pulses, nextCursor };
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

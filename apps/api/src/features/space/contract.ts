export const instrument = {
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
} as const;
export type QuestionId = (typeof instrument.questions)[number]['id'];
export type Answers = Record<QuestionId, number | null>;
export type QuestionAggregate =
  | { status: 'suppressed'; mean: null }
  | { status: 'published'; mean: number; answeredCount: number };
export type QuestionResult = QuestionAggregate & { questionId: QuestionId };
export type PulseState = 'draft' | 'open' | 'closed' | 'cancelled';
export interface Pulse {
  id: string;
  workspaceId: string;
  teamId: string;
  teamName: string;
  instrumentVersion: typeof instrument.version;
  referenceStart: string;
  referenceEnd: string;
  state: PulseState;
  minimumRespondents: number;
  rosterSize: number;
  openedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  eligible: boolean;
  submitted: boolean;
  submittedCount: number | null;
  questions: QuestionResult[] | null;
}
export function aggregateQuestion(values: (number | null)[], minimum: number): QuestionAggregate {
  const answered = values.filter((value): value is number => value !== null);
  if (answered.length < minimum) return { status: 'suppressed', mean: null };
  return {
    status: 'published',
    mean: answered.reduce((sum, value) => sum + value, 0) / answered.length,
    answeredCount: answered.length,
  };
}
export function aggregateResponses(responses: Answers[], minimum: number): QuestionResult[] {
  return instrument.questions.map(({ id }) => ({
    questionId: id,
    ...aggregateQuestion(
      responses.map((response) => response[id]),
      minimum,
    ),
  }));
}

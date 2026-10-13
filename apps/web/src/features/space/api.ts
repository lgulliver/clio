import { ApiError, record } from '../identity/api';

/** Clio application contract for team pulses; separate from OEMS delivery results. */
export const instrumentVersion = 'clio.space.pulse.v1';
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
export type QuestionId = (typeof questionIds)[number];
export type Dimension =
  | 'satisfaction_and_wellbeing'
  | 'performance'
  | 'activity'
  | 'communication_and_collaboration'
  | 'efficiency_and_flow';
export type Scale = 'agreement' | 'frequency';
export type Question = { id: QuestionId; prompt: string; dimension: Dimension; scale: Scale };
export type Instrument = {
  version: typeof instrumentVersion;
  questions: readonly Question[];
  scales: Readonly<Record<Scale, readonly string[]>>;
};

/** Original pilot items from the approved design; the server must serve exactly these. */
export const instrument: Instrument = {
  version: instrumentVersion,
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
};

export const dimensions: readonly { id: Dimension; label: string; description: string }[] = [
  {
    id: 'satisfaction_and_wellbeing',
    label: 'Satisfaction and well-being',
    description: 'How fulfilling and sustainable the work felt.',
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Perceived contribution to useful outcomes; not independently measured value.',
  },
  {
    id: 'activity',
    label: 'Activity',
    description: 'Self-reported contribution frequency; not measured commits or pull requests.',
  },
  {
    id: 'communication_and_collaboration',
    label: 'Communication and collaboration',
    description: 'Access to help and shared context.',
  },
  {
    id: 'efficiency_and_flow',
    label: 'Efficiency and flow',
    description: 'Tools, processes and uninterrupted focus.',
  },
];

export function questionById(id: QuestionId): Question {
  const question = instrument.questions.find((item) => item.id === id);
  if (!question) throw new ApiError(0);
  return question;
}
export function scaleLabel(scale: Scale, value: number): string {
  const label = instrument.scales[scale][value - 1] ?? '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export type Role = 'owner' | 'member';
export type PulseState = 'draft' | 'open' | 'closed' | 'cancelled';
export type QuestionResult =
  | { questionId: QuestionId; status: 'suppressed'; mean: null }
  | { questionId: QuestionId; status: 'published'; mean: number; answeredCount: number };
export type Pulse = {
  id: string;
  workspaceId: string;
  teamId: string;
  teamName: string;
  instrumentVersion: typeof instrumentVersion;
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
};
export type PulsePage = { pulses: Pulse[]; nextCursor: string | null };
export type Assignment = { userId: string; teamId: string | null; teamName: string | null };
export type AssignmentPage = { assignments: Assignment[]; nextCursor: string | null };
export type AssignmentChange = {
  id: string;
  teamId: string | null;
  teamName: string | null;
  changedAt: string;
};
export type OwnAssignment = {
  teamId: string | null;
  teamName: string | null;
  history: AssignmentChange[];
  nextCursor: string | null;
};
export type Answers = Record<QuestionId, number | null>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const midnightPattern = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const pulseKeys = [
  'id',
  'workspaceId',
  'teamId',
  'teamName',
  'instrumentVersion',
  'referenceStart',
  'referenceEnd',
  'state',
  'minimumRespondents',
  'rosterSize',
  'openedAt',
  'closedAt',
  'cancelledAt',
  'eligible',
  'submitted',
  'submittedCount',
  'questions',
] as const;

function invalid(): never {
  throw new ApiError(0);
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = record(value);
  const present = Object.keys(row);
  if (present.length !== keys.length || present.some((key) => !keys.includes(key))) invalid();
  return row;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) invalid();
  return value;
}
function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}
function userId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    invalid();
  return value;
}
function name(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    [...value].length > 200
  )
    invalid();
  return value;
}
function nullableName(value: unknown): string | null {
  return value === null ? null : name(value);
}
function midnight(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !midnightPattern.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !timestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid();
  return value;
}
function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
    invalid();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function before(earlier: string, later: string) {
  if (Date.parse(later) < Date.parse(earlier)) invalid();
}

export function parseInstrument(value: unknown): Instrument {
  const item = exact(exact(value, ['instrument']).instrument, ['version', 'questions', 'scales']);
  if (
    item.version !== instrumentVersion ||
    !Array.isArray(item.questions) ||
    item.questions.length !== instrument.questions.length
  )
    invalid();
  item.questions.forEach((question: unknown, index) => {
    const row = exact(question, ['id', 'prompt', 'dimension', 'scale']);
    const expected = instrument.questions[index];
    if (
      !expected ||
      row.id !== expected.id ||
      row.prompt !== expected.prompt ||
      row.dimension !== expected.dimension ||
      row.scale !== expected.scale
    )
      invalid();
  });
  const scales = exact(item.scales, ['agreement', 'frequency']);
  for (const scale of ['agreement', 'frequency'] as const) {
    const labels = scales[scale];
    const expected = instrument.scales[scale];
    if (
      !Array.isArray(labels) ||
      labels.length !== expected.length ||
      labels.some((label: unknown, index) => label !== expected[index])
    )
      invalid();
  }
  return instrument;
}

export function parsePreferences(value: unknown, workspaceId: string): number {
  const row = exact(value, ['workspaceId', 'minimumRespondents']);
  if (row.workspaceId !== workspaceId) invalid();
  return integer(row.minimumRespondents, 3, 1000);
}

function assignment(value: unknown): Assignment {
  const row = exact(value, ['userId', 'teamId', 'teamName']);
  const teamId = nullableUuid(row.teamId);
  const teamName = nullableName(row.teamName);
  if ((teamId === null) !== (teamName === null)) invalid();
  return { userId: userId(row.userId), teamId, teamName };
}
export function parseAssignmentPage(
  value: unknown,
  workspaceId: string,
  cursor?: string,
): AssignmentPage {
  const row = exact(value, ['workspaceId', 'assignments', 'nextCursor']);
  if (row.workspaceId !== workspaceId || !Array.isArray(row.assignments)) invalid();
  if (row.assignments.length > 100) invalid();
  const assignments = row.assignments.map(assignment);
  const ids = new Set(assignments.map((item) => item.userId));
  if (ids.size !== assignments.length || (cursor !== undefined && ids.has(cursor))) invalid();
  const nextCursor = row.nextCursor === null ? null : userId(row.nextCursor);
  if (
    nextCursor !== null &&
    (assignments.length !== 100 || assignments.at(-1)?.userId !== nextCursor)
  )
    invalid();
  return { assignments, nextCursor };
}
export function parseAssignmentUpdate(
  value: unknown,
  workspaceId: string,
  expectedUserId: string,
  expectedTeamId: string | null,
): Assignment {
  const row = exact(value, ['workspaceId', 'assignment']);
  if (row.workspaceId !== workspaceId) invalid();
  const result = assignment(row.assignment);
  if (result.userId !== expectedUserId || result.teamId !== expectedTeamId) invalid();
  return result;
}
export function parseOwnAssignment(
  value: unknown,
  workspaceId: string,
  cursor?: string,
): OwnAssignment {
  const row = exact(value, ['workspaceId', 'teamId', 'teamName', 'history', 'nextCursor']);
  if (row.workspaceId !== workspaceId || !Array.isArray(row.history) || row.history.length > 25)
    invalid();
  const teamId = nullableUuid(row.teamId);
  const teamName = nullableName(row.teamName);
  if ((teamId === null) !== (teamName === null)) invalid();
  const history = row.history.map((item: unknown) => {
    const change = exact(item, ['id', 'teamId', 'teamName', 'changedAt']);
    return {
      id: uuid(change.id),
      teamId: nullableUuid(change.teamId),
      teamName: nullableName(change.teamName),
      changedAt: timestamp(change.changedAt),
    };
  });
  const ids = new Set(history.map((item) => item.id));
  if (ids.size !== history.length || (cursor !== undefined && ids.has(cursor))) invalid();
  const nextCursor = nullableUuid(row.nextCursor);
  if (nextCursor !== null && (history.length !== 25 || history.at(-1)?.id !== nextCursor))
    invalid();
  return { teamId, teamName, history, nextCursor };
}

function questionResults(
  value: unknown,
  minimum: number,
  rosterSize: number,
  submittedCount: number | null,
): QuestionResult[] {
  if (!Array.isArray(value) || value.length !== questionIds.length) invalid();
  return value.map((item: unknown, index): QuestionResult => {
    const questionId = questionIds[index];
    const row = record(item);
    if (!questionId || row.questionId !== questionId) invalid();
    if (row.status === 'suppressed') {
      exact(row, ['questionId', 'status', 'mean']);
      if (row.mean !== null) invalid();
      return { questionId, status: 'suppressed', mean: null };
    }
    if (row.status !== 'published') invalid();
    exact(row, ['questionId', 'status', 'mean', 'answeredCount']);
    const answeredCount = integer(row.answeredCount, minimum, rosterSize);
    if (
      typeof row.mean !== 'number' ||
      !Number.isFinite(row.mean) ||
      row.mean < 1 ||
      row.mean > 5 ||
      submittedCount === null ||
      answeredCount > submittedCount
    )
      invalid();
    return { questionId, status: 'published', mean: row.mean, answeredCount };
  });
}

function pulse(value: unknown, workspaceId: string, role: Role): Pulse {
  const row = exact(value, pulseKeys);
  if (row.workspaceId !== workspaceId || row.instrumentVersion !== instrumentVersion) invalid();
  const state = row.state;
  if (state !== 'draft' && state !== 'open' && state !== 'closed' && state !== 'cancelled')
    invalid();
  const referenceStart = midnight(row.referenceStart);
  const referenceEnd = midnight(row.referenceEnd);
  if (Date.parse(referenceStart) >= Date.parse(referenceEnd)) invalid();
  const minimumRespondents = integer(row.minimumRespondents, 3, 1000);
  const rosterSize = integer(row.rosterSize, state === 'open' || state === 'closed' ? 1 : 0, 1e6);
  const openedAt = nullableTimestamp(row.openedAt);
  const closedAt = nullableTimestamp(row.closedAt);
  const cancelledAt = nullableTimestamp(row.cancelledAt);
  const eligible = boolean(row.eligible);
  const submitted = boolean(row.submitted);
  const submittedCount =
    row.submittedCount === null ? null : integer(row.submittedCount, 0, rosterSize);
  let questions: QuestionResult[] | null = null;
  switch (state) {
    case 'draft':
      if (
        role !== 'owner' ||
        openedAt !== null ||
        closedAt !== null ||
        cancelledAt !== null ||
        eligible ||
        submitted ||
        submittedCount !== null ||
        row.questions !== null
      )
        invalid();
      break;
    case 'open':
      if (
        openedAt === null ||
        closedAt !== null ||
        cancelledAt !== null ||
        row.questions !== null ||
        (submitted && !eligible) ||
        (role === 'owner') !== (submittedCount !== null)
      )
        invalid();
      break;
    case 'closed':
      if (openedAt === null || closedAt === null || cancelledAt !== null) invalid();
      before(openedAt, closedAt);
      if (
        (role === 'owner' && submittedCount === null) ||
        (role === 'member' && submittedCount !== null && submittedCount < minimumRespondents)
      )
        invalid();
      questions = questionResults(row.questions, minimumRespondents, rosterSize, submittedCount);
      break;
    case 'cancelled':
      if (
        cancelledAt === null ||
        closedAt !== null ||
        submittedCount !== null ||
        row.questions !== null
      )
        invalid();
      if (openedAt !== null) before(openedAt, cancelledAt);
      break;
  }
  return {
    id: uuid(row.id),
    workspaceId,
    teamId: uuid(row.teamId),
    teamName: name(row.teamName),
    instrumentVersion,
    referenceStart,
    referenceEnd,
    state,
    minimumRespondents,
    rosterSize,
    openedAt,
    closedAt,
    cancelledAt,
    eligible,
    submitted,
    submittedCount,
    questions,
  };
}

export function parsePulse(
  value: unknown,
  scope: { workspaceId: string; role: Role; pulseId?: string },
): Pulse {
  const result = pulse(exact(value, ['pulse']).pulse, scope.workspaceId, scope.role);
  if (scope.pulseId !== undefined && result.id !== scope.pulseId) invalid();
  return result;
}

export function parsePulsePage(
  value: unknown,
  scope: { workspaceId: string; role: Role; teamId?: string; cursor?: string },
): PulsePage {
  const row = exact(value, ['workspaceId', 'pulses', 'nextCursor']);
  if (row.workspaceId !== scope.workspaceId || !Array.isArray(row.pulses) || row.pulses.length > 25)
    invalid();
  const pulses = row.pulses.map((item: unknown) => pulse(item, scope.workspaceId, scope.role));
  const ids = new Set(pulses.map((item) => item.id));
  if (
    ids.size !== pulses.length ||
    (scope.cursor !== undefined && ids.has(scope.cursor)) ||
    (scope.teamId !== undefined && pulses.some((item) => item.teamId !== scope.teamId))
  )
    invalid();
  const nextCursor = nullableUuid(row.nextCursor);
  if (nextCursor !== null && (pulses.length !== 25 || pulses.at(-1)?.id !== nextCursor)) invalid();
  return { pulses, nextCursor };
}

export function parseSubmission(value: unknown, workspaceId: string, pulseId: string): true {
  const row = exact(value, ['workspaceId', 'pulseId', 'submitted']);
  if (row.workspaceId !== workspaceId || row.pulseId !== pulseId || row.submitted !== true)
    invalid();
  return true;
}

export function emptyAnswers(): Answers {
  return {
    satisfaction: null,
    sustainable_workload: null,
    useful_outcomes: null,
    contribution_frequency: null,
    useful_help: null,
    shared_context: null,
    effective_tools: null,
    focus_time: null,
  };
}
/** Exact documented body: the version plus all eight keys, skipped items as null. */
export function responseBody(answers: Answers) {
  const values = emptyAnswers();
  for (const id of questionIds) {
    const answer = answers[id];
    values[id] =
      answer !== null && Number.isInteger(answer) && answer >= 1 && answer <= 5 ? answer : null;
  }
  return { instrumentVersion, answers: values };
}

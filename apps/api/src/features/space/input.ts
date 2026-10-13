import { IdentityError, object, uuid } from '../identity/input.ts';
import { type Answers, instrument } from './contract.ts';

export function parseMinimum(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 3 || value > 1000)
    throw new IdentityError(400, 'invalid_request');
  return value;
}
function answer(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5)
    throw new IdentityError(400, 'invalid_request');
  return value;
}
export function parseAnswers(value: unknown): Answers {
  const values = object(
    value,
    instrument.questions.map((q) => q.id),
  );
  return {
    satisfaction: answer(values.satisfaction),
    sustainable_workload: answer(values.sustainable_workload),
    useful_outcomes: answer(values.useful_outcomes),
    contribution_frequency: answer(values.contribution_frequency),
    useful_help: answer(values.useful_help),
    shared_context: answer(values.shared_context),
    effective_tools: answer(values.effective_tools),
    focus_time: answer(values.focus_time),
  };
}
export function parseResponse(value: unknown): Answers {
  const body = object(value, ['instrumentVersion', 'answers']);
  if (body.instrumentVersion !== instrument.version)
    throw new IdentityError(400, 'invalid_request');
  return parseAnswers(body.answers);
}
function midnight(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new IdentityError(400, 'invalid_request');
  return value;
}
export function parseDraft(value: unknown, now = new Date()) {
  const body = object(value, ['teamId', 'referenceStart', 'referenceEnd']);
  const referenceStart = midnight(body.referenceStart);
  const referenceEnd = midnight(body.referenceEnd);
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  if (referenceStart >= referenceEnd || Date.parse(referenceEnd) > today.getTime())
    throw new IdentityError(400, 'invalid_request');
  return { teamId: uuid(body.teamId), referenceStart, referenceEnd };
}

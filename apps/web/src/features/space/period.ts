const dayMs = 86_400_000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

export type ReferenceInputs = { firstDay: string; lastDay: string };
export type ReferenceBounds = { referenceStart: string; referenceEnd: string };

function utcMidnight(now: Date) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
function day(value: string): number | null {
  if (!datePattern.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
    return null;
  return parsed;
}
function input(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Browser default: the preceding 14 UTC calendar days, ending before today's UTC midnight. */
export function defaultReferenceInputs(now: Date): ReferenceInputs {
  const end = utcMidnight(now);
  return { firstDay: input(end - 14 * dayMs), lastDay: input(end - dayMs) };
}

/** Inputs are inclusive calendar days; the contract end is the following exclusive midnight. */
export function referenceFromInputs(
  firstDay: string,
  lastDay: string,
  now: Date,
): ReferenceBounds | { error: string } {
  const start = day(firstDay);
  const last = day(lastDay);
  if (start === null || last === null) return { error: 'Enter valid first and last days.' };
  if (start > last) return { error: 'The first day must be on or before the last day.' };
  const end = last + dayMs;
  if (end > utcMidnight(now)) return { error: 'The reference period must end before today (UTC).' };
  return {
    referenceStart: new Date(start).toISOString(),
    referenceEnd: new Date(end).toISOString(),
  };
}

export function inputsFromReference(referenceStart: string, referenceEnd: string): ReferenceInputs {
  return {
    firstDay: input(Date.parse(referenceStart)),
    lastDay: input(Date.parse(referenceEnd) - dayMs),
  };
}

export function periodLengthDays(referenceStart: string, referenceEnd: string) {
  return Math.round((Date.parse(referenceEnd) - Date.parse(referenceStart)) / dayMs);
}

export function formatDay(value: string | number) {
  return dateFormat.format(new Date(value));
}

export function formatReferencePeriod(referenceStart: string, referenceEnd: string) {
  const days = periodLengthDays(referenceStart, referenceEnd);
  return `${formatDay(referenceStart)} to ${formatDay(Date.parse(referenceEnd) - dayMs)} (${days} UTC ${
    days === 1 ? 'day' : 'days'
  }; ends before ${formatDay(referenceEnd)})`;
}

export function formatTimestamp(value: string) {
  return `${timeFormat.format(new Date(value))} UTC`;
}

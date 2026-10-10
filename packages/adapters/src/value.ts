/** Boundary helpers: failures contain codes, never input values or provider errors. */
export class AdapterError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'AdapterError';
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AdapterError('invalid_object');
  }
  return Object.fromEntries(Object.entries(value));
}
export function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new AdapterError('invalid_string');
  return value;
}
export function positiveId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AdapterError('invalid_id');
  }
  return value;
}
export function timestamp(value: unknown): string {
  const result = string(value);
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(result);
  if (
    !match ||
    result.endsWith('-00:00') ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  ) {
    throw new AdapterError('invalid_timestamp');
  }
  const day = match[1];
  if (
    !day ||
    !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day ||
    !Number.isFinite(Date.parse(result))
  ) {
    throw new AdapterError('invalid_timestamp');
  }
  return result;
}
export function instant(value: string): bigint {
  timestamp(value);
  const fraction = /\.(\d{1,6})/.exec(value)?.[1] ?? '';
  const whole = value.replace(/\.\d{1,6}/, '');
  return BigInt(Date.parse(whole)) * 1000n + BigInt(fraction.padEnd(6, '0'));
}
export function sha(value: unknown): string {
  const result = string(value);
  if (!/^[a-fA-F0-9]{40}$/.test(result)) throw new AdapterError('invalid_sha');
  return result.toLowerCase();
}
export function identity(...parts: (string | number)[]): string {
  return parts.map((part) => encodeURIComponent(String(part))).join(':');
}
export function eventBeforeObservation(eventAt: string, observedAt: string): void {
  if (instant(eventAt) > instant(observedAt)) throw new AdapterError('event_after_observation');
}
/** Compare normalized scalar records independent of property insertion order. */
export function content(value: object): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map((item: unknown) => canonical(item));
    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return input;
  }
  return JSON.stringify(canonical(value));
}

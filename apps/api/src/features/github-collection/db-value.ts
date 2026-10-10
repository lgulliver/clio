import { positive } from './input.ts';

/** pg returns bigint columns as decimal strings; no other coercion is trusted. */
export function storedRevision(value: unknown): number {
  if (typeof value === 'number') return positive(value);
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
    throw new Error('Invalid stored revision');
  return positive(Number(value));
}

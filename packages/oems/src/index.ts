/** Explicit upstream provenance; the normative contract belongs to OEMS. */
export const oemsContract = {
  profileVersion: '0.1-draft',
  revision: '5908bb12cdf24e7528088237dff9dca4c10ff45f',
  repository: 'https://github.com/lgulliver/oems',
  calendarProfile: 'utc-whole-day',
  inputProfile: 'reconciled-snapshot',
} as const;

export { calculate } from './calculate.ts';
export type { SchemaInputs, SchemaKind, ValidationIssue, ValidationResult } from './schema.ts';
export { validateStructure } from './schema.ts';
export { ValidatedSnapshot, validateSnapshot } from './snapshot.ts';
export type {
  Change,
  Dataset,
  Deployment,
  EventEnvelope,
  Incident,
  MetricResult,
  Service,
} from './types.ts';

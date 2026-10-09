import type { ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import change from '../vendor/schemas/v0.1/change.schema.json' with { type: 'json' };
import dataset from '../vendor/schemas/v0.1/dataset.schema.json' with { type: 'json' };
import deployment from '../vendor/schemas/v0.1/deployment.schema.json' with { type: 'json' };
import envelope from '../vendor/schemas/v0.1/event-envelope.schema.json' with { type: 'json' };
import incident from '../vendor/schemas/v0.1/incident.schema.json' with { type: 'json' };
import result from '../vendor/schemas/v0.1/metric-result.schema.json' with { type: 'json' };
import service from '../vendor/schemas/v0.1/service.schema.json' with { type: 'json' };
import { copyJson } from './json.ts';
import type {
  Change,
  Dataset,
  Deployment,
  EventEnvelope,
  Incident,
  MetricResult,
  Service,
} from './types.ts';

export type SchemaInputs = {
  dataset: Dataset;
  service: Service;
  change: Change;
  deployment: Deployment;
  incident: Incident;
  'metric-result': MetricResult;
  'event-envelope': EventEnvelope;
};
export type SchemaKind = keyof SchemaInputs;
export type ValidationIssue = {
  layer: 'structural' | 'semantic';
  code: string;
  path: string;
  message: string;
};
export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: ValidationIssue[] };

// All references resolve locally. No URL retrieval or provider access.
const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });
addFormats(ajv);
const schemas = {
  dataset,
  service,
  change,
  deployment,
  incident,
  'metric-result': result,
  'event-envelope': envelope,
};
for (const [kind, schema] of Object.entries(schemas)) ajv.addSchema(schema, `${kind}.schema.json`);
const validators: { [K in SchemaKind]: ValidateFunction<SchemaInputs[K]> } = {
  dataset: ajv.compile<Dataset>({ $ref: 'dataset.schema.json' }),
  service: ajv.compile<Service>({ $ref: 'service.schema.json' }),
  change: ajv.compile<Change>({ $ref: 'change.schema.json' }),
  deployment: ajv.compile<Deployment>({ $ref: 'deployment.schema.json' }),
  incident: ajv.compile<Incident>({ $ref: 'incident.schema.json' }),
  'metric-result': ajv.compile<MetricResult>({ $ref: 'metric-result.schema.json' }),
  'event-envelope': ajv.compile<EventEnvelope>({ $ref: 'event-envelope.schema.json' }),
};

// A mapped generic keeps Ajv's type guard tied to the selected schema.
function checker<K extends SchemaKind>(kind: K): (value: unknown) => value is SchemaInputs[K] {
  return validators[kind];
}
export function validateStructure<K extends SchemaKind>(
  kind: K,
  input: unknown,
): ValidationResult<SchemaInputs[K]> {
  let value: unknown;
  try {
    value = copyJson(input);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          layer: 'structural',
          code: 'invalid_json',
          path: '',
          message: error instanceof Error ? error.message : 'Invalid JSON input',
        },
      ],
    };
  }
  const check = checker(kind);
  if (check(value)) return { ok: true, data: value };
  return {
    ok: false,
    errors: (validators[kind].errors ?? []).map((error) => ({
      layer: 'structural',
      code: error.keyword,
      path: error.instancePath,
      message: error.message ?? 'Schema validation failed',
    })),
  };
}

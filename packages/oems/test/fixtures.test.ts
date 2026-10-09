import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  calculate,
  type Dataset,
  type MetricResult,
  type SchemaKind,
  validateSnapshot,
  validateStructure,
} from '../src/index.ts';

const fixtures = new URL('../vendor/conformance/v0.1/', import.meta.url);
function read(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, fixtures), 'utf8'));
}
function dataset(input: unknown): Dataset {
  const checked = validateStructure('dataset', input);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.data;
}
function results(input: unknown): MetricResult[] {
  return (Array.isArray(input) ? input : [input])
    .map((value) => {
      const checked = validateStructure('metric-result', value);
      if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
      return checked.data;
    })
    .sort((a, b) => (a.service_id < b.service_id ? -1 : a.service_id > b.service_id ? 1 : 0));
}
function run(input: unknown): MetricResult[] {
  const checked = validateSnapshot(input);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return calculate(checked.data);
}
function schemaKind(value: unknown): SchemaKind {
  switch (value) {
    case undefined:
    case 'dataset':
      return 'dataset';
    case 'service':
    case 'change':
    case 'deployment':
    case 'incident':
    case 'metric-result':
    case 'event-envelope':
      return value;
    default:
      throw new Error('Unknown fixture schema');
  }
}

describe('pinned OEMS complete fixture parity', () => {
  for (const file of readdirSync(new URL('cases/', fixtures))
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    it(`${file}: every expected field and output schema`, () => {
      const actual = run(read(`cases/${file}`));
      expect(actual).toEqual(results(read(`expected-results/${file}`)));
      for (const result of actual) expect(validateStructure('metric-result', result).ok).toBe(true);
    });
    it(`${file}: order invariance`, () => {
      const input = dataset(read(`cases/${file}`));
      const reversed = {
        ...input,
        services: [...input.services].reverse(),
        changes: [...input.changes].reverse(),
        deployments: [...input.deployments].reverse(),
        incidents: [...input.incidents].reverse(),
      };
      expect(run(reversed)).toEqual(run(input));
    });
  }
  for (const file of readdirSync(new URL('invalid/', fixtures))
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    it(`${file}: rejects at declared layer/code`, () => {
      const fixture = read(`invalid/${file}`);
      if (!fixture || typeof fixture !== 'object' || !('input' in fixture) || !('layer' in fixture))
        throw new Error('Invalid test fixture');
      if (fixture.layer === 'structural') {
        const rejected = validateStructure(
          schemaKind('schema' in fixture ? fixture.schema : undefined),
          fixture.input,
        );
        expect(rejected.ok).toBe(false);
        if (!rejected.ok)
          expect(rejected.errors.every((error) => error.layer === 'structural')).toBe(true);
      } else {
        expect(validateStructure('dataset', fixture.input).ok).toBe(true);
        const rejected = validateSnapshot(fixture.input);
        expect(rejected.ok).toBe(false);
        if (!rejected.ok)
          expect(rejected.errors.map((error) => [error.layer, error.code])).toEqual([
            ['semantic', 'error_code' in fixture ? fixture.error_code : undefined],
          ]);
      }
    });
  }
  it('record examples, envelope and payload validate', () => {
    const examples: unknown = JSON.parse(
      readFileSync(new URL('../vendor/examples/v0.1/records.json', import.meta.url), 'utf8'),
    );
    if (!examples || typeof examples !== 'object') throw new Error('Invalid examples');
    for (const [kind, input] of Object.entries(examples)) {
      const checked = validateStructure(
        kind === 'envelope' ? 'event-envelope' : schemaKind(kind),
        input,
      );
      expect(checked.ok).toBe(true);
      if (kind === 'envelope') {
        const envelope = validateStructure('event-envelope', input);
        if (!envelope.ok) throw new Error('Invalid envelope');
        expect(validateStructure(envelope.data.record_type, envelope.data.payload).ok).toBe(true);
      }
    }
  });
});

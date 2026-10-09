import { type DeepReadonly, freezeJson } from './json.ts';
import { type ValidationResult, validateStructure } from './schema.ts';
import { validateSemantics } from './semantic.ts';
import type { Dataset } from './types.ts';

const authority = Symbol('validated snapshot');
const checked = new WeakMap<ValidatedSnapshot, Dataset>();
/** Immutable capability issued only after structural and semantic validation. */
export class ValidatedSnapshot {
  private constructor(data: Dataset, proof: symbol) {
    if (proof !== authority) throw new TypeError('Calculation requires a validated snapshot');
    freezeJson(data);
    checked.set(this, data);
    Object.freeze(this);
  }
  get data(): DeepReadonly<Dataset> {
    return checkedDataset(this);
  }
  static validate(input: unknown): ValidationResult<ValidatedSnapshot> {
    const structure = validateStructure('dataset', input);
    if (!structure.ok) return structure;
    const semantics = validateSemantics(structure.data);
    if (!semantics.ok) return semantics;
    return { ok: true, data: new ValidatedSnapshot(semantics.data, authority) };
  }
}
export function validateSnapshot(input: unknown): ValidationResult<ValidatedSnapshot> {
  return ValidatedSnapshot.validate(input);
}
/** Internal capability check also rejects forged tokens at runtime. */
export function checkedDataset(snapshot: ValidatedSnapshot): Dataset {
  const data = checked.get(snapshot);
  if (!data) throw new TypeError('Calculation requires a validated snapshot');
  return data;
}

/** Clone JSON values without silently dropping undefined, non-finite values or cycles. */
export function copyJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null)
    throw new Error('Input must contain JSON values only');
  if (ancestors.has(value)) throw new Error('Input must not contain cycles');
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error('Input must contain plain JSON objects');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, (child) => copyJson(child, ancestors));
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, copyJson(child, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export function freezeJson(value: unknown): void {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}

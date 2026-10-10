import { createHash } from 'node:crypto';

/** Sort object keys so PostgreSQL JSONB ordering cannot change the content hash. */
export function snapshotDigest(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
  if (serialized === undefined) throw new Error('Missing snapshot content');
  return createHash('sha256').update(serialized).digest('hex');
}

/** Exact microsecond instants. Date is used only for whole-second calendar conversion. */
export function instant(value: string): bigint {
  const match =
    /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match?.[1] || !match[2] || !match[4]) throw new Error('Invalid validated timestamp');
  const milliseconds = Date.parse(`${match[1]}T${match[2]}${match[4].toUpperCase()}`);
  if (!Number.isFinite(milliseconds)) throw new Error('Invalid validated timestamp');
  return BigInt(milliseconds) * 1000n + BigInt((match[3] ?? '').padEnd(6, '0'));
}

export const dayMicroseconds = 86_400_000_000n;
export function secondsBetween(end: string, start: string): number {
  return Number(instant(end) - instant(start)) / 1_000_000;
}

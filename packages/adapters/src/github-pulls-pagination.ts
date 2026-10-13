import { AdapterError } from './value.ts';

/** Validate every Link target, not just next; preserve this endpoint's query profile. */
export function nextPullEndpointPage(header: string | null, current: URL): number | null {
  if (!header) return null;
  const relations = new Set<string>();
  let next: number | null = null;
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
    if (!match?.[1] || !match[2] || relations.has(match[2]))
      throw new AdapterError('invalid_pagination');
    relations.add(match[2]);
    let target: URL;
    try {
      target = new URL(match[1]);
    } catch {
      throw new AdapterError('unsafe_pagination');
    }
    const expected = [...current.searchParams.keys()];
    const pageText = target.searchParams.get('page');
    const page = Number(pageText);
    if (
      target.origin !== current.origin ||
      target.username ||
      target.password ||
      target.hash ||
      target.pathname !== current.pathname ||
      [...target.searchParams.keys()].length !== expected.length ||
      expected.some(
        (key) =>
          target.searchParams.getAll(key).length !== 1 ||
          (key !== 'page' && target.searchParams.get(key) !== current.searchParams.get(key)),
      ) ||
      !pageText ||
      !/^[1-9]\d*$/.test(pageText) ||
      !Number.isSafeInteger(page) ||
      (match[2] === 'next' && page !== Number(current.searchParams.get('page')) + 1)
    )
      throw new AdapterError('unsafe_pagination');
    if (match[2] === 'next') next = page;
  }
  return next;
}

export class IdentityError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new IdentityError(400, 'invalid_request');
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keys.includes(key)) throw new IdentityError(400, 'invalid_request');
    result[key] = item;
  }
  return result;
}
export function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new IdentityError(400, 'invalid_request');
  return value.toLowerCase();
}
export function opaqueId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new IdentityError(400, 'invalid_request');
  return value;
}
export function name(value: unknown): string {
  if (typeof value !== 'string') throw new IdentityError(400, 'invalid_request');
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > 200 || normalized.includes('\0'))
    throw new IdentityError(400, 'invalid_request');
  return normalized;
}
export function email(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  )
    throw new IdentityError(400, 'invalid_request');
  return value.toLowerCase();
}
export function invitationToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new IdentityError(400, 'invalid_request');
  return value;
}

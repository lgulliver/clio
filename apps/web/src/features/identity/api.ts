export type User = { id: string; name: string; email: string; emailVerified: boolean };
export type Workspace = { id: string; name: string; role: 'owner' | 'member' };
export type Service = { id: string; name: string; workspaceId: string };
export type Invitation = {
  id: string;
  workspaceId: string;
  email: string;
  expiresAt: string;
  token: string;
};

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(
      status === 0
        ? 'The response could not be verified. Please try again.'
        : (messages[status] ?? 'The request failed. Please try again.'),
    );
  }
}
const messages: Record<number, string> = {
  401: 'Your session ended. Sign in again.',
  403: 'You do not have permission for this action.',
  404: 'This workspace or invitation is no longer available to you.',
  409: 'This change conflicts with an existing record.',
  503: 'Clio is unavailable. Please try again.',
  400: 'Check the details and try again.',
};
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Clio is unavailable. Please try again.';
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ApiError(0);
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new ApiError(0);
  return value;
}
function uuid(value: unknown): string {
  const result = string(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result))
    throw new ApiError(0);
  return result;
}
export function parseUser(value: unknown): User {
  const user = record(record(value).user);
  if (
    typeof user.emailVerified !== 'boolean' ||
    !(user.image === null || typeof user.image === 'string')
  )
    throw new ApiError(0);
  return {
    id: string(user.id),
    name: string(user.name),
    email: string(user.email),
    emailVerified: user.emailVerified,
  };
}
function workspace(value: unknown): Workspace {
  const item = record(value);
  if (item.role !== 'owner' && item.role !== 'member') throw new ApiError(0);
  return { id: uuid(item.id), name: string(item.name), role: item.role };
}
export function parseWorkspace(value: unknown): Workspace {
  return workspace(record(value).workspace);
}
export function parseWorkspaces(value: unknown): Workspace[] {
  const items = record(value).workspaces;
  if (!Array.isArray(items)) throw new ApiError(0);
  return items.map(workspace);
}
function service(value: unknown, workspaceId: string): Service {
  const item = record(value);
  if (item.workspaceId !== workspaceId) throw new ApiError(0);
  return { id: uuid(item.id), workspaceId, name: string(item.name) };
}
export function parseServices(value: unknown, workspaceId: string): Service[] {
  const items = record(value).services;
  if (!Array.isArray(items)) throw new ApiError(0);
  return items.map((item) => service(item, workspaceId));
}
export function parseService(value: unknown, workspaceId: string): Service {
  return service(record(value).service, workspaceId);
}
export function parseInvitation(value: unknown, workspaceId: string): Invitation {
  const item = record(record(value).invitation);
  if (item.workspaceId !== workspaceId) throw new ApiError(0);
  const token = string(item.token);
  const expiresAt = string(item.expiresAt);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !Number.isFinite(Date.parse(expiresAt)))
    throw new ApiError(0);
  return { id: uuid(item.id), workspaceId, email: string(item.email), expiresAt, token };
}
export function parseAcceptance(value: unknown): string {
  return uuid(record(value).workspaceId);
}
export function apiOrigin(value: unknown): string {
  if (value === undefined || value === '') return 'http://localhost:3000';
  if (typeof value !== 'string') throw new ApiError(0);
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new ApiError(0);
    return url.origin;
  } catch {
    throw new ApiError(0);
  }
}
export async function request<T>(
  path: string,
  parse: (value: unknown) => T,
  options: { signal?: AbortSignal; body?: object } = {},
): Promise<T> {
  const response = await fetch(`${apiOrigin(import.meta.env.VITE_API_URL)}${path}`, {
    method: options.body ? 'POST' : 'GET',
    credentials: 'include',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.body
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }
      : {}),
  });
  if (!response.ok) throw new ApiError(response.status);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiError(0);
  }
  return parse(value);
}
export function parseRedirect(value: unknown): string {
  const data = record(value);
  if (data.redirect !== false) throw new ApiError(0);
  try {
    const url = new URL(string(data.url));
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/login/oauth/authorize' ||
      url.hash
    )
      throw new ApiError(0);
    return url.href;
  } catch {
    throw new ApiError(0);
  }
}
export function parseLogout(value: unknown): void {
  if (record(value).success !== true) throw new ApiError(0);
}

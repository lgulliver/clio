export type NotificationHttpFailure =
  | 'aborted'
  | 'network'
  | 'redirect'
  | 'status'
  | 'oversize'
  | 'malformed';

/** Reads one property of an unknown object without asserting its shape. */
export function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

const maximumRetryAfterMs = 3_600_000;

/** Safe, body-free failure. Never carries request or response content. */
export class NotificationHttpError extends Error {
  readonly failure: NotificationHttpFailure;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  constructor(
    failure: NotificationHttpFailure,
    status: number | null,
    retryAfterMs: number | null,
  ) {
    super(`notification_http_${failure}`);
    this.failure = failure;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfter(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (value === null || !/^\d{1,9}$/.test(value.trim())) return null;
  return Math.min(Number(value.trim()) * 1000, maximumRetryAfterMs);
}
/** Combines the caller's abort signal with a network deadline of at most `milliseconds`. */
export function notificationDeadline(signal: AbortSignal, milliseconds: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is being thrown away; a failed cancel changes nothing.
  }
}
async function readBounded(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await discard(response);
    throw new NotificationHttpError('oversize', null, null);
  }
  if (response.body === null) throw new NotificationHttpError('malformed', null, null);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new NotificationHttpError('oversize', null, null);
      }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof NotificationHttpError) throw error;
    throw new NotificationHttpError('network', null, null);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Fixed-endpoint JSON request for notification and identity providers. Callers supply an
 * allowlisted URL; this helper never follows redirects, bounds the decoded body while it is
 * streamed, and discards the transient payload after parsing. Non-2xx statuses become typed
 * body-free failures (429 carries a bounded Retry-After).
 */
export async function boundedNotificationJson(
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<unknown> {
  if (url.username || url.password) throw new NotificationHttpError('malformed', null, null);
  if (signal.aborted) throw new NotificationHttpError('aborted', null, null);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new NotificationHttpError('aborted', null, null));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // Abort wins even if a fetch implementation ignores the signal.
  aborted.catch(() => {});
  const work = request(url, init, signal, maximumBytes);
  work.catch(() => {});
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
async function request(
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await globalThis.fetch(url, { ...init, redirect: 'manual', signal });
  } catch {
    throw new NotificationHttpError(signal.aborted ? 'aborted' : 'network', null, null);
  }
  if (response.status >= 300 && response.status < 400) {
    await discard(response);
    throw new NotificationHttpError('redirect', response.status, null);
  }
  if (response.status < 200 || response.status >= 300) {
    const delay = response.status === 429 ? retryAfter(response.headers) : null;
    await discard(response);
    throw new NotificationHttpError('status', response.status, delay);
  }
  let text: string;
  try {
    text = await readBounded(response, maximumBytes);
  } catch (error) {
    if (error instanceof NotificationHttpError)
      throw error.failure === 'network' && signal.aborted
        ? new NotificationHttpError('aborted', null, null)
        : error;
    throw new NotificationHttpError('malformed', null, null);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new NotificationHttpError('malformed', null, null);
  }
}

import { AdapterError } from './value.ts';

export class GitHubRateLimitError extends AdapterError {
  readonly retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super('rate_limited');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Untrusted response metadata; never include provider payloads in errors. */
export async function githubRateLimit(response: Response, clock: () => Date) {
  const seconds = (value: string | null) =>
    value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const retry = seconds(response.headers.get('retry-after'));
  const reset = seconds(response.headers.get('x-ratelimit-reset'));
  const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
  let limited =
    response.status === 429 || (response.status === 403 && (exhausted || retry !== null));
  if (response.status === 403 && !limited) {
    try {
      const body: unknown = await response.clone().json();
      limited =
        typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        typeof body.message === 'string' &&
        /(?:secondary|API) rate limit/i.test(body.message);
    } catch {
      // A malformed permission response is not evidence of quota exhaustion.
    }
  }
  const delay = Math.max(
    retry ?? 0,
    exhausted && reset !== null ? Math.max(0, reset - Math.floor(clock().getTime() / 1000)) : 0,
  );
  return {
    limited,
    exhausted,
    retryAfterSeconds: delay > 0 ? delay : null,
    resetAtUnixSeconds: exhausted ? reset : null,
  };
}

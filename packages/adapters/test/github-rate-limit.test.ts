import { expect, it } from 'vitest';
import { githubRateLimit } from '../src/github-rate-limit.ts';

const clock = () => new Date('2026-01-01T00:00:00Z');
it('keeps the later provider deadline when retry and primary reset both apply', async () => {
  const response = new Response('', {
    status: 403,
    headers: {
      'retry-after': '600',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(clock().getTime() / 1000 + 9999),
    },
  });
  expect(await githubRateLimit(response, clock)).toMatchObject({
    limited: true,
    retryAfterSeconds: 9999,
  });
});
it('recognizes secondary 403 without headers and leaves permission failures distinct', async () => {
  const response = new Response(
    JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }),
    { status: 403 },
  );
  expect(await githubRateLimit(response, clock)).toMatchObject({
    limited: true,
    retryAfterSeconds: null,
  });
  expect(await response.json()).toHaveProperty('message');
  expect(
    await githubRateLimit(
      new Response('{"message":"Resource not accessible by integration"}', { status: 403 }),
      clock,
    ),
  ).toMatchObject({ limited: false });
});
it('recognizes successful exhaustion and ignores malformed throttling headers', async () => {
  expect(
    await githubRateLimit(
      new Response('[]', {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(clock().getTime() / 1000 + 900),
        },
      }),
      clock,
    ),
  ).toMatchObject({ limited: false, exhausted: true, retryAfterSeconds: 900 });
  expect(
    await githubRateLimit(
      new Response('', { status: 429, headers: { 'retry-after': '9007199254740992' } }),
      clock,
    ),
  ).toMatchObject({ limited: true, retryAfterSeconds: null });
});

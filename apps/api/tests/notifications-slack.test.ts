import { afterEach, describe, expect, it } from 'vitest';
import {
  boundedNotificationJson,
  NotificationHttpError,
} from '../src/features/notifications/http.ts';
import { createNotificationProvider } from '../src/features/notifications/provider.ts';
import { classifySlack, SlackVerificationError } from '../src/features/notifications/slack.ts';
import { renderNotice } from '../src/features/notifications/templates.ts';
import {
  configFor,
  fixtureBotToken,
  jsonResponse,
  mockFetch,
  slackGrant,
  truncatedResponse,
  workspaceId,
} from './fixtures/notification-transports.ts';

const message = renderNotice(
  'invitation',
  `https://clio.example.test/developer-experience?workspace=${workspaceId}`,
);
const grant = slackGrant();
const provider = createNotificationProvider(configFor('live', [grant]));
const live = (): AbortSignal => new AbortController().signal;
const uncertain = { outcome: 'uncertain', reason: 'acceptance_unknown' } as const;
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});
function stub(handler: Parameters<typeof mockFetch>[0]) {
  const mock = mockFetch(handler);
  restore = mock.restore;
  return mock.calls;
}

describe('classifySlack', () => {
  it('accepts only an explicit ok:true', () => {
    expect(classifySlack({ ok: true, channel: 'D0FIXTURE' })).toEqual({ outcome: 'accepted' });
    for (const value of [{ ok: 'true' }, { ok: 1 }, {}, null, 'ok', [], { ok: false }])
      expect(classifySlack(value).outcome).not.toBe('accepted');
  });

  it('treats the allowlisted refusals as known non-acceptance', () => {
    const recipient = ['user_not_found', 'channel_not_found', 'account_inactive', 'no_permission'];
    const configuration = ['invalid_auth', 'token_revoked', 'missing_scope', 'not_authed'];
    for (const error of recipient)
      expect(classifySlack({ ok: false, error })).toEqual({
        outcome: 'not_accepted',
        retryable: false,
        reason: 'recipient_unavailable',
      });
    for (const error of configuration)
      expect(classifySlack({ ok: false, error })).toEqual({
        outcome: 'not_accepted',
        retryable: false,
        reason: 'configuration_invalid',
      });
  });

  it('keeps internal, fatal, unknown and malformed responses uncertain', () => {
    expect(classifySlack({ ok: false, error: 'internal_error' })).toEqual(uncertain);
    expect(classifySlack({ ok: false, error: 'fatal_error' })).toEqual(uncertain);
    expect(classifySlack({ ok: false, error: 'some_new_error' })).toEqual(uncertain);
    expect(classifySlack({ ok: false })).toEqual(uncertain);
    expect(classifySlack({ ok: false, error: 42 })).toEqual(uncertain);
    expect(classifySlack(undefined)).toEqual(uncertain);
  });
});

describe('boundedNotificationJson', () => {
  const url = new URL('https://slack.com/api/auth.test');
  it('parses JSON without following redirects and passes the abort signal', async () => {
    const calls = stub(() => jsonResponse({ ok: true }));
    const controller = new AbortController();
    await expect(
      boundedNotificationJson(url, { method: 'POST' }, controller.signal, 65536),
    ).resolves.toEqual({ ok: true });
    expect(calls[0]?.init?.redirect).toBe('manual');
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects redirects, oversize bodies, malformed JSON and truncated bodies', async () => {
    stub(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }));
    await expect(boundedNotificationJson(url, {}, live(), 1024)).rejects.toMatchObject({
      failure: 'redirect',
    });
    restore?.();
    stub(() => new Response(`{"ok":true,"pad":"${'x'.repeat(2048)}"}`, { status: 200 }));
    await expect(boundedNotificationJson(url, {}, live(), 1024)).rejects.toMatchObject({
      failure: 'oversize',
    });
    restore?.();
    stub(() => new Response('not json', { status: 200 }));
    await expect(boundedNotificationJson(url, {}, live(), 1024)).rejects.toMatchObject({
      failure: 'malformed',
    });
    restore?.();
    stub(() => truncatedResponse('{"ok":tr'));
    await expect(boundedNotificationJson(url, {}, live(), 1024)).rejects.toMatchObject({
      failure: 'network',
    });
  });

  it('stops reading at the limit even when the declared length is absent', async () => {
    let pulled = 0;
    const encoder = new TextEncoder();
    stub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(encoder.encode('x'.repeat(512)));
            },
          }),
          { status: 200 },
        ),
    );
    await expect(boundedNotificationJson(url, {}, live(), 4096)).rejects.toMatchObject({
      failure: 'oversize',
    });
    expect(pulled).toBeLessThan(20);
  });

  it('reports 429 with a bounded Retry-After and other statuses without body details', async () => {
    stub(() => new Response('', { status: 429, headers: { 'retry-after': '7' } }));
    await expect(boundedNotificationJson(url, {}, live(), 1024)).rejects.toMatchObject({
      failure: 'status',
      status: 429,
      retryAfterMs: 7000,
    });
    restore?.();
    stub(() => new Response('', { status: 429, headers: { 'retry-after': '999999999' } }));
    const error = await boundedNotificationJson(url, {}, live(), 1024).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(NotificationHttpError);
    if (error instanceof NotificationHttpError)
      expect(error.retryAfterMs).toBeLessThanOrEqual(3_600_000);
    restore?.();
    stub(() => new Response('secret-token-body', { status: 503 }));
    const failure = await boundedNotificationJson(url, {}, live(), 1024).catch(
      (reason: unknown) => reason,
    );
    expect(String(failure)).not.toContain('secret-token-body');
  });

  it('aborts promptly', async () => {
    stub(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const controller = new AbortController();
    const pending = boundedNotificationJson(url, {}, controller.signal, 1024);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ failure: 'aborted' });
  });

  it('rejects URLs carrying credentials', async () => {
    stub(() => jsonResponse({}));
    await expect(
      boundedNotificationJson(new URL('https://user:pw@slack.com/api/auth.test'), {}, live(), 1024),
    ).rejects.toBeInstanceOf(NotificationHttpError);
  });
});

describe('Slack provider', () => {
  it('verifies the exact workspace identity with auth.test', async () => {
    const calls = stub(() => jsonResponse({ ok: true, team_id: 'T0FIXTURE', team: 'Hidden Team' }));
    await expect(provider.verifySlack(grant, live())).resolves.toEqual({ teamId: 'T0FIXTURE' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://slack.com/api/auth.test');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
      `Bearer ${fixtureBotToken}`,
    );
  });

  it('distinguishes wrong team, rejection, rate limiting and outage without leaking', async () => {
    stub(() => jsonResponse({ ok: true, team_id: 'T0OTHER' }));
    await expect(provider.verifySlack(grant, live())).rejects.toMatchObject({
      failure: 'team_mismatch',
    });
    restore?.();
    stub(() => jsonResponse({ ok: false, error: 'invalid_auth' }));
    await expect(provider.verifySlack(grant, live())).rejects.toMatchObject({
      failure: 'rejected',
    });
    restore?.();
    stub(() => new Response('', { status: 429, headers: { 'retry-after': '30' } }));
    const limited = await provider.verifySlack(grant, live()).catch((reason: unknown) => reason);
    expect(limited).toBeInstanceOf(SlackVerificationError);
    expect(limited).toMatchObject({ failure: 'rate_limited', retryAfterMs: 30_000 });
    restore?.();
    stub(() => new Response('', { status: 502 }));
    await expect(provider.verifySlack(grant, live())).rejects.toMatchObject({
      failure: 'unavailable',
    });
    restore?.();
    stub(() => jsonResponse({ ok: true }));
    await expect(provider.verifySlack(grant, live())).rejects.toMatchObject({
      failure: 'unavailable',
    });
    for (const error of [limited, new SlackVerificationError('rejected', null)])
      expect(String(error)).not.toContain(fixtureBotToken);
  });

  it('refuses to call Slack without a Slack profile', async () => {
    const calls = stub(() => jsonResponse({ ok: true }));
    const noSlack = { ...grant, slack: null };
    await expect(provider.verifySlack(noSlack, live())).rejects.toMatchObject({
      failure: 'rejected',
    });
    await expect(provider.openDm(noSlack, 'U0FIXTURE', live())).resolves.toMatchObject({
      outcome: 'not_accepted',
      reason: 'configuration_invalid',
    });
    expect(calls).toHaveLength(0);
  });

  it('opens a DM for exactly one validated user', async () => {
    const calls = stub(() => jsonResponse({ ok: true, channel: { id: 'D0FIXTURE' } }));
    await expect(provider.openDm(grant, 'U0FIXTURE', live())).resolves.toEqual({
      channelId: 'D0FIXTURE',
    });
    expect(calls[0]?.url).toBe('https://slack.com/api/conversations.open');
    const body: unknown = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({ users: 'U0FIXTURE', return_im: false });
    for (const user of ['U1,U2', 'u0lower', '', 'U0 SPACE', '../x'])
      await expect(provider.openDm(grant, user, live())).resolves.toMatchObject({
        outcome: 'not_accepted',
        retryable: false,
        reason: 'recipient_unavailable',
      });
    expect(calls).toHaveLength(1);
  });

  it('never reports a failed DM open as an uncertain message submission', async () => {
    for (const reply of [
      jsonResponse({ ok: false, error: 'internal_error' }),
      jsonResponse({ ok: false, error: 'fatal_error' }),
      new Response('', { status: 500 }),
      truncatedResponse('{"ok":'),
      jsonResponse({ ok: true, channel: { id: 'not-a-dm' } }),
    ]) {
      stub(() => reply);
      const result = await provider.openDm(grant, 'U0FIXTURE', live());
      expect(result).toEqual({
        outcome: 'not_accepted',
        retryable: true,
        reason: 'provider_unavailable',
      });
      restore?.();
    }
    stub(() => jsonResponse({ ok: false, error: 'user_not_found' }));
    await expect(provider.openDm(grant, 'U0FIXTURE', live())).resolves.toEqual({
      outcome: 'not_accepted',
      retryable: false,
      reason: 'recipient_unavailable',
    });
    restore?.();
    stub(() => new Response('', { status: 429, headers: { 'retry-after': '5' } }));
    await expect(provider.openDm(grant, 'U0FIXTURE', live())).resolves.toEqual({
      outcome: 'not_accepted',
      retryable: true,
      reason: 'provider_unavailable',
      retryAfterMs: 5000,
    });
  });

  it('posts one non-unfurling message to the opened DM and accepts only ok:true', async () => {
    const calls = stub(() => jsonResponse({ ok: true, channel: 'D0FIXTURE', ts: '1.1' }));
    await expect(provider.sendSlack(grant, 'D0FIXTURE', message, live())).resolves.toEqual({
      outcome: 'accepted',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    const body: unknown = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      channel: 'D0FIXTURE',
      text: message.slackText,
      unfurl_links: false,
      unfurl_media: false,
    });
    await expect(provider.sendSlack(grant, '#general', message, live())).resolves.toMatchObject({
      outcome: 'not_accepted',
      retryable: false,
    });
    await expect(provider.sendSlack(grant, 'C0PUBLIC', message, live())).resolves.toMatchObject({
      outcome: 'not_accepted',
    });
    expect(calls).toHaveLength(1);
  });

  it('is uncertain after any ambiguous post response, truncated body, timeout or server error', async () => {
    for (const reply of [
      jsonResponse({ ok: false, error: 'internal_error' }),
      jsonResponse({ ok: false, error: 'fatal_error' }),
      jsonResponse({ ok: false, error: 'surprise' }),
      truncatedResponse('{"ok":tr'),
      new Response('<html>bad gateway</html>', { status: 502 }),
      new Response('not json', { status: 200 }),
      new Response(`{"ok":true,"pad":"${'x'.repeat(70000)}"}`, { status: 200 }),
      new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    ]) {
      stub(() => reply);
      expect(await provider.sendSlack(grant, 'D0FIXTURE', message, live())).toEqual(uncertain);
      restore?.();
    }
    stub(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const pending = provider.sendSlack(grant, 'D0FIXTURE', message, controller.signal);
    controller.abort();
    expect(await pending).toEqual(uncertain);
  });

  it('treats 429 as a known rejection with a delay and definitive refusals as not accepted', async () => {
    stub(() => new Response('', { status: 429, headers: { 'retry-after': '12' } }));
    expect(await provider.sendSlack(grant, 'D0FIXTURE', message, live())).toEqual({
      outcome: 'not_accepted',
      retryable: true,
      reason: 'provider_unavailable',
      retryAfterMs: 12_000,
    });
    restore?.();
    stub(() => jsonResponse({ ok: false, error: 'token_revoked' }));
    expect(await provider.sendSlack(grant, 'D0FIXTURE', message, live())).toEqual({
      outcome: 'not_accepted',
      retryable: false,
      reason: 'configuration_invalid',
    });
  });

  it('does not call Slack when the deadline has already passed and exposes nothing sensitive', async () => {
    const calls = stub(() => jsonResponse({ ok: true }));
    const aborted = AbortSignal.abort();
    const result = await provider.sendSlack(grant, 'D0FIXTURE', message, aborted);
    expect(result).toEqual({
      outcome: 'not_accepted',
      retryable: true,
      reason: 'provider_unavailable',
    });
    expect(calls).toHaveLength(0);
    const serialized = JSON.stringify([
      result,
      classifySlack({ ok: false, error: 'invalid_auth', detail: fixtureBotToken }),
    ]);
    expect(serialized).not.toContain(fixtureBotToken);
    expect(serialized).not.toContain(message.slackText);
  });
});

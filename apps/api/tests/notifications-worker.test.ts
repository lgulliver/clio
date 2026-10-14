import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NotificationConfig } from '../src/features/notifications/config.ts';
import {
  decideRoute,
  ineligibility,
  pacingFor,
  retryDelayMs,
  settleDispatch,
} from '../src/features/notifications/jobs.ts';
import {
  createProductionConfigNow,
  openDirectMessage,
} from '../src/features/notifications/worker.ts';

const slack = { teamId: 'T1', slackUserId: 'U1', bindingRevision: 1 };
const base = {
  kind: 'invitation',
  channel: null,
  uncertainReplays: 0,
  slackAttempts: 0,
  emailAttempts: 0,
  lastReason: null,
  slack,
  email: 'member@example.com',
} as const;

describe('transport routing', () => {
  it('uses Slack first, goes directly to verified email without a link, and never invents a destination', () => {
    expect(decideRoute(base)).toMatchObject({ kind: 'send', route: { channel: 'slack' } });
    expect(decideRoute({ ...base, slack: null })).toMatchObject({
      kind: 'send',
      route: { channel: 'email', email: 'member@example.com' },
    });
    expect(decideRoute({ ...base, slack: null, email: null })).toEqual({
      kind: 'end',
      state: 'skipped',
      reason: 'no_destination',
    });
  });

  it('falls to email once Slack is exhausted or pinned away, and never returns to Slack', () => {
    expect(decideRoute({ ...base, slackAttempts: 3 })).toMatchObject({
      route: { channel: 'email' },
    });
    expect(decideRoute({ ...base, channel: 'email', slackAttempts: 1 })).toMatchObject({
      route: { channel: 'email' },
    });
  });

  it('keeps tests and explicit uncertainty replays on their exact channel without fallback', () => {
    expect(decideRoute({ ...base, kind: 'test', channel: 'slack', slack: null })).toEqual({
      kind: 'end',
      state: 'skipped',
      reason: 'no_destination',
    });
    expect(
      decideRoute({ ...base, uncertainReplays: 1, channel: 'slack', slack: null }),
    ).toMatchObject({
      kind: 'end',
    });
    expect(decideRoute({ ...base, uncertainReplays: 1, channel: 'email' })).toMatchObject({
      route: { channel: 'email' },
    });
  });

  it('fails rather than skips once a transport was actually attempted', () => {
    expect(
      decideRoute({
        ...base,
        channel: 'email',
        slack: null,
        emailAttempts: 3,
        lastReason: 'provider_unavailable',
      }),
    ).toEqual({ kind: 'end', state: 'failed', reason: 'provider_unavailable' });
  });
});

describe('dispatch settlement', () => {
  const refused = (retryable: boolean) =>
    ({ outcome: 'not_accepted', retryable, reason: 'provider_unavailable' }) as const;
  const common = { channel: 'slack', attempts: 1, fallbackAllowed: true, fits: true } as const;

  it('never retries or falls back after uncertainty, and accepts only explicit acceptance', () => {
    expect(
      settleDispatch({
        ...common,
        result: { outcome: 'uncertain', reason: 'acceptance_unknown' },
      }),
    ).toEqual({ kind: 'uncertain' });
    expect(settleDispatch({ ...common, result: { outcome: 'accepted' } })).toEqual({
      kind: 'accepted',
    });
  });

  it('retries known refusals within bounds, then falls back from Slack only for ordinary events', () => {
    expect(settleDispatch({ ...common, result: refused(true) })).toMatchObject({ kind: 'retry' });
    expect(settleDispatch({ ...common, attempts: 3, result: refused(true) })).toMatchObject({
      kind: 'fallback',
    });
    expect(settleDispatch({ ...common, result: refused(false) })).toMatchObject({
      kind: 'fallback',
    });
    expect(settleDispatch({ ...common, fits: false, result: refused(true) })).toMatchObject({
      kind: 'fallback',
    });
    expect(
      settleDispatch({ ...common, fallbackAllowed: false, result: refused(false) }),
    ).toMatchObject({ kind: 'failed' });
    expect(settleDispatch({ ...common, channel: 'email', result: refused(false) })).toMatchObject({
      kind: 'failed',
    });
  });

  it('caps exponential backoff at fifteen minutes but lets a provider cooldown lengthen it', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(30)).toBe(15 * 60_000);
    expect(retryDelayMs(1, 3_600_000)).toBe(3_600_000);
    expect(retryDelayMs(1, Number.MAX_SAFE_INTEGER)).toBe(24 * 60 * 60_000);
  });
});

describe('current-context eligibility', () => {
  const event = { kind: 'reminder', grantFingerprint: 'a'.repeat(64), expired: false } as const;
  const facts = {
    member: true,
    pulseState: 'open',
    submitted: false,
    frozenActive: true,
    remindersEnabled: true,
    workspaceEnabled: true,
    workspaceFingerprint: 'a'.repeat(64),
    olderUnresolved: false,
    email: null,
    bindingRevision: null,
    slackUserId: null,
  };
  const grant = { fingerprint: 'a'.repeat(64) };

  it('is eligible only while every current fence agrees', () => {
    expect(ineligibility(event, facts, grant)).toBeNull();
    expect(ineligibility({ ...event, expired: true }, facts, grant)).toBe('expired');
    expect(ineligibility(event, { ...facts, member: false }, grant)).toBe('access_removed');
    expect(ineligibility(event, { ...facts, submitted: true }, grant)).toBe('response_received');
    expect(ineligibility(event, { ...facts, pulseState: 'closed' }, grant)).toBe('pulse_inactive');
    expect(ineligibility(event, { ...facts, remindersEnabled: false }, grant)).toBe(
      'reminders_disabled',
    );
    expect(ineligibility(event, { ...facts, workspaceEnabled: false }, grant)).toBe(
      'integration_disabled',
    );
    expect(ineligibility(event, facts, { fingerprint: 'b'.repeat(64) })).toBe(
      'integration_disabled',
    );
    expect(ineligibility(event, facts, null)).toBe('integration_disabled');
  });

  it('lets closure notices through a closed pulse and tests through disabled switches', () => {
    expect(
      ineligibility({ ...event, kind: 'closure' }, { ...facts, pulseState: 'closed' }, grant),
    ).toBeNull();
    expect(
      ineligibility(
        { ...event, kind: 'closure' },
        { ...facts, pulseState: 'closed', submitted: true },
        grant,
      ),
    ).toBeNull();
    expect(
      ineligibility(
        { ...event, kind: 'test' },
        { ...facts, pulseState: null, workspaceEnabled: false, frozenActive: false },
        grant,
      ),
    ).toBeNull();
  });
});

describe('production configuration authority', () => {
  const config: NotificationConfig = {
    mode: 'live',
    publicOrigin: 'https://clio.example.com',
    grants: [],
  };
  const auth = {
    AUTH_SECRET: 'x'.repeat(40),
    AUTH_BASE_URL: 'https://clio.example.com',
    APP_ORIGIN: 'https://clio.example.com',
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
  };

  it('requires the notification origin to equal the trusted application origin', async () => {
    const same = createProductionConfigNow(auth, async () => config);
    await expect(same()).resolves.toBe(config);
    const moved = createProductionConfigNow(
      { ...auth, APP_ORIGIN: 'https://other.example.com' },
      async () => config,
    );
    await expect(moved()).rejects.toThrow('Invalid notification configuration');
    await expect(createProductionConfigNow({}, async () => config)()).rejects.toThrow(
      'Invalid notification configuration',
    );
  });

  it('stays disabled without configuration and re-reads on every call', async () => {
    let calls = 0;
    let current: NotificationConfig | null = null;
    const now = createProductionConfigNow(auth, async () => {
      calls += 1;
      return current;
    });
    await expect(now()).resolves.toBeNull();
    current = config;
    await expect(now()).resolves.toBe(config);
    expect(calls).toBe(2);
  });
});

describe('response privacy', () => {
  it('keeps notification code away from stored raw answers', async () => {
    const directory = join(import.meta.dirname, '../src/features/notifications');
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.ts')) continue;
      const source = await readFile(join(directory, name), 'utf8');
      expect(source.replaceAll(/\/\/.*$/gm, '')).not.toMatch(/space_answers/);
    }
  });
});

describe('absolute dispatch authorization', () => {
  const grant = {
    workspaceId: 'w',
    fingerprint: 'a'.repeat(64),
    credentialFingerprint: 'b'.repeat(64),
    slack: null,
    smtp: {
      host: 'smtp.example.test',
      port: 465,
      user: 'u',
      password: 'p',
      from: 'clio@example.test',
      ratePerMinute: 60,
    },
  };
  const route = { channel: 'slack', teamId: 'T1', slackUserId: 'U1', bindingRevision: 1 } as const;

  it('does not call the provider when the DM authorization is already known to be expired', async () => {
    let calls = 0;
    const provider: Parameters<typeof openDirectMessage>[0] = {
      verifySlack: async () => ({ teamId: 'T1' }),
      openDm: async () => {
        calls += 1;
        return { channelId: 'D1' };
      },
      sendSlack: async () => ({ outcome: 'accepted' }),
      sendEmail: async () => ({ outcome: 'accepted' }),
    };
    // Expired: leaves less than the 1 s call budget after the 5 s begin reserve.
    expect(
      await openDirectMessage(provider, grant, route, undefined, performance.now() + 5500),
    ).toBe('expired');
    expect(await openDirectMessage(provider, grant, route, undefined, performance.now() - 10)).toBe(
      'expired',
    );
    expect(calls).toBe(0);
    expect(
      await openDirectMessage(provider, grant, route, undefined, performance.now() + 20_000),
    ).toBe('D1');
    expect(calls).toBe(1);
  });

  it('derives pacing from the fresh grant: same budget key, new spacing', () => {
    const email = { channel: 'email', email: 'a@example.test' } as const;
    const fast = pacingFor(email, grant);
    const slow = pacingFor(email, { ...grant, smtp: { ...grant.smtp, ratePerMinute: 1 } });
    expect(fast).toMatchObject({ kind: 'smtp', spacingMs: 1000 });
    expect(slow).toMatchObject({ kind: 'smtp', spacingMs: 60_000 });
    expect(fast.kind === 'smtp' && slow.kind === 'smtp' && fast.key === slow.key).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { ApiError } from '../identity/api';
import { historyId, pulseId, workspaceId } from '../space/fixtures.test-support';
import {
  notificationError,
  parseDeliverySummary,
  parseNotificationAvailability,
  parseNotificationBatch,
  parseNotificationPolicy,
  parseOwnNotificationPage,
  parseOwnSlackLink,
  parseSlackAuthorizeUrl,
  rateLimitedText,
  unknownOutcome,
} from './api';

const scope = { workspaceId };
const at = '2026-10-13T09:00:00.000Z';
const policy = {
  revision: 2,
  enabled: true,
  invitations: true,
  closures: false,
  reminders: true,
  firstReminderHours: 48,
  repeatHours: 72,
  maximumReminders: 2,
};
const counts = {
  pending: 1,
  leased: 0,
  retry_scheduled: 0,
  provider_accepted: 4,
  skipped: 2,
  failed: 1,
  uncertain: 0,
};
function item(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: historyId(index),
    pulseId: pulseId(1),
    kind: 'invitation',
    state: 'provider_accepted',
    channel: 'slack',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
function thrown(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}
function unverifiable(run: () => unknown) {
  const error = thrown(run);
  return error instanceof ApiError && error.status === 0;
}

describe('notification response parsing', () => {
  it('accepts the exact availability, policy and link envelopes', () => {
    expect(
      parseNotificationAvailability(
        { workspaceId, emailConfigured: true, slackConfigured: true, linkingConfigured: true },
        scope,
      ),
    ).toEqual({
      workspaceId,
      emailConfigured: true,
      slackConfigured: true,
      linkingConfigured: true,
    });
    expect(parseNotificationPolicy({ policy })).toEqual(policy);
    expect(parseOwnSlackLink({ link: { linked: true, revision: 3, linkedAt: at } })).toEqual({
      linked: true,
      revision: 3,
      linkedAt: at,
    });
  });

  it('rejects other workspaces, extra keys, unbounded values and inconsistent state', () => {
    const base = { emailConfigured: true, slackConfigured: false, linkingConfigured: false };
    expect(
      unverifiable(() =>
        parseNotificationAvailability({ ...base, workspaceId: historyId(1) }, scope),
      ),
    ).toBe(true);
    expect(
      unverifiable(() =>
        parseNotificationAvailability({ ...base, workspaceId, slackAccount: 'U1' }, scope),
      ),
    ).toBe(true);
    // Linking cannot exist without Slack delivery.
    expect(
      unverifiable(() =>
        parseNotificationAvailability({ ...base, workspaceId, linkingConfigured: true }, scope),
      ),
    ).toBe(true);
    for (const bad of [
      { ...policy, firstReminderHours: 23 },
      { ...policy, repeatHours: 169 },
      { ...policy, maximumReminders: 4 },
      { ...policy, revision: -1 },
      { ...policy, enabled: 'yes' },
      { ...policy, token: 'x' },
    ])
      expect(unverifiable(() => parseNotificationPolicy({ policy: bad }))).toBe(true);
    expect(unverifiable(() => parseNotificationPolicy(policy))).toBe(true);
    // A link is linked exactly when it records when.
    expect(
      unverifiable(() =>
        parseOwnSlackLink({ link: { linked: true, revision: 1, linkedAt: null } }),
      ),
    ).toBe(true);
    expect(
      unverifiable(() => parseOwnSlackLink({ link: { linked: false, revision: 1, linkedAt: at } })),
    ).toBe(true);
  });

  it('keeps own history to the safe fields and a coherent page', () => {
    const page = parseOwnNotificationPage(
      { workspaceId, items: [item(1), item(2, { kind: 'test', pulseId: null })], nextCursor: null },
      scope,
    );
    expect(page.items).toHaveLength(2);
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(
      ['channel', 'createdAt', 'id', 'kind', 'pulseId', 'state', 'updatedAt'].sort(),
    );
    const bad = (row: unknown) =>
      unverifiable(() =>
        parseOwnNotificationPage({ workspaceId, items: [row], nextCursor: null }, scope),
      );
    expect(bad(item(1, { recipient: 'someone@example.test' }))).toBe(true);
    expect(bad(item(1, { kind: 'test' }))).toBe(true); // a test names no pulse
    expect(bad(item(1, { pulseId: null }))).toBe(true); // other kinds always do
    expect(bad(item(1, { channel: null }))).toBe(true); // accepted means a channel was used
    expect(bad(item(1, { channel: null, state: 'uncertain' }))).toBe(true);
    expect(bad(item(1, { state: 'delivered' }))).toBe(true);
    expect(bad(item(1, { updatedAt: '2026-10-13T08:59:59.000Z' }))).toBe(true);
    expect(bad(item(1, { createdAt: 'yesterday' }))).toBe(true);
    expect(
      unverifiable(() =>
        parseOwnNotificationPage({ workspaceId: historyId(9), items: [], nextCursor: null }, scope),
      ),
    ).toBe(true);
    expect(
      unverifiable(() =>
        parseOwnNotificationPage(
          { workspaceId, items: [item(1), item(1)], nextCursor: null },
          scope,
        ),
      ),
    ).toBe(true);
  });

  it('accepts a continuation cursor only after a full page and never repeats the one used', () => {
    const full = Array.from({ length: 25 }, (_, index) => item(index + 1));
    expect(
      parseOwnNotificationPage({ workspaceId, items: full, nextCursor: 'abc_-9' }, scope)
        .nextCursor,
    ).toBe('abc_-9');
    for (const nextCursor of ['has space', '', 7, 'x'.repeat(2049)])
      expect(
        unverifiable(() =>
          parseOwnNotificationPage({ workspaceId, items: full, nextCursor }, scope),
        ),
      ).toBe(true);
    expect(
      unverifiable(() =>
        parseOwnNotificationPage({ workspaceId, items: full.slice(1), nextCursor: 'abc' }, scope),
      ),
    ).toBe(true);
    expect(
      unverifiable(() =>
        parseOwnNotificationPage(
          { workspaceId, items: full, nextCursor: 'same' },
          { workspaceId, cursor: 'same' },
        ),
      ),
    ).toBe(true);
    expect(
      unverifiable(() =>
        parseOwnNotificationPage(
          {
            workspaceId,
            items: Array.from({ length: 26 }, (_, i) => item(i + 1)),
            nextCursor: null,
          },
          scope,
        ),
      ),
    ).toBe(true);
  });

  it('parses an aggregate summary for the expected pulse only', () => {
    const body = { workspaceId, pulseId: pulseId(1), counts, remindersEnabled: true, revision: 4 };
    expect(parseDeliverySummary(body, { workspaceId, pulseId: pulseId(1) }).counts.failed).toBe(1);
    expect(
      unverifiable(() => parseDeliverySummary(body, { workspaceId, pulseId: pulseId(2) })),
    ).toBe(true);
    expect(
      unverifiable(() =>
        parseDeliverySummary(
          { ...body, counts: { ...counts, failures: ['someone'] } },
          { workspaceId, pulseId: pulseId(1) },
        ),
      ),
    ).toBe(true);
    // A missing state is not zero.
    const { uncertain: _omitted, ...partial } = counts;
    expect(
      unverifiable(() =>
        parseDeliverySummary({ ...body, counts: partial }, { workspaceId, pulseId: pulseId(1) }),
      ),
    ).toBe(true);
    expect(
      unverifiable(() =>
        parseDeliverySummary(
          { ...body, counts: { ...counts, failed: -1 } },
          { workspaceId, pulseId: pulseId(1) },
        ),
      ),
    ).toBe(true);
    expect(
      unverifiable(() =>
        parseDeliverySummary({ ...body, recipients: [] }, { workspaceId, pulseId: pulseId(1) }),
      ),
    ).toBe(true);
  });

  it('parses a batch acknowledgement without recipient detail', () => {
    expect(parseNotificationBatch({ requestId: historyId(1), queued: false })).toEqual({
      requestId: historyId(1),
      queued: false,
    });
    expect(
      unverifiable(() =>
        parseNotificationBatch({ requestId: historyId(1), queued: true, count: 3 }),
      ),
    ).toBe(true);
    expect(unverifiable(() => parseNotificationBatch({ requestId: 'x', queued: true }))).toBe(true);
  });
});

describe('Slack authorization URL', () => {
  const ok =
    'https://slack.com/openid/connect/authorize?response_type=code&scope=openid+profile&state=s';
  it('accepts only the fixed Slack OpenID endpoint', () => {
    expect(parseSlackAuthorizeUrl({ authorizeUrl: ok })).toBe(ok);
    for (const bad of [
      'http://slack.com/openid/connect/authorize',
      'https://evil.example/openid/connect/authorize',
      'https://slack.com.evil.example/openid/connect/authorize',
      'https://user:pw@slack.com/openid/connect/authorize',
      'https://slack.com:8443/openid/connect/authorize',
      'https://slack.com/openid/connect/authorize/../x',
      'https://slack.com/oauth/v2/authorize',
      'https://slack.com/openid/connect/authorize#frag',
      'javascript:alert(1)',
      '/openid/connect/authorize',
    ])
      expect(unverifiable(() => parseSlackAuthorizeUrl({ authorizeUrl: bad }))).toBe(true);
    expect(unverifiable(() => parseSlackAuthorizeUrl({ authorizeUrl: ok, redirect: ok }))).toBe(
      true,
    );
  });
});

describe('failure text', () => {
  it('uses fixed safe text for rate limits regardless of the provider', () => {
    expect(notificationError(new ApiError(429))).toBe(rateLimitedText);
    expect(rateLimitedText).not.toMatch(/\d/);
    expect(notificationError(new ApiError(403))).toBe(
      'You do not have permission for this action.',
    );
  });

  it('treats only unanswered or server failures as an unknown write outcome', () => {
    expect(unknownOutcome(new ApiError(0))).toBe(true);
    expect(unknownOutcome(new ApiError(503))).toBe(true);
    expect(unknownOutcome(new ApiError(409))).toBe(false);
    expect(unknownOutcome(new ApiError(429))).toBe(false);
    expect(unknownOutcome(new ApiError(400))).toBe(false);
  });
});

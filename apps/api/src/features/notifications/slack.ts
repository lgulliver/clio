import type { NotificationGrant } from './config.ts';
import type { DispatchResult, NoticeMessage } from './contract.ts';
import {
  boundedNotificationJson,
  field,
  NotificationHttpError,
  notificationDeadline,
} from './http.ts';

// Fixed Slack Web API endpoints. Nothing configurable reaches these.
const authTest = new URL('https://slack.com/api/auth.test');
const conversationsOpen = new URL('https://slack.com/api/conversations.open');
const chatPostMessage = new URL('https://slack.com/api/chat.postMessage');
const jsonLimit = 65536;

const recipientRefusals: ReadonlySet<string> = new Set([
  'user_not_found',
  'channel_not_found',
  'account_inactive',
  'no_permission',
]);
const configurationRefusals: ReadonlySet<string> = new Set([
  'invalid_auth',
  'token_revoked',
  'missing_scope',
  'not_authed',
]);
// Additional definitive refusals that can only come from conversations.open (no message exists yet).
const openRecipientRefusals: ReadonlySet<string> = new Set([
  ...recipientRefusals,
  'user_disabled',
  'user_not_visible',
  'cannot_dm_bot',
]);
const uncertain: DispatchResult = { outcome: 'uncertain', reason: 'acceptance_unknown' };
const unavailable: Extract<DispatchResult, { outcome: 'not_accepted' }> = {
  outcome: 'not_accepted',
  retryable: true,
  reason: 'provider_unavailable',
};

function refusal(error: unknown, recipients: ReadonlySet<string>): DispatchResult | null {
  if (typeof error !== 'string') return null;
  if (recipients.has(error))
    return { outcome: 'not_accepted', retryable: false, reason: 'recipient_unavailable' };
  if (configurationRefusals.has(error))
    return { outcome: 'not_accepted', retryable: false, reason: 'configuration_invalid' };
  return null;
}

/**
 * Classifies a parsed chat.postMessage response. Only an explicit ok:true is acceptance; only the
 * allowlisted definitive refusals are known non-acceptance; everything else may have submitted.
 */
export function classifySlack(value: unknown): DispatchResult {
  const ok = field(value, 'ok');
  if (ok === true) return { outcome: 'accepted' };
  if (ok === false) return refusal(field(value, 'error'), recipientRefusals) ?? uncertain;
  return uncertain;
}

export type SlackVerificationFailure =
  | 'rate_limited'
  | 'unavailable'
  | 'rejected'
  | 'team_mismatch';
/** Safe verification failure; carries only a category and an optional bounded retry delay. */
export class SlackVerificationError extends Error {
  readonly failure: SlackVerificationFailure;
  readonly retryAfterMs: number | null;
  constructor(failure: SlackVerificationFailure, retryAfterMs: number | null) {
    super(`slack_verification_${failure}`);
    this.failure = failure;
    this.retryAfterMs = retryAfterMs;
  }
}

function request(token: string, body: Readonly<Record<string, unknown>>): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  };
}
function rateLimit(error: unknown): number | null | false {
  return error instanceof NotificationHttpError &&
    error.failure === 'status' &&
    error.status === 429
    ? error.retryAfterMs
    : false;
}

export async function verifySlackIdentity(
  grant: NotificationGrant,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ teamId: string }> {
  const profile = grant.slack;
  if (profile === null) throw new SlackVerificationError('rejected', null);
  let response: unknown;
  try {
    response = await boundedNotificationJson(
      authTest,
      request(profile.botToken, {}),
      notificationDeadline(signal, timeoutMs),
      jsonLimit,
    );
  } catch (error) {
    const delay = rateLimit(error);
    throw new SlackVerificationError(
      delay === false ? 'unavailable' : 'rate_limited',
      delay || null,
    );
  }
  const ok = field(response, 'ok');
  const error = field(response, 'error');
  if (ok === false && typeof error === 'string') {
    if (error === 'ratelimited') throw new SlackVerificationError('rate_limited', null);
    if (configurationRefusals.has(error)) throw new SlackVerificationError('rejected', null);
    throw new SlackVerificationError('unavailable', null);
  }
  const teamId = field(response, 'team_id');
  if (ok !== true || typeof teamId !== 'string' || teamId.length === 0)
    throw new SlackVerificationError('unavailable', null);
  if (teamId !== profile.teamId) throw new SlackVerificationError('team_mismatch', null);
  return { teamId };
}

function transient(error: unknown): DispatchResult {
  const delay = rateLimit(error);
  return delay === false || delay === null ? unavailable : { ...unavailable, retryAfterMs: delay };
}
const missingProfile: DispatchResult = {
  outcome: 'not_accepted',
  retryable: false,
  reason: 'configuration_invalid',
};
const invalidTarget: DispatchResult = {
  outcome: 'not_accepted',
  retryable: false,
  reason: 'recipient_unavailable',
};

/** Opens (or reuses) the one-to-one DM with exactly one user. Opening is not message submission. */
export async function openSlackDm(
  grant: NotificationGrant,
  userId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ channelId: string } | DispatchResult> {
  const profile = grant.slack;
  if (profile === null) return missingProfile;
  if (!/^[UW][A-Z0-9]{2,}$/.test(userId)) return invalidTarget;
  if (signal.aborted) return unavailable;
  let response: unknown;
  try {
    response = await boundedNotificationJson(
      conversationsOpen,
      request(profile.botToken, { users: userId, return_im: false }),
      notificationDeadline(signal, timeoutMs),
      jsonLimit,
    );
  } catch (error) {
    return transient(error);
  }
  const ok = field(response, 'ok');
  if (ok === true) {
    const channelId = field(field(response, 'channel'), 'id');
    return typeof channelId === 'string' && /^D[A-Z0-9]{2,}$/.test(channelId)
      ? { channelId }
      : unavailable;
  }
  if (ok === false) {
    const error = field(response, 'error');
    if (error === 'ratelimited') return unavailable;
    return refusal(error, openRecipientRefusals) ?? unavailable;
  }
  return unavailable;
}

/** Posts one message to an opened DM. Any non-definitive outcome after submission is uncertain. */
export async function postSlackMessage(
  grant: NotificationGrant,
  channelId: string,
  message: NoticeMessage,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<DispatchResult> {
  const profile = grant.slack;
  if (profile === null) return missingProfile;
  if (!/^D[A-Z0-9]{2,}$/.test(channelId)) return invalidTarget;
  if (signal.aborted) return unavailable;
  let response: unknown;
  try {
    response = await boundedNotificationJson(
      chatPostMessage,
      request(profile.botToken, {
        channel: channelId,
        text: message.slackText,
        unfurl_links: false,
        unfurl_media: false,
      }),
      notificationDeadline(signal, timeoutMs),
      jsonLimit,
    );
  } catch (error) {
    // A 429 is a documented rejection before processing; every other failure may follow submission.
    return rateLimit(error) === false ? uncertain : transient(error);
  }
  return classifySlack(response);
}

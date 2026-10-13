import type { NotificationConfig, NotificationGrant } from './config.ts';
import type { DispatchResult, NoticeMessage } from './contract.ts';
import { openSlackDm, postSlackMessage, verifySlackIdentity } from './slack.ts';
import { sendSmtpEmail } from './smtp.ts';

export { NotificationHttpError } from './http.ts';
export { SlackVerificationError } from './slack.ts';
export { buildPulseLink, buildWorkspaceLink } from './templates.ts';

/** Network deadline for one provider attempt; callers may only shorten it with their signal. */
export const notificationNetworkTimeoutMs = 10_000;

export type NotificationProvider = Readonly<{
  verifySlack: (grant: NotificationGrant, signal: AbortSignal) => Promise<{ teamId: string }>;
  openDm: (
    grant: NotificationGrant,
    userId: string,
    signal: AbortSignal,
  ) => Promise<{ channelId: string } | DispatchResult>;
  sendSlack: (
    grant: NotificationGrant,
    channelId: string,
    message: NoticeMessage,
    signal: AbortSignal,
  ) => Promise<DispatchResult>;
  sendEmail: (
    grant: NotificationGrant,
    email: string,
    message: NoticeMessage,
    signal: AbortSignal,
  ) => Promise<DispatchResult>;
}>;

export type NotificationProviderOptions = Readonly<{
  /** Can only shorten the ten-second attempt deadline. */
  networkTimeoutMs?: number;
  /** Test-only extra trust anchor for loopback TLS fixtures; never configuration-driven. */
  tlsCa?: string;
}>;

/**
 * Server-side transports only. Fingerprints, private configuration reads, routing and fallback
 * belong to callers; this returns honest per-transport outcomes for exactly one attempt.
 */
export function createNotificationProvider(
  config: NotificationConfig,
  options: NotificationProviderOptions = {},
): NotificationProvider {
  const requested = options.networkTimeoutMs ?? notificationNetworkTimeoutMs;
  const networkTimeoutMs =
    Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, notificationNetworkTimeoutMs)
      : notificationNetworkTimeoutMs;
  return {
    verifySlack: (grant, signal) => verifySlackIdentity(grant, signal, networkTimeoutMs),
    openDm: (grant, userId, signal) => openSlackDm(grant, userId, signal, networkTimeoutMs),
    sendSlack: (grant, channelId, message, signal) =>
      postSlackMessage(grant, channelId, message, signal, networkTimeoutMs),
    sendEmail: (grant, email, message, signal) =>
      sendSmtpEmail(grant, email, message, signal, {
        mode: config.mode,
        networkTimeoutMs,
        tlsCa: options.tlsCa,
      }),
  };
}

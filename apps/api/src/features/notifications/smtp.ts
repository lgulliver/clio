import { isIP, connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createTransport } from 'nodemailer';
import type { NotificationGrant } from './config.ts';
import type { DispatchResult, NoticeMessage } from './contract.ts';
import { field, notificationDeadline } from './http.ts';
import { BudgetedSmtpSocket } from './smtp-socket.ts';

export const smtpReplyLimitBytes = 65536;

export type SmtpTransportOptions = Readonly<{
  mode: 'live' | 'local_capture';
  networkTimeoutMs: number;
  /** Test-only trust anchor for the loopback TLS fixture; never read from configuration. */
  tlsCa: string | undefined;
}>;

const uncertain: DispatchResult = { outcome: 'uncertain', reason: 'acceptance_unknown' };
const unavailable: DispatchResult = {
  outcome: 'not_accepted',
  retryable: true,
  reason: 'provider_unavailable',
};
const invalidConfiguration: DispatchResult = {
  outcome: 'not_accepted',
  retryable: false,
  reason: 'configuration_invalid',
};
const invalidRecipient: DispatchResult = {
  outcome: 'not_accepted',
  retryable: false,
  reason: 'recipient_unavailable',
};

function validRecipient(email: string): boolean {
  return (
    email.length <= 254 &&
    /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/.test(email) &&
    Array.from(email).every(
      (character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) < 127,
    )
  );
}

function openSocket(
  profile: NonNullable<NotificationGrant['smtp']>,
  options: SmtpTransportOptions,
  signal: AbortSignal,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const live = options.mode === 'live';
    const socket = live
      ? tlsConnect({
          host: profile.host,
          port: profile.port,
          ...(isIP(profile.host) === 0 ? { servername: profile.host } : {}),
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          ...(options.tlsCa === undefined ? {} : { ca: options.tlsCa }),
        })
      : netConnect({ host: profile.host, port: profile.port });
    const ready = live ? 'secureConnect' : 'connect';
    const cleanup = (): void => {
      socket.off(ready, onReady);
      socket.off('error', fail);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown): void => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = (): void => fail(new Error('SMTP connection aborted'));
    const onReady = (): void => {
      cleanup();
      if ('authorized' in socket && socket.authorized !== true) {
        socket.destroy();
        reject(new Error('SMTP certificate not authorized'));
        return;
      }
      resolve(socket);
    };
    socket.once(ready, onReady);
    socket.once('error', fail);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function certificateFailure(error: unknown): boolean {
  const code = field(error, 'code');
  return (
    typeof code === 'string' &&
    /CERT|TLS|SSL|VERIFY|SELF_SIGNED|ALTNAME|HOSTNAME|EPROTO/i.test(code)
  );
}

type Observed = Readonly<{
  overBudget: boolean;
  malformed: boolean;
  dataSent: boolean;
  connectFailure: 'certificate' | 'network' | null;
}>;
function classifyFailure(error: unknown, seen: Observed): DispatchResult {
  // Syntactically invalid replies prove nothing: after DATA a message may exist, before it none can.
  if (seen.malformed) return seen.dataSent ? uncertain : unavailable;
  const code = field(error, 'responseCode');
  const command = field(error, 'command');
  // A complete 4xx/5xx reply to a real SMTP command is a known refusal. A reply attributed to
  // 'CONN' can be synthesized from an unterminated remainder and proves nothing by itself.
  if (
    typeof code === 'number' &&
    code >= 400 &&
    code < 600 &&
    typeof command === 'string' &&
    command !== 'CONN' &&
    command !== 'API'
  ) {
    if (code < 500) return unavailable;
    return command === 'RCPT TO' || command === 'DATA' ? invalidRecipient : invalidConfiguration;
  }
  if (seen.connectFailure === 'certificate') return invalidConfiguration;
  // Without a DATA command no message body can have been submitted.
  return seen.dataSent ? uncertain : unavailable;
}

/**
 * Sends one message to one recipient through Nodemailer's public transport API over an owned,
 * budgeted socket. Success needs the final 250 reply and exactly the expected accepted recipient.
 */
export async function sendSmtpEmail(
  grant: NotificationGrant,
  email: string,
  message: NoticeMessage,
  signal: AbortSignal,
  options: SmtpTransportOptions,
): Promise<DispatchResult> {
  const profile = grant.smtp;
  if (profile === null) return invalidConfiguration;
  if (!validRecipient(email)) return invalidRecipient;
  if (signal.aborted) return unavailable;
  const deadline = notificationDeadline(signal, options.networkTimeoutMs);
  const timeout = options.networkTimeoutMs;
  let adapter: BudgetedSmtpSocket | null = null;
  let upstream: Socket | null = null;
  let connectFailure: Observed['connectFailure'] = null;
  let settled = false;
  const transporter = createTransport({
    host: profile.host,
    port: profile.port,
    secure: options.mode === 'live',
    ignoreTLS: options.mode !== 'live',
    name: 'localhost',
    auth:
      profile.user !== null && profile.password !== null
        ? { user: profile.user, pass: profile.password }
        : undefined,
    pool: false,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    maxResponseSize: smtpReplyLimitBytes,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
    transactionLog: false,
    tls: { rejectUnauthorized: true },
    getSocket: (_connection, callback) => {
      openSocket(profile, options, deadline).then(
        (socket) => {
          if (settled) {
            socket.destroy();
            return;
          }
          upstream = socket;
          const owned = new BudgetedSmtpSocket(socket, smtpReplyLimitBytes);
          adapter = owned;
          callback(
            null,
            options.mode === 'live' ? { connection: owned, secured: true } : { connection: owned },
          );
        },
        (error: unknown) => {
          connectFailure = certificateFailure(error) ? 'certificate' : 'network';
          callback(new Error('SMTP connection failed'));
        },
      );
    },
  });
  const observed = (): Observed => ({
    overBudget: adapter?.overBudget ?? false,
    malformed: adapter?.malformed ?? false,
    dataSent: adapter?.dataCommandSent ?? false,
    connectFailure,
  });
  return new Promise<DispatchResult>((resolve) => {
    const finish = (result: DispatchResult): void => {
      if (settled) return;
      settled = true;
      deadline.removeEventListener('abort', onAbort);
      adapter?.destroy();
      upstream?.destroy();
      transporter.close();
      resolve(result);
    };
    const onAbort = (): void => finish(observed().dataSent ? uncertain : unavailable);
    deadline.addEventListener('abort', onAbort, { once: true });
    transporter
      .sendMail({
        from: profile.from,
        to: email,
        envelope: { from: profile.from, to: [email] },
        subject: message.subject,
        text: message.text,
        html: message.html,
      })
      .then(
        (info) => {
          const final = typeof info.response === 'string' && /^250(?:[ -]|$)/.test(info.response);
          const only =
            info.accepted.length === 1 &&
            info.rejected.length === 0 &&
            String(info.accepted[0]).toLowerCase() === email.toLowerCase();
          finish(final && only ? { outcome: 'accepted' } : uncertain);
        },
        (error: unknown) => finish(classifyFailure(error, observed())),
      );
  });
}

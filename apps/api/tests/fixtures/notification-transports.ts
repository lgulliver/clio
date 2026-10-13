import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { vi } from 'vitest';
import type {
  NotificationConfig,
  NotificationGrant,
} from '../../src/features/notifications/config.ts';
import type { NotificationPolicy } from '../../src/features/notifications/contract.ts';

export const enabledPolicy: NotificationPolicy = {
  revision: 1,
  enabled: true,
  invitations: true,
  closures: true,
  reminders: true,
  firstReminderHours: 48,
  repeatHours: 72,
  maximumReminders: 2,
};

export function validCallback(start: { authorizeUrl: string }) {
  return {
    state: new URL(start.authorizeUrl).searchParams.get('state'),
    code: 'signed-fixture-code',
  };
}

export const workspaceId = '11111111-1111-4111-8111-111111111111';
export const pulseId = '22222222-2222-4222-8222-222222222222';
export const fixtureOrigin = 'https://clio.example.test';
export const fixtureBotToken = 'xoxb-fixture-token-not-real';
export const fixtureEmail = 'member.fixture@example.test';

/*
 * DISPOSABLE TEST-ONLY TLS MATERIAL. Generated for these loopback tests with a throwaway
 * CA that signs only a localhost/127.0.0.1 leaf certificate. Neither key protects anything;
 * nothing outside the test suite trusts this CA.
 */
export const fixtureCaPem = `-----BEGIN CERTIFICATE-----
MIIBijCCATCgAwIBAgIUbaFYmRqiWPxDeBIiiw8Zm61kgWowCgYIKoZIzj0EAwIw
IjEgMB4GA1UEAwwXQ2xpbyBkaXNwb3NhYmxlIHRlc3QgQ0EwIBcNMjYxMDEzMjI0
NDMwWhgPMjEyNjA5MTkyMjQ0MzBaMCIxIDAeBgNVBAMMF0NsaW8gZGlzcG9zYWJs
ZSB0ZXN0IENBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZgrxVD+KtkApKNDp
U7twgwjYnyKoe3U7J1N4WooLO0NJeb4xz6I/erU0H2BcXOVoyxD9M4gCBrS+Mh0Z
C7KebaNCMEAwHQYDVR0OBBYEFJNEHAC19fzQ7c8vd3ITTCVBtyG+MA8GA1UdEwEB
/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCIQDSmgEm
R/XCEBlOfzkG7N4b+hzE9d7RSJ0yuwYgPwRUvgIgYj0JLW0fMEvszk6E/SMwfHpN
ZNl0nagsMWcfvm5veME=
-----END CERTIFICATE-----
`;
export const fixtureLeafKeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgB0ycZGJDv+9/zmR6
3FIbXR19JWC+fPwrTcjHciL+emihRANCAARb3aRyjDusGLIwmK+zJ3+8iaguW055
MaAUI+7FmbHJbZTKxBnW5H6Bf2nRmB9WqV5XzlyMHQFFewguhED3MNvI
-----END PRIVATE KEY-----
`;
export const fixtureLeafCertPem = `-----BEGIN CERTIFICATE-----
MIIBhjCCASugAwIBAgIUfVv8NAwYrbyUn4Evx2v/wdKSkmIwCgYIKoZIzj0EAwIw
IjEgMB4GA1UEAwwXQ2xpbyBkaXNwb3NhYmxlIHRlc3QgQ0EwIBcNMjYxMDEzMjI0
NDMwWhgPMjEyNjA5MTkyMjQ0MzBaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABFvdpHKMO6wYsjCYr7Mnf7yJqC5bTnkxoBQj
7sWZscltlMrEGdbkfoF/adGYH1apXlfOXIwdAUV7CC6EQPcw28ijSzBJMBoGA1Ud
EQQTMBGCCWxvY2FsaG9zdIcEfwAAATAJBgNVHRMEAjAAMAsGA1UdDwQEAwIHgDAT
BgNVHSUEDDAKBggrBgEFBQcDATAKBggqhkjOPQQDAgNJADBGAiEA4qWTJEHjMdwi
4A36dWAnzMHjpHrEBZjzd0HzAhBiitgCIQDAoxKhWUbM7hhZKMkztvVvL4PorEr4
rvXZRvlM1TYVAg==
-----END CERTIFICATE-----
`;

export function grant(
  parts: Pick<NotificationGrant, 'smtp' | 'slack'>,
  id: string = workspaceId,
): NotificationGrant {
  return {
    workspaceId: id,
    fingerprint: 'a'.repeat(64),
    credentialFingerprint: 'b'.repeat(64),
    ...parts,
  };
}

export function slackGrant(): NotificationGrant {
  return grant({
    smtp: null,
    slack: {
      teamId: 'T0FIXTURE',
      botToken: fixtureBotToken,
      clientId: 'client.fixture',
      clientSecret: 'fixture-client-secret-not-real',
    },
  });
}

export function smtpGrant(host: string, port: number): NotificationGrant {
  return grant({
    smtp: { host, port, user: null, password: null, from: 'clio@example.test', ratePerMinute: 30 },
    slack: null,
  });
}

export function configFor(
  mode: NotificationConfig['mode'],
  grants: readonly NotificationGrant[],
): NotificationConfig {
  return {
    mode,
    publicOrigin: mode === 'live' ? fixtureOrigin : 'http://localhost:5173',
    grants,
  };
}

export type SmtpScript = Readonly<{
  /** Raw wire text; null keeps the server silent. */
  greeting?: string | null;
  ehlo?: string;
  mail?: string;
  rcpt?: string;
  data?: string;
  /** Raw wire text sent after the message terminator, or 'drop' to close without replying. */
  final?: string | 'drop' | 'trickle';
  /** Close the connection on receiving the DATA command. */
  dropOnData?: boolean;
}>;
export type SmtpFixture = Readonly<{
  host: string;
  port: number;
  commands: () => readonly string[];
  message: () => string;
  connections: () => number;
  openSockets: () => number;
  close: () => Promise<void>;
}>;

function lines(prefix: string, count: number, width: number, last: string): string {
  const body = 'x'.repeat(width);
  let text = '';
  for (let index = 0; index < count; index += 1) text += `${prefix}-${body}\r\n`;
  return `${text}${last}\r\n`;
}
/** Complete multi-line replies whose cumulative size is large while each reply stays small. */
export function bulkyReply(code: string, bytes: number, last: string): string {
  return lines(code, Math.ceil(bytes / 1000), 996, last);
}

function serve(socket: Socket, script: SmtpScript, commands: string[], messages: string[]): void {
  socket.on('error', () => {});
  let buffer = '';
  let inData = false;
  let body = '';
  if (script.greeting !== null) socket.write(script.greeting ?? '220 fixture ESMTP\r\n');
  socket.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    for (;;) {
      if (inData) {
        body += buffer;
        buffer = '';
        const end = body.indexOf('\r\n.\r\n');
        if (end < 0) return;
        messages.push(body.slice(0, end));
        buffer = body.slice(end + 5);
        inData = false;
        body = '';
        if (script.final === 'trickle') {
          // Partial reply bytes (no CRLF) forever, faster than any idle timeout.
          const timer = setInterval(() => socket.write('2'), 40);
          socket.on('close', () => clearInterval(timer));
          return;
        }
        if (script.final === 'drop') {
          socket.destroy();
          return;
        }
        socket.write(script.final ?? '250 2.0.0 queued\r\n');
        continue;
      }
      const eol = buffer.indexOf('\r\n');
      if (eol < 0) return;
      const line = buffer.slice(0, eol);
      buffer = buffer.slice(eol + 2);
      commands.push(line);
      const verb = line.split(/[ :]/, 1)[0]?.toUpperCase() ?? '';
      if (verb === 'EHLO' || verb === 'HELO') socket.write(script.ehlo ?? '250 fixture\r\n');
      else if (verb === 'MAIL') socket.write(script.mail ?? '250 ok\r\n');
      else if (verb === 'RCPT') socket.write(script.rcpt ?? '250 ok\r\n');
      else if (verb === 'DATA') {
        if (script.dropOnData) {
          socket.destroy();
          return;
        }
        const reply = script.data ?? '354 go ahead\r\n';
        socket.write(reply);
        inData = reply.startsWith('354');
      } else if (verb === 'RSET') socket.write('250 ok\r\n');
      else if (verb === 'QUIT') {
        socket.end('221 bye\r\n');
        return;
      } else socket.write('502 not implemented\r\n');
    }
  });
}

export async function startSmtpFixture(
  script: SmtpScript,
  options: Readonly<{ tls: boolean; host?: string }>,
): Promise<SmtpFixture> {
  const host = options.host ?? '127.0.0.1';
  const commands: string[] = [];
  const messages: string[] = [];
  let connections = 0;
  const accept = (socket: Socket): void => {
    connections += 1;
    serve(socket, script, commands, messages);
  };
  const server: Server = options.tls
    ? createTlsServer({ key: fixtureLeafKeyPem, cert: fixtureLeafCertPem }, accept)
    : createNetServer(accept);
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture failed to listen');
  return {
    host,
    port: address.port,
    commands: () => commands,
    message: () => messages.join('\n'),
    connections: () => connections,
    openSockets: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export type FetchCall = Readonly<{ url: string; init: RequestInit | undefined }>;
export function mockFetch(handler: (call: FetchCall) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: input instanceof Request ? input.url : String(input), init };
      calls.push(call);
      return handler(call);
    });
  return { calls, restore: () => spy.mockRestore() };
}
export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });
}
/** A body that yields some bytes and then fails, as a truncated connection would. */
export function truncatedResponse(prefix: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(prefix));
        controller.error(new Error('connection reset'));
      },
    }),
    { status: 200 },
  );
}

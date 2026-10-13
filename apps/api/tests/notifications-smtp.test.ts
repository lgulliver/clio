import { connect, createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationProvider } from '../src/features/notifications/provider.ts';
import { BudgetedSmtpSocket } from '../src/features/notifications/smtp-socket.ts';
import { renderNotice } from '../src/features/notifications/templates.ts';
import {
  bulkyReply,
  configFor,
  fixtureCaPem,
  fixtureEmail,
  type SmtpFixture,
  type SmtpScript,
  smtpGrant,
  startSmtpFixture,
  workspaceId,
} from './fixtures/notification-transports.ts';

const message = renderNotice(
  'invitation',
  `https://clio.example.test/developer-experience?workspace=${workspaceId}`,
);
const uncertain = { outcome: 'uncertain', reason: 'acceptance_unknown' } as const;
const open: SmtpFixture[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((fixture) => fixture.close()));
});
async function fixture(script: SmtpScript, options: { tls: boolean; host?: string }) {
  const started = await startSmtpFixture(script, options);
  open.push(started);
  return started;
}
function capture(started: SmtpFixture, timeoutMs = 2000) {
  const grant = smtpGrant(started.host, started.port);
  return {
    grant,
    provider: createNotificationProvider(configFor('local_capture', [grant]), {
      networkTimeoutMs: timeoutMs,
    }),
  };
}
function secure(started: SmtpFixture, ca: string | null = fixtureCaPem, host = 'localhost') {
  const grant = smtpGrant(host, started.port);
  return {
    grant,
    provider: createNotificationProvider(
      configFor('live', [grant]),
      ca === null ? { networkTimeoutMs: 2000 } : { networkTimeoutMs: 2000, tlsCa: ca },
    ),
  };
}
const live = (): AbortSignal => new AbortController().signal;

describe('SMTP outcomes over the local capture transport', () => {
  it('accepts only a final 250 for the single expected recipient and builds one envelope', async () => {
    const started = await fixture({}, { tls: false });
    const { grant, provider } = capture(started);
    await expect(provider.sendEmail(grant, fixtureEmail, message, live())).resolves.toEqual({
      outcome: 'accepted',
    });
    const rcpt = started.commands().filter((line) => /^RCPT/i.test(line));
    expect(rcpt).toEqual([`RCPT TO:<${fixtureEmail}>`]);
    expect(started.commands().filter((line) => /^MAIL/i.test(line))).toHaveLength(1);
    expect(started.message()).toContain(message.text.split('\n')[0] ?? '?');
    expect(started.message()).not.toMatch(/^(cc|bcc):/im);
    expect(started.commands().some((line) => /^(STARTTLS|AUTH)/i.test(line))).toBe(false);
  });

  it('treats an unexpected positive final response as uncertain rather than accepted', async () => {
    const started = await fixture({ final: '252 2.0.0 maybe\r\n' }, { tls: false });
    const { grant, provider } = capture(started);
    expect(await provider.sendEmail(grant, fixtureEmail, message, live())).toEqual(uncertain);
  });

  it('reports explicit 550 and 451 replies as known non-acceptance with safe reasons', async () => {
    for (const [script, expected] of [
      [
        { rcpt: '550 5.1.1 mailbox unavailable\r\n' },
        { retryable: false, reason: 'recipient_unavailable' },
      ],
      [{ final: '550 5.7.1 refused\r\n' }, { retryable: false, reason: 'recipient_unavailable' }],
      [{ final: '451 4.3.0 try later\r\n' }, { retryable: true, reason: 'provider_unavailable' }],
      [{ rcpt: '451 4.7.1 greylisted\r\n' }, { retryable: true, reason: 'provider_unavailable' }],
      [
        { mail: '553 5.1.8 sender rejected\r\n' },
        { retryable: false, reason: 'configuration_invalid' },
      ],
      [{ data: '554 5.5.1 no\r\n' }, { retryable: false, reason: 'recipient_unavailable' }],
    ] as const) {
      const started = await fixture(script, { tls: false });
      const { grant, provider } = capture(started);
      const result = await provider.sendEmail(grant, fixtureEmail, message, live());
      expect(result).toEqual({ outcome: 'not_accepted', ...expected });
      expect(JSON.stringify(result)).not.toContain(fixtureEmail);
    }
  });

  it('is uncertain when the connection drops after DATA, in either direction of the exchange', async () => {
    for (const script of [{ final: 'drop' }, { dropOnData: true }] as const) {
      const started = await fixture(script, { tls: false });
      const { grant, provider } = capture(started);
      expect(await provider.sendEmail(grant, fixtureEmail, message, live())).toEqual(uncertain);
    }
  });

  it('is a known non-acceptance for a slow greeting or failure before any submission', async () => {
    const silent = await fixture({ greeting: null }, { tls: false });
    const slow = capture(silent, 300);
    const started = Date.now();
    expect(await slow.provider.sendEmail(slow.grant, fixtureEmail, message, live())).toEqual({
      outcome: 'not_accepted',
      retryable: true,
      reason: 'provider_unavailable',
    });
    expect(Date.now() - started).toBeLessThan(2000);
    const refused = await fixture({}, { tls: false });
    const closedPort = refused.port;
    await refused.close();
    const dead = createNotificationProvider(
      configFor('local_capture', [smtpGrant('127.0.0.1', closedPort)]),
      {
        networkTimeoutMs: 1000,
      },
    );
    expect(
      await dead.sendEmail(smtpGrant('127.0.0.1', closedPort), fixtureEmail, message, live()),
    ).toEqual({
      outcome: 'not_accepted',
      retryable: true,
      reason: 'provider_unavailable',
    });
    const greeting = await fixture({ greeting: '554 no service\r\n' }, { tls: false });
    const refusedGreeting = capture(greeting);
    expect(
      await refusedGreeting.provider.sendEmail(
        refusedGreeting.grant,
        fixtureEmail,
        message,
        live(),
      ),
    ).toMatchObject({
      outcome: 'not_accepted',
    });
  });

  it('enforces the total attempt deadline against partial reply bytes trickled below the idle timeout', async () => {
    const started = await fixture({ final: 'trickle' }, { tls: false });
    // A byte every 40 ms keeps a 400 ms idle/socket timeout from ever firing; only the total deadline can end this.
    const { grant, provider } = capture(started, 400);
    const begun = Date.now();
    expect(await provider.sendEmail(grant, fixtureEmail, message, live())).toEqual(uncertain);
    expect(Date.now() - begun).toBeLessThan(1500);
    await vi.waitFor(() => expect(started.openSockets()).toBe(0), { timeout: 1000 });
  });

  it('never trusts malformed or inconsistent replies after DATA (uncertain, not refusal or acceptance)', async () => {
    for (const final of [
      '451garbage\r\n',
      '250-first\r\n550 final\r\n',
      '451-first\r\n250 final\r\n',
      '250-first\r\n250-second\r\n550 final\r\n',
      '250 ok\n',
      '25O ok\r\n',
      '250-only continuation\r\n',
    ]) {
      const started = await fixture({ final }, { tls: false });
      const { grant, provider } = capture(started, 600);
      expect(await provider.sendEmail(grant, fixtureEmail, message, live())).toEqual(uncertain);
    }
  });

  it('accepts legal horizontal tabs in reply text and still refuses other control or non-ASCII bytes', async () => {
    const tabbed = await fixture(
      { greeting: '220 server ready\tfor mail\r\n', final: '250 queued\tid1\r\n' },
      { tls: false },
    );
    const ok = capture(tabbed);
    expect(await ok.provider.sendEmail(ok.grant, fixtureEmail, message, live())).toEqual({
      outcome: 'accepted',
    });
    for (const final of [
      '250 queued\u0001id\r\n',
      '250 queued\u007fid\r\n',
      '250 queued\u00e9\r\n',
    ]) {
      const started = await fixture({ final }, { tls: false });
      const { grant, provider } = capture(started, 600);
      expect(await provider.sendEmail(grant, fixtureEmail, message, live())).toEqual(uncertain);
    }
  });

  it('keeps malformed replies before DATA as known non-submission and accepts consistent multiline 250', async () => {
    const early = await fixture({ rcpt: '451garbage\r\n' }, { tls: false });
    const first = capture(early, 600);
    expect(await first.provider.sendEmail(first.grant, fixtureEmail, message, live())).toEqual({
      outcome: 'not_accepted',
      retryable: true,
      reason: 'provider_unavailable',
    });
    expect(early.commands().some((line) => /^DATA/i.test(line))).toBe(false);
    const multiline = await fixture({ final: '250-queued\r\n250 as id 1\r\n' }, { tls: false });
    const ok = capture(multiline);
    expect(await ok.provider.sendEmail(ok.grant, fixtureEmail, message, live())).toEqual({
      outcome: 'accepted',
    });
  });

  it('settles once and destroys the connection when the caller aborts', async () => {
    const started = await fixture({ final: '' }, { tls: false });
    const { grant, provider } = capture(started, 5000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const begun = Date.now();
    expect(await provider.sendEmail(grant, fixtureEmail, message, controller.signal)).toEqual(
      uncertain,
    );
    expect(Date.now() - begun).toBeLessThan(2500);
    const before = await fixture({ greeting: null }, { tls: false });
    const early = capture(before, 5000);
    const prompt = AbortSignal.abort();
    expect(await early.provider.sendEmail(early.grant, fixtureEmail, message, prompt)).toEqual({
      outcome: 'not_accepted',
      retryable: true,
      reason: 'provider_unavailable',
    });
    expect(before.connections()).toBe(0);
  });

  it('terminates cumulative replies over 64 KiB that no single reply limit would catch', async () => {
    const before = await fixture(
      {
        greeting: bulkyReply('220', 30_000, '220 ready'),
        ehlo: bulkyReply('250', 40_000, '250 ok'),
      },
      { tls: false },
    );
    const early = capture(before);
    expect(
      await early.provider.sendEmail(early.grant, fixtureEmail, message, live()),
    ).toMatchObject({
      outcome: 'not_accepted',
    });
    expect(before.commands().some((line) => /^DATA/i.test(line))).toBe(false);
    const after = await fixture(
      { ehlo: bulkyReply('250', 40_000, '250 ok'), final: bulkyReply('250', 40_000, '250 queued') },
      { tls: false },
    );
    const late = capture(after);
    expect(await late.provider.sendEmail(late.grant, fixtureEmail, message, live())).toEqual(
      uncertain,
    );
  });

  it('rejects unsafe recipient addresses before connecting', async () => {
    const started = await fixture({}, { tls: false });
    const { grant, provider } = capture(started);
    for (const email of [
      'a@b.test\r\nBcc: x@y.test',
      'a@b.test, c@d.test',
      '<a@b.test>',
      'no-at-sign',
      '',
    ]) {
      expect(await provider.sendEmail(grant, email, message, live())).toEqual({
        outcome: 'not_accepted',
        retryable: false,
        reason: 'recipient_unavailable',
      });
    }
    expect(started.connections()).toBe(0);
  });

  it('refuses without an SMTP profile', async () => {
    const started = await fixture({}, { tls: false });
    const { grant, provider } = capture(started);
    expect(
      await provider.sendEmail({ ...grant, smtp: null }, fixtureEmail, message, live()),
    ).toEqual({
      outcome: 'not_accepted',
      retryable: false,
      reason: 'configuration_invalid',
    });
  });
});

describe('SMTP over implicit TLS with certificate validation', () => {
  it('delivers through a verified connection using the supplied test CA and SNI', async () => {
    const started = await fixture({}, { tls: true });
    const { grant, provider } = secure(started);
    expect(await provider.sendEmail(grant, fixtureEmail, message, live())).toEqual({
      outcome: 'accepted',
    });
    expect(started.commands().some((line) => /^STARTTLS/i.test(line))).toBe(false);
  });

  it('never talks SMTP to a server whose certificate is not trusted', async () => {
    const started = await fixture({}, { tls: true });
    const { grant, provider } = secure(started, null);
    expect(await provider.sendEmail(grant, fixtureEmail, message, live())).toEqual({
      outcome: 'not_accepted',
      retryable: false,
      reason: 'configuration_invalid',
    });
    expect(started.commands()).toEqual([]);
  });

  it('rejects a certificate that does not match the configured host', async () => {
    const started = await fixture({}, { tls: true, host: '127.0.0.2' });
    const { grant, provider } = secure(started, fixtureCaPem, '127.0.0.2');
    expect(await provider.sendEmail(grant, fixtureEmail, message, live())).toEqual({
      outcome: 'not_accepted',
      retryable: false,
      reason: 'configuration_invalid',
    });
    expect(started.commands()).toEqual([]);
  });

  it('does not downgrade to plaintext when a live endpoint speaks plain SMTP', async () => {
    const plain = await fixture({}, { tls: false });
    const { grant, provider } = secure(plain);
    const result = await provider.sendEmail(grant, fixtureEmail, message, live());
    expect(result.outcome).toBe('not_accepted');
    expect(
      plain.commands().filter((line) => /^(EHLO|HELO|MAIL|RCPT|DATA|AUTH)/i.test(line)),
    ).toEqual([]);
  });

  it('applies the cumulative reply budget on the decrypted stream', async () => {
    const started = await fixture(
      { ehlo: bulkyReply('250', 40_000, '250 ok'), final: bulkyReply('250', 40_000, '250 queued') },
      { tls: true },
    );
    const { grant, provider } = secure(started);
    expect(await provider.sendEmail(grant, fixtureEmail, message, live())).toEqual(uncertain);
  });
});

describe('BudgetedSmtpSocket', () => {
  async function pair(onConnection: (socket: Socket) => void) {
    const server = createServer(onConnection);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const upstream = connect(address.port, '127.0.0.1');
    await new Promise<void>((resolve) => upstream.once('connect', () => resolve()));
    return { server, upstream };
  }

  it('never delivers bytes beyond the cumulative budget and destroys the upstream first', async () => {
    const { server, upstream } = await pair((socket) => {
      socket.on('error', () => {});
      socket.write('a'.repeat(600));
      setTimeout(() => socket.write('b'.repeat(600)), 20);
      setTimeout(() => socket.write('c'.repeat(600)), 40);
    });
    const adapter = new BudgetedSmtpSocket(upstream, 1000);
    adapter.on('error', () => {});
    const received: Buffer[] = [];
    adapter.on('data', (chunk: Buffer) => received.push(chunk));
    await new Promise<void>((resolve) => adapter.once('close', () => resolve()));
    expect(Buffer.concat(received).length).toBeLessThanOrEqual(1000);
    expect(adapter.overBudget).toBe(true);
    expect(upstream.destroyed).toBe(true);
    server.close();
  });

  it('preserves write order across corked batches and honours end', async () => {
    const chunks: string[] = [];
    const { server, upstream } = await pair((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => chunks.push(String(chunk)));
      socket.on('end', () => socket.end());
    });
    const adapter = new BudgetedSmtpSocket(upstream, 65536);
    adapter.cork();
    adapter.write('MAIL FROM:<a@b.test>\r\n');
    adapter.write('RCPT TO:<c@d.test>\r\n');
    adapter.write('DATA\r\n');
    adapter.uncork();
    expect(adapter.dataCommandSent).toBe(true);
    await new Promise<void>((resolve) => adapter.end(() => resolve()));
    await new Promise<void>((resolve) => adapter.once('close', () => resolve()));
    expect(chunks.join('')).toBe('MAIL FROM:<a@b.test>\r\nRCPT TO:<c@d.test>\r\nDATA\r\n');
    server.close();
  });

  it('does not expose the upstream through a socket property and delegates timeouts', async () => {
    const { server, upstream } = await pair((socket) => socket.on('error', () => {}));
    const adapter = new BudgetedSmtpSocket(upstream, 1000);
    expect('socket' in adapter).toBe(false);
    adapter.on('error', () => {});
    const timedOut = new Promise<void>((resolve) => adapter.once('timeout', () => resolve()));
    adapter.setTimeout(50);
    await timedOut;
    adapter.destroy();
    expect(upstream.destroyed).toBe(true);
    server.close();
  });
});

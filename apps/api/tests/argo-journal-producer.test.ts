import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../infra/argocd/journal/cli.ts';
import {
  appendJournal,
  captureJournal,
  drainJournal,
  initJournal,
  sealJournal,
  statusJournal,
} from '../../../infra/argocd/journal/journal.ts';
import { atomicState, locked, object } from '../../../infra/argocd/journal/storage.ts';

const roots: string[] = [];
const config = {
  sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  producerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  journalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  policyReference: 'urn:clio:fictional:journal:v1',
  fictional: true,
  startupAt: '2026-10-10T00:00:00Z',
};
async function setup(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clio-journal-test-'));
  roots.push(root);
  const directory = join(root, 'journal');
  await initJournal(directory, { ...config, ...extra });
  return { root, directory };
}
const entry = {
  notification: { original: 'unsupported retained payload' },
  capturedAt: '2026-10-10T00:00:01Z',
  evidenceRef: 'urn:fictional:observation:1',
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('durable Argo journal', () => {
  it('recovers fsynced entry before checkpoint update; exact resend after lost acknowledgement retains files', async () => {
    const { directory, root } = await setup();
    const state = await readFile(join(directory, 'state.json'));
    await appendJournal(directory, entry);
    await writeFile(join(directory, 'state.json'), state, { mode: 0o600 });
    expect(await statusJournal(directory)).toMatchObject({ entries: 1, acknowledgedRecords: 0 });
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const bodies: unknown[] = [];
    const options = {
      baseUrl: 'http://127.0.0.1:3001',
      tokenFile,
      maxAttempts: 1,
      sleep: async () => {},
      env: {},
    };
    await expect(
      drainJournal(directory, {
        ...options,
        fetcher: async (_url, request) => {
          bodies.push(request?.body);
          throw new Error('lost ack');
        },
      }),
    ).resolves.toMatchObject({ acknowledgedRecords: 0, pendingRecords: 1 });
    await expect(
      drainJournal(directory, {
        ...options,
        fetcher: async (_url, request) => {
          bodies.push(request?.body);
          return new Response('', { status: 202 });
        },
      }),
    ).resolves.toMatchObject({ acknowledgedRecords: 1, pendingRecords: 0 });
    expect(bodies[0]).toBe(bodies[1]);
    expect(await readdir(join(directory, 'records'))).toHaveLength(1);
  });
  it('fails visibly for torn immutable records and chronology violations', async () => {
    const { directory } = await setup();
    await appendJournal(directory, entry);
    await expect(
      appendJournal(directory, { ...entry, capturedAt: '2026-10-09T23:59:59Z' }),
    ).rejects.toThrow('journal_chronology');
    await writeFile(join(directory, 'records', '0000000001.json'), '{', { mode: 0o600 });
    await expect(statusJournal(directory)).rejects.toThrow('journal_corrupt');
  });
  it('bounds capacity and full envelope before retaining oversized payload', async () => {
    const { directory } = await setup({ maxRecords: 1 });
    await expect(
      appendJournal(directory, { ...entry, notification: 'x'.repeat(65500) }),
    ).rejects.toThrow();
    expect(await readdir(join(directory, 'records'))).toHaveLength(0);
    await appendJournal(directory, entry);
    await expect(appendJournal(directory, entry)).rejects.toThrow('journal_capacity');
  });
  it('supports contiguous and empty seals; rejects capture before sealed end', async () => {
    const { directory } = await setup();
    await appendJournal(directory, entry);
    const seal = await sealJournal(directory, {
      start: config.startupAt,
      end: '2026-10-10T00:00:02Z',
      evidenceRef: 'urn:fictional:seal',
    });
    expect(seal).toMatchObject({ first_sequence: 1, last_sequence: 1, entry_count: 1 });
    await expect(appendJournal(directory, entry)).rejects.toThrow('journal_chronology');
    const empty = await sealJournal(directory, {
      start: '2026-10-10T00:00:02Z',
      end: '2026-10-10T00:00:03Z',
      evidenceRef: 'urn:fictional:empty',
    });
    expect(empty).toMatchObject({
      first_sequence: 2,
      last_sequence: 1,
      entry_count: 0,
      last_digest: seal.last_digest,
    });
  });
  it('capture keeps real UID, info, revision and retry/self-heal/unmarked shapes without rollout gate', async () => {
    const { directory } = await setup();
    const application = {
      kind: 'Application',
      apiVersion: 'argoproj.io/v1alpha1',
      metadata: { uid: 'actual-uid', name: 'example', namespace: 'argocd' },
      spec: {
        project: 'default',
        sources: [{ repoURL: 'https://example.invalid' }],
        destination: { server: 'https://kubernetes.default.svc', namespace: 'demo' },
      },
      status: {
        operationState: {
          phase: 'Succeeded',
          startedAt: '2026-10-10T00:00:00Z',
          retryCount: 2,
          operation: {
            info: [
              { name: 'clio.operation-id', value: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
              { name: 'clio.operation-kind', value: 'self_heal' },
            ],
            initiatedBy: { automated: true },
          },
          syncResult: { revision: 'real-revision', revisions: ['multi-source'] },
        },
        health: { status: 'Unknown' },
        history: [{ id: 42, revision: 'must-not-reconstruct' }],
      },
    };
    const record = await captureJournal(directory, {
      input: application,
      format: 'application',
      evidenceRef: 'urn:fictional:application',
    });
    expect(record.notification).toMatchObject({
      application: { uid: 'actual-uid', hasSources: true },
      operation: {
        retryCount: 2,
        info: application.status.operationState.operation.info,
        revision: 'real-revision',
      },
    });
    application.status.operationState.operation.info = [];
    expect(
      (
        await captureJournal(directory, {
          input: application,
          format: 'application',
          evidenceRef: 'urn:fictional:unmarked',
        })
      ).notification,
    ).toMatchObject({ operation: { info: [] } });
  });
});

describe('journal failure and security boundaries', () => {
  it('rejects late prefix/empty seals and overlapping or out-of-range interruptions', async () => {
    const { directory } = await setup();
    await appendJournal(directory, entry);
    const options = {
      start: config.startupAt,
      end: '2026-10-10T00:00:02Z',
      evidenceRef: 'urn:fictional:seal',
    };
    await expect(sealJournal(directory, { ...options, lastSequence: 0 })).rejects.toThrow(
      'journal_seal_bounds',
    );
    await expect(
      sealJournal(directory, {
        ...options,
        interruptions: [
          { start: '2026-10-09T23:59:59Z', end: '2026-10-10T00:00:01Z', reason: 'outside' },
        ],
      }),
    ).rejects.toThrow();
    expect(await statusJournal(directory)).toMatchObject({ seals: 0, entries: 1 });
  });
  it('allows append/status during HTTP without overwriting retained progress', async () => {
    const { directory, root } = await setup();
    await appendJournal(directory, entry);
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const fetcher: typeof fetch = async () => {
      await appendJournal(directory, entry);
      expect(await statusJournal(directory)).toMatchObject({ entries: 2, acknowledgedRecords: 0 });
      return new Response('', { status: 202 });
    };
    await drainJournal(directory, {
      baseUrl: 'http://127.0.0.1:3001',
      tokenFile,
      env: {},
      fetcher,
      maxAttempts: 1,
    });
    expect(await statusJournal(directory)).toMatchObject({ entries: 2, acknowledgedRecords: 1 });
  });
  it('detects digest tampering and a missing contiguous immutable file', async () => {
    const { directory } = await setup();
    await appendJournal(directory, entry);
    const path = join(directory, 'records', '0000000001.json');
    const body = await readFile(path, 'utf8');
    await writeFile(
      path,
      body.replace('unsupported retained payload', 'altered retained payload'),
      { mode: 0o600 },
    );
    await expect(statusJournal(directory)).rejects.toThrow('journal_corrupt');
    await writeFile(path, body, { mode: 0o600 });
    await appendJournal(directory, entry);
    await rm(path);
    await expect(statusJournal(directory)).rejects.toThrow('journal_corrupt');
  });
  it('resumes bounded offline/throttled attempts with persisted Retry-After and exact bodies', async () => {
    const { directory, root } = await setup();
    await appendJournal(directory, entry);
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const bodies: unknown[] = [];
    const waits: number[] = [];
    const options = {
      baseUrl: 'http://127.0.0.1:3001',
      tokenFile,
      env: {},
      sleep: async (ms: number) => {
        const checkpoint = object(
          JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')),
        );
        if (typeof checkpoint.nextAttemptAt !== 'string') throw new Error('missing_cooldown');
        // Filesystem work consumes part of the delay; wait must reach its durable deadline.
        expect(Date.now() + ms).toBeGreaterThanOrEqual(Date.parse(checkpoint.nextAttemptAt));
        waits.push(ms);
      },
      random: () => 0,
    };
    let calls = 0;
    const fetcher: typeof fetch = async (_url, request) => {
      bodies.push(request?.body);
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
    };
    expect(await drainJournal(directory, { ...options, fetcher, maxAttempts: 2 })).toMatchObject({
      attemptsThisRun: 2,
      pendingRecords: 1,
    });
    expect(await drainJournal(directory, { ...options, fetcher, maxAttempts: 1 })).toMatchObject({
      attemptsThisRun: 0,
      stoppedReason: 'retry_wait_exceeds_run_budget',
    });
    // Expire persisted cooldown to model operator resume later, retaining immutable record.
    const state = object(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')));
    state.nextAttemptAt = '2026-10-10T00:00:00Z';
    await writeFile(join(directory, 'state.json'), JSON.stringify(state), { mode: 0o600 });
    const result = await drainJournal(directory, {
      ...options,
      fetcher: async (_url, request) => {
        bodies.push(request?.body);
        return new Response('', { status: 202 });
      },
      maxAttempts: 1,
    });
    expect(result).toMatchObject({ acknowledgedRecords: 1, pendingRecords: 0 });
    expect(new Set(bodies).size).toBe(1);
    expect(waits).toHaveLength(1);
    expect(waits.every((ms) => ms > 0)).toBe(true);
  });
  it('does not acknowledge authentication/predecessor/storage conflicts', async () => {
    const { directory, root } = await setup();
    await appendJournal(directory, entry);
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    for (const status of [401, 409, 413, 507]) {
      expect(
        await drainJournal(directory, {
          baseUrl: 'http://127.0.0.1:3001',
          tokenFile,
          env: {},
          sleep: async () => {},
          maxAttempts: 1,
          fetcher: async () => new Response('', { status }),
        }),
      ).toMatchObject({
        pendingRecords: 1,
        acknowledgedRecords: 0,
        stoppedReason: `receiver_${status}`,
      });
    }
  });
  it('rejects endpoint credentials, queries (including empty), fragments, non-loopback HTTP, and proxy env before fetch', async () => {
    const { directory, root } = await setup();
    await appendJournal(directory, entry);
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    let calls = 0;
    const options = {
      tokenFile,
      env: {},
      maxAttempts: 1,
      fetcher: async () => {
        calls += 1;
        return new Response('', { status: 202 });
      },
    };
    for (const baseUrl of [
      'http://example.invalid',
      'http://user:secret@localhost:3001',
      'http://localhost:3001?x=1',
      'http://localhost:3001?',
      'http://localhost:3001#',
      'http://localhost:3001/api',
    ]) {
      await expect(drainJournal(directory, { ...options, baseUrl })).rejects.toThrow(
        'journal_endpoint',
      );
    }
    await expect(
      drainJournal(directory, {
        ...options,
        baseUrl: 'https://trusted.example.invalid',
        env: { HTTPS_PROXY: 'http://proxy.invalid' },
      }),
    ).rejects.toThrow('journal_proxy_environment');
    expect(calls).toBe(0);
  });
});

describe('journal crash recovery and private files', () => {
  it('rejects token whitespace outside the optional single final newline before HTTP', async () => {
    const { root, directory } = await setup();
    await appendJournal(directory, entry);
    const tokenFile = join(root, 'token');
    let requests = 0;
    for (const value of [` ${'a'.repeat(64)}`, `${'a'.repeat(64)} `, `${'a'.repeat(64)}\n\n`]) {
      await writeFile(tokenFile, value, { mode: 0o600 });
      await expect(
        drainJournal(directory, {
          baseUrl: 'http://127.0.0.1:3000',
          tokenFile,
          env: {},
          fetcher: async () => {
            requests++;
            return new Response('', { status: 202 });
          },
        }),
      ).rejects.toThrow('journal_token');
    }
    expect(requests).toBe(0);
  });
  it('rejects an existing empty Git marker instead of guessing repository readiness', async () => {
    const { root, directory } = await setup();
    await mkdir(join(root, '.git'));
    await expect(statusJournal(directory)).rejects.toThrow('journal_private_path');
  });
  it('recovers stale PID reuse and interrupted empty lock publication; fails closed for unknown lock shape', async () => {
    const { directory } = await setup();
    const lock = join(directory, '.lock');
    await mkdir(lock, { mode: 0o700 });
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    await writeFile(
      join(lock, 'owner.dddddddd-dddd-4ddd-8ddd-dddddddddddd.json'),
      JSON.stringify({ pid: process.pid, start: '0', boot }),
      { mode: 0o600 },
    );
    expect(await statusJournal(directory)).toMatchObject({ entries: 0 });
    await mkdir(lock, { mode: 0o700 });
    expect(await statusJournal(directory)).toMatchObject({ entries: 0 });
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, 'unknown'), 'x', { mode: 0o600 });
    await expect(statusJournal(directory)).rejects.toThrow('journal_lock_corrupt');
  });
  it('enforces owner-only directory/token, rejects token symlinks and Git roots', async () => {
    const { directory, root } = await setup();
    await appendJournal(directory, entry);
    const tokenFile = join(root, 'token');
    const tokenLink = join(root, 'token-link');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    await symlink(tokenFile, tokenLink);
    const options = { baseUrl: 'http://127.0.0.1:3001', tokenFile, env: {}, maxAttempts: 1 };
    await expect(drainJournal(directory, { ...options, tokenFile: tokenLink })).rejects.toThrow(
      'journal_private_path',
    );
    await chmod(tokenFile, 0o644);
    await expect(drainJournal(directory, options)).rejects.toThrow('journal_private_file');
    await chmod(directory, 0o755);
    await expect(statusJournal(directory)).rejects.toThrow('journal_private_directory');
    await chmod(directory, 0o700);
    await writeFile(join(root, '.git'), 'gitdir: /fictional/worktree', { mode: 0o600 });
    await expect(statusJournal(directory)).rejects.toThrow('journal_private_path');
  });
  it('bounds bytes independently of record count and never prunes acknowledged evidence', async () => {
    const { directory } = await setup({ maxBytes: 700 });
    await appendJournal(directory, entry);
    const before = await readFile(join(directory, 'records', '0000000001.json'));
    await expect(appendJournal(directory, entry)).rejects.toThrow('journal_capacity');
    expect(await statusJournal(directory)).toMatchObject({ entries: 1, acknowledgedRecords: 0 });
    expect(await readFile(join(directory, 'records', '0000000001.json'))).toEqual(before);
  });
  it('drains entries and multiple seals in original retained order with fixed API path', async () => {
    const { directory, root } = await setup();
    await appendJournal(directory, entry);
    await sealJournal(directory, {
      start: config.startupAt,
      end: '2026-10-10T00:00:02Z',
      evidenceRef: 'urn:fictional:seal',
    });
    await appendJournal(directory, { ...entry, capturedAt: '2026-10-10T00:00:03Z' });
    await sealJournal(directory, {
      start: '2026-10-10T00:00:02Z',
      end: '2026-10-10T00:00:04Z',
      evidenceRef: 'urn:fictional:seal2',
    });
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const files = (await readdir(join(directory, 'records'))).sort();
    const expected = await Promise.all(
      files.map((name) => readFile(join(directory, 'records', name), 'utf8')),
    );
    const bodies: unknown[] = [];
    const result = await drainJournal(directory, {
      baseUrl: 'https://trusted.example.invalid',
      tokenFile,
      env: {},
      maxAttempts: 4,
      sleep: async () => {},
      fetcher: async (url, request) => {
        expect(String(url)).toBe(
          `https://trusted.example.invalid/api/argo/sources/${config.sourceId}/archives/${config.producerId}`,
        );
        expect(request?.redirect).toBe('error');
        bodies.push(request?.body);
        return new Response('', { status: 202 });
      },
    });
    expect(bodies).toEqual(expected);
    expect(result).toMatchObject({
      entries: 2,
      seals: 2,
      retainedRecords: 4,
      acknowledgedRecords: 4,
      lastAcknowledgedSequence: 2,
    });
  });
  it('rejects backdated real captures but preserves original unknown notification unchanged', async () => {
    const { root } = await setup();
    const directory = join(root, 'actual');
    const { startupAt: _startup, ...actual } = config;
    await initJournal(directory, { ...actual, fictional: false });
    await expect(appendJournal(directory, entry)).rejects.toThrow('journal_capture_clock');
    const native = {
      unsupported: ['keep', 'original'],
      operation: { info: [{ name: 'clio.operation-kind', value: 'retry' }] },
    };
    const record = await captureJournal(directory, {
      input: native,
      format: 'notification',
      evidenceRef: 'urn:fictional:real-capture-test',
    });
    expect(record.notification).toEqual(native);
    expect(record.startup_at <= record.captured_at).toBe(true);
  });
});

it('preserves malformed Application initiator instead of converting it into valid native metadata', async () => {
  const { directory } = await setup();
  const record = await captureJournal(directory, {
    input: {
      kind: 'Application',
      apiVersion: 'argoproj.io/v1alpha1',
      metadata: { uid: 'real-uid' },
      spec: {},
      status: {
        operationState: {
          operation: { initiatedBy: 'unsupported-shape', info: { not: 'an array' } },
          syncResult: { revisions: 'unsupported' },
        },
      },
    },
    format: 'application',
    evidenceRef: 'urn:fictional:unsupported',
  });
  expect(record.notification).toMatchObject({
    operation: {
      initiatedBy: 'unsupported-shape',
      info: { not: 'an array' },
      revisions: 'unsupported',
    },
  });
});

it('real loopback HTTP lost-ack delivery resends identical bytes; throttling remains resumable', async () => {
  const { directory, root } = await setup();
  await appendJournal(directory, entry);
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const requests: { path: string | undefined; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ path: request.url, body });
      if (requests.length === 1) request.socket.destroy();
      else if (requests.length === 3) {
        response.writeHead(429, { 'Retry-After': '120' });
        response.end();
      } else {
        response.writeHead(202);
        response.end();
      }
    });
  });
  try {
    await new Promise<void>((ready, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', ready);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test_listener');
    const options = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      tokenFile,
      env: {},
      maxAttempts: 1,
      sleep: async () => {},
    };
    expect(await drainJournal(directory, options)).toMatchObject({
      pendingRecords: 1,
      acknowledgedRecords: 0,
    });
    expect(await drainJournal(directory, options)).toMatchObject({
      pendingRecords: 0,
      acknowledgedRecords: 1,
    });
    expect(requests[0]?.body).toBe(requests[1]?.body);
    expect(requests[0]?.path).toBe(
      `/api/argo/sources/${config.sourceId}/archives/${config.producerId}`,
    );
    await appendJournal(directory, entry);
    expect(await drainJournal(directory, options)).toMatchObject({
      pendingRecords: 1,
      stoppedReason: 'receiver_429',
    });
    expect(await drainJournal(directory, options)).toMatchObject({
      attemptsThisRun: 0,
      pendingRecords: 1,
      stoppedReason: 'retry_wait_exceeds_run_budget',
    });
    const state = object(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')));
    state.nextAttemptAt = '2026-10-10T00:00:00Z';
    await writeFile(join(directory, 'state.json'), JSON.stringify(state), { mode: 0o600 });
    expect(await drainJournal(directory, options)).toMatchObject({
      pendingRecords: 0,
      acknowledgedRecords: 2,
    });
    expect(requests[2]?.body).toBe(requests[3]?.body);
    expect(await readdir(join(directory, 'records'))).toHaveLength(2);
  } finally {
    if (server.listening)
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
  }
});

it('CLI rejects duplicate/unknown flags; fictional append, capture, seal and status share durable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-journal-cli-'));
  roots.push(root);
  const directory = join(root, 'journal');
  expect(await runCli(['help'])).toContain('Coverage remains incomplete');
  await expect(
    runCli(['status', '--directory', directory, '--provider-url', 'https://example.invalid']),
  ).rejects.toThrow('journal_arguments');
  await expect(
    runCli(['status', '--directory', directory, '--directory', directory]),
  ).rejects.toThrow('journal_arguments');
  await runCli([
    'init',
    '--directory',
    directory,
    '--source',
    config.sourceId,
    '--producer',
    config.producerId,
    '--journal',
    config.journalId,
    '--policy',
    config.policyReference,
    '--fictional',
    '--startup-at',
    config.startupAt,
  ]);
  const input = join(root, 'original.json');
  await writeFile(input, JSON.stringify(entry.notification), { mode: 0o600 });
  await runCli([
    'append',
    '--directory',
    directory,
    '--input',
    input,
    '--evidence-ref',
    entry.evidenceRef,
    '--captured-at',
    entry.capturedAt,
  ]);
  await runCli([
    'seal',
    '--directory',
    directory,
    '--start',
    config.startupAt,
    '--end',
    '2026-10-10T00:00:02Z',
    '--evidence-ref',
    'urn:fictional:cli-seal',
  ]);
  await runCli([
    'capture',
    '--directory',
    directory,
    '--input',
    input,
    '--format',
    'notification',
    '--evidence-ref',
    'urn:fictional:cli-current',
  ]);
  expect(await runCli(['status', '--directory', directory])).toMatchObject({
    entries: 2,
    seals: 1,
    pendingRecords: 3,
    fictional: true,
  });
});

it('rejects incompatible Unicode before persisting a journal entry', async () => {
  const { directory } = await setup();
  await expect(
    appendJournal(directory, { ...entry, notification: { unsupported: '\u0000' } }),
  ).rejects.toThrow();
  expect((await statusJournal(directory)).retainedRecords).toBe(0);
});

it('captures and seals during a stalled sender, excludes another sender and acknowledges fresh state', async () => {
  const { directory, root } = await setup();
  await appendJournal(directory, entry);
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  let started: () => void = () => {};
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: () => void = () => {};
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const options = { baseUrl: 'http://127.0.0.1:3001', tokenFile, env: {}, maxAttempts: 1 };
  const body = await readFile(join(directory, 'records', '0000000001.json'), 'utf8');
  const drain = drainJournal(directory, {
    ...options,
    fetcher: async (_url, request) => {
      expect(request?.body).toBe(body);
      started();
      await stalled;
      return new Response('', { status: 202 });
    },
  });
  await sending;
  try {
    await expect(drainJournal(directory, options)).rejects.toThrow('journal_locked');
    await sealJournal(directory, {
      start: config.startupAt,
      end: '2026-10-10T00:00:02Z',
      evidenceRef: 'urn:fictional:concurrent-seal',
    });
    await captureJournal(directory, {
      input: { phase: 'Running' },
      format: 'notification',
      evidenceRef: 'urn:fictional:concurrent-capture',
    });
    expect(await statusJournal(directory)).toMatchObject({
      retainedRecords: 3,
      acknowledgedRecords: 0,
    });
  } finally {
    release();
    await drain;
  }
  expect(await drain).toMatchObject({
    retainedRecords: 3,
    acknowledgedRecords: 1,
    pendingRecords: 2,
  });
  const state = object(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')));
  expect(state).toMatchObject({ retainedRecords: 3, acknowledgedRecords: 1, attempts: 1 });
});

it('deduplicates exact projected observations after a lost checkpoint while default capture still appends', async () => {
  const { directory } = await setup();
  const before = await readFile(join(directory, 'state.json'));
  const input = {
    kind: 'Application',
    apiVersion: 'argoproj.io/v1alpha1',
    metadata: { uid: 'uid', annotations: { bookkeeping: 'first' } },
    spec: {},
    status: {
      operationState: {
        phase: 'Running',
        operation: { info: [{ name: 'clio.operation-id', value: 'id1' }] },
      },
    },
  };
  const options = {
    input,
    format: 'application' as const,
    evidenceRef: 'urn:fictional:dedup',
    deduplicate: true,
  };
  const first = await captureJournal(directory, options);
  await writeFile(join(directory, 'state.json'), before, { mode: 0o600 });
  const repeated = await captureJournal(directory, {
    ...options,
    evidenceRef: 'urn:fictional:restart',
    input: { ...input, metadata: { uid: 'uid', annotations: { bookkeeping: 'second' } } },
  });
  expect(repeated).toEqual(first);
  expect(await readdir(join(directory, 'records'))).toHaveLength(1);
  const changed = await captureJournal(directory, {
    ...options,
    input: {
      ...input,
      status: { operationState: { ...input.status.operationState, phase: 'Succeeded' } },
    },
  });
  expect(changed.sequence).toBe(2);
  const manual = await captureJournal(directory, { ...options, deduplicate: false });
  expect(manual.sequence).toBe(3);
  expect(await captureJournal(directory, options)).toEqual(manual);
});

it.each(['Healthy', { unsupported: 'health' }])(
  'retains health A/B/A without timestamps, deduplicating only latest entry across seals (%j)',
  async (health) => {
    const { directory } = await setup();
    const input = {
      kind: 'Application',
      apiVersion: 'argoproj.io/v1alpha1',
      metadata: { uid: 'uid' },
      spec: {},
      status: { health: { status: health } },
    };
    const options = {
      input,
      format: 'application' as const,
      evidenceRef: 'urn:fictional:health-transition',
      deduplicate: true,
    };
    const first = await captureJournal(directory, options);
    const changed = await captureJournal(directory, {
      ...options,
      input: { ...input, status: { health: { status: 'Degraded' } } },
    });
    const restored = await captureJournal(directory, options);
    expect([first.sequence, changed.sequence, restored.sequence]).toEqual([1, 2, 3]);
    expect(restored.notification).toEqual(first.notification);
    expect(restored.previous_digest).toBe(changed.digest);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await sealJournal(directory, {
      start: config.startupAt,
      end: new Date().toISOString(),
      evidenceRef: 'urn:fictional:health-seal',
    });
    expect(await captureJournal(directory, options)).toEqual(restored);
    expect(await statusJournal(directory)).toMatchObject({ entries: 3, seals: 1 });
  },
);

it.each([
  'not-a-date-secret',
  'Wed, 99 Oct 2026 00:00:00 GMT',
  '9'.repeat(400),
  '9000000000000',
  'Wed, 01 Jan 10000 00:00:00 GMT',
])(
  'falls back safely for invalid or excessive Retry-After %s, preserving bytes and ack',
  async (header) => {
    const { directory, root } = await setup();
    await appendJournal(directory, entry);
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const bodies: unknown[] = [];
    const options = {
      baseUrl: 'http://127.0.0.1:3001',
      tokenFile,
      env: {},
      maxAttempts: 1,
      random: () => 0,
    };
    const before = Date.now();
    const rejected = await drainJournal(directory, {
      ...options,
      fetcher: async (_url, request) => {
        bodies.push(request?.body);
        return new Response('', { status: 503, headers: { 'Retry-After': header } });
      },
    });
    expect(rejected).toMatchObject({
      acknowledgedRecords: 0,
      pendingRecords: 1,
      stoppedReason: 'receiver_503',
    });
    expect(typeof rejected.nextAttemptAt).toBe('string');
    const state = object(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')));
    expect(rejected.nextAttemptAt).toBe(state.nextAttemptAt);
    if (typeof rejected.nextAttemptAt !== 'string') throw new Error('missing_cooldown');
    const deadline = Date.parse(rejected.nextAttemptAt);
    expect(deadline).toBeGreaterThanOrEqual(before + 4000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 4000);
    expect(await statusJournal(directory)).not.toHaveProperty('nextAttemptAt');
    const resumed = await drainJournal(directory, {
      ...options,
      sleep: async (delay) => {
        expect(Date.now() + delay).toBeGreaterThanOrEqual(deadline);
        await appendJournal(directory, { ...entry, evidenceRef: 'urn:fictional:tail' });
      },
      fetcher: async (_url, request) => {
        bodies.push(request?.body);
        return new Response('', { status: 202 });
      },
    });
    expect(resumed).toMatchObject({ acknowledgedRecords: 1, pendingRecords: 1 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  },
);

it.each(['delta', 'date'])(
  'returns durable receiver cooldown for valid Retry-After %s without changing status shape',
  async (format) => {
    const header = format === 'delta' ? '120' : new Date(Date.now() + 120000).toUTCString();
    const { directory, root } = await setup();
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const options = { baseUrl: 'http://127.0.0.1:3001', tokenFile, env: {}, maxAttempts: 1 };
    expect(await drainJournal(directory, options)).toMatchObject({
      nextAttemptAt: null,
      attemptsThisRun: 0,
    });
    await appendJournal(directory, entry);
    const before = Date.now();
    const result = await drainJournal(directory, {
      ...options,
      fetcher: async () => new Response('', { status: 429, headers: { 'Retry-After': header } }),
    });
    if (typeof result.nextAttemptAt !== 'string') throw new Error('missing_cooldown');
    expect(Date.parse(result.nextAttemptAt)).toBeGreaterThanOrEqual(
      header === '120' ? before + 120000 : Date.parse(header),
    );
    let calls = 0;
    expect(
      await drainJournal(directory, {
        ...options,
        maxWaitMs: 0,
        fetcher: async () => {
          calls += 1;
          return new Response('', { status: 202 });
        },
      }),
    ).toMatchObject({
      nextAttemptAt: result.nextAttemptAt,
      attemptsThisRun: 0,
      stoppedReason: 'retry_wait_exceeds_run_budget',
    });
    expect(calls).toBe(0);
    expect(await statusJournal(directory)).not.toHaveProperty('nextAttemptAt');
  },
);

it('named stale locks reclaim independently and capture checkpoint writes leave sender state intact', async () => {
  const { directory } = await setup();
  const original = await readFile(join(directory, 'state.json'), 'utf8');
  for (const kind of ['sender', 'capture'] as const) {
    const lock = join(directory, `.${kind}.lock`);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(
      join(lock, 'owner.dddddddd-dddd-4ddd-8ddd-dddddddddddd.json'),
      JSON.stringify({ pid: 2147483647, boot: 'old-boot', start: '1' }),
      { mode: 0o600 },
    );
  }
  await locked(
    directory,
    async () => {
      await locked(
        directory,
        async () => {
          await expect(locked(directory, async () => {}, 'capture')).rejects.toThrow(
            'journal_locked',
          );
          await Promise.all([
            appendJournal(directory, entry),
            atomicState(directory, { cursor: 'opaque' }, 'capture-state.json'),
          ]);
        },
        'capture',
      );
    },
    'sender',
  );
  expect(JSON.parse(await readFile(join(directory, 'capture-state.json'), 'utf8'))).toEqual({
    cursor: 'opaque',
  });
  const current = object(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')));
  expect(current).toEqual({ ...object(JSON.parse(original)), retainedRecords: 1 });
  expect(await readdir(directory)).not.toContain('capture-state.pending');
});

it('allows capture during backoff and reloads the tail before exact-byte retry acknowledgement', async () => {
  const { directory, root } = await setup();
  await appendJournal(directory, entry);
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const body = await readFile(join(directory, 'records', '0000000001.json'), 'utf8');
  let calls = 0;
  const result = await drainJournal(directory, {
    baseUrl: 'http://127.0.0.1:3001',
    tokenFile,
    env: {},
    maxAttempts: 2,
    random: () => 0,
    fetcher: async (_url, request) => {
      expect(request?.body).toBe(body);
      calls += 1;
      return calls === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '5' } })
        : new Response('', { status: 202 });
    },
    sleep: async (delay) => {
      expect(delay).toBeGreaterThan(4000);
      await captureJournal(directory, {
        input: { original: 'later capture' },
        format: 'notification',
        evidenceRef: 'urn:fictional:backoff',
      });
    },
  });
  expect(result).toMatchObject({
    retainedRecords: 2,
    acknowledgedRecords: 1,
    pendingRecords: 1,
    attemptsThisRun: 2,
  });
  expect(object(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')))).toMatchObject({
    retainedRecords: 2,
    acknowledgedRecords: 1,
    attempts: 2,
  });
});

it('fails closed instead of regressing progress when selected index changes during delivery', async () => {
  const { directory, root } = await setup();
  await appendJournal(directory, entry);
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  await expect(
    drainJournal(directory, {
      baseUrl: 'http://127.0.0.1:3001',
      tokenFile,
      env: {},
      maxAttempts: 1,
      fetcher: async () => {
        const state = object(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')));
        await atomicState(directory, { ...state, acknowledgedRecords: 1 });
        return new Response('', { status: 202 });
      },
    }),
  ).rejects.toThrow('journal_corrupt');
  expect(await statusJournal(directory)).toMatchObject({ acknowledgedRecords: 1 });
});

it.each([202, 503])(
  'receiver body cancellation failure does not abort status %i delivery state',
  async (status) => {
    const { directory, root } = await setup();
    await appendJournal(directory, entry);
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const result = await drainJournal(directory, {
      baseUrl: 'http://127.0.0.1:3001',
      tokenFile,
      env: {},
      maxAttempts: 1,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw new Error('controlled private receiver body failure');
            },
          }),
          { status },
        ),
    });
    expect(result.acknowledgedRecords).toBe(status === 202 ? 1 : 0);
    expect(result.stoppedReason).toBe(status === 202 ? null : 'receiver_503');
    expect(await statusJournal(directory)).toMatchObject({
      retainedRecords: 1,
      acknowledgedRecords: result.acknowledgedRecords,
    });
  },
);

it('caps representable long Retry-After at one day without acknowledging or clearing pacing', async () => {
  const { directory, root } = await setup();
  await appendJournal(directory, entry);
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const started = Date.now();
  const result = await drainJournal(directory, {
    baseUrl: 'http://127.0.0.1:3001',
    tokenFile,
    env: {},
    maxAttempts: 1,
    fetcher: async () => new Response('', { status: 429, headers: { 'Retry-After': '99999999' } }),
  });
  expect(result.acknowledgedRecords).toBe(0);
  if (typeof result.nextAttemptAt !== 'string') throw new Error('missing_cooldown');
  expect(Date.parse(result.nextAttemptAt)).toBeGreaterThanOrEqual(started + 86400000);
  expect(Date.parse(result.nextAttemptAt)).toBeLessThanOrEqual(Date.now() + 86400000);
  expect(
    await drainJournal(directory, {
      baseUrl: 'http://127.0.0.1:3001',
      tokenFile,
      env: {},
      maxAttempts: 1,
      maxWaitMs: 0,
    }),
  ).toMatchObject({ attemptsThisRun: 0, stoppedReason: 'retry_wait_exceeds_run_budget' });
});

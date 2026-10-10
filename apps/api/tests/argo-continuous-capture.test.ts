import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../../infra/argocd/capture/cli.ts';
import { loadConfig, parseConfig } from '../../../infra/argocd/capture/config.ts';
import {
  frames,
  parseList,
  parseWatchEvent,
  validateApplication,
} from '../../../infra/argocd/capture/parser.ts';
import { runCapture, sleep } from '../../../infra/argocd/capture/run.ts';
import { createTransport, kubectlArguments } from '../../../infra/argocd/capture/transport.ts';
import {
  captureJournal,
  initJournal,
  statusJournal,
} from '../../../infra/argocd/journal/journal.ts';
import { locked } from '../../../infra/argocd/journal/storage.ts';

describe('continuous capture boundaries', () => {
  it('rejects unknown operator config and missing binding', () => {
    expect(() => parseConfig({ arbitraryUrl: 'https://example.com' })).toThrow();
  });
  it('frames multiple events across chunk boundaries', async () => {
    async function* chunks() {
      yield Buffer.from('{"type":"BO');
      yield Buffer.from('OKMARK","object":{"metadata":{"resourceVersion":"opaque/2"}}}\n');
      yield Buffer.from('{"type":"ERROR","object":{"code":410}}\n');
    }
    const events = [];
    for await (const event of frames(chunks())) events.push(parseWatchEvent(event));
    expect(events).toEqual([{ type: 'BOOKMARK', cursor: 'opaque/2' }, { type: 'EXPIRED' }]);
  });
  it('rejects giant frames, malformed JSON and incomplete final event', async () => {
    for (const body of ['x'.repeat(512 * 1024 + 1), '{broken}\n', '{"type":']) {
      async function* chunks() {
        yield Buffer.from(body);
      }
      await expect(
        (async () => {
          for await (const _event of frames(chunks())) {
            /* consume */
          }
        })(),
      ).rejects.toThrow();
    }
  });
});

const roots: string[] = [];
const scope = {
  sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  serviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  instance: 'sandbox',
  applicationUid: 'real-uid',
  applicationName: 'selected',
  applicationNamespace: 'argocd',
  project: 'default',
  destinationClusterId: 'cluster',
  destinationServer: 'https://kubernetes.default.svc',
  destinationName: null,
  destinationNamespace: 'demo',
  configurationRepositoryId: 'config',
  repoURL: 'https://example.com/repo.git',
  environment: 'production',
};
const ids = {
  producerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  journalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  policyReference: 'urn:test:policy',
};
function application(
  resourceVersion = 'rv-1',
  phase = 'Running',
  operationId = '11111111-1111-4111-8111-111111111111',
) {
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: {
      uid: scope.applicationUid,
      name: scope.applicationName,
      namespace: scope.applicationNamespace,
      resourceVersion,
    },
    spec: {
      project: scope.project,
      source: { repoURL: scope.repoURL },
      destination: { server: scope.destinationServer, namespace: scope.destinationNamespace },
    },
    status: {
      operationState: {
        phase,
        startedAt: '2026-10-10T00:00:01Z',
        finishedAt: phase === 'Running' ? null : '2026-10-10T00:00:02Z',
        operation: {
          info: [{ name: 'clio.operation-id', value: operationId }],
          initiatedBy: { username: 'operator' },
        },
        syncResult: { revision: 'same-sha' },
      },
      health: { status: 'Healthy', lastTransitionTime: '2026-10-10T00:00:03Z' },
    },
  };
}
function list(input = application(), resourceVersion = 'list-rv') {
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'ApplicationList',
    metadata: { resourceVersion },
    items: [input],
  };
}
async function fixture(maxRecords = 100) {
  const root = await mkdtemp(join(tmpdir(), 'clio-capture-test-'));
  roots.push(root);
  const directory = join(root, 'journal');
  await initJournal(directory, { sourceId: scope.sourceId, ...ids, maxRecords });
  const kubeconfig = join(root, 'kubeconfig'),
    tokenFile = join(root, 'token');
  await writeFile(kubeconfig, 'trusted operator fixture', { mode: 0o600 });
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const config = parseConfig({
    journalDirectory: directory,
    kubectlPath: await realpath(process.execPath),
    kubeconfig,
    context: 'chosen',
    scope,
    ...ids,
    receiver: { baseUrl: 'http://127.0.0.1:3001', tokenFile },
  });
  return { root, directory, config };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native source and transport', () => {
  it('checks UID, deletion and every source binding; retains unsupported native shapes', () => {
    expect(validateApplication(application(), scope).cursor).toBe('rv-1');
    for (const input of [
      { ...application(), metadata: { ...application().metadata, uid: 'recreated' } },
      {
        ...application(),
        metadata: { ...application().metadata, deletionTimestamp: '2026-10-10T00:00:01Z' },
      },
      { ...application(), spec: { ...application().spec, project: 'other' } },
      {
        ...application(),
        spec: { ...application().spec, source: { repoURL: 'https://other/repo' } },
      },
      {
        ...application(),
        spec: { ...application().spec, destination: { server: 'other', namespace: 'demo' } },
      },
    ])
      expect(() => validateApplication(input, scope)).toThrow();
    const unsupported = {
      ...application(),
      spec: {
        project: scope.project,
        sources: [{ repoURL: 'https://other/repo' }],
        sourceHydrator: {},
        destination: application().spec.destination,
      },
    };
    expect(validateApplication(unsupported, scope).input).toEqual(unsupported);
    expect(() => parseList({ ...list(), items: [] }, scope)).toThrow('capture_list_scope');
    expect(() => parseList({ ...list(), items: [application(), application()] }, scope)).toThrow();
  });
  it('rejects config extra keys, scope limits, bad URLs and unsafe selectors', () => {
    const base = {
      journalDirectory: '/private/journal',
      kubectlPath: '/usr/bin/kubectl',
      kubeconfig: '/private/kubeconfig',
      context: 'chosen',
      scope,
      ...ids,
      receiver: { baseUrl: 'https://clio.example.com', tokenFile: '/private/token' },
    };
    for (const value of [
      { ...base, extra: true },
      { ...base, scope: { ...scope, extra: true } },
      { ...base, scope: { ...scope, instance: 'x'.repeat(201) } },
      { ...base, scope: { ...scope, applicationName: 'selected,other' } },
      { ...base, receiver: { ...base.receiver, baseUrl: 'http://external.test' } },
      { ...base, context: '' },
    ])
      expect(() => parseConfig(value)).toThrow();
    expect(parseConfig(base)).toEqual(base);
  });
  it('spawns controlled executable with exact argv, bounded list/watch and no shell', async () => {
    const { root, config } = await fixture();
    const executable = join(root, 'fake-kubectl');
    const argvFile = join(root, 'argv.json');
    await writeFile(
      executable,
      `#!${await realpath(process.execPath)}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(list()))});\n`,
      { mode: 0o700 },
    );
    const realConfig = { ...config, kubectlPath: executable, context: 'chosen; touch forbidden' };
    const transport = createTransport(realConfig, {});
    expect(await transport.list(new AbortController().signal)).toEqual(list());
    expect(JSON.parse(await readFile(argvFile, 'utf8'))).toEqual(kubectlArguments(realConfig));
    const watchArgs = kubectlArguments(realConfig, 'opaque/&cursor');
    expect(watchArgs).toContain('--request-timeout=35s');
    const request = watchArgs.at(-1);
    expect(request).toContain('watch=true');
    expect(request).toContain('timeoutSeconds=30');
    expect(request).toContain('fieldSelector=metadata.name%3Dselected');
    expect(request).toContain('resourceVersion=opaque%2F%26cursor');
    expect(() => createTransport(config, { HTTPS_PROXY: 'http://private' })).toThrow(
      'capture_proxy_environment',
    );
  });
  it('rejects private config permissions before parsing; safe CLI argument gate', async () => {
    const { root, config } = await fixture();
    const file = join(root, 'capture.json');
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    expect(await loadConfig(file)).toEqual(config);
    await chmod(file, 0o644);
    await expect(loadConfig(file)).rejects.toThrow('capture_config');
  });
});

describe('durable continuous capture', () => {
  it('retains Running, terminal and new operation at same SHA; deduplicates annotations; bookmarks create no evidence', async () => {
    const { config, directory } = await fixture();
    const stop = new AbortController();
    const result = await runCapture(config, {
      env: {},
      signal: stop.signal,
      fetcher: async () => {
        throw new Error('offline');
      },
      transport: {
        list: async () => list(),
        async *watch() {
          yield {
            type: 'MODIFIED',
            object: {
              ...application('rv-2'),
              metadata: {
                ...application('rv-2').metadata,
                annotations: { bookkeeping: 'changed' },
              },
            },
          };
          yield { type: 'MODIFIED', object: application('rv-3', 'Succeeded') };
          yield {
            type: 'MODIFIED',
            object: application('rv-4', 'Succeeded', '22222222-2222-4222-8222-222222222222'),
          };
          yield { type: 'BOOKMARK', object: { metadata: { resourceVersion: 'bookmark-opaque' } } };
          stop.abort();
        },
      },
    });
    expect(result.bookmarks).toBe(1);
    expect(await statusJournal(directory)).toMatchObject({ entries: 3, acknowledgedRecords: 0 });
    expect(JSON.parse(await readFile(join(directory, 'capture-state.json'), 'utf8'))).toMatchObject(
      { cursor: 'bookmark-opaque', lastSequence: 3 },
    );
  });
  it('captures while receiver is blocked and shutdown cancels watch with honest unsealed tail', async () => {
    const { config, directory } = await fixture();
    const stop = new AbortController();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempted: (() => void) | undefined;
    const sending = new Promise<void>((resolve) => {
      attempted = resolve;
    });
    const running = runCapture(config, {
      env: {},
      signal: stop.signal,
      fetcher: async () => {
        attempted?.();
        await blocked;
        return new Response('', { status: 202 });
      },
      transport: {
        list: async () => list(),
        async *watch(_cursor, signal) {
          await sending;
          yield { type: 'MODIFIED', object: application('rv-terminal', 'Succeeded') };
          expect(await statusJournal(directory)).toMatchObject({
            entries: 2,
            acknowledgedRecords: 0,
          });
          stop.abort();
          release?.();
          await sleep(1, signal);
        },
      },
    });
    await running;
    expect(await statusJournal(directory)).toMatchObject({ entries: 2, acknowledgedRecords: 1 });
  });
  it('reuses fsynced exact entry after crash before capture checkpoint, keeping original capture time', async () => {
    const { config, directory } = await fixture();
    const options = {
      env: {},
      fetcher: async () => {
        throw new Error('offline');
      },
    };
    await expect(
      runCapture(config, {
        ...options,
        signal: new AbortController().signal,
        transport: { list: async () => list(), async *watch() {} },
        afterCapture: async () => {
          throw new Error('injected_crash');
        },
      }),
    ).rejects.toThrow('injected_crash');
    const files = await import('node:fs/promises').then((fs) =>
      fs.readdir(join(directory, 'records')),
    );
    const prior = await Promise.all(
      files.map((file) => readFile(join(directory, 'records', file), 'utf8')),
    );
    const original = prior
      .map((body) => JSON.parse(body))
      .find((record) => record.kind === 'entry');
    expect(
      JSON.parse(await readFile(join(directory, 'capture-state.json'), 'utf8')).cursor,
    ).toBeNull();
    const stop = new AbortController();
    await runCapture(config, {
      ...options,
      signal: stop.signal,
      transport: {
        list: async () => list(),
        async *watch() {
          stop.abort();
          yield { type: 'BOOKMARK', object: { metadata: { resourceVersion: 'unused' } } };
        },
      },
    });
    expect(await statusJournal(directory)).toMatchObject({ entries: 1 });
    const currentFiles = await import('node:fs/promises').then((fs) =>
      fs.readdir(join(directory, 'records')),
    );
    const records = await Promise.all(
      currentFiles.map((file) => readFile(join(directory, 'records', file), 'utf8')),
    );
    expect(
      records.map((body) => JSON.parse(body)).find((record) => record.kind === 'entry'),
    ).toEqual(original);
  });
  it('seals disconnect, cursor expiration/relist and restart without recovering history', async () => {
    const { config, directory } = await fixture();
    const stop = new AbortController();
    let lists = 0,
      watches = 0;
    const acquisitionCodes: string[] = [];
    let expiredAt = 0;
    const options = {
      progress: (value: { acquisition: string | null }) => {
        if (value.acquisition) acquisitionCodes.push(value.acquisition);
      },
      env: {},
      signal: stop.signal,
      fetcher: async () => {
        throw new Error('offline');
      },
      sleep: async (_ms: number, signal: AbortSignal) => sleep(2, signal),
    };
    await runCapture(config, {
      ...options,
      transport: {
        list: async () => {
          lists++;
          return list(application(`list-${lists}`));
        },
        async *watch() {
          watches++;
          if (watches === 1) throw new Error('capture_transport');
          if (watches === 2) {
            expiredAt = Date.now();
            yield { type: 'ERROR', object: { code: 410 } };
          } else stop.abort();
        },
      },
    });
    expect(lists).toBe(2);
    expect(watches).toBe(3);
    expect(await statusJournal(directory)).toMatchObject({ entries: 1 });
    const files = await import('node:fs/promises').then((fs) =>
      fs.readdir(join(directory, 'records')),
    );
    const records = await Promise.all(
      files.map((file) => readFile(join(directory, 'records', file), 'utf8')),
    );
    const seals = records
      .map((body) => JSON.parse(body))
      .filter((record) => record.kind === 'seal');
    expect(acquisitionCodes).toContain('capture_transport');
    expect(acquisitionCodes).toContain('capture_cursor_expired');
    const pending = JSON.parse(await readFile(join(directory, 'capture-state.json'), 'utf8'));
    expect(
      pending.interruptions.some(
        (gap: { start: string; end: string }) =>
          Date.parse(gap.start) <= expiredAt && Date.parse(gap.end) >= expiredAt,
      ),
    ).toBe(true);
    const resumedStop = new AbortController();
    await runCapture(config, {
      ...options,
      signal: resumedStop.signal,
      transport: {
        list: async () => list(),
        async *watch() {
          resumedStop.abort();
          yield* [];
        },
      },
    });
    const resumed = await statusJournal(directory);
    expect(resumed.entries).toBe(1);
    expect(resumed.seals).toBeGreaterThan(seals.length);
    for (const seal of seals) {
      expect(Date.parse(seal.end)).toBeGreaterThan(Date.parse(seal.start));
      expect(seal.interruptions.length).toBeLessThanOrEqual(32);
    }
  });
  it('stops on scope drift, malformed events, capacity, checkpoint corruption and backward clock', async () => {
    for (const [kind, code] of [
      ['scope', 'capture_scope_drift'],
      ['malformed', 'capture_watch_event'],
      ['capacity', 'journal_capacity'],
      ['clock', 'capture_clock_rollback'],
    ]) {
      const { config, directory } = await fixture(kind === 'capacity' ? 5 : 100);
      let rollback = false;
      const clock = () => new Date(rollback ? 0 : Date.now());
      let releaseSender: () => void = () => {};
      let sender: Promise<void> | undefined;
      if (kind === 'capacity') {
        let ready: () => void = () => {};
        const owned = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const held = new Promise<void>((resolve) => {
          releaseSender = resolve;
        });
        sender = locked(
          directory,
          async () => {
            ready();
            await held;
          },
          'sender',
        );
        await owned;
      }
      try {
        await expect(
          runCapture(config, {
            env: {},
            signal: new AbortController().signal,
            ...(kind === 'clock' ? { now: clock } : {}),
            fetcher: async () => {
              throw new Error('offline');
            },
            transport: {
              list: async () => list(),
              async *watch() {
                if (kind === 'clock') rollback = true;
                if (kind === 'capacity') {
                  const available = (await statusJournal(directory)).remainingRecords;
                  for (let index = 0; index < available; index++)
                    await captureJournal(directory, {
                      input: { controlledCapacity: index },
                      format: 'notification',
                      evidenceRef: 'urn:fixture:capacity',
                    });
                }
                if (kind === 'scope')
                  yield {
                    type: 'MODIFIED',
                    object: {
                      ...application(),
                      metadata: { ...application().metadata, uid: 'other' },
                    },
                  };
                else if (kind === 'malformed') yield { type: 'UNKNOWN', object: {} };
                else yield { type: 'MODIFIED', object: application('new-rv', 'Succeeded') };
              },
            },
          }),
        ).rejects.toThrow(code);
      } finally {
        releaseSender();
        await sender;
      }
      if (kind !== 'capacity') expect(await statusJournal(directory)).toMatchObject({ entries: 1 });
    }
    const { config, directory } = await fixture();
    await writeFile(join(directory, 'capture-state.json'), '{bad', { mode: 0o600 });
    await expect(
      runCapture(config, { env: {}, signal: new AbortController().signal }),
    ).rejects.toThrow('capture_state');
  });
  it('surfaces permanent receiver conflict once while retaining later capture', async () => {
    const { config, directory } = await fixture();
    const stop = new AbortController();
    let sends = 0;
    let delivered: (() => void) | undefined;
    const conflict = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    let code: string | null = null;
    await runCapture(config, {
      env: {},
      signal: stop.signal,
      progress: (value) => {
        code = value.delivery;
      },
      fetcher: async () => {
        sends++;
        delivered?.();
        return new Response('', { status: 409 });
      },
      transport: {
        list: async () => list(),
        async *watch() {
          await conflict;
          yield { type: 'MODIFIED', object: application('terminal', 'Succeeded') };
          stop.abort();
        },
      },
    });
    expect(sends).toBe(1);
    expect(code).toBe('receiver_409');
    expect(await statusJournal(directory)).toMatchObject({ entries: 2, acknowledgedRecords: 0 });
  });
});

describe('bounded acquisition regressions', () => {
  it('retains UTF-8 code points split between chunks and bounds individual frames in large chunks', async () => {
    const body = Buffer.from(`${JSON.stringify({ value: '☃' })}\n`);
    const start = body.indexOf(Buffer.from('☃'));
    async function* chunks() {
      yield body.subarray(0, start + 1);
      yield body.subarray(start + 1);
    }
    const records = [];
    for await (const value of frames(chunks())) records.push(value);
    expect(records).toEqual([{ value: '☃' }]);
    async function* largeChunk() {
      yield Buffer.from('null\n'.repeat(110000));
    }
    let count = 0;
    for await (const _value of frames(largeChunk())) count++;
    expect(count).toBe(110000);
    async function* invalidUtf8() {
      yield Buffer.from([255, 10]);
    }
    await expect(
      (async () => {
        for await (const _value of frames(invalidUtf8())) {
          /* consume */
        }
      })(),
    ).rejects.toThrow('capture_json');
  });
  it('checks opaque argv independently and redacts real subprocess stderr', async () => {
    const config = parseConfig({
      journalDirectory: '/private/journal',
      kubectlPath: await realpath(process.execPath),
      kubeconfig: '/private/kubeconfig',
      context: 'chosen; no-shell',
      scope,
      ...ids,
      receiver: { baseUrl: 'https://clio.example.com', tokenFile: '/private/token' },
    });
    const args = kubectlArguments(config, 'opaque/rv?2');
    expect(args.slice(0, 6)).toEqual([
      '--kubeconfig',
      '/private/kubeconfig',
      '--context',
      'chosen; no-shell',
      '--request-timeout=35s',
      'get',
    ]);
    expect(args.at(-1)).toContain('resourceVersion=opaque%2Frv%3F2');
    // Node is intentionally not kubectl; its real stderr must never escape transport.
    await expect(createTransport(config, {}).list(new AbortController().signal)).rejects.toThrow(
      'capture_transport',
    );
  });
  it('cancels controlled watch subprocess promptly without accepting partial source data', async () => {
    const { root, config } = await fixture();
    const executable = join(root, 'waiting-kubectl');
    await writeFile(
      executable,
      `#!${await realpath(process.execPath)}\nprocess.stdout.write('{"type":');\nsetInterval(() => {},1000);\n`,
      { mode: 0o700 },
    );
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 30);
    const records = [];
    try {
      for await (const raw of createTransport({ ...config, kubectlPath: executable }, {}).watch(
        'opaque',
        stop.signal,
      ))
        records.push(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    } finally {
      clearTimeout(timer);
    }
    expect(records).toHaveLength(0);
    expect(stop.signal.aborted).toBe(true);
  });
  it('rejects immutable config drift and cursors referring to nonexistent durable entries', async () => {
    const { config, directory } = await fixture();
    const stop = new AbortController();
    await runCapture(config, {
      env: {},
      signal: stop.signal,
      fetcher: async () => {
        throw new Error('offline');
      },
      transport: {
        list: async () => list(),
        async *watch() {
          stop.abort();
          yield null;
        },
      },
    });
    await expect(
      runCapture(
        { ...config, context: 'different' },
        { env: {}, signal: new AbortController().signal },
      ),
    ).rejects.toThrow('capture_state');
    const file = join(directory, 'capture-state.json');
    const checkpoint = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...checkpoint, lastSequence: 4999 }), { mode: 0o600 });
    await expect(
      runCapture(config, { env: {}, signal: new AbortController().signal }),
    ).rejects.toThrow('capture_state');
  });
});

it('classifies actual kubectl HTTP 410 diagnostic without exposing private stderr', async () => {
  const { root, config } = await fixture();
  const executable = join(root, 'expired-kubectl');
  await writeFile(
    executable,
    `#!${await realpath(process.execPath)}\nprocess.stderr.write('Error from server (Gone): private discarded resource version');\nprocess.exitCode = 1;\n`,
    { mode: 0o700 },
  );
  await expect(
    (async () => {
      for await (const _raw of createTransport({ ...config, kubectlPath: executable }, {}).watch(
        'opaque',
        new AbortController().signal,
      )) {
        /* consume */
      }
    })(),
  ).rejects.toThrow('capture_cursor_expired');
});

it('admits one capture owner per journal and preserves unsealed shutdown uncertainty', async () => {
  const { config, directory } = await fixture();
  const stop = new AbortController();
  let ready: (() => void) | undefined;
  const watching = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const running = runCapture(config, {
    env: {},
    signal: stop.signal,
    fetcher: async () => {
      throw new Error('offline');
    },
    transport: {
      list: async () => list(),
      async *watch(_cursor, signal) {
        ready?.();
        await sleep(30000, signal);
        yield null;
      },
    },
  });
  await watching;
  await expect(
    runCapture(config, { env: {}, signal: new AbortController().signal }),
  ).rejects.toThrow('journal_locked');
  stop.abort();
  await running;
  const checkpoint = JSON.parse(await readFile(join(directory, 'capture-state.json'), 'utf8'));
  expect(checkpoint.cursor).toBe('list-rv');
  const summary = await statusJournal(directory);
  expect(summary.entries).toBe(1);
});

it('rejects CLI duplicate/unknown flags before touching config', async () => {
  for (const args of [
    [],
    ['--unknown'],
    ['--config', '/private/config', '--config', '/private/config'],
  ])
    await expect(runCli(args)).rejects.toThrow('capture_arguments');
});

it('keeps acquisition alive while another sender owns a long manual drain', async () => {
  const { config, directory } = await fixture();
  const stop = new AbortController();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => {};
  const owned = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const manual = locked(
    directory,
    async () => {
      ready();
      await held;
    },
    'sender',
  );
  await owned;
  let busy: () => void = () => {};
  const senderBusy = new Promise<void>((resolve) => {
    busy = resolve;
  });
  let requests = 0;
  try {
    const result = await runCapture(config, {
      env: {},
      signal: stop.signal,
      fetcher: async () => {
        requests++;
        return new Response('', { status: 202 });
      },
      progress(value) {
        if (value.delivery === 'sender_busy') busy();
      },
      transport: {
        list: async () => list(),
        async *watch(_cursor, signal) {
          await Promise.race([senderBusy, sleep(1000, signal)]);
          yield { type: 'MODIFIED', object: application('new-terminal', 'Succeeded') };
          stop.abort();
        },
      },
    });
    expect(result.delivery).toBe('sender_busy');
    expect(result.captured).toBe(2);
    expect(requests).toBe(0);
    expect(await statusJournal(directory)).toMatchObject({ entries: 2, acknowledgedRecords: 0 });
  } finally {
    stop.abort();
    release();
    await manual;
  }
});

it('bounds seals across 125 clean watch rollovers and flushes hourly while persisting conservative gaps', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { config, directory } = await fixture();
    const stop = new AbortController();
    let watches = 0;
    await runCapture(config, {
      env: {},
      signal: stop.signal,
      fetcher: async () => new Response('', { status: 503 }),
      sleep: async (milliseconds, signal) => {
        if (milliseconds >= 1000) await sleep(60000, signal);
        else vi.setSystemTime(Date.now() + milliseconds);
      },
      transport: {
        list: async () => list(),
        async *watch() {
          yield* [];
          watches++;
          vi.setSystemTime(Date.now() + 30000);
          if (watches === 125) stop.abort();
        },
      },
    });
    expect(watches).toBe(125);
    expect((await statusJournal(directory)).seals).toBe(1);
    const state = JSON.parse(await readFile(join(directory, 'capture-state.json'), 'utf8'));
    expect(state.interruptions.length).toBeGreaterThan(0);
    expect(state.interruptions.length).toBeLessThanOrEqual(32);
  } finally {
    vi.useRealTimers();
  }
});

it('retains pending observation across writer contention longer than old 200ms budget', async () => {
  const { config, directory } = await fixture();
  const stop = new AbortController();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => {};
  const owned = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let writer: Promise<void> | undefined;
  let releaseSender: () => void = () => {};
  const senderHeld = new Promise<void>((resolve) => {
    releaseSender = resolve;
  });
  let senderReady: () => void = () => {};
  const senderOwned = new Promise<void>((resolve) => {
    senderReady = resolve;
  });
  const sender = locked(
    directory,
    async () => {
      senderReady();
      await senderHeld;
    },
    'sender',
  );
  await senderOwned;
  try {
    const result = await runCapture(config, {
      env: {},
      signal: stop.signal,
      fetcher: async () => new Response('', { status: 503 }),
      transport: {
        list: async () => list(),
        async *watch() {
          writer = locked(directory, async () => {
            ready();
            await held;
          });
          await owned;
          setTimeout(release, 3000);
          yield { type: 'MODIFIED', object: application('after-contention', 'Succeeded') };
          stop.abort();
        },
      },
    });
    expect(result.captured).toBe(2);
    expect(JSON.parse(await readFile(join(directory, 'capture-state.json'), 'utf8')).cursor).toBe(
      'after-contention',
    );
  } finally {
    stop.abort();
    release();
    await writer;
    releaseSender();
    await sender;
  }
}, 10000);

it('reconnects transient Kubernetes Status errors without advancing absent observation', async () => {
  const { config, directory } = await fixture();
  const stop = new AbortController();
  let watches = 0;
  const result = await runCapture(config, {
    env: {},
    signal: stop.signal,
    fetcher: async () => new Response('', { status: 503 }),
    transport: {
      list: async () => list(),
      async *watch() {
        watches++;
        if (watches === 1)
          yield {
            type: 'ERROR',
            object: { apiVersion: 'v1', kind: 'Status', status: 'Failure', code: 503 },
          };
        else {
          yield { type: 'MODIFIED', object: application('after-server-error', 'Succeeded') };
          stop.abort();
        }
      },
    },
  });
  expect(watches).toBe(2);
  expect(result.captured).toBe(2);
  expect(JSON.parse(await readFile(join(directory, 'capture-state.json'), 'utf8')).cursor).toBe(
    'after-server-error',
  );
});

it.each([
  ['format', 'journal_token'],
  ['permissions', 'journal_private_file'],
  ['missing', 'journal_credential_unavailable'],
])(
  'credential rotation %s failure stops delivery but keeps acquisition alive',
  async (fault, code) => {
    const { config, directory } = await fixture();
    const stop = new AbortController();
    let sent: () => void = () => {};
    const firstFailure = new Promise<void>((resolve) => {
      sent = resolve;
    });
    let unavailable: () => void = () => {};
    const observedFailure = new Promise<void>((resolve) => {
      unavailable = resolve;
    });
    let captured = 0;
    let delivery: string | null = null;
    try {
      await runCapture(config, {
        env: {},
        signal: stop.signal,
        fetcher: async () => new Response('', { status: 503 }),
        progress(value) {
          captured = value.captured;
          delivery = value.delivery;
          if (value.delivery === 'receiver_503') sent();
          if (value.delivery === code) unavailable();
        },
        transport: {
          list: async () => list(),
          async *watch(_cursor, signal) {
            await Promise.race([firstFailure, sleep(8000, signal)]);
            if (signal.aborted) return;
            if (fault === 'format')
              await writeFile(config.receiver.tokenFile, 'incomplete-rotation', { mode: 0o600 });
            else if (fault === 'permissions') await chmod(config.receiver.tokenFile, 0o644);
            else await rm(config.receiver.tokenFile);
            await Promise.race([observedFailure, sleep(8000, signal)]);
            yield {
              type: 'MODIFIED',
              object: application('captured-during-rotation', 'Succeeded'),
            };
            stop.abort();
          },
        },
      });
      expect(captured).toBe(2);
      expect(delivery).toBe(code);
      expect(await statusJournal(directory)).toMatchObject({ entries: 2, acknowledgedRecords: 0 });
    } finally {
      stop.abort();
    }
  },
  12000,
);

it('coalesces overflow of 32 disjoint rollover gaps without dropping uncertainty', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { config, directory } = await fixture();
    const stop = new AbortController();
    let watches = 0;
    await runCapture(config, {
      env: {},
      signal: stop.signal,
      fetcher: async () => new Response('', { status: 503 }),
      sleep: async (milliseconds, signal) => {
        if (milliseconds >= 1000) await sleep(60000, signal);
        else vi.setSystemTime(Date.now() + milliseconds);
      },
      transport: {
        list: async () => list(),
        async *watch() {
          watches++;
          vi.setSystemTime(Date.now() + 30000);
          yield {
            type: 'BOOKMARK',
            object: { metadata: { resourceVersion: `bookmark-${watches}` } },
          };
          vi.setSystemTime(Date.now() + 100);
          if (watches === 35) stop.abort();
        },
      },
    });
    expect(await statusJournal(directory)).toMatchObject({ seals: 0, retainedRecords: 1 });
    const state = JSON.parse(await readFile(join(directory, 'capture-state.json'), 'utf8'));
    expect(state.interruptions.length).toBe(2);
    expect(state.interruptions[0].reason).toBe('capture_uncertainty');
    expect(
      Date.parse(state.interruptions[0].end) - Date.parse(state.interruptions[0].start),
    ).toBeGreaterThan(30 * 30000);
  } finally {
    vi.useRealTimers();
  }
});

it.each(['list', 'watch'])(
  '200 consecutive %s failures coalesce rather than exhausting journal',
  async (mode) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { config, directory } = await fixture();
      const stop = new AbortController();
      let failures = 0;
      const failed = () => {
        failures++;
        if (failures > 200) stop.abort();
        throw new Error('capture_transport');
      };
      await runCapture(config, {
        env: {},
        signal: stop.signal,
        fetcher: async () => new Response('', { status: 503 }),
        deliverySleep: sleep,
        sleep: async (milliseconds) => {
          vi.setSystemTime(Date.now() + milliseconds);
        },
        transport: {
          list: async () => (mode === 'list' ? failed() : list()),
          async *watch() {
            yield* [];
            failed();
          },
        },
      });
      const summary = await statusJournal(directory);
      expect(failures).toBe(201);
      expect(summary.seals).toBeLessThanOrEqual(3);
      expect(summary.retainedRecords).toBeLessThanOrEqual(4);
      const state = JSON.parse(await readFile(join(directory, 'capture-state.json'), 'utf8'));
      expect(state.interruptions).toHaveLength(1);
      expect(state.interruptions[0].reason).toBe('acquisition_unavailable');
    } finally {
      vi.useRealTimers();
    }
  },
  20000,
);

it('normal shutdown while waiting for startup writer lock returns clean progress and releases capture ownership', async () => {
  const { config, directory } = await fixture();
  const stop = new AbortController();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => {};
  const owned = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const writer = locked(directory, async () => {
    ready();
    await held;
  });
  await owned;
  try {
    const running = runCapture(config, {
      env: {},
      signal: stop.signal,
      transport: {
        list: async () => list(),
        async *watch() {
          yield* [];
        },
      },
    });
    setTimeout(() => stop.abort(), 100);
    expect(await running).toEqual({
      captured: 0,
      bookmarks: 0,
      seals: 0,
      delivery: null,
      acquisition: null,
    });
    await locked(directory, async () => {}, 'capture');
  } finally {
    stop.abort();
    release();
    await writer;
  }
});

it('normal shutdown never conceals concurrent fatal sender journal corruption', async () => {
  const { config, directory } = await fixture();
  const stop = new AbortController();
  let started: () => void = () => {};
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let abortAtSeal = false;
  try {
    await expect(
      runCapture(config, {
        env: {},
        signal: stop.signal,
        now: () => {
          if (abortAtSeal) {
            stop.abort();
            release();
          }
          return new Date(Date.now() + (abortAtSeal ? 3600001 : 0));
        },
        sleep: async (_milliseconds, signal) => {
          if (signal.aborted) return;
          await sending;
          abortAtSeal = true;
        },
        fetcher: async () => {
          started();
          await released;
          await writeFile(join(directory, 'records', '0000000001.json'), '{"corrupt":true}', {
            mode: 0o600,
          });
          return new Response('', { status: 202 });
        },
        transport: {
          list: async () => list(),
          async *watch() {
            yield* [];
            throw new Error('capture_transport');
          },
        },
      }),
    ).rejects.toThrow('journal_corrupt');
  } finally {
    stop.abort();
    release();
  }
});

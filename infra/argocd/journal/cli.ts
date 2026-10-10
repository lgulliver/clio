import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  appendJournal,
  captureJournal,
  drainJournal,
  initJournal,
  sealJournal,
  statusJournal,
} from './journal.ts';
import { fail, integer, object, string } from './storage.ts';

export const help = `Clio durable Argo journal (local operator tool)
Usage: node infra/argocd/journal/cli.ts COMMAND --directory /absolute/private/journal [options]
  init --source UUID --producer UUID --journal UUID --policy REF
       [--fictional] [--startup-at UTC] [--max-records N] [--max-bytes N]
  append --input /local/native-notification.json --evidence-ref REF [--captured-at UTC]
  capture --input /local/original.json --format application|notification --evidence-ref REF
  seal --start UTC --end UTC --evidence-ref REF [--last-sequence N] [--interruptions /local/intervals.json]
  drain --base-url http://127.0.0.1:3001|https://trusted-host --token-file /private/token [--max-attempts N] [--max-wait-ms N]
  status
  help
Append --captured-at and init --startup-at require fictional mode. Capture always uses current local clock.
No provider fetch. Keep directory and token outside Git; directory 0700, token 0600.
Drain retains acknowledged files; pending records remain resumable. Coverage remains incomplete.
Linux /proc required for crash-safe PID/start-time/boot-ID lock; unavailable identity fails closed.
`;
const allowed: Record<string, readonly string[]> = {
  init: [
    'source',
    'producer',
    'journal',
    'policy',
    'fictional',
    'startup-at',
    'max-records',
    'max-bytes',
  ],
  append: ['input', 'evidence-ref', 'captured-at'],
  capture: ['input', 'format', 'evidence-ref'],
  seal: ['start', 'end', 'evidence-ref', 'last-sequence', 'interruptions'],
  drain: ['base-url', 'token-file', 'max-attempts', 'max-wait-ms'],
  status: [],
};
async function readInput(path: string, limit = 65536): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) fail('journal_input_size');
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > limit) fail('journal_input_size');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
  } finally {
    await file.close();
  }
}
export async function runCli(args: string[]): Promise<unknown> {
  const command = args[0];
  if (!command || command === 'help' || command === '--help') return help;
  const keys = allowed[command];
  if (!keys) fail('journal_command');
  const flags = new Map<string, string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith('--')) fail('journal_arguments');
    const key = flag.slice(2);
    if (flags.has(key) || (key !== 'directory' && !keys.includes(key))) fail('journal_arguments');
    if (key === 'fictional') {
      flags.set(key, 'true');
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) fail('journal_arguments');
    flags.set(key, value);
  }
  const required = (key: string) => {
    const value = flags.get(key);
    if (!value) fail('journal_arguments');
    return value;
  };
  const number = (key: string, defaultValue: number, min: number, max: number) =>
    integer(flags.has(key) ? Number(required(key)) : defaultValue, min, max);
  const directory = required('directory');
  switch (command) {
    case 'init':
      await initJournal(directory, {
        sourceId: required('source'),
        producerId: required('producer'),
        journalId: required('journal'),
        policyReference: required('policy'),
        fictional: flags.has('fictional'),
        ...(flags.has('startup-at') ? { startupAt: required('startup-at') } : {}),
        maxRecords: number('max-records', 5000, 1, 5000),
        maxBytes: number('max-bytes', 8388608, 1, 8388608),
      });
      return statusJournal(directory);
    case 'append':
      await appendJournal(directory, {
        notification: await readInput(required('input')),
        evidenceRef: required('evidence-ref'),
        ...(flags.has('captured-at') ? { capturedAt: required('captured-at') } : {}),
      });
      return statusJournal(directory);
    case 'capture': {
      const format = required('format');
      if (format !== 'application' && format !== 'notification') fail('journal_arguments');
      await captureJournal(directory, {
        input: await readInput(required('input')),
        format,
        evidenceRef: required('evidence-ref'),
      });
      return statusJournal(directory);
    }
    case 'seal': {
      const input = flags.has('interruptions') ? await readInput(required('interruptions')) : [];
      if (!Array.isArray(input)) fail('journal_arguments');
      const interruptions = input.map((value: unknown) => {
        const row = object(value);
        if (Object.keys(row).sort().join(',') !== 'end,reason,start') fail('journal_arguments');
        return { start: string(row.start), end: string(row.end), reason: string(row.reason) };
      });
      await sealJournal(directory, {
        start: required('start'),
        end: required('end'),
        evidenceRef: required('evidence-ref'),
        interruptions,
        ...(flags.has('last-sequence')
          ? { lastSequence: number('last-sequence', 0, 0, 5000) }
          : {}),
      });
      return statusJournal(directory);
    }
    case 'drain':
      return drainJournal(directory, {
        baseUrl: required('base-url'),
        tokenFile: required('token-file'),
        maxAttempts: number('max-attempts', 15, 1, 100),
        maxWaitMs: number('max-wait-ms', 60000, 0, 60000),
      });
    case 'status':
      return statusJournal(directory);
    default:
      return fail('journal_command');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runCli(process.argv.slice(2));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    if (
      typeof result === 'object' &&
      result !== null &&
      'pendingRecords' in result &&
      typeof result.pendingRecords === 'number' &&
      result.pendingRecords > 0 &&
      process.argv[2] === 'drain'
    )
      process.exitCode = 2;
  } catch (error) {
    // Input, network and filesystem errors may contain private payloads/tokens/paths.
    console.error(
      error instanceof Error && /^(?:journal_[a-z_]+|invalid_argo_archive)$/.test(error.message)
        ? error.message
        : 'journal_command_failed: check private paths, journal integrity, endpoint and resumable status',
    );
    process.exitCode = 1;
  }
}

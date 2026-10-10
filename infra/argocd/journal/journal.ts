import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ArchiveEntry,
  type ArchiveRecord,
  type ArchiveSeal,
  archiveRecordDigest,
  parseArchiveRecord,
} from '../../../packages/adapters/src/argo-archive.ts';
import { applicationNotification } from './application.ts';
import {
  atomicState,
  createPrivateDirectory,
  fail,
  instant,
  integer,
  locked,
  object,
  outsideGit,
  privateDirectory,
  readPrivate,
  string,
  syncDirectory,
  writeExclusive,
} from './storage.ts';

const zero = '0'.repeat(64);
const transportLimit = 65536;
export interface JournalOptions {
  sourceId: string;
  producerId: string;
  journalId: string;
  policyReference: string;
  fictional?: boolean;
  startupAt?: string;
  maxRecords?: number;
  maxBytes?: number;
}
interface Config {
  sourceId: string;
  producerId: string;
  journalId: string;
  policyReference: string;
  fictional: boolean;
  startupAt: string;
  maxRecords: number;
  maxBytes: number;
}
interface State {
  retainedRecords: number;
  acknowledgedRecords: number;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
}
interface Loaded {
  config: Config;
  state: State;
  records: { record: ArchiveRecord; body: string }[];
  bytes: number;
}
function common(config: Config) {
  return {
    contract: 'clio.argocd.archive.v1',
    source_id: config.sourceId,
    producer_id: config.producerId,
    journal_id: config.journalId,
    policy_reference: config.policyReference,
    startup_at: config.startupAt,
  };
}
function envelope(value: unknown): ArchiveRecord {
  const result = parseArchiveRecord({ ...object(value), digest: archiveRecordDigest(value) });
  if (Buffer.byteLength(JSON.stringify(result)) > transportLimit) fail('journal_envelope_size');
  return result;
}
function configFrom(value: unknown): Config {
  const row = object(value);
  if (
    Object.keys(row).sort().join(',') !==
      'fictional,journalId,maxBytes,maxRecords,policyReference,producerId,sourceId,startupAt' ||
    typeof row.fictional !== 'boolean'
  )
    fail('journal_corrupt');
  const config = {
    sourceId: string(row.sourceId),
    producerId: string(row.producerId),
    journalId: string(row.journalId),
    policyReference: string(row.policyReference),
    fictional: row.fictional,
    startupAt: string(row.startupAt),
    maxRecords: integer(row.maxRecords, 1, 5000),
    maxBytes: integer(row.maxBytes, 1, 8 * 1024 * 1024),
  };
  // Validate shared identifiers, timestamp, policy and strict wire fields without native eligibility.
  envelope({
    ...common(config),
    kind: 'entry',
    sequence: 1,
    previous_digest: zero,
    captured_at: config.startupAt,
    evidence_ref: 'urn:clio:journal:configuration',
    notification: null,
  });
  return config;
}
function stateFrom(value: unknown): State {
  const row = object(value);
  if (
    Object.keys(row).sort().join(',') !==
    'acknowledgedRecords,attempts,lastAttemptAt,nextAttemptAt,retainedRecords'
  )
    fail('journal_corrupt');
  const lastAttemptAt = row.lastAttemptAt === null ? null : string(row.lastAttemptAt);
  if (lastAttemptAt !== null) instant(lastAttemptAt);
  const nextAttemptAt = row.nextAttemptAt === null ? null : string(row.nextAttemptAt);
  if (nextAttemptAt !== null) instant(nextAttemptAt);
  return {
    retainedRecords: integer(row.retainedRecords, 0, 5000),
    acknowledgedRecords: integer(row.acknowledgedRecords, 0, 5000),
    attempts: integer(row.attempts, 0, Number.MAX_SAFE_INTEGER),
    lastAttemptAt,
    nextAttemptAt,
  };
}
function fileName(index: number): string {
  return `${String(index).padStart(10, '0')}.json`;
}
function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return fail('journal_corrupt');
  }
}
function verify(loaded: Loaded): void {
  let sequence = 0;
  let digest = zero;
  let capture = instant(loaded.config.startupAt);
  let sealedLast = 0;
  let sealedEnd = instant(loaded.config.startupAt);
  const entries: ArchiveEntry[] = [];
  const sealIds = new Set<string>();
  for (const { record } of loaded.records) {
    for (const [key, value] of Object.entries(common(loaded.config))) {
      if (object(record)[key] !== value) fail('journal_corrupt');
    }
    if (record.kind === 'entry') {
      const at = instant(record.captured_at);
      if (
        record.sequence !== sequence + 1 ||
        record.previous_digest !== digest ||
        at < capture ||
        at < sealedEnd
      )
        fail('journal_chronology');
      sequence = record.sequence;
      digest = record.digest;
      capture = at;
      entries.push(record);
    } else {
      const start = instant(record.start);
      const end = instant(record.end);
      if (
        sealIds.has(record.seal_id) ||
        start < sealedEnd ||
        end <= start ||
        record.first_sequence !== sealedLast + 1 ||
        record.last_sequence > sequence ||
        record.last_sequence < sealedLast ||
        record.entry_count !== record.last_sequence - sealedLast
      )
        fail('journal_seal_bounds');
      const previous = entries[record.last_sequence - 1];
      if (record.last_digest !== (previous?.digest ?? zero)) fail('journal_seal_bounds');
      for (const entry of entries.slice(sealedLast, record.last_sequence)) {
        const time = instant(entry.captured_at);
        if (time < start || time >= end) fail('journal_seal_bounds');
      }
      const next = entries[record.last_sequence];
      if (next && instant(next.captured_at) < end) fail('journal_seal_bounds');
      let lastInterruption = start;
      for (const interruption of record.interruptions) {
        const from = instant(interruption.start);
        const until = instant(interruption.end);
        if (from < lastInterruption || until > end || until <= from) fail('journal_seal_bounds');
        lastInterruption = until;
      }
      sealedLast = record.last_sequence;
      sealedEnd = end;
      sealIds.add(record.seal_id);
    }
  }
  if (
    loaded.state.retainedRecords > loaded.records.length ||
    loaded.state.acknowledgedRecords > loaded.state.retainedRecords
  )
    fail('journal_corrupt');
}
async function load(directory: string): Promise<Loaded> {
  const config = configFrom(json(await readPrivate(join(directory, 'config.json'), 4096)));
  const state = stateFrom(json(await readPrivate(join(directory, 'state.json'), 4096)));
  const recordsDirectory = join(directory, 'records');
  await privateDirectory(recordsDirectory);
  const names = (await readdir(recordsDirectory)).sort();
  if (names.length > config.maxRecords) fail('journal_capacity');
  const records: Loaded['records'] = [];
  let bytes = 0;
  for (const [index, name] of names.entries()) {
    if (name !== fileName(index + 1)) fail('journal_corrupt');
    const body = await readPrivate(
      join(recordsDirectory, name),
      transportLimit,
      index >= state.retainedRecords,
    );
    bytes += Buffer.byteLength(body);
    if (bytes > config.maxBytes) fail('journal_capacity');
    let record: ArchiveRecord;
    try {
      record = parseArchiveRecord(json(body));
      if (body !== JSON.stringify(record)) fail('journal_corrupt');
    } catch {
      return fail('journal_corrupt');
    }
    records.push({ record, body });
  }
  // A process may die before directory fsync, leaving valid bytes but no checkpoint.
  // Reflush that recovered tail before any new checkpoint or outbound delivery.
  if (records.length > state.retainedRecords) await syncDirectory(recordsDirectory);
  const loaded = { config, state, records, bytes };
  verify(loaded);
  return loaded;
}
export async function initJournal(directory: string, options: JournalOptions): Promise<void> {
  const config = configFrom({
    ...options,
    fictional: options.fictional ?? false,
    startupAt: options.startupAt ?? new Date().toISOString(),
    maxRecords: options.maxRecords ?? 5000,
    maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
  });
  if (!config.fictional && options.startupAt !== undefined) fail('journal_capture_clock');
  if (instant(config.startupAt) > instant(new Date().toISOString())) fail('journal_chronology');
  await createPrivateDirectory(directory);
  await locked(directory, async () => {
    await createPrivateDirectory(join(directory, 'records'));
    await writeExclusive(join(directory, 'config.json'), JSON.stringify(config));
    await writeExclusive(
      join(directory, 'state.json'),
      JSON.stringify({
        retainedRecords: 0,
        acknowledgedRecords: 0,
        attempts: 0,
        lastAttemptAt: null,
        nextAttemptAt: null,
      }),
    );
  });
}
async function persist(directory: string, loaded: Loaded, record: ArchiveRecord): Promise<void> {
  const body = JSON.stringify(record);
  const next: Loaded = { ...loaded, records: [...loaded.records, { record, body }] };
  verify(next);
  if (
    next.records.length > loaded.config.maxRecords ||
    loaded.bytes + Buffer.byteLength(body) > loaded.config.maxBytes
  )
    fail('journal_capacity');
  // Exclusive immutable file and directory fsync precede both state checkpoint and HTTP.
  await writeExclusive(join(directory, 'records', fileName(next.records.length)), body);
  await atomicState(directory, { ...loaded.state, retainedRecords: next.records.length });
}
export interface AppendOptions {
  notification: unknown;
  evidenceRef: string;
  capturedAt?: string;
}
function makeEntry(loaded: Loaded, options: AppendOptions, capturedAt: string): ArchiveEntry {
  if (instant(capturedAt) < instant(loaded.config.startupAt)) fail('journal_chronology');
  const entries = loaded.records.filter(({ record }) => record.kind === 'entry');
  const last = entries.at(-1)?.record;
  const record = envelope({
    ...common(loaded.config),
    kind: 'entry',
    sequence: entries.length + 1,
    previous_digest: last?.digest ?? zero,
    captured_at: capturedAt,
    evidence_ref: options.evidenceRef,
    notification: options.notification,
  });
  if (record.kind !== 'entry') fail('journal_corrupt');
  return record;
}
export async function appendJournal(
  directory: string,
  options: AppendOptions,
): Promise<ArchiveEntry> {
  return locked(directory, async () => {
    const loaded = await load(directory);
    if (options.capturedAt !== undefined && !loaded.config.fictional) fail('journal_capture_clock');
    const capturedAt = options.capturedAt ?? new Date().toISOString();
    if (instant(capturedAt) > instant(new Date().toISOString())) fail('journal_chronology');
    const record = makeEntry(loaded, options, capturedAt);
    await persist(directory, loaded, record);
    return record;
  });
}
export interface CaptureOptions {
  input: unknown;
  format: 'application' | 'notification';
  evidenceRef: string;
  deduplicate?: boolean;
}
export async function captureJournal(
  directory: string,
  options: CaptureOptions,
): Promise<ArchiveEntry> {
  // Capture clock fixed before waiting for the writer lock. A backward clock/late writer conflicts.
  const capturedAt = new Date().toISOString();
  return locked(directory, async () => {
    const loaded = await load(directory);
    const notification =
      options.format === 'application' ? applicationNotification(options.input) : options.input;
    const record = makeEntry(
      loaded,
      { notification, evidenceRef: options.evidenceRef },
      capturedAt,
    );
    if (options.deduplicate) {
      const digest = archiveRecordDigest({ notification: record.notification });
      // Seals do not change the latest observation; earlier matching states are transitions.
      const retained = loaded.records.findLast(
        ({ record: prior }) => prior.kind === 'entry',
      )?.record;
      if (
        retained?.kind === 'entry' &&
        archiveRecordDigest({ notification: retained.notification }) === digest
      )
        return retained;
    }
    await persist(directory, loaded, record);
    return record;
  });
}
export interface SealOptions {
  start: string;
  end: string;
  evidenceRef: string;
  interruptions?: { start: string; end: string; reason: string }[];
  lastSequence?: number;
}
export async function sealJournal(directory: string, options: SealOptions): Promise<ArchiveSeal> {
  return locked(directory, async () => {
    const loaded = await load(directory);
    const entries = loaded.records
      .map(({ record }) => record)
      .filter((record) => record.kind === 'entry');
    const prior = loaded.records
      .map(({ record }) => record)
      .filter((record) => record.kind === 'seal')
      .at(-1);
    const lastSequence = options.lastSequence ?? entries.length;
    if (instant(options.end) > instant(new Date().toISOString())) fail('journal_seal_bounds');
    const record = envelope({
      ...common(loaded.config),
      kind: 'seal',
      seal_id: randomUUID(),
      start: options.start,
      end: options.end,
      first_sequence: (prior?.last_sequence ?? 0) + 1,
      last_sequence: lastSequence,
      entry_count: lastSequence - (prior?.last_sequence ?? 0),
      last_digest: entries[lastSequence - 1]?.digest ?? zero,
      interruptions: options.interruptions ?? [],
      evidence_ref: options.evidenceRef,
    });
    if (record.kind !== 'seal') fail('journal_corrupt');
    await persist(directory, loaded, record);
    return record;
  });
}
function summary(loaded: Loaded) {
  const entries = loaded.records
    .map(({ record }) => record)
    .filter((record) => record.kind === 'entry');
  const seals = loaded.records
    .map(({ record }) => record)
    .filter((record) => record.kind === 'seal');
  return {
    sourceId: loaded.config.sourceId,
    producerId: loaded.config.producerId,
    journalId: loaded.config.journalId,
    policyReference: loaded.config.policyReference,
    fictional: loaded.config.fictional,
    startupAt: loaded.config.startupAt,
    entries: entries.length,
    seals: seals.length,
    retainedRecords: loaded.records.length,
    acknowledgedRecords: loaded.state.acknowledgedRecords,
    lastAcknowledgedSequence: loaded.records
      .slice(0, loaded.state.acknowledgedRecords)
      .filter(({ record }) => record.kind === 'entry').length,
    pendingRecords: loaded.records.length - loaded.state.acknowledgedRecords,
    remainingRecords: loaded.config.maxRecords - loaded.records.length,
    remainingBytes: loaded.config.maxBytes - loaded.bytes,
    lastSealedInterval: seals.at(-1)
      ? { start: seals.at(-1)?.start, end: seals.at(-1)?.end }
      : null,
  };
}
export async function statusJournal(directory: string) {
  return locked(directory, async () => summary(await load(directory)));
}
export interface DrainOptions {
  baseUrl: string;
  tokenFile: string;
  maxAttempts?: number;
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxWaitMs?: number;
}
function endpoint(baseUrl: string, config: Config): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return fail('journal_endpoint');
  }
  if (
    baseUrl.includes('?') ||
    baseUrl.includes('#') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
    )
  )
    fail('journal_endpoint');
  url.pathname = `/api/argo/sources/${config.sourceId}/archives/${config.producerId}`;
  return url;
}
function retryDelay(response: Response | null, attempt: number, random: () => number): number {
  const header = response?.headers.get('retry-after');
  let minimum = 0;
  if (header !== null && header !== undefined) {
    const now = Date.now();
    const candidate = /^\d+$/.test(header)
      ? Number(header) * 1000
      : Math.max(0, Date.parse(header) - now);
    // Receiver data must not overflow Date or our four-digit UTC checkpoint format.
    // Reserve one run's wait budget at the calendar boundary for checkpoint work.
    const latestDeadline = Date.parse('9999-12-31T23:59:59.999Z') - 60000;
    if (Number.isSafeInteger(candidate) && candidate >= 0 && now + candidate <= latestDeadline)
      minimum = Math.min(candidate, 86400000);
    // Malformed/unrepresentable cooldowns use the existing bounded backoff.
  }
  const jitter = random();
  if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) fail('journal_retry_jitter');
  return Math.max(
    minimum,
    Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5)) + Math.floor(jitter * 1000),
  );
}
/** Credential faults are recoverable delivery failures, separate from journal corruption. */
export class JournalCredentialError extends Error {}
export async function drainJournal(directory: string, options: DrainOptions) {
  const maxAttempts = integer(options.maxAttempts ?? 15, 1, 100);
  const maxWaitMs = integer(options.maxWaitMs ?? 60000, 0, 60000);
  const env = options.env ?? process.env;
  if (Object.entries(env).some(([key, value]) => /^(?:https?|all|no)_proxy$/i.test(key) && value))
    fail('journal_proxy_environment');
  const tokenText = await (async () => {
    await outsideGit(options.tokenFile);
    return readPrivate(options.tokenFile, 4096);
  })().catch((error: unknown) => {
    const code =
      error instanceof Error && /^journal_[a-z_]+$/.test(error.message)
        ? error.message
        : 'journal_credential_unavailable';
    throw new JournalCredentialError(code);
  });
  if (!/^[0-9a-f]{64}\n?$/.test(tokenText)) throw new JournalCredentialError('journal_token');
  const token = tokenText.trim();
  return locked(
    directory,
    async () => {
      const fetcher = options.fetcher ?? fetch;
      const sleep =
        options.sleep ??
        ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
      let attempts = 0;
      let consecutiveFailures = 0;
      let reason: string | null = null;
      let waitedUntil: string | null = null;
      // Sender ownership spans the run; writer ownership spans only durable transactions.
      while (attempts < maxAttempts) {
        const selected = await locked(directory, async () => {
          const loaded = await load(directory);
          const url = endpoint(options.baseUrl, loaded.config);
          const index = loaded.state.acknowledgedRecords;
          const current = loaded.records[index];
          if (!current) return { kind: 'done' as const };
          const delay =
            loaded.state.nextAttemptAt === null
              ? 0
              : Math.max(0, Date.parse(loaded.state.nextAttemptAt) - Date.now());
          if (delay > maxWaitMs) return { kind: 'budget' as const };
          if (delay && waitedUntil !== loaded.state.nextAttemptAt)
            return { kind: 'wait' as const, delay, until: loaded.state.nextAttemptAt };
          await atomicState(directory, {
            ...loaded.state,
            retainedRecords: loaded.records.length,
            attempts: integer(loaded.state.attempts + 1, 1, Number.MAX_SAFE_INTEGER),
            lastAttemptAt: new Date().toISOString(),
            nextAttemptAt: new Date(Date.now() + 4000).toISOString(),
          });
          return { kind: 'send' as const, index, body: current.body, url };
        });
        if (selected.kind === 'done') break;
        if (selected.kind === 'budget') {
          reason = 'retry_wait_exceeds_run_budget';
          break;
        }
        if (selected.kind === 'wait') {
          await sleep(selected.delay);
          waitedUntil = selected.until;
          continue;
        }
        waitedUntil = null;
        attempts += 1;
        let response: Response | null = null;
        try {
          response = await fetcher(selected.url, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: selected.body,
          });
        } catch {
          reason = 'transport_failed';
        }
        const accepted = response?.status === 202;
        const retryable =
          response === null ||
          response.status === 429 ||
          response.status === 408 ||
          response.status >= 500;
        if (response) reason = accepted ? null : `receiver_${response.status}`;
        await response?.body?.cancel().catch(() => undefined);
        if (accepted) consecutiveFailures = 0;
        else if (retryable) consecutiveFailures += 1;
        const delay =
          !accepted && retryable
            ? Math.max(
                4000,
                retryDelay(response, consecutiveFailures, options.random ?? Math.random),
              )
            : null;
        await locked(directory, async () => {
          const loaded = await load(directory);
          // Appends/seals can change the tail, never the selected immutable index/body.
          if (
            loaded.state.acknowledgedRecords !== selected.index ||
            loaded.records[selected.index]?.body !== selected.body
          )
            fail('journal_corrupt');
          await atomicState(directory, {
            ...loaded.state,
            retainedRecords: loaded.records.length,
            acknowledgedRecords: selected.index + (accepted ? 1 : 0),
            nextAttemptAt:
              !accepted && !retryable
                ? loaded.state.nextAttemptAt
                : new Date(
                    Math.max(
                      loaded.state.nextAttemptAt === null
                        ? 0
                        : Date.parse(loaded.state.nextAttemptAt),
                      Date.now() + (delay ?? 4000),
                    ),
                  ).toISOString(),
          });
        });
        if (!accepted && !retryable) break;
      }
      return {
        ...(await locked(directory, async () => {
          const loaded = await load(directory);
          return { ...summary(loaded), nextAttemptAt: loaded.state.nextAttemptAt };
        })),
        attemptsThisRun: attempts,
        stoppedReason: reason,
      };
    },
    'sender',
  );
}

import { join } from 'node:path';
import {
  type ArchiveSeal,
  parseArchiveRecord,
} from '../../../packages/adapters/src/argo-archive.ts';
import {
  captureJournal,
  drainJournal,
  JournalCredentialError,
  sealJournal,
  statusJournal,
} from '../journal/journal.ts';
import { atomicState, instant, isMissing, locked, readPrivate } from '../journal/storage.ts';
import { type CaptureConfig, exact, fail, fingerprint, text, validateConfig } from './config.ts';
import { cursor, parseList, parseWatchEvent, validateApplication } from './parser.ts';
import { type CaptureTransport, createTransport } from './transport.ts';

interface State {
  binding: string;
  cursor: string | null;
  lastContact: string;
  periodStart: string;
  lastSequence: number;
  lastDigest: string | null;
  interruptions: ArchiveSeal['interruptions'];
}
function parseState(value: unknown, binding: string): State {
  const row = exact(value, [
    'binding',
    'cursor',
    'lastContact',
    'periodStart',
    'lastSequence',
    'lastDigest',
    'interruptions',
  ]);
  if (
    row.binding !== binding ||
    typeof row.lastSequence !== 'number' ||
    !Number.isSafeInteger(row.lastSequence) ||
    row.lastSequence < 0 ||
    row.lastSequence > 5000
  )
    fail('capture_state');
  const lastContact = text(row.lastContact),
    periodStart = text(row.periodStart);
  if (instant(lastContact) < instant(periodStart)) fail('capture_state');
  const lastDigest = row.lastDigest === null ? null : text(row.lastDigest);
  if (
    (row.lastSequence === 0) !== (lastDigest === null) ||
    (row.lastSequence === 0) !== (row.cursor === null) ||
    (lastDigest !== null && !/^[0-9a-f]{64}$/.test(lastDigest))
  )
    fail('capture_state');
  if (!Array.isArray(row.interruptions) || row.interruptions.length > 32) fail('capture_state');
  let previousEnd = instant(periodStart);
  const interruptions = row.interruptions.map((value: unknown) => {
    const gap = exact(value, ['start', 'end', 'reason']);
    const start = text(gap.start),
      end = text(gap.end),
      reason = text(gap.reason);
    if (instant(start) < previousEnd || instant(end) <= instant(start)) fail('capture_state');
    previousEnd = instant(end);
    return { start, end, reason };
  });
  return {
    binding,
    interruptions,
    cursor: row.cursor === null ? null : cursor(row.cursor),
    lastContact,
    periodStart,
    lastSequence: row.lastSequence,
    lastDigest,
  };
}
export interface CaptureProgress {
  captured: number;
  bookmarks: number;
  seals: number;
  delivery: string | null;
  acquisition: string | null;
}
export interface CaptureOptions {
  signal: AbortSignal;
  transport?: CaptureTransport;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Separate injectable scheduler keeps delivery independent in controlled-clock tests. */
  deliverySleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  fetcher?: typeof fetch;
  progress?: (value: CaptureProgress) => void;
  /** Test fault injection runs after durable capture and before cursor checkpoint. */
  afterCapture?: () => Promise<void>;
}
export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}
async function transaction<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) fail('capture_shutdown');
    try {
      return await work();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'journal_locked' ||
        (!signal && attempt >= 20)
      )
        throw error;
      if (signal) await sleep(Math.min(250, 10 * 2 ** Math.min(attempt, 5)), signal);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
export async function runCapture(
  config: CaptureConfig,
  options: CaptureOptions,
): Promise<CaptureProgress> {
  const progress: CaptureProgress = {
    captured: 0,
    bookmarks: 0,
    seals: 0,
    delivery: null,
    acquisition: null,
  };
  const env = options.env ?? process.env;
  await validateConfig(config, env);
  return locked(
    config.journalDirectory,
    async () => {
      const directory = config.journalDirectory;
      const summary = await transaction(() => statusJournal(directory), options.signal);
      if (
        summary.sourceId !== config.scope.sourceId ||
        summary.producerId !== config.producerId ||
        summary.journalId !== config.journalId ||
        summary.policyReference !== config.policyReference
      )
        fail('capture_journal_binding');
      const binding = fingerprint(config);
      let state: State;
      try {
        state = parseState(
          JSON.parse(await readPrivate(join(directory, 'capture-state.json'), 16384)),
          binding,
        );
      } catch (error) {
        if (!isMissing(error)) fail('capture_state');
        if (summary.entries || summary.seals) fail('capture_unbound_journal');
        state = {
          binding,
          cursor: null,
          lastContact: summary.startupAt,
          periodStart: summary.startupAt,
          lastSequence: 0,
          lastDigest: null,
          interruptions: [],
        };
      }
      // Existing journal validation is authority. Validate checkpoint's exact retained entry.
      if (state.lastSequence > summary.entries) fail('capture_state');
      if (state.lastSequence) {
        let found = false;
        for (let index = 1; index <= summary.retainedRecords; index++) {
          const record = parseArchiveRecord(
            JSON.parse(
              await readPrivate(
                join(directory, 'records', `${String(index).padStart(10, '0')}.json`),
                65536,
              ),
            ),
          );
          if (record.kind === 'entry' && record.sequence === state.lastSequence) {
            if (
              record.digest !== state.lastDigest ||
              instant(record.captured_at) > instant(state.lastContact)
            )
              fail('capture_state');
            found = true;
            break;
          }
        }
        if (!found) fail('capture_state');
      }
      const later = (left: bigint, right: bigint) => (left > right ? left : right);
      let lastClock = later(
        instant(state.lastContact),
        instant(state.interruptions.at(-1)?.end ?? state.lastContact),
      );
      const clock = () => {
        const value = (options.now ?? (() => new Date()))().toISOString();
        const current = instant(value);
        if (current < lastClock) fail('capture_clock_rollback');
        lastClock = current;
        return value;
      };
      const checkpoint = () => atomicState(directory, state, 'capture-state.json');
      // A seal can fsync before its capture checkpoint. Adopt only verified journal end.
      if (summary.lastSealedInterval?.end) {
        const end = summary.lastSealedInterval.end;
        if (instant(end) < instant(state.periodStart)) fail('capture_state');
        state.periodStart = end;
        state.interruptions = state.interruptions
          .filter((gap) => instant(gap.end) > instant(end))
          .map((gap) => ({ ...gap, start: instant(gap.start) < instant(end) ? end : gap.start }));
        if (instant(state.lastContact) < instant(end)) state.lastContact = end;
        lastClock = later(
          instant(state.lastContact),
          instant(state.interruptions.at(-1)?.end ?? state.lastContact),
        );
      } else if (state.periodStart !== summary.startupAt) fail('capture_state');
      await checkpoint();
      const report = () => options.progress?.({ ...progress });
      let retainedVersion = summary.retainedRecords;
      const rememberInterruption = (end: string, reason: string) => {
        if (instant(end) > instant(state.lastContact)) {
          const prior = state.interruptions.at(-1);
          if (prior && instant(state.lastContact) <= instant(prior.end)) {
            if (instant(end) > instant(prior.end)) prior.end = end;
            if (prior.reason !== reason) prior.reason = 'capture_uncertainty';
          } else {
            if (state.interruptions.length === 32) {
              // Preserve every missing bound; the conservative union also marks intervening
              // contacts uncertain instead of consuming another immutable seal.
              const first = state.interruptions[0];
              if (!first) fail('capture_state');
              state.interruptions = [{ start: first.start, end, reason: 'capture_uncertainty' }];
            } else state.interruptions.push({ start: state.lastContact, end, reason });
          }
        }
      };
      const closePeriod = async (reason: string, force = true) => {
        let end = clock();
        if (instant(end) <= instant(state.periodStart)) return;
        rememberInterruption(end, reason);
        if (!force && instant(end) - instant(state.periodStart) < 3600000000n) {
          await checkpoint();
          return;
        }
        // Include even a crash-recovered tail before closing an exclusive period.
        const current = await transaction(() => statusJournal(directory), options.signal);
        let latestCapture = instant(state.periodStart);
        for (let index = current.retainedRecords; index > 0; index--) {
          const record = parseArchiveRecord(
            JSON.parse(
              await readPrivate(
                join(directory, 'records', `${String(index).padStart(10, '0')}.json`),
                65536,
              ),
            ),
          );
          if (record.kind === 'entry') {
            latestCapture = instant(record.captured_at);
            break;
          }
        }
        if (instant(end) < latestCapture) fail('capture_clock_rollback');
        if (instant(end) === latestCapture || instant(end) === instant(state.lastContact)) {
          await sleep(1, options.signal);
          end = clock();
          if (instant(end) <= latestCapture || instant(end) <= instant(state.lastContact)) return;
        }
        // A same-millisecond exclusive-end adjustment also extends uncertainty.
        rememberInterruption(end, reason);
        await transaction(
          () =>
            sealJournal(directory, {
              start: state.periodStart,
              end,
              evidenceRef: 'urn:clio:capture:period',
              interruptions: state.interruptions,
            }),
          options.signal,
        );
        state.periodStart = end;
        state.lastContact = end;
        state.interruptions = [];
        retainedVersion++;
        await checkpoint();
        progress.seals++;
        report();
      };
      await closePeriod('collector_restart');
      const transport = options.transport ?? createTransport(config, env);
      const acquisition = new AbortController();
      const abort = () => acquisition.abort();
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      let senderFailure: unknown;
      let permanentDelivery: string | null = null;
      const deliveryFetch: typeof fetch = async (input, init) => {
        const response = await (options.fetcher ?? fetch)(input, init);
        if (
          response.status !== 202 &&
          response.status !== 408 &&
          response.status !== 429 &&
          response.status < 500
        ) {
          permanentDelivery = `receiver_${response.status}`;
        }
        return response;
      };
      let highestSequence = summary.entries;
      let nextDeliveryAt = 0;
      let idleUntil = 0;
      let idleVersion = -1;
      const sender = (async () => {
        try {
          while (!acquisition.signal.aborted) {
            const cooldown = nextDeliveryAt - Date.now();
            if (cooldown > 0 || (idleVersion === retainedVersion && idleUntil > Date.now())) {
              await (options.deliverySleep ?? options.sleep ?? sleep)(
                Math.min(60000, cooldown > 0 ? cooldown : 1000),
                acquisition.signal,
              );
              continue;
            }
            const attemptVersion = retainedVersion;
            let deliveryError: string | null = null;
            const result = await transaction(() =>
              drainJournal(directory, {
                ...config.receiver,
                env,
                fetcher: deliveryFetch,
                maxAttempts: 1,
                maxWaitMs: 0,
              }),
            ).catch((error: unknown) => {
              if (error instanceof JournalCredentialError) {
                deliveryError = error.message;
                return null;
              }
              if (error instanceof Error && error.message === 'journal_locked') {
                deliveryError = 'sender_busy';
                return null;
              }
              throw error;
            });
            if (result === null) {
              // Another bounded sender owns delivery; acquisition keeps its own lock.
              progress.delivery = deliveryError;
              report();
              await (options.deliverySleep ?? options.sleep ?? sleep)(1000, acquisition.signal);
              continue;
            }
            nextDeliveryAt = result.nextAttemptAt === null ? 0 : Date.parse(result.nextAttemptAt);
            if (result.pendingRecords === 0) {
              idleVersion = attemptVersion;
              idleUntil = Date.now() + 60000;
            }
            progress.delivery = permanentDelivery ?? result.stoppedReason;
            report();
            if (
              progress.delivery?.startsWith('receiver_') &&
              !['receiver_408', 'receiver_429'].includes(progress.delivery) &&
              !/^receiver_5\d\d$/.test(progress.delivery)
            )
              break;
            await (options.deliverySleep ?? options.sleep ?? sleep)(1000, acquisition.signal);
          }
        } catch (error) {
          senderFailure = error;
          acquisition.abort();
        }
      })();
      let failures = 0;
      let relist = true; // Restart always observes current state; never assumes retained watch history.
      const observe = async (input: unknown, resourceVersion: string) => {
        clock();
        const entry = await transaction(
          () =>
            captureJournal(directory, {
              input,
              format: 'application',
              evidenceRef: 'urn:clio:capture:application',
              deduplicate: true,
            }),
          acquisition.signal,
        );
        await options.afterCapture?.();
        state.lastSequence = entry.sequence;
        state.lastDigest = entry.digest;
        state.cursor = resourceVersion;
        state.lastContact = clock();
        await checkpoint();
        if (entry.sequence > highestSequence) {
          highestSequence = entry.sequence;
          progress.captured++;
          retainedVersion++;
        }
        report();
      };
      let acquisitionFailure: { error: unknown } | null = null;
      try {
        while (!acquisition.signal.aborted) {
          let interruptionReason = 'watch_interruption';
          try {
            if (relist) {
              const list = parseList(await transport.list(acquisition.signal), config.scope);
              if (acquisition.signal.aborted) break;
              await closePeriod('current_list_uncertainty', false);
              await observe(list.input, list.cursor);
              relist = false;
              progress.acquisition = null;
            }
            if (state.cursor === null) fail('capture_state');
            for await (const raw of transport.watch(state.cursor, acquisition.signal)) {
              if (acquisition.signal.aborted) break;
              const event = parseWatchEvent(raw);
              if (event.type === 'EXPIRED') throw new Error('capture_cursor_expired');
              progress.acquisition = null;
              if (event.type === 'BOOKMARK') {
                state.cursor = event.cursor;
                state.lastContact = clock();
                await checkpoint();
                progress.bookmarks++;
                report();
              } else {
                const app = validateApplication(event.input, config.scope);
                await observe(app.input, app.cursor);
              }
            }
            failures = 0;
          } catch (error) {
            if (acquisition.signal.aborted) break;
            if (
              !(error instanceof Error) ||
              !['capture_transport', 'capture_cursor_expired'].includes(error.message)
            )
              throw error;
            if (error.message === 'capture_cursor_expired') relist = true;
            interruptionReason =
              error.message === 'capture_cursor_expired'
                ? 'cursor_expired_relist'
                : 'acquisition_unavailable';
            progress.acquisition = error.message;
            report();
            failures++;
          }
          if (acquisition.signal.aborted) break;
          // Reconnect latency, quiet streams and expired cursors all carry conservative uncertainty.
          await (options.sleep ?? sleep)(
            Math.min(30000, 250 * 2 ** Math.min(failures, 7)),
            acquisition.signal,
          );
          if (!acquisition.signal.aborted) await closePeriod(interruptionReason, false);
        }
      } catch (error) {
        acquisitionFailure = { error };
      } finally {
        acquisition.abort();
        options.signal.removeEventListener('abort', abort);
        await sender; // Existing drain has a finite 5s network ceiling; leave period unsealed.
      }
      // A requested shutdown must not conceal a concurrent fatal journal failure.
      if (senderFailure) throw senderFailure;
      if (acquisitionFailure) throw acquisitionFailure.error;
      return { ...progress };
    },
    'capture',
  ).catch((error: unknown) => {
    if (options.signal.aborted && error instanceof Error && error.message === 'capture_shutdown')
      return { ...progress };
    throw error;
  });
}

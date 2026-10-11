import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Mapping, Preview } from '../deployment-mappings/api';
import { ApiError, errorMessage, request } from '../identity/api';
import { useSession } from '../identity/session';
import { MetricResults } from '../measurements/metric-results';
import type { SourceSetupPresentation } from '../source-setup/provider-state';
import { newestFirst, parseRun, parseRuns, type Run } from './api';

export function MockCollectionHistory({
  mapping,
  owner,
  userId,
  validSelection,
  reloadMapping,
  setup,
}: {
  setup?: SourceSetupPresentation;
  mapping: Mapping;
  owner: boolean;
  userId: string;
  validSelection: () => boolean;
  reloadMapping: () => Promise<void>;
}) {
  const setupRef = useRef(setup);
  const lastStatus = useRef('');
  setupRef.current = setup;
  const session = useSession();
  const revision = session.revision;
  const client = useQueryClient();
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const replay = useRef<{ revision: number; requestId: string } | null>(null);
  const polls = useRef(0);
  const [confirmation, setConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queueDenied, setQueueDenied] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pollLimit, setPollLimit] = useState(false);
  const path = `/api/workspaces/${mapping.workspaceId}/services/${mapping.serviceId}/mock-collection-runs`;
  const key = useMemo(
    () => [
      'identity',
      userId,
      revision,
      'workspace',
      mapping.workspaceId,
      'service',
      mapping.serviceId,
      'mock-collection-runs',
    ],
    [userId, revision, mapping.workspaceId, mapping.serviceId],
  );
  const valid = useCallback(
    () => mounted.current && session.current(revision) && validSelection(),
    [session.current, revision, validSelection],
  );
  const query = useQuery({
    queryKey: key,
    enabled: !unavailable,
    queryFn: async ({ signal }) => {
      const runs = await request(path, (value) => parseRuns(value, mapping), { signal });
      if (signal.aborted || !valid()) throw new ApiError(0);
      return runs;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lastStatus.current = '';
      setupRef.current?.onStatus({ ready: false, busy: false, hasSavedResult: false });
      controller.current?.abort();
      replay.current = null;
      void client.cancelQueries({ queryKey: key });
      client.removeQueries({ queryKey: key });
    };
  }, [client, key]);
  useEffect(() => {
    if (replay.current?.revision !== mapping.revision) {
      replay.current = null;
      setConfirmation(false);
    }
    setConflict(false);
    setError('');
  }, [mapping.revision]);
  function handleFailure(failure: unknown) {
    if (!valid()) return;
    if (failure instanceof ApiError) {
      if (failure.status === 401) session.expire(revision);
      if (failure.status === 404) {
        setUnavailable(true);
        setupRef.current?.onAccessLost();
        client.removeQueries({ queryKey: key });
      }
      if (failure.status === 403) {
        setQueueDenied(true);
        void client.invalidateQueries({ queryKey: ['identity', userId, revision, 'workspaces'] });
      }
    }
  }
  useEffect(() => {
    if (query.error instanceof ApiError && valid()) {
      if (query.error.status === 401) session.expire(revision);
      if (query.error.status === 404 || (setupRef.current && query.error.status === 403)) {
        setupRef.current?.onAccessLost();
        setUnavailable(true);
        client.removeQueries({ queryKey: key });
      }
    }
  }, [query.error, client, key, revision, session.expire, valid]);
  const active =
    query.data?.some((run) => run.status === 'pending' || run.status === 'running') ?? false;
  const setupReady =
    valid() && owner && !queueDenied && !unavailable && !conflict && query.isSuccess;
  const setupBusy = busy || confirmation;
  const hasSavedResult =
    valid() &&
    !unavailable &&
    query.isSuccess &&
    query.data.some(
      (run) =>
        run.status === 'succeeded' &&
        run.result !== null &&
        run.mappingRevision === mapping.revision,
    );
  useEffect(() => {
    const signature = JSON.stringify([
      setupReady,
      setupBusy,
      hasSavedResult,
      mapping.revision,
      !!setupRef.current,
    ]);
    if (lastStatus.current === signature) return;
    lastStatus.current = signature;
    setupRef.current?.onStatus({ ready: setupReady, busy: setupBusy, hasSavedResult });
  });
  // At most 30 automatic refreshes per observation period. Manual refresh starts another period.
  useEffect(() => {
    if (
      !query.dataUpdatedAt ||
      !active ||
      unavailable ||
      query.isFetching ||
      query.isError ||
      !valid()
    )
      return;
    if (polls.current >= 30) {
      setPollLimit(true);
      return;
    }
    const timer = window.setTimeout(() => {
      if (!valid()) return;
      polls.current += 1;
      void query.refetch();
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [
    active,
    unavailable,
    query.isFetching,
    query.isError,
    query.dataUpdatedAt,
    query.refetch,
    valid,
  ]);
  function refresh() {
    polls.current = 0;
    setPollLimit(false);
    void query.refetch();
  }
  async function queue() {
    if (pending.current || !valid() || !owner || queueDenied || unavailable) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const next = new AbortController();
    controller.current = next;
    const body = replay.current ?? { revision: mapping.revision, requestId: crypto.randomUUID() };
    replay.current = body;
    setConfirmation(true);
    try {
      const run = await request(path, (value) => parseRun(value, mapping, body.revision), {
        body,
        signal: next.signal,
      });
      if (!valid() || next.signal.aborted) return;
      if (replay.current === body) {
        replay.current = null;
        setConfirmation(false);
      }
      setNotice(`Demo collection queued for saved revision ${run.mappingRevision}.`);
      setConflict(false);
      polls.current = 0;
      setPollLimit(false);
      // Cancel an older list read before inserting the confirmed run.
      await client.cancelQueries({ queryKey: key });
      if (!valid() || next.signal.aborted) return;
      client.setQueryData<Run[]>(key, (previous) =>
        [run, ...(previous ?? []).filter((item) => item.id !== run.id)]
          .sort(newestFirst)
          .slice(0, 25),
      );
      void query.refetch();
    } catch (failure) {
      if (!valid() || next.signal.aborted) return;
      handleFailure(failure);
      // Network, server and unverifiable success responses may follow an accepted request.
      // Keep the same request ID until an accepted result or definite client rejection.
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        if (replay.current === body) {
          replay.current = null;
          setConfirmation(false);
        }
      }
      if (failure instanceof ApiError && failure.status === 409) {
        setConflict(true);
        setError(
          'Saved settings changed or another demo collection is active. Refresh runs and saved settings before trying again.',
        );
      } else if (failure instanceof ApiError && failure.status === 403) {
        setError(
          'Only workspace owners can queue demo collection. You can still read run history.',
        );
      } else setError(`${errorMessage(failure)} Retry queueing to confirm the same request.`);
    } finally {
      if (valid() && !next.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  async function reload() {
    if (pending.current || !valid()) return;
    pending.current = true;
    setBusy(true);
    try {
      await reloadMapping();
      if (valid()) {
        setConflict(false);
        setError('');
        refresh();
      }
    } catch (failure) {
      if (valid()) {
        handleFailure(failure);
        setError(errorMessage(failure));
      }
    } finally {
      if (valid()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section className="mt-6 border-t border-slate-200 pt-6" aria-label="Demo collection history">
      <div hidden={setup?.step === 'configure'}>
        <h4 className="text-lg font-semibold">Demo collection history</h4>
        <p>
          {mapping.scenario === 'complete-lifecycle'
            ? 'Complete lifecycle. Demo data.'
            : 'Partial lifecycle.'}
        </p>
        <p className="mt-2">
          Fictional data only. These runs do not change your workspace metrics.
        </p>
        <p className="mt-2">
          Queueing uses saved settings revision {mapping.revision}. Save edits first to include
          them.
        </p>
      </div>
      {unavailable || (query.error instanceof ApiError && query.error.status === 404) ? (
        <p role="alert">Run history is no longer available to you.</p>
      ) : (
        <>
          <span hidden={setup?.step === 'configure'}>
            {owner && !queueDenied ? (
              <button
                className="control mt-3"
                type="button"
                disabled={busy || conflict || (active && replay.current === null)}
                onClick={() => void queue()}
              >
                Queue demo collection
              </button>
            ) : (
              <p className="mt-2">Only workspace owners can queue demo collection.</p>
            )}
          </span>
          <button
            className="control mt-3 ml-3"
            type="button"
            disabled={query.isFetching || busy}
            onClick={refresh}
          >
            Refresh runs
          </button>
          {conflict && (
            <button
              className="control mt-3 ml-3"
              type="button"
              disabled={busy}
              onClick={() => void reload()}
            >
              Refresh saved settings
            </button>
          )}
          {busy && (
            <p role="status" className="mt-2">
              Confirming demo collection request…
            </p>
          )}
          {notice && (
            <p role="status" className="mt-2">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2">
              {error}
            </p>
          )}
          {query.isPending ? (
            <p role="status" className="mt-2">
              Loading demo collection history…
            </p>
          ) : query.isError ? (
            <p role="alert" className="mt-2">
              {errorMessage(query.error)} Refresh runs to try again.
            </p>
          ) : (
            <div hidden={setup?.step === 'configure'}>
              {query.data.length === 0 ? (
                <p className="mt-2">No demo collection runs yet.</p>
              ) : (
                <ol className="mt-4 space-y-4" aria-label="Latest 25 demo collection runs">
                  {query.data.map((run) => (
                    <RunSummary key={run.id} run={run} />
                  ))}
                </ol>
              )}
            </div>
          )}
          {active && (
            <p className="mt-3">
              Pending runs wait for local demo processing. If processing is paused, runs stay
              pending; resume local demo processing, then refresh runs.
            </p>
          )}
          {pollLimit && (
            <p role="status" className="mt-2">
              Automatic refresh paused. Refresh runs to check progress again.
            </p>
          )}
        </>
      )}
    </section>
  );
}
function RunSummary({ run }: { run: Run }) {
  return (
    <li className="rounded border border-slate-200 p-4">
      <h5 className="font-semibold">
        Saved settings revision {run.mappingRevision} · {run.status}
      </h5>
      <p>{run.scenario === 'complete-lifecycle' ? 'Complete lifecycle' : 'Partial lifecycle'}</p>
      <p>
        {run.primaryProvider === 'github' ? 'GitHub' : 'Argo CD'} · Attempts: {run.attempts} of 3
      </p>
      <p>
        Settings observed at {run.mappingObservedAt}. Queued at {run.createdAt}.
      </p>
      <p>
        Updated at {run.updatedAt}.{run.completedAt && ` Completed at ${run.completedAt}.`}
      </p>
      {run.status === 'failed' && (
        <p>Mock processing failed after {run.attempts} attempts. An owner can queue another run.</p>
      )}
      {run.result && <StoredResult result={run.result} />}
    </li>
  );
}
function StoredResult({ result }: { result: Preview }) {
  return (
    <div className="mt-3">
      <p>
        Saved result ·{' '}
        {result.scenario === 'complete-lifecycle' ? 'Complete lifecycle' : 'Provisional'} ·
        Qualification: {result.qualification}
      </p>
      <p>
        Sample window: {result.window.start} to {result.window.end} (UTC,{' '}
        {result.window.calendarDays} calendar days).
      </p>
      <p>
        Evidence cutoff: {result.evidenceCutoff}. OEMS revision: {result.oemsRevision}.
      </p>
      <p>
        Rollouts: {result.rolloutCount}. Qualifying sample deployments:{' '}
        {result.deploymentFrequency.count}.
      </p>
      {result.metricResult ? (
        <p>Complete demo scenario.</p>
      ) : (
        <p>
          Coverage incomplete: collection{' '}
          {result.coverage.collectionComplete ? 'complete' : 'incomplete'}, deployment history{' '}
          {result.coverage.deploymentHistoryComplete ? 'complete' : 'incomplete'}, recovery evidence{' '}
          {result.coverage.recoveryEvidenceComplete ? 'complete' : 'incomplete'}.
        </p>
      )}
      <p>
        Quality reasons: {result.deploymentFrequency.qualityReasons.join(', ') || 'None reported'}.
      </p>
      {result.metricResult ? (
        <MetricResults result={result.metricResult} sourceLabel="Demo" headingLevel={6} />
      ) : (
        <p>Deployments per day, change failure rate and recovery time are unavailable.</p>
      )}
      {result.qualification === 'unknown' && (
        <p>Production exposure is unconfirmed for this result.</p>
      )}
    </div>
  );
}

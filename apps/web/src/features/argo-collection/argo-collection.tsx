import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, errorMessage, request, type Workspace } from '../identity/api';
import { useSession } from '../identity/session';
import {
  type Connection,
  closedWindow,
  newestFirst,
  parseConnection,
  parseRun,
  parseRuns,
  parseSavedConnection,
  type Run,
  type Scope,
  type Source,
  type Window,
} from './api';

type Props = {
  workspace: Workspace;
  serviceId: string;
  serviceName: string;
  userId: string;
  validSelection: () => boolean;
};
export function ArgoCollection(props: Props) {
  const session = useSession();
  return (
    <LiveScope
      key={`${props.userId}:${session.revision}:${props.workspace.id}:${props.serviceId}`}
      {...props}
    />
  );
}
function LiveScope({ workspace, serviceId, serviceName, userId, validSelection }: Props) {
  const session = useSession(),
    client = useQueryClient(),
    revision = session.revision;
  const scope = useMemo(
    () => ({ workspaceId: workspace.id, serviceId }),
    [workspace.id, serviceId],
  );
  const key = useMemo(
    () => [
      'identity',
      userId,
      revision,
      'workspace',
      workspace.id,
      'service',
      serviceId,
      'argo-live',
    ],
    [userId, revision, workspace.id, serviceId],
  );
  const connectionKey = useMemo(() => [...key, 'connection'], [key]);
  const runsKey = useMemo(() => [...key, 'runs'], [key]);
  const path = `/api/workspaces/${workspace.id}/services/${serviceId}`;
  const mounted = useRef(true),
    controller = useRef<AbortController | null>(null),
    pending = useRef(false);
  const [busy, setBusy] = useState(false),
    [unavailable, setUnavailable] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [conflict, setConflict] = useState(false);
  const [selected, setSelected] = useState('');
  const selection = useRef('');
  const valid = useCallback(
    () => mounted.current && session.current(revision) && validSelection(),
    [session.current, revision, validSelection],
  );
  const detailKey = useMemo(() => [...key, 'detail', selected], [key, selected]);
  const detailValid = useCallback(
    () => valid() && selection.current === selected,
    [valid, selected],
  );
  const connectionQuery = useQuery({
    queryKey: connectionKey,
    enabled: !unavailable,
    queryFn: async ({ signal }) => {
      const value = await request(
        `${path}/argo-connection`,
        (value) => parseConnection(value, scope),
        { signal },
      );
      if (signal.aborted || !valid()) throw new ApiError(0);
      return value;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const runs = useQuery({
    queryKey: runsKey,
    enabled: !unavailable,
    queryFn: async ({ signal }) => {
      const value = await request(
        `${path}/argo-collection-runs`,
        (value) => parseRuns(value, scope),
        { signal },
      );
      if (signal.aborted || !valid()) throw new ApiError(0);
      return value;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      void client.cancelQueries({ queryKey: key });
      client.removeQueries({ queryKey: key });
    };
  }, [client, key]);
  const handleFailure = useCallback(
    (failure: unknown, write = false) => {
      if (!valid() || !(failure instanceof ApiError)) return;
      if (failure.status === 401) session.expire(revision);
      if (failure.status === 404 || (!write && failure.status === 403)) {
        setUnavailable(true);
        controller.current?.abort();
        void client.cancelQueries({ queryKey: key });
        client.removeQueries({ queryKey: key });
      }
      if (write && failure.status === 403) {
        void client.invalidateQueries({ queryKey: ['identity', userId, revision, 'workspaces'] });
      }
    },
    [valid, session.expire, revision, client, key, userId],
  );
  useEffect(() => {
    handleFailure(connectionQuery.error);
    handleFailure(runs.error);
  }, [connectionQuery.error, runs.error, handleFailure]);
  const polls = useRef(0),
    [pollLimit, setPollLimit] = useState(false);
  const active =
    runs.data?.some((run) => run.status === 'pending' || run.status === 'running') ?? false;
  useEffect(() => {
    if (
      !runs.dataUpdatedAt ||
      !active ||
      runs.isFetching ||
      runs.isError ||
      unavailable ||
      !valid()
    )
      return;
    if (polls.current >= 30) {
      setPollLimit(true);
      return;
    }
    const timer = window.setTimeout(() => {
      if (valid()) {
        polls.current++;
        void runs.refetch();
      }
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [active, runs.isFetching, runs.isError, runs.dataUpdatedAt, runs.refetch, unavailable, valid]);
  async function refresh() {
    if (pending.current || !valid()) return false;
    polls.current = 0;
    setPollLimit(false);
    const results = await Promise.all([connectionQuery.refetch(), runs.refetch()]);
    if (valid() && results.every((result) => !result.isError)) {
      setConflict(false);
      setError('');
      return true;
    }
    return false;
  }
  async function refreshHistory() {
    if (pending.current || !valid() || unavailable) return false;
    polls.current = 0;
    setPollLimit(false);
    const result = await runs.refetch();
    return valid() && !result.isError;
  }
  async function write<T>(
    suffix: string,
    body: object,
    parse: (value: unknown) => T,
    success: (value: T) => void,
  ): Promise<'accepted' | 'rejected' | 'uncertain' | 'stale'> {
    if (pending.current || !valid() || workspace.role !== 'owner' || unavailable || conflict)
      return 'stale';
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const next = new AbortController();
    controller.current = next;
    try {
      const value = await request(`${path}/${suffix}`, parse, { body, signal: next.signal });
      if (!valid() || next.signal.aborted) return 'stale';
      await client.cancelQueries({ queryKey: key });
      if (!valid() || next.signal.aborted) return 'stale';
      success(value);
      return 'accepted';
    } catch (failure) {
      if (!valid() || next.signal.aborted) return 'stale';
      handleFailure(failure, true);
      if (failure instanceof ApiError && failure.status === 409) {
        setConflict(true);
        setError(
          'Saved connection changed or another collection is active. Refresh connection and runs before trying again.',
        );
      } else if (failure instanceof ApiError && failure.status === 403)
        setError(
          'This action is not permitted for the selected Argo scope, or your owner access changed. Ask your operator to confirm the selected source grant. After any operator grant change, save the connection again. You can still read history.',
        );
      else setError(errorMessage(failure));
      return failure instanceof ApiError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.status !== 408 &&
        failure.status !== 429
        ? 'rejected'
        : 'uncertain';
    } finally {
      if (valid() && !next.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  const saved = connectionQuery.data?.connection ?? null;
  const editable = workspace.role === 'owner';
  const configured = connectionQuery.data?.configured === true;
  const currentSource = connectionQuery.data?.sources.find(
    (source) => source.sourceId === saved?.sourceId,
  );
  const staleConnection =
    saved !== null &&
    configured &&
    (!currentSource ||
      currentSource.applicationName !== saved.applicationName ||
      currentSource.applicationNamespace !== saved.applicationNamespace ||
      currentSource.instance !== saved.instance ||
      currentSource.environment !== saved.productionEnvironment ||
      (saved.enrichmentProducers ?? []).some(
        (producer) =>
          !(currentSource.enrichmentProducers ?? []).some(
            (grant) =>
              grant.producerId === producer.producerId &&
              grant.capability === producer.capability &&
              grant.policyReference === producer.policyReference,
          ),
      ));

  return (
    <section
      className="mt-8 border-t border-slate-200 pt-6"
      aria-label={`Live Argo for ${serviceName}`}
    >
      <h3 className="text-xl font-semibold">Live Argo · {serviceName}</h3>
      <p className="mt-2">
        Inspect retained real Argo notification evidence. Mock settings and attestations remain
        separate. Saved results are available separately in Overview with incomplete coverage.
      </p>
      {unavailable ? (
        <p role="alert">Live Argo data is no longer available to you.</p>
      ) : (
        <>
          {connectionQuery.isPending ? (
            <p role="status">Loading Argo connection…</p>
          ) : !connectionQuery.data ? (
            <p role="alert">{errorMessage(connectionQuery.error)}</p>
          ) : (
            <>
              {!configured && (
                <p role="status">
                  Operator setup needed. Ask your Clio operator to configure Argo access for this
                  workspace before connecting or collecting.
                </p>
              )}
              <p className="mt-3">
                {saved
                  ? `${saved.active ? 'Connected' : 'Disconnected'}: ${saved.applicationName} · ${saved.productionEnvironment} · Saved revision ${saved.revision}`
                  : 'No live Argo connection saved.'}
              </p>
              {saved && (
                <>
                  <p>
                    Application namespace: {saved.applicationNamespace}. Instance: {saved.instance}.
                    Saved at {saved.observedAt}.
                  </p>
                  <p>
                    {(saved.enrichmentProducers ?? []).length === 0
                      ? 'No independent evidence producers selected; native Argo status leaves production exposure unknown.'
                      : `Independent evidence producers selected: ${saved.enrichmentProducers?.length}.`}
                  </p>
                  {saved.exposurePolicyReference && (
                    <p>
                      Legacy native policy reference: {saved.exposurePolicyReference}. Native status
                      alone does not confirm exposure.
                    </p>
                  )}
                  {(saved.enrichmentProducers ?? []).map((producer) => (
                    <p key={producer.producerId}>
                      {producer.capability === 'consumer_exposure'
                        ? 'Consumer exposure'
                        : 'Build provenance'}
                      : {producer.policyReference}.
                    </p>
                  ))}
                </>
              )}
              {editable && configured && (
                <ConnectionForm
                  key={`connection:${saved?.revision ?? 0}:${JSON.stringify(connectionQuery.data.sources)}`}
                  connection={saved}
                  sources={connectionQuery.data.sources}
                  disabled={busy || conflict || connectionQuery.isFetching}
                  save={async (draft) => {
                    const expectedRevision = saved?.revision ?? null;
                    const granted = connectionQuery.data?.sources.find(
                      (source) => source.sourceId === draft.sourceId,
                    );
                    if (!granted) return;

                    await write(
                      'argo-connection',
                      { ...draft, expectedRevision },
                      (value) =>
                        parseSavedConnection(value, scope, expectedRevision, true, {
                          sourceId: granted.sourceId,
                          applicationName: granted.applicationName,
                          applicationNamespace: granted.applicationNamespace,
                          instance: granted.instance,
                          productionEnvironment: granted.environment,
                          exposurePolicyReference: draft.exposurePolicyReference,
                          enrichmentProducers: (granted.enrichmentProducers ?? []).filter((entry) =>
                            draft.enrichmentProducerIds.includes(entry.producerId),
                          ),
                        }),
                      (connection) => {
                        client.setQueryData(connectionKey, {
                          connection,
                          configured,
                          sources: connectionQuery.data?.sources ?? [],
                        });
                        setNotice('Argo connection saved.');
                      },
                    );
                  }}
                />
              )}
              {editable && saved?.active && (
                <button
                  className="control mt-3"
                  type="button"
                  disabled={busy || conflict || connectionQuery.isFetching}
                  onClick={() =>
                    void write(
                      'argo-connection/disconnect',
                      { expectedRevision: saved.revision },
                      (value) => parseSavedConnection(value, scope, saved.revision, false, saved),
                      (connection) => {
                        client.setQueryData(connectionKey, {
                          connection,
                          configured,
                          sources: connectionQuery.data?.sources ?? [],
                        });
                        setNotice(
                          'Disconnected from Clio ingestion. Retained history remains available.',
                        );
                        void runs.refetch();
                      },
                    )
                  }
                >
                  Disconnect Argo
                </button>
              )}
              {!editable && (
                <p className="mt-3">
                  Only workspace owners can save, disconnect or collect. Members can read
                  connections and history.
                </p>
              )}
              {staleConnection && (
                <p role="status">
                  Granted source changed. An owner must review the grant and save the connection
                  again before collecting. Retained history remains available.
                </p>
              )}
              {saved?.active && editable && configured && !staleConnection && (
                <CollectionForm
                  key={`collection:${saved.revision}`}
                  connection={saved}
                  disabled={busy || conflict || connectionQuery.isFetching}
                  active={active}
                  reviewHistory={refreshHistory}
                  collect={async (body) =>
                    write(
                      'argo-collection-runs',
                      body,
                      (value) => parseRun(value, scope, saved.revision, undefined, body.window),
                      (run) => {
                        setNotice(
                          `Collection confirmed for saved revision ${run.connectionRevision}.`,
                        );
                        polls.current = 0;
                        setPollLimit(false);
                        client.setQueryData<Run[]>(runsKey, (previous) =>
                          [run, ...(previous ?? []).filter((item) => item.id !== run.id)]
                            .sort(newestFirst)
                            .slice(0, 25),
                        );
                        void runs.refetch();
                      },
                    )
                  }
                />
              )}
            </>
          )}
          <button
            className="control mt-3"
            type="button"
            disabled={busy || connectionQuery.isFetching || runs.isFetching}
            onClick={() => void refresh()}
          >
            Refresh connection and runs
          </button>
          {busy && <p role="status">Confirming request…</p>}
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert">{error}</p>}
          <h4 className="mt-6 text-lg font-semibold">Live Argo history</h4>
          {runs.isPending ? (
            <p role="status">Loading live Argo history…</p>
          ) : runs.isError ? (
            <p role="alert">{errorMessage(runs.error)}</p>
          ) : runs.data.length === 0 ? (
            <p>No live Argo runs yet.</p>
          ) : (
            <ol aria-label="Latest 25 live Argo runs" className="mt-3 space-y-3">
              {runs.data.map((run) => (
                <li key={run.id} className="rounded border border-slate-200 p-4">
                  <p>
                    Saved connection revision {run.connectionRevision} · {run.status}
                  </p>
                  <p>
                    Queued {run.createdAt}. Updated {run.updatedAt}. Attempts: {run.attempts} of 3.
                  </p>
                  <button
                    className="control mt-2"
                    type="button"
                    aria-pressed={selected === run.id}
                    onClick={() => {
                      selection.current = run.id;
                      setSelected(run.id);
                    }}
                  >
                    View run {run.createdAt}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {active && (
            <p role="status">
              Collection pending or running. History refreshes while processing continues.
            </p>
          )}
          {pollLimit && (
            <p role="status">
              Automatic refresh paused. Refresh connection and runs to check progress.
            </p>
          )}
          {selected && (
            <RunDetail
              key={selected}
              id={selected}
              scope={scope}
              path={path}
              queryKey={detailKey}
              valid={detailValid}
              failure={handleFailure}
              tick={runs.dataUpdatedAt}
            />
          )}
        </>
      )}
    </section>
  );
}

type ConnectionDraft = {
  sourceId: string;
  exposurePolicyReference: string | null;
  enrichmentProducerIds: string[];
  applicationOperationsBelongToService: true;
};
function ConnectionForm({
  connection,
  sources,
  disabled,
  save,
}: {
  connection: Connection | null;
  sources: Source[];
  disabled: boolean;
  save: (draft: ConnectionDraft) => Promise<void>;
}) {
  const id = useId();
  const [sourceId, setSourceId] = useState(
      sources.find((source) => source.sourceId === connection?.sourceId)?.sourceId ??
        sources[0]?.sourceId ??
        '',
    ),
    [producerIds, setProducerIds] = useState(
      (connection?.enrichmentProducers ?? [])
        .filter((entry) =>
          sources
            .find((source) => source.sourceId === connection?.sourceId)
            ?.enrichmentProducers?.some((grant) => grant.producerId === entry.producerId),
        )
        .map((entry) => entry.producerId),
    ),
    [assigned, setAssigned] = useState(false),
    [error, setError] = useState('');
  const selected = sources.find((source) => source.sourceId === sourceId);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (
      !selected ||
      !assigned ||
      producerIds.some(
        (producerId) =>
          !(selected.enrichmentProducers ?? []).some((entry) => entry.producerId === producerId),
      )
    ) {
      setError(
        'Choose a granted source, granted evidence producers and confirm application assignment.',
      );
      return;
    }
    setError('');
    await save({
      sourceId: selected.sourceId,
      exposurePolicyReference:
        selected.sourceId === connection?.sourceId ? connection.exposurePolicyReference : null,
      enrichmentProducerIds: [...producerIds].sort(),
      applicationOperationsBelongToService: true,
    });
  }
  return (
    <form className="mt-4" onSubmit={(event) => void submit(event)} noValidate>
      <fieldset disabled={disabled}>
        <legend className="font-semibold">Connect Argo deployment evidence</legend>
        <label htmlFor={`${id}-source`}>Granted Argo source</label>
        <select
          id={`${id}-source`}
          className="field"
          value={sourceId}
          onChange={(event) => {
            setSourceId(event.target.value);
            setAssigned(false);
            setProducerIds([]);
          }}
        >
          {sources.map((source) => (
            <option key={source.sourceId} value={source.sourceId}>
              {source.applicationName} · {source.applicationNamespace} · {source.instance} ·{' '}
              {source.environment}
            </option>
          ))}
        </select>
        <p>Production environment from grant: {selected?.environment ?? 'Unavailable'}</p>
        <fieldset className="mt-3">
          <legend className="font-semibold">Granted evidence producers</legend>
          {(selected?.enrichmentProducers ?? []).length === 0 && (
            <p>
              No independent evidence producers configured. Native production exposure remains
              unknown.
            </p>
          )}
          {(selected?.enrichmentProducers ?? []).map((producer) => (
            <label className="mt-2 block" key={producer.producerId}>
              <input
                type="checkbox"
                checked={producerIds.includes(producer.producerId)}
                onChange={(event) =>
                  setProducerIds((previous) =>
                    event.target.checked
                      ? [...previous, producer.producerId]
                      : previous.filter((producerId) => producerId !== producer.producerId),
                  )
                }
              />{' '}
              {producer.capability === 'consumer_exposure'
                ? 'Production consumer exposure'
                : 'Artifact build provenance'}{' '}
              · {producer.policyReference}
            </label>
          ))}
          <p>
            Exposure requires independently confirmed production activation. Build provenance
            identifies artifact source; it attaches to a rollout only when matching artifact
            exposure exists.
          </p>
        </fieldset>
        <label className="mt-3 block">
          <input
            type="checkbox"
            checked={assigned}
            onChange={(event) => setAssigned(event.target.checked)}
          />{' '}
          I assign all deployment operations in this application to this service.
        </label>
        <button className="control mt-3" type="submit">
          Save Argo connection
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function CollectionForm({
  connection,
  disabled,
  active,
  reviewHistory,
  collect,
}: {
  connection: Connection;
  disabled: boolean;
  active: boolean;
  reviewHistory: () => Promise<boolean>;
  collect: (body: {
    connectionRevision: number;
    requestId: string;
    window: Window;
  }) => Promise<'accepted' | 'rejected' | 'uncertain' | 'stale'>;
}) {
  const id = useId(),
    [start, setStart] = useState(''),
    [end, setEnd] = useState(''),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(false),
    [reviewing, setReviewing] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [abandonConfirmed, setAbandonConfirmed] = useState(false);
  const mounted = useRef(true),
    reviewPending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const replay = useRef<{ connectionRevision: number; requestId: string; window: Window } | null>(
    null,
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || reviewPending.current || (active && !replay.current)) return;
    let body = replay.current;
    try {
      body ??= {
        connectionRevision: connection.revision,
        requestId: crypto.randomUUID(),
        window: closedWindow(start, end),
      };
    } catch {
      setError(
        'Choose valid UTC dates: end after start, no later than today, and at most 90 calendar days. End date is exclusive.',
      );
      return;
    }
    replay.current = body;
    setReviewed(false);
    setAbandonConfirmed(false);
    setError('');
    const outcome = await collect(body);
    if (!mounted.current) return;
    if (outcome === 'accepted' || outcome === 'rejected') {
      replay.current = null;
      setRetry(false);
    } else if (outcome === 'uncertain') {
      setRetry(true);
      setError('Collection could not be confirmed. Retry preserves the same request and dates.');
    }
  }
  async function review() {
    if (disabled || reviewPending.current || !retry) return;
    reviewPending.current = true;
    setReviewing(true);
    setReviewed(false);
    setAbandonConfirmed(false);
    try {
      const refreshed = await reviewHistory();
      if (!mounted.current) return;
      setReviewed(refreshed);
      if (!refreshed)
        setError(
          'History could not be verified. Keep the same request and retry, or review history again before abandoning confirmation.',
        );
    } catch {
      if (mounted.current)
        setError(
          'History could not be verified. Review history again before abandoning confirmation.',
        );
    } finally {
      if (mounted.current) {
        reviewPending.current = false;
        setReviewing(false);
      }
    }
  }
  function abandon() {
    if (disabled || reviewPending.current || !reviewed || !abandonConfirmed) return;
    replay.current = null;
    setRetry(false);
    setReviewed(false);
    setAbandonConfirmed(false);
    setError(
      'Confirmation abandoned. The previous request may already have completed. A new collection can repeat that work.',
    );
  }
  return (
    <form className="mt-5" onSubmit={(event) => void submit(event)} noValidate>
      <h4 className="font-semibold">Collect saved connection revision {connection.revision}</h4>
      <p>
        Closed UTC calendar days, up to 90 days. End date is exclusive and cannot be in the future.
      </p>
      <fieldset disabled={disabled || retry}>
        <legend>Collection dates (UTC)</legend>
        <label htmlFor={`${id}-start`}>Start date (UTC)</label>
        <input
          id={`${id}-start`}
          className="field"
          type="date"
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
        <label htmlFor={`${id}-end`}>End date, exclusive (UTC)</label>
        <input
          id={`${id}-end`}
          className="field"
          type="date"
          value={end}
          onChange={(event) => setEnd(event.target.value)}
          max={new Date().toISOString().slice(0, 10)}
        />
      </fieldset>
      <button
        className="control mt-3"
        type="submit"
        disabled={disabled || reviewing || (active && !retry)}
      >
        {retry ? 'Retry collection request' : 'Collect Argo evidence'}
      </button>
      {retry && (
        <div className="mt-3">
          <p>
            The previous request may already be accepted. Review the latest history before choosing
            to start another request. History cannot identify this request directly.
          </p>
          <button
            className="control mt-3"
            type="button"
            disabled={disabled || reviewing}
            onClick={() => void review()}
          >
            Review latest collection history
          </button>
          {reviewing && <p role="status">Refreshing collection history…</p>}
          {reviewed && (
            <>
              <p role="status">
                Latest history refreshed. Inspect runs below before abandoning confirmation. An
                accepted run may already be complete or outside the latest 25 runs.
              </p>
              <label className="mt-3 block">
                <input
                  type="checkbox"
                  checked={abandonConfirmed}
                  disabled={disabled || reviewing}
                  onChange={(event) => setAbandonConfirmed(event.target.checked)}
                />{' '}
                I reviewed history and understand that a new request may duplicate a completed
                collection.
              </label>
              <button
                className="control mt-3"
                type="button"
                disabled={disabled || reviewing || !abandonConfirmed}
                onClick={abandon}
              >
                Abandon confirmation and unlock dates
              </button>
            </>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function RunDetail({
  id,
  scope,
  path,
  queryKey,
  valid,
  failure,
  tick,
}: {
  id: string;
  scope: Scope;
  path: string;
  queryKey: readonly unknown[];
  valid: () => boolean;
  failure: (error: unknown) => void;
  tick: number;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const run = await request(
        `${path}/argo-collection-runs/${id}`,
        (value) => parseRun(value, scope, undefined, id),
        { signal },
      );
      if (signal.aborted || !valid()) throw new ApiError(0);
      return run;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    failure(query.error);
  }, [failure, query.error]);
  const lastTick = useRef(tick);
  useEffect(() => {
    if (tick !== lastTick.current && valid()) {
      lastTick.current = tick;
      void client.invalidateQueries({ queryKey });
    }
  }, [tick, client, queryKey, valid]);
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey });
      client.removeQueries({ queryKey });
    },
    [client, queryKey],
  );
  return (
    <section className="mt-4 rounded border border-slate-200 p-4" aria-label="Live Argo run detail">
      <h4 className="font-semibold">Run detail</h4>
      {query.isPending ? (
        <p role="status">Loading run…</p>
      ) : query.isError ? (
        <>
          <p role="alert">{errorMessage(query.error)}</p>
          <button
            className="control"
            type="button"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry run detail
          </button>
        </>
      ) : (
        <StoredRun run={query.data} />
      )}
    </section>
  );
}
function StoredRun({ run }: { run: Run }) {
  const result = run.result;
  return (
    <>
      <p>
        Live Argo · {run.status} · Saved connection revision {run.connectionRevision}
      </p>
      <p>
        Queued {run.createdAt}. Updated {run.updatedAt}.
        {run.completedAt && ` Completed ${run.completedAt}.`}
      </p>
      {run.status === 'failed' &&
        (run.failureCode === 'argo_connection_revoked' ? (
          <p>
            Connection access changed. An owner must review and save the connection before another
            collection.
          </p>
        ) : (
          <p>Collection failed. An owner can try another run.</p>
        ))}
      {result && (
        <>
          <p>Stored live evidence · Provisional result</p>
          <p>
            Window: {result.window.start} to {result.window.end} (UTC, {result.window.calendarDays}{' '}
            calendar days).
          </p>
          <p>
            Evidence cutoff: {result.evidenceCutoff}. OEMS revision: {result.oemsRevision}.
          </p>
          <p>
            Argo transport history incomplete. This does not establish complete metric coverage.
          </p>
          <p>Retained receipts across all dates at cutoff: {result.retainedReceiptCount}.</p>
          <p>
            Retained evidence records across all dates at cutoff: {result.retainedEvidenceCount}.
          </p>
          <p>
            Retained deployment records across all dates at cutoff: {result.deploymentCount}.
            Qualifying: {result.qualifyingCount}. Unknown qualification: {result.unknownCount}.
          </p>
          <p>
            Retained counts are not limited to the reporting window and do not prove completeness.
          </p>
          <p>
            Observation period: {result.observationPeriod.start ?? 'No retained observations'} to{' '}
            {result.observationPeriod.end} (UTC). This is the source lifetime, including earlier
            grant revisions, not the reporting window.
          </p>
          <p>
            Recorded gaps: {result.recordedGapCount}. Zero recorded gaps does not prove complete
            delivery.
          </p>
          {Object.entries(result.gapReasons).length > 0 && (
            <ul aria-label="Recorded gap reasons">
              {Object.entries(result.gapReasons).map(([reason, count]) => (
                <li key={reason}>
                  {gapLabel(reason)}: {count}
                </li>
              ))}
            </ul>
          )}
          <p>
            Rejections: {result.rejectionCount}. Scope drift: {result.scopeDriftCount}. Counters
            span the source lifetime across grant revisions; retained evidence and gaps use the
            current grant only.
          </p>
          <p>
            {result.enrichmentSummary?.consumerExposureCount
              ? 'Independent exposure receipts are available. Qualification uses exact rollout binding and confirmed production activation.'
              : 'Native consumer exposure remains unknown. Successful sync and Healthy status do not establish qualification.'}
          </p>
          {result.enrichmentSummary && (
            <>
              <p>
                Independent exposure receipts: {result.enrichmentSummary.consumerExposureCount}.
                Build provenance receipts: {result.enrichmentSummary.applicationProvenanceCount}.
                Build inventory may remain unbound.
              </p>
              <ul aria-label="Selected evidence policies">
                {result.enrichmentSummary.policies.map((policy) => (
                  <li key={policy.producerId}>
                    {policy.capability === 'consumer_exposure'
                      ? 'Production exposure'
                      : 'Build provenance'}
                    : {policy.policyReference}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p>
            Provisional deployment frequency count: {result.deploymentFrequency.count}. This count
            is not a complete deployment measurement.
          </p>
          <p>Coverage incomplete: collection, deployment history and recovery evidence.</p>
          <p>Quality reasons: {result.deploymentFrequency.qualityReasons.join(', ')}.</p>
          <p>Deployments per day, change failure rate and recovery time are unavailable.</p>
        </>
      )}
    </>
  );
}

function gapLabel(reason: string): string {
  const labels: Record<string, string> = {
    unmarked_operation: 'Operation identity missing',
    non_terminal: 'Operation not terminal',
    missing_sync_result: 'Sync result missing',
    missing_health_timestamp: 'Health timestamp missing',
    multi_source: 'Multiple sources unsupported',
    source_hydrator: 'Source hydrator unsupported',
    future_timestamp: 'Future timestamp',
    invalid_operation_info: 'Invalid operation information',
    observation_horizon: 'Observation arrived too late',
    status_combination_repeated: 'Repeated status combination',
    status_combination_limit: 'Status combination limit reached',
    connection_interruption: 'Connection interruption',
  };
  return labels[reason] ?? 'Unsupported observation';
}

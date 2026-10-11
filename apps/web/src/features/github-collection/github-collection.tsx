import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, errorMessage, request, type Workspace } from '../identity/api';
import { useSession } from '../identity/session';
import { MetricResults } from '../measurements/metric-results';
import type { SourceSetupPresentation } from '../source-setup/provider-state';
import {
  type Connection,
  closedWindow,
  newestFirst,
  parseConnection,
  parseRun,
  parseRuns,
  parseSavedConnection,
  positiveId,
  type Run,
  type Scope,
  type Window,
} from './api';

type Props = {
  setup?: SourceSetupPresentation;
  workspace: Workspace;
  serviceId: string;
  serviceName: string;
  userId: string;
  validSelection: () => boolean;
};
export function GitHubCollection(props: Props) {
  const session = useSession();
  return (
    <LiveScope
      key={`${props.userId}:${session.revision}:${props.workspace.id}:${props.serviceId}`}
      {...props}
    />
  );
}
function LiveScope({ workspace, serviceId, serviceName, userId, validSelection, setup }: Props) {
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
      'github-live',
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
  const setupRef = useRef(setup);
  const lastStatus = useRef('');
  setupRef.current = setup;
  const [dirty, setDirty] = useState(true);
  const [confirmation, setConfirmation] = useState(false);
  const [detailState, setDetailState] = useState({ busy: false, failed: false });
  const [writeDenied, setWriteDenied] = useState(false);
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
        `${path}/github-connection`,
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
        `${path}/github-collection-runs`,
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
      lastStatus.current = '';
      setupRef.current?.onStatus({ ready: false, busy: false, hasSavedResult: false });
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
        setupRef.current?.onAccessLost();
        controller.current?.abort();
        void client.cancelQueries({ queryKey: key });
        client.removeQueries({ queryKey: key });
      }
      if (write && failure.status === 403) {
        setWriteDenied(true);
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
          'This action is not permitted for the selected GitHub scope, or your owner access changed. Check the installation and repository IDs or ask your operator to confirm access. After any operator grant change, save the connection again. You can still read history.',
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
  const setupReady =
    valid() &&
    editable &&
    configured &&
    saved?.active === true &&
    !unavailable &&
    !conflict &&
    !writeDenied &&
    !detailState.failed &&
    !dirty &&
    !connectionQuery.isError &&
    !connectionQuery.isPending &&
    !runs.isError &&
    !runs.isPending;
  const setupBusy = busy || confirmation;
  const hasSavedResult =
    valid() &&
    !unavailable &&
    !runs.isError &&
    (runs.data?.some(
      (run) =>
        run.status === 'succeeded' &&
        run.result !== null &&
        run.connectionRevision === saved?.revision,
    ) ??
      false);
  useEffect(() => {
    const signature = JSON.stringify([
      setupReady,
      setupBusy,
      hasSavedResult,
      saved?.revision,
      !!setupRef.current,
    ]);
    if (lastStatus.current === signature) return;
    lastStatus.current = signature;
    setupRef.current?.onStatus({ ready: setupReady, busy: setupBusy, hasSavedResult });
  });
  return (
    <section
      className="mt-8 border-t border-slate-200 pt-6"
      aria-label={`Live GitHub for ${serviceName}`}
    >
      <h3 className="text-xl font-semibold">Live GitHub · {serviceName}</h3>
      <p className="mt-2">
        Collect real GitHub deployment evidence. Mock settings and attestations remain separate.
        Saved results are available separately in Overview with incomplete coverage.
      </p>
      {unavailable ? (
        <p role="alert">Live GitHub data is no longer available to you.</p>
      ) : (
        <>
          {connectionQuery.isPending ? (
            <p role="status">Loading GitHub connection…</p>
          ) : !connectionQuery.data ? (
            <p role="alert">{errorMessage(connectionQuery.error)}</p>
          ) : (
            <>
              {!configured && (
                <p role="status">
                  Operator setup needed. Ask your Clio operator to configure GitHub access for this
                  workspace before connecting or collecting.
                </p>
              )}
              <div hidden={setup?.step === 'collect'}>
                <p className="mt-3">
                  {saved
                    ? `${saved.active ? 'Connected' : 'Disconnected'}: ${saved.repositoryName} · ${saved.productionEnvironment} · Saved revision ${saved.revision}`
                    : 'No live GitHub connection saved.'}
                </p>
                {saved && (
                  <>
                    <p>
                      Account: {saved.accountLogin}. Verified at {saved.verifiedAt}. Saved at{' '}
                      {saved.observedAt}.
                    </p>
                    <p>
                      Exposure policy:{' '}
                      {saved.exposurePolicyReference ??
                        'Not supplied; production exposure remains unknown.'}
                    </p>
                  </>
                )}
                {editable && configured && (
                  <ConnectionForm
                    key={`connection:${saved?.revision ?? 0}`}
                    connection={saved}
                    onDirty={setDirty}
                    disabled={busy || conflict || connectionQuery.isFetching}
                    save={async (draft) => {
                      const expectedRevision = saved?.revision ?? null;
                      await write(
                        'github-connection',
                        { ...draft, expectedRevision },
                        (value) => parseSavedConnection(value, scope, expectedRevision, true),
                        (connection) => {
                          client.setQueryData(connectionKey, { connection, configured });
                          setWriteDenied(false);
                          setNotice('GitHub connection saved.');
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
                        'github-connection/disconnect',
                        { expectedRevision: saved.revision },
                        (value) => parseSavedConnection(value, scope, saved.revision, false),
                        (connection) => {
                          client.setQueryData(connectionKey, { connection, configured });
                          setNotice(
                            'Disconnected from Clio collection. GitHub installation remains unchanged.',
                          );
                          void runs.refetch();
                        },
                      )
                    }
                  >
                    Disconnect GitHub
                  </button>
                )}
                {!editable && (
                  <p className="mt-3">
                    Only workspace owners can save, disconnect or collect. Members can read
                    connections and history.
                  </p>
                )}
              </div>
              <div hidden={setup?.step === 'configure'}>
                {saved?.active && editable && configured && (
                  <CollectionForm
                    key={`collection:${saved.revision}`}
                    connection={saved}
                    disabled={busy || conflict || connectionQuery.isFetching}
                    active={active}
                    onConfirmation={setConfirmation}
                    reviewHistory={refreshHistory}
                    collect={async (body) =>
                      write(
                        'github-collection-runs',
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
              </div>
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
          {setup?.step === 'configure' && runs.isError && (
            <p role="alert">{errorMessage(runs.error)}</p>
          )}
          <div hidden={setup?.step === 'configure'}>
            <h4 className="mt-6 text-lg font-semibold">Live GitHub history</h4>
            {runs.isPending ? (
              <p role="status">Loading live GitHub history…</p>
            ) : runs.isError ? (
              <p role="alert">{errorMessage(runs.error)}</p>
            ) : runs.data.length === 0 ? (
              <p>No live GitHub runs yet.</p>
            ) : (
              <ol aria-label="Latest 25 live GitHub runs" className="mt-3 space-y-3">
                {runs.data.map((run) => (
                  <li key={run.id} className="rounded border border-slate-200 p-4">
                    <p>
                      Saved connection revision {run.connectionRevision} · {run.status}
                    </p>
                    <p>
                      Queued {run.createdAt}. Updated {run.updatedAt}. Attempts: {run.attempts} of
                      3.
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
          </div>
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
          <div hidden={setup?.step === 'configure'}>
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
                onState={setDetailState}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

type ConnectionDraft = {
  installationId: number;
  repositoryId: number;
  productionEnvironment: string;
  exposurePolicyReference: string | null;
  repositoryDeploymentsBelongToService: true;
};
function ConnectionForm({
  connection,
  disabled,
  save,
  onDirty,
}: {
  connection: Connection | null;
  onDirty?: (dirty: boolean) => void;
  disabled: boolean;
  save: (draft: ConnectionDraft) => Promise<void>;
}) {
  const id = useId();
  const [installation, setInstallation] = useState(String(connection?.installationId ?? '')),
    [repository, setRepository] = useState(String(connection?.repositoryId ?? '')),
    [environment, setEnvironment] = useState(connection?.productionEnvironment ?? ''),
    [policy, setPolicy] = useState(connection?.exposurePolicyReference ?? ''),
    [assigned, setAssigned] = useState(false),
    [error, setError] = useState('');
  const dirty =
    connection === null ||
    installation !== String(connection.installationId) ||
    repository !== String(connection.repositoryId) ||
    environment !== connection.productionEnvironment ||
    policy !== (connection.exposurePolicyReference ?? '');
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    try {
      const installationId = positiveId(installation),
        repositoryId = positiveId(repository);
      if (
        !environment.trim() ||
        environment !== environment.trim() ||
        [...environment].length > 200 ||
        (policy && (policy !== policy.trim() || [...policy].length > 200)) ||
        !assigned
      )
        throw new ApiError(400);
      setError('');
      await save({
        installationId,
        repositoryId,
        productionEnvironment: environment,
        exposurePolicyReference: policy || null,
        repositoryDeploymentsBelongToService: true,
      });
    } catch {
      setError(
        'Enter positive whole-number IDs within the safe integer range, an exact production environment, and confirm repository assignment. Policy reference is optional (up to 200 characters).',
      );
    }
  }
  return (
    <form className="mt-4" onSubmit={(event) => void submit(event)} noValidate>
      <fieldset disabled={disabled}>
        <legend className="font-semibold">Connect GitHub deployment evidence</legend>
        <label htmlFor={`${id}-install`}>GitHub App installation ID</label>
        <input
          id={`${id}-install`}
          className="field"
          inputMode="numeric"
          value={installation}
          onChange={(event) => setInstallation(event.target.value)}
          autoComplete="off"
        />
        <label htmlFor={`${id}-repo`}>Repository ID</label>
        <input
          id={`${id}-repo`}
          className="field"
          inputMode="numeric"
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
          autoComplete="off"
        />
        <label htmlFor={`${id}-env`}>Exact production environment</label>
        <input
          id={`${id}-env`}
          className="field"
          value={environment}
          onChange={(event) => setEnvironment(event.target.value)}
          aria-describedby={`${id}-env-help`}
        />
        <p id={`${id}-env-help`}>
          Match the GitHub deployment environment exactly, including case.
        </p>
        <label htmlFor={`${id}-policy`}>Exposure policy reference (optional)</label>
        <input
          id={`${id}-policy`}
          className="field"
          value={policy}
          onChange={(event) => setPolicy(event.target.value)}
          aria-describedby={`${id}-policy-help`}
        />
        <p id={`${id}-policy-help`}>
          Reference a versioned policy that establishes consumer exposure. A successful deployment
          alone does not prove production exposure. Without a policy, qualification remains unknown.
          Mock attestations do not apply.
        </p>
        <label className="mt-3 block">
          <input
            type="checkbox"
            checked={assigned}
            onChange={(event) => setAssigned(event.target.checked)}
          />{' '}
          I assign all deployment operations in this repository to this service.
        </label>
        <button className="control mt-3" type="submit">
          Save GitHub connection
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
  onConfirmation,
}: {
  onConfirmation?: (pending: boolean) => void;
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
  useEffect(() => {
    onConfirmation?.(retry || reviewing);
    return () => onConfirmation?.(false);
  }, [retry, reviewing, onConfirmation]);
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
        {retry ? 'Retry collection request' : 'Collect GitHub deployments'}
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
  onState,
}: {
  id: string;
  scope: Scope;
  path: string;
  queryKey: readonly unknown[];
  valid: () => boolean;
  failure: (error: unknown) => void;
  tick: number;
  onState?: (state: { busy: boolean; failed: boolean }) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const run = await request(
        `${path}/github-collection-runs/${id}`,
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
    onState?.({ busy: query.isFetching, failed: query.isError });
  }, [onState, query.isFetching, query.isError]);
  useEffect(() => () => onState?.({ busy: false, failed: false }), [onState]);
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
    <section
      className="mt-4 rounded border border-slate-200 p-4"
      aria-label="Live GitHub run detail"
    >
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
        Live GitHub · {run.status} · Saved connection revision {run.connectionRevision}
      </p>
      <p>
        Queued {run.createdAt}. Updated {run.updatedAt}.
        {run.completedAt && ` Completed ${run.completedAt}.`}
      </p>
      {run.status === 'failed' &&
        (run.failureCode === 'github_connection_revoked' ? (
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
            GitHub history retrieval {result.transportComplete ? 'complete' : 'incomplete'}. This
            does not establish complete metric coverage.
          </p>
          <p>
            Retained deployment records across all dates and environments: {result.deploymentCount}.
            Qualifying: {result.qualifyingCount}. Unknown qualification: {result.unknownCount}.
          </p>
          <p>
            Provisional deployment frequency count: {result.deploymentFrequency.count}. This count
            is not a complete deployment measurement.
          </p>
          <p>Coverage incomplete: collection, deployment history and recovery evidence.</p>
          <p>Quality reasons: {result.deploymentFrequency.qualityReasons.join(', ')}.</p>
          <MetricResults result={result.metricResult} sourceLabel="GitHub" />
        </>
      )}
    </>
  );
}

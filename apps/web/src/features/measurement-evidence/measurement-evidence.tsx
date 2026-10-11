import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { type Run as ArgoRun, parseHistoryPage as parseArgoPage } from '../argo-collection/api';
import {
  type Run as GitHubRun,
  parseHistoryPage as parseGitHubPage,
} from '../github-collection/api';
import { ApiError, errorMessage, parseServices, request } from '../identity/api';
import { useSession } from '../identity/session';
import { HistoryBrowser, useStoredRead } from '../result-history/history-browser';
import {
  type Authority,
  type Basis,
  type Capability,
  capabilities,
  type Provider,
  parseAuthorities,
  parseHistoryPage,
  parseRun,
  type Run,
  type Scope,
} from './api';
import { MeasurementDetails } from './measurement-history';

export type MeasurementEvidenceProps = Scope & { serviceName: string; onAccessLost?: () => void };
export function MeasurementEvidence(props: MeasurementEvidenceProps) {
  const session = useSession();
  if (session.status !== 'ready' || !session.user) return null;
  return (
    <OwnerScope
      key={`${session.user.id}:${session.revision}:${props.workspaceId}:${props.serviceId}`}
      {...props}
    />
  );
}
function OwnerScope(props: MeasurementEvidenceProps) {
  const [provider, setProvider] = useState<Provider>('github');
  const [blocked, setBlocked] = useState(false);
  const accessLost = useCallback(() => {
    setBlocked(true);
    props.onAccessLost?.();
  }, [props.onAccessLost]);
  const id = useId();
  return (
    <section aria-label="Independent measurement evidence" className="panel">
      <h2 className="text-xl font-semibold">Independent measurement evidence</h2>
      <p className="mt-3">
        Calculate a separate saved measurement for {props.serviceName} from a saved collection and
        received independent evidence. Missing evidence keeps measurements partial.
      </p>
      {blocked ? (
        <p role="alert">
          Measurement evidence is no longer accessible. Refresh your workspace access.
        </p>
      ) : (
        <>
          <label className="mt-3 block" htmlFor={id}>
            Basis provider
          </label>
          <select
            id={id}
            className="field"
            value={provider}
            onChange={(event) => setProvider(event.target.value === 'argocd' ? 'argocd' : 'github')}
          >
            <option value="github">GitHub</option>
            <option value="argocd">Argo CD</option>
          </select>
          <OwnerRequests {...props} onAccessLost={accessLost} />
          <BasisSelection key={provider} {...props} provider={provider} onAccessLost={accessLost} />
        </>
      )}
    </section>
  );
}
function BasisSelection({
  workspaceId,
  serviceId,
  provider,
  onAccessLost,
}: Scope & { provider: Provider; onAccessLost: () => void }) {
  const [basis, setBasis] = useState<Basis | null>(null);
  const scope = { workspaceId, serviceId };
  return (
    <>
      <HistoryBrowser<GitHubRun | ArgoRun>
        title={provider === 'github' ? 'GitHub basis' : 'Argo CD basis'}
        path={`/api/workspaces/${workspaceId}/services/${serviceId}/${provider === 'github' ? 'github' : 'argo'}-collection-runs`}
        parse={(value, options) =>
          provider === 'github'
            ? parseGitHubPage(value, scope, options)
            : parseArgoPage(value, scope, options)
        }
        onAccessLost={onAccessLost}
        renderResult={(_newest, selected) =>
          selected?.result ? (
            <div className="mt-3 space-y-3">
              <p>
                Saved basis: {selected.result.window.start} to {selected.result.window.end}.
                Original evidence cutoff: {selected.result.evidenceCutoff}. Connection revision:{' '}
                {selected.connectionRevision}.
              </p>
              <button
                className="control"
                type="button"
                onClick={() => {
                  if (selected.result)
                    setBasis({
                      id: selected.id,
                      provider,
                      connectionRevision: selected.connectionRevision,
                      result: selected.result,
                    });
                }}
              >
                Use selected saved collection
              </button>
            </div>
          ) : (
            <p>
              No successful saved collection available for this provider. Collect a basis first.
            </p>
          )
        }
      />
      {basis && (
        <AuthoritySelection key={basis.id} {...scope} basis={basis} onAccessLost={onAccessLost} />
      )}
    </>
  );
}
export const capabilityLabels: Record<Capability, string> = {
  population: 'Deployment population',
  change_links: 'Changes and first-deployment history',
  classification: 'Failure and rework classification',
  recovery: 'Service recovery',
};
function unavailableMessage(error: unknown, detail = false): string {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return 'A measurement may already be in progress, or the source or evidence changed. Refresh measurement requests and workspace access, then refresh received evidence.';
    if (error.status === 404)
      return detail
        ? 'This measurement request is unavailable. Refresh measurement requests.'
        : 'This saved collection is unavailable for a new measurement. Select a fresh collection and refresh received evidence.';
  }
  return errorMessage(error);
}
function OwnerRequests({
  workspaceId,
  serviceId,
  onAccessLost,
}: Scope & { onAccessLost: () => void }) {
  const path = `/api/workspaces/${workspaceId}/services/${serviceId}/measurement-runs`;
  const recent = useStoredRead(`${path}/owner-recent`, path, (value) =>
    parseHistoryPage(value, { workspaceId, serviceId }),
  );
  const denied = recent.error instanceof ApiError && [401, 403, 404].includes(recent.error.status);
  useLayoutEffect(() => {
    if (denied) onAccessLost();
  }, [denied, onAccessLost]);
  return (
    <section aria-label="Recent measurement requests" className="mt-4 space-y-3">
      <h3 className="font-semibold">Recent measurement requests</h3>
      <button
        className="control"
        type="button"
        aria-disabled={recent.isFetching}
        onClick={() => {
          if (!recent.isFetching) void recent.refetch();
        }}
      >
        Refresh measurement requests
      </button>
      {!denied &&
        (recent.isError ? (
          <p role="alert">{errorMessage(recent.error)}</p>
        ) : recent.isPending ? (
          <p role="status">Loading measurement requests…</p>
        ) : recent.data.runs.length === 0 ? (
          <p>No recent measurement requests.</p>
        ) : (
          <>
            <p>
              Showing up to 25 recent requests across both providers. Pending requests have no saved
              result yet.
            </p>
            <ul className="list-disc pl-6">
              {recent.data.runs.map((run) => (
                <li key={run.id}>
                  {run.provider === 'github' ? 'GitHub' : 'Argo CD'} measurement: {run.status}.
                  Requested {run.createdAt}.
                </li>
              ))}
            </ul>
          </>
        ))}
    </section>
  );
}
function AuthoritySelection({
  workspaceId,
  serviceId,
  basis,
  onAccessLost,
}: Scope & { basis: Basis; onAccessLost: () => void }) {
  const session = useSession(),
    revision = session.revision,
    client = useQueryClient();
  const path = `/api/workspaces/${workspaceId}/services/${serviceId}`;
  const scope = { workspaceId, serviceId };
  const [selected, setSelected] = useState<Partial<Record<Capability, string>>>({});
  const [queued, setQueued] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [postMissing, setPostMissing] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [accessError, setAccessError] = useState('');
  const [accessVerified, setAccessVerified] = useState(false);
  const accessController = useRef<AbortController | null>(null);
  const checked404s = useRef(new WeakSet<ApiError>());
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(true),
    pending = useRef(false),
    requestId = useRef<string | null>(null);
  const authorities = useStoredRead(
    `${path}/authorities/${basis.provider}/${basis.id}`,
    `${path}/measurement-authorities?provider=${basis.provider}&basisRunId=${encodeURIComponent(basis.id)}`,
    parseAuthorities,
  );
  const detail = useStoredRead(
    `${path}/measurement-detail/${basis.provider}/${basis.id}/${queued?.id ?? ''}`,
    `${path}/measurement-runs/${queued?.id ?? ''}`,
    (value) => parseRun(value, scope, { ...(queued ? { id: queued.id } : {}), basis }),
    queued !== null,
  );
  const valid = () => mounted.current && session.current(revision);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      accessController.current?.abort();
    };
  }, []);
  const handleAccess = useCallback(
    async (failure: unknown) => {
      const current = () => mounted.current && session.current(revision);
      if (!(failure instanceof ApiError) || !current()) return;
      if (failure.status === 401) session.expire(revision);
      if (failure.status === 401 || failure.status === 403) {
        onAccessLost();
        return;
      }
      if (failure.status !== 404 || accessController.current || checked404s.current.has(failure))
        return;
      checked404s.current.add(failure);
      const abort = new AbortController();
      accessController.current = abort;
      setCheckingAccess(true);
      setAccessVerified(false);
      setAccessError('');
      try {
        const services = await request(
          `/api/workspaces/${workspaceId}/services`,
          (value) => parseServices(value, workspaceId),
          { signal: abort.signal },
        );
        if (!abort.signal.aborted && current()) {
          if (!services.some((item) => item.id === serviceId)) onAccessLost();
          else setAccessVerified(true);
        }
      } catch (failure) {
        if (abort.signal.aborted || !current()) return;
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
          if (failure.status === 401) session.expire(revision);
          onAccessLost();
        } else
          setAccessError(
            'Workspace access could not be checked. Refresh received evidence to retry.',
          );
      } finally {
        if (!abort.signal.aborted && current()) {
          accessController.current = null;
          setCheckingAccess(false);
        }
      }
    },
    [session.current, session.expire, revision, onAccessLost, workspaceId, serviceId],
  );
  useLayoutEffect(() => {
    void handleAccess(authorities.error);
    void handleAccess(detail.error);
  }, [authorities.error, detail.error, handleAccess]);
  const run = detail.data ?? queued;
  const active = run?.status === 'pending' || run?.status === 'running';
  const selectedIds = Object.values(selected);
  const selectedAuthorities =
    authorities.data?.filter((authority) => selectedIds.includes(authority.producerId)) ?? [];
  const selectionAvailable = selectedIds.every((id) =>
    selectedAuthorities.some(
      (authority) => authority.producerId === id && authority.receiptAvailable,
    ),
  );
  async function calculate() {
    if (
      pending.current ||
      busy ||
      checkingAccess ||
      accessError !== '' ||
      active ||
      !valid() ||
      !authorities.data ||
      authorities.isFetching ||
      authorities.isError ||
      !selectionAvailable
    )
      return;
    pending.current = true;
    setBusy(true);
    setError('');
    setPostMissing(false);
    const abort = new AbortController();
    controller.current = abort;
    requestId.current ??= crypto.randomUUID();
    try {
      const saved = await request(
        `${path}/measurement-runs`,
        (value) => parseRun(value, scope, { basis }),
        {
          signal: abort.signal,
          body: {
            requestId: requestId.current,
            provider: basis.provider,
            basisRunId: basis.id,
            producerIds: selectedAuthorities.map((authority) => authority.producerId),
          },
        },
      );
      if (abort.signal.aborted || !valid()) return;
      setQueued(saved);
      refreshRequests();
      requestId.current = null;
      // Same run identity can be returned by a retry; its detail must be refreshed.
      void client.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'identity' &&
          query.queryKey[1] === session.user?.id &&
          query.queryKey[2] === revision &&
          query.queryKey.includes(
            `${path}/measurement-detail/${basis.provider}/${basis.id}/${saved.id}`,
          ),
      });
    } catch (failure) {
      if (!abort.signal.aborted && valid()) {
        setPostMissing(failure instanceof ApiError && failure.status === 404);
        setError(unavailableMessage(failure));
        if (failure instanceof ApiError && failure.status === 409) refreshRequests();
        await handleAccess(failure);
      }
    } finally {
      if (!abort.signal.aborted && valid()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  function refreshRequests() {
    void client.invalidateQueries({
      queryKey: [
        'identity',
        session.user?.id,
        revision,
        'overview',
        `${path}/measurement-runs/owner-recent`,
      ],
    });
  }
  function choose(capability: Capability, producerId: string) {
    if (
      busy ||
      pending.current ||
      checkingAccess ||
      accessError !== '' ||
      active ||
      authorities.isFetching
    )
      return;
    requestId.current = null;
    const next = { ...selected };
    if (producerId) next[capability] = producerId;
    else delete next[capability];
    setSelected(next);
    setError('');
  }
  const controlsBusy =
    busy || active || checkingAccess || accessError !== '' || authorities.isFetching;
  return (
    <div className="mt-4 space-y-3">
      <h3 className="font-semibold">Received evidence for selected collection</h3>
      <p>
        Measurement basis window: {basis.result.window.start} to {basis.result.window.end}. Original
        collection evidence cutoff: {basis.result.evidenceCutoff}. Connection revision:{' '}
        {basis.connectionRevision}. Saved basis reference: {basis.id}.
      </p>
      <button
        className="control"
        type="button"
        aria-disabled={busy || checkingAccess || authorities.isFetching || active}
        onClick={() => {
          if (busy || checkingAccess || authorities.isFetching || active) return;
          setAccessError('');
          void authorities.refetch();
        }}
      >
        Refresh received evidence
      </button>
      {authorities.isPending ? (
        <p role="status">Loading received evidence…</p>
      ) : authorities.isError ? (
        <p role="alert">
          {authorities.error instanceof ApiError &&
          authorities.error.status === 404 &&
          !accessVerified
            ? 'Saved collection could not be read. Checking workspace access before retrying.'
            : unavailableMessage(authorities.error)}
        </p>
      ) : (
        <>
          {authorities.data.length === 0 && (
            <p>No configured evidence authorities are available for this saved collection.</p>
          )}
          <p>
            Select at most one received authority per capability. Omitted or unreceived reports
            cannot establish complete coverage. Calculating with no reports saves a partial
            measurement.
          </p>
          {capabilities.map((capability) => (
            <AuthorityChoices
              key={capability}
              capability={capability}
              authorities={authorities.data.filter((item) => item.capability === capability)}
              selectedProducerId={selected[capability]}
              busy={controlsBusy}
              choose={choose}
            />
          ))}
          {!selectionAvailable && (
            <p role="alert">
              Selected evidence is no longer available. Choose received evidence or omit that
              capability.
            </p>
          )}
        </>
      )}
      <button
        className="control aria-disabled:opacity-60"
        type="button"
        aria-disabled={
          controlsBusy || authorities.isPending || authorities.isError || !selectionAvailable
        }
        onClick={() => void calculate()}
      >
        Calculate saved measurement
      </button>
      {checkingAccess && <p role="status">Checking workspace access…</p>}
      {accessError && <p role="alert">{accessError}</p>}
      {busy && <p role="status">Requesting a saved measurement…</p>}
      {error && (
        <p role="alert">
          {checkingAccess || (postMissing && !accessVerified)
            ? 'Measurement request could not be saved. Check workspace access before retrying.'
            : error}
        </p>
      )}
      {run && (
        <>
          <p role="status">
            Measurement request: {run.status}.
            {active && ' No saved result yet. Refresh measurement status to check progress.'}
            {run.status === 'failed' &&
              (run.failureCode === 'measurement_revoked'
                ? ' Evidence or source access changed; collect a fresh basis before retrying.'
                : ' Processing failed; no measurement was saved.')}
          </p>
          <button
            className="control"
            type="button"
            aria-disabled={busy || checkingAccess || detail.isFetching}
            onClick={() => {
              if (busy || checkingAccess || detail.isFetching) return;
              void detail.refetch();
            }}
          >
            Refresh measurement status
          </button>
          {detail.isError ? (
            <p role="alert">
              {detail.error instanceof ApiError && detail.error.status === 404 && !accessVerified
                ? 'Measurement request could not be read. Checking workspace access before retrying.'
                : unavailableMessage(detail.error, true)}
            </p>
          ) : (
            run.result && <MeasurementDetails result={run.result} />
          )}
        </>
      )}
    </div>
  );
}
function AuthorityChoices({
  capability,
  authorities,
  selectedProducerId,
  busy,
  choose,
}: {
  capability: Capability;
  authorities: Authority[];
  selectedProducerId: string | undefined;
  busy: boolean;
  choose: (capability: Capability, producerId: string) => void;
}) {
  const name = useId();
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium">{capabilityLabels[capability]}</legend>
      <label className="block">
        <input
          type="radio"
          name={name}
          checked={!selectedProducerId}
          aria-disabled={busy}
          onChange={() => choose(capability, '')}
        />{' '}
        Omit this capability
      </label>
      {authorities.map((authority) => (
        <label className="block" key={authority.producerId}>
          <input
            type="radio"
            name={name}
            checked={selectedProducerId === authority.producerId}
            disabled={!authority.receiptAvailable}
            aria-disabled={busy || !authority.receiptAvailable}
            onChange={() => choose(capability, authority.producerId)}
          />{' '}
          {authority.name} ·{' '}
          {authority.receiptAvailable ? 'Evidence received' : 'Evidence unavailable for this basis'}
        </label>
      ))}
      {authorities.length === 0 && <p>No authority available for this capability.</p>}
    </fieldset>
  );
}

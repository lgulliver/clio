import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, errorMessage, request, type Workspace } from '../identity/api';
import { useSession } from '../identity/session';
import { MetricResults } from '../measurements/metric-results';
import { MockCollectionHistory } from '../mock-collection/mock-collection';
import type { SourceSetupPresentation, SourceSetupStatus } from '../source-setup/provider-state';
import {
  type Draft,
  type Mapping,
  type Preview,
  parseMapping,
  parsePreview,
  parseSavedMapping,
} from './api';

type Props = {
  setup?: SourceSetupPresentation;
  workspace: Workspace;
  serviceId: string;
  serviceName: string;
  userId: string;
  validSelection: () => boolean;
};
export function DeploymentMappings(props: Props) {
  const session = useSession();
  return (
    <MappingScope
      key={`${props.userId}:${session.revision}:${props.workspace.id}:${props.serviceId}`}
      {...props}
    />
  );
}
function MappingScope({ workspace, serviceId, serviceName, userId, validSelection, setup }: Props) {
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const [editorStatus, setEditorStatus] = useState({ revision: -1, ready: false, busy: false });
  const [historyStatus, setHistoryStatus] = useState<SourceSetupStatus & { revision: number }>({
    revision: -1,
    ready: false,
    busy: false,
    hasSavedResult: false,
  });
  const session = useSession();
  const client = useQueryClient();
  const revision = session.revision;
  const mounted = useRef(true);
  const controllers = useRef(new Set<AbortController>());
  const [denied, setDenied] = useState(false);
  const [editingDenied, setEditingDenied] = useState(false);
  const [notice, setNotice] = useState('');
  const noticeElement = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (notice) noticeElement.current?.focus();
  }, [notice]);
  const [reload, setReload] = useState(0);
  const scope = { workspaceId: workspace.id, serviceId };
  const path = `/api/workspaces/${workspace.id}/services/${serviceId}`;
  const key = useMemo(
    () => [
      'identity',
      userId,
      revision,
      'workspace',
      workspace.id,
      'service',
      serviceId,
      'deployment-mapping',
    ],
    [userId, revision, workspace.id, serviceId],
  );
  const valid = () => mounted.current && session.current(revision) && validSelection();
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const result = await request(
        `${path}/deployment-mapping`,
        (value) => parseMapping(value, scope),
        { signal },
      );
      if (signal.aborted || !valid()) throw new ApiError(0);
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setupRef.current?.onStatus({ ready: false, busy: false, hasSavedResult: false });
      for (const controller of controllers.current) controller.abort();
      void client.cancelQueries({ queryKey: key });
      client.removeQueries({ queryKey: key });
    };
  }, [client, key]);
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) session.expire(revision);
  }, [query.error, session.expire, revision]);
  useEffect(() => {
    if (
      query.error instanceof ApiError &&
      (query.error.status === 403 || query.error.status === 404)
    )
      setupRef.current?.onAccessLost();
  }, [query.error]);
  const savedRevision = query.data?.revision ?? -1;
  const reportEditor = useCallback(
    (status: { ready: boolean; busy: boolean }) => {
      setEditorStatus({ ...status, revision: savedRevision });
    },
    [savedRevision],
  );
  const reportHistory = useCallback(
    (status: SourceSetupStatus) => {
      setHistoryStatus({ ...status, revision: savedRevision });
    },
    [savedRevision],
  );
  const accessLost = useCallback(() => {
    setDenied(true);
    setupRef.current?.onAccessLost();
  }, []);
  const setupReady =
    valid() &&
    workspace.role === 'owner' &&
    !denied &&
    !editingDenied &&
    query.isSuccess &&
    query.data !== null &&
    editorStatus.revision === savedRevision &&
    editorStatus.ready &&
    historyStatus.revision === savedRevision &&
    historyStatus.ready;
  const setupBusy = editorStatus.busy || historyStatus.busy;
  const hasSavedResult =
    valid() &&
    !denied &&
    query.isSuccess &&
    query.data !== null &&
    historyStatus.revision === savedRevision &&
    historyStatus.hasSavedResult;
  useEffect(() => {
    setupRef.current?.onStatus({ ready: setupReady, busy: setupBusy, hasSavedResult });
  }, [setupReady, setupBusy, hasSavedResult]);
  async function execute<T>(endpoint: string, parse: (value: unknown) => T, body?: object) {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const result = await request(`${path}/${endpoint}`, parse, {
        signal: controller.signal,
        ...(body ? { body } : {}),
      });
      if (!valid() || controller.signal.aborted) throw new ApiError(0);
      return result;
    } catch (error) {
      if (valid() && error instanceof ApiError) {
        if (error.status === 401) session.expire(revision);
        if (error.status === 404) {
          setDenied(true);
          setupRef.current?.onAccessLost();
          client.removeQueries({ queryKey: key });
        }
        if (error.status === 403 && !body && setupRef.current) {
          setDenied(true);
          setupRef.current.onAccessLost();
        }
        if (error.status === 403 && endpoint === 'deployment-mapping' && body) {
          setEditingDenied(true);
          void client.invalidateQueries({ queryKey: ['identity', userId, revision, 'workspaces'] });
        }
      }
      throw error;
    } finally {
      controllers.current.delete(controller);
    }
  }
  return (
    <section className="mt-6 border-t border-slate-200 pt-6" aria-label="Demo deployment settings">
      <h3 className="text-xl font-semibold">Demo deployment settings for {serviceName}</h3>
      <p className="mt-3 font-semibold">Demo data</p>
      <p className="mt-2 text-slate-600">
        These settings preview sample deployments only. They do not authorize provider access or
        change your workspace metrics.
      </p>
      {editingDenied && (
        <p role="status" className="mt-4">
          You can no longer edit these settings. Saved settings remain available.
        </p>
      )}
      {denied || (query.error instanceof ApiError && query.error.status === 404) ? (
        <p role="alert" className="mt-4">
          These service settings are no longer available to you.
        </p>
      ) : query.isPending ? (
        <p role="status" className="mt-4">
          Loading deployment settings…
        </p>
      ) : query.isError ? (
        <div className="mt-4">
          <p role="alert">{errorMessage(query.error)}</p>
          <button className="control mt-3" type="button" onClick={() => void query.refetch()}>
            Retry deployment settings
          </button>
        </div>
      ) : (
        <>
          {notice && (
            <p
              role="status"
              tabIndex={-1}
              ref={noticeElement}
              className="mt-4 focus-visible:outline-2 focus-visible:outline-indigo-600"
            >
              {notice}
            </p>
          )}
          <MappingEditor
            key={`${query.data?.revision ?? 'unset'}:${reload}:${workspace.role === 'owner' && !editingDenied}`}
            mapping={query.data}
            onStatus={reportEditor}
            configureVisible={setup?.step !== 'collect'}
            owner={workspace.role === 'owner' && !editingDenied}
            valid={valid}
            clearNotice={() => setNotice('')}
            save={async (draft) => {
              const expectedRevision = query.data?.revision ?? null;
              const result = await execute(
                'deployment-mapping',
                (value) => parseSavedMapping(value, scope, expectedRevision),
                { expectedRevision, ...draft },
              );
              client.setQueryData(key, result);
              setNotice('Demo settings saved.');
            }}
            reload={async () => {
              const result = await execute('deployment-mapping', (value) =>
                parseMapping(value, scope),
              );
              client.setQueryData(key, result);
              setReload((previous) => previous + 1);
              setNotice('Saved settings reloaded.');
            }}
            preview={async () => {
              if (!query.data) throw new ApiError(0);
              const mapping = query.data;
              return execute('deployment-preview', (value) => parsePreview(value, mapping), {
                revision: mapping.revision,
              });
            }}
          />
          {query.data && (
            <MockCollectionHistory
              key={`${userId}:${revision}:${workspace.id}:${serviceId}`}
              mapping={query.data}
              {...(setup
                ? {
                    setup: {
                      step: setup.step,
                      onStatus: reportHistory,
                      onAccessLost: accessLost,
                    },
                  }
                : {})}
              owner={workspace.role === 'owner' && !editingDenied}
              userId={userId}
              validSelection={valid}
              reloadMapping={async () => {
                const result = await execute('deployment-mapping', (value) =>
                  parseMapping(value, scope),
                );
                client.setQueryData(key, result);
                setReload((previous) => previous + 1);
                setNotice('Saved settings reloaded.');
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
function MappingEditor({
  mapping,
  owner,
  valid,
  save,
  reload,
  preview,
  clearNotice,
  onStatus,
  configureVisible = true,
}: {
  configureVisible?: boolean;
  onStatus?: (status: { ready: boolean; busy: boolean }) => void;
  mapping: Mapping | null;
  owner: boolean;
  valid: () => boolean;
  save: (draft: Draft) => Promise<void>;
  reload: () => Promise<void>;
  preview: () => Promise<Preview>;
  clearNotice: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(
    mapping ?? {
      primaryProvider: 'github',
      productionEnvironment: 'production',
      exposureAttested: false,
    },
  );
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState('');
  const pending = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
    };
  }, []);
  const setupDirty =
    mapping === null ||
    (draft.scenario ?? 'partial') !== (mapping.scenario ?? 'partial') ||
    draft.primaryProvider !== mapping.primaryProvider ||
    draft.productionEnvironment !== mapping.productionEnvironment ||
    draft.exposureAttested !== mapping.exposureAttested;
  useEffect(() => {
    onStatus?.({ ready: !setupDirty && !conflict, busy: !!busy });
  }, [setupDirty, conflict, busy, onStatus]);
  function edit(next: Draft) {
    epoch.current += 1;
    setDraft(next);
    setDirty(true);
    setResult(null);
    setError('');
    clearNotice();
  }
  async function action(name: string, run: () => Promise<void>) {
    if (pending.current || !valid()) return;
    pending.current = true;
    const ticket = epoch.current;
    setBusy(name);
    setResult(null);
    setError('');
    clearNotice();
    try {
      await run();
    } catch (failure) {
      if (mounted.current && valid() && ticket === epoch.current) {
        if (failure instanceof ApiError && failure.status === 409) {
          setConflict(true);
          setError(
            owner
              ? 'Saved settings changed. Your draft is kept. Reload saved settings before continuing.'
              : 'Saved settings changed. Reload saved settings before previewing.',
          );
        } else setError(errorMessage(failure));
      }
    } finally {
      if (mounted.current && valid()) {
        pending.current = false;
        setBusy('');
      }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!owner || conflict || pending.current) return;
    const environment = draft.productionEnvironment.trim();
    if ([...environment].length < 1 || [...environment].length > 200) {
      setError('Enter a production environment between 1 and 200 characters.');
      return;
    }
    // Send only the contract's editable fields, never response metadata.
    void action('Saving demo settings…', () =>
      save({
        ...(draft.scenario === undefined ? {} : { scenario: draft.scenario }),
        primaryProvider: draft.primaryProvider,
        productionEnvironment: environment,
        exposureAttested: draft.exposureAttested,
      }),
    );
  }
  return (
    <div className="mt-4">
      <div hidden={!configureVisible}>
        {mapping ? (
          <p>
            Saved settings revision {mapping.revision}. Observed at {mapping.observedAt}.{' '}
            {mapping.scenario === 'complete-lifecycle' ? 'Complete lifecycle' : 'Partial lifecycle'}
            .
          </p>
        ) : (
          <p>No demo settings saved for this service.</p>
        )}
        {owner ? (
          <form className="mt-4" onSubmit={submit}>
            <fieldset disabled={!!busy} className="space-y-4">
              <legend className="font-semibold">Fictional deployment source</legend>
              <div>
                <label htmlFor={`${id}-scenario`}>Demo scenario</label>
                <select
                  className="field"
                  id={`${id}-scenario`}
                  aria-describedby={
                    draft.scenario === 'complete-lifecycle' ? `${id}-scenario-help` : undefined
                  }
                  value={draft.scenario ?? 'partial'}
                  onChange={(event) => {
                    const scenario = event.target.value;
                    if (scenario === 'partial' || scenario === 'complete-lifecycle')
                      edit({
                        ...draft,
                        scenario,
                        ...(scenario === 'complete-lifecycle'
                          ? { productionEnvironment: 'production', exposureAttested: true }
                          : {}),
                      });
                  }}
                >
                  <option value="partial">Partial lifecycle</option>
                  <option value="complete-lifecycle">Complete lifecycle</option>
                </select>
                {draft.scenario === 'complete-lifecycle' && (
                  <p id={`${id}-scenario-help`} className="mt-2">
                    Healthy → broken → recovery, January 1–3, 2026 UTC. Complete within demo
                    scenario only. Production environment and sample exposure are fixed. Use a
                    separate service named Fictional lifecycle demo; these records never describe
                    live delivery.
                  </p>
                )}
              </div>
              <div>
                <label htmlFor={`${id}-provider`}>Mock primary provider</label>
                <select
                  className="field"
                  id={`${id}-provider`}
                  value={draft.primaryProvider}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === 'github' || value === 'argocd')
                      edit({ ...draft, primaryProvider: value });
                  }}
                >
                  <option value="github">GitHub</option>
                  <option value="argocd">Argo CD</option>
                </select>
              </div>
              <div>
                <label htmlFor={`${id}-environment`}>Production environment</label>
                <input
                  className="field"
                  id={`${id}-environment`}
                  disabled={draft.scenario === 'complete-lifecycle'}
                  aria-invalid={error.startsWith('Enter a production environment')}
                  aria-describedby={
                    [
                      error ? `${id}-error` : '',
                      draft.scenario === 'complete-lifecycle' ? `${id}-scenario-help` : '',
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  value={draft.productionEnvironment}
                  onChange={(event) =>
                    edit({ ...draft, productionEnvironment: event.target.value })
                  }
                  required
                  autoComplete="off"
                />
              </div>
              <label className="flex items-start gap-3" htmlFor={`${id}-attestation`}>
                <input
                  id={`${id}-attestation`}
                  aria-describedby={
                    draft.scenario === 'complete-lifecycle' ? `${id}-scenario-help` : undefined
                  }
                  disabled={draft.scenario === 'complete-lifecycle'}
                  type="checkbox"
                  checked={draft.exposureAttested}
                  onChange={(event) => edit({ ...draft, exposureAttested: event.target.checked })}
                />
                I attest to production exposure for this MOCK example only. This does not attest to
                real production exposure.
              </label>
            </fieldset>
            <button className="control mt-4" type="submit" disabled={!!busy || conflict}>
              Save demo settings
            </button>
          </form>
        ) : (
          <div className="mt-4">
            <p>Only workspace owners can edit demo settings.</p>
            {mapping && (
              <dl className="mt-3">
                <dt>Demo scenario</dt>
                <dd>
                  {mapping.scenario === 'complete-lifecycle'
                    ? 'Complete lifecycle'
                    : 'Partial lifecycle'}
                </dd>
                <dt>Mock primary provider</dt>
                <dd>{mapping.primaryProvider === 'github' ? 'GitHub' : 'Argo CD'}</dd>
                <dt>Production environment</dt>
                <dd>{mapping.productionEnvironment}</dd>
                <dt>Mock exposure attestation</dt>
                <dd>{mapping.exposureAttested ? 'Included in demo scenario' : 'Not attested'}</dd>
              </dl>
            )}
          </div>
        )}
      </div>
      {error && (
        <p role="alert" id={`${id}-error`} className="mt-3 text-red-700">
          {error}
        </p>
      )}
      {conflict && (
        <button
          className="control mt-3"
          type="button"
          disabled={!!busy}
          onClick={() => void action('Reloading saved settings…', reload)}
        >
          Reload saved settings
        </button>
      )}
      <div hidden={!configureVisible}>
        {mapping && (
          <>
            <button
              className="control mt-4"
              type="button"
              disabled={!!busy || dirty || conflict}
              onClick={() => {
                const ticket = epoch.current;
                void action('Loading preview…', async () => {
                  const value = await preview();
                  if (mounted.current && valid() && epoch.current === ticket) setResult(value);
                });
              }}
            >
              Preview saved demo settings
            </button>
            {dirty && (
              <p className="mt-2">Save your changes before previewing the saved revision.</p>
            )}
          </>
        )}
      </div>
      {busy && (
        <p role="status" className="mt-3">
          {busy}
        </p>
      )}
      <div hidden={!configureVisible}>{result && <PreviewResult preview={result} />}</div>
    </div>
  );
}
function PreviewResult({ preview }: { preview: Preview }) {
  return (
    <section className="mt-6" aria-label="Fictional deployment preview">
      <h4 className="font-semibold">Preview · Saved settings revision {preview.mappingRevision}</h4>
      <p className="mt-2">
        Mock data ·{' '}
        {preview.scenario === 'complete-lifecycle' ? 'Complete lifecycle' : 'Provisional'} ·
        Qualification: {preview.qualification}
      </p>
      <p className="mt-2">
        Rollouts: {preview.rolloutCount}. Qualifying sample deployments:{' '}
        {preview.deploymentFrequency.count}.
      </p>
      <p className="mt-2">
        Sample window: {preview.window.start} to {preview.window.end} (UTC,{' '}
        {preview.window.calendarDays} calendar days).
      </p>
      <p className="mt-2">Evidence cutoff: {preview.evidenceCutoff}.</p>
      {preview.metricResult ? (
        <>
          <p className="mt-2">Complete demo scenario.</p>
          <MetricResults result={preview.metricResult} sourceLabel="Demo" headingLevel={5} />
        </>
      ) : (
        <p className="mt-2">
          Coverage is incomplete. Deployment history and recovery evidence have not been collected.
          Deployments per day, change failure rate and recovery time are unavailable.
        </p>
      )}
      {preview.qualification === 'unknown' && (
        <p className="mt-2">Production exposure is unconfirmed for this selection.</p>
      )}
    </section>
  );
}

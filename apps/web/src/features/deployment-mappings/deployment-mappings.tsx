import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, errorMessage, request, type Workspace } from '../identity/api';
import { useSession } from '../identity/session';
import {
  type Draft,
  type Mapping,
  type Preview,
  parseMapping,
  parsePreview,
  parseSavedMapping,
} from './api';

export function DeploymentMappings({
  workspace,
  serviceId,
  serviceName,
  userId,
  validSelection,
}: {
  workspace: Workspace;
  serviceId: string;
  serviceName: string;
  userId: string;
  validSelection: () => boolean;
}) {
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
      for (const controller of controllers.current) controller.abort();
      void client.cancelQueries({ queryKey: key });
      client.removeQueries({ queryKey: key });
    };
  }, [client, key]);
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) session.expire(revision);
  }, [query.error, session.expire, revision]);
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
          client.removeQueries({ queryKey: key });
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
    <section className="mt-6 border-t border-slate-200 pt-6" aria-label="Mock deployment settings">
      <h3 className="text-xl font-semibold">Mock deployment settings for {serviceName}</h3>
      <p className="mt-3 font-semibold">Mock data · No live provider connected</p>
      <p className="mt-2 text-slate-600">
        These settings preview fictional deployments only. They do not authorize provider access or
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
              setNotice('Mock settings saved.');
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
}: {
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
    void action('Saving mock settings…', () =>
      save({
        primaryProvider: draft.primaryProvider,
        productionEnvironment: environment,
        exposureAttested: draft.exposureAttested,
      }),
    );
  }
  return (
    <div className="mt-4">
      {mapping ? (
        <p>
          Saved mock revision {mapping.revision}. Observed at {mapping.observedAt}.
        </p>
      ) : (
        <p>No mock settings saved for this service.</p>
      )}
      {owner ? (
        <form className="mt-4" onSubmit={submit}>
          <fieldset disabled={!!busy} className="space-y-4">
            <legend className="font-semibold">Fictional deployment source</legend>
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
                <option value="github">GitHub (mock)</option>
                <option value="argocd">Argo CD (mock)</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-environment`}>Production environment (mock)</label>
              <input
                className="field"
                id={`${id}-environment`}
                aria-invalid={error.startsWith('Enter a production environment')}
                aria-describedby={error ? `${id}-error` : undefined}
                value={draft.productionEnvironment}
                onChange={(event) => edit({ ...draft, productionEnvironment: event.target.value })}
                required
                autoComplete="off"
              />
            </div>
            <label className="flex items-start gap-3" htmlFor={`${id}-attestation`}>
              <input
                id={`${id}-attestation`}
                type="checkbox"
                checked={draft.exposureAttested}
                onChange={(event) => edit({ ...draft, exposureAttested: event.target.checked })}
              />
              I attest to production exposure for this MOCK example only. This does not attest to
              real production exposure.
            </label>
          </fieldset>
          <button className="control mt-4" type="submit" disabled={!!busy || conflict}>
            Save mock settings
          </button>
        </form>
      ) : (
        <div className="mt-4">
          <p>Only workspace owners can edit mock settings.</p>
          {mapping && (
            <dl className="mt-3">
              <dt>Mock primary provider</dt>
              <dd>{mapping.primaryProvider === 'github' ? 'GitHub (mock)' : 'Argo CD (mock)'}</dd>
              <dt>Production environment (mock)</dt>
              <dd>{mapping.productionEnvironment}</dd>
              <dt>Mock exposure attestation</dt>
              <dd>
                {mapping.exposureAttested ? 'Attested for this mock example only' : 'Not attested'}
              </dd>
            </dl>
          )}
        </div>
      )}
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
      {mapping && (
        <>
          <button
            className="control mt-4"
            type="button"
            disabled={!!busy || dirty || conflict}
            onClick={() => {
              const ticket = epoch.current;
              void action('Loading fictional preview…', async () => {
                const value = await preview();
                if (mounted.current && valid() && epoch.current === ticket) setResult(value);
              });
            }}
          >
            Preview saved mock settings
          </button>
          {dirty && <p className="mt-2">Save your changes before previewing the saved revision.</p>}
        </>
      )}
      {busy && (
        <p role="status" className="mt-3">
          {busy}
        </p>
      )}
      {result && <PreviewResult preview={result} />}
    </div>
  );
}
function PreviewResult({ preview }: { preview: Preview }) {
  return (
    <section className="mt-6" aria-label="Fictional deployment preview">
      <h4 className="font-semibold">
        Fictional preview · Saved mock revision {preview.mappingRevision}
      </h4>
      <p className="mt-2">Mock data · Provisional · Qualification: {preview.qualification}</p>
      <p className="mt-2">
        Fictional rollouts: {preview.rolloutCount}. Qualifying fictional deployments:{' '}
        {preview.deploymentFrequency.count}.
      </p>
      <p className="mt-2">
        Sample window: {preview.window.start} to {preview.window.end} (UTC,{' '}
        {preview.window.calendarDays} calendar days).
      </p>
      <p className="mt-2">Evidence cutoff: {preview.evidenceCutoff}.</p>
      <p className="mt-2">
        Coverage is incomplete. Deployment history and recovery evidence have not been collected.
        Deployments per day, change failure rate and recovery time are unavailable.
      </p>
      {preview.qualification === 'unknown' && (
        <p className="mt-2">Production exposure is unconfirmed for this mock selection.</p>
      )}
    </section>
  );
}

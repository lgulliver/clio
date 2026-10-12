import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArgoCollection } from '../argo-collection/argo-collection';
import { DeploymentMappings } from '../deployment-mappings/deployment-mappings';
import { GitHubCollection } from '../github-collection/github-collection';
import {
  ApiError,
  errorMessage,
  type Invitation,
  parseAcceptance,
  parseInvitation,
  parseInvitationStatus,
  parseService,
  parseServices,
  parseWorkspace,
  parseWorkspaces,
  request,
  type Workspace,
} from '../identity/api';
import { useSession } from '../identity/session';
import { MeasurementEvidence } from '../measurement-evidence/measurement-evidence';
import { OrganizationSettings } from '../organization/organization-settings';
import { SourceSetupWizard } from '../source-setup/source-setup-wizard';
import { WorkspaceAccess } from './workspace-access';

export function WorkspacePage({ authError }: { authError: boolean }) {
  const session = useSession();
  return (
    <section>
      <h1 className="text-3xl font-semibold tracking-tight">Workspace</h1>
      <p className="mt-4 max-w-2xl leading-7 text-slate-600">
        Organize services and manage workspace access.
      </p>
      {authError && (
        <p className="mt-4 text-red-700" role="alert">
          GitHub sign-in failed. Please try again.
        </p>
      )}
      {session.status === 'ready' && session.user ? (
        <WorkspaceManager key={`${session.user.id}:${session.revision}`} userId={session.user.id} />
      ) : (
        <p className="mt-8">
          {session.status === 'checking'
            ? 'Checking your session…'
            : session.status === 'error'
              ? 'Workspace access is unavailable until your session can be checked.'
              : 'Sign in with GitHub to manage your workspaces.'}
        </p>
      )}
      <div className="panel">
        <h2 className="text-xl font-semibold">Connections</h2>
        <p className="mt-3 text-slate-600">
          Select a workspace and service to manage live GitHub or Argo connections, or demo
          deployment settings.
        </p>
      </div>
    </section>
  );
}
function WorkspaceManager({ userId }: { userId: string }) {
  const session = useSession();
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState('');
  const selection = useRef('');
  const key = ['identity', userId, session.revision, 'workspaces'];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => request('/api/workspaces', parseWorkspaces, { signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401)
      session.expire(session.revision);
  }, [query.error, session.expire, session.revision]);
  if (query.isPending)
    return (
      <p className="mt-8" role="status">
        Loading workspaces…
      </p>
    );
  if (query.isError)
    return (
      <div className="panel">
        <p role="alert">{errorMessage(query.error)}</p>
        <button className="control mt-4" type="button" onClick={() => void query.refetch()}>
          Retry workspaces
        </button>
      </div>
    );
  const active = query.data.find((item) => item.id === selected);
  return (
    <div className="panel">
      <h2 className="text-xl font-semibold">Your workspaces</h2>
      {query.data.length === 0 ? (
        <p className="mt-3">No workspaces yet. Create one or accept an invitation.</p>
      ) : (
        <div className="mt-4">
          <label htmlFor="workspace-selector">Workspace</label>
          <select
            id="workspace-selector"
            className="field"
            value={active?.id ?? ''}
            onChange={(event) => {
              setNotice('');
              selection.current = event.target.value;
              setSelected(event.target.value);
            }}
          >
            <option value="">Choose a workspace</option>
            {query.data.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.role})
              </option>
            ))}
          </select>
        </div>
      )}
      {notice && (
        <p role="status" className="mt-4">
          {notice}
        </p>
      )}
      <WorkspaceScope
        notify={setNotice}
        key={active?.id ?? 'none'}
        workspace={active}
        userId={userId}
        validSelection={() => selection.current === selected}
        select={(id) => {
          selection.current = id;
          setSelected(id);
        }}
      />
    </div>
  );
}
function WorkspaceScope({
  workspace,
  userId,
  validSelection,
  select,
  notify,
}: {
  workspace: Workspace | undefined;
  userId: string;
  validSelection: () => boolean;
  select: (id: string) => void;
  notify: (message: string) => void;
}) {
  const session = useSession();
  const client = useQueryClient();
  const mounted = useRef(true);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const invitationRef = useRef<Invitation | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  // One marker fences all pending creates without retaining cancelled IDs indefinitely.
  const cancellationRevision = useRef<object>({});
  const invitationHeading = useRef<HTMLHeadingElement>(null);
  const invitationArea = useRef<HTMLDivElement>(null);
  const [invitationStatus, setInvitationStatus] = useState<'ready' | 'checking' | 'error'>('ready');
  const statusRef = useRef<'ready' | 'checking' | 'error'>('ready');
  const storeInvitation = useCallback((value: Invitation | null) => {
    if (!value && invitationArea.current?.contains(document.activeElement))
      invitationHeading.current?.focus();
    statusRequest.current?.abort();
    statusRequest.current = null;
    invitationRef.current = value;
    setInvitation(value);
  }, []);
  function tokenStatus(value: 'ready' | 'checking' | 'error') {
    if (value !== statusRef.current && invitationArea.current?.contains(document.activeElement))
      invitationHeading.current?.focus();
    statusRef.current = value;
    setInvitationStatus(value);
  }
  const [denied, setDenied] = useState('');
  const [showAccess, setShowAccess] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const setupTrigger = useRef<HTMLButtonElement>(null);
  const deniedAlert = useRef<HTMLParagraphElement>(null);
  const setupOpen = showSetup && workspace?.role === 'owner';
  useEffect(() => {
    if (workspace?.role !== 'owner') setShowSetup(false);
  }, [workspace?.role]);
  useEffect(() => {
    if (denied) deniedAlert.current?.focus();
  }, [denied]);
  const [selectedService, setSelectedService] = useState('');
  const [sourceMode, setSourceMode] = useState<'mock' | 'live' | 'argo'>('mock');
  const serviceSelection = useRef('');
  const mutationEpoch = useRef(0);
  const revision = session.revision;
  const valid = () => mounted.current && session.current(revision) && validSelection();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      statusRequest.current?.abort();
    };
  }, []);
  const workspacesKey = ['identity', userId, revision, 'workspaces'];
  const workspaceId = workspace?.id;
  const measurementAccessLost = useCallback(() => {
    if (!mounted.current || !session.current(revision) || !validSelection()) return;
    mutationEpoch.current += 1;
    storeInvitation(null);
    setDenied('Workspace access changed. Refresh your workspace access.');
    void client.invalidateQueries({ queryKey: ['identity', userId, revision, 'workspaces'] });
  }, [client, revision, session.current, userId, validSelection, storeInvitation]);
  const servicesKey = useMemo(
    () => ['identity', userId, revision, 'workspace', workspaceId, 'services'],
    [userId, revision, workspaceId],
  );
  const services = useQuery({
    queryKey: servicesKey,
    queryFn: ({ signal }) => {
      if (!workspace) throw new ApiError(0);
      return request(
        `/api/workspaces/${workspace.id}/services`,
        (value) => parseServices(value, workspace.id),
        { signal },
      );
    },
    enabled: !!workspace,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (services.error instanceof ApiError && services.error.status === 401)
      session.expire(revision);
  }, [services.error, session.expire, revision]);
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: servicesKey });
      client.removeQueries({ queryKey: servicesKey });
    },
    [client, servicesKey],
  );
  async function mutate<T>(
    path: string,
    body: object,
    parse: (value: unknown) => T,
    success: (value: T) => void,
  ) {
    const ticket = mutationEpoch.current;
    try {
      const result = await request(path, parse, { body });
      if (
        session.current(revision) &&
        (path === '/api/workspaces' || path === '/api/workspace-invitations/accept')
      )
        void client.invalidateQueries({ queryKey: workspacesKey });
      if (valid() && ticket === mutationEpoch.current) success(result);
    } catch (error) {
      if (!valid() || ticket !== mutationEpoch.current) return;
      if (error instanceof ApiError && error.status === 401) session.expire(revision);
      if (
        workspace &&
        path.startsWith(`/api/workspaces/${workspace.id}/`) &&
        error instanceof ApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        mutationEpoch.current += 1;
        storeInvitation(null);
        setDenied(errorMessage(error));
        void client.invalidateQueries({ queryKey: workspacesKey });
      }
      throw error;
    }
  }
  async function verifyInvitation(current: Invitation) {
    const cancellation = cancellationRevision.current;
    const ticket = mutationEpoch.current;
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    tokenStatus('checking');
    try {
      const pending = await request(
        `/api/workspaces/${current.workspaceId}/invitations/${current.id}/status`,
        parseInvitationStatus,
        { signal: controller.signal },
      );
      if (
        !valid() ||
        controller.signal.aborted ||
        statusRequest.current !== controller ||
        ticket !== mutationEpoch.current ||
        cancellation !== cancellationRevision.current ||
        invitationRef.current !== current
      )
        return;
      if (!pending) storeInvitation(null);
      tokenStatus('ready');
    } catch (error) {
      if (
        !valid() ||
        controller.signal.aborted ||
        statusRequest.current !== controller ||
        ticket !== mutationEpoch.current ||
        cancellation !== cancellationRevision.current ||
        invitationRef.current !== current
      )
        return;
      if (error instanceof ApiError && error.status === 401) session.expire(revision);
      else if (error instanceof ApiError && [403, 404].includes(error.status)) {
        mutationEpoch.current += 1;
        storeInvitation(null);
        setDenied(errorMessage(error));
        void client.invalidateQueries({ queryKey: workspacesKey });
      } else tokenStatus('error');
    }
  }
  function cancelledInvitations(ids: string[], hasMore: boolean) {
    if (!valid()) return;
    cancellationRevision.current = {};
    const current = invitationRef.current;
    if (!current) return;
    if (ids.includes(current.id.toLowerCase())) storeInvitation(null);
    // Omitted IDs are uncertain on overflow; recheck rather than discard another grant.
    else if (hasMore || statusRef.current !== 'ready') void verifyInvitation(current);
  }
  const activeService = services.data?.find((item) => item.id === selectedService);
  return (
    <>
      <ActionForm
        label="Workspace name"
        action="Create workspace"
        valid={valid}
        submit={(name) =>
          mutate('/api/workspaces', { name }, parseWorkspace, (created) => {
            client.setQueryData<Workspace[]>(workspacesKey, (previous) => [
              ...(previous ?? []),
              created,
            ]);
            select(created.id);
          })
        }
      />
      <ActionForm
        label="Invitation token"
        action="Accept invitation"
        sensitive
        valid={valid}
        submit={(token) =>
          mutate('/api/workspace-invitations/accept', { token }, parseAcceptance, (id) => {
            notify('Invitation accepted.');
            select(id);
          })
        }
      />
      {workspace && (
        <div className="mt-8 border-t border-slate-200 pt-6">
          <h2 className="text-xl font-semibold">{workspace.name}</h2>
          <p className="mt-2">Your role: {workspace.role}</p>
          {denied ? (
            <div className="mt-4">
              <p role="alert" tabIndex={-1} ref={deniedAlert}>
                {denied}
              </p>
              <button className="control mt-3" type="button" onClick={session.refresh}>
                Refresh access
              </button>
            </div>
          ) : services.isPending ? (
            <p role="status" className="mt-4">
              Loading services…
            </p>
          ) : services.isError ? (
            <div className="mt-4">
              <p role="alert">{errorMessage(services.error)}</p>
              <button
                type="button"
                className="control mt-3"
                onClick={() => void services.refetch()}
              >
                Retry services
              </button>
            </div>
          ) : (
            <>
              {!setupOpen && (
                <OrganizationSettings
                  key={services.data.map((item) => item.id).join('.')}
                  workspace={workspace}
                  services={services.data}
                  validSelection={valid}
                  onAccessLost={measurementAccessLost}
                />
              )}
              <h3 className="mt-6 font-semibold">Services</h3>
              {workspace.role === 'owner' && (
                <>
                  <button
                    ref={setupTrigger}
                    className="control mt-3"
                    type="button"
                    aria-expanded={setupOpen}
                    aria-disabled={setupOpen}
                    onClick={() => {
                      if (setupOpen) return;
                      serviceSelection.current = '';
                      setSelectedService('');
                      setShowSetup(true);
                    }}
                  >
                    Set up a data source
                  </button>
                  {setupOpen && (
                    <SourceSetupWizard
                      workspace={workspace}
                      services={services.data ?? []}
                      userId={userId}
                      validSelection={valid}
                      onAccessLost={measurementAccessLost}
                      onClose={() => {
                        setShowSetup(false);
                        setupTrigger.current?.focus();
                      }}
                      createServiceForm={
                        <ActionForm
                          label="New service name"
                          action="Create service for setup"
                          valid={valid}
                          submit={(name) =>
                            mutate(
                              `/api/workspaces/${workspace.id}/services`,
                              { name },
                              (value) => parseService(value, workspace.id),
                              () => {
                                void client.invalidateQueries({ queryKey: servicesKey });
                              },
                            )
                          }
                        />
                      }
                    />
                  )}
                </>
              )}
              <div hidden={setupOpen}>
                {services.data?.length ? (
                  <ul className="mt-3 list-inside list-disc">
                    {services.data.map((item) => (
                      <li key={item.id}>
                        {item.name}{' '}
                        <button
                          type="button"
                          className="control ml-2"
                          aria-label={`Demo settings for ${item.name}`}
                          aria-pressed={selectedService === item.id && sourceMode === 'mock'}
                          onClick={() => {
                            serviceSelection.current = `mock:${item.id}`;
                            setSourceMode('mock');
                            setSelectedService(item.id);
                          }}
                        >
                          Demo settings
                        </button>
                        <button
                          type="button"
                          className="control ml-2"
                          aria-label={`Live GitHub for ${item.name}`}
                          aria-pressed={selectedService === item.id && sourceMode === 'live'}
                          onClick={() => {
                            serviceSelection.current = `live:${item.id}`;
                            setSourceMode('live');
                            setSelectedService(item.id);
                          }}
                        >
                          Live GitHub
                        </button>
                        <button
                          type="button"
                          className="control ml-2"
                          aria-label={`Live Argo for ${item.name}`}
                          aria-pressed={selectedService === item.id && sourceMode === 'argo'}
                          onClick={() => {
                            serviceSelection.current = `argo:${item.id}`;
                            setSourceMode('argo');
                            setSelectedService(item.id);
                          }}
                        >
                          Live Argo
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3">No services yet.</p>
                )}
                {activeService && sourceMode === 'mock' && (
                  <DeploymentMappings
                    key={selectedService}
                    workspace={workspace}
                    serviceId={selectedService}
                    serviceName={activeService.name}
                    userId={userId}
                    validSelection={() =>
                      valid() && serviceSelection.current === `mock:${selectedService}`
                    }
                  />
                )}
                {activeService && sourceMode === 'live' && (
                  <GitHubCollection
                    workspace={workspace}
                    serviceId={selectedService}
                    serviceName={activeService.name}
                    userId={userId}
                    validSelection={() =>
                      valid() && serviceSelection.current === `live:${selectedService}`
                    }
                  />
                )}
                {activeService && sourceMode === 'argo' && (
                  <ArgoCollection
                    workspace={workspace}
                    serviceId={selectedService}
                    serviceName={activeService.name}
                    userId={userId}
                    validSelection={() =>
                      valid() && serviceSelection.current === `argo:${selectedService}`
                    }
                  />
                )}
              </div>
              {workspace.role === 'owner' ? (
                <>
                  {!setupOpen && activeService && (
                    <MeasurementEvidence
                      workspaceId={workspace.id}
                      serviceId={activeService.id}
                      serviceName={activeService.name}
                      onAccessLost={measurementAccessLost}
                    />
                  )}
                  {!setupOpen && (
                    <ActionForm
                      label="Service name"
                      action="Create service"
                      valid={valid}
                      submit={(name) =>
                        mutate(
                          `/api/workspaces/${workspace.id}/services`,
                          { name },
                          (value) => parseService(value, workspace.id),
                          () => {
                            void client.invalidateQueries({ queryKey: servicesKey });
                          },
                        )
                      }
                    />
                  )}
                  <div hidden={setupOpen}>
                    <button
                      className="control mt-6"
                      type="button"
                      aria-expanded={showAccess}
                      onClick={() => setShowAccess((previous) => !previous)}
                    >
                      {showAccess ? 'Hide access management' : 'Manage workspace access'}
                    </button>
                    {showAccess && (
                      <WorkspaceAccess
                        workspaceId={workspace.id}
                        userId={userId}
                        validSelection={valid}
                        onInvitationCancelled={(id) =>
                          cancelledInvitations([id.toLowerCase()], false)
                        }
                        onCancellationUncertain={() => cancelledInvitations([], true)}
                        onMemberRevoked={(result) =>
                          cancelledInvitations(result.cancelledInvitationIds, result.hasMore)
                        }
                        onDenied={(error) => {
                          mutationEpoch.current += 1;
                          storeInvitation(null);
                          setDenied(errorMessage(error));
                          void client.invalidateQueries({ queryKey: workspacesKey });
                        }}
                      />
                    )}
                    <h3
                      ref={invitationHeading}
                      tabIndex={-1}
                      className="mt-8 font-semibold focus-visible:outline focus-visible:outline-2"
                    >
                      Invite a member
                    </h3>
                    <p className="mt-2 text-slate-600">
                      Share the token manually. Acceptance requires the member’s matching verified
                      email. Invitations expire after seven days.
                    </p>
                    <ActionForm
                      label="Member email"
                      action="Create invitation"
                      type="email"
                      valid={valid}
                      submit={(email) => {
                        storeInvitation(null);
                        tokenStatus('ready');
                        const cancellation = cancellationRevision.current;
                        return mutate(
                          `/api/workspaces/${workspace.id}/invitations`,
                          { email },
                          (value) => parseInvitation(value, workspace.id),
                          (created) => {
                            storeInvitation(created);
                            if (cancellation !== cancellationRevision.current)
                              void verifyInvitation(created);
                            void client.invalidateQueries({
                              queryKey: [
                                'identity',
                                userId,
                                revision,
                                'workspace',
                                workspace.id,
                                'access',
                              ],
                            });
                          },
                        );
                      }}
                    />
                    {invitation && invitationStatus !== 'ready' && (
                      <div ref={invitationArea} className="mt-4">
                        <p role={invitationStatus === 'error' ? 'alert' : 'status'}>
                          {invitationStatus === 'checking'
                            ? 'Checking invitation availability…'
                            : 'Invitation availability could not be checked. Retry before sharing.'}
                        </p>
                        {invitationStatus === 'error' && (
                          <button
                            type="button"
                            className="control mt-3"
                            onClick={() => {
                              invitationHeading.current?.focus();
                              void verifyInvitation(invitation);
                            }}
                          >
                            Retry invitation check
                          </button>
                        )}
                        <button
                          type="button"
                          className="control mt-3"
                          onClick={() => {
                            invitationHeading.current?.focus();
                            storeInvitation(null);
                          }}
                        >
                          Dismiss token
                        </button>
                      </div>
                    )}
                    {invitation && invitationStatus === 'ready' && (
                      <div ref={invitationArea} className="mt-4">
                        <label htmlFor="created-invitation">
                          Invitation token — copy and share once
                        </label>
                        <input
                          id="created-invitation"
                          className="field font-mono"
                          readOnly
                          value={invitation.token}
                          onFocus={(event) => event.currentTarget.select()}
                        />
                        <p className="mt-2">
                          For {invitation.email}. This token disappears when you leave this
                          workspace.
                        </p>
                        <button
                          type="button"
                          className="control mt-3"
                          onClick={() => {
                            invitationHeading.current?.focus();
                            storeInvitation(null);
                          }}
                        >
                          Dismiss token
                        </button>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <p className="mt-4 text-slate-600">
                  Members can read services. Only owners can create services or invite members.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
function ActionForm({
  label,
  action,
  submit,
  valid,
  type = 'text',
  sensitive = false,
}: {
  label: string;
  action: string;
  submit: (value: string) => Promise<void>;
  valid: () => boolean;
  type?: 'text' | 'email';
  sensitive?: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !valid()) return;
    const input = value.trim();
    if (!input || (!sensitive && type === 'text' && [...input].length > 200)) {
      setError('Enter between 1 and 200 characters.');
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    if (sensitive) setValue('');
    try {
      await submit(input);
      if (valid()) setValue('');
    } catch (failure) {
      if (valid()) setError(errorMessage(failure));
    } finally {
      if (mounted.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <form className="mt-6" onSubmit={(event) => void onSubmit(event)}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="field"
        type={type}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        required
        readOnly={busy}
        autoComplete="off"
        spellCheck={!sensitive}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} className="mt-2 text-red-700" role="alert">
          {error}
        </p>
      )}
      <button className="control mt-3" type="submit" aria-disabled={busy}>
        {busy ? `${action}…` : action}
      </button>
      {busy && (
        <span className="ml-3" role="status">
          Saving…
        </span>
      )}
    </form>
  );
}

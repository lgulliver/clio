import { Link } from '@tanstack/react-router';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArgoCollection } from '../argo-collection/argo-collection';
import { DeploymentMappings } from '../deployment-mappings/deployment-mappings';
import { GitHubCollection } from '../github-collection/github-collection';
import type { Service, Workspace } from '../identity/api';
import { MeasurementEvidence } from '../measurement-evidence/measurement-evidence';
import type { SourceSetupPresentation, SourceSetupStatus } from './provider-state';

type Source = 'github' | 'argocd' | 'mock';
const steps = ['Service', 'Source', 'Connection', 'Collection', 'Evidence'];
const emptyStatus: SourceSetupStatus = { ready: false, busy: false, hasSavedResult: false };
const sources: { id: Source; name: string; description: string; guide: string }[] = [
  {
    id: 'github',
    name: 'GitHub Deployments',
    description: 'Track deployments from a selected repository and production environment.',
    guide: 'connect-github.md',
  },
  {
    id: 'argocd',
    name: 'Argo CD',
    description:
      'Track operations for a selected Application, including separate GitOps repositories.',
    guide: 'connect-argocd.md',
  },
  {
    id: 'mock',
    name: 'Fictional demo',
    description: 'Try the collection workflow with sample deployments. No live provider access.',
    guide: 'synthetic-lifecycle-demo.md',
  },
];

export function SourceSetupWizard({
  workspace,
  services,
  userId,
  validSelection,
  onAccessLost,
  onClose,
  createServiceForm,
}: {
  workspace: Workspace;
  services: Service[];
  userId: string;
  validSelection: () => boolean;
  onAccessLost: () => void;
  onClose: () => void;
  createServiceForm: ReactNode;
}) {
  const [step, setStep] = useState(0);
  const [serviceId, setServiceId] = useState('');
  const [source, setSource] = useState<Source | null>(null);
  const [status, setStatus] = useState(emptyStatus);
  const [blocked, setBlocked] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const selection = useRef('');
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const closePrompt = useRef<HTMLDivElement>(null);
  const id = useId();
  const service = services.find((item) => item.id === serviceId);
  const selectedSource = sources.find((item) => item.id === source);
  const ticket = `${serviceId}:${source ?? ''}`;
  const valid = useCallback(
    () => mounted.current && validSelection() && selection.current === ticket,
    [ticket, validSelection],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (blocked || steps[step]) heading.current?.focus();
  }, [step, blocked]);
  useEffect(() => {
    if (confirmClose && !status.busy) {
      if (closePrompt.current?.contains(document.activeElement)) heading.current?.focus();
      setConfirmClose(false);
    }
  }, [confirmClose, status.busy]);
  const onStatus = useCallback(
    (next: SourceSetupStatus) => {
      if (!valid()) return;
      setStatus((previous) =>
        previous.ready === next.ready &&
        previous.busy === next.busy &&
        previous.hasSavedResult === next.hasSavedResult
          ? previous
          : next,
      );
    },
    [valid],
  );
  const accessLost = useCallback(() => {
    if (!valid()) return;
    setBlocked(true);
    setStatus(emptyStatus);
    onAccessLost();
  }, [valid, onAccessLost]);
  const setup: SourceSetupPresentation = {
    step: step === 2 ? 'configure' : 'collect',
    onStatus,
    onAccessLost: accessLost,
  };
  const canAdvance =
    !blocked &&
    (step === 0
      ? service !== undefined
      : step === 1
        ? source !== null
        : step === 2
          ? status.ready && !status.busy
          : step === 3
            ? status.ready && status.hasSavedResult && !status.busy
            : false);
  function close() {
    if (!validSelection()) return;
    if (status.busy) setConfirmClose(true);
    else onClose();
  }
  if (workspace.role !== 'owner') return null;
  return (
    <section className="setup-wizard" aria-label="Data source setup wizard">
      <div className="setup-heading">
        <div>
          <h3 className="text-xl font-semibold">Set up a data source</h3>
          <p className="mt-1 text-sm text-clio-muted">
            {workspace.name}
            {service ? ` / ${service.name}` : ''}
          </p>
        </div>
        <button type="button" className="text-action" onClick={close}>
          Close setup
        </button>
      </div>
      <ol className="setup-progress" aria-label="Setup progress">
        {steps.map((name, index) => (
          <li key={name} aria-current={step === index ? 'step' : undefined}>
            <span className="setup-step-number" aria-hidden="true">
              {index + 1}
            </span>
            <span>{name}</span>
          </li>
        ))}
      </ol>
      <h4 ref={heading} tabIndex={-1} className="setup-step-heading">
        Step {step + 1} of {steps.length}: {steps[step]}
      </h4>
      {confirmClose && (
        <div
          ref={closePrompt}
          role="alert"
          className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm"
        >
          <p>
            Request confirmation is still pending. Closing does not cancel work already accepted.
            Check source history before submitting again.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              className="control"
              type="button"
              onClick={() => {
                setConfirmClose(false);
                heading.current?.focus();
              }}
            >
              Keep setup
            </button>
            <button
              className="text-action"
              type="button"
              onClick={() => {
                if (validSelection()) onClose();
              }}
            >
              Close setup anyway
            </button>
          </div>
        </div>
      )}
      {blocked ? (
        <p role="alert">Source access changed. Refresh workspace access before continuing.</p>
      ) : (
        <>
          {step === 0 && (
            <div>
              <p className="setup-help">
                Choose the service whose deployments you want to measure.
              </p>
              <label htmlFor={`${id}-service`} className="block mt-4">
                Service for setup
              </label>
              <select
                id={`${id}-service`}
                className="field"
                value={serviceId}
                disabled={status.busy}
                onChange={(event) => {
                  const next = event.target.value;
                  selection.current = `${next}:${source ?? ''}`;
                  setServiceId(next);
                  setStatus(emptyStatus);
                }}
              >
                <option value="">Choose a service</option>
                {services.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              {services.length === 0 && (
                <p className="mt-3 text-sm">Create your first service to continue.</p>
              )}
              <details className="saved-context" open={services.length === 0}>
                <summary>Create a service</summary>
                {createServiceForm}
              </details>
            </div>
          )}
          {step === 1 && (
            <fieldset>
              <legend className="setup-help">Where does this service deploy?</legend>
              <div className="setup-source-list">
                {sources.map((item) => (
                  <label key={item.id} className="setup-source-option">
                    <input
                      type="radio"
                      name={`${id}-source`}
                      value={item.id}
                      checked={source === item.id}
                      disabled={status.busy}
                      onChange={() => {
                        selection.current = `${serviceId}:${item.id}`;
                        setSource(item.id);
                        setStatus(emptyStatus);
                      }}
                    />
                    <span>
                      <span className="block font-semibold">{item.name}</span>
                      <span className="setup-help">{item.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {step === 2 && selectedSource && (
            <div className="setup-help">
              <p>
                {source === 'mock'
                  ? 'Save demo settings before collecting. No live provider access is needed.'
                  : 'Save the source scope before collecting. Provider credentials stay with your Clio operator.'}
              </p>
              {selectedSource.guide && (
                <a
                  className="text-action mt-2 inline-block"
                  href={`https://github.com/lgulliver/clio/blob/main/docs/providers/${selectedSource.guide}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open {selectedSource.name} setup guide
                </a>
              )}
            </div>
          )}
          {step === 3 && (
            <p className="setup-help">
              {source === 'mock'
                ? 'Collect saved demo settings, or review a successful saved demo result.'
                : 'Choose a closed reporting window and collect it.'}{' '}
              Continue once a saved result exists for this configuration revision. A queued request
              is still waiting for its worker.
            </p>
          )}
          {service && source && (
            <div hidden={step !== 2 && step !== 3}>
              {source === 'github' ? (
                <GitHubCollection
                  key={ticket}
                  workspace={workspace}
                  serviceId={service.id}
                  serviceName={service.name}
                  userId={userId}
                  validSelection={valid}
                  setup={setup}
                />
              ) : source === 'argocd' ? (
                <ArgoCollection
                  key={ticket}
                  workspace={workspace}
                  serviceId={service.id}
                  serviceName={service.name}
                  userId={userId}
                  validSelection={valid}
                  setup={setup}
                />
              ) : (
                <DeploymentMappings
                  key={ticket}
                  workspace={workspace}
                  serviceId={service.id}
                  serviceName={service.name}
                  userId={userId}
                  validSelection={valid}
                  setup={setup}
                />
              )}
            </div>
          )}
          {step === 4 && service && source && (
            <div>
              <p className="setup-help">
                Saved collection available. Coverage still depends on supporting evidence;
                connection setup alone cannot establish complete metrics.
              </p>
              {source === 'mock' ? (
                <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  This demo uses sample data. Choose Partial or Complete lifecycle. Complete
                  coverage applies only within this demo scenario; neither scenario establishes live
                  source coverage or a native measurement basis.
                </p>
              ) : (
                <>
                  <EvidenceChecklist />
                  <MeasurementEvidence
                    workspaceId={workspace.id}
                    serviceId={service.id}
                    serviceName={service.name}
                    basisProvider={source}
                    onAccessLost={accessLost}
                  />
                </>
              )}
              <Link className="text-action mt-6 inline-block" to="/">
                View saved measurements in Overview
              </Link>
            </div>
          )}
          <div className="setup-actions">
            {step > 0 && (
              <button
                type="button"
                className="control setup-secondary"
                onClick={() => {
                  if (validSelection()) setStep(step - 1);
                }}
              >
                Back
              </button>
            )}
            {step < 4 ? (
              <button
                type="button"
                className="control"
                aria-disabled={!canAdvance}
                onClick={() => {
                  if (canAdvance && validSelection()) setStep(step + 1);
                }}
              >
                Next: {steps[step + 1]}
              </button>
            ) : (
              <button type="button" className="control" onClick={close}>
                Finish setup review
              </button>
            )}
          </div>
          {status.busy && (
            <p className="setup-help mt-3" role="status">
              Request confirmation is pending. Keep the source selected and retry or review its
              history before continuing.
            </p>
          )}
          {step === 2 && !status.ready && (
            <p className="setup-help mt-3">
              Save a current connection or mapping to continue. Unsaved changes and missing access
              need attention.
            </p>
          )}
          {step === 3 && !status.hasSavedResult && (
            <p className="setup-help mt-3" role="status">
              Waiting for a successful saved collection. Review worker status or collection errors
              above.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function EvidenceChecklist() {
  return (
    <section className="mt-5" aria-label="Evidence checklist">
      <h5 className="font-semibold">Evidence needed for complete measurements</h5>
      <p className="setup-help mt-2">
        Review these requirements with your source operator. Received reports and saved assessments
        below establish what is available.
      </p>
      <dl className="setup-evidence-list">
        <div>
          <dt>Deployment population</dt>
          <dd>An exhaustive census of qualified production deployments and reconciled gaps.</dd>
        </div>
        <div>
          <dt>Change history</dt>
          <dd>Application-source revisions, first-deployment links and the required history.</dd>
        </div>
        <div>
          <dt>Outcome classifications</dt>
          <dd>Failure and incident-driven rework classifications for deployments.</dd>
        </div>
        <div>
          <dt>Recovery evidence</dt>
          <dd>Failure episodes, confirmed recovery and open or unresolved episodes.</dd>
        </div>
      </dl>
      <a
        className="text-action"
        href="https://github.com/lgulliver/clio/blob/main/docs/providers/connect-measurement-evidence.md"
        target="_blank"
        rel="noreferrer"
      >
        Open independent evidence setup guide
      </a>
    </section>
  );
}

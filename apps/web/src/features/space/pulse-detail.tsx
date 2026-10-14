import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../identity/api';
import { PulseNotificationControls } from '../notifications/delivery-summary';
import { type Pulse, parsePulse } from './api';
import { formatReferencePeriod } from './period';
import { PulseResponse } from './pulse-response';
import { DimensionResults, PulseContext } from './pulse-results';
import { readFailure, useSpaceRead, useSpaceScope } from './space-scope';

type Action = 'close' | 'cancel';
const confirmations: Record<Action, { prompt: string; confirm: string; keep: string }> = {
  close: {
    prompt:
      'Close this pulse? Responses stop, results are calculated once and raw answers are deleted. Closed pulses cannot reopen.',
    confirm: 'Confirm close pulse',
    keep: 'Keep pulse open',
  },
  cancel: {
    prompt:
      'Cancel this pulse? It will never publish results or counts, and any raw answers are deleted.',
    confirm: 'Confirm cancel pulse',
    keep: 'Keep pulse',
  },
};

export function PulseDetail({
  pulseId,
  still,
  onEditDraft,
  missingText = 'This pulse is no longer available. Choose another pulse from the list.',
}: {
  pulseId: string;
  still: () => boolean;
  onEditDraft: (pulse: Pulse) => void;
  missingText?: string;
}) {
  const scope = useSpaceScope();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const query = useSpaceRead(`pulse/${pulseId}`, `${scope.path}/pulses/${pulseId}`, (value) =>
    parsePulse(value, { workspaceId: scope.workspace.id, role: scope.workspace.role, pulseId }),
  );
  useEffect(() => {
    if (action) confirmButton.current?.focus();
  }, [action]);
  async function run(kind: Action) {
    setError('');
    setNotice('');
    const outcome = await scope.mutate({
      path: `/pulses/${pulseId}/${kind}`,
      body: {},
      parse: (value) =>
        parsePulse(value, { workspaceId: scope.workspace.id, role: 'owner', pulseId }),
      owner: true,
      still,
    });
    if (outcome.status === 'stale') return;
    setAction(null);
    if (outcome.status === 'failed') {
      setError(
        outcome.error instanceof ApiError && outcome.error.status === 409
          ? 'This pulse changed before your request completed. Its current state is shown.'
          : outcome.error instanceof ApiError && outcome.error.status === 404
            ? 'This pulse is no longer available. The pulse list has been refreshed.'
            : errorMessage(outcome.error),
      );
      scope.refresh();
      heading.current?.focus();
      return;
    }
    const expected = kind === 'close' ? 'closed' : 'cancelled';
    setNotice(
      outcome.value.state === expected
        ? kind === 'close'
          ? 'Pulse closed. Its results are now fixed.'
          : 'Pulse cancelled. It will not publish results.'
        : 'The pulse state has changed. Its current state is shown.',
    );
    scope.refresh();
    heading.current?.focus();
  }
  if (query.isPending || query.checking) return <p role="status">Loading pulse…</p>;
  if (query.missing)
    return (
      <p role="status" className="panel">
        {missingText}
      </p>
    );
  if (query.isError)
    return (
      <div className="panel">
        <p role="alert">{readFailure(query, 'This pulse is unavailable right now.')}</p>
        <button className="control mt-3" type="button" onClick={() => void query.refetch()}>
          Retry pulse
        </button>
      </div>
    );
  const pulse = query.data;
  return (
    <article className="panel space-pulse-detail" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} ref={heading} tabIndex={-1} className="space-step-heading">
        {pulse.teamName} pulse · {formatReferencePeriod(pulse.referenceStart, pulse.referenceEnd)}
      </h3>
      <PulseContext pulse={pulse} owner={scope.owner} />
      {scope.owner && (pulse.state === 'draft' || pulse.state === 'open') && (
        <div className="space-wizard-actions">
          {pulse.state === 'draft' && (
            <button type="button" className="control" onClick={() => onEditDraft(pulse)}>
              Continue setup
            </button>
          )}
          {pulse.state === 'open' && (
            <button
              type="button"
              className="control"
              aria-expanded={action === 'close'}
              onClick={() => setAction('close')}
            >
              Close pulse
            </button>
          )}
          <button
            type="button"
            className="space-secondary space-danger"
            aria-expanded={action === 'cancel'}
            onClick={() => setAction('cancel')}
          >
            {pulse.state === 'draft' ? 'Cancel draft' : 'Cancel pulse'}
          </button>
        </div>
      )}
      {action && scope.owner && (
        <fieldset className="space-confirm">
          <legend>{confirmations[action].prompt}</legend>
          <button
            ref={confirmButton}
            type="button"
            className={action === 'cancel' ? 'control space-danger-fill' : 'control'}
            aria-disabled={scope.busy}
            onClick={() => {
              if (!scope.busy) void run(action);
            }}
          >
            {confirmations[action].confirm}
          </button>
          <button type="button" className="space-secondary" onClick={() => setAction(null)}>
            {confirmations[action].keep}
          </button>
        </fieldset>
      )}
      {pulse.state === 'open' &&
        (pulse.eligible && !pulse.submitted ? (
          <PulseResponse
            key={pulse.id}
            pulse={pulse}
            still={still}
            onSubmitted={(outcome) => {
              setNotice(
                outcome === 'submitted'
                  ? 'Response submitted. Your answers are not shown again and cannot be changed.'
                  : 'This pulse is no longer accepting new responses. Your unsent answers were discarded.',
              );
              scope.refresh();
            }}
          />
        ) : pulse.submitted ? (
          <p className="space-note">
            You have responded to this pulse. Answers cannot be viewed or changed.
          </p>
        ) : (
          <p className="space-note">
            You are not on this pulse&apos;s frozen roster. People assigned to the team after it
            opened take part in a later pulse.
          </p>
        ))}
      {pulse.state === 'cancelled' && pulse.submitted && (
        <p className="space-note">
          Your earlier response was discarded when this pulse was cancelled.
        </p>
      )}
      {pulse.state === 'closed' && (
        <p className="space-muted">Closed pulses are immutable and cannot reopen.</p>
      )}
      {pulse.state !== 'draft' && <DimensionResults pulse={pulse} headingLevel={4} />}
      {scope.owner && (pulse.state === 'open' || pulse.state === 'closed') && (
        <PulseNotificationControls
          key={`notifications-${pulse.id}`}
          pulseId={pulse.id}
          state={pulse.state}
        />
      )}
      {scope.busy && <p role="status">Updating pulse…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

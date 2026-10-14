import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../identity/api';
import type { Team } from '../organization/api';
import { dimensions, instrument, type Pulse, parsePulse, scaleLabel } from './api';
import {
  defaultReferenceInputs,
  formatReferencePeriod,
  inputsFromReference,
  referenceFromInputs,
} from './period';
import { useSpaceRead, useSpaceScope } from './space-scope';

const steps = ['Team', 'Period and roster', 'Questions', 'Open'] as const;
type Step = 0 | 1 | 2 | 3;

export const openConflictMessage =
  'Opening was refused because it conflicts with another pulse. Only one pulse can be open per team, and reference periods cannot overlap open or closed pulses that share participants. Your draft is still saved: change its reference period, or close the other pulse first.';

/**
 * Owner setup: choose team, save a draft to review the live roster/minimum, preview the eight
 * original items, then explicitly open. Nothing is created or opened on mount.
 */
export function PulseWizard({
  teams,
  draft: initialDraft,
  now,
  onClose,
}: {
  teams: readonly Team[];
  draft: Pulse | null;
  now: () => Date;
  onClose: () => void;
}) {
  const scope = useSpaceScope();
  const id = useId();
  const alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<Step>(0);
  // The last write result; live reads of the same draft replace it once they are newer.
  const [local, setLocal] = useState<{ pulse: Pulse | null; at: number }>({
    pulse: initialDraft,
    at: 0,
  });
  const draftId = local.pulse?.id ?? '';
  const live = useSpaceRead(
    `wizard/draft/${draftId}`,
    `${scope.path}/pulses/${draftId}`,
    (value) =>
      parsePulse(value, { workspaceId: scope.workspace.id, role: 'owner', pulseId: draftId }),
    draftId !== '',
  );
  const draft =
    live.data && !live.isError && live.dataUpdatedAt >= local.at ? live.data : local.pulse;
  // Review values must come from a successful server reply for this draft.
  const previewVerified =
    draft !== null && !live.isError && !live.checking && !live.missing && draft.state === 'draft';
  const [opened, setOpened] = useState<Pulse | null>(null);
  const [teamId, setTeamId] = useState(initialDraft?.teamId ?? '');
  const initialInputs = initialDraft
    ? inputsFromReference(initialDraft.referenceStart, initialDraft.referenceEnd)
    : defaultReferenceInputs(now());
  const [firstDay, setFirstDay] = useState(initialInputs.firstDay);
  const [lastDay, setLastDay] = useState(initialInputs.lastDay);
  const [createUncertain, setCreateUncertain] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const focusRequest = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (focusRequest.current) heading.current?.focus();
    focusRequest.current = false;
  });
  const still = () => alive.current;
  const team = teams.find((item) => item.id === teamId);
  const savedInputs = draft ? inputsFromReference(draft.referenceStart, draft.referenceEnd) : null;
  const saved =
    draft !== null &&
    previewVerified &&
    draft.teamId === teamId &&
    savedInputs?.firstDay === firstDay &&
    savedInputs.lastDay === lastDay;
  function go(next: Step) {
    setError('');
    setNotice('');
    setConfirmCancel(false);
    focusRequest.current = true;
    setStep(next);
  }
  async function saveDraft() {
    setError('');
    setNotice('');
    if (!team) {
      setError('Choose a current team.');
      return;
    }
    const bounds = referenceFromInputs(firstDay, lastDay, now());
    if ('error' in bounds) {
      setError(bounds.error);
      return;
    }
    if (!draft && createUncertain) {
      setError(
        'An earlier save could not be confirmed. Close setup and continue from the pulse list if a draft was saved.',
      );
      return;
    }
    const body = { teamId: team.id, ...bounds };
    const outcome = await scope.mutate({
      path: draft ? `/pulses/${draft.id}` : '/pulses',
      ...(draft ? { method: 'PATCH' as const } : {}),
      body,
      parse: (value) =>
        parsePulse(value, {
          workspaceId: scope.workspace.id,
          role: 'owner',
          ...(draft ? { pulseId: draft.id } : {}),
        }),
      owner: true,
      still,
    });
    if (outcome.status === 'stale') return;
    if (outcome.status === 'failed') {
      const status = outcome.error instanceof ApiError ? outcome.error.status : 0;
      if (!draft && (status === 0 || status >= 500)) setCreateUncertain(true);
      setError(
        status === 404
          ? draft
            ? 'This draft or its team is no longer available. Close setup and check the pulse list.'
            : 'This team is no longer available. Choose a current team.'
          : status === 409
            ? draft
              ? 'This draft can no longer be edited. It may have been opened or cancelled elsewhere. Close setup and check the pulse list.'
              : 'This draft conflicts with the current team state. Refresh and try again.'
            : !draft && (status === 0 || status >= 500)
              ? 'Saving could not be confirmed. Close setup and check the pulse list for a saved draft before trying again.'
              : errorMessage(outcome.error),
      );
      scope.refresh();
      return;
    }
    const value = outcome.value;
    if (
      value.state !== 'draft' ||
      value.teamId !== body.teamId ||
      value.referenceStart !== body.referenceStart ||
      value.referenceEnd !== body.referenceEnd
    ) {
      setError('The saved draft could not be verified. Close setup and check the pulse list.');
      scope.refresh();
      return;
    }
    setLocal({ pulse: value, at: Date.now() });
    setNotice('Draft saved. Review the live roster and minimum below.');
    scope.refresh();
  }
  async function openPulse() {
    if (!draft || !saved || draft.rosterSize === 0) return;
    setError('');
    setNotice('');
    const outcome = await scope.mutate({
      path: `/pulses/${draft.id}/open`,
      body: {},
      parse: (value) =>
        parsePulse(value, { workspaceId: scope.workspace.id, role: 'owner', pulseId: draft.id }),
      owner: true,
      still,
    });
    if (outcome.status === 'stale') return;
    if (outcome.status === 'failed') {
      setError(
        outcome.error instanceof ApiError && outcome.error.status === 409
          ? openConflictMessage
          : outcome.error instanceof ApiError && outcome.error.status === 404
            ? 'This draft is no longer available. Close setup and check the pulse list.'
            : errorMessage(outcome.error),
      );
      scope.refresh();
      return;
    }
    if (outcome.value.state !== 'open') {
      setError('The pulse state could not be verified. Check the pulse list.');
      scope.refresh();
      return;
    }
    focusRequest.current = true;
    setOpened(outcome.value);
    scope.refresh();
  }
  async function cancelDraft() {
    if (!draft) return;
    setError('');
    const outcome = await scope.mutate({
      path: `/pulses/${draft.id}/cancel`,
      body: {},
      parse: (value) =>
        parsePulse(value, { workspaceId: scope.workspace.id, role: 'owner', pulseId: draft.id }),
      owner: true,
      still,
    });
    if (outcome.status === 'stale') return;
    if (outcome.status === 'failed') {
      setError(errorMessage(outcome.error));
      scope.refresh();
      return;
    }
    scope.refresh();
    onClose();
  }
  const reviewed = saved && draft;
  const elsewhere = live.missing
    ? 'This draft is no longer available. Close setup and check the pulse list.'
    : draft && draft.state !== 'draft'
      ? `This draft was ${draft.state === 'cancelled' ? 'cancelled' : 'opened'} elsewhere. Close setup and check the pulse list.`
      : '';
  const previewFailed = draftId !== '' && live.isError && !live.checking && !live.missing;
  const refreshPreview = draftId !== '' && (step === 1 || step === 3) && (
    <button
      type="button"
      className="space-secondary"
      onClick={() => {
        void live.refetch();
      }}
    >
      Refresh roster and minimum
    </button>
  );
  return (
    <section className="space-wizard" aria-labelledby={`${id}-title`}>
      <div className="space-section-heading">
        <h3 id={`${id}-title`}>{initialDraft ? 'Continue pulse setup' : 'Set up a team pulse'}</h3>
        <button type="button" className="space-secondary" onClick={onClose}>
          {opened ? 'Done' : 'Close setup'}
        </button>
      </div>
      {opened ? (
        <div className="space-wizard-body">
          <h4 ref={heading} tabIndex={-1} className="space-step-heading">
            Pulse opened for {opened.teamName}
          </h4>
          <p>
            The roster of {opened.rosterSize}, minimum of {opened.minimumRespondents} and reference
            period {formatReferencePeriod(opened.referenceStart, opened.referenceEnd)} are now
            frozen.
          </p>
          <p className="space-muted">
            Clio messages participants only if an owner has enabled pulse notifications for this
            workspace. Pulses are never created or closed automatically. Participants can always
            open Developer experience in Clio to respond.
          </p>
        </div>
      ) : (
        <>
          <ol className="space-progress" aria-label="Pulse setup steps">
            {steps.map((label, index) => (
              <li key={label} aria-current={index === step ? 'step' : undefined}>
                <span className="setup-step-number" aria-hidden="true">
                  {index + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
          <div className="space-wizard-body">
            <h4 ref={heading} tabIndex={-1} className="space-step-heading">
              Step {step + 1} of {steps.length}: {steps[step]}
            </h4>
            {step === 0 && (
              <>
                {teams.length === 0 ? (
                  <p>Create a team in Workspace before setting up a pulse.</p>
                ) : (
                  <>
                    <label htmlFor={`${id}-team`}>Team</label>
                    <select
                      id={`${id}-team`}
                      className="field"
                      value={team ? team.id : ''}
                      disabled={scope.busy}
                      onChange={(event) => setTeamId(event.target.value)}
                    >
                      <option value="">Choose a team</option>
                      {teams.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <p className="space-muted">
                  The pulse covers people currently assigned to this primary team. Products and
                  services do not subdivide survey cohorts.
                </p>
              </>
            )}
            {step === 1 && (
              <>
                <p className="space-muted">
                  The reference period is the past interval people reflect on, separate from when
                  the pulse is open. Default: the previous 14 UTC calendar days.
                </p>
                <div className="space-date-fields">
                  <label>
                    First day (UTC)
                    <input
                      className="field"
                      type="date"
                      value={firstDay}
                      readOnly={scope.busy}
                      onChange={(event) => setFirstDay(event.target.value)}
                    />
                  </label>
                  <label>
                    Last day (UTC, inclusive)
                    <input
                      className="field"
                      type="date"
                      value={lastDay}
                      readOnly={scope.busy}
                      onChange={(event) => setLastDay(event.target.value)}
                    />
                  </label>
                </div>
                <button
                  className="control mt-4"
                  type="button"
                  aria-disabled={scope.busy || saved || elsewhere !== ''}
                  onClick={() => {
                    if (!scope.busy && !saved && !elsewhere) void saveDraft();
                  }}
                >
                  {draft ? 'Update draft' : 'Save draft'}
                </button>
                {reviewed && <DraftReview draft={draft} />}
                {refreshPreview}
                {draft && !saved && !elsewhere && !previewFailed && (
                  <p className="space-muted">
                    Changes are not saved yet. Update the draft to review the current roster.
                  </p>
                )}
              </>
            )}
            {step === 2 && <QuestionPreview />}
            {step === 3 && elsewhere === '' && previewFailed && refreshPreview}
            {elsewhere && (
              <p role="alert" className="space-warning">
                {elsewhere}
              </p>
            )}
            {previewFailed && (
              <p role="alert">
                The current roster and minimum could not be verified. Refresh before continuing.
              </p>
            )}
            {step === 3 && !reviewed && !elsewhere && !previewFailed && (
              <p>Save the draft with the current team and dates before opening.</p>
            )}
            {step === 3 && reviewed && (
              <>
                <DraftReview draft={draft} />
                {refreshPreview}
                <p>
                  Opening freezes the team name, reference period, minimum, instrument and roster.
                  The roster cannot grow after opening and closed pulses cannot reopen.
                  Notifications go out only if an owner has enabled them for this workspace.
                </p>
                <button
                  className="control mt-4"
                  type="button"
                  aria-disabled={scope.busy || draft.rosterSize === 0}
                  onClick={() => {
                    if (!scope.busy && draft.rosterSize > 0) void openPulse();
                  }}
                >
                  Open pulse for responses
                </button>
              </>
            )}
          </div>
          <div className="space-wizard-actions">
            {step > 0 && (
              <button
                type="button"
                className="space-secondary"
                onClick={() => go((step - 1) as Step)}
              >
                Back
              </button>
            )}
            {step < 3 && (
              <button
                type="button"
                className="control"
                aria-disabled={(step === 0 && !team) || (step === 1 && !saved) || scope.busy}
                onClick={() => {
                  if ((step === 0 && !team) || (step === 1 && !saved) || scope.busy) return;
                  go((step + 1) as Step);
                }}
              >
                {step === 0
                  ? 'Next: period and roster'
                  : step === 1
                    ? 'Next: preview questions'
                    : 'Next: open'}
              </button>
            )}
            {draft && draft.state === 'draft' && !elsewhere && !confirmCancel && (
              <button
                type="button"
                className="space-secondary space-danger"
                onClick={() => setConfirmCancel(true)}
              >
                Cancel draft
              </button>
            )}
          </div>
          {confirmCancel && draft && (
            <fieldset className="space-confirm">
              <legend>Cancel this draft? It will never open or publish results.</legend>
              <button
                type="button"
                className="control space-danger-fill"
                aria-disabled={scope.busy}
                onClick={() => {
                  if (!scope.busy) void cancelDraft();
                }}
              >
                Confirm cancel draft
              </button>
              <button
                type="button"
                className="space-secondary"
                onClick={() => setConfirmCancel(false)}
              >
                Keep draft
              </button>
            </fieldset>
          )}
        </>
      )}
      {scope.busy && <p role="status">Saving pulse…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function DraftReview({ draft }: { draft: Pulse }) {
  return (
    <div className="space-review">
      <dl className="space-context">
        <div>
          <dt>Team</dt>
          <dd>{draft.teamName}</dd>
        </div>
        <div>
          <dt>Reference period</dt>
          <dd>{formatReferencePeriod(draft.referenceStart, draft.referenceEnd)}</dd>
        </div>
        <div>
          <dt>Roster preview</dt>
          <dd>
            {draft.rosterSize} currently assigned {draft.rosterSize === 1 ? 'member' : 'members'}
          </dd>
        </div>
        <div>
          <dt>Minimum answers per question</dt>
          <dd>{draft.minimumRespondents}</dd>
        </div>
      </dl>
      <p className="space-muted">
        Roster and minimum are live until opening, then frozen. Moving people later does not change
        an open pulse.
      </p>
      {draft.rosterSize === 0 ? (
        <p className="space-warning" role="alert">
          No members are assigned to this team. Assign primary teams before opening.
        </p>
      ) : draft.rosterSize < draft.minimumRespondents ? (
        <p className="space-warning">
          The roster ({draft.rosterSize}) is smaller than the minimum ({draft.minimumRespondents}).
          You can open it, but every question result will remain suppressed because the roster
          cannot grow after opening.
        </p>
      ) : null}
    </div>
  );
}

export function QuestionPreview() {
  return (
    <div className="space-preview">
      <p className="space-muted">
        Eight original Clio pilot items, each answered on a 1–5 scale or skipped with “Prefer not to
        answer / not applicable”. They are not a validated psychometric scale.
      </p>
      {dimensions.map((dimension) => (
        <div key={dimension.id}>
          <h5>{dimension.label}</h5>
          <ul>
            {instrument.questions
              .filter((question) => question.dimension === dimension.id)
              .map((question) => (
                <li key={question.id}>
                  {question.prompt}
                  <small>
                    {[1, 2, 3, 4, 5]
                      .map((value) => `${value} ${scaleLabel(question.scale, value)}`)
                      .join(' · ')}
                  </small>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

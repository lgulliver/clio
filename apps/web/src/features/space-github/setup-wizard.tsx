import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../identity/api';
import type { Team } from '../organization/api';
import { formatReferencePeriod } from '../space/period';
import { useSpaceScope } from '../space/space-scope';
import {
  type OperationGrant,
  type OperationMapping,
  type OperationRun,
  parseOperationMapping,
} from './api';
import { CollectWindow } from './mapping-detail';

const steps = ['Source and team', 'Scope and limits', 'Save and collect', 'Saved result'] as const;
type Step = 0 | 1 | 2 | 3;

function grantKey(grant: OperationGrant) {
  return `${grant.appId}:${grant.installationId}:${grant.accountId}`;
}
export function grantLabel(grant: OperationGrant) {
  return `App ${grant.appId} · installation ${grant.installationId} · ${grant.accountType} account ${grant.accountId}`;
}

/**
 * Owner setup in four explicit stages. Until the server verifies the chosen repository on save,
 * only granted numeric IDs are shown. Nothing is saved or collected without a confirmation, and
 * the wizard state survives read-only refreshes; the role-scoped parent remounts on role change.
 */
export function OperationsSetupWizard({
  grants,
  teams,
  now,
  onClose,
  onOpen,
}: {
  grants: readonly OperationGrant[];
  teams: readonly Team[];
  now: () => Date;
  onClose: () => void;
  onOpen: (mapping: OperationMapping) => void;
}) {
  const scope = useSpaceScope();
  const id = useId();
  const alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusRequest = useRef(false);
  const [step, setStep] = useState<Step>(0);
  const [source, setSource] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const [saved, setSaved] = useState<OperationMapping | null>(null);
  const [run, setRun] = useState<OperationRun | null>(null);
  const [error, setError] = useState('');
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
  const grant = grants.find((item) => grantKey(item) === source);
  const repository = grant?.repositoryIds.find((item) => String(item) === repositoryId);
  const team = teams.find((item) => item.id === teamId);
  const ready = grant !== undefined && repository !== undefined && team !== undefined;
  const revoked = !saved && ((source !== '' && !grant) || (repositoryId !== '' && !repository));
  const blocked =
    (step === 0 && !ready && !saved) || (step === 1 && !reviewed) || (step === 2 && !saved);
  function go(next: Step) {
    setError('');
    setConfirming(false);
    focusRequest.current = true;
    setStep(next);
  }
  async function save() {
    if (!grant || repository === undefined || !team || saved) return;
    if (saveUncertain) {
      setError(
        'An earlier save could not be confirmed. Close setup and check the repository list before trying again.',
      );
      return;
    }
    setError('');
    const body = {
      teamId: team.id,
      installationId: grant.installationId,
      repositoryId: repository,
    };
    const outcome = await scope.mutate({
      path: '/github/mappings',
      body,
      parse: (value) => {
        const mapping = parseOperationMapping(value, { workspaceId: scope.workspace.id });
        if (
          mapping.teamId !== body.teamId ||
          mapping.installationId !== body.installationId ||
          mapping.repositoryId !== body.repositoryId ||
          mapping.appId !== grant.appId ||
          !mapping.connected
        )
          throw new ApiError(0);
        return mapping;
      },
      owner: true,
      still,
    });
    if (outcome.status === 'stale') return;
    setConfirming(false);
    if (outcome.status === 'failed') {
      const code = outcome.error instanceof ApiError ? outcome.error.status : 0;
      if (code === 0 || code >= 500) setSaveUncertain(true);
      setError(
        code === 409
          ? 'This repository is already connected in this workspace or its grant changed. Close setup and check the repository list.'
          : code === 404
            ? 'This team or repository grant is no longer available. Refresh and choose again.'
            : code === 0 || code >= 500
              ? 'Saving could not be confirmed. Close setup and check the repository list before trying again.'
              : errorMessage(outcome.error),
      );
      scope.refresh();
      return;
    }
    setSaved(outcome.value);
    scope.refresh();
  }
  return (
    <section className="space-wizard" aria-labelledby={`${id}-title`}>
      <div className="space-section-heading">
        <h3 id={`${id}-title`}>Connect a GitHub repository</h3>
        <button type="button" className="space-secondary" onClick={onClose}>
          {saved ? 'Done' : 'Close setup'}
        </button>
      </div>
      <ol className="space-progress" aria-label="Repository setup steps">
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
        {step === 0 &&
          (grants.length === 0 ? (
            <p>No GitHub repositories are available to connect for this workspace yet.</p>
          ) : (
            <>
              <label htmlFor={`${id}-grant`}>GitHub installation</label>
              <select
                id={`${id}-grant`}
                className="field"
                value={source}
                disabled={scope.busy || saved !== null}
                onChange={(event) => {
                  setSource(event.target.value);
                  setRepositoryId('');
                }}
              >
                <option value="">Choose an installation</option>
                {grants.map((item) => (
                  <option key={grantKey(item)} value={grantKey(item)}>
                    {grantLabel(item)}
                  </option>
                ))}
              </select>
              <label htmlFor={`${id}-repository`}>Repository</label>
              <select
                id={`${id}-repository`}
                className="field"
                value={repositoryId}
                disabled={scope.busy || saved !== null || !grant}
                onChange={(event) => setRepositoryId(event.target.value)}
              >
                <option value="">Choose a repository</option>
                {(grant?.repositoryIds ?? []).map((item) => (
                  <option key={item} value={String(item)}>
                    Repository ID {item}
                  </option>
                ))}
              </select>
              <label htmlFor={`${id}-team`}>Owning team</label>
              <select
                id={`${id}-team`}
                className="field"
                value={teamId}
                disabled={scope.busy || saved !== null}
                onChange={(event) => setTeamId(event.target.value)}
              >
                <option value="">Choose a team</option>
                {teams.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <p className="space-muted">
                Repository names appear after Clio verifies the repository with GitHub when you
                save. Each repository has exactly one owning team; deleted teams cannot own new
                connections.
              </p>
              {teams.length === 0 && <p>Create a team in Workspace before connecting.</p>}
            </>
          ))}
        {step === 1 && (
          <div className="space-privacy">
            <h4>Before you connect</h4>
            <p>
              Clio uses a separate GitHub App with Pull requests: read and Metadata: read on
              selected repositories only. It does not ask for access to repository code.
            </p>
            <p>
              GitHub&apos;s pull request and review responses also include titles, descriptions and
              review text. Clio discards these while processing each response and does not save
              them. It keeps only opened, merged and review times, review outcomes, and whether each
              author or reviewer is a person, a bot or unknown, including whether a review came from
              the pull request&apos;s author.
            </p>
            <p>
              One explicit owning team per repository. Shared repositories still need a single
              owner; Clio never infers ownership from authors or branches.
            </p>
            <p>
              Each collection reads at most 20 pages or 1,000 pull requests, 100 review pages per
              pull request and 10,000 reviews. Larger histories are marked incomplete rather than
              silently truncated; if review reading stops early, newer pull requests are more likely
              to be timed.
            </p>
            <p>
              PR review time (open to merge) and Time to first human review (open to first review)
              are elapsed times that include draft time, author work and queues; they do not measure
              active review effort. Each needs at least 3 timed PRs. First-review timing only counts
              reviews observed before the window ends, so it is biased toward shorter waits.
            </p>
            <p>
              Clio stores no usernames or person IDs, but in a small repository these figures can
              still be attributable to a single person. They are not anonymous survey results and do
              not use the pulse reporting minimum. Results are shown per repository, never as team
              totals or personal scores.
            </p>
            <label className="space-options">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => setReviewed(event.target.checked)}
              />{' '}
              I have reviewed the scope, limits and attribution notes
            </label>
          </div>
        )}
        {step === 2 && (
          <>
            {!saved && ready && (
              <>
                <p>
                  Repository ID {repository} through {grantLabel(grant)}, owned by {team.name}.
                </p>
                {!confirming ? (
                  <button
                    type="button"
                    className="control"
                    aria-disabled={scope.busy}
                    onClick={() => {
                      if (!scope.busy) setConfirming(true);
                    }}
                  >
                    Save connection
                  </button>
                ) : (
                  <fieldset className="space-confirm">
                    <legend>
                      Save repository ID {repository} for {team.name}? Clio verifies access with
                      GitHub before saving. Nothing is collected yet.
                    </legend>
                    <button
                      type="button"
                      className="control"
                      aria-disabled={scope.busy}
                      onClick={() => {
                        if (!scope.busy) void save();
                      }}
                    >
                      Confirm save
                    </button>
                    <button
                      type="button"
                      className="space-secondary"
                      onClick={() => setConfirming(false)}
                    >
                      Do not save
                    </button>
                  </fieldset>
                )}
              </>
            )}
            {saved && (
              <>
                <p role="status">
                  Verified repository {saved.repositoryLabel} connected to {saved.teamName}.
                </p>
                {!run ? (
                  <CollectWindow
                    mapping={saved}
                    now={now}
                    still={still}
                    onQueued={(queued) => {
                      setRun(queued);
                      go(3);
                    }}
                  />
                ) : (
                  <p>Collection already queued for this setup.</p>
                )}
              </>
            )}
          </>
        )}
        {step === 3 && saved && (
          <>
            {run ? (
              <p>
                Collection queued for {saved.repositoryLabel},{' '}
                {formatReferencePeriod(run.windowStart, run.windowEnd)}. It runs in the background;
                use Refresh saved results to check progress. Refreshing never starts collection.
              </p>
            ) : (
              <p>
                {saved.repositoryLabel} is connected but not collected yet. Collect a window from
                the repository view when you choose.
              </p>
            )}
            <button type="button" className="control" onClick={() => onOpen(saved)}>
              View saved results
            </button>
          </>
        )}
        {revoked && step < 2 && (
          <p className="space-warning" role="alert">
            The selected installation or repository is no longer granted. Choose again.
          </p>
        )}
      </div>
      <div className="space-wizard-actions">
        {step > 0 && step < 3 && (
          <button type="button" className="space-secondary" onClick={() => go((step - 1) as Step)}>
            Back
          </button>
        )}
        {step < 3 && (
          <button
            type="button"
            className="control"
            aria-disabled={blocked || scope.busy}
            onClick={() => {
              if (!blocked && !scope.busy) go((step + 1) as Step);
            }}
          >
            {step === 0
              ? 'Next: scope and limits'
              : step === 1
                ? 'Next: save and collect'
                : 'Next: saved result'}
          </button>
        )}
      </div>
      {scope.busy && <p role="status">Saving…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

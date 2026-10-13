import { useId } from 'react';
import { formatReferencePeriod, formatTimestamp } from '../space/period';
import {
  type GapReason,
  type OperationResult,
  type RunReason,
  type Signal,
  type SignalId,
  signalLabels,
} from './api';

/** A historical team choice offered to the parent's existing team selection. */
export type HistoricalTeam = { id: string; name: string; archived: boolean };

const hours = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Displayed value only for provisional numbers; empty cohorts and small samples are gaps. */
export function signalValue(signal: Signal): string {
  if (signal.status === 'no_observations' || signal.value === null)
    return signal.status === 'insufficient_samples' ? 'Insufficient samples' : 'No observations';
  return signal.unit === 'hours' ? `${hours.format(signal.value)} h` : String(signal.value);
}

/** Sample wording with the fixed three-PR duration minimum, independent of survey suppression. */
export function sampleText(signal: Signal): string {
  if (signal.unit === 'hours')
    return `${signal.sampleCount} timed ${signal.sampleCount === 1 ? 'PR' : 'PRs'}; minimum 3`;
  const noun =
    signal.id === 'reviews_submitted'
      ? signal.sampleCount === 1
        ? 'review record'
        : 'review records'
      : signal.sampleCount === 1
        ? 'PR'
        : 'PRs';
  return `${signal.sampleCount} ${noun} observed`;
}

export function signalStatus(signal: Signal): string {
  if (signal.status === 'provisional') return 'Provisional';
  if (signal.status === 'no_observations') return 'No observations in this window';
  return `Insufficient samples (${signal.sampleCount} timed ${
    signal.sampleCount === 1 ? 'PR' : 'PRs'
  }; minimum 3)`;
}

export const signalNotes: Readonly<Record<SignalId, string>> = {
  pulls_opened:
    'Distinct PRs created in this window, including drafts and bot PRs. Observed within collection limits; not a complete history.',
  pulls_merged:
    'Distinct PRs merged in this window, including bot and unknown-author PRs. A PR may have been opened before the window.',
  reviews_submitted:
    'Submitted human review records, excluding self reviews, bots, pending and unknown accounts. Several records can come from one person; this is not a count of reviewers.',
  open_to_first_review:
    'Median from opening to the first qualifying human review, for human-authored PRs opened in this window. Includes draft time. Only PRs with a review observed before the window ended are timed, so results are biased toward shorter waits; it is not a ready-for-review wait time.',
  open_to_merge:
    'Median from opening to merge for human-authored PRs merged in this window. Elapsed lifecycle time including draft time, author work and queues; not measured active review effort and not deployment lead time.',
};

export const gapLabels: Readonly<Record<GapReason, string>> = {
  discovery_limit: 'PR discovery stopped at a page or PR limit',
  review_limit: 'Review traversal stopped at a review limit',
  fact_limit: 'Collected facts reached the storage limit',
  byte_limit: 'A response reached the size limit',
  active_time_limit: 'Collection reached its active-time limit',
  record_conflict: 'Conflicting records were excluded',
  invalid_time: 'Records with invalid times were excluded',
  unknown_actor: 'Records with unknown accounts were excluded from human cohorts',
};

export const runReasonLabels: Readonly<Record<RunReason, string>> = {
  scope_changed: 'the repository connection changed before collection finished',
  disconnected: 'the repository was disconnected',
  grant_removed: 'access to this repository was removed',
  expired: 'collection did not finish within 24 hours',
  provider_unavailable: 'GitHub was unavailable',
  invalid_provider_data: 'GitHub returned data Clio could not verify',
  retry_exhausted: 'collection failed after repeated attempts',
};

/** Five separate repository cards; never totals or averages across repositories or teams. */
export function ResultCards({
  result,
  currentTeamIds,
  onTeamSelect,
}: {
  result: OperationResult;
  currentTeamIds: ReadonlySet<string>;
  onTeamSelect?: ((team: HistoricalTeam) => void) | undefined;
}) {
  const id = useId();
  const review = result.calculated.reviewContext;
  return (
    <div className="space-github-result">
      <dl className="space-context">
        <div>
          <dt>Repository</dt>
          <dd>{result.repositoryLabel}</dd>
        </div>
        <div>
          <dt>Team recorded with this result</dt>
          <dd>
            {result.teamName}
            {!currentTeamIds.has(result.teamId) && ' (team deleted)'}
            {onTeamSelect && (
              <button
                type="button"
                className="text-action ml-2"
                onClick={() =>
                  onTeamSelect({
                    id: result.teamId,
                    name: result.teamName,
                    archived: !currentTeamIds.has(result.teamId),
                  })
                }
              >
                View {result.teamName} team history
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt>Window</dt>
          <dd>{formatReferencePeriod(result.windowStart, result.windowEnd)}</dd>
        </div>
        <div>
          <dt>Collected from GitHub</dt>
          <dd>
            {formatTimestamp(result.acquisitionStartedAt)} to{' '}
            {formatTimestamp(result.acquisitionEndedAt)}
          </dd>
        </div>
        <div>
          <dt>Saved</dt>
          <dd>{formatTimestamp(result.completedAt)}</dd>
        </div>
        <div>
          <dt>Connection revision</dt>
          <dd>{result.mappingRevision}</dd>
        </div>
        <div>
          <dt>PR discovery</dt>
          <dd>
            {result.discoveryTraversalComplete
              ? 'All listed pages read within limits'
              : 'Incomplete: stopped before the end of the listing'}
          </dd>
        </div>
        <div>
          <dt>Review traversal</dt>
          <dd>
            {result.reviewTraversalComplete
              ? 'Finished for every discovered PR'
              : 'Incomplete for some PRs'}
          </dd>
        </div>
      </dl>
      <ul className="space-dimension-grid" aria-label={`Signals for ${result.repositoryLabel}`}>
        {result.calculated.signals.map((signal) => (
          <li key={signal.id}>
            <article className="space-dimension-card" aria-labelledby={`${id}-${signal.id}`}>
              <h5 id={`${id}-${signal.id}`}>{signalLabels[signal.id]}</h5>
              <p className="space-question-value">
                <strong>{signalValue(signal)}</strong>
              </p>
              <p className="space-muted">
                {signalStatus(signal)} · {sampleText(signal)}
              </p>
              <p className="space-muted">{signalNotes[signal.id]}</p>
              {signal.id === 'open_to_first_review' && (
                <p className="space-muted">
                  PRs opened in this window: {review.reviewed} timed with an observed review,{' '}
                  {review.noQualifyingReview} with no qualifying review observed,{' '}
                  {review.unknownTraversal} not timed because review traversal was incomplete,{' '}
                  {review.excludedActors} excluded because the author was a bot or unknown.
                </p>
              )}
            </article>
          </li>
        ))}
      </ul>
      {result.gaps.length > 0 && (
        <div className="space-note">
          <p>Collection limits and exclusions for this result:</p>
          <ul className="list-disc pl-5">
            {result.gaps.map((gap) => (
              <li key={gap}>{gapLabels[gap]}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="space-muted">
        Values are provisional observations from GitHub listings, which can change and are not an
        atomic snapshot. Clio stores no usernames or titles, but a small or single-contributor
        repository can still make these figures attributable to one person.
      </p>
    </div>
  );
}

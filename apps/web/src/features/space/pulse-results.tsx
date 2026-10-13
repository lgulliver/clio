import { dimensions, instrument, type Pulse, type QuestionResult, scaleLabel } from './api';
import { formatReferencePeriod, formatTimestamp } from './period';

export function formatMean(mean: number) {
  return mean.toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

export function stateLabel(state: Pulse['state']) {
  switch (state) {
    case 'draft':
      return 'Draft';
    case 'open':
      return 'Open for responses';
    case 'closed':
      return 'Closed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** Visible participation follows the server's role-specific counts; nothing is inferred. */
export function participation(pulse: Pulse, owner: boolean): string {
  switch (pulse.state) {
    case 'draft':
      return `Live roster preview: ${pulse.rosterSize} currently assigned. No responses exist.`;
    case 'open':
      return pulse.submittedCount !== null
        ? `${pulse.submittedCount} of ${pulse.rosterSize} frozen roster submitted so far.`
        : 'Participation counts are visible only to workspace owners while the pulse is open.';
    case 'closed':
      return pulse.submittedCount !== null
        ? `${pulse.submittedCount} of ${pulse.rosterSize} frozen roster submitted.${
            owner && pulse.submittedCount < pulse.minimumRespondents
              ? ' Below the minimum; members see this count as withheld.'
              : ''
          }`
        : `Participation withheld: fewer than ${pulse.minimumRespondents} submitted.`;
    case 'cancelled':
      return 'Cancelled pulses publish no participation counts or results.';
  }
}

/**
 * Labels describe what each team name/size actually is: a live preview for drafts, values
 * captured at cancellation for pulses that never opened (no frozen roster exists), and frozen
 * opening context otherwise.
 */
export function contextLabels(pulse: Pick<Pulse, 'state' | 'openedAt'>) {
  if (pulse.state === 'draft') return { team: 'Team', roster: 'Roster preview' };
  if (pulse.state === 'cancelled' && pulse.openedAt === null)
    return {
      team: 'Team captured at cancellation',
      roster: 'Team size captured at cancellation',
    };
  return { team: 'Team at opening', roster: 'Frozen roster size' };
}

export function PulseContext({ pulse, owner }: { pulse: Pulse; owner: boolean }) {
  const labels = contextLabels(pulse);
  return (
    <dl className="space-context">
      <div>
        <dt>{labels.team}</dt>
        <dd>{pulse.teamName}</dd>
      </div>
      <div>
        <dt>Reference period</dt>
        <dd>{formatReferencePeriod(pulse.referenceStart, pulse.referenceEnd)}</dd>
      </div>
      <div>
        <dt>State</dt>
        <dd>{stateLabel(pulse.state)}</dd>
      </div>
      <div>
        <dt>{labels.roster}</dt>
        <dd>{pulse.rosterSize}</dd>
      </div>
      <div>
        <dt>Reporting minimum per question</dt>
        <dd>{pulse.minimumRespondents}</dd>
      </div>
      <div>
        <dt>Participation</dt>
        <dd>{participation(pulse, owner)}</dd>
      </div>
      {pulse.openedAt && (
        <div>
          <dt>Opened</dt>
          <dd>{formatTimestamp(pulse.openedAt)}</dd>
        </div>
      )}
      {pulse.closedAt && (
        <div>
          <dt>Closed</dt>
          <dd>{formatTimestamp(pulse.closedAt)}</dd>
        </div>
      )}
      {pulse.cancelledAt && (
        <div>
          <dt>Cancelled</dt>
          <dd>{formatTimestamp(pulse.cancelledAt)}</dd>
        </div>
      )}
    </dl>
  );
}

function QuestionValue({ result, pulse }: { result: QuestionResult | undefined; pulse: Pulse }) {
  const question = instrument.questions.find((item) => item.id === result?.questionId);
  if (!result || !question) return null;
  if (result.status === 'suppressed')
    return (
      <div className="space-question-value">
        <strong>Suppressed</strong>
        <span>
          Fewer than {pulse.minimumRespondents} answered this question. The count is withheld.
        </span>
      </div>
    );
  const position = ((result.mean - 1) / 4) * 100;
  return (
    <div className="space-question-value">
      <strong>
        {formatMean(result.mean)}
        <span className="space-scale-suffix"> on 1–5</span>
      </strong>
      <span className="space-scale-track" aria-hidden="true">
        <span style={{ left: `${position}%` }} />
      </span>
      <span>
        1 {scaleLabel(question.scale, 1).toLowerCase()} · 5{' '}
        {scaleLabel(question.scale, 5).toLowerCase()}
      </span>
      <span>
        {result.answeredCount} answered of {pulse.rosterSize} · minimum {pulse.minimumRespondents}
      </span>
    </div>
  );
}

/** Question means grouped under their dimension. No dimension or overall score is calculated. */
export function DimensionResults({
  pulse,
  headingLevel = 3,
}: {
  pulse: Pulse;
  headingLevel?: 3 | 4;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  if (pulse.state !== 'closed' || !pulse.questions)
    return (
      <p className="space-muted">
        {pulse.state === 'cancelled'
          ? 'Cancelled pulses never publish results.'
          : 'Results are published only after an owner closes the pulse.'}
      </p>
    );
  const results = pulse.questions;
  return (
    <ul
      className="space-dimension-grid grid auto-rows-fr"
      aria-label={`Results by SPACE dimension for ${pulse.teamName}`}
    >
      {dimensions.map((dimension) => (
        <li key={dimension.id} className="space-dimension-card">
          <Heading>{dimension.label}</Heading>
          <p className="space-muted">{dimension.description}</p>
          {dimension.id === 'activity' && (
            <p className="space-note">Descriptive frequency: higher is not better or worse.</p>
          )}
          <ul>
            {instrument.questions
              .filter((question) => question.dimension === dimension.id)
              .map((question) => (
                <li key={question.id}>
                  <p className="space-prompt">{question.prompt}</p>
                  <QuestionValue
                    pulse={pulse}
                    result={results.find((item) => item.questionId === question.id)}
                  />
                </li>
              ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

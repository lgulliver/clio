import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../identity/api';
import {
  type Answers,
  dimensions,
  emptyAnswers,
  instrument,
  type Pulse,
  parseSubmission,
  questionIds,
  responseBody,
  scaleLabel,
} from './api';
import { OwnAssignment } from './own-assignment';
import { formatReferencePeriod } from './period';
import { useSpaceScope } from './space-scope';

export function ConfidentialityNotice({
  minimum,
  rosterSize,
}: {
  minimum: number;
  rosterSize: number;
}) {
  return (
    <div className="space-privacy">
      <h4>How your answers are reported</h4>
      <p>
        Results are confidential team aggregates. Nobody in Clio sees individual answers, and each
        question stays suppressed until at least {minimum} of the {rosterSize} people on the frozen
        roster answer it. Raw answers are deleted when the pulse closes or is cancelled.
      </p>
      <p>
        This is not a promise of anonymity. Small teams, database administrators, owners who change
        assignments, or people who know others&apos; answers may still be able to infer responses.
        Skip any item with “Prefer not to answer / not applicable”.
      </p>
    </div>
  );
}

/**
 * One confidential response for an eligible member. Answers live only in this component while
 * editing; they are cleared after acceptance and never echoed in status or error text.
 */
export function PulseResponse({
  pulse,
  still,
  onSubmitted,
}: {
  pulse: Pulse;
  still: () => boolean;
  onSubmitted: (outcome: 'submitted' | 'closed') => void;
}) {
  const scope = useSpaceScope();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusRequest = useRef(false);
  const [stage, setStage] = useState<'answer' | 'review' | 'submitted' | 'closed'>('answer');
  const [answers, setAnswers] = useState<Answers>(emptyAnswers);
  const [error, setError] = useState('');
  useEffect(() => {
    if (focusRequest.current) heading.current?.focus();
    focusRequest.current = false;
  });
  function move(next: typeof stage) {
    focusRequest.current = true;
    setStage(next);
  }
  async function submit() {
    setError('');
    const outcome = await scope.mutate({
      path: `/pulses/${pulse.id}/response`,
      body: responseBody(answers),
      parse: (value) => parseSubmission(value, scope.workspace.id, pulse.id),
      owner: false,
      still,
    });
    if (outcome.status === 'stale') return;
    if (outcome.status === 'failed') {
      if (
        outcome.error instanceof ApiError &&
        (outcome.error.status === 409 || outcome.error.status === 404)
      ) {
        setAnswers(emptyAnswers());
        move('closed');
        onSubmitted('closed');
        return;
      }
      setError(
        `Your response was not confirmed. ${errorMessage(outcome.error)} If an earlier attempt was accepted, retries keep that original response.`,
      );
      return;
    }
    setAnswers(emptyAnswers());
    move('submitted');
    onSubmitted('submitted');
  }
  const answered = questionIds.filter((questionId) => answers[questionId] !== null).length;
  return (
    <section className="space-response" aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`} ref={heading} tabIndex={-1} className="space-step-heading">
        {stage === 'answer'
          ? 'Your response'
          : stage === 'review'
            ? 'Review your response'
            : stage === 'submitted'
              ? 'Response submitted'
              : 'Pulse no longer accepting responses'}
      </h4>
      {stage === 'submitted' ? (
        <p role="status">
          Your response was recorded. Your answers are not shown again and cannot be changed.
        </p>
      ) : stage === 'closed' ? (
        <p role="status">
          This pulse is no longer accepting new responses. Your unsent answers were discarded.
        </p>
      ) : (
        <>
          <dl className="space-context">
            <div>
              <dt>Team at opening</dt>
              <dd>{pulse.teamName}</dd>
            </div>
            <div>
              <dt>Reference period</dt>
              <dd>{formatReferencePeriod(pulse.referenceStart, pulse.referenceEnd)}</dd>
            </div>
            <div>
              <dt>Frozen roster size</dt>
              <dd>{pulse.rosterSize}</dd>
            </div>
            <div>
              <dt>Minimum answers per question</dt>
              <dd>{pulse.minimumRespondents}</dd>
            </div>
          </dl>
          <ConfidentialityNotice minimum={pulse.minimumRespondents} rosterSize={pulse.rosterSize} />
          <OwnAssignment compact />
          {stage === 'answer' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                move('review');
              }}
            >
              <p className="space-muted">
                Think about the reference period above. Every item is optional.
              </p>
              {dimensions.map((dimension) => (
                <div key={dimension.id} className="space-response-group">
                  <h5>{dimension.label}</h5>
                  {instrument.questions
                    .filter((question) => question.dimension === dimension.id)
                    .map((question) => (
                      <fieldset key={question.id} className="space-question">
                        <legend>{question.prompt}</legend>
                        <div className="space-options">
                          {[1, 2, 3, 4, 5].map((value) => (
                            <label key={value}>
                              <input
                                type="radio"
                                name={`${id}-${question.id}`}
                                value={value}
                                checked={answers[question.id] === value}
                                onChange={() =>
                                  setAnswers((current) => ({ ...current, [question.id]: value }))
                                }
                              />
                              <span>
                                {value} {scaleLabel(question.scale, value)}
                              </span>
                            </label>
                          ))}
                          <label>
                            <input
                              type="radio"
                              name={`${id}-${question.id}`}
                              value=""
                              checked={answers[question.id] === null}
                              onChange={() =>
                                setAnswers((current) => ({ ...current, [question.id]: null }))
                              }
                            />
                            <span>Prefer not to answer / not applicable</span>
                          </label>
                        </div>
                      </fieldset>
                    ))}
                </div>
              ))}
              <button className="control mt-4" type="submit">
                Review response
              </button>
            </form>
          ) : (
            <div>
              <p>
                {answered === 0
                  ? 'You skipped every item. Submitting records that you took part, but no question values.'
                  : `You answered ${answered} of ${questionIds.length} items. Skipped items are not counted as zero.`}
              </p>
              <dl className="space-answer-review">
                {instrument.questions.map((question) => {
                  const value = answers[question.id];
                  return (
                    <div key={question.id}>
                      <dt>{question.prompt}</dt>
                      <dd>
                        {value === null
                          ? 'Prefer not to answer / not applicable'
                          : `${value} ${scaleLabel(question.scale, value)}`}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              <p className="space-muted">
                You can respond once. After submission your answers cannot be viewed or changed.
              </p>
              <div className="space-wizard-actions">
                <button type="button" className="space-secondary" onClick={() => move('answer')}>
                  Change answers
                </button>
                <button
                  type="button"
                  className="control"
                  aria-disabled={scope.busy}
                  onClick={() => {
                    if (!scope.busy) void submit();
                  }}
                >
                  {error ? 'Retry submission' : 'Submit response'}
                </button>
              </div>
              {scope.busy && <p role="status">Submitting response…</p>}
              {error && <p role="alert">{error}</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../identity/api';
import { readFailure } from '../space/space-scope';
import {
  type DeliverySummary,
  type NotificationBatch,
  newRequestId,
  notificationError,
  notificationStates,
  parseDeliverySummary,
  parseNotificationBatch,
  unknownOutcome,
} from './api';
import { useNotificationRead, useNotificationScope, useStill } from './notification-scope';
import { stateLabel } from './own-history';

type Kind = 'remind' | 'retry' | 'disable';
type Body = { requestId: string; revision: number; confirm: true; confirmUncertain?: boolean };
type Intent = { kind: Kind; body: Body | { revision: number } };

const stateHelp: Record<(typeof notificationStates)[number], string> = {
  pending: 'Queued, not yet sent.',
  leased: 'Being sent now.',
  retry_scheduled: 'A known-safe failure; Clio will try again.',
  provider_accepted: 'Handed to Slack or the email server. Not proof of delivery or reading.',
  skipped: 'Not sent, for example because the notice stopped applying.',
  failed:
    'Not accepted on the latest attempt; an earlier submission may have arrived if retried after an unknown outcome.',
  uncertain: 'Sent but acceptance could not be confirmed. Another message may arrive on retry.',
};

/**
 * Owner-only aggregate delivery state for one pulse: counts per state and three batch actions.
 * It names no recipients, destinations, failures or non-responders. Reads never queue or send;
 * every action needs an explicit confirmation and replays the same request after an unknown
 * outcome instead of sending again.
 */
export function PulseNotificationControls({
  pulseId,
  state,
}: {
  pulseId: string;
  /** Reminders apply only to an open pulse; retry applies to either. */
  state?: 'open' | 'closed';
}) {
  const scope = useNotificationScope();
  const id = useId();
  const still = useStill();
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState<Kind | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  // The exact request whose outcome is unknown; replayed verbatim, never regenerated.
  const [unknown, setUnknown] = useState<Intent | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const workspaceId = scope.workspaceId;
  const read = useNotificationRead(
    `summary/${pulseId}`,
    `/pulses/${pulseId}`,
    (value) => parseDeliverySummary(value, { workspaceId, pulseId }),
    scope.owner,
  );
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  if (!scope.owner) return null;
  const summary: DeliverySummary | undefined = read.data;

  function intentFor(kind: Kind, current: DeliverySummary): Intent {
    if (unknown?.kind === kind) return unknown;
    if (kind === 'disable') return { kind, body: { revision: current.revision } };
    const body: Body = {
      requestId: newRequestId(),
      revision: current.revision,
      confirm: true,
      // Consent counts only while its warning is visible for the current uncertain total.
      ...(kind === 'retry' && acknowledged && current.counts.uncertain > 0
        ? { confirmUncertain: true }
        : {}),
    };
    return { kind, body };
  }
  async function run(kind: Kind, current: DeliverySummary) {
    setError('');
    setNotice('');
    const intent = intentFor(kind, current);
    const outcome =
      kind === 'disable'
        ? await scope.write({
            path: `/pulses/${pulseId}/reminders/disable`,
            body: intent.body,
            parse: (value) => parseDeliverySummary(value, { workspaceId, pulseId }),
            owner: true,
            still,
          })
        : await scope.write<NotificationBatch>({
            path: `/pulses/${pulseId}/${kind === 'remind' ? 'remind' : 'retry'}`,
            body: intent.body,
            parse: parseNotificationBatch,
            owner: true,
            still,
          });
    if (outcome.status === 'stale') return;
    setConfirming(null);
    if (outcome.status === 'failed') {
      if (unknownOutcome(outcome.error)) {
        setUnknown(intent);
        setError(
          'Clio could not confirm whether this request was accepted. Check the request again: it repeats the same request and cannot send twice. Do not start a new one until you have checked.',
        );
      } else {
        setUnknown(null);
        setAcknowledged(false);
        const status = outcome.error instanceof ApiError ? outcome.error.status : 0;
        setError(
          status === 409
            ? kind === 'remind'
              ? 'No reminders were queued. The pulse or settings changed, reminders are off, a batch was already requested in the last 24 hours, or the reminder limit is reached.'
              : 'Nothing was changed because the pulse or its notification settings changed. The current status is shown.'
            : notificationError(outcome.error),
        );
        scope.refresh();
      }
      heading.current?.focus();
      return;
    }
    setUnknown(null);
    setAcknowledged(false);
    const value = outcome.value;
    if ('queued' in value)
      setNotice(
        value.queued
          ? kind === 'remind'
            ? 'A reminder batch is queued for eligible members. Counts update as it is processed.'
            : 'A retry batch is queued. Counts update as it is processed.'
          : 'Nothing was queued: there was nothing eligible to send.',
      );
    else setNotice('Reminders are turned off for this pulse. Pending reminders are cancelled.');
    scope.refresh();
    heading.current?.focus();
  }
  function stopChecking() {
    setUnknown(null);
    setNotice('');
    setError(
      'The earlier request may still have been queued. Check the counts below before requesting again.',
    );
    scope.refresh();
  }
  const retryable = summary ? summary.counts.failed + summary.counts.uncertain : 0;
  const uncertain = summary?.counts.uncertain ?? 0;
  const canRemind = state === 'open' && summary?.remindersEnabled === true;
  const prompts: Record<Kind, string> = {
    remind:
      'Queue one reminder to eligible members of this pulse’s roster who have not responded? Clio does not list recipients. At most one batch per pulse per 24 hours, within the reminder limit.',
    disable: 'Turn off the remaining reminders for this pulse? The survey itself is unchanged.',
    retry: 'Retry deliveries that could not be sent? Clio does not list recipients or failures.',
  };
  return (
    <section className="space-notification-summary" aria-labelledby={`${id}-title`}>
      <div className="space-section-heading">
        <h4 id={`${id}-title`} ref={heading} tabIndex={-1} className="space-step-heading">
          Notification delivery
        </h4>
        <button type="button" className="space-secondary" onClick={() => scope.refresh()}>
          Refresh delivery status
        </button>
      </div>
      {read.checking ? (
        <p role="status">Checking access…</p>
      ) : read.isError ? (
        <div>
          <p role="alert">
            {readFailure(read, 'Delivery status is unavailable for this pulse right now.')}
          </p>
          <button type="button" className="control mt-3" onClick={() => void read.refetch()}>
            Retry delivery status
          </button>
        </div>
      ) : !summary ? (
        <p role="status">Loading delivery status…</p>
      ) : (
        <>
          <p className="space-muted">
            Totals across everyone notified for this pulse. Clio shows no names, destinations or
            reasons per person. Reminders are {summary.remindersEnabled ? 'on' : 'off'} for this
            pulse.
          </p>
          <dl className="space-compact-results">
            {notificationStates.map((item) => (
              <div key={item}>
                <dt>{stateLabel[item]}</dt>
                <dd>
                  <strong>{summary.counts[item]}</strong>
                  <span className="space-muted"> {stateHelp[item]}</span>
                </dd>
              </div>
            ))}
          </dl>
          <div className="space-wizard-actions">
            {canRemind && (
              <button
                type="button"
                className="control"
                aria-expanded={confirming === 'remind'}
                aria-disabled={scope.busy || unknown !== null}
                onClick={() => {
                  if (!scope.busy && !unknown) setConfirming('remind');
                }}
              >
                Queue reminder batch
              </button>
            )}
            {canRemind && (
              <button
                type="button"
                className="space-secondary"
                aria-expanded={confirming === 'disable'}
                aria-disabled={scope.busy || unknown !== null}
                onClick={() => {
                  if (!scope.busy && !unknown) setConfirming('disable');
                }}
              >
                Turn off reminders for this pulse
              </button>
            )}
            {retryable > 0 && (
              <button
                type="button"
                className="space-secondary"
                aria-expanded={confirming === 'retry'}
                aria-describedby={`${id}-retry-help`}
                aria-disabled={scope.busy || unknown !== null}
                onClick={() => {
                  if (scope.busy || unknown) return;
                  setAcknowledged(false);
                  setConfirming('retry');
                }}
              >
                Retry failed deliveries
              </button>
            )}
          </div>
          {retryable > 0 && (
            <p id={`${id}-retry-help`} className="space-muted">
              Older failed or unknown invitations and reminders can pause further reminders. Missed
              reminder slots are not restored. Invitations have no time expiry; they stop applying
              when the pulse closes or access is lost. Retry only eligible deliveries within the
              attempt limits. Exhausted attempt limits cannot be retried. You can turn off reminders
              for this pulse or disable workspace notifications to cancel pending work. Messages
              already accepted or in flight may still arrive.
            </p>
          )}
          {confirming && (
            <fieldset className="space-confirm">
              <legend>{prompts[confirming]}</legend>
              {confirming === 'retry' && uncertain > 0 && (
                <label>
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />{' '}
                  Also retry deliveries whose outcome is unknown. Some people may receive a second
                  message because the first may already have arrived.
                </label>
              )}
              <button
                ref={confirmButton}
                type="button"
                className="control"
                aria-disabled={scope.busy}
                onClick={() => {
                  if (!scope.busy) void run(confirming, summary);
                }}
              >
                {confirming === 'remind'
                  ? 'Confirm queue reminders'
                  : confirming === 'disable'
                    ? 'Confirm turn off reminders'
                    : 'Confirm retry'}
              </button>
              <button
                type="button"
                className="space-secondary"
                onClick={() => {
                  setAcknowledged(false);
                  setConfirming(null);
                }}
              >
                Cancel
              </button>
            </fieldset>
          )}
          {unknown && (
            <div className="space-warning">
              <p>
                An earlier{' '}
                {unknown.kind === 'remind'
                  ? 'reminder'
                  : unknown.kind === 'retry'
                    ? 'retry'
                    : 'reminder-off'}{' '}
                request could not be confirmed.
              </p>
              <button
                type="button"
                className="control"
                aria-disabled={scope.busy}
                onClick={() => {
                  if (!scope.busy) void run(unknown.kind, summary);
                }}
              >
                Check the request again
              </button>{' '}
              <button type="button" className="space-secondary" onClick={stopChecking}>
                Stop checking
              </button>
            </div>
          )}
        </>
      )}
      {scope.busy && <p role="status">Updating notification delivery…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

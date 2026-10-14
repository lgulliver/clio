import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../identity/api';
import { useSession } from '../identity/session';
import {
  type NotificationAvailability,
  type NotificationChannel,
  type NotificationPolicy,
  newRequestId,
  notificationError,
  parseNotificationBatch,
  parseNotificationPolicy,
  unknownOutcome,
} from './api';
import { useNotificationScope, useStill } from './notification-scope';
import { useOwnSlackLink } from './own-link';

const steps = ['Integration', 'Messages and timing', 'Preview and test', 'Enable'] as const;
type Step = 0 | 1 | 2 | 3;

/** Neutral wording only: no answers, counts, names or team and workspace names. */
const previews = [
  {
    key: 'invitations',
    title: 'When a pulse opens',
    subject: 'A team pulse is open',
    text: 'A team pulse is open and your input is welcome.',
  },
  {
    key: 'reminders',
    title: 'Reminder',
    subject: 'Reminder: a team pulse is open',
    text: 'A team pulse is still open if you would like to take part.',
  },
  {
    key: 'closures',
    title: 'When a pulse closes',
    subject: 'Pulse closed',
    text: 'A team pulse has closed. You can find it in Clio.',
  },
] as const;

type Draft = {
  invitations: boolean;
  closures: boolean;
  reminders: boolean;
  firstReminderHours: string;
  repeatHours: string;
  maximumReminders: string;
};

function draftFrom(policy: NotificationPolicy): Draft {
  return {
    invitations: policy.invitations,
    closures: policy.closures,
    reminders: policy.reminders,
    firstReminderHours: String(policy.firstReminderHours),
    repeatHours: String(policy.repeatHours),
    maximumReminders: String(policy.maximumReminders),
  };
}
function whole(value: string, min: number, max: number): number | null {
  if (!/^\d{1,4}$/.test(value.trim())) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}
/** Timings are always validated, so they stay independent of the reminders switch. */
function validDraft(draft: Draft) {
  const firstReminderHours = whole(draft.firstReminderHours, 24, 168);
  const repeatHours = whole(draft.repeatHours, 24, 168);
  const maximumReminders = whole(draft.maximumReminders, 1, 3);
  if (firstReminderHours === null || repeatHours === null || maximumReminders === null) return null;
  return {
    invitations: draft.invitations,
    closures: draft.closures,
    reminders: draft.reminders,
    firstReminderHours,
    repeatHours,
    maximumReminders,
  };
}

function sameSettings(a: NotificationPolicy, b: ReturnType<typeof validDraft>) {
  return (
    b !== null &&
    a.invitations === b.invitations &&
    a.closures === b.closures &&
    a.reminders === b.reminders &&
    a.firstReminderHours === b.firstReminderHours &&
    a.repeatHours === b.repeatHours &&
    a.maximumReminders === b.maximumReminders
  );
}

/**
 * Owner setup for pulse notifications. Nothing is saved, tested or enabled on mount: each send
 * and the final enable need an explicit confirmation. There is no credential, address or
 * recipient entry; the operator configures destinations outside Clio.
 */
export function SetupWizard({
  availability,
  policy,
  onClose,
}: {
  availability: NotificationAvailability;
  policy: NotificationPolicy;
  onClose: () => void;
}) {
  const scope = useNotificationScope();
  const session = useSession();
  const id = useId();
  const still = useStill();
  const link = useOwnSlackLink();
  const heading = useRef<HTMLHeadingElement>(null);
  const testConfirm = useRef<HTMLButtonElement>(null);
  const enableConfirm = useRef<HTMLButtonElement>(null);
  const focusRequest = useRef(true);
  const [step, setStep] = useState<Step>(0);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(policy));
  // Every write names the revision this draft was based on. If another owner changes the
  // policy meanwhile, the draft is never silently rebased: the owner must reload it.
  const [baseRevision, setBaseRevision] = useState(policy.revision);
  const [channel, setChannel] = useState<NotificationChannel | ''>('');
  const [confirmTest, setConfirmTest] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [testNotice, setTestNotice] = useState('');
  const [testError, setTestError] = useState('');
  // The identity of a test whose outcome is unknown; reusing it replays instead of resending.
  const testIntent = useRef<{
    requestId: string;
    revision: number;
    channel: NotificationChannel;
  } | null>(null);
  const [testUnknown, setTestUnknown] = useState(false);
  useEffect(() => {
    if (focusRequest.current) heading.current?.focus();
    focusRequest.current = false;
  });
  useEffect(() => {
    if (confirmTest) testConfirm.current?.focus();
  }, [confirmTest]);
  useEffect(() => {
    if (confirmEnable) enableConfirm.current?.focus();
  }, [confirmEnable]);
  const values = validDraft(draft);
  const outdated = !done && policy.revision !== baseRevision;
  const anyIntegration = availability.emailConfigured || availability.slackConfigured;
  const anyMessage = draft.invitations || draft.closures || draft.reminders;
  const slackReady = availability.slackConfigured && link.data?.linked === true;
  const emailReady = availability.emailConfigured && session.user?.emailVerified === true;
  function go(next: Step) {
    setError('');
    setConfirmTest(false);
    setConfirmEnable(false);
    focusRequest.current = true;
    setStep(next);
  }
  function edit(next: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...next }));
    setConfirmEnable(false);
  }
  function reload() {
    // Settings changed elsewhere: discard this draft. A test whose outcome is unknown is never
    // abandoned silently; it stays retained (replayable, channel locked) until the owner checks
    // it or explicitly stops checking.
    setDraft(draftFrom(policy));
    setBaseRevision(policy.revision);
    if (testIntent.current) {
      go(2);
      return;
    }
    setTestError('');
    setTestNotice('');
    setChannel('');
    go(1);
  }
  function forward() {
    if (step === 0 && !anyIntegration) return;
    if (step === 1) {
      if (!values) {
        setError(
          'Enter whole hours from 24 to 168 for both timings and a maximum of 1 to 3 reminders.',
        );
        return;
      }
      if (!anyMessage) {
        setError('Choose at least one message to send.');
        return;
      }
    }
    if (step < 3) go((step + 1) as Step);
  }
  async function sendTest() {
    // A retained unknown request is always replayed as it was, whatever the radio now shows.
    const retained = testIntent.current;
    // A retained request replays as it was; only a brand-new request is revision fenced.
    if (retained ? false : !channel || outdated) return;
    setTestError('');
    setTestNotice('');
    const intent =
      retained ?? (channel ? { requestId: newRequestId(), revision: baseRevision, channel } : null);
    if (!intent) return;
    const outcome = await scope.write({
      path: '/test',
      body: {
        requestId: intent.requestId,
        revision: intent.revision,
        confirm: true,
        channel: intent.channel,
      },
      parse: parseNotificationBatch,
      owner: true,
      still,
    });
    if (outcome.status === 'stale') return;
    setConfirmTest(false);
    if (outcome.status === 'failed') {
      if (unknownOutcome(outcome.error)) {
        // Keep the identity: confirming again replays this request and cannot send a second test.
        testIntent.current = intent;
        setTestUnknown(true);
        setTestError(
          'Clio could not confirm whether the test was queued. Confirming again repeats the same request and cannot send a second test.',
        );
      } else {
        testIntent.current = null;
        setTestUnknown(false);
        setTestError(
          outcome.error instanceof ApiError && outcome.error.status === 409
            ? 'No test was queued. A test for this channel may already have been requested in the last 24 hours, or the settings changed. Refresh status and check your history.'
            : notificationError(outcome.error),
        );
        scope.refresh();
      }
      return;
    }
    testIntent.current = null;
    setTestUnknown(false);
    setTestNotice(
      outcome.value.queued
        ? `A test message to your own ${intent.channel === 'slack' ? 'Slack account' : 'email'} is queued. Provider acceptance does not prove you will see it; check your notification history.`
        : 'No test was queued because your own destination is not ready for that channel.',
    );
    scope.refresh();
  }
  async function enable() {
    if (!values || outdated) return;
    setError('');
    const body = { ...values, enabled: true, revision: baseRevision };
    const outcome = await scope.write({
      path: '/policy',
      method: 'PATCH',
      body,
      parse: parseNotificationPolicy,
      owner: true,
      still,
    });
    if (outcome.status === 'stale') return;
    setConfirmEnable(false);
    if (outcome.status === 'failed') {
      const status = outcome.error instanceof ApiError ? outcome.error.status : 0;
      setError(
        status === 409
          ? 'Notifications were not enabled. The settings changed, or this workspace’s integration could not be matched. Review the current settings and try again.'
          : unknownOutcome(outcome.error)
            ? `${notificationError(outcome.error)} Clio could not confirm whether notifications were enabled; refresh status before trying again.`
            : notificationError(outcome.error),
      );
      scope.refresh();
      heading.current?.focus();
      return;
    }
    if (!outcome.value.enabled || !sameSettings(outcome.value, values)) {
      setError(
        'The saved settings could not be verified. Refresh status to see the current state.',
      );
      scope.refresh();
      heading.current?.focus();
      return;
    }
    setDone(true);
    focusRequest.current = true;
    scope.refresh();
  }
  const reasonSlack = !availability.slackConfigured
    ? 'Slack is not configured for this workspace.'
    : link.data?.linked
      ? ''
      : 'Link your own Slack account first.';
  const reasonEmail = !availability.emailConfigured
    ? 'Email is not configured for this workspace.'
    : emailReady
      ? ''
      : 'Your sign-in email is not verified.';
  return (
    <section className="space-wizard" aria-labelledby={`${id}-title`}>
      <div className="space-section-heading">
        <h3 id={`${id}-title`}>Set up pulse notifications</h3>
        <button type="button" className="space-secondary" onClick={onClose}>
          {done ? 'Done' : 'Close setup'}
        </button>
      </div>
      {done ? (
        <div className="space-wizard-body">
          <h4 ref={heading} tabIndex={-1} className="space-step-heading">
            Notifications are enabled
          </h4>
          <p>
            Messages apply to pulses opened from now on. Pulses that are already open are not
            backfilled.
          </p>
        </div>
      ) : (
        <>
          <ol className="space-progress" aria-label="Notification setup steps">
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
            {outdated && (
              <div role="alert" className="space-warning">
                <p>
                  Notification settings changed elsewhere after you opened setup. Nothing from this
                  draft has been saved. Reload the current settings before continuing.
                </p>
                <button type="button" className="control" onClick={reload}>
                  Reload current settings
                </button>
              </div>
            )}
            {step === 0 && (
              <>
                <ul>
                  <li>
                    Email delivery: {availability.emailConfigured ? 'available' : 'not configured'}
                  </li>
                  <li>
                    Slack delivery: {availability.slackConfigured ? 'available' : 'not configured'}
                  </li>
                  <li>
                    Slack account linking:{' '}
                    {availability.linkingConfigured ? 'available' : 'not configured'}
                  </li>
                </ul>
                {anyIntegration ? (
                  <p className="space-muted">
                    Clio sends a private Slack message first to members who linked Slack, and falls
                    back to verified email when Slack is not linked or definitely declines the
                    message. If acceptance cannot be confirmed (for example a timeout), Clio does
                    not send a second message by itself: the delivery is marked outcome unknown and
                    an owner can choose to retry it. Destinations are configured by whoever operates
                    Clio; there is nothing to enter here.
                  </p>
                ) : (
                  <p className="space-note">
                    No delivery integration is configured for this workspace, so notifications
                    cannot be enabled. Ask whoever operates Clio to configure Slack or email for it.
                  </p>
                )}
              </>
            )}
            {step === 1 && (
              <>
                <fieldset className="space-options">
                  <legend>Messages to send</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.invitations}
                      onChange={(event) => edit({ invitations: event.target.checked })}
                    />{' '}
                    When a pulse opens
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.reminders}
                      onChange={(event) => edit({ reminders: event.target.checked })}
                    />{' '}
                    Reminders while a pulse is open
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.closures}
                      onChange={(event) => edit({ closures: event.target.checked })}
                    />{' '}
                    When a pulse closes
                  </label>
                </fieldset>
                <div className="space-date-fields">
                  <label>
                    First reminder after (hours, 24–168)
                    <input
                      className="field"
                      inputMode="numeric"
                      value={draft.firstReminderHours}
                      onChange={(event) => edit({ firstReminderHours: event.target.value })}
                    />
                  </label>
                  <label>
                    Further reminders every (hours, 24–168)
                    <input
                      className="field"
                      inputMode="numeric"
                      value={draft.repeatHours}
                      onChange={(event) => edit({ repeatHours: event.target.value })}
                    />
                  </label>
                  <label>
                    Maximum reminders (1–3)
                    <input
                      className="field"
                      inputMode="numeric"
                      value={draft.maximumReminders}
                      onChange={(event) => edit({ maximumReminders: event.target.value })}
                    />
                  </label>
                </div>
                <p className="space-muted">
                  Reminders only go to people on the pulse’s frozen roster who have not responded.
                  Timings are saved even when reminders are off. These settings do not change the
                  reporting minimum or which results are suppressed.
                </p>
              </>
            )}
            {step === 2 && (
              <>
                <p className="space-muted">
                  Example wording. Every message links to its exact pulse and contains no answers,
                  averages, participation counts, names or team names.
                </p>
                {previews
                  .filter((item) => draft[item.key])
                  .map((item) => (
                    <figure key={item.key} className="space-preview">
                      <figcaption>{item.title}</figcaption>
                      <p>
                        <strong>{item.subject}</strong>
                      </p>
                      <p>{item.text}</p>
                    </figure>
                  ))}
                {!anyMessage && <p>No messages are selected. Go back to choose at least one.</p>}
                <fieldset className="space-options">
                  <legend>Send a test to your own destination</legend>
                  <p className="space-muted">
                    Only you receive it. You cannot enter another address or send a test to a team.
                    One test per channel per 24 hours.
                  </p>
                  <label>
                    <input
                      type="radio"
                      name={`${id}-channel`}
                      checked={channel === 'slack'}
                      disabled={!slackReady || testUnknown}
                      onChange={() => {
                        setChannel('slack');
                        setConfirmTest(false);
                      }}
                    />{' '}
                    My Slack account{!slackReady && reasonSlack ? ` (${reasonSlack})` : ''}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={`${id}-channel`}
                      checked={channel === 'email'}
                      disabled={!emailReady || testUnknown}
                      onChange={() => {
                        setChannel('email');
                        setConfirmTest(false);
                      }}
                    />{' '}
                    My verified sign-in email{!emailReady && reasonEmail ? ` (${reasonEmail})` : ''}
                  </label>
                </fieldset>
                <button
                  type="button"
                  className="space-secondary"
                  aria-expanded={confirmTest}
                  aria-disabled={!channel || scope.busy || testUnknown || outdated}
                  onClick={() => {
                    if (channel && !scope.busy && !testUnknown && !outdated) setConfirmTest(true);
                  }}
                >
                  Send a test to me
                </button>
                {confirmTest && channel && (
                  <fieldset className="space-confirm">
                    <legend>
                      Send one test message to your own{' '}
                      {channel === 'slack' ? 'Slack account' : 'email'} now? Only you receive it.
                    </legend>
                    <button
                      ref={testConfirm}
                      type="button"
                      className="control"
                      aria-disabled={scope.busy}
                      onClick={() => {
                        if (!scope.busy) void sendTest();
                      }}
                    >
                      Confirm send test
                    </button>
                    <button
                      type="button"
                      className="space-secondary"
                      onClick={() => setConfirmTest(false)}
                    >
                      Do not send
                    </button>
                  </fieldset>
                )}
                {testUnknown && (
                  <div className="space-warning">
                    <p>
                      An earlier test to your{' '}
                      {testIntent.current?.channel === 'slack' ? 'Slack account' : 'email'} could
                      not be confirmed. Choose another channel only after you stop checking it.
                    </p>
                    <button
                      type="button"
                      className="control"
                      aria-disabled={scope.busy}
                      onClick={() => {
                        if (!scope.busy) void sendTest();
                      }}
                    >
                      Check the test request again
                    </button>{' '}
                    <button
                      type="button"
                      className="space-secondary"
                      onClick={() => {
                        testIntent.current = null;
                        setTestUnknown(false);
                        setTestError(
                          'The earlier test may still have been queued. Check your notification history before testing again.',
                        );
                      }}
                    >
                      Stop checking
                    </button>
                  </div>
                )}
                {testNotice && <p role="status">{testNotice}</p>}
                {testError && <p role="alert">{testError}</p>}
              </>
            )}
            {step === 3 && (
              <>
                <ul>
                  <li>When a pulse opens: {draft.invitations ? 'on' : 'off'}</li>
                  <li>
                    Reminders: {draft.reminders ? 'on' : 'off'}
                    {values
                      ? `, first after ${values.firstReminderHours} hours, then every ${values.repeatHours} hours, up to ${values.maximumReminders}`
                      : ''}
                  </li>
                  <li>When a pulse closes: {draft.closures ? 'on' : 'off'}</li>
                </ul>
                <p className="space-muted">
                  Enabling applies only to pulses opened afterwards and freezes these settings for
                  each. It does not create surveys, close pulses or send to existing pulses.
                  Disabling later cancels pending messages; enabling again does not bring them back.
                  Messages already handed to a provider cannot be recalled.
                </p>
                {!anyIntegration && (
                  <p className="space-note">No delivery integration is configured.</p>
                )}
                <button
                  type="button"
                  className="control"
                  aria-expanded={confirmEnable}
                  aria-disabled={
                    scope.busy || !values || !anyMessage || !anyIntegration || outdated
                  }
                  onClick={() => {
                    if (!scope.busy && values && anyMessage && anyIntegration && !outdated)
                      setConfirmEnable(true);
                  }}
                >
                  {policy.enabled ? 'Save notification settings' : 'Enable notifications'}
                </button>
                {confirmEnable && (
                  <fieldset className="space-confirm">
                    <legend>
                      {policy.enabled ? 'Save these settings' : 'Enable notifications'} for pulses
                      opened from now on?
                    </legend>
                    <button
                      ref={enableConfirm}
                      type="button"
                      className="control"
                      aria-disabled={scope.busy}
                      onClick={() => {
                        if (!scope.busy) void enable();
                      }}
                    >
                      {policy.enabled ? 'Confirm save settings' : 'Confirm enable notifications'}
                    </button>
                    <button
                      type="button"
                      className="space-secondary"
                      onClick={() => setConfirmEnable(false)}
                    >
                      Not yet
                    </button>
                  </fieldset>
                )}
              </>
            )}
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
                  aria-disabled={step === 0 && !anyIntegration}
                  onClick={forward}
                >
                  Next
                </button>
              )}
            </div>
            {scope.busy && <p role="status">Working…</p>}
            {error && <p role="alert">{error}</p>}
          </div>
        </>
      )}
    </section>
  );
}

/** Current saved settings with an explicit, revision-checked disable. */
export function PolicySummary({
  policy,
  onChange,
}: {
  policy: NotificationPolicy;
  onChange: () => void;
}) {
  const scope = useNotificationScope();
  const still = useStill();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  async function disable() {
    setError('');
    setNotice('');
    const outcome = await scope.write({
      path: '/policy',
      method: 'PATCH',
      body: { ...policy, enabled: false },
      parse: parseNotificationPolicy,
      owner: true,
      still,
    });
    if (outcome.status === 'stale') return;
    setConfirming(false);
    scope.refresh();
    if (outcome.status === 'failed') {
      setError(
        outcome.error instanceof ApiError && outcome.error.status === 409
          ? 'The settings changed before your request completed. The current settings are shown.'
          : `${notificationError(outcome.error)} Refresh status to see whether notifications were disabled.`,
      );
    } else if (outcome.value.enabled) {
      setError('Notifications could not be disabled. The current settings are shown.');
    } else {
      setNotice('Notifications disabled. Pending messages are cancelled.');
    }
    status.current?.focus();
  }
  return (
    <div>
      <p ref={status} tabIndex={-1}>
        {policy.enabled
          ? 'Notifications are enabled for pulses opened after they were enabled.'
          : 'Notifications are disabled. Clio sends no pulse messages.'}
      </p>
      {policy.enabled && (
        <>
          <ul>
            <li>When a pulse opens: {policy.invitations ? 'on' : 'off'}</li>
            <li>
              Reminders: {policy.reminders ? 'on' : 'off'}; first after {policy.firstReminderHours}{' '}
              hours, then every {policy.repeatHours} hours, up to {policy.maximumReminders}
            </li>
            <li>When a pulse closes: {policy.closures ? 'on' : 'off'}</li>
          </ul>
          <div className="space-wizard-actions">
            <button type="button" className="control" onClick={onChange}>
              Change notification settings
            </button>
            <button
              type="button"
              className="space-secondary space-danger"
              aria-expanded={confirming}
              onClick={() => setConfirming(true)}
            >
              Disable notifications
            </button>
          </div>
          {confirming && (
            <fieldset className="space-confirm">
              <legend>
                Disable notifications? Pending messages are cancelled and enabling again does not
                bring them back. Messages already handed to a provider cannot be recalled.
              </legend>
              <button
                ref={confirmButton}
                type="button"
                className="control space-danger-fill"
                aria-disabled={scope.busy}
                onClick={() => {
                  if (!scope.busy) void disable();
                }}
              >
                Confirm disable notifications
              </button>
              <button
                type="button"
                className="space-secondary"
                onClick={() => setConfirming(false)}
              >
                Keep enabled
              </button>
            </fieldset>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

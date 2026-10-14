import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../identity/api';
import { useSession } from '../identity/session';
import { readFailure } from '../space/space-scope';
import {
  type NotificationAvailability,
  notificationError,
  type OwnSlackLink,
  parseOwnSlackLink,
  parseSlackAuthorizeUrl,
} from './api';
import { useNotificationRead, useNotificationScope, useStill } from './notification-scope';

/** Test seam for the one full-page navigation: the server-provided Slack authorization URL. */
export const slackNavigation = {
  go: (url: string) => {
    window.location.assign(url);
  },
};

export function useOwnSlackLink() {
  return useNotificationRead('link', '/slack-link', parseOwnSlackLink);
}

/** What happens when Slack cannot be used, from public availability and own sign-in state only. */
function fallbackText(availability: NotificationAvailability, emailVerified: boolean) {
  if (!availability.emailConfigured)
    return 'Email delivery is not configured for this workspace, so there is no email fallback.';
  return emailVerified
    ? 'If Slack is not linked or cannot take a message, Clio uses your verified sign-in email instead. The address is never shown here.'
    : 'Your sign-in email is not verified, so it cannot be used as a fallback.';
}

/**
 * Own Slack link state. Returning from Slack proves nothing here: this component always shows
 * the state read from Clio. Linking sends only your own verified Slack identity, never a team
 * roster, and unlinking affects only unsent messages.
 */
export function OwnLink({ availability }: { availability: NotificationAvailability }) {
  const scope = useNotificationScope();
  const session = useSession();
  const id = useId();
  const still = useStill();
  const read = useOwnSlackLink();
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  const link: OwnSlackLink | undefined = read.data;
  async function start() {
    setError('');
    setNotice('');
    const outcome = await scope.write({
      path: '/slack-link/start',
      body: {},
      parse: parseSlackAuthorizeUrl,
      owner: false,
      still,
    });
    if (outcome.status === 'stale') return;
    if (outcome.status === 'failed') {
      setError(
        outcome.error instanceof ApiError && outcome.error.status === 409
          ? 'Slack linking is not available for this workspace right now.'
          : notificationError(outcome.error),
      );
      heading.current?.focus();
      return;
    }
    slackNavigation.go(outcome.value);
  }
  async function unlink() {
    if (!link) return;
    setError('');
    setNotice('');
    const outcome = await scope.write({
      path: '/slack-link/unlink',
      body: { revision: link.revision },
      parse: parseOwnSlackLink,
      owner: false,
      still,
    });
    if (outcome.status === 'stale') return;
    setConfirming(false);
    scope.refresh();
    if (outcome.status === 'failed') {
      setError(
        outcome.error instanceof ApiError && outcome.error.status === 409
          ? 'Your Slack link changed before this request completed. Its current state is shown.'
          : `${notificationError(outcome.error)} Refresh status to see whether your Slack link changed.`,
      );
    } else if (outcome.value.linked) {
      setError('Your Slack link could not be removed. Its current state is shown.');
    } else {
      setNotice('Slack unlinked. Unsent messages will use email if it is available.');
    }
    heading.current?.focus();
  }
  return (
    <section aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} ref={heading} tabIndex={-1} className="space-panel-title">
        Your Slack account
      </h3>
      {read.checking ? (
        <p role="status">Checking access…</p>
      ) : read.isError ? (
        <div>
          <p role="alert">
            {readFailure(read, 'Your Slack link status is unavailable right now.')}
          </p>
          <button type="button" className="control mt-3" onClick={() => void read.refetch()}>
            Retry Slack link status
          </button>
        </div>
      ) : !link ? (
        <p role="status">Loading your Slack link…</p>
      ) : (
        <>
          <p>
            {link.linked
              ? `Slack account linked${link.linkedAt ? ` on ${link.linkedAt.slice(0, 10)}` : ''}. ${
                  availability.linkingConfigured
                    ? 'Clio sends your pulse notices as a private Slack message.'
                    : 'Slack is not configured for this workspace, so it is not used until the operator restores it.'
                }`
              : !availability.linkingConfigured
                ? 'No Slack account linked.'
                : 'No Slack account linked. Linking asks Slack to confirm who you are; it does not sign you in to Clio or give Clio access to your Slack messages.'}
          </p>
          {!availability.linkingConfigured && (
            <p className="space-note">
              Slack linking is not available for this workspace.
              {link.linked ? ' You can still remove your existing link.' : ''}
            </p>
          )}
          <p className="space-muted">
            {fallbackText(availability, session.user?.emailVerified === true)} A message whose
            outcome cannot be confirmed is never resent automatically.
          </p>
          {link.linked ? (
            <button
              type="button"
              className="space-secondary"
              aria-expanded={confirming}
              onClick={() => setConfirming(true)}
            >
              Unlink Slack account
            </button>
          ) : (
            availability.linkingConfigured && (
              <button
                type="button"
                className="control"
                aria-disabled={scope.busy}
                onClick={() => {
                  if (!scope.busy) void start();
                }}
              >
                Link Slack account
              </button>
            )
          )}
          {confirming && link.linked && (
            <fieldset className="space-confirm">
              <legend>
                Unlink your Slack account? Later messages use email if it is available. Messages
                already submitted to Slack cannot be recalled.
              </legend>
              <button
                ref={confirmButton}
                type="button"
                className="control"
                aria-disabled={scope.busy}
                onClick={() => {
                  if (!scope.busy) void unlink();
                }}
              >
                Confirm unlink Slack
              </button>
              <button
                type="button"
                className="space-secondary"
                onClick={() => setConfirming(false)}
              >
                Keep linked
              </button>
            </fieldset>
          )}
        </>
      )}
      {scope.busy && <p role="status">Updating Slack link…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

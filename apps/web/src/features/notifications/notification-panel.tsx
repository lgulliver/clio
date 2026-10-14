import { useId, useRef, useState } from 'react';
import type { Workspace } from '../identity/api';
import { readFailure } from '../space/space-scope';
import {
  type NotificationAvailability,
  parseNotificationAvailability,
  parseNotificationPolicy,
} from './api';
import { useNotificationRead, useNotificationScope } from './notification-scope';
import { OwnHistory } from './own-history';
import { OwnLink } from './own-link';
import { PolicySummary, SetupWizard } from './setup-wizard';

function OwnerSettings({ availability }: { availability: NotificationAvailability }) {
  const [wizard, setWizard] = useState<number | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Stable return target: the trigger exists only while notifications are disabled.
  const heading = useRef<HTMLHeadingElement>(null);
  const read = useNotificationRead('policy', '/policy', parseNotificationPolicy);
  const open = () => setWizard((current) => (current ?? 0) + 1);
  const policy = read.data;
  return (
    <div>
      <h3 ref={heading} tabIndex={-1} className="space-panel-title">
        Owner settings
      </h3>
      {read.checking ? (
        <p role="status">Checking access…</p>
      ) : read.isError ? (
        <div>
          <p role="alert">
            {readFailure(read, 'Notification settings are unavailable right now.')}
          </p>
          <button type="button" className="control mt-3" onClick={() => void read.refetch()}>
            Retry notification settings
          </button>
        </div>
      ) : !policy ? (
        <p role="status">Loading notification settings…</p>
      ) : (
        <>
          {!availability.emailConfigured && !availability.slackConfigured && (
            <p className="space-note">
              No delivery integration is configured for this workspace. Notifications stay off until
              whoever operates Clio configures Slack or email for it.
            </p>
          )}
          <PolicySummary policy={policy} onChange={open} />
          {wizard === null && !policy.enabled && (
            <button ref={trigger} type="button" className="control mt-3" onClick={open}>
              Set up notifications
            </button>
          )}
          {wizard !== null && (
            <SetupWizard
              key={wizard}
              availability={availability}
              policy={policy}
              onClose={() => {
                setWizard(null);
                requestAnimationFrame(() => (trigger.current ?? heading.current)?.focus());
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Private pulse notifications for one workspace and role. Owners configure delivery and see
 * aggregate state elsewhere; every signed-in member manages their own Slack link and sees only
 * their own history. Nothing here sends, queues or enables anything on its own, and refreshing
 * only re-reads saved state.
 */
export function NotificationPanel({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: Workspace['role'];
}) {
  const scope = useNotificationScope();
  const id = useId();
  const availability = useNotificationRead('availability', '/availability', (value) =>
    parseNotificationAvailability(value, { workspaceId }),
  );
  // Fence: never render this scope's data under a different workspace or role.
  if (scope.workspaceId !== workspaceId || scope.role !== role) return null;
  const data = availability.data;
  return (
    <section className="panel space-notifications" aria-labelledby={`${id}-title`}>
      <div className="space-section-heading">
        <h2 id={`${id}-title`} className="space-panel-title">
          Pulse notifications
        </h2>
        <button type="button" className="space-secondary" onClick={() => scope.refresh()}>
          Refresh notification status
        </button>
      </div>
      <p className="space-muted">
        When enabled by an owner, Clio sends a neutral private message when a pulse opens, as a
        reminder and when it closes: Slack first, verified email as the fallback. It never creates
        surveys, closes pulses or sends answers, and acceptance by a provider does not prove a
        message was delivered or read.
      </p>
      {availability.checking ? (
        <p role="status">Checking access…</p>
      ) : availability.isError ? (
        <div>
          <p role="alert">
            {readFailure(availability, 'Notification settings are unavailable right now.')}
          </p>
          <button
            type="button"
            className="control mt-3"
            onClick={() => void availability.refetch()}
          >
            Retry notifications
          </button>
        </div>
      ) : !data ? (
        <p role="status">Loading notifications…</p>
      ) : (
        <>
          {scope.owner && <OwnerSettings availability={data} />}
          <OwnLink availability={data} />
          <OwnHistory />
        </>
      )}
    </section>
  );
}

import { useId, useState } from 'react';
import { useCursorRecovery } from '../space/space-scope';
import {
  historyPath,
  type NotificationChannel,
  type NotificationKind,
  type NotificationState,
  parseOwnNotificationPage,
} from './api';
import { useNotificationRead, useNotificationScope } from './notification-scope';

export const stateLabel: Record<NotificationState, string> = {
  pending: 'Waiting to send',
  leased: 'Sending',
  retry_scheduled: 'Will retry',
  provider_accepted: 'Accepted by the provider',
  skipped: 'Skipped',
  failed: 'Could not send',
  uncertain: 'Outcome unknown',
};
const kindLabel: Record<NotificationKind, string> = {
  invitation: 'Pulse opened',
  reminder: 'Reminder',
  closure: 'Pulse closed',
  test: 'Test message',
};
const channelLabel: Record<NotificationChannel, string> = { slack: 'Slack', email: 'Email' };

function formatInstant(value: string) {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}

/**
 * Only the signed-in member's own notifications: kind, state, channel and time. Recipient
 * addresses and Slack identifiers never reach the browser. One bounded page replaces the last.
 */
export function OwnHistory() {
  const scope = useNotificationScope();
  const id = useId();
  const [cursor, setCursor] = useState<string | undefined>();
  const [notice, setNotice] = useState('');
  const workspaceId = scope.workspaceId;
  const read = useNotificationRead(`history/${cursor ?? ''}`, historyPath('', cursor), (value) =>
    parseOwnNotificationPage(value, { workspaceId, ...(cursor ? { cursor } : {}) }),
  );
  useCursorRecovery(read.missing, cursor, () => {
    setCursor(undefined);
    setNotice('That page of your notifications is no longer available. Showing the newest.');
  });
  const unavailable = read.isError && !read.checking && !(read.missing && cursor !== undefined);
  return (
    <section aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="space-panel-title">
        Your notification history
      </h3>
      <p className="space-muted">
        Only messages Clio tried to send to you. Accepted by the provider does not prove the message
        was delivered or read.
      </p>
      {unavailable ? (
        <div>
          <p role="alert">Your notification history is unavailable right now.</p>
          <button type="button" className="control mt-3" onClick={() => void read.refetch()}>
            Retry notification history
          </button>
        </div>
      ) : !read.data || read.checking ? (
        <p role="status">Loading your notification history…</p>
      ) : read.data.items.length === 0 ? (
        <p>{cursor ? 'No notifications on this older page.' : 'No notifications yet.'}</p>
      ) : (
        <div className="comparison-scroll">
          <table className="space-table">
            <caption>Up to 25 notifications per page, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Updated</th>
                <th scope="col">Message</th>
                <th scope="col">Channel</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {read.data.items.map((item) => (
                <tr key={item.id}>
                  <th scope="row">{formatInstant(item.updatedAt)}</th>
                  <td>{kindLabel[item.kind]}</td>
                  <td>{item.channel ? channelLabel[item.channel] : 'Not chosen'}</td>
                  <td>{stateLabel[item.state]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="space-pager">
        <button
          type="button"
          className="space-secondary"
          aria-disabled={cursor === undefined}
          onClick={() => {
            if (cursor === undefined) return;
            setNotice('');
            setCursor(undefined);
          }}
        >
          Newest notifications
        </button>
        <button
          type="button"
          className="space-secondary"
          aria-disabled={!read.data?.nextCursor || read.isFetching}
          onClick={() => {
            const next = read.data?.nextCursor;
            if (!next || read.isFetching) return;
            setNotice('');
            setCursor(next);
          }}
        >
          Older notifications
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

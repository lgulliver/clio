import { useState } from 'react';
import { parseOwnAssignment } from './api';
import { formatTimestamp } from './period';
import { readFailure, useCursorRecovery, useSpaceRead, useSpaceScope } from './space-scope';

/** The actor's own primary-team assignment and change history; never other people's. */
export function OwnAssignment({ compact = false }: { compact?: boolean }) {
  const scope = useSpaceScope();
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useSpaceRead(
    `assignment/${compact ? 'response' : 'page'}/${cursor ?? ''}`,
    `${scope.path}/assignment${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    (value) => parseOwnAssignment(value, scope.workspace.id, cursor),
  );
  const [notice, setNotice] = useState('');
  useCursorRecovery(query.missing, cursor, () => {
    setCursor(undefined);
    setNotice('That history page is no longer available. Showing the newest changes.');
  });
  return (
    <section
      className={compact ? 'space-own-assignment space-own-compact' : 'panel space-own-assignment'}
      aria-label="Your primary team"
    >
      <h3>Your primary team</h3>
      {query.isPending || query.checking || (query.missing && cursor !== undefined) ? (
        <p role="status">Loading your team assignment…</p>
      ) : query.isError ? (
        <div>
          <p role="alert">{readFailure(query, 'Your team assignment is unavailable right now.')}</p>
          <button className="control mt-3" type="button" onClick={() => void query.refetch()}>
            Retry team assignment
          </button>
        </div>
      ) : (
        <>
          <p className="space-own-current">{query.data.teamName ?? 'No primary team assigned'}</p>
          <p className="space-muted">
            Owners set primary teams. A pulse uses the roster frozen when it opened, so a later move
            does not remove you from an open pulse and new team members join later pulses.
          </p>
          <details className="space-history">
            <summary>Assignment history{cursor ? ' (older page)' : ''}</summary>
            {query.data.history.length === 0 ? (
              <p>No assignment changes recorded{cursor ? ' on this page' : ''}.</p>
            ) : (
              <ol>
                {query.data.history.map((change) => (
                  <li key={change.id}>
                    <time dateTime={change.changedAt}>{formatTimestamp(change.changedAt)}</time>
                    <span>
                      {change.teamName === null
                        ? 'Primary team cleared'
                        : change.teamId === null
                          ? `Removed from ${change.teamName}`
                          : `Assigned to ${change.teamName}`}
                    </span>
                  </li>
                ))}
              </ol>
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
                Newest changes
              </button>
              <button
                type="button"
                className="space-secondary"
                aria-disabled={!query.data.nextCursor || query.isFetching}
                onClick={() => {
                  if (!query.data.nextCursor || query.isFetching) return;
                  setNotice('');
                  setCursor(query.data.nextCursor);
                }}
              >
                Older changes
              </button>
            </div>
          </details>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

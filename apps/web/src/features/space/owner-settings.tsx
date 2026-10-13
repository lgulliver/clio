import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError, errorMessage, parseMembers } from '../identity/api';
import type { Team } from '../organization/api';
import { parseAssignmentPage, parseAssignmentUpdate, parsePreferences } from './api';
import { readFailure, useCursorRecovery, useSpaceRead, useSpaceScope } from './space-scope';

export function MinimumSetting({ minimum }: { minimum: number }) {
  const scope = useSpaceScope();
  const id = useId();
  const [value, setValue] = useState(String(minimum));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Follow refreshed server values without discarding an owner's unsaved edit or save notice.
  const shown = useRef(minimum);
  useEffect(() => {
    setValue((current) => (current === String(shown.current) ? String(minimum) : current));
    shown.current = minimum;
  }, [minimum]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    const parsed = Number(value);
    if (!/^\d+$/.test(value.trim()) || !Number.isInteger(parsed) || parsed < 3 || parsed > 1000) {
      setError('Enter a whole number from 3 to 1000.');
      return;
    }
    const outcome = await scope.mutate({
      path: '/preferences',
      method: 'PATCH',
      body: { minimumRespondents: parsed },
      parse: (body) => parsePreferences(body, scope.workspace.id),
      owner: true,
    });
    if (outcome.status === 'stale') return;
    if (outcome.status === 'failed') {
      setError(errorMessage(outcome.error));
      return;
    }
    shown.current = outcome.value;
    setValue(String(outcome.value));
    setNotice(`Minimum saved: ${outcome.value}. It applies to pulses opened from now on.`);
    scope.refresh();
  }
  return (
    <form className="space-owner-form" onSubmit={(event) => void submit(event)}>
      <h4>Reporting minimum</h4>
      <label htmlFor={`${id}-minimum`}>Minimum answers before a question result is shown</label>
      <input
        id={`${id}-minimum`}
        className="field"
        type="number"
        inputMode="numeric"
        min={3}
        max={1000}
        step={1}
        required
        aria-describedby={`${id}-minimum-help`}
        value={value}
        readOnly={scope.busy}
        onChange={(event) => setValue(event.target.value)}
      />
      <p id={`${id}-minimum-help`} className="space-muted">
        Default 3; allowed 3–1000. Changes apply only to pulses opened afterwards. Open and closed
        pulses keep the minimum frozen when they opened.
      </p>
      <button className="control" type="submit" aria-disabled={scope.busy}>
        Save minimum
      </button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

/**
 * Current primary teams for current workspace members. This is separate from any pulse's private
 * frozen roster; a partial page never implies a complete team roster.
 */
export function AssignmentManager({ teams }: { teams: readonly Team[] }) {
  const scope = useSpaceScope();
  const id = useId();
  const [cursor, setCursor] = useState<string | undefined>();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const assignments = useSpaceRead(
    `assignments/${cursor ?? ''}`,
    `${scope.path}/assignments${query}`,
    (value) => parseAssignmentPage(value, scope.workspace.id, cursor),
  );
  const members = useSpaceRead(
    `members/${cursor ?? ''}`,
    `/api/workspaces/${scope.workspace.id}/members${query}`,
    (value) => parseMembers(value, scope.workspace.id),
  );
  const names = new Map((members.data?.items ?? []).map((item) => [item.userId, item.name]));
  const staleCursor = cursor !== undefined && (assignments.missing || members.missing);
  useCursorRecovery(staleCursor, cursor, () => {
    setChoices({});
    setCursor(undefined);
    setNotice('That member page is no longer available. Showing the first page.');
  });
  async function save(event: FormEvent, userId: string) {
    event.preventDefault();
    setError('');
    setNotice('');
    const choice = choices[userId];
    if (choice === undefined) return;
    const teamId = choice === '' ? null : choice;
    if (teamId !== null && !teams.some((team) => team.id === teamId)) {
      setError('Choose a current team.');
      return;
    }
    const outcome = await scope.mutate({
      path: `/assignments/${encodeURIComponent(userId)}`,
      body: { teamId },
      parse: (body) => parseAssignmentUpdate(body, scope.workspace.id, userId, teamId),
      owner: true,
    });
    if (outcome.status === 'stale') return;
    if (outcome.status === 'failed') {
      const status = outcome.error instanceof ApiError ? outcome.error.status : 0;
      setError(
        status === 404
          ? 'This member or team is no longer available. The member list has been refreshed.'
          : status === 409
            ? 'This assignment changed or the team is no longer available. Refresh and try again.'
            : errorMessage(outcome.error),
      );
      if (status === 404) scope.refresh();
      return;
    }
    setChoices((current) => {
      const next = { ...current };
      delete next[userId];
      return next;
    });
    setNotice(
      `Primary team saved for ${names.get(userId) ?? 'this member'}: ${
        outcome.value.teamName ?? 'no primary team'
      }. Open pulses keep their frozen roster.`,
    );
    scope.refresh();
  }
  const loading =
    assignments.isPending ||
    members.isPending ||
    assignments.checking ||
    members.checking ||
    staleCursor;
  const failure = assignments.isError ? assignments : members.isError ? members : null;
  return (
    <section className="space-owner-form" aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`}>Primary team assignments</h4>
      <p className="space-muted">
        Assign each current workspace member to one optional primary team. Members can see their own
        assignment history. Opening a pulse freezes the team&apos;s assigned members as its roster.
        Up to 100 members per page; counts on one page do not describe a whole team.
      </p>
      {loading ? (
        <p role="status">Loading member assignments…</p>
      ) : failure ? (
        <div>
          <p role="alert">
            {readFailure(failure, 'Member assignments are unavailable right now.')}
          </p>
          <button
            className="control mt-3"
            type="button"
            onClick={() => {
              void assignments.refetch();
              void members.refetch();
            }}
          >
            Retry member assignments
          </button>
        </div>
      ) : assignments.data && assignments.data.assignments.length === 0 ? (
        <p>No current members on this page.</p>
      ) : (
        <div className="comparison-scroll">
          <table className="space-table">
            <caption>Current members and primary teams on this page</caption>
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Current primary team</th>
                <th scope="col">Change primary team</th>
              </tr>
            </thead>
            <tbody>
              {assignments.data?.assignments.map((row) => {
                const memberName = names.get(row.userId) ?? 'Name not on this member page';
                const value = choices[row.userId] ?? row.teamId ?? '';
                const known = value === '' || teams.some((team) => team.id === value);
                return (
                  <tr key={row.userId}>
                    <th scope="row">{memberName}</th>
                    <td>{row.teamName ?? 'None'}</td>
                    <td>
                      <form
                        className="space-inline-form"
                        onSubmit={(event) => void save(event, row.userId)}
                      >
                        <label className="sr-only" htmlFor={`${id}-${row.userId}`}>
                          Primary team for {memberName}
                        </label>
                        <select
                          id={`${id}-${row.userId}`}
                          className="field"
                          value={known ? value : ''}
                          disabled={scope.busy}
                          onChange={(event) =>
                            setChoices((current) => ({
                              ...current,
                              [row.userId]: event.target.value,
                            }))
                          }
                        >
                          <option value="">No primary team</option>
                          {teams.map((team) => (
                            <option key={team.id} value={team.id}>
                              {team.name}
                            </option>
                          ))}
                        </select>
                        <button
                          className="control"
                          type="submit"
                          aria-label={`Save primary team for ${memberName}`}
                          aria-disabled={scope.busy || choices[row.userId] === undefined}
                        >
                          Save
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
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
            setChoices({});
            setNotice('');
            setCursor(undefined);
          }}
        >
          First member page
        </button>
        <button
          type="button"
          className="space-secondary"
          aria-disabled={!assignments.data?.nextCursor || assignments.isFetching}
          onClick={() => {
            const next = assignments.data?.nextCursor;
            if (!next || assignments.isFetching) return;
            setChoices({});
            setNotice('');
            setCursor(next);
          }}
        >
          Next member page
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

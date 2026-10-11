import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  errorMessage,
  parseMembers,
  parsePendingInvitations,
  request,
} from '../identity/api';
import { useSession } from '../identity/session';

export function WorkspaceAccess({
  workspaceId,
  userId,
  validSelection,
  onDenied,
  onInvitationCancelled,
  onMemberRevoked,
}: {
  workspaceId: string;
  userId: string;
  validSelection: () => boolean;
  onDenied: (error: unknown) => void;
  onInvitationCancelled: (id: string) => void;
  onMemberRevoked: (email: string) => void;
}) {
  const session = useSession();
  const client = useQueryClient();
  const revision = session.revision;
  const mounted = useRef(true);
  const pending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const handledError = useRef<unknown>(null);
  const [pageRevision, setPageRevision] = useState(0);
  const [membersCursor, setMembersCursor] = useState<string | null>(null);
  const [invitationsCursor, setInvitationsCursor] = useState<string | null>(null);
  const [memberPage, setMemberPage] = useState(1);
  const [invitationPage, setInvitationPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const key = useMemo(
    () => ['identity', userId, revision, 'workspace', workspaceId, 'access'],
    [userId, revision, workspaceId],
  );
  const valid = () => mounted.current && session.current(revision) && validSelection();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void client.cancelQueries({ queryKey: key });
      client.removeQueries({ queryKey: key });
    };
  }, [client, key]);
  const membersKey = useMemo(
    () => [...key, 'members', pageRevision, membersCursor],
    [key, pageRevision, membersCursor],
  );
  const invitationsKey = useMemo(
    () => [...key, 'invitations', pageRevision, invitationsCursor],
    [key, pageRevision, invitationsCursor],
  );
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: membersKey });
      client.removeQueries({ queryKey: membersKey });
    },
    [client, membersKey],
  );
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: invitationsKey });
      client.removeQueries({ queryKey: invitationsKey });
    },
    [client, invitationsKey],
  );
  const membersQuery = useQuery({
    queryKey: membersKey,
    queryFn: async ({ signal }) => {
      const result = await request(
        `/api/workspaces/${workspaceId}/members${membersCursor === null ? '' : `?cursor=${encodeURIComponent(membersCursor)}`}`,
        (value) => parseMembers(value, workspaceId),
        { signal },
      );
      if (signal.aborted || !valid()) throw new ApiError(0);
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const invitationsQuery = useQuery({
    queryKey: invitationsKey,
    queryFn: async ({ signal }) => {
      const result = await request(
        `/api/workspaces/${workspaceId}/invitations${invitationsCursor === null ? '' : `?cursor=${encodeURIComponent(invitationsCursor)}`}`,
        (value) => parsePendingInvitations(value, workspaceId),
        { signal },
      );
      if (signal.aborted || !valid()) throw new ApiError(0);
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const recoveringCursor = [
    [membersCursor, membersQuery.error],
    [invitationsCursor, invitationsQuery.error],
  ].some(
    ([cursor, failure]) => cursor !== null && failure instanceof ApiError && failure.status === 404,
  );
  const query = {
    error:
      [membersQuery.error, invitationsQuery.error].find(
        (error) => error instanceof ApiError && [401, 403, 404].includes(error.status),
      ) ??
      membersQuery.error ??
      invitationsQuery.error,
    isPending: recoveringCursor || membersQuery.isPending || invitationsQuery.isPending,
    isFetching: membersQuery.isFetching || invitationsQuery.isFetching,
    isError: membersQuery.isError || invitationsQuery.isError,
    data:
      membersQuery.data && invitationsQuery.data
        ? { members: membersQuery.data, invitations: invitationsQuery.data }
        : undefined,
    refetch: () => Promise.all([membersQuery.refetch(), invitationsQuery.refetch()]),
  };
  function page(kind: 'members' | 'invitations', cursor: string | null) {
    if (pending.current || !valid()) return;
    heading.current?.focus();
    setError('');
    setNotice('');
    if (kind === 'members') {
      setMembersCursor(cursor);
      setMemberPage((previous) => (cursor === null ? 1 : previous + 1));
    } else {
      setInvitationsCursor(cursor);
      setInvitationPage((previous) => (cursor === null ? 1 : previous + 1));
    }
  }
  useEffect(() => {
    // A deleted or expired cursor does not establish loss of workspace access.
    // Retry from current first-page storage, whose authorization still applies.
    for (const [kind, cursor, failure] of [
      ['members', membersCursor, membersQuery.error],
      ['invitations', invitationsCursor, invitationsQuery.error],
    ] as const) {
      if (
        cursor !== null &&
        failure instanceof ApiError &&
        failure.status === 404 &&
        valid() &&
        !pending.current
      ) {
        if (heading.current?.parentElement?.contains(document.activeElement))
          heading.current.focus();
        if (kind === 'members') {
          setMembersCursor(null);
          setMemberPage(1);
        } else {
          setInvitationsCursor(null);
          setInvitationPage(1);
        }
        setNotice('Saved page position is no longer available. Returned to first page.');
        return;
      }
    }
    if (!query.error) {
      handledError.current = null;
      return;
    }
    if (!valid() || handledError.current === query.error) return;
    handledError.current = query.error;
    if (query.error instanceof ApiError && query.error.status === 401) session.expire(revision);
    else if (query.error instanceof ApiError && [403, 404].includes(query.error.status))
      onDenied(query.error);
  });
  async function remove(kind: 'members' | 'invitations', id: string, label: string, email: string) {
    if (pending.current || !valid()) return;
    pending.current = true;
    heading.current?.focus();
    setBusy(true);
    setError('');
    setNotice('');
    // Fence an older read before performing a write, then read fresh storage.
    try {
      await client.cancelQueries({ queryKey: key });
      if (!valid()) return;
      await request(
        `/api/workspaces/${workspaceId}/${kind}/${encodeURIComponent(id)}`,
        () => undefined,
        { method: 'DELETE' },
      );
      if (!valid()) return;
      if (kind === 'invitations') onInvitationCancelled(id);
      else onMemberRevoked(email);
      client.removeQueries({ queryKey: key });
      setMembersCursor(null);
      setInvitationsCursor(null);
      setMemberPage(1);
      setInvitationPage(1);
      setNotice(label);
      setPageRevision((previous) => previous + 1);
    } catch (failure) {
      if (!valid()) return;
      if (failure instanceof ApiError && failure.status === 401) session.expire(revision);
      else if (failure instanceof ApiError && [403, 404].includes(failure.status))
        onDenied(failure);
      else setError(errorMessage(failure));
    } finally {
      pending.current = false;
      if (valid()) setBusy(false);
    }
  }
  return (
    <section className="mt-6" aria-label="Workspace access">
      <h3
        ref={heading}
        tabIndex={-1}
        className="font-semibold focus-visible:outline focus-visible:outline-2"
      >
        Workspace access
      </h3>
      {notice && (
        <p className="mt-3" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-3 text-red-700" role="alert">
          {error}
        </p>
      )}
      {query.isPending || query.isFetching || busy ? (
        <p className="mt-3" role="status">
          {busy ? 'Updating access…' : 'Loading workspace access…'}
        </p>
      ) : query.isError ? (
        <div className="mt-3">
          <p role="alert">{errorMessage(query.error)}</p>
          <button
            className="control mt-3"
            type="button"
            onClick={() => {
              heading.current?.focus();
              void query.refetch();
            }}
          >
            Retry workspace access
          </button>
        </div>
      ) : (
        query.data && (
          <>
            <h4 className="mt-4 font-semibold">Members</h4>
            {query.data.members.hasMore && !query.data.members.nextCursor && (
              <p className="mt-2" role="status">
                Showing up to 100 members. More members exist; this list is incomplete.
              </p>
            )}
            {query.data.members.items.length === 0 ? (
              <p className="mt-2">No members found.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {query.data.members.items.map((member) => (
                  <li key={member.userId}>
                    <span>
                      {member.name} ({member.email}) — {member.role}
                    </span>
                    {member.role === 'member' && (
                      <button
                        className="control ml-3"
                        type="button"
                        disabled={busy}
                        aria-label={`Revoke access for ${member.name} (${member.email})`}
                        onClick={() =>
                          void remove(
                            'members',
                            member.userId,
                            `Access revoked for ${member.name}.`,
                            member.email,
                          )
                        }
                      >
                        Revoke access
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <h4 className="mt-6 font-semibold">Pending invitations</h4>
            {query.data.invitations.hasMore && !query.data.invitations.nextCursor && (
              <p className="mt-2" role="status">
                Showing up to 100 pending invitations. More invitations exist; this list is
                incomplete.
              </p>
            )}
            {query.data.invitations.items.length === 0 ? (
              <p className="mt-2">No pending invitations.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {query.data.invitations.items.map((invitation) => (
                  <li key={invitation.id}>
                    <span>
                      {invitation.email} — expires {invitation.expiresAt}
                    </span>
                    <button
                      className="control ml-3"
                      type="button"
                      disabled={busy}
                      aria-label={`Cancel invitation for ${invitation.email} (${invitation.createdAt})`}
                      onClick={() =>
                        void remove(
                          'invitations',
                          invitation.id,
                          `Invitation cancelled for ${invitation.email}.`,
                          invitation.email,
                        )
                      }
                    >
                      Cancel invitation
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      )}
      <fieldset className="mt-3 flex flex-wrap gap-3" aria-label="Members page navigation">
        <p>Members page {memberPage}</p>
        <button
          className="control"
          type="button"
          disabled={membersCursor === null || busy}
          onClick={() => page('members', null)}
        >
          First members page
        </button>
        <button
          className="control"
          type="button"
          disabled={!query.data?.members.nextCursor || busy || query.isFetching}
          onClick={() => page('members', query.data?.members.nextCursor ?? null)}
        >
          Next members page
        </button>
      </fieldset>
      <fieldset
        className="mt-3 flex flex-wrap gap-3"
        aria-label="Pending invitations page navigation"
      >
        <p>Invitations page {invitationPage}</p>
        <button
          className="control"
          type="button"
          disabled={invitationsCursor === null || busy}
          onClick={() => page('invitations', null)}
        >
          First invitations page
        </button>
        <button
          className="control"
          type="button"
          disabled={!query.data?.invitations.nextCursor || busy || query.isFetching}
          onClick={() => page('invitations', query.data?.invitations.nextCursor ?? null)}
        >
          Next invitations page
        </button>
      </fieldset>
      <button
        className="control mt-3"
        type="button"
        disabled={busy || query.isFetching}
        onClick={() => {
          heading.current?.focus();
          void query.refetch();
        }}
      >
        Refresh workspace access
      </button>
    </section>
  );
}

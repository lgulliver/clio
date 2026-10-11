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
}: {
  workspaceId: string;
  userId: string;
  validSelection: () => boolean;
  onDenied: (error: unknown) => void;
  onInvitationCancelled: (id: string | null) => void;
}) {
  const session = useSession();
  const client = useQueryClient();
  const revision = session.revision;
  const mounted = useRef(true);
  const pending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const handledError = useRef<unknown>(null);
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
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const [members, invitations] = await Promise.all([
        request(
          `/api/workspaces/${workspaceId}/members`,
          (value) => parseMembers(value, workspaceId),
          { signal },
        ),
        request(
          `/api/workspaces/${workspaceId}/invitations`,
          (value) => parsePendingInvitations(value, workspaceId),
          { signal },
        ),
      ]);
      if (!valid()) throw new ApiError(0);
      return { members, invitations };
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
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
  async function remove(kind: 'members' | 'invitations', id: string, label: string) {
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
      onInvitationCancelled(kind === 'invitations' ? id : null);
      setNotice(label);
      await client.invalidateQueries({ queryKey: key });
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
            {query.data.members.hasMore && (
              <p className="mt-2" role="status">
                Showing first 100 members. More members exist; this list is incomplete.
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
            {query.data.invitations.hasMore && (
              <p className="mt-2" role="status">
                Showing first 100 pending invitations. More invitations exist; this list is
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
    </section>
  );
}

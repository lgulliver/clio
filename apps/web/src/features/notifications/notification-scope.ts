import { useCallback, useEffect, useRef } from 'react';
import { type MutationOutcome, useSpaceRead, useSpaceScope } from '../space/space-scope';

type WriteInput<T> = {
  path: string;
  body: object;
  parse: (value: unknown) => T;
  method?: 'PATCH';
  /** Owner-only writes recheck the latest workspace role before and after the request. */
  owner: boolean;
  /** Narrower fence for the component that started the write. */
  still?: () => boolean;
};

/**
 * Notification reads and writes ride the SPACE scope's identity/session revision, workspace,
 * role and abort fences: a write from a demoted, removed or unmounted scope is reported `stale`
 * and its late result never renders. The namespace is a trusted internal constant.
 */
export function useNotificationScope() {
  const scope = useSpaceScope();
  const base = `/api/workspaces/${scope.workspace.id}/notifications`;
  const mutate = scope.mutate;
  const write = useCallback(
    <T>(input: WriteInput<T>): Promise<MutationOutcome<T>> =>
      mutate({ ...input, namespace: 'notifications' }),
    [mutate],
  );
  const refreshScope = scope.refresh;
  const refresh = useCallback(() => refreshScope('notifications'), [refreshScope]);
  return {
    workspaceId: scope.workspace.id,
    role: scope.workspace.role,
    owner: scope.owner,
    busy: scope.busy,
    base,
    write,
    refresh,
    verify: scope.verify,
  };
}

/** Scoped private read of one notification route (`route` begins with a slash). */
export function useNotificationRead<T>(
  key: string,
  route: string,
  parse: (value: unknown) => T,
  enabled = true,
) {
  const scope = useSpaceScope();
  return useSpaceRead(
    key,
    `/api/workspaces/${scope.workspace.id}/notifications${route}`,
    parse,
    enabled,
    'notifications',
  );
}

/**
 * `still()` is true until the owning component unmounts, so a write that finishes after the
 * user closed or replaced the panel never updates it.
 */
export function useStill() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return useCallback(() => alive.current, []);
}

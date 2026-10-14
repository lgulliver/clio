import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, errorMessage, request, type Workspace } from '../identity/api';
import { useSession } from '../identity/session';
import { useStoredRead } from '../result-history/history-browser';

export type MutationOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'stale' };

/**
 * Result of rechecking current workspace membership/role through the authenticated workspace
 * list: unchanged access, a different role, a missing workspace, unverifiable metadata, or a
 * selection/session that is no longer current.
 */
export type AccessVerdict = 'unchanged' | 'changed' | 'gone' | 'unknown' | 'stale';

/** Trusted internal API areas sharing this scope's fences; never caller or browser input. */
export type ScopeNamespace = 'space' | 'notifications';

type MutationInput<T> = {
  /** Defaults to `space`; `notifications` targets the workspace notification routes. */
  namespace?: ScopeNamespace;
  path: string;
  parse: (value: unknown) => T;
  body: object;
  method?: 'PATCH';
  /** Owner-only writes recheck the latest workspace role before and after the request. */
  owner: boolean;
  /** Narrower fence for the detail, pulse or wizard that started the write. */
  still?: () => boolean;
};

type SpaceScope = {
  workspace: Workspace;
  path: string;
  owner: boolean;
  busy: boolean;
  readScope: (suffix: string, namespace?: ScopeNamespace) => string;
  mutate: <T>(input: MutationInput<T>) => Promise<MutationOutcome<T>>;
  /** Resolves true only when current access and role are verified unchanged. */
  verify: () => Promise<boolean>;
  /** Re-reads saved data of one namespace (default `space`); never sends or queues anything. */
  refresh: (namespace?: ScopeNamespace) => void;
};

const Context = createContext<SpaceScope | null>(null);

export function useSpaceScope() {
  const scope = useContext(Context);
  if (!scope) throw new Error('SpaceScopeProvider is required');
  return scope;
}

/** A denial or unverifiable payload that may mean access/role changed and must be rechecked. */
function suspicious(error: unknown) {
  return (
    error instanceof ApiError &&
    (error.status === 0 || error.status === 403 || error.status === 404)
  );
}

/**
 * Private SPACE state for one workspace and role. The parent remounts this provider when the
 * workspace, role or access attempt changes; every write still rechecks the live session,
 * selection and latest role so late replies cannot reappear in another scope. A 403/404 or an
 * unverifiable payload is not treated as access loss until current membership is revalidated;
 * if access and role are unchanged, the caller handles a local stale target or cursor.
 */
export function SpaceScopeProvider({
  workspace,
  validSelection,
  latestRole,
  revalidate,
  children,
}: {
  workspace: Workspace;
  validSelection: () => boolean;
  latestRole: () => Workspace['role'] | undefined;
  revalidate: (role: Workspace['role']) => Promise<AccessVerdict>;
  children: ReactNode;
}) {
  const session = useSession();
  const client = useQueryClient();
  const revision = session.revision;
  const userId = session.user?.id;
  const mounted = useRef(true);
  const lost = useRef(false);
  const pending = useRef(false);
  const epoch = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const [busy, setBusy] = useState(false);
  const prefixFor = useCallback(
    (namespace: ScopeNamespace) => `${namespace}/${workspace.id}/${workspace.role}/`,
    [workspace.id, workspace.role],
  );
  useEffect(() => {
    mounted.current = true;
    const active = controllers.current;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      for (const controller of active) controller.abort();
      active.clear();
    };
  }, []);
  const valid = useCallback(
    (owner: boolean, still?: () => boolean) =>
      mounted.current &&
      !lost.current &&
      session.current(revision) &&
      validSelection() &&
      latestRole() === workspace.role &&
      (!owner || latestRole() === 'owner') &&
      (still ? still() : true),
    [session.current, revision, validSelection, latestRole, workspace.role],
  );
  const verify = useCallback(async () => {
    if (!valid(false)) return false;
    const verdict = await revalidate(workspace.role);
    if (verdict === 'unchanged' && valid(false)) return true;
    if (verdict !== 'stale' && mounted.current && !lost.current) {
      // Access, role or metadata changed: fence every pending write in this role-scoped tree.
      lost.current = true;
      epoch.current += 1;
      for (const controller of controllers.current) controller.abort();
    }
    return false;
  }, [revalidate, valid, workspace.role]);
  const refresh = useCallback(
    (namespace: ScopeNamespace = 'space') => {
      if (!valid(false)) return;
      const prefix = prefixFor(namespace);
      void client.invalidateQueries({
        predicate: (entry) =>
          entry.queryKey[0] === 'identity' &&
          entry.queryKey[1] === userId &&
          entry.queryKey[2] === revision &&
          typeof entry.queryKey[4] === 'string' &&
          entry.queryKey[4].startsWith(prefix),
      });
    },
    [client, prefixFor, revision, userId, valid],
  );
  const mutate = useCallback(
    async <T,>(input: MutationInput<T>): Promise<MutationOutcome<T>> => {
      if (pending.current || !valid(input.owner, input.still)) return { status: 'stale' };
      pending.current = true;
      setBusy(true);
      const ticket = epoch.current;
      const controller = new AbortController();
      controllers.current.add(controller);
      const current = () =>
        ticket === epoch.current && !controller.signal.aborted && valid(input.owner, input.still);
      try {
        const value = await request(
          `/api/workspaces/${workspace.id}/${input.namespace ?? 'space'}${input.path}`,
          input.parse,
          {
            body: input.body,
            signal: controller.signal,
            ...(input.method ? { method: input.method } : {}),
          },
        );
        return current() ? { status: 'ok', value } : { status: 'stale' };
      } catch (error) {
        if (!current()) return { status: 'stale' };
        if (error instanceof ApiError && error.status === 401) {
          session.expire(revision);
          return { status: 'stale' };
        }
        if (suspicious(error)) {
          // The pending guard stays held while membership is rechecked.
          const unchanged = await verify();
          return unchanged && current() ? { status: 'failed', error } : { status: 'stale' };
        }
        return { status: 'failed', error };
      } finally {
        controllers.current.delete(controller);
        pending.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [revision, session.expire, valid, verify, workspace.id],
  );
  const value = useMemo<SpaceScope>(
    () => ({
      workspace,
      path: `/api/workspaces/${workspace.id}/space`,
      owner: workspace.role === 'owner',
      busy,
      readScope: (suffix, namespace = 'space') => `${prefixFor(namespace)}${suffix}`,
      mutate,
      verify,
      refresh,
    }),
    [workspace, busy, prefixFor, mutate, verify, refresh],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/**
 * Scoped private read keyed by identity/revision/workspace/role/filter/cursor. A denied or
 * unverifiable reply triggers one membership revalidation per error. While that check runs the
 * read reports `checking` (render no alert); `missing` means access is unchanged and the target
 * or cursor itself is stale, so the caller recovers locally. Changed access remounts or hides the
 * scope from the parent.
 */
export function useSpaceRead<T>(
  suffix: string,
  path: string,
  parse: (value: unknown) => T,
  enabled = true,
  namespace: ScopeNamespace = 'space',
) {
  const scope = useSpaceScope();
  const query = useStoredRead(scope.readScope(suffix, namespace), path, parse, enabled);
  const error = query.error;
  const needsCheck = suspicious(error);
  const verify = useRef(scope.verify);
  verify.current = scope.verify;
  const [verified, setVerified] = useState<unknown>(null);
  useEffect(() => {
    if (!needsCheck) return;
    let active = true;
    void verify.current().then((unchanged) => {
      if (active && unchanged) setVerified(error);
    });
    return () => {
      active = false;
    };
  }, [needsCheck, error]);
  const checking = needsCheck && verified !== error;
  const missing =
    !checking && error instanceof ApiError && (error.status === 403 || error.status === 404);
  return { ...query, checking, missing };
}

/** Safe local text for a failed read; a verified stale target never claims lost access. */
export function readFailure(read: { error: unknown; missing: boolean }, missingText: string) {
  return read.missing ? missingText : errorMessage(read.error);
}

/**
 * When an older cursor's anchor disappeared (access verified unchanged), replace the page with
 * the newest verified page instead of hiding the scope. Runs without moving focus.
 */
export function useCursorRecovery(
  missing: boolean,
  cursor: string | undefined,
  recover: () => void,
) {
  const latest = useRef(recover);
  latest.current = recover;
  useEffect(() => {
    if (missing && cursor !== undefined) latest.current();
  }, [missing, cursor]);
}

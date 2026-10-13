import { createContext, type ReactNode, useContext, useState } from 'react';
import { useSession } from '../identity/session';
import { useSpaceScope } from '../space/space-scope';

type Window = { windowStart: string; windowEnd: string };
type Mapping = { id: string; revision: number };

/**
 * Unresolved collection request IDs, held in memory only. An enqueue whose outcome is unknown
 * (network error, 5xx, unverifiable reply or a reply that arrived after its view closed) may have
 * been accepted, so retrying the same mapping revision and window must reuse its request ID. The
 * store outlives repository detail and setup wizard remounts, and it is replaced whenever the
 * session, workspace or role differs from the scope that created it. Nothing is persisted.
 */
type IntentStore = { scope: string; ids: Map<string, string> };

const Context = createContext<{ current: IntentStore } | null>(null);

/** Mount once inside the role-scoped SPACE provider, around every view that can collect. */
export function CollectIntentProvider({ children }: { children: ReactNode }) {
  // A stable mutable holder: changes never need to re-render anything.
  const [holder] = useState(() => ({ current: { scope: '', ids: new Map<string, string>() } }));
  return <Context.Provider value={holder}>{children}</Context.Provider>;
}

function intentKey(mapping: Mapping, window: Window) {
  return `${mapping.id}:${mapping.revision}:${window.windowStart}:${window.windowEnd}`;
}

export function useCollectIntents() {
  const holder = useContext(Context);
  const scope = useSpaceScope();
  const session = useSession();
  if (!holder) throw new Error('CollectIntentProvider is required');
  const intents = holder;
  const owner = `${session.user?.id ?? ''}:${session.revision}:${scope.workspace.id}:${scope.workspace.role}`;
  function store() {
    if (intents.current.scope !== owner) intents.current = { scope: owner, ids: new Map() };
    return intents.current.ids;
  }
  return {
    /** The unresolved request ID for this revision and window, or a new one recorded as unresolved. */
    requestId(mapping: Mapping, window: Window) {
      const ids = store();
      const key = intentKey(mapping, window);
      const existing = ids.get(key);
      if (existing) return existing;
      const created = crypto.randomUUID();
      ids.set(key, created);
      return created;
    },
    /** Explicit reconciliation: the server confirmed this request, so it is no longer unresolved. */
    resolve(mapping: Mapping, window: Window, id: string) {
      const ids = store();
      const key = intentKey(mapping, window);
      if (ids.get(key) === id) ids.delete(key);
    },
  };
}

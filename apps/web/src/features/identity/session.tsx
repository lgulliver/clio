import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { navigateExternal } from '../../lib/navigation';
import {
  ApiError,
  errorMessage,
  parseLogout,
  parseRedirect,
  parseUser,
  request,
  type User,
} from './api';

type SessionState = {
  status: 'checking' | 'signed-out' | 'ready' | 'error';
  user: User | null;
  revision: number;
  error: string;
};
type Session = SessionState & {
  refresh: () => void;
  current: (revision: number) => boolean;
  expire: (revision: number) => void;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  busy: boolean;
};
const Context = createContext<Session | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const action = useRef(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<SessionState>({
    status: 'checking',
    user: null,
    revision: 0,
    error: '',
  });
  const latest = useRef(state);
  latest.current = state;
  const clear = useCallback(() => {
    epoch.current += 1;
    controller.current?.abort();
    void client.cancelQueries();
    client.clear();
    setBusy(false);
    action.current = false;
    return epoch.current;
  }, [client]);
  const refresh = useCallback(() => {
    const revision = clear();
    setState({ status: 'checking', user: null, revision, error: '' });
    const next = new AbortController();
    controller.current = next;
    void request('/api/me', parseUser, { signal: next.signal })
      .then((user) => {
        if (epoch.current === revision) setState({ status: 'ready', user, revision, error: '' });
      })
      .catch((error: unknown) => {
        if (epoch.current !== revision) return;
        setState({
          status: error instanceof ApiError && error.status === 401 ? 'signed-out' : 'error',
          user: null,
          revision,
          error: error instanceof ApiError && error.status === 401 ? '' : errorMessage(error),
        });
      });
  }, [clear]);
  const recheck = useCallback(() => {
    const previous = latest.current;
    if (previous.status !== 'ready' || !previous.user) return;
    const revision = epoch.current;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    void request('/api/me', parseUser, { signal: next.signal })
      .then((user) => {
        if (epoch.current !== revision || next.signal.aborted) return;
        const changed = user.id !== previous.user?.id;
        const currentRevision = changed ? clear() : revision;
        setState({ status: 'ready', user, revision: currentRevision, error: '' });
      })
      .catch((error: unknown) => {
        if (epoch.current !== revision || next.signal.aborted) return;
        const currentRevision = clear();
        const expired = error instanceof ApiError && error.status === 401;
        setState({
          status: expired ? 'signed-out' : 'error',
          user: null,
          revision: currentRevision,
          error: expired ? '' : errorMessage(error),
        });
      });
  }, [clear]);
  const expire = useCallback(
    (revision: number) => {
      if (epoch.current !== revision) return;
      const next = clear();
      setState({
        status: 'signed-out',
        user: null,
        revision: next,
        error: 'Your session ended. Sign in again.',
      });
    },
    [clear],
  );
  useEffect(() => {
    refresh();
    const focus = () => {
      if (document.visibilityState !== 'hidden' && !action.current) recheck();
    };
    const visibility = () => {
      if (action.current) return;
      if (document.visibilityState === 'hidden') {
        const revision = clear();
        setState({ status: 'checking', user: null, revision, error: '' });
      } else refresh();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      epoch.current += 1;
      controller.current?.abort();
      void client.cancelQueries();
      client.clear();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [refresh, recheck, clear, client]);
  async function login() {
    if (action.current) return;
    action.current = true;
    setBusy(true);
    const revision = epoch.current;
    try {
      const url = await request('/api/auth/sign-in/social', parseRedirect, {
        body: {
          provider: 'github',
          disableRedirect: true,
          callbackURL: `${window.location.origin}/settings`,
        },
      });
      if (revision === epoch.current) navigateExternal(url);
    } catch (error) {
      if (revision === epoch.current)
        setState((previous) => ({ ...previous, error: errorMessage(error) }));
    } finally {
      if (revision === epoch.current) {
        action.current = false;
        setBusy(false);
      }
    }
  }
  async function logout() {
    if (action.current) return;
    const revision = clear();
    action.current = true;
    setBusy(true);
    setState({ status: 'checking', user: null, revision, error: '' });
    try {
      await request('/api/auth/sign-out', parseLogout, { body: {} });
      if (revision === epoch.current)
        setState({ status: 'signed-out', user: null, revision, error: '' });
    } catch (error) {
      if (revision === epoch.current)
        setState({
          status: 'error',
          user: null,
          revision,
          error: `Sign out could not be confirmed. ${errorMessage(error)}`,
        });
    } finally {
      if (revision === epoch.current) {
        action.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <Context.Provider
      value={{
        ...state,
        refresh,
        expire,
        current: (revision) => epoch.current === revision,
        login,
        logout,
        busy,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const session = useContext(Context);
  if (!session) throw new Error('SessionProvider is required');
  return session;
}
export function IdentityControls() {
  const session = useSession();
  return (
    <div className="text-sm">
      {session.status === 'ready' ? (
        <div className="flex items-center gap-3">
          <span>Signed in as {session.user?.name}</span>
          <button
            className="control"
            type="button"
            disabled={session.busy}
            onClick={() => void session.logout()}
          >
            Sign out
          </button>
        </div>
      ) : session.status === 'signed-out' ? (
        <button
          className="control"
          type="button"
          disabled={session.busy}
          onClick={() => void session.login()}
        >
          {session.busy ? 'Opening GitHub…' : 'Sign in with GitHub'}
        </button>
      ) : session.status === 'checking' ? (
        <p role="status">{session.busy ? 'Signing out…' : 'Checking your session…'}</p>
      ) : (
        <div className="flex gap-3">
          <button className="control" type="button" onClick={session.refresh}>
            Retry sign-in check
          </button>
          {session.error.startsWith('Sign out could not be confirmed.') && (
            <button className="control" type="button" onClick={() => void session.logout()}>
              Retry sign out
            </button>
          )}
        </div>
      )}
      {session.error && (
        <p role="alert" className="mt-2 text-red-700">
          {session.error}
        </p>
      )}
    </div>
  );
}

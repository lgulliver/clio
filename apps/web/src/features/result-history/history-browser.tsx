import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, errorMessage, request } from '../identity/api';
import { useSession } from '../identity/session';

// Each mounted scope owns its cache. Abandoned selection results must never return.
export function useStoredRead<T>(
  scope: string,
  path: string,
  parse: (value: unknown) => T,
  enabled = true,
) {
  const session = useSession();
  const client = useQueryClient();
  const mounted = useRef(true);
  const revision = session.revision;
  const key = useMemo(
    () => ['identity', session.user?.id, revision, 'overview', scope],
    [session.user?.id, revision, scope],
  );
  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: async ({ signal }) => {
      const value = await request(path, parse, { signal });
      if (signal.aborted || !mounted.current || !session.current(revision)) throw new ApiError(0);
      return value;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void client.cancelQueries({ queryKey: key });
      client.removeQueries({ queryKey: key });
    };
  }, [client, key]);
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) session.expire(revision);
  }, [query.error, session.expire, revision]);
  return query;
}

/** One bounded page replaces the previous page; refresh never accumulates records. */
export function HistoryBrowser<
  R extends {
    id: string;
    createdAt: string;
    result: { window: { start: string; end: string } } | null;
  },
>({
  title,
  path,
  parse,
  onAccessLost,
  renderResult,
}: {
  title: string;
  path: string;
  parse: (
    value: unknown,
    options: { cursor?: string; succeeded?: boolean },
  ) => { runs: R[]; nextCursor: string | null };
  onAccessLost: () => void;
  renderResult: (newest: R | undefined, selected: R | undefined, page: R[]) => ReactNode;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState('');
  const recent = useStoredRead(`${path}/recent`, path, (value) => parse(value, {}));
  const newest = useStoredRead(`${path}/succeeded`, `${path}?status=succeeded`, (value) =>
    parse(value, { succeeded: true }),
  );
  const older = useStoredRead(
    `${path}/succeeded/${cursor ?? ''}`,
    `${path}?status=succeeded&cursor=${cursor ?? ''}`,
    (value) => parse(value, { succeeded: true, ...(cursor === undefined ? {} : { cursor }) }),
    cursor !== undefined,
  );
  const page = cursor === undefined ? newest : older;
  const errors = [recent.error, newest.error, older.error];
  const accessLost = errors.some(
    (error) => error instanceof ApiError && [401, 403, 404].includes(error.status),
  );
  useLayoutEffect(() => {
    if (accessLost) onAccessLost();
  }, [accessLost, onAccessLost]);
  const selected = page.data?.runs.find((run) => run.id === selectedId) ?? page.data?.runs[0];
  const refreshing =
    recent.isFetching || newest.isFetching || (cursor !== undefined && older.isFetching);
  return (
    <section aria-label={`${title} stored results`} className="panel history-browser">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="history-controls mt-3 flex flex-wrap gap-2">
        <button
          className="control aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          type="button"
          aria-disabled={refreshing}
          onClick={() => {
            if (refreshing) return;
            void recent.refetch();
            void newest.refetch();
            if (cursor !== undefined) void older.refetch();
          }}
        >
          Refresh {title} history
        </button>
        <button
          className="control aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          type="button"
          aria-disabled={cursor === undefined && selectedId === ''}
          onClick={() => {
            if (cursor === undefined && selectedId === '') return;
            setCursor(undefined);
            setSelectedId('');
          }}
        >
          Newest {title} saved result
        </button>
        <button
          className="control aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          type="button"
          aria-disabled={page.isFetching || !page.data?.nextCursor}
          onClick={() => {
            if (page.isFetching || !page.data?.nextCursor) return;
            setCursor(page.data.nextCursor);
            setSelectedId('');
          }}
        >
          Older {title} saved results
        </button>
      </div>
      {accessLost ? null : recent.isError || newest.isError || page.isError ? (
        <p role="alert">{errorMessage(recent.error ?? newest.error ?? page.error)}</p>
      ) : recent.isPending || page.isPending ? (
        <p role="status">Loading stored requests and saved results…</p>
      ) : (
        <>
          {page.data.runs.length > 0 && (
            <label className="mt-3 block">
              {title} saved reporting window
              <select
                className="field"
                value={selected?.id ?? ''}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {page.data.runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.result?.window.start} to {run.result?.window.end} · requested{' '}
                    {run.createdAt}
                  </option>
                ))}
              </select>
            </label>
          )}
          {cursor !== undefined && page.data.runs.length === 0 && (
            <p>No saved results on this older page.</p>
          )}
          {renderResult(recent.data.runs[0], selected, page.data.runs)}
        </>
      )}
    </section>
  );
}

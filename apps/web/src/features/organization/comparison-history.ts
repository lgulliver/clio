import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { ApiError, request, type Service } from '../identity/api';
import { useSession } from '../identity/session';
import { type ComparisonSource, parseComparison } from './comparison-data';

/** Dynamic service page with the same identity, cancellation and cache lifetime as stored reads. */
export function useComparisonHistories(
  services: Service[],
  source: ComparisonSource,
  onAccessLost: () => void,
) {
  const session = useSession();
  const client = useQueryClient();
  const mounted = useRef(true);
  const revision = session.revision;
  const instance = useId();
  const signature = services
    .map(
      (service) =>
        `/api/workspaces/${service.workspaceId}/services/${service.id}/${source === 'measurement' ? 'measurement' : `${source}-collection`}-runs?status=succeeded`,
    )
    .join('\n');
  const definitions = useMemo(
    () =>
      signature
        ? signature.split('\n').map((path) => ({
            path,
            key: [
              'identity',
              session.user?.id,
              revision,
              'overview',
              'group-comparison',
              instance,
              path,
            ],
          }))
        : [],
    [signature, session.user?.id, revision, instance],
  );
  const queries = useQueries({
    queries: definitions.map(({ key, path }, index) => ({
      queryKey: key,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const service = services[index];
        if (!service || !session.current(revision)) throw new ApiError(0);
        const result = await request(
          path,
          (value) =>
            parseComparison(
              value,
              { workspaceId: service.workspaceId, serviceId: service.id },
              source,
            ),
          { signal },
        );
        if (signal.aborted || !mounted.current || !session.current(revision)) throw new ApiError(0);
        return result;
      },
      enabled: !!session.user,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const definition of definitions) {
        void client.cancelQueries({ queryKey: definition.key });
        client.removeQueries({ queryKey: definition.key });
      }
    };
  }, [client, definitions]);
  const unauthorized = queries.some(
    (query) => query.error instanceof ApiError && query.error.status === 401,
  );
  const denied = queries.some(
    (query) => query.error instanceof ApiError && [401, 403, 404].includes(query.error.status),
  );
  useLayoutEffect(() => {
    if (unauthorized) session.expire(revision);
    if (denied) onAccessLost();
  }, [unauthorized, denied, session.expire, revision, onAccessLost]);
  return queries;
}

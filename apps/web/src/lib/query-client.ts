import { QueryClient } from '@tanstack/react-query';

/** Create per app/test instance; do not share cache across workspaces or requests. */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1 },
    },
  });
}

import { QueryClient } from '@tanstack/react-query';
import { shouldRetryQuery } from '@/lib/query/retryPolicy';
import { onApiWrite } from '@/lib/utils/apiWriteSignal';

/**
 * The QueryClient for the firm workspace (`/lawfirm/[lawFirmId]`).
 *
 * Results stay fresh for two minutes and are NOT refetched when the window
 * regains focus. Focus refetch re-ran every stale mounted query on each return
 * to the tab, the dashboard summary (25-30 database queries) among them, which
 * made it the largest source of API traffic for a user switching windows.
 *
 * Two things keep that from showing stale data:
 * - `markQueriesStaleOnApiWrite` marks the cache stale after any successful
 *   write, so a screen remounted after the user's own edit re-reads it.
 * - Queries showing data that OTHER people change, with no Realtime channel or
 *   invalidation to report it, opt back in with `REFRESH_ON_FOCUS`.
 *
 * Call once per layout instance (a `useState` initializer), never at module
 * scope: a module-level client would be shared by every server render.
 */
export function createLawFirmQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 2 * 60_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
      },
    },
  });
}

/**
 * Per-query opt-in to the old refresh behaviour: re-read when the window regains
 * focus once the data is 30 seconds old. Spread it into a query whose data is
 * changed by someone else (another member, a client in the portal, an external
 * signer) and that nothing else refreshes, with a comment naming who changes it.
 */
export const REFRESH_ON_FOCUS = {
  staleTime: 30_000,
  refetchOnWindowFocus: true,
} as const;

/**
 * Mark every cached query stale after a successful API write, without fetching
 * anything. Mounted queries keep what they show (the screen that made the write
 * refreshes its own data); the next screen to mount a query re-reads it instead
 * of serving the result from before the write. Returns the unsubscribe function.
 */
export function markQueriesStaleOnApiWrite(queryClient: QueryClient): () => void {
  return onApiWrite(() => {
    void queryClient.invalidateQueries({ refetchType: 'none' });
  });
}

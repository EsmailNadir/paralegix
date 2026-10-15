import { hashKey, type QueryClient } from '@tanstack/react-query';

/** One cache entry to fill from a combined response, or null to leave it alone. */
export type QuerySeed = { name: string; key: readonly unknown[]; data: unknown } | null;

/**
 * Fetch a response that combines several endpoints' bodies, and write each part
 * into the cache entry its own query reads.
 *
 * Lets a page open with one request while every section keeps its own query,
 * key and endpoint, so the invalidations already issued elsewhere still reach
 * it and re-read only that section.
 *
 * A part is NOT written when its query was invalidated while the combined
 * request was in flight: that copy predates the change that invalidated it, and
 * the section's own query re-reads it instead. A null seed (a section the
 * response left out, such as one the member may not see) is skipped too, so its
 * query reads its own endpoint as it always did.
 *
 * Resolves to the names of the entries it wrote.
 */
export async function fetchAndSeed<T>(
  queryClient: QueryClient,
  fetch: () => Promise<T>,
  seeds: (body: T) => QuerySeed[],
): Promise<string[]> {
  const invalidatedInFlight = new Set<string>();
  const stopWatching = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'invalidate') {
      invalidatedInFlight.add(event.query.queryHash);
    }
  });

  let body: T;
  try {
    body = await fetch();
  } finally {
    stopWatching();
  }

  const written: string[] = [];
  for (const seed of seeds(body)) {
    if (!seed || invalidatedInFlight.has(hashKey(seed.key))) continue;
    queryClient.setQueryData(seed.key, seed.data);
    written.push(seed.name);
  }
  return written;
}

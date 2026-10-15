/**
 * Dev-only duplicate-request guard.
 *
 * The whole app funnels its API calls through `apiFetch`, so this is the one
 * place that sees every real network request. When the SAME GET endpoint is
 * requested more than once in a short window it's almost always a bug:
 *  - two React Query hooks fetching the same data under DIFFERENT queryKeys
 *     (React Query can't dedupe across keys, so it fires twice), or
 *  - a raw `useEffect` + fetch that should be a shared, cached hook.
 *
 * Both waste a round trip on every page that mounts them. This guard surfaces
 * them loudly during development (one warning per endpoint per session) so the
 * pattern is caught in review instead of only by a manual network-tab audit.
 *
 * It is a no-op in production (guarded on NODE_ENV) and can be silenced in dev
 * with `NEXT_PUBLIC_DUP_FETCH_WARN=off`. Only GETs are tracked - mutations
 * (POST/PUT/PATCH/DELETE) legitimately repeat. The full URL including its query
 * string is the key, so two calls with different params (e.g. charge-codes
 * `includeInactive=true` vs `false`) are correctly treated as distinct.
 */

// Two identical GETs within this window count as a duplicate. Comfortably covers
// a single page's mount fan-out without spanning separate navigations.
const WINDOW_MS = 2000;

// url -> timestamp of the most recent GET (rolling; pruned opportunistically).
const recentGets = new Map<string, number>();
// Warn at most once per endpoint per page session to keep the console readable.
const warnedUrls = new Set<string>();

function isEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.NEXT_PUBLIC_DUP_FETCH_WARN === 'off') return false;
  return true;
}

// Drop the API origin so the warning shows a readable path, not the full host.
function shortenUrl(url: string): string {
  const q = url.indexOf('/api/');
  return q >= 0 ? url.slice(q) : url;
}

/**
 * Record a request and warn (dev-only) if it duplicates a recent identical GET.
 * Safe to call on every `apiFetch`; returns nothing and never throws.
 */
export function trackDuplicateRequest(url: string, method: string = 'GET'): void {
  if (!isEnabled()) return;
  if ((method || 'GET').toUpperCase() !== 'GET') return;

  const now = Date.now();
  const last = recentGets.get(url);
  recentGets.set(url, now);

  // Opportunistic cleanup so the map can't grow unbounded across a long session.
  if (recentGets.size > 300) {
    for (const [k, t] of recentGets) {
      if (now - t > WINDOW_MS) recentGets.delete(k);
    }
  }

  if (last != null && now - last <= WINDOW_MS && !warnedUrls.has(url)) {
    warnedUrls.add(url);
    console.warn(
      `[duplicate-fetch] GET ${shortenUrl(url)} was requested more than once within ${WINDOW_MS}ms. ` +
        `Two callers are likely fetching the same endpoint under different React Query keys, ` +
        `or via a raw fetch that should be a shared hook. Consolidate onto one canonical hook / ` +
        `queryKey so React Query serves both from a single request. (dev-only check; ` +
        `set NEXT_PUBLIC_DUP_FETCH_WARN=off to silence)`,
    );
  }
}

/** Test-only: clear the internal state between cases. */
export function __resetDuplicateRequestGuard(): void {
  recentGets.clear();
  warnedUrls.clear();
}

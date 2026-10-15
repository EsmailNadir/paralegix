/**
 * Short-TTL in-memory cache of the RESOLVED PERMISSION SET for a member,
 * keyed by BOTH (lawFirmId, userId).
 *
 * WHY THIS IS SAFE (and different from the disabled token cache):
 *   The prior caching bug (see the big comment in
 *   `src/shared/middleware/auth.js`) was a TOKEN cache keyed only on the
 *   Firebase UID that returned the WRONG USER's decoded token after a
 *   logout/login on the same browser. This cache is fundamentally different:
 *     (a) it caches a derived PERMISSION SET, never an auth token / identity;
 *     (b) the key includes BOTH lawFirmId AND userId, so there is no way for
 *         one user's entry to be served for another user or another firm;
 *     (c) the entry is the same permission array that
 *         `resolvePermissions(lawFirmId, member)` would compute fresh. The
 *         authorization decision is byte-identical, only memoized.
 *
 * STALENESS BOUNDING:
 *   - A short TTL (30s) is the backstop: even if an invalidation is missed,
 *     a permission change takes effect within 30s.
 *   - Explicit invalidation on the relevant mutations makes changes effective
 *     immediately (see permissionCache.events.js): member removed, member role
 *     changed, and a role's permission array edited.
 *
 * NEVER FAIL OPEN: this module only stores/returns previously-resolved sets.
 * It never fabricates permissions. A cache MISS returns undefined so the caller
 * resolves fresh from the DB; it never substitutes an empty or full set on its
 * own.
 */

import { createBoundedCache } from '../../../shared/utils/boundedCache';

export const TTL_MS = 30 * 1000; // 30s backstop against any missed invalidation

/**
 * Hard ceiling on cached members.
 *
 * The key is (firm, user), so it grows with the customer base times its
 * members, and the TTL alone does not bound it: an expired entry is removed
 * only when that same key is read again, and the keys that make this cache grow
 * are the ones nobody reads twice. At the ceiling the least recently used entry
 * is evicted, which costs one permission query, never an access decision.
 */
export const MAX_ENTRIES = Number(process.env.PERMISSION_CACHE_MAX_ENTRIES) || 5000;

interface CachedMember { isOwner?: boolean; resolvedPermissions?: string[]; [k: string]: unknown }

const store = createBoundedCache<CachedMember>({
  name: 'permissionCache',
  maxEntries: MAX_ENTRIES,
  ttlMs: TTL_MS,
});

function keyFor(lawFirmId: string, userId: string) {
  // Both components are part of the key. A user only ever reads their own
  // firm-scoped entry. The separator cannot appear inside an id, which is what
  // lets `invalidateFirm` match on a prefix without `firm-1` also matching
  // `firm-10`.
  return `${lawFirmId} ${userId}`;
}

/**
 * Return the cached resolved member for (lawFirmId, userId), or undefined on
 * miss or expiry. The cached value is the shaped member object WITH
 * `resolvedPermissions` already attached, exactly what `requirePermission`
 * would otherwise build fresh (owner flag + permission set), so the
 * authorization decision is identical, only memoized. A fresh copy is returned
 * (member object AND its resolvedPermissions array) so a caller mutating
 * `req.member` cannot corrupt the cached entry.
 */
export function get(lawFirmId: string, userId: string) {
  if (!lawFirmId || !userId) return undefined;
  const entry = store.get(keyFor(lawFirmId, userId));
  if (!entry) return undefined;
  const copy: any = { ...entry };
  if (Array.isArray(copy.resolvedPermissions)) {
    copy.resolvedPermissions = copy.resolvedPermissions.slice();
  }
  return copy;
}

/**
 * Cache a freshly-resolved member for (lawFirmId, userId). `member` MUST carry
 * the canonical `resolvedPermissions` array (and `isOwner`) produced by the
 * resolution logic. This module never derives permissions itself.
 */
export function set(lawFirmId: string, userId: string, member: any) {
  if (!lawFirmId || !userId || !member) return;
  const snapshot = { ...member };
  if (Array.isArray(snapshot.resolvedPermissions)) {
    snapshot.resolvedPermissions = snapshot.resolvedPermissions.slice();
  }
  store.set(keyFor(lawFirmId, userId), snapshot);
}

/** Invalidate a single (lawFirmId, userId) entry -- e.g. member role changed/removed. */
export function invalidate(lawFirmId: string, userId: string) {
  if (!lawFirmId || !userId) return;
  store.delete(keyFor(lawFirmId, userId));
}

/**
 * Invalidate every cached entry for a firm. Used when a role's permission
 * array is edited (we don't track which members hold which role in the cache),
 * so the simplest correct action is to drop the whole firm's entries.
 */
export function invalidateFirm(lawFirmId: string) {
  if (!lawFirmId) return;
  // A prefix sweep rather than a secondary index. The index that used to make
  // this cheap was a second unbounded map of every firm id ever seen, so it was
  // the same leak in another place. The ceiling caps what this walks.
  store.deletePrefix(`${lawFirmId} `);
}

/** Test/maintenance helper: drop everything. */
export function clear() {
  store.clear();
}

/** Entries currently held. For tests asserting the ceiling. */
export function size() {
  return store.size();
}

/**
 * A module-scope cache that cannot grow without bound.
 *
 * A `new Map()` at module scope lives as long as the instance does. Several
 * caches in this codebase were keyed on values that grow with the customer
 * base (firm id, user id, `${firmId}:${userId}`, calendar id) and were bounded
 * only by a TTL, or in one case by nothing at all.
 *
 * A TTL alone does not bound a cache. An expired entry is removed when that
 * exact key is looked up again, and the keys that make a cache grow are exactly
 * the ones nobody asks for twice. So this pairs the TTL with a hard entry
 * ceiling and evicts the least recently used entry when the ceiling is reached.
 *
 * Insertion order is the LRU order: `Map` preserves it, so re-inserting on a hit
 * moves an entry to the most recently used end, and the first key the iterator
 * yields is the one to evict. This is the shape `shared/middleware/auth.ts`
 * already used for its token cache, generalised so the next cache cannot get it
 * wrong.
 *
 * Not a substitute for a shared cache. Each instance keeps its own, so a value
 * cached here may be up to `ttlMs` stale after another instance changes it.
 * That is the same trade the callers already made; the ceiling does not change
 * it.
 */

export interface BoundedCacheOptions {
  /** Identifies the cache in errors. Not used for storage. */
  name: string;
  /** Hard ceiling on entries. Must be positive: an unbounded cache is the bug. */
  maxEntries: number;
  /** How long an entry may be served after it was written. Must be positive. */
  ttlMs: number;
}

export interface BoundedCache<T> {
  get(key: string): T | undefined;
  has(key: string): boolean;
  set(key: string, value: T): void;
  delete(key: string): void;
  /** Forget every key starting with `prefix`, for scoped invalidation. */
  deletePrefix(prefix: string): void;
  clear(): void;
  size(): number;
}

interface Entry<T> {
  value: T;
  writtenAt: number;
}

export function createBoundedCache<T>(options: BoundedCacheOptions): BoundedCache<T> {
  const { name, maxEntries, ttlMs } = options;
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
    throw new Error(`boundedCache(${name}): maxEntries must be a positive number`);
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`boundedCache(${name}): ttlMs must be a positive number`);
  }

  const entries = new Map<string, Entry<T>>();

  /** Read an unexpired entry, refreshing its position in the LRU order. */
  const read = (key: string): Entry<T> | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.writtenAt > ttlMs) {
      // Deleted rather than skipped: a hidden entry still occupies the ceiling
      // and would evict a live one in its place.
      entries.delete(key);
      return undefined;
    }
    // Re-insert to move this key to the most-recently-used end.
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  };

  return {
    get(key) {
      return read(key)?.value;
    },
    has(key) {
      return read(key) !== undefined;
    },
    set(key, value) {
      // Delete first so an overwrite also refreshes the LRU position, and so a
      // repeated write of one key cannot count towards the ceiling twice.
      entries.delete(key);
      entries.set(key, { value, writtenAt: Date.now() });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    delete(key) {
      entries.delete(key);
    },
    deletePrefix(prefix) {
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) entries.delete(key);
      }
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

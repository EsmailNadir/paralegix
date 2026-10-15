/**
 * The one cache shape every module-scope cache uses.
 *
 * A `new Map()` at module scope lives for the life of the instance. Several of
 * them were keyed on things that grow with the customer base: firm id, user id,
 * `${firmId}:${userId}`, calendar id. A TTL alone does not bound them, because
 * an expired entry is only removed when that exact key is asked for again, and
 * the key that grows is the key nobody asks for twice. One of them had no TTL
 * at all and grew for the life of the process.
 *
 * So the contract has two halves and both are asserted here: entries expire by
 * time, AND the map has a hard entry ceiling that evicts the least recently
 * used. The token cache in `shared/middleware/auth.ts` already worked this way;
 * this generalises it so the next cache cannot get it wrong.
 */
import { createBoundedCache } from '../../src/shared/utils/boundedCache';

describe('reading and writing', () => {
  it('returns what was stored', () => {
    const cache = createBoundedCache<string>({ name: 't', maxEntries: 10, ttlMs: 1000 });

    cache.set('a', 'value-a');

    expect(cache.get('a')).toBe('value-a');
  });

  it('returns undefined for a key it never held', () => {
    const cache = createBoundedCache<string>({ name: 't', maxEntries: 10, ttlMs: 1000 });

    expect(cache.get('missing')).toBeUndefined();
  });

  it('stores a falsy value without confusing it for a miss', () => {
    // `canViewSignatureSession` caches a boolean, and `false` is the answer that
    // matters most. A cache that treated it as absent would re-run the
    // permission lookup on every denied request.
    const cache = createBoundedCache<boolean>({ name: 't', maxEntries: 10, ttlMs: 1000 });

    cache.set('denied', false);

    expect(cache.get('denied')).toBe(false);
    expect(cache.has('denied')).toBe(true);
  });
});

describe('expiring by time', () => {
  it('drops an entry once its ttl has passed', () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const cache = createBoundedCache<string>({ name: 't', maxEntries: 10, ttlMs: 1000 });
      cache.set('a', 'value-a');

      jest.setSystemTime(1_700_000_000_000 + 1001);

      expect(cache.get('a')).toBeUndefined();
      // Removed, not merely hidden: a hidden entry still occupies the ceiling.
      expect(cache.size()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps an entry that is still inside its ttl', () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const cache = createBoundedCache<string>({ name: 't', maxEntries: 10, ttlMs: 1000 });
      cache.set('a', 'value-a');

      jest.setSystemTime(1_700_000_000_000 + 999);

      expect(cache.get('a')).toBe('value-a');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the entry ceiling', () => {
  it('never exceeds maxEntries however many distinct keys arrive', () => {
    const cache = createBoundedCache<number>({ name: 't', maxEntries: 3, ttlMs: 60_000 });

    // Ten thousand distinct firms is the shape of the real risk: a TTL alone
    // would hold every one of them until each was asked for a second time.
    for (let i = 0; i < 10_000; i += 1) cache.set(`firm-${i}`, i);

    expect(cache.size()).toBe(3);
  });

  it('evicts the LEAST RECENTLY USED entry, not the oldest write', () => {
    const cache = createBoundedCache<string>({ name: 't', maxEntries: 2, ttlMs: 60_000 });
    cache.set('a', 'A');
    cache.set('b', 'B');

    // Touching `a` makes `b` the least recently used, so the next write evicts
    // `b`. Evicting by insertion order instead would throw away the entry that
    // is actually being used, which is the opposite of a cache.
    cache.get('a');
    cache.set('c', 'C');

    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
    expect(cache.get('b')).toBeUndefined();
  });

  it('does not grow when the same key is written repeatedly', () => {
    const cache = createBoundedCache<number>({ name: 't', maxEntries: 5, ttlMs: 60_000 });

    for (let i = 0; i < 100; i += 1) cache.set('same', i);

    expect(cache.size()).toBe(1);
    expect(cache.get('same')).toBe(99);
  });
});

describe('invalidation', () => {
  it('forgets one key', () => {
    const cache = createBoundedCache<string>({ name: 't', maxEntries: 10, ttlMs: 60_000 });
    cache.set('a', 'A');
    cache.set('b', 'B');

    cache.delete('a');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('B');
  });

  it('forgets every key matching a prefix', () => {
    // Firm-scoped invalidation: a permission change must clear that firm's
    // entries without discarding every other firm's.
    const cache = createBoundedCache<string>({ name: 't', maxEntries: 100, ttlMs: 60_000 });
    cache.set('firm-1:user-a', 'A');
    cache.set('firm-1:user-b', 'B');
    cache.set('firm-2:user-c', 'C');

    cache.deletePrefix('firm-1:');

    expect(cache.get('firm-1:user-a')).toBeUndefined();
    expect(cache.get('firm-1:user-b')).toBeUndefined();
    expect(cache.get('firm-2:user-c')).toBe('C');
  });

  it('clears everything', () => {
    const cache = createBoundedCache<string>({ name: 't', maxEntries: 10, ttlMs: 60_000 });
    cache.set('a', 'A');

    cache.clear();

    expect(cache.size()).toBe(0);
  });
});

describe('configuration', () => {
  it('refuses a cache with no ceiling', () => {
    // The whole point. An unbounded cache must not be constructible, or the
    // next one added quietly reintroduces the problem this file exists for.
    expect(() => createBoundedCache<string>({ name: 't', maxEntries: 0, ttlMs: 1000 }))
      .toThrow(/maxEntries/);
  });

  it('refuses a cache with no ttl', () => {
    expect(() => createBoundedCache<string>({ name: 't', maxEntries: 10, ttlMs: 0 }))
      .toThrow(/ttlMs/);
  });
});

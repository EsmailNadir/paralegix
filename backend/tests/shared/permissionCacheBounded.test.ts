/**
 * The permission cache holds an authorization answer per (firm, user).
 *
 * Its key grows with the customer base twice over: a firm times its members.
 * A TTL alone does not bound that. An expired entry leaves the map only when
 * that exact key is read again, and the keys that make this cache grow are the
 * ones nobody reads twice: a one-off portal visit, a member who signs in once,
 * a burst from a firm that then goes quiet. On a long-lived instance the map
 * keeps every one of them.
 *
 * A second map made it worse. `firmIndex` existed to make `invalidateFirm`
 * cheap, and it was never bounded either, so the fix had to remove it rather
 * than cap it.
 *
 * The behaviour that must survive the bound is asserted first, because this
 * cache decides who may do what:
 *
 *   A miss returns undefined, never an empty or full permission set. The
 *   caller resolves from the database. Failing open here is a data leak.
 *
 *   An entry is per (firm, user). One user must never read another's, and one
 *   firm's answer must never be served for another firm.
 *
 *   A returned member is a COPY. A caller that mutates `req.member` must not
 *   change what the next request reads.
 */
import * as permissionCache from '../../src/modules/lawfirms/roles/permissionCache';

const member = (perms: string[]) => ({ isOwner: false, resolvedPermissions: perms });

beforeEach(() => permissionCache.clear());

describe('the authorization answer it stores', () => {
  it('returns undefined on a miss rather than any permission set', () => {
    // Never fail open. An empty array would deny a legitimate member, and a
    // full one would grant a stranger; both are worse than resolving fresh.
    expect(permissionCache.get('firm-1', 'user-1')).toBeUndefined();
  });

  it('does not serve one user the answer cached for another', () => {
    permissionCache.set('firm-1', 'user-1', member(['billing.viewInvoices']));

    expect(permissionCache.get('firm-1', 'user-2')).toBeUndefined();
  });

  it('does not serve one firm the answer cached for another', () => {
    permissionCache.set('firm-1', 'user-1', member(['billing.viewInvoices']));

    expect(permissionCache.get('firm-2', 'user-1')).toBeUndefined();
  });

  it('hands back a copy, so a caller mutating req.member cannot widen it', () => {
    permissionCache.set('firm-1', 'user-1', member(['matters.view']));

    const first: any = permissionCache.get('firm-1', 'user-1');
    first.resolvedPermissions.push('billing.deleteInvoices');
    first.isOwner = true;

    const second: any = permissionCache.get('firm-1', 'user-1');
    expect(second.resolvedPermissions).toEqual(['matters.view']);
    expect(second.isOwner).toBe(false);
  });

  it('expires an entry after the ttl', () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      permissionCache.set('firm-1', 'user-1', member(['matters.view']));

      jest.setSystemTime(1_700_000_000_000 + permissionCache.TTL_MS + 1);

      expect(permissionCache.get('firm-1', 'user-1')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('invalidation', () => {
  it('drops one member without touching their colleagues', () => {
    permissionCache.set('firm-1', 'user-1', member(['matters.view']));
    permissionCache.set('firm-1', 'user-2', member(['matters.view']));

    permissionCache.invalidate('firm-1', 'user-1');

    expect(permissionCache.get('firm-1', 'user-1')).toBeUndefined();
    expect(permissionCache.get('firm-1', 'user-2')).toBeDefined();
  });

  it('drops a whole firm without touching another firm', () => {
    // A role's permission array changed, and the cache does not track which
    // members hold that role, so every entry for the firm has to go.
    permissionCache.set('firm-1', 'user-1', member(['matters.view']));
    permissionCache.set('firm-1', 'user-2', member(['matters.view']));
    permissionCache.set('firm-2', 'user-3', member(['matters.view']));

    permissionCache.invalidateFirm('firm-1');

    expect(permissionCache.get('firm-1', 'user-1')).toBeUndefined();
    expect(permissionCache.get('firm-1', 'user-2')).toBeUndefined();
    expect(permissionCache.get('firm-2', 'user-3')).toBeDefined();
  });

  it('does not let one firm id invalidate another whose id starts the same', () => {
    // Firm-scoped invalidation matches on a key prefix, so the separator has to
    // make `firm-1` and `firm-10` distinct. Without it, editing a role in one
    // firm silently flushes the other, which costs latency rather than
    // correctness, but the reverse mistake would not.
    permissionCache.set('firm-1', 'user-1', member(['matters.view']));
    permissionCache.set('firm-10', 'user-1', member(['matters.view']));

    permissionCache.invalidateFirm('firm-1');

    expect(permissionCache.get('firm-1', 'user-1')).toBeUndefined();
    expect(permissionCache.get('firm-10', 'user-1')).toBeDefined();
  });
});

describe('the entry ceiling', () => {
  it('has a real ceiling, not an unset one', () => {
    // Asserted on its own because every other case here compares against
    // MAX_ENTRIES. If the ceiling were Infinity those cases would all pass
    // against an unbounded map.
    expect(Number.isFinite(permissionCache.MAX_ENTRIES)).toBe(true);
    expect(permissionCache.MAX_ENTRIES).toBeGreaterThan(0);
  });

  it('does not keep a second unbounded index alongside the store', () => {
    // `firmIndex` was a Map of every firm id ever seen, holding a Set of keys.
    // It was the same leak in a second place, and capping only the store would
    // have left it. Which entry the ceiling evicts is `createBoundedCache`'s
    // job and is pinned in boundedCache.test.ts.
    for (let i = 0; i < permissionCache.MAX_ENTRIES + 500; i += 1) {
      permissionCache.set(`firm-${i}`, 'user-1', member(['matters.view']));
    }

    expect(permissionCache.size()).toBe(permissionCache.MAX_ENTRIES);
    expect((permissionCache as any).firmIndex).toBeUndefined();
  });
});

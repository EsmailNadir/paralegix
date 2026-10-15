/**
 * The cross-tab lock and last-sync stamp that stop every open matters, tasks
 * and calendar page from firing its own Google or Outlook sync.
 *
 * Getting the lock wrong either way is visible: too permissive and two tabs
 * sync at once (duplicate events, provider rate limits); too strict and a lock
 * left by a closed tab blocks syncing until someone clears storage. So the
 * expiry boundary, the re-entrant owner, and the "only the owner releases"
 * rule are each pinned, as is the scoping by provider and firm.
 */
import {
  CALENDAR_SYNC_LOCK_TTL_MS,
  claimSyncLock,
  getSharedLastSyncAt,
  releaseSyncLock,
  setSharedLastSyncAt,
} from '@/utils/calendarSyncLock';

const LOCK_KEY = 'paralegix:google:calendar-sync:firm-1:lock';
const LAST_KEY = 'paralegix:google:calendar-sync:firm-1:last';

let now: number;

beforeEach(() => {
  window.localStorage.clear();
  now = 1_700_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const storedLock = () => JSON.parse(window.localStorage.getItem(LOCK_KEY) || 'null');

describe('last sync timestamp', () => {
  it('is null before any sync has been recorded', () => {
    expect(getSharedLastSyncAt('google', 'firm-1')).toBeNull();
  });

  it('round-trips under a key scoped to provider and firm', () => {
    setSharedLastSyncAt('google', 'firm-1', 1234);

    expect(window.localStorage.getItem(LAST_KEY)).toBe('1234');
    expect(getSharedLastSyncAt('google', 'firm-1')).toBe(1234);
    expect(getSharedLastSyncAt('outlook', 'firm-1')).toBeNull();
    expect(getSharedLastSyncAt('google', 'firm-2')).toBeNull();
  });

  it('reads a non-numeric stored value as null rather than NaN', () => {
    window.localStorage.setItem(LAST_KEY, 'garbage');
    expect(getSharedLastSyncAt('google', 'firm-1')).toBeNull();
  });

  it('reads null and swallows the write when storage throws (private mode)', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(getSharedLastSyncAt('google', 'firm-1')).toBeNull();
    expect(() => setSharedLastSyncAt('google', 'firm-1', 1)).not.toThrow();
  });
});

describe('claimSyncLock', () => {
  it('claims a free lock and records the owner with a five-minute expiry', () => {
    expect(claimSyncLock('google', 'firm-1', 'tab-a')).toBe(true);
    expect(storedLock()).toEqual({ ownerId: 'tab-a', expiresAt: now + CALENDAR_SYNC_LOCK_TTL_MS });
    expect(CALENDAR_SYNC_LOCK_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('refuses a lock another tab holds until it expires', () => {
    claimSyncLock('google', 'firm-1', 'tab-a');
    now += CALENDAR_SYNC_LOCK_TTL_MS - 1;

    expect(claimSyncLock('google', 'firm-1', 'tab-b')).toBe(false);
    expect(storedLock().ownerId).toBe('tab-a');
  });

  it('lets another tab take the lock at the moment it expires', () => {
    claimSyncLock('google', 'firm-1', 'tab-a');
    now += CALENDAR_SYNC_LOCK_TTL_MS;

    expect(claimSyncLock('google', 'firm-1', 'tab-b')).toBe(true);
    expect(storedLock()).toEqual({ ownerId: 'tab-b', expiresAt: now + CALENDAR_SYNC_LOCK_TTL_MS });
  });

  it('lets the holder re-claim and pushes the expiry out', () => {
    claimSyncLock('google', 'firm-1', 'tab-a');
    now += 60_000;

    expect(claimSyncLock('google', 'firm-1', 'tab-a')).toBe(true);
    expect(storedLock().expiresAt).toBe(now + CALENDAR_SYNC_LOCK_TTL_MS);
  });

  it('scopes the lock by provider and by firm', () => {
    claimSyncLock('google', 'firm-1', 'tab-a');

    expect(claimSyncLock('outlook', 'firm-1', 'tab-b')).toBe(true);
    expect(claimSyncLock('google', 'firm-2', 'tab-b')).toBe(true);
  });

  it('treats a corrupt lock entry as free instead of blocking sync forever', () => {
    window.localStorage.setItem(LOCK_KEY, '{not json');
    expect(claimSyncLock('google', 'firm-1', 'tab-a')).toBe(true);
  });
});

describe('releaseSyncLock', () => {
  it('releases a lock its owner holds', () => {
    claimSyncLock('google', 'firm-1', 'tab-a');
    releaseSyncLock('google', 'firm-1', 'tab-a');

    expect(window.localStorage.getItem(LOCK_KEY)).toBeNull();
    expect(claimSyncLock('google', 'firm-1', 'tab-b')).toBe(true);
  });

  it('leaves a lock held by another tab alone', () => {
    claimSyncLock('google', 'firm-1', 'tab-a');
    releaseSyncLock('google', 'firm-1', 'tab-b');

    expect(storedLock().ownerId).toBe('tab-a');
  });

  it('clears a corrupt lock entry', () => {
    window.localStorage.setItem(LOCK_KEY, '{not json');
    releaseSyncLock('google', 'firm-1', 'tab-a');

    expect(window.localStorage.getItem(LOCK_KEY)).toBeNull();
  });
});

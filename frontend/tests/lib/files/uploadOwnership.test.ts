/**
 * Which tab is allowed to drive a remembered upload session.
 *
 * The descriptor lives in `localStorage`, which every tab on the origin shares.
 * Two tabs with the same document picked read the same descriptor, ask GCS the
 * same "where did you get to", and then both PUT from that offset into ONE
 * session. The bytes interleave, the object is corrupt, and neither tab is told
 * anything: both see 308s with an advancing Range, because the range IS
 * advancing, just not only because of them.
 *
 * The Web Locks API answers exactly this question, so it is what decides. Where
 * it does not exist there is no way to ask, and the safe answer is not to share
 * the session at all: the caller opens an independent one, pays for a second
 * upload, and stores a correct object.
 */
import { claimUploadSession, uploadLockName } from '@/lib/files/uploadOwnership';

type LockCallback = (lock: unknown) => Promise<void> | void;

/**
 * A LockManager honest enough to fail against.
 *
 * It queues waiters like the real one, so a `request` made WITHOUT
 * `ifAvailable` never settles while another holder is in place, and a spec that
 * forgot that would hang rather than pass.
 */
function installFakeLocks() {
  const held = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();
  const requests: Array<{ name: string; options: Record<string, unknown> }> = [];

  const grant = (name: string, callback: LockCallback) => {
    held.add(name);
    return Promise.resolve(callback({ name })).finally(() => {
      held.delete(name);
      const next = (waiting.get(name) || []).shift();
      if (next) next();
    });
  };

  const locks = {
    request(name: string, options: Record<string, unknown>, callback: LockCallback) {
      requests.push({ name, options });
      if (!held.has(name)) return grant(name, callback);
      if (options && options.ifAvailable) return Promise.resolve(callback(null));
      return new Promise<void>((resolve) => {
        const queue = waiting.get(name) || [];
        queue.push(() => { resolve(grant(name, callback) as unknown as void); });
        waiting.set(name, queue);
      });
    },
  };

  const original = Object.getOwnPropertyDescriptor(window.navigator, 'locks');
  Object.defineProperty(window.navigator, 'locks', { configurable: true, value: locks });
  return {
    requests,
    isHeld: (name: string) => held.has(name),
    restore() {
      if (original) Object.defineProperty(window.navigator, 'locks', original);
      else delete (window.navigator as unknown as Record<string, unknown>).locks;
    },
  };
}

const KEY = 'plx:upload-session:["firm-1","user-1","matter"]';

describe('with the Web Locks API', () => {
  let locks: ReturnType<typeof installFakeLocks>;

  beforeEach(() => { locks = installFakeLocks(); });
  afterEach(() => { locks.restore(); });

  it('grants the session to the first tab and refuses the second', async () => {
    const first = await claimUploadSession(KEY);
    const second = await claimUploadSession(KEY);

    // Two tabs, one session. The loser must NOT resume: its caller opens an
    // independent session instead, which costs an upload and saves the object.
    expect(first.owned).toBe(true);
    expect(second.owned).toBe(false);

    first.release();
  });

  it('answers the second tab immediately instead of queueing behind the first', async () => {
    const first = await claimUploadSession(KEY);

    // The real LockManager blocks a plain request until the holder lets go, and
    // the holder here is a multi-gigabyte upload. Without `ifAvailable` the
    // second tab would sit on a spinner for an hour rather than being told to
    // open its own session. The fake above queues, so dropping the flag makes
    // this spec hang rather than quietly pass.
    await claimUploadSession(KEY);

    expect(locks.requests.map((r) => r.options.ifAvailable)).toEqual([true, true]);
    first.release();
  });

  it('hands the session on once the owner releases it', async () => {
    const first = await claimUploadSession(KEY);
    first.release();
    // The release resolves the held promise, which the LockManager only acts on
    // in a later turn.
    await Promise.resolve();
    await Promise.resolve();

    const second = await claimUploadSession(KEY);

    // A tab that finishes or is closed must not strand the session forever: the
    // descriptor outlives the tab and the next one has to be able to take it.
    expect(second.owned).toBe(true);
    second.release();
  });

  it('releases only once, however many times it is called', async () => {
    const first = await claimUploadSession(KEY);

    first.release();
    first.release();
    await Promise.resolve();
    await Promise.resolve();

    // A double release from an error path plus a finally must not free a lock
    // some LATER upload has since taken.
    const second = await claimUploadSession(KEY);
    expect(second.owned).toBe(true);
    second.release();
  });

  it('locks each upload separately, so two files do not block each other', async () => {
    const a = await claimUploadSession(`${KEY}-a`);
    const b = await claimUploadSession(`${KEY}-b`);

    // A single global upload lock would serialise every file in a batch behind
    // the first, which is the concurrency the batch exists for.
    expect(a.owned).toBe(true);
    expect(b.owned).toBe(true);
    expect(locks.requests.map((r) => r.name)).toEqual([
      uploadLockName(`${KEY}-a`), uploadLockName(`${KEY}-b`),
    ]);
    a.release();
    b.release();
  });

  it('refuses ownership when the lock manager itself throws', async () => {
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: { request() { throw new Error('locks unavailable'); } },
    });

    const claim = await claimUploadSession(KEY);

    // Unable to ask means unable to prove, and an unproven claim of exclusive
    // ownership is exactly what corrupts the object.
    expect(claim.owned).toBe(false);
    expect(() => claim.release()).not.toThrow();
  });
});

describe('without the Web Locks API', () => {
  it('refuses ownership rather than assuming this tab is alone', async () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, 'locks');
    delete (window.navigator as unknown as Record<string, unknown>).locks;
    try {
      const claim = await claimUploadSession(KEY);

      // Assuming exclusivity here would corrupt an object every time a user has
      // the app open twice, which is normal. The cost of refusing is a second
      // upload; the cost of assuming is a document with another document's
      // bytes in the middle of it.
      expect(claim.owned).toBe(false);
      expect(() => claim.release()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window.navigator, 'locks', original);
    }
  });
});

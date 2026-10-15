/**
 * The drain that keeps a fire-and-forget write out of the next spec's truncate.
 *
 * This helper exists because three writers in this codebase deliberately do not
 * await their own insert: the audit log, the signature audit trail and the
 * timezone capture. In production that is correct. Under test it means a write
 * can still be in flight when the next spec truncates all the schema, and the
 * two deadlock on Postgres 40P01. Whichever side Postgres kills, the symptom
 * lands on an innocent spec and moves as the suite grows.
 *
 * So the property under test is narrow and mechanical: after `drain` resolves,
 * nothing registered before it is still outstanding. Each case names the way
 * that could fail.
 */
import {
  trackBackgroundWrite,
  drainBackgroundWrites,
  pendingBackgroundWrites,
} from '../../src/shared/utils/backgroundWrites';

/** A promise that settles when told, so a test can hold one open on purpose. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  // The registry is module state shared with every other spec in this worker.
  // Starting from empty is what keeps these counts meaningful.
  await drainBackgroundWrites();
});

describe('a tracked write is outstanding until it settles', () => {
  it('counts a write that has not settled', () => {
    const d = deferred();

    trackBackgroundWrite(d.promise);

    // Without this, `drain` has nothing to wait on and the whole helper is a
    // no-op that always looks correct.
    expect(pendingBackgroundWrites()).toBe(1);
    d.resolve();
  });

  it('stops counting it once it resolves', async () => {
    const d = deferred();
    trackBackgroundWrite(d.promise);

    d.resolve();
    await drainBackgroundWrites();

    // A registry that never forgets grows without bound in a long run, and
    // every later drain waits on every write the process ever made.
    expect(pendingBackgroundWrites()).toBe(0);
  });

  it('stops counting it once it REJECTS', async () => {
    const d = deferred();
    trackBackgroundWrite(d.promise).catch(() => {});

    d.reject(new Error('insert failed'));
    await drainBackgroundWrites();

    // The failing case is the one that matters: these writes are fire and
    // forget precisely because they are allowed to fail, so a registry that
    // only forgets on success leaks exactly the writes that went wrong.
    expect(pendingBackgroundWrites()).toBe(0);
  });
});

describe('drain waits for what is outstanding', () => {
  it('does not resolve before a pending write does', async () => {
    const d = deferred();
    trackBackgroundWrite(d.promise);
    let drained = false;

    const draining = drainBackgroundWrites().then(() => { drained = true; });
    // Give the drain every chance to resolve early if it is going to.
    await new Promise((r) => setImmediate(r));

    expect(drained).toBe(false);

    d.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it('resolves immediately when nothing is outstanding', async () => {
    // The ordinary case: most specs make no such write, and the drain must not
    // cost them anything.
    await drainBackgroundWrites();

    expect(pendingBackgroundWrites()).toBe(0);
  });

  it('waits for a write REGISTERED BY another write settling', async () => {
    const first = deferred();
    const second = deferred();
    trackBackgroundWrite(first.promise.then(() => {
      // A settling write starting another is the reason drain loops rather
      // than awaiting the set once. Awaiting once would return with `second`
      // still in flight, which is the exact race this helper exists to close.
      trackBackgroundWrite(second.promise);
    }));

    first.resolve();
    const draining = drainBackgroundWrites();
    second.resolve();
    await draining;

    expect(pendingBackgroundWrites()).toBe(0);
  });

  it('survives a rejected write without rejecting itself', async () => {
    const d = deferred();
    trackBackgroundWrite(d.promise).catch(() => {});
    d.reject(new Error('insert failed'));

    // `drain` runs in the harness's beforeEach. If a failed background write
    // could reject it, one unlucky insert would fail every remaining spec in
    // the file with an error naming none of them.
    await expect(drainBackgroundWrites()).resolves.toBeUndefined();
  });
});

describe('tracking does not change what the caller sees', () => {
  it('returns the same promise it was given', () => {
    const d = deferred<number>();

    const returned = trackBackgroundWrite(d.promise);

    // The callers that DO await this must keep working. Returning a wrapper,
    // or a new promise, would silently change their timing.
    expect(returned).toBe(d.promise);
    d.resolve(1);
  });

  it('still delivers the resolved value to a caller that awaits', async () => {
    const d = deferred<string>();
    const returned = trackBackgroundWrite(d.promise);

    d.resolve('row-id');

    // `writeAuditEvent` returns the inserted id, and one caller reads it.
    expect(await returned).toBe('row-id');
  });

  it('does not swallow a rejection on behalf of the caller', async () => {
    const d = deferred();
    const returned = trackBackgroundWrite(d.promise);
    d.reject(new Error('insert failed'));

    // The internal handler exists only to keep the registry from leaking. If it
    // also marked the rejection handled for the caller, a real failure would
    // vanish instead of reaching whatever the caller attached.
    await expect(returned).rejects.toThrow('insert failed');
  });
});

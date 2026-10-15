/**
 * A Web Locks API for jsdom, which has none.
 *
 * Uploads use `navigator.locks` to decide which tab owns a remembered upload
 * session. Where the API is missing they deliberately refuse to share a session
 * at all and open an independent one, because there is then no way to prove
 * this tab is alone and an unproven claim of exclusivity corrupts the stored
 * object. jsdom therefore looks to the code exactly like a browser too old to
 * resume anything, and every resumption spec would silently exercise the
 * fallback instead of the path it names.
 *
 * `installWebLocks()` models ONE tab in a browser that has the API.
 * `holdElsewhere()` models a SECOND tab already holding the session.
 * `removeWebLocks()` models the browser that has no API at all.
 */

export interface WebLocksMock {
  /**
   * Make every `ifAvailable` claim fail, as another tab holding the lock does.
   *
   * Deliberately not per name: a spec would otherwise have to rebuild the
   * session key the service computes, and would then pass whenever that key
   * changed rather than when the ownership rule broke.
   */
  holdElsewhere(): void;
  /** Every lock request the code under test made, in order. */
  requests(): Array<{ name: string; options: { ifAvailable?: boolean } }>;
  restore(): void;
}

type LockCallback = (lock: unknown) => Promise<void> | void;

export function installWebLocks(): WebLocksMock {
  const held = new Set<string>();
  const seen: Array<{ name: string; options: { ifAvailable?: boolean } }> = [];
  let allHeldElsewhere = false;

  const locks = {
    request(name: string, options: { ifAvailable?: boolean }, callback: LockCallback) {
      seen.push({ name, options });
      const taken = allHeldElsewhere || held.has(name);
      if (taken) {
        if (options?.ifAvailable) return Promise.resolve(callback(null));
        // A plain request queues behind the holder. Nothing in the app makes
        // one, and hanging here is the right way for that to be found out.
        return new Promise<void>(() => {});
      }
      held.add(name);
      return Promise.resolve(callback({ name })).finally(() => { held.delete(name); });
    },
  };

  const original = Object.getOwnPropertyDescriptor(window.navigator, 'locks');
  Object.defineProperty(window.navigator, 'locks', { configurable: true, value: locks });

  return {
    holdElsewhere() { allHeldElsewhere = true; },
    requests: () => seen,
    restore() {
      if (original) Object.defineProperty(window.navigator, 'locks', original);
      else delete (window.navigator as unknown as Record<string, unknown>).locks;
    },
  };
}

/** Take the API away, as an old browser or a locked-down one does. Returns the undo. */
export function removeWebLocks(): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'locks');
  delete (window.navigator as unknown as Record<string, unknown>).locks;
  return () => {
    if (original) Object.defineProperty(window.navigator, 'locks', original);
  };
}

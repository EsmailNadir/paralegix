/**
 * Which tab owns a remembered upload session.
 *
 * The descriptor is kept in `localStorage`, which every tab on the origin
 * shares. Two tabs with the same document picked read the same descriptor, both
 * ask GCS where the session got to, and both PUT from that offset into the ONE
 * session. The bytes interleave and the stored object is corrupt, with nothing
 * on either screen to say so: both tabs see 308s whose Range keeps advancing,
 * because it does, just not only because of them.
 *
 * The Web Locks API is the browser's answer to exactly this question, so it is
 * what decides. The lock is requested with `ifAvailable`, because the holder is
 * a multi-gigabyte upload and queueing behind it would leave the second tab on
 * a spinner for an hour rather than getting on with its own session.
 *
 * Where the API is absent, or throws, ownership is REFUSED. There is then no
 * way to prove this tab is alone, and an unproven claim of exclusivity is the
 * corruption above. The caller opens an independent session instead: one extra
 * upload, and a correct object.
 */

export interface UploadOwnership {
  /** True only when this tab is provably the sole owner of the session. */
  owned: boolean;
  /** Give the session up. Safe to call more than once, and when unowned. */
  release(): void;
}

/** Lock names live in one flat namespace per origin, so they carry a prefix. */
export function uploadLockName(sessionKey: string): string {
  return `plx:upload-owner:${sessionKey}`;
}

const UNOWNED: UploadOwnership = { owned: false, release: () => {} };

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

function lockManager(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * Claim exclusive use of one upload session for this tab.
 *
 * Resolves as soon as the browser has answered, whether or not the claim
 * succeeded. It never waits for another tab to finish.
 */
export async function claimUploadSession(sessionKey: string): Promise<UploadOwnership> {
  const locks = lockManager();
  if (!locks) return UNOWNED;

  const name = uploadLockName(sessionKey);
  let releaseHold: (() => void) | null = null;

  try {
    const granted = await new Promise<boolean>((resolveGranted) => {
      // The lock is held for as long as the callback's promise is pending, so
      // holding it means handing back a resolver and returning that promise.
      const held = new Promise<void>((resolveHeld) => { releaseHold = resolveHeld; });
      void locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolveGranted(false);
            return undefined;
          }
          resolveGranted(true);
          return held;
        })
        .catch(() => resolveGranted(false));
    });

    if (!granted) return UNOWNED;
  } catch {
    // A LockManager that refuses to be asked is the same situation as not
    // having one: nothing can be proved, so nothing is claimed.
    return UNOWNED;
  }

  let released = false;
  return {
    owned: true,
    release() {
      // Once only. An error path plus a `finally` both calling this would
      // otherwise resolve a promise belonging to a lock a LATER upload holds.
      if (released) return;
      released = true;
      releaseHold?.();
    },
  };
}

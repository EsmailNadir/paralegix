/**
 * Deadline plumbing for `apiFetch`. Mechanism only - the budgets live in
 * `@/lib/constants/requestTimeouts` and the error shape in `./apiErrors`.
 */

export interface ArmedTimeout {
  /** Pass to `fetch`. Undefined only when there is neither a deadline nor a caller signal. */
  signal: AbortSignal | undefined;
  /**
   * True when OUR deadline fired, as opposed to the caller aborting. The two are
   * indistinguishable from the `AbortError` alone, and they mean opposite things:
   * a deadline is a failure worth showing the user, a caller abort is a
   * cancellation (React Query dropping a query on unmount) that must stay silent.
   */
  didTimeOut: () => boolean;
  /** Release the timer and the caller-signal listener. Safe to call twice. */
  dispose: () => void;
}

/**
 * Arm a deadline, folded together with any signal the caller supplied.
 *
 * Built on `AbortController` rather than `AbortSignal.timeout()` +
 * `AbortSignal.any()`: those are newer than this app's (unstated) browser floor,
 * and `AbortSignal.any` erases which input aborted, which is the one thing
 * `didTimeOut` exists to tell us.
 *
 * @param timeoutMs Milliseconds to allow. Zero or negative arms nothing.
 * @param callerSignal Optional signal that should also abort the request.
 */
export function armTimeout(timeoutMs: number, callerSignal?: AbortSignal | null): ArmedTimeout {
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      signal: callerSignal ?? undefined,
      didTimeOut: () => false,
      dispose: () => {},
    };
  }

  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onCallerAbort = () => {
    clearTimeout(timer);
    controller.abort();
  };

  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Bound a promise that cannot be aborted.
 *
 * `AbortSignal` only reaches code that accepts one. The Firebase SDK's token
 * refresh does not, and `apiFetch` awaits it in the middle of the 401 retry - so
 * without this, a stalled refresh is an unbounded wait inside an otherwise
 * bounded request.
 *
 * The underlying promise keeps running; there is no way to stop it. What this
 * buys is that the caller stops waiting.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeError: () => Error,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

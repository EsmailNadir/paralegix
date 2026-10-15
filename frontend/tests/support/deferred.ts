/**
 * A promise a spec settles by hand, for holding a response back while it
 * asserts what the caller shows in the meantime.
 */
import { waitFor } from '@testing-library/react';

export interface Deferred<T = unknown> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface HeldResponse<T = unknown> {
  /** An `apiMock` handler that records the request and answers once released. */
  handler: () => Promise<T>;
  /** Whether the held request has actually gone out. */
  readonly requested: boolean;
  /** Resolves once the held request has gone out. */
  untilRequested(): Promise<void>;
  /** Answer the held request with this body (or `{ status, body }` envelope). */
  release(value: T): void;
  /** Fail the held request at the transport. */
  fail(reason: unknown): void;
}

/**
 * An `apiMock` response held back until the spec releases it.
 *
 *   const firmB = holdResponse();
 *   api.getExact(URL_B, firmB.handler);
 *   ...
 *   await firmB.untilRequested();
 *   expect(rows()).not.toContain('firm-a-row');
 *   await act(async () => firmB.release({ rows: [...] }));
 *
 * `untilRequested()` is the step that matters: an assertion made before the
 * request went out proves nothing about what the caller shows while it waits.
 */
export function holdResponse<T = unknown>(): HeldResponse<T> {
  const pending = deferred<T>();
  let requested = false;
  return {
    handler: () => {
      requested = true;
      return pending.promise;
    },
    get requested() {
      return requested;
    },
    untilRequested: () => waitFor(() => expect(requested).toBe(true)),
    release: (value: T) => pending.resolve(value),
    fail: (reason: unknown) => pending.reject(reason),
  };
}

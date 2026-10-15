/**
 * How many uploads the tab runs at once.
 *
 * A batch used to hand every picked file to `Promise.all`, which starts all of
 * them at once. Twenty files means twenty sockets sharing one uplink, so every
 * chunk takes twenty times as long, is twenty times more likely to time out
 * mid-flight, and each timeout costs a status query and a resend of everything
 * that chunk had not persisted. The upload gets slower and less reliable the
 * more the user asks of it.
 *
 * The gate is app-wide, not per call. A document sent for signature and a batch
 * dropped on the files page contend for the same uplink, so counting them
 * separately would let four run and defeat the point.
 */

import { UploadCancelledError } from './resumableUpload';

/**
 * Two. Enough that one stalled connection does not idle the link while it times
 * out, few enough that each upload gets a usable share of it.
 */
export const MAX_ACTIVE_UPLOADS = 2;

let active = 0;
const waiting: Array<() => void> = [];

/**
 * Wait for a slot, or until `signal` aborts.
 *
 * A cancelled waiter leaves the queue. Left in it, the slot it was handed
 * later would go to an upload nobody wants, and the cancel itself would not be
 * heard until two other uploads, possibly gigabytes each, had finished.
 */
function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new UploadCancelledError());
  if (active < MAX_ACTIVE_UPLOADS) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const at = waiting.indexOf(grant);
      if (at >= 0) waiting.splice(at, 1);
      reject(new UploadCancelledError());
    };
    const grant = () => {
      signal?.removeEventListener('abort', onAbort);
      active += 1;
      resolve();
    };
    waiting.push(grant);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function release(): void {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

/**
 * Run one upload, waiting for a free slot first.
 *
 * The slot is released in a `finally`, so a file that fails, is cancelled, or
 * throws before it ever awaits does not hold one. Without that, two failures
 * would leave the tab unable to start another upload at all, with nothing on
 * screen to explain it.
 *
 * `signal` rejects the wait with `UploadCancelledError` without taking a slot.
 * Once the task has started, stopping it is the task's own job.
 */
export async function runWithUploadLimit<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await acquire(signal);
  try {
    return await task();
  } finally {
    release();
  }
}

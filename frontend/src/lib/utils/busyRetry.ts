import { isApiError } from '@/lib/utils/apiErrors';

/** Attempts after the first. */
const MAX_BUSY_RETRIES = 3;

/** First backoff window when the server named no wait; doubles per retry. */
const BUSY_BACKOFF_BASE_MS = 1000;

/**
 * The longest `Retry-After` worth sitting through. Asked to wait longer, the
 * request gives up and the person sees the busy message instead of a spinner
 * that has stopped meaning anything.
 */
const MAX_RETRY_AFTER_SECONDS = 30;

/**
 * Whether a failure is a document queue that was full.
 *
 * Only these are retried. The server refused the work before starting it, so
 * repeating the request cannot do it twice. A 429 `TEMPLATE_RENDER_IN_PROGRESS`
 * is this person's own render still running, and a 504 or a lost connection
 * says nothing about whether the work happened, so neither qualifies.
 */
export function isServerBusyError(error: unknown): boolean {
  return isApiError(error) && error.isServerBusy;
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** Sleep for `ms`, ending early with an AbortError when `signal` fires. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run a document request, and run it again while the server answers that its
 * queue is full: up to three retries, each after the server's `Retry-After`
 * when it sent one, or a jittered, doubling backoff when it did not. The jitter
 * keeps a burst of refused callers from returning in the same instant and
 * filling the queue again.
 *
 * @param run The request. Called again from scratch, so it must be repeatable.
 * @param options.signal Cancels a pending wait; the request is not sent again.
 */
export async function retryWhileBusy<T>(
  run: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= MAX_BUSY_RETRIES || !isApiError(error) || !error.isServerBusy) throw error;
      const retryAfter = error.retryAfterSeconds;
      if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_SECONDS) throw error;
      const delayMs = retryAfter !== undefined
        ? retryAfter * 1000
        : BUSY_BACKOFF_BASE_MS * 2 ** attempt * (0.5 + Math.random() * 0.5);
      await wait(delayMs, options.signal);
    }
  }
}

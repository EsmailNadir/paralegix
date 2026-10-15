/**
 * Retry helper for transient network/socket failures.
 *
 * Cloud Run instances throttle CPU between requests, which lets the keep-alive
 * sockets the Google auth/GCS clients hold open to googleapis.com get reaped.
 * The next call reuses a dead socket and fails mid-response with
 * `ERR_STREAM_PREMATURE_CLOSE` (and friends). These errors succeed on a fresh
 * connection, so a short retry — which forces the dead socket to be discarded —
 * clears them without any infra change.
 */

// Error codes that indicate a dropped/dead connection rather than a real failure.
const TRANSIENT_ERROR_CODES = new Set([
  'ERR_STREAM_PREMATURE_CLOSE',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNABORTED',
]);

// Message fragments for the same class of failure when no code is set.
const TRANSIENT_ERROR_PATTERNS = [
  /premature close/i,
  /socket hang up/i,
  /network socket disconnected/i,
  /invalid response body/i,
  /econnreset/i,
  /etimedout/i,
];

/**
 * The shape this helper reads off a thrown value. Every field is optional
 * because the input is whatever a third-party client threw, not a known class.
 */
interface MaybeTransientError {
  code?: string;
  errno?: string;
  message?: string;
  error?: MaybeTransientError;
  cause?: MaybeTransientError;
  response?: { data?: MaybeTransientError };
}

export function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const e = err as MaybeTransientError;
  // google-auth/gaxios nest the underlying network error a level or two deep.
  const candidates = [e, e.error, e.cause, e.response?.data];
  for (const c of candidates) {
    if (!c) continue;
    const code = c.code || c.errno;
    if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
  }
  const msg = `${e.message || ''} ${e.error?.message || ''} ${e.cause?.message || ''}`;
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(msg));
}

export interface RetryOptions {
  /** Extra attempts after the first. */
  retries?: number;
  /** Linear backoff per attempt, in milliseconds. */
  baseDelayMs?: number;
  /** Label for logs. */
  label?: string;
}

/**
 * Run `fn` and retry it on transient connection errors.
 *
 * Generic over the operation's result so a caller keeps its own return type
 * rather than widening to `any` at the retry boundary.
 */
export async function retryOnTransient<T>(
  fn: () => Promise<T>,
  { retries = 2, baseDelayMs = 150, label = 'gcs' }: RetryOptions = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isTransientError(err)) throw err;
      const delay = baseDelayMs * attempt;
      const e = err as MaybeTransientError;
      console.warn(
        `retryOnTransient: ${label} hit transient error (${e.code || e.message}); `
        + `retrying ${attempt}/${retries} after ${delay}ms`,
      );
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

import { isApiError, NETWORK_UNREACHABLE_CODE, REQUEST_TIMEOUT_CODE } from '@/lib/utils/apiErrors';

/**
 * Attempts after the first. One, matching `retryPolicy`'s long-standing default.
 */
const MAX_COLD_START_RETRIES = 1;

/**
 * How long to wait before the retry.
 *
 * Short on purpose. A first attempt that failed this way has already spent its
 * whole budget waiting, so by the time we get here the container is usually up;
 * the pause only covers the case where the failure was immediate (connection
 * refused while the instance was still starting).
 */
const COLD_START_RETRY_DELAY_MS = 1000;

/**
 * Whether a failure has the shape of an API that was not running yet.
 *
 * The backend deploys with `min-instances=0`, so the first request after an idle
 * period waits for a container to boot and for a fresh Postgres connection. Two
 * outcomes fall out of that, and only these two: the client's deadline expires
 * mid-boot (`REQUEST_TIMEOUT`), or the request finds nothing listening at all
 * (`NETWORK_UNREACHABLE`). Every other failure is an answer from a server that
 * is already up, and retrying one repeats a decision the backend already made.
 */
export function isColdStartError(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return error.code === REQUEST_TIMEOUT_CODE || error.code === NETWORK_UNREACHABLE_CODE;
}

/**
 * Run a request, and run it once more if it failed the way a cold start fails.
 *
 * This is deliberately NOT what `shouldRetryQuery` does. That policy refuses to
 * retry a timeout because a server which is slow under load will be slow again,
 * and a second wait spends the user's patience before showing them anything.
 * A boot is the opposite: the failed attempt is what started the container, so
 * the retry lands on a warm instance and answers immediately.
 *
 * Reserve this for a read the screen cannot render without, where the
 * alternative is a full-page error the user has to dismiss by hand. A retry that
 * the user never notices is worth one extra request; a background refresh is not.
 *
 * @param run     The request. Called again from scratch, so it must be repeatable.
 * @param delayMs Pause before the retry. Zero retries immediately.
 */
export async function retryOnColdStart<T>(
  run: () => Promise<T>,
  delayMs: number = COLD_START_RETRY_DELAY_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= MAX_COLD_START_RETRIES || !isColdStartError(error)) throw error;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}

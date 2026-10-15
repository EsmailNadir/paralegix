import { isApiError, NETWORK_UNREACHABLE_CODE, REQUEST_TIMEOUT_CODE } from '@/lib/utils/apiErrors';

/** Attempts after the first. One, matching the app's long-standing default. */
const MAX_RETRIES = 1;

/**
 * Whether a failed query is worth trying again.
 *
 * Retries exist for the blip - a dropped packet, a request that raced a deploy.
 * A timeout is the opposite: the server is known to be slow right now, and
 * retrying spends the user's patience twice over before showing them anything.
 * Both timeouts and outright unreachability are surfaced immediately instead, so
 * the page can offer a retry control the user chooses to press.
 *
 * Shared by the firm and client-portal QueryClients so the two cannot drift.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isApiError(error)) {
    if (error.code === REQUEST_TIMEOUT_CODE) return false;
    if (error.code === NETWORK_UNREACHABLE_CODE) return false;
  }
  return failureCount < MAX_RETRIES;
}

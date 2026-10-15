/**
 * apiFetch: drop-in replacement for fetch() that silently retries on 401 and
 * refuses to wait forever.
 *
 * Flow:
 *  1. Make the request normally, under a deadline.
 *  2. On 401: clear cached token → force-refresh via Firebase → retry once,
 *     under a fresh deadline of its own.
 *  3. On second 401: fall back to page reload (handleExpiredToken).
 *
 * The deadline defaults from the HTTP method (see `timeoutForMethod`) and is
 * overridden per call with `timeoutMs`. Every budget is defined in
 * `@/lib/constants/requestTimeouts` - change it there, not here.
 */

import { getFirebaseToken, clearTokenCache } from './auth';
import { getUserTimeZone } from './timezone';
import { handleExpiredToken } from './tokenRefreshHandler';
import { trackDuplicateRequest } from './duplicateRequestGuard';
import { emitApiWrite, isWriteMethod } from './apiWriteSignal';
import { armTimeout, withDeadline } from './requestTimeout';
import { timeoutForMethod } from '@/lib/constants/requestTimeouts';
import {
  API_UNREACHABLE_MESSAGE,
  ApiError,
  NETWORK_UNREACHABLE_CODE,
  REQUEST_TIMEOUT_CODE,
  REQUEST_TIMEOUT_MESSAGE,
  readErrorBody,
} from './apiErrors';
import {
  billingStatusFromBody,
  emitBillingLock,
  lawFirmIdFromUrl,
} from '@/lib/plans/billingLockSignal';

/** Message thrown when the request fails due to network/API unreachable. */
export { API_UNREACHABLE_MESSAGE };

export interface ApiFetchOptions extends RequestInit {
  /**
   * Override the method-derived budget, in milliseconds. `0` disables the
   * deadline for this call - reserve it for work whose length is set by the
   * payload rather than by the server (see `REQUEST_TIMEOUT_MS.upload`, which is
   * usually the better answer).
   */
  timeoutMs?: number;
  /** Attach the current Firebase credential unless a caller supplied one. */
  attachAuth?: boolean;
  /** Attach the user's timezone unless a caller supplied one. */
  timezone?: boolean;
}

/**
 * How long the Firebase token refresh inside the 401 retry may take. Short: it
 * is a token mint against Google's infrastructure, not application work, and it
 * is spent from the same patience the user is already extending to the request
 * that triggered it.
 */
const TOKEN_REFRESH_TIMEOUT_MS = 10_000;

/**
 * The `code` values `shared/middleware/auth.ts` puts on a 401 when the problem
 * really is THIS session - an expired, revoked, malformed or absent Firebase
 * token, or a disabled account. Only these are worth a refresh-and-retry.
 *
 * A 401 is not automatically a session failure. The calendar modules answer 401
 * to mean "your Google/Microsoft OAuth grant needs reconnecting", which no
 * amount of Firebase token refreshing can fix: the retry 401s identically and
 * the second failure escalates to `handleExpiredToken`, i.e. a full page reload,
 * on a condition that persists - so background calendar sync would reload the
 * page on a loop instead of surfacing the reconnect banner.
 */
const SESSION_AUTH_CODES = new Set([
  'NO_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'ACCOUNT_DISABLED',
  'INVALID_TOKEN',
  'AUTH_FAILED',
  'AUTH_REQUIRED',
]);

/**
 * Whether a 401 is about the Firebase session (refresh may help) or about some
 * other credential the endpoint needs (refresh cannot help).
 *
 * Reads the body through `readErrorBody`, which clones the response, so the
 * caller can still consume it. An uncoded 401 is treated as a session failure:
 * that is the behavior this function was factored out of, and preserving it
 * means only endpoints that explicitly opt out by sending a non-session `code`
 * change behavior.
 */
async function isSessionAuthFailure(response: Response): Promise<boolean> {
  const body = await readErrorBody(response);
  const code =
    typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code
      : undefined;

  if (!code) return true;
  return SESSION_AUTH_CODES.has(code);
}

function timeoutError(url: string, method: string): ApiError {
  return new ApiError(REQUEST_TIMEOUT_MESSAGE, {
    status: 0,
    code: REQUEST_TIMEOUT_CODE,
    requestUrl: url,
    requestMethod: method,
  });
}

function unreachableError(url: string, method: string): ApiError {
  return new ApiError(API_UNREACHABLE_MESSAGE, {
    status: 0,
    code: NETWORK_UNREACHABLE_CODE,
    requestUrl: url,
    requestMethod: method,
  });
}

/**
 * A transport-level failure, which every engine words differently: Chrome
 * "Failed to fetch", Firefox "NetworkError when attempting to fetch resource",
 * Safari "Load failed", Node/undici "fetch failed". Matching all four keeps the
 * classification the same wherever this runs, rather than degrading to a bare
 * TypeError outside the browser.
 */
function isNetworkFailure(message: string): boolean {
  return message === 'Failed to fetch'
    || message === 'fetch failed'
    || message.includes('NetworkError')
    || message.includes('Load failed');
}

/**
 * One `fetch` under a deadline, with the three failure outcomes named.
 *
 * The armed timeout is deliberately NOT disposed on success. Callers read the
 * body (`response.json()`) after this returns, so a server that sends headers
 * and then stalls mid-body would otherwise be unbounded - the signal has to stay
 * live to abort the body stream. Once the body is consumed the pending abort is
 * a no-op, so the only cost is a timer that outlives a fast response.
 */
async function fetchWithDeadline(
  url: string,
  options: ApiFetchOptions,
  headers?: Headers,
): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase();
  const budget = options.timeoutMs ?? timeoutForMethod(method);
  const armed = armTimeout(budget, options.signal);

  // `timeoutMs` is ours, not fetch's. Strip it so the RequestInit handed to the
  // platform contains only platform options. Deleted from a shallow copy rather
  // than destructured away, so no unused binding is left behind for lint.
  const init: ApiFetchOptions = { ...options };
  delete init.timeoutMs;
  delete init.attachAuth;
  delete init.timezone;

  try {
    return await fetch(url, {
      ...init,
      ...(headers ? { headers } : {}),
      signal: armed.signal,
    });
  } catch (err) {
    armed.dispose();

    // A caller-initiated abort (React Query dropping a query on unmount) is a
    // cancellation, not a failure. Rethrow it untouched so React Query keeps
    // treating it as one; only OUR deadline becomes a reportable error.
    if (armed.didTimeOut()) throw timeoutError(url, method);
    if (options.signal?.aborted) throw err;

    const message = err instanceof Error ? err.message : String(err);
    if (isNetworkFailure(message)) throw unreachableError(url, method);
    throw err;
  }
}

/**
 * Supply the two headers required by normal API routes in one place. Services
 * may still provide a different Authorization header for a specialised flow;
 * this never overwrites caller intent. Public and signed-URL requests use
 * `publicFetch`, which deliberately bypasses this helper.
 */
export async function prepareApiFetchOptions(options: ApiFetchOptions): Promise<ApiFetchOptions> {
  const { attachAuth = true, timezone = true, ...init } = options;
  const headers = new Headers(init.headers);

  if (attachAuth && !headers.has('Authorization')) {
    const token = await getFirebaseToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  if (timezone && !headers.has('X-Timezone')) {
    headers.set('X-Timezone', getUserTimeZone());
  }

  return { ...init, headers };
}

export async function apiFetch(
  url: string,
  options: ApiFetchOptions = {},
): Promise<Response> {
  // Dev-only: flag the same GET endpoint being fetched twice in quick succession
  // (usually two hooks with divergent React Query keys). No-op in production.
  const preparedOptions = await prepareApiFetchOptions(options);
  trackDuplicateRequest(url, preparedOptions.method || 'GET');

  const method = (preparedOptions.method || 'GET').toUpperCase();
  const response = await fetchWithDeadline(url, preparedOptions);

  if (response.status === 410 || response.status === 503) {
    const body = await readErrorBody(response);
    throw ApiError.fromResponse(
      response,
      body,
      // A 503 takes its default from the body's code: maintenance only when
      // the backend said MAINTENANCE_MODE, never for a busy queue or a platform
      // 503, which carry no maintenance window at all.
      response.status === 410 ? 'This is no longer available.' : undefined,
      { url, method },
    );
  }

  // A 402 is always BILLING_INACTIVE, and it means the whole firm workspace is
  // locked rather than this one request having failed. Announce it centrally so
  // the firm layout raises the paywall, instead of each caller painting its own
  // error banner over a workspace the backend has already closed. The response
  // is handed back untouched: the caller still throws its own ApiError.
  if (response.status === 402) {
    const body = await readErrorBody(response);
    emitBillingLock({
      lawFirmId: lawFirmIdFromUrl(url),
      billingStatus: billingStatusFromBody(body),
    });
  }

  if (response.status !== 401) {
    return announceWrite(response, method, url);
  }

  // A 401 the session cannot fix (an expired Google/Microsoft OAuth grant) is
  // handed straight back, so the caller can raise its own reconnect prompt
  // instead of this function refreshing, retrying and finally reloading the page.
  if (!(await isSessionAuthFailure(response))) {
    return response;
  }

  // 401: attempt silent token refresh + retry
  clearTokenCache();

  const newToken = await withDeadline(
    getFirebaseToken(true),
    TOKEN_REFRESH_TIMEOUT_MS,
    () => timeoutError(url, method),
  );

  if (!newToken) {
    // No user / can't refresh, last-resort reload
    handleExpiredToken(new Error('No authenticated user'));
    throw new ApiError('Authentication failed: not signed in', {
      status: 401,
      code: 'AUTHENTICATION_FAILED',
      requestUrl: url,
      requestMethod: method,
    });
  }

  // Rebuild headers with the fresh token. The retry gets its own full budget:
  // the user is waiting on one logical request, but the first attempt's failure
  // was authentication, not slowness, so it should not eat the retry's patience.
  const retryHeaders = new Headers(preparedOptions.headers);
  retryHeaders.set('Authorization', `Bearer ${newToken}`);

  const retryResponse = await fetchWithDeadline(url, preparedOptions, retryHeaders);

  if (retryResponse.status === 401) {
    // A fresh token still got 401, but for a credential this layer does not own
    // (the endpoint's own OAuth grant). Reloading would not fix it; hand it back.
    if (!(await isSessionAuthFailure(retryResponse))) {
      return retryResponse;
    }

    // Truly expired / revoked, last-resort reload
    handleExpiredToken(new Error('Token expired after refresh'));
    throw new ApiError('Authentication failed: session expired', {
      status: 401,
      code: 'AUTHENTICATION_EXPIRED',
      requestUrl: url,
      requestMethod: method,
    });
  }

  if (retryResponse.status === 410 || retryResponse.status === 503) {
    const body = await readErrorBody(retryResponse);
    throw ApiError.fromResponse(
      retryResponse,
      body,
      // A 503 takes its default from the body's code: maintenance only when
      // the backend said MAINTENANCE_MODE, never for a busy queue or a platform
      // 503, which carry no maintenance window at all.
      retryResponse.status === 410 ? 'This is no longer available.' : undefined,
      { url, method },
    );
  }

  return announceWrite(retryResponse, method, url);
}

// A 2xx write changed server data, so tell the firm layout to mark its query
// cache stale (see `apiWriteSignal`). The response is handed back untouched.
function announceWrite(response: Response, method: string, url: string): Response {
  if (response.ok && isWriteMethod(method)) {
    emitApiWrite({ method, url });
  }
  return response;
}

/**
 * The same deadline and network-error handling, without the Authorization
 * plumbing, for the handful of backend endpoints that answer unauthenticated
 * callers: invitation lookup, public share links, signing-session verification.
 *
 * Those pages have no session yet by definition, so they cannot use `apiFetch` - 
 * but a stalled invite lookup strands a new user on a spinner exactly the same
 * way, and it should not be a separate code path to remember to bound.
 */
export async function publicFetch(
  url: string,
  options: ApiFetchOptions = {},
): Promise<Response> {
  return fetchWithDeadline(url, options);
}

export interface ApiErrorOptions {
  status?: number;
  code?: string;
  details?: unknown;
  requestId?: string;
  requestUrl?: string;
  requestMethod?: string;
  retryAfterSeconds?: number;
}

export interface ApiErrorPayload {
  error?: string;
  message?: string;
  code?: string;
  details?: unknown;
  requestId?: string;
}

export const MAINTENANCE_MODE_CODE = 'MAINTENANCE_MODE';
export const NETWORK_UNREACHABLE_CODE = 'NETWORK_UNREACHABLE';
export const REQUEST_TIMEOUT_CODE = 'REQUEST_TIMEOUT';
export const RATE_LIMITED_CODE = 'RATE_LIMITED';
export const BILLING_INACTIVE_CODE = 'BILLING_INACTIVE';
export const BILLING_INACTIVE_MESSAGE =
  "This firm's subscription is inactive. Your data is safe and preserved. The firm owner needs to update the subscription to restore access.";
export const API_UNREACHABLE_MESSAGE =
  'Unable to connect to the server. Please check your internet connection and try again.';
export const REQUEST_TIMEOUT_MESSAGE =
  'The server took too long to respond. It may still be catching up. Please try again.';
/**
 * The codes a document route answers with when its queue is full. Each is a 503
 * from a server that is up and refused the work before starting it, so the same
 * request is safe to send again (see `retryWhileBusy`).
 */
export const SERVER_BUSY_CODES: ReadonlySet<string> = new Set([
  'TEMPLATE_FILL_BUSY',
  'CONVERSION_BUSY',
  'SIGNING_BUSY',
]);
export const SERVER_BUSY_MESSAGE =
  'Too many documents are being prepared right now. Please try again in a moment.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toApiPayload(raw: unknown): ApiErrorPayload {
  if (!isRecord(raw)) return {};
  const payload: ApiErrorPayload = {};
  if (typeof raw.error === 'string') payload.error = raw.error;
  if (typeof raw.message === 'string') payload.message = raw.message;
  if (typeof raw.code === 'string') payload.code = raw.code;
  if ('details' in raw) payload.details = raw.details;
  if (typeof raw.requestId === 'string') payload.requestId = raw.requestId;
  return payload;
}

/**
 * Seconds until a rate-limited request may be retried, read from the standard
 * headers the backend now exposes cross-origin. Prefers `Retry-After` (express-
 * rate-limit sends it as delta-seconds; an HTTP-date is also tolerated) and
 * falls back to `RateLimit-Reset`. Returns undefined when neither is readable
 * (e.g. the header is not CORS-exposed), so callers can degrade gracefully.
 */
function parseRetryAfterSeconds(
  response: Response,
  { allowRateLimitReset = true }: { allowRateLimitReset?: boolean } = {},
): number | undefined {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const asNumber = Number(retryAfter);
    if (Number.isFinite(asNumber)) {
      // A value that reads as a number is judged on that reading alone. A
      // negative used to fall through to the date branch, where
      // Date.parse('-5') succeeds, so a malformed header produced a real
      // countdown clamped to zero instead of none. It now declines to answer
      // and lets RateLimit-Reset below have its turn.
      if (asNumber >= 0) return Math.ceil(asNumber);
    } else {
      const asDate = Date.parse(retryAfter);
      if (!Number.isNaN(asDate)) return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
    }
  }
  // `RateLimit-Reset` describes the rate window, which the limiter stamps on
  // every response. Only a 429 is about that window.
  if (!allowRateLimitReset) return undefined;
  const reset = response.headers.get('RateLimit-Reset');
  if (reset) {
    const asNumber = Number(reset);
    if (Number.isFinite(asNumber) && asNumber >= 0) return Math.ceil(asNumber);
  }
  return undefined;
}

function defaultMessageFor(status?: number, code?: string) {
  if (status === 410) {
    return 'This is no longer available.';
  }
  if (code === MAINTENANCE_MODE_CODE) {
    return 'Paralegix is in maintenance mode. Please retry in a few minutes.';
  }
  if (code && SERVER_BUSY_CODES.has(code)) return SERVER_BUSY_MESSAGE;
  return 'Something went wrong. Please try again.';
}

export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly requestUrl?: string;
  readonly requestMethod?: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
    this.requestUrl = options.requestUrl;
    this.requestMethod = options.requestMethod;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /**
   * By code only. The backend's maintenance middleware always sends it; a 503
   * without it is a busy document queue or the platform shedding load, and
   * neither is a reason to tell the user the whole app is down.
   */
  get isMaintenanceMode() {
    return this.code === MAINTENANCE_MODE_CODE;
  }

  /** A document queue was full and the work was refused before it started. */
  get isServerBusy() {
    return !!this.code && SERVER_BUSY_CODES.has(this.code);
  }

  /**
   * The client gave up waiting. Distinct from an unreachable server: the request
   * reached the backend, which may well still be working on it - which is why a
   * timed-out write cannot be assumed not to have landed.
   */
  get isTimeout() {
    return this.code === REQUEST_TIMEOUT_CODE;
  }

  get isBillingInactive() {
    return this.status === 402 || this.code === BILLING_INACTIVE_CODE;
  }

  get isRateLimited() {
    return this.status === 429 || this.code === RATE_LIMITED_CODE;
  }

  /**
   * Refused for who the caller is, not for anything the request said. There is
   * nothing to retry and nothing to correct, so a read that answers this way
   * belongs in a locked empty state rather than an error banner.
   */
  get isForbidden() {
    return this.status === 403 || this.code === 'FORBIDDEN';
  }

  static fromResponse(
    response: Response,
    rawBody: unknown,
    fallbackMessage?: string,
    request?: { url?: string; method?: string },
  ) {
    const payload = toApiPayload(rawBody);
    const code = payload.code;
    const message =
      payload.error ||
      payload.message ||
      fallbackMessage ||
      defaultMessageFor(response.status, code);

    return new ApiError(message, {
      status: response.status,
      code,
      details: payload.details,
      requestId: payload.requestId || response.headers.get('x-request-id') || undefined,
      requestUrl: request?.url,
      requestMethod: request?.method,
      retryAfterSeconds: response.status === 429
        ? parseRetryAfterSeconds(response)
        : response.status === 503
          ? parseRetryAfterSeconds(response, { allowRateLimitReset: false })
          : undefined,
    });
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** True when a failure was a refusal of access; see `ApiError.isForbidden`. */
export function isForbiddenError(error: unknown): boolean {
  return isApiError(error) && error.isForbidden;
}

export async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    try {
      const text = await response.clone().text();
      return text ? { error: text } : {};
    } catch {
      return {};
    }
  }
}

export async function toApiError(
  response: Response,
  fallbackMessage?: string,
  request?: { url?: string; method?: string },
) {
  const body = await readErrorBody(response);
  return ApiError.fromResponse(response, body, fallbackMessage, request);
}

/**
 * Flatten validation `details` into a list of human-readable messages.
 * Handles the three shapes the backend produces: a plain string, a Zod
 * `flatten()` result ({ formErrors, fieldErrors }), or an ad-hoc field map
 * ({ email: ['msg'] } / { dependency: 'msg' }).
 */
export function getFieldErrors(error: unknown): string[] {
  if (!isApiError(error) || !error.details) return [];
  // Only validation errors carry a field map; other errors put structured
  // data in details (e.g. PLAN_LIMIT_REACHED's { resource, limit, planId }),
  // which must not be rendered as field messages.
  if (error.code !== 'VALIDATION_ERROR') return [];
  const details = error.details;
  if (typeof details === 'string') return details.trim() ? [details] : [];
  if (!isRecord(details)) return [];

  const messages: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) messages.push(value);
    else if (Array.isArray(value)) value.forEach((v) => typeof v === 'string' && v.trim() && messages.push(v));
  };

  if (Array.isArray(details.formErrors)) push(details.formErrors);
  const fieldMap = isRecord(details.fieldErrors) ? details.fieldErrors : details;
  Object.values(fieldMap).forEach(push);

  return Array.from(new Set(messages)).slice(0, 6);
}

const SESSION_EXPIRED_CODES = new Set([
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'AUTH_FAILED',
  'INVALID_TOKEN',
  'AUTHENTICATION_FAILED',
  'AUTHENTICATION_EXPIRED',
]);

/**
 * Map any thrown error to copy a user can act on. Prefers specific guidance
 * keyed off the backend error code, falls back to the server-provided message,
 * and appends the request id for server-side failures so users can quote it
 * to support.
 */
export function getErrorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (typeof error === 'string') return error || fallback;
  if (!(error instanceof Error)) return fallback;

  if (!isApiError(error)) {
    // fetch() network failures surface as TypeError with a browser-specific message.
    if (error.name === 'TypeError' && /fetch|network/i.test(error.message)) {
      return API_UNREACHABLE_MESSAGE;
    }
    return error.message || fallback;
  }

  const { code, status, requestId } = error;

  if (code === NETWORK_UNREACHABLE_CODE) return API_UNREACHABLE_MESSAGE;
  if (code === REQUEST_TIMEOUT_CODE) return REQUEST_TIMEOUT_MESSAGE;
  // A 402 means the firm's subscription is inactive. The layout guard owns the
  // visible lock screen; this just gives any stray data-fetch failure sane copy.
  if (code === BILLING_INACTIVE_CODE || status === 402) return BILLING_INACTIVE_MESSAGE;
  if (error.isMaintenanceMode) return 'Paralegix is undergoing maintenance. Please retry in a few minutes.';
  if (error.isServerBusy) {
    // The routes send their own wording; keep it unless it is the backend's
    // generic scrub text. No request id: nothing failed, the queue was full.
    return error.message && !/^something went wrong/i.test(error.message)
      ? error.message
      : SERVER_BUSY_MESSAGE;
  }
  if (error.isRateLimited) {
    const secs = error.retryAfterSeconds;
    if (secs && secs > 0) {
      const unit = secs === 1 ? 'second' : 'seconds';
      return `You're doing that too quickly. Please wait ${secs} ${unit} and try again.`;
    }
    // No countdown header available: prefer the server's curated copy (e.g. the
    // per-network or per-signing-session wording), else a generic fallback.
    return error.message || 'You are making requests too quickly. Please wait a moment and try again.';
  }
  if (code && SESSION_EXPIRED_CODES.has(code)) return 'Your session has expired. Please log in again.';
  if (code === 'ACCOUNT_DISABLED') return 'Your account has been disabled. Please contact support.';
  if (code === 'PLAN_LIMIT_REACHED') {
    const details = isRecord(error.details) ? error.details : {};
    const RESOURCE_LABELS: Record<string, string> = { maxMatters: 'matters', maxMembers: 'team members' };
    const label = RESOURCE_LABELS[String(details.resource)] || 'items';
    const limit = typeof details.limit === 'number' ? details.limit : null;
    return limit === null
      ? `Your plan's ${label} limit has been reached. Upgrade your plan to add more.`
      : `Your plan allows ${limit} ${label} and you are using all ${limit}. Upgrade your plan to add more.`;
  }
  if (status === 403 || code === 'FORBIDDEN') {
    return error.message && error.message !== 'Access denied'
      ? error.message
      : 'You do not have permission to do this. Ask a firm admin if you need access.';
  }
  if (status && status >= 500) {
    // Keep a specific message when one exists (services curate copy for some
    // failures); only replace the backend's generic scrub text, which lacks
    // the concrete error ID.
    // A 503 with no code is the platform's own page (Cloud Run answers an
    // overloaded or unstarted service with HTML) or a bare "not configured"
    // answer. Neither body is copy for a user, so it gets the generic line.
    const isGeneric = !error.message
      || /^something went wrong/i.test(error.message)
      || (status === 503 && !code);
    const base = isGeneric ? 'Something went wrong on our end. Please try again.' : error.message;
    const suffix = requestId ? ` If it keeps happening, contact support with error ID ${requestId}.` : '';
    return `${base}${suffix}`;
  }

  return error.message || fallback;
}


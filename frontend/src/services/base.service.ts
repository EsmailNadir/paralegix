import { getFirebaseToken } from '@/lib/utils/auth';
import { getUserTimeZone } from '@/lib/utils/timezone';
import { apiFetch, type ApiFetchOptions } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError } from '@/lib/utils/apiErrors';
import requestDeduplicator from './requestDeduplicator';

/**
 * The shared transport every domain service is built on.
 *
 * Before this existed, each of the ~30 services resolved its own credential and
 * hand-assembled `Authorization: Bearer ${token}` at every call site - roughly
 * 230 copies of the same four lines. The duplication was not merely noisy: a
 * subset of services skipped `apiFetch` entirely and called `fetch` directly,
 * so those requests silently lost the 401 refresh-and-retry and the per-method
 * timeout budget that every other request in the app enjoys.
 *
 * `authHeaders` below is now the ONLY place in the frontend that turns "the
 * current user" into a credential on a request. That matters beyond tidiness:
 * moving the app from a bearer token to an HttpOnly session cookie becomes an
 * edit to one method here (drop the token, set `credentials: 'include'`) rather
 * than a sweep across every service.
 */

/** A request body we serialize ourselves vs. one the platform handles. */
type PassthroughBody = FormData | Blob | ArrayBuffer | URLSearchParams | string;

function isPassthroughBody(value: unknown): value is PassthroughBody {
  return (
    typeof value === 'string' ||
    (typeof FormData !== 'undefined' && value instanceof FormData) ||
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) ||
    value instanceof ArrayBuffer
  );
}

export interface ApiRequestOptions extends Omit<ApiFetchOptions, 'body' | 'headers'> {
  /**
   * Plain objects and arrays are JSON-serialized and get a JSON content type.
   * FormData/Blob/string/URLSearchParams are passed through untouched - notably
   * FormData must NOT carry an explicit Content-Type or the browser cannot add
   * the multipart boundary.
   */
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Send `X-Timezone`. On by default: the backend's `requireTimezone` rejects
   * requests without it, and `persistTimezone` uses it to keep a user's stored
   * zone current for scheduled work (digests, reminders) that has no request to
   * read one from. Sending it everywhere costs nothing and removes a class of
   * "which calls remembered the header" bugs.
   */
  timezone?: boolean;
  /** Fallback message when the server's error body carries none. */
  errorMessage?: string;
}

/**
 * Shared credential/header builder for service methods that cannot yet extend
 * `BaseApiService`. It deliberately omits Authorization when Firebase has not
 * restored a user, preventing an accidental `Bearer null` request.
 */
export async function authenticatedHeaders(
  extra: Record<string, string> = {},
  { timezone = true, requireToken = false }: { timezone?: boolean; requireToken?: boolean } = {},
): Promise<Record<string, string>> {
  const token = await getFirebaseToken();
  if (!token && requireToken) {
    throw new Error('Your session has expired. Please log in again.');
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (timezone) headers['X-Timezone'] = getUserTimeZone();
  return { ...headers, ...extra };
}

export class BaseApiService {
  /** The `/api` root, e.g. `https://api.paralegix.com/api`. */
  protected readonly apiRoot: string;

  /** `apiRoot` joined with the subclass's path, e.g. `.../api/users`. */
  protected readonly baseUrl: string;

  constructor(basePath = '') {
    this.apiRoot = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const trimmed = basePath.replace(/^\/+/, '');
    this.baseUrl = trimmed ? `${this.apiRoot}/${trimmed}` : this.apiRoot;
  }

  /**
   * The single credential-attachment point for the whole frontend.
   *
   * `getFirebaseToken()` caches for five minutes and waits out Firebase's
   * session restore on cold loads, so calling this per request is cheap.
   */
  protected async authHeaders(
    extra: Record<string, string> = {},
    { timezone = true }: { timezone?: boolean } = {},
  ): Promise<Record<string, string>> {
    return authenticatedHeaders(extra, { timezone });
  }

  /**
   * Build the RequestInit shared by `request`/`requestRaw`, resolving the
   * credential and choosing a body encoding.
   */
  private async buildInit(options: ApiRequestOptions): Promise<ApiFetchOptions> {
    const { body, headers: extraHeaders, timezone, errorMessage, ...rest } = options;
    void errorMessage;

    const headers = await this.authHeaders(extraHeaders, { timezone });

    if (body === undefined) {
      return { ...rest, headers };
    }

    if (isPassthroughBody(body)) {
      return { ...rest, headers, body: body as BodyInit };
    }

    return {
      ...rest,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    };
  }

  /** An authenticated request whose JSON body is returned, throwing `ApiError` on failure. */
  protected async request<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
    const response = await this.requestRaw(url, options);
    // 204 and other empty-body successes have nothing to parse; callers that
    // type these as void or as an optional shape get undefined rather than a
    // JSON syntax error.
    if (response.status === 204) return undefined as T;
    return (await response.json().catch(() => ({}))) as T;
  }

  /**
   * An authenticated request returning the raw `Response`, for callers that read
   * a blob or an arrayBuffer. Still throws `ApiError` on a non-2xx.
   */
  protected async requestRaw(url: string, options: ApiRequestOptions = {}): Promise<Response> {
    const init = await this.buildInit(options);
    const method = (init.method || 'GET').toUpperCase();
    const response = await apiFetch(url, init);

    if (!response.ok) {
      throw await toApiError(response, options.errorMessage, { url, method });
    }

    return response;
  }

  /** Read a successful authenticated response as binary without duplicating response checks. */
  protected async requestBlob(url: string, options: ApiRequestOptions = {}): Promise<Blob> {
    return (await this.requestRaw(url, options)).blob();
  }

  /** Read a successful authenticated response as an ArrayBuffer. */
  protected async requestArrayBuffer(url: string, options: ApiRequestOptions = {}): Promise<ArrayBuffer> {
    return (await this.requestRaw(url, options)).arrayBuffer();
  }

  /**
   * A GET that coalesces with an identical in-flight GET. Use for reads that
   * several components request at once (a list a page and its sidebar both
   * need); `requestDeduplicator` only collapses concurrent calls and never
   * caches settled results, so React Query still owns staleness.
   */
  protected async dedupedGet<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
    const init = await this.buildInit({ ...options, method: 'GET' });
    return requestDeduplicator.execute<T>(url, init);
  }

  /** Join path segments onto `baseUrl`, encoding each one. */
  protected url(...segments: (string | number)[]): string {
    if (!segments.length) return this.baseUrl;
    return `${this.baseUrl}/${segments.map((s) => encodeURIComponent(String(s))).join('/')}`;
  }
}

export default BaseApiService;

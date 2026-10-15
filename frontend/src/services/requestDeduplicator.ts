import { apiFetch, prepareApiFetchOptions, type ApiFetchOptions } from '@/lib/utils/fetchWithTokenRefresh';
import { ApiError } from '@/lib/utils/apiErrors';

// Extends the apiFetch options rather than a bare RequestInit so a caller can
// set `timeoutMs` on a request that routes through here. `execute` already
// forwards the whole options object, so widening the type is the entire change.
interface RequestOptions extends ApiFetchOptions {
  params?: Record<string, unknown>;
}

class RequestDeduplicator {
  private pendingRequests: Map<string, Promise<any>>;

  constructor() {
    this.pendingRequests = new Map();
  }

  async execute<T = any>(url: string, options: RequestOptions = {}): Promise<T> {
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      throw new Error('requestDeduplicator only supports GET requests.');
    }

    const preparedOptions = await prepareApiFetchOptions(options);
    const headers = new Headers(preparedOptions.headers);
    // The URL carries query parameters already. Include request-affecting
    // headers so an anonymous/public read cannot coalesce with an authenticated
    // read of the same URL during a session transition.
    const requestKey = JSON.stringify({
      method,
      url,
      params: options.params || {},
      authorization: headers.get('authorization') || '',
      accept: headers.get('accept') || '',
    });

    // Coalesce only with a currently in-flight identical request. We deliberately
    // do NOT cache settled results: mutations bypass this deduplicator (plain
    // fetch), so a post-settle cache could not be invalidated on write and would
    // replay stale data to React Query's post-mutation refetch (e.g. a deleted
    // row reappearing). React Query owns result caching/staleness; this layer
    // only collapses concurrent network calls for the same request.
    if (this.pendingRequests.has(requestKey)) {
      return this.pendingRequests.get(requestKey) as Promise<T>;
    }

    const requestPromise = apiFetch(url, preparedOptions)
      .then(async (response) => {
        const body = await response.json().catch(() => ({} as any));
        if (!response.ok) {
          throw ApiError.fromResponse(
            response,
            body,
            'Something went wrong. Please try again.',
            { url, method },
          );
        }
        return body as T;
      })
      .finally(() => {
        this.pendingRequests.delete(requestKey);
      });

    this.pendingRequests.set(requestKey, requestPromise);

    return requestPromise as Promise<T>;
  }
}

const requestDeduplicator = new RequestDeduplicator();
export default requestDeduplicator;

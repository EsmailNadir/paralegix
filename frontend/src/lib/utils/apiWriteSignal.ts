/**
 * The one place a successful API write is announced.
 *
 * Much of the firm workspace changes data with an imperative service call that
 * does not invalidate the React Query caches reading that data. The firm
 * QueryClient keeps results fresh for two minutes, so without a signal a screen
 * remounted after the user's own edit would show the value from before it.
 * `apiFetch` announces every 2xx write here and the firm layout marks its cache
 * stale (see `markQueriesStaleOnApiWrite`).
 *
 * Listeners live only in the client bundle, so nothing here runs on the server.
 */

export interface ApiWriteSignal {
  /** Upper-case HTTP method: POST, PUT, PATCH or DELETE. */
  method: string;
  url: string;
}

type ApiWriteListener = (signal: ApiWriteSignal) => void;

const listeners = new Set<ApiWriteListener>();

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether a request with this method can change server data. */
export function isWriteMethod(method: string): boolean {
  return !READ_METHODS.has(method.toUpperCase());
}

/** Subscribe to successful writes. Returns the unsubscribe function. */
export function onApiWrite(listener: ApiWriteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announce a successful write. A listener that throws must not fail the request
 * that triggered it, so each one is called defensively.
 */
export function emitApiWrite(signal: ApiWriteSignal): void {
  listeners.forEach((listener) => {
    try {
      listener(signal);
    } catch (error) {
      console.error('API write listener failed:', error);
    }
  });
}

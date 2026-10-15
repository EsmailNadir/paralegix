/**
 * A fake XMLHttpRequest, for the upload paths `apiMock` cannot see.
 *
 * WHY A SECOND FAKE EXISTS
 * `apiMock` replaces the global `fetch`, which covers every request the service
 * layer makes through `apiFetch`. File uploads do not go that way: they need a
 * per-byte progress event, and `fetch` has no request-progress API, so every
 * upload in the app is hand-built on `XMLHttpRequest`. Those requests are
 * invisible to a fetch fake, which is exactly why nothing has ever asserted what
 * an upload puts on the wire: the file field name, the credential the service
 * attaches by hand, and the Content-Type it must NOT set.
 *
 * THE SAME RULE THAT MAKES `apiMock` HONEST
 * An unmatched request THROWS, naming the method and url. The throw happens
 * inside `send()`, which the services call from a promise continuation, so it
 * surfaces as a rejection of the upload rather than being swallowed.
 *
 * USAGE
 *   const xhr = installXhrMock();
 *   xhr.on('POST', '/documents', { body: { documents: [] } });
 *   await service.uploadMatterDocuments(...);
 *   expect(xhr.calls()[0].headers.authorization).toMatch(/^Bearer /);
 */

/** One request a service handed to `XMLHttpRequest`. */
export interface RecordedXhrCall {
  method: string;
  url: string;
  /** Header names lower-cased, matching how a real `Headers` normalises them. */
  headers: Record<string, string>;
  /** Whatever was passed to `send()`: a `FormData`, a `File`, or null. */
  body: unknown;
}

export interface XhrResponse {
  status?: number;
  /** JSON-serialised into `responseText`. */
  body?: unknown;
  /** Raw `responseText`, for the case where the server does not answer JSON. */
  text?: string;
  /**
   * Response headers the service may read back with `getResponseHeader`. The
   * one that matters is `Range` on a `308`: it is how a resumable upload learns
   * how many bytes GCS persisted, and the only way a spec can drive a resume.
   * Names are matched case-insensitively, as a browser does.
   */
  headers?: Record<string, string>;
  /** Upload progress events emitted before the terminal event. */
  progress?: Array<{ loaded: number; total: number; lengthComputable?: boolean }>;
  /** Emit `error` instead of `load`, as a dropped connection does. */
  networkError?: boolean;
  /** Emit `abort` instead of `load`, as a cancelled upload does. */
  aborted?: boolean;
  /**
   * Hold the response until this settles, for a spec that acts while the
   * bytes are still moving. An `abort()` in the meantime still ends the request
   * at once, as it does in a browser.
   */
  until?: Promise<unknown>;
}

type XhrHandler = XhrResponse | ((call: RecordedXhrCall) => XhrResponse);

export interface XhrMock {
  /**
   * Answer one method plus a url SUBSTRING. A later registration wins over an
   * earlier one.
   *
   * Deliberately broad, for a spec whose subject is not the url. Note what that
   * costs: `/messaging/attachments` is contained in every firm's upload url, so
   * a handler registered that way answers an upload addressed to the wrong firm
   * and the spec looks correct. Use `onExact` whenever the url matters.
   */
  on(method: string, urlSuffix: string, handler: XhrHandler): XhrMock;
  /**
   * Answer one method plus the COMPLETE url path, ignoring the origin so a spec
   * does not have to know `API_URL`. A request for another firm, another matter
   * or another upload session is refused.
   */
  onExact(method: string, url: string, handler: XhrHandler): XhrMock;
  calls(method?: string): RecordedXhrCall[];
  /**
   * Uploads that matched no route.
   *
   * The throw inside `send()` only reaches whoever awaits the upload, and every
   * upload service rewraps the failure in its own Error. So an unregistered
   * request becomes an invisible one, and the spec passes having proved nothing.
   */
  unhandledRequests(): RecordedXhrCall[];
  /** Accept unmatched uploads here, for a test whose subject IS the refusal. */
  allowUnhandled(): XhrMock;
  /** Throw if any upload went unmatched. `restore()` calls this. */
  assertNoUnhandledRequests(): void;
  restore(): void;
}

/**
 * The path a url carries, without its origin.
 *
 * Services build absolute urls from `API_URL`, which differs between a developer
 * machine and CI, so a spec that pinned the whole string would be pinning the
 * environment rather than the route.
 */
function pathOf(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url;
  }
}

type Listener = (event: unknown) => void;

export function installXhrMock(): XhrMock {
  const routes: Array<{ method: string; urlPart: string; match: 'substring' | 'exact'; handler: XhrHandler }> = [];
  const recorded: RecordedXhrCall[] = [];
  const unhandled: RecordedXhrCall[] = [];
  let unhandledAllowed = false;
  const original = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;

  class FakeXhr {
    status = 0;
    responseText = '';
    private responseHeaders: Record<string, string> = {};

    private requestMethod = 'GET';
    private requestUrl = '';
    private requestHeaders: Record<string, string> = {};
    private listeners: Record<string, Listener[]> = {};
    private uploadListeners: Record<string, Listener[]> = {};

    // The services attach their progress handler to `xhr.upload`, a separate
    // event target from the request itself. Keeping the two lists apart is what
    // lets a spec prove progress was reported on the upload rather than on the
    // response.
    upload = {
      addEventListener: (type: string, callback: Listener) => {
        this.uploadListeners[type] = (this.uploadListeners[type] || []).concat(callback);
      },
    };

    addEventListener(type: string, callback: Listener): void {
      this.listeners[type] = (this.listeners[type] || []).concat(callback);
    }

    open(method: string, url: string): void {
      this.requestMethod = String(method).toUpperCase();
      this.requestUrl = url;
    }

    setRequestHeader(name: string, value: string): void {
      this.requestHeaders[String(name).toLowerCase()] = String(value);
    }

    getResponseHeader(name: string): string | null {
      const wanted = String(name).toLowerCase();
      for (const [key, value] of Object.entries(this.responseHeaders)) {
        if (key.toLowerCase() === wanted) return value;
      }
      return null;
    }

    send(body?: unknown): void {
      const call: RecordedXhrCall = {
        method: this.requestMethod,
        url: this.requestUrl,
        headers: { ...this.requestHeaders },
        body: body ?? null,
      };
      recorded.push(call);

      const route = routes.find((r) => r.method === call.method
        && (r.match === 'substring'
          ? call.url.includes(r.urlPart)
          : pathOf(call.url) === r.urlPart));
      if (!route) {
        // Recorded as well as thrown, for the same reason `apiMock` records its
        // misses: the throw is swallowed by the service's own error handling.
        unhandled.push(call);
        throw new Error(
          `xhrMock: no handler for ${call.method} ${call.url}\n`
          + `Registered: ${routes.map((r) => `${r.method} ${r.urlPart}`).join(', ') || '(none)'}\n`
          + 'Add one with xhr.on(method, urlSuffix, ...), or assert the upload should not happen.',
        );
      }

      const resolved = typeof route.handler === 'function' ? route.handler(call) : route.handler;

      // Asynchronous, like a real request: a service that resolved its promise
      // before the load event would otherwise appear to work here.
      Promise.resolve(resolved.until).then(() => {
        if (this.settled) return;
        for (const tick of resolved.progress || []) {
          this.emit(this.uploadListeners, 'progress', {
            lengthComputable: tick.lengthComputable !== false,
            loaded: tick.loaded,
            total: tick.total,
          });
        }
        if (this.settled) return;
        this.settled = true;
        if (resolved.networkError) {
          this.emit(this.listeners, 'error', {});
          return;
        }
        if (resolved.aborted) {
          this.emit(this.listeners, 'abort', {});
          return;
        }
        this.status = resolved.status ?? 200;
        this.responseText = resolved.text ?? JSON.stringify(resolved.body ?? {});
        this.responseHeaders = { ...(resolved.headers || {}) };
        this.emit(this.listeners, 'load', {});
      });
    }

    /**
     * Cancel the request, as a real XHR does.
     *
     * An upload that takes an `AbortSignal` calls this from the signal's own
     * listener, and a listener that throws is swallowed by the event dispatch:
     * the fake would look like it cancelled while the cancellation never
     * reached the request, and every spec about it would pass.
     */
    abort(): void {
      if (this.settled) return;
      this.settled = true;
      this.emit(this.listeners, 'abort', {});
    }

    private settled = false;

    private emit(target: Record<string, Listener[]>, type: string, event: unknown): void {
      for (const callback of target[type] || []) callback(event);
    }
  }

  const mock: XhrMock = {
    on(method: string, urlPart: string, handler: XhrHandler) {
      routes.unshift({ method: method.toUpperCase(), urlPart, match: 'substring', handler });
      return mock;
    },
    onExact(method: string, url: string, handler: XhrHandler) {
      routes.unshift({ method: method.toUpperCase(), urlPart: pathOf(url), match: 'exact', handler });
      return mock;
    },
    calls: (method?: string) =>
      (method ? recorded.filter((c) => c.method === method.toUpperCase()) : recorded),
    unhandledRequests: () => unhandled,
    allowUnhandled: () => { unhandledAllowed = true; return mock; },
    assertNoUnhandledRequests: () => {
      if (unhandledAllowed || unhandled.length === 0) return;
      const lines = unhandled.map((c) => `  ${c.method} ${c.url}`).join('\n');
      throw new Error(
        `xhrMock: ${unhandled.length} upload(s) matched no handler:\n${lines}\n`
        + 'Each one threw inside send(), but the upload service caught it, so this spec '
        + 'would otherwise pass while a request it never set up went out. Register the '
        + 'route, or call xhr.allowUnhandled() when the refusal is what the test is about.',
      );
    },
    // Restores first, then asserts. An assertion thrown before the restore would
    // leak the fake into every later test in the file.
    restore: () => {
      (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = original;
      mock.assertNoUnhandledRequests();
    },
  };

  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  return mock;
}

/** Every value a `FormData` holds under one field, as the server would see them. */
export function formDataValues(body: unknown, field: string): FormDataEntryValue[] {
  if (!(body instanceof FormData)) {
    throw new Error(`Expected a FormData body, got ${Object.prototype.toString.call(body)}`);
  }
  return body.getAll(field);
}

/** The field names a `FormData` carries, in the order they were appended. */
export function formDataFieldOrder(body: unknown): string[] {
  if (!(body instanceof FormData)) {
    throw new Error(`Expected a FormData body, got ${Object.prototype.toString.call(body)}`);
  }
  return Array.from(body.keys());
}

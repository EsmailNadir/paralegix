/**
 * A fake at the TRANSPORT, so a component test can actually fail.
 *
 * THE PROBLEM THIS REPLACES
 * `tests/setup.ts` swaps every service module for a Proxy whose every method
 * resolves to `{}`, and forces `hasPermission: () => true`. Under that default a
 * component test cannot fail because a service returned the wrong shape, because
 * an endpoint answered 403, or because a permission was missing. It asserts only
 * that a component renders given fabricated data, which is why 390 frontend tests
 * passed while organization behaviour was broken.
 *
 * WHAT THIS DOES INSTEAD
 * Every service reaches the network through `apiFetch`, which calls the global
 * `fetch`. Faking THAT leaves the whole service layer real: url building, query
 * parameters, the auth header, response parsing, and `ApiError` handling all
 * execute. So a test fails when the component asks for the wrong url, sends the
 * wrong body, or mishandles an error.
 *
 * THE RULE THAT MAKES IT HONEST
 * An unmatched request THROWS, naming the method and url. It does not return an
 * empty object. A component that quietly asks for something the test never set up
 * is a component doing something the test does not know about, and that should be
 * loud.
 *
 * USAGE
 *   const api = installApiMock();
 *   api.get('/clients', { clients: [{ id: '1', name: 'Acme' }] });
 *   api.post('/clients', { status: 403, body: { error: 'Forbidden' } });
 *   render(<Thing />);
 *   expect(api.calls('GET')).toHaveLength(1);
 *
 * `get`/`post`/… retain suffix matching for compact legacy setup. Use
 * `getExact`/`postExact`/… for an authorization-, tenant-, or filter-sensitive
 * request: they match the complete pathname and every query parameter, while
 * treating query-parameter order as irrelevant.
 */

export interface MockResponse {
  status?: number;
  body?: unknown;
  /**
   * Raw response text, for a body that is not JSON: an HTML error page from a
   * proxy, a CSV export, a truncated payload. Wins over `body`, and makes
   * `json()` reject the way a real Response does rather than resolving `{}`.
   *
   * Requires an explicit `status`. Envelope detection keys on a numeric
   * `status` or a `body` key, and this app puts a `text` field on real data (a
   * note body, for one), so a bare `{ text: ... }` is read as DATA on purpose.
   */
  text?: string;
  /**
   * Extra response headers. `content-type` may be overridden here; it defaults
   * to `application/json`. Requires an explicit `status`, for the same reason
   * as `text`.
   */
  headers?: Record<string, string>;
  /** Delay in ms, for asserting a loading state. */
  delayMs?: number;
}

export interface RecordedCall {
  method: string;
  url: string;
  pathname: string;
  search: string;
  /** Query values grouped by key, preserving repeated values. */
  query: Record<string, string[]>;
  body: unknown;
  headers: Record<string, string>;
  /** The fetch `credentials` mode, when the caller set one. */
  credentials?: string;
}

/**
 * Any JSON value a route can answer with, when the spec just wants a body.
 *
 * The object case is `object`, not `Record<string, unknown>`. A spec that builds
 * its response from a real domain type (`function report(): TrustAuditReport`)
 * hands over an INTERFACE, and an interface has no implicit index signature, so
 * it does not satisfy `Record<string, unknown>` however plain its fields are.
 * That mismatch type-checks fine under Jest, which runs with `isolatedModules`,
 * and then fails `next build`, which type-checks the `tests/` tree. Typing the
 * response after the API's own type is the behaviour worth encouraging, so the
 * parameter widens rather than the specs casting.
 */
type JsonBody = object | string | number | boolean | null;

/**
 * What a spec may hand a route.
 *
 * Three shapes, in the order a spec reaches for them: a plain BODY
 * (`{ contacts: [...] }`), a full ENVELOPE when the status matters
 * (`{ status: 403, body: {...} }`), or a FUNCTION for a response that depends on
 * the request.
 *
 * The plain-body arm is not optional decoration. Leaving it out typed the
 * parameter as envelope-or-function only, so every ordinary
 * `api.get('/contacts', { contacts: [] })` was a type error. Jest never saw it,
 * because ts-jest runs with `isolatedModules`, but `next build` type-checks the
 * `tests/` tree and the Vercel build failed on it.
 */
type Handler =
  | MockResponse
  | JsonBody
  | ((call: RecordedCall) => MockResponse | unknown | Promise<MockResponse | unknown>);

interface Route {
  method: string;
  path: string;
  match: 'suffix' | 'exact';
  handler: Handler;
}

export interface ApiMock {
  get(pathSuffix: string, handler: Handler): ApiMock;
  post(pathSuffix: string, handler: Handler): ApiMock;
  put(pathSuffix: string, handler: Handler): ApiMock;
  patch(pathSuffix: string, handler: Handler): ApiMock;
  delete(pathSuffix: string, handler: Handler): ApiMock;
  getExact(path: string, handler: Handler): ApiMock;
  postExact(path: string, handler: Handler): ApiMock;
  putExact(path: string, handler: Handler): ApiMock;
  patchExact(path: string, handler: Handler): ApiMock;
  deleteExact(path: string, handler: Handler): ApiMock;
  /** Every recorded call, optionally filtered by method. */
  calls(method?: string): RecordedCall[];
  /** Calls whose pathname ends with the given suffix. */
  callsTo(pathSuffix: string): RecordedCall[];
  /**
   * Requests that matched no route.
   *
   * The throw at the transport is not enough on its own. A service that catches
   * its own fetch error, or a component that renders an error state, swallows
   * the rejection, and then the spec stays green while a request it never set up
   * went out. That is the same blindness this file exists to remove, one layer
   * further up.
   */
  unhandledRequests(): RecordedCall[];
  /**
   * Accept unmatched requests in this spec, for a test whose subject IS the
   * refusal. Without it, `restore()` fails the test.
   */
  allowUnhandled(): ApiMock;
  /** Throw if any request went unmatched. `restore()` calls this. */
  assertNoUnhandledRequests(): void;
  reset(): void;
  restore(): void;
}

/**
 * Decide whether a handler's value is a response ENVELOPE or a plain body.
 *
 * `status` must be a NUMBER to count. Testing only for the KEY misread any body
 * carrying a `status` field as an envelope, and this app puts one on almost
 * everything: a client is `status: 'active'`, a matter `status: 'closed'`, a
 * task `status: 'open'`. So `api.get('/clients', { id: '1', status: 'active' })`
 * built a Response with an HTTP status of the string "active" and an empty body,
 * and the spec failed somewhere unrelated with no hint of why.
 */
/**
 * Flatten whatever shape the caller passed as headers into a plain object.
 *
 * `apiFetch` builds a real `Headers` instance (`prepareApiFetchOptions`), and
 * casting one straight to `Record<string, string>` yields `{}` because its
 * entries live behind an iterator rather than on own properties. Every header
 * assertion therefore saw an empty object and could only ever pass by asserting
 * absence, which is how the Authorization and X-Timezone headers went untested.
 *
 * Keys are lower-cased, because a `Headers` instance normalises them and a plain
 * object does not, so a spec would otherwise have to guess the casing.
 */
function normaliseHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (typeof (raw as Headers).forEach === 'function' && typeof (raw as Headers).get === 'function') {
    (raw as Headers).forEach((value, key) => { out[key.toLowerCase()] = value; });
    return out;
  }
  if (Array.isArray(raw)) {
    for (const [key, value] of raw as Array<[string, string]>) out[String(key).toLowerCase()] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

function toResponse(result: MockResponse | unknown): MockResponse {
  if (!result || typeof result !== 'object') return { status: 200, body: result };
  const candidate = result as Record<string, unknown>;
  // `delayMs` counts too. It is a MockResponse field with no counterpart in this
  // app's data, and without it `{ clients: [], delayMs: 200 }` was read as DATA:
  // the delay silently did nothing and the spec asserting a loading state, or a
  // timeout, passed against an instant response.
  //
  // `text` and `headers` deliberately do NOT count. Records here carry a `text`
  // field (a note body), so promoting a bare `{ text: ... }` to an envelope
  // would swallow real data, which is the same trap the `status: 'active'` rule
  // above guards against. Pass an explicit `status` to use them.
  const looksLikeEnvelope = typeof candidate.status === 'number'
    || 'body' in candidate
    || 'delayMs' in candidate;
  return looksLikeEnvelope ? (candidate as MockResponse) : { status: 200, body: result };
}

interface ParsedTarget {
  pathname: string;
  search: string;
  query: Record<string, string[]>;
  /** Path plus a canonically ordered query string, for exact matching. */
  exactTarget: string;
}

/**
 * Parse the request target once so recorded calls and exact routes agree about
 * repeated query keys and parameter ordering. A tenant-sensitive test should
 * not pass merely because another firm reaches the same path suffix.
 */
function parseTarget(url: string): ParsedTarget {
  try {
    const parsed = new URL(url, 'http://localhost');
    const query: Record<string, string[]> = {};
    const entries = Array.from(parsed.searchParams.entries());
    for (const [key, value] of entries) (query[key] ||= []).push(value);
    entries.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    const canonicalQuery = new URLSearchParams(entries).toString();
    return {
      pathname: parsed.pathname,
      search: parsed.search,
      query,
      exactTarget: canonicalQuery ? `${parsed.pathname}?${canonicalQuery}` : parsed.pathname,
    };
  } catch {
    // Preserve a malformed target as written so a test sees an unmatched
    // request instead of silently matching a different valid path.
    return { pathname: url, search: '', query: {}, exactTarget: url };
  }
}

/**
 * The rejection a real `fetch` produces for an aborted request.
 *
 * `fetchWithDeadline` branches on `armed.didTimeOut()` first and rethrows a
 * caller abort untouched, so what matters is that this REJECTS, promptly, with
 * an error the transport does not mistake for a network failure.
 */
function abortError(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Settle when the response is ready, or reject as soon as the signal aborts,
 * whichever happens first.
 *
 * Without this a spec can only test a request that completes. The deadline in
 * `requestTimeout.ts` fires a real `setTimeout` and aborts its own controller,
 * so a handler that simply takes longer than the budget now produces the
 * timeout error the application actually renders.
 */
function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Answer a sequence of responses to repeated calls of the same route.
 *
 * A function rather than an extra `once`/`times` method, and not a bare array,
 * because an array is itself a valid JSON body: a list endpoint answering
 * `[{...}]` and a two-step sequence would be indistinguishable.
 *
 * The LAST response repeats once the sequence runs out, so a spec states only
 * the steps it cares about. The counter lives in this closure, so a new
 * `sequence()` per test resets itself and no state leaks between cases.
 *
 *   api.getExact(url, sequence(
 *     { status: 401, body: { code: 'TOKEN_EXPIRED' } },
 *     { clients: [] },
 *   ));
 */
export function sequence(...responses: Handler[]): Handler {
  let index = 0;
  return (call) => {
    const step = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return typeof step === 'function' ? step(call) : step;
  };
}

export function installApiMock(): ApiMock {
  const routes: Route[] = [];
  const recorded: RecordedCall[] = [];
  const unhandled: RecordedCall[] = [];
  let unhandledAllowed = false;
  const original = global.fetch;

  const register = (method: string, match: Route['match']) => (path: string, handler: Handler) => {
    // Unshifted, so a later registration WINS over an earlier one for the same
    // path. That lets a test override a shared beforeEach handler for one case
    // without unpicking the setup.
    routes.unshift({ method, path: match === 'exact' ? parseTarget(path).exactTarget : path, match, handler });
    return mock;
  };

  const fakeFetch = async (input: unknown, init: Record<string, any> = {}) => {
    const requestInput = input && typeof input === 'object'
      ? input as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown; signal?: unknown }
      : undefined;
    const url = typeof input === 'string' ? input : String(requestInput?.url ?? input);
    // Match native fetch precedence: an explicit `init` overrides a Request;
    // otherwise the Request carries its own method, headers, and body.
    const method = String(init.method ?? requestInput?.method ?? 'GET').toUpperCase();
    const headers = init.headers ?? requestInput?.headers;
    const body = init.body ?? requestInput?.body;
    // Honoured rather than dropped. `fetchWithDeadline` arms a timeout, passes
    // ITS signal here, and then reads three different outcomes off the
    // rejection: its own deadline becomes a timeout ApiError, a caller abort is
    // rethrown untouched so React Query still treats it as a cancellation, and
    // a transport failure becomes an unreachable ApiError. A fake that ignores
    // the signal reaches none of those branches, so a timed-out request is
    // indistinguishable from a valid empty response.
    const signal = (init.signal ?? requestInput?.signal) as AbortSignal | undefined;
    const target = parseTarget(url);

    // A real fetch given an already-aborted signal never reaches the network, so
    // the request must not be recorded either. Recording it would show a spec a
    // call the application did not actually make.
    if (signal?.aborted) throw abortError();

    let parsedBody: unknown = null;
    if (typeof body === 'string') {
      try { parsedBody = JSON.parse(body); } catch { parsedBody = body; }
    } else if (body) {
      parsedBody = body;
    }

    const call: RecordedCall = {
      method,
      url,
      pathname: target.pathname,
      search: target.search,
      query: target.query,
      body: parsedBody,
      headers: normaliseHeaders(headers),
      ...(init.credentials ? { credentials: String(init.credentials) } : {}),
    };
    recorded.push(call);

    const route = routes.find((r) => r.method === method
      && (r.match === 'suffix'
        ? target.pathname.endsWith(r.path)
        : target.exactTarget === r.path));
    if (!route) {
      // Loud on purpose. Returning an empty body here would recreate exactly the
      // problem this file exists to fix.
      //
      // Recorded as well as thrown: the throw only reaches whoever awaits this
      // promise, and a caller that catches it turns a real mismatch back into a
      // green test. `restore()` reads this list.
      unhandled.push(call);
      throw new Error(
        `apiMock: no handler for ${method} ${target.pathname}${target.search}\n`
        + `Registered: ${routes.map((r) => `${r.method} ${r.match === 'exact' ? 'exact ' : ''}${r.path}`).join(', ') || '(none)'}\n`
        + 'Add one with api.get(...) / api.getExact(...), or assert the component should not call it.',
      );
    }

    const resolved = await raceAbort(
      Promise.resolve(typeof route.handler === 'function' ? route.handler(call) : route.handler)
        .then(async (handlerResult) => {
          const response = toResponse(handlerResult);
          if (response.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, response.delayMs));
          }
          return response;
        }),
      signal,
    );

    const status = resolved.status ?? 200;
    // `'body' in resolved` rather than `resolved.body ?? {}`. The old form
    // erased a deliberate null into `{}`, so a spec could not tell an endpoint
    // that answers `null` from one that answers an empty object, and a 204
    // still carried a body.
    // 204 and 205 are defined as having no body at all, so `json()` on one must
    // reject rather than resolve `{}`. A service that reads a body off a 204 is
    // making an assumption the server does not honour.
    const emptyByStatus = status === 204 || status === 205;
    const payload = emptyByStatus
      ? ''
      : (typeof resolved.text === 'string'
        ? resolved.text
        : ('body' in resolved ? JSON.stringify(resolved.body) : JSON.stringify({})));
    const responseHeaders = new Headers({ 'content-type': 'application/json', ...(resolved.headers ?? {}) });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: responseHeaders,
      // Rejects on malformed text, exactly as a real Response does. Parsing
      // through a stringify round trip could only ever produce valid JSON, so
      // the branch a service takes when a proxy returns HTML was unreachable.
      json: async () => JSON.parse(payload === undefined ? 'null' : payload),
      text: async () => (payload === undefined ? '' : payload),
      // Binary reads are part of the transport too: the zip download paths in
      // `files.service` call `response.blob()` and hand the result to
      // `createObjectURL`, so without this the only reachable assertion about a
      // download would be its failure path.
      blob: async () => new Blob([payload ?? ''], { type: responseHeaders.get('content-type') ?? 'application/json' }),
      // The overlay editor reads its source PDF as bytes and hands them to
      // pdf.js, so a spec that renders it needs the bytes path to resolve.
      arrayBuffer: async () => new TextEncoder().encode(payload ?? '').buffer,
      clone() { return this; },
    } as unknown as Response;
  };

  const mock: ApiMock = {
    get: register('GET', 'suffix'),
    post: register('POST', 'suffix'),
    put: register('PUT', 'suffix'),
    patch: register('PATCH', 'suffix'),
    delete: register('DELETE', 'suffix'),
    getExact: register('GET', 'exact'),
    postExact: register('POST', 'exact'),
    putExact: register('PUT', 'exact'),
    patchExact: register('PATCH', 'exact'),
    deleteExact: register('DELETE', 'exact'),
    calls: (method?: string) =>
      (method ? recorded.filter((c) => c.method === method.toUpperCase()) : recorded),
    callsTo: (pathSuffix: string) => recorded.filter((c) => c.pathname.endsWith(pathSuffix)),
    unhandledRequests: () => unhandled,
    allowUnhandled: () => { unhandledAllowed = true; return mock; },
    assertNoUnhandledRequests: () => {
      if (unhandledAllowed || unhandled.length === 0) return;
      const lines = unhandled.map((c) => `  ${c.method} ${c.pathname}${c.search}`).join('\n');
      throw new Error(
        `apiMock: ${unhandled.length} request(s) matched no handler:\n${lines}\n`
        + 'Each one threw at the transport, but something caught it, so this spec would '
        + 'otherwise pass while a request it never set up went out. Register the route, '
        + 'assert the caller should not send it, or call api.allowUnhandled() when the '
        + 'refusal is what the test is about.',
      );
    },
    reset: () => {
      routes.length = 0;
      recorded.length = 0;
      unhandled.length = 0;
      unhandledAllowed = false;
    },
    // Restores first, then asserts. An assertion thrown before the restore would
    // leak the fake `fetch` into every later test in the file.
    restore: () => {
      global.fetch = original;
      mock.assertNoUnhandledRequests();
    },
  };

  global.fetch = fakeFetch as unknown as typeof fetch;
  return mock;
}

/**
 * Install a fresh `installApiMock()` before each test in the calling file and
 * restore it after, returning a handle that always points at the current one.
 *
 * Call it once at the top level of a file (or a `describe`) in place of the
 * hand-written `let api; beforeEach(install); afterEach(restore)` block. The
 * handle forwards every property to the mock installed for the running test,
 * so `api.get(...)` and `api.calls()` read exactly as they did against a local
 * variable. Touching it outside a test throws, rather than answering from a
 * mock that is no longer installed.
 *
 * Not named `use...`: `react-hooks/rules-of-hooks` rejects a `use` call at the
 * top level of a test file.
 */
export function setupApiMock(): ApiMock {
  let current: ApiMock | null = null;

  beforeEach(() => {
    current = installApiMock();
  });

  afterEach(() => {
    const installed = current;
    current = null;
    installed?.restore();
  });

  return new Proxy({} as ApiMock, {
    get(_target, key) {
      if (!current) {
        throw new Error(`apiMock: \`${String(key)}\` was read outside a test; setupApiMock() installs the mock per test.`);
      }
      return current[key as keyof ApiMock];
    },
  });
}

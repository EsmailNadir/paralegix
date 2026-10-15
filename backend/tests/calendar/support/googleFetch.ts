/**
 * The network wall for the Google calendar specs.
 *
 * `google.service.ts` holds no third-party SDK. Every Google request it makes
 * goes through `makeGoogleApiCall` in `calendar/shared/calendarHelpers.ts`, and
 * every token refresh goes through `refreshGoogleToken` in the same file. Both
 * call the GLOBAL `fetch` directly, so `globalThis.fetch` is the single
 * chokepoint: replace it and no code path in this module can reach the wire.
 *
 * That matters more than usual here. `tests/support/db.ts` loads `backend/.env`
 * before anything else, so a developer machine has real `GOOGLE_CLIENT_ID` and
 * `GOOGLE_CLIENT_SECRET` in `process.env` while these specs run. An unmocked
 * refresh would post real credentials to `https://oauth2.googleapis.com/token`.
 *
 * The fake is installed at MODULE LOAD (see `installGoogleFetchWall` below,
 * which each spec calls at import time) rather than in a `beforeAll`, so there
 * is no window in which a stray import-time request could escape.
 *
 * UNROUTED REQUESTS THROW. A url no test has registered is recorded and then
 * rejected with `BLOCKED_NETWORK_CALL`, so a code path that reaches for an
 * endpoint the test did not anticipate fails loudly instead of quietly
 * succeeding against the real API. Each spec opens with a case that proves this
 * wall is up; without that proof every later "no call was made" assertion would
 * be worthless.
 */

export interface GoogleCall {
  method: string;
  url: string;
  /** Parsed JSON body when the request carried one, else the raw string, else null. */
  body: any;
  /** The bearer token the caller presented, without the `Bearer ` prefix. */
  bearer: string | null;
}

/** What a route answers with. `json` wins over `text` when both are given. */
export interface ResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
}

/**
 * A function responder may return a promise, which holds the request open until
 * it settles. That is how a case pins a provider call mid-flight.
 */
type Responder = ResponseSpec | ResponseSpec[]
  | ((call: GoogleCall, hit: number) => ResponseSpec | Promise<ResponseSpec>);

interface Route {
  match: string | RegExp;
  method?: string;
  responder: Responder;
  hits: number;
}

const calls: GoogleCall[] = [];
const routes: Route[] = [];

/** Marker every blocked request carries, asserted on by each spec's wall case. */
export const BLOCKED = 'BLOCKED_NETWORK_CALL';

let installed = false;
let realFetch: typeof globalThis.fetch | null = null;

function matches(route: Route, call: GoogleCall) {
  if (route.method && route.method.toUpperCase() !== call.method) return false;
  return typeof route.match === 'string'
    ? call.url.includes(route.match)
    : route.match.test(call.url);
}

function toResponse(spec: ResponseSpec) {
  const status = spec.status ?? 200;
  if (spec.json !== undefined) {
    return new Response(JSON.stringify(spec.json), {
      status,
      headers: { 'content-type': 'application/json', ...spec.headers },
    });
  }
  // A body of `null` with 204 is the only status Response refuses a body for.
  return new Response(status === 204 ? null : (spec.text ?? ''), { status, headers: spec.headers });
}

/**
 * Replace `globalThis.fetch` for the whole spec file. Idempotent, so importing
 * this module from two specs in one worker is safe.
 */
export function installGoogleFetchWall() {
  if (installed) return;
  installed = true;
  realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const headers = (init.headers || {}) as Record<string, string>;
    const auth = headers.Authorization || headers.authorization || null;
    let body: any = init.body ?? null;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* form-encoded or empty; keep the string */ }
    } else if (body && typeof body.toString === 'function' && body instanceof URLSearchParams) {
      body = Object.fromEntries(body.entries());
    }

    const call: GoogleCall = {
      method: String(init.method || 'GET').toUpperCase(),
      url,
      body,
      bearer: auth ? String(auth).replace(/^Bearer\s+/i, '') : null,
    };
    calls.push(call);

    const route = routes.find((r) => matches(r, call));
    if (!route) {
      throw new Error(`${BLOCKED}: ${call.method} ${url}`);
    }

    const hit = route.hits;
    route.hits += 1;
    const spec = typeof route.responder === 'function'
      ? route.responder(call, hit)
      : Array.isArray(route.responder)
        ? route.responder[Math.min(hit, route.responder.length - 1)]
        : route.responder;
    return toResponse(await spec);
  }) as typeof globalThis.fetch;
}

/** Put the process back the way it was. Called from each spec's `afterAll`. */
export function uninstallGoogleFetchWall() {
  if (!installed) return;
  installed = false;
  if (realFetch) globalThis.fetch = realFetch;
}

/** True only while the fake is the live `globalThis.fetch`. */
export function wallIsUp() {
  return installed && globalThis.fetch !== realFetch;
}

/**
 * Register a canned answer. Routes are consulted in registration order, so a
 * narrow route added first wins over a broader one added later.
 *
 * An array responder answers the first call with element 0, the second with
 * element 1, and every call past the end with the last element. That is how the
 * 401-then-refresh-then-retry sequence is expressed against one url.
 */
export function route(match: string | RegExp, responder: Responder, opts: { method?: string } = {}) {
  routes.push({ match, responder, method: opts.method, hits: 0 });
}

/** Every request the code under test attempted, routed or blocked, in order. */
export function googleCalls() {
  return calls.slice();
}

/** The attempted requests whose url contains `fragment`. */
export function callsMatching(fragment: string | RegExp) {
  return calls.filter((c) => (typeof fragment === 'string' ? c.url.includes(fragment) : fragment.test(c.url)));
}

/** Drop routes and recorded calls. Belongs in `beforeEach`, not `afterEach`. */
export function resetGoogleFetch() {
  calls.length = 0;
  routes.length = 0;
}

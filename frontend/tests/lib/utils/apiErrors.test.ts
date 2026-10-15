/**
 * The error layer every service call funnels through. 42% branch coverage
 * before this file, and no spec of its own.
 *
 * `getErrorMessage` is a long ordered if-chain, and the order is the contract:
 * a 402 must read as "subscription inactive" rather than the generic 500 copy,
 * and a 403 must read as "ask an admin" rather than "contact support with error
 * ID". Reordering two clauses changes what a user is told to do about a failure
 * they cannot otherwise diagnose, and no other test in the suite would notice.
 *
 * `getFieldErrors` is the other half: it decides which backend `details` blobs
 * are safe to render next to a form field. It deliberately renders NONE unless
 * the code is VALIDATION_ERROR, because other errors put machine data there
 * (PLAN_LIMIT_REACHED ships `{ resource, limit, planId }`) and printing that
 * under an input is a leak of internals dressed up as advice.
 */
import {
  ApiError,
  isApiError,
  isForbiddenError,
  readErrorBody,
  toApiError,
  getFieldErrors,
  getErrorMessage,
  API_UNREACHABLE_MESSAGE,
  REQUEST_TIMEOUT_MESSAGE,
  BILLING_INACTIVE_MESSAGE,
  BILLING_INACTIVE_CODE,
  NETWORK_UNREACHABLE_CODE,
  REQUEST_TIMEOUT_CODE,
  RATE_LIMITED_CODE,
  MAINTENANCE_MODE_CODE,
} from '@/lib/utils/apiErrors';

/**
 * A stand-in for `Response`. Only `.status`, `.headers.get` and `.clone()` are
 * reached, and building a real one would drag whatwg-fetch into a jsdom env
 * that does not need it. `json` throws by default so the text fallback in
 * `readErrorBody` is exercised unless a spec opts into a JSON body.
 */
function fakeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  json?: () => unknown;
  text?: () => string;
}): Response {
  const headers = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const res = {
    status: opts.status ?? 500,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    clone: () => res,
    json: async () => {
      if (!opts.json) throw new SyntaxError('Unexpected token');
      return opts.json();
    },
    text: async () => {
      if (!opts.text) throw new TypeError('body already read');
      return opts.text();
    },
  };
  return res as unknown as Response;
}

describe('ApiError classification getters', () => {
  it('classifies maintenance mode by code only, never by a bare 503', () => {
    // The backend's maintenance middleware always answers with the code. A 503
    // without it is a busy worker or the platform shedding load, and telling
    // that user the whole app is in maintenance sends them away for no reason.
    expect(new ApiError('x', { status: 503 }).isMaintenanceMode).toBe(false);
    expect(new ApiError('x', { status: 503, code: 'TEMPLATE_FILL_BUSY' }).isMaintenanceMode).toBe(false);
    expect(new ApiError('x', { code: MAINTENANCE_MODE_CODE }).isMaintenanceMode).toBe(true);
    expect(new ApiError('x', { status: 500 }).isMaintenanceMode).toBe(false);
  });

  it('classifies a timeout by code only, never by status', () => {
    // Deliberate: the request reached the backend, which may still be working
    // on it, so a timed-out write cannot be assumed not to have landed. A
    // status-based check would sweep in server-side 408s that mean the opposite.
    expect(new ApiError('x', { code: REQUEST_TIMEOUT_CODE }).isTimeout).toBe(true);
    expect(new ApiError('x', { status: 408 }).isTimeout).toBe(false);
  });

  it('classifies an inactive subscription by 402 OR by code', () => {
    expect(new ApiError('x', { status: 402 }).isBillingInactive).toBe(true);
    expect(new ApiError('x', { code: BILLING_INACTIVE_CODE }).isBillingInactive).toBe(true);
    expect(new ApiError('x', { status: 403 }).isBillingInactive).toBe(false);
  });

  it('classifies rate limiting by 429 OR by code', () => {
    expect(new ApiError('x', { status: 429 }).isRateLimited).toBe(true);
    expect(new ApiError('x', { code: RATE_LIMITED_CODE }).isRateLimited).toBe(true);
    expect(new ApiError('x', { status: 400 }).isRateLimited).toBe(false);
  });

  it('classifies a refusal of access by 403 OR by code', () => {
    // Load-bearing for the read-only degradation rule: a forbidden READ becomes
    // a locked empty state, not an error banner.
    expect(new ApiError('x', { status: 403 }).isForbidden).toBe(true);
    expect(new ApiError('x', { code: 'FORBIDDEN' }).isForbidden).toBe(true);
    expect(new ApiError('x', { status: 401 }).isForbidden).toBe(false);
  });

  it('keeps the Error identity so instanceof and .message still work', () => {
    const err = new ApiError('boom', { status: 500 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect(err.message).toBe('boom');
  });
});

describe('isApiError / isForbiddenError', () => {
  it('rejects a plain Error and a bare object', () => {
    expect(isApiError(new Error('x'))).toBe(false);
    expect(isApiError({ status: 403 })).toBe(false);
    expect(isApiError(null)).toBe(false);
  });

  it('reports forbidden only for an ApiError that is actually forbidden', () => {
    // A plain Error carrying the text "403" must not be treated as a refusal,
    // or an unrelated crash would silently render as a locked empty state.
    expect(isForbiddenError(new ApiError('x', { status: 403 }))).toBe(true);
    expect(isForbiddenError(new ApiError('x', { status: 500 }))).toBe(false);
    expect(isForbiddenError(new Error('403 Forbidden'))).toBe(false);
  });
});

describe('ApiError.fromResponse', () => {
  it('prefers the body `error` field over `message`, fallback, and default', () => {
    const err = ApiError.fromResponse(
      fakeResponse({ status: 400 }),
      { error: 'from error', message: 'from message' },
      'from fallback',
    );
    expect(err.message).toBe('from error');
  });

  it('falls back through message, then the caller fallback, then the default', () => {
    expect(ApiError.fromResponse(fakeResponse({ status: 400 }), { message: 'm' }, 'f').message).toBe('m');
    expect(ApiError.fromResponse(fakeResponse({ status: 400 }), {}, 'f').message).toBe('f');
    expect(ApiError.fromResponse(fakeResponse({ status: 400 }), {}).message).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('uses the gone default for a 410 with no body copy', () => {
    expect(ApiError.fromResponse(fakeResponse({ status: 410 }), {}).message).toMatch(
      /no longer available/,
    );
  });

  it('does not use the maintenance default for a 503 with no body copy and no code', () => {
    expect(ApiError.fromResponse(fakeResponse({ status: 503 }), {}).message).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('uses the maintenance default for a MAINTENANCE_MODE answer with no body copy', () => {
    expect(
      ApiError.fromResponse(fakeResponse({ status: 503 }), { code: MAINTENANCE_MODE_CODE }).message,
    ).toMatch(/maintenance mode/);
  });

  it('reads Retry-After off a 503, so a busy answer can be retried on the server\'s schedule', () => {
    const err = ApiError.fromResponse(
      fakeResponse({ status: 503, headers: { 'Retry-After': '7' } }),
      { code: 'CONVERSION_BUSY' },
    );
    expect(err.retryAfterSeconds).toBe(7);
  });

  it('does not read RateLimit-Reset off a 503, which describes the rate window, not the backlog', () => {
    const err = ApiError.fromResponse(
      fakeResponse({ status: 503, headers: { 'RateLimit-Reset': '900' } }),
      { code: 'CONVERSION_BUSY' },
    );
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it('ignores a non-object body instead of throwing', () => {
    // The backend scrubs some responses to a bare string or null. Reading
    // `.code` off that would crash the error handler itself.
    const err = ApiError.fromResponse(fakeResponse({ status: 500 }), 'plain text', 'fb');
    expect(err.message).toBe('fb');
    expect(err.code).toBeUndefined();
  });

  it('ignores body fields of the wrong type', () => {
    // A numeric `code` must not become the string "42" and start matching
    // classification checks by accident.
    const err = ApiError.fromResponse(fakeResponse({ status: 500 }), { code: 42, error: null }, 'fb');
    expect(err.code).toBeUndefined();
    expect(err.message).toBe('fb');
  });

  it('prefers the body requestId over the x-request-id header', () => {
    const err = ApiError.fromResponse(
      fakeResponse({ status: 500, headers: { 'x-request-id': 'from-header' } }),
      { requestId: 'from-body' },
    );
    expect(err.requestId).toBe('from-body');
  });

  it('falls back to the x-request-id header when the body carries none', () => {
    // This is the id a user quotes to support, so losing it costs a support
    // ticket its only thread back to a log line.
    const err = ApiError.fromResponse(
      fakeResponse({ status: 500, headers: { 'x-request-id': 'req-9' } }),
      {},
    );
    expect(err.requestId).toBe('req-9');
  });

  it('records the request url and method for later reporting', () => {
    const err = ApiError.fromResponse(fakeResponse({ status: 500 }), {}, undefined, {
      url: '/api/matters',
      method: 'POST',
    });
    expect(err.requestUrl).toBe('/api/matters');
    expect(err.requestMethod).toBe('POST');
  });

  it('carries structured details through', () => {
    const err = ApiError.fromResponse(fakeResponse({ status: 400 }), {
      details: { a: 1 },
    });
    expect(err.details).toEqual({ a: 1 });
  });
});

describe('ApiError.fromResponse retry-after parsing', () => {
  const at429 = (headers: Record<string, string>) =>
    ApiError.fromResponse(fakeResponse({ status: 429, headers }), {}).retryAfterSeconds;

  it('reads Retry-After as delta-seconds', () => {
    expect(at429({ 'Retry-After': '30' })).toBe(30);
  });

  it('rounds a fractional delta up so the countdown never under-promises', () => {
    // Telling a user to wait 4 seconds when the server wants 4.2 sends them
    // straight into a second 429.
    expect(at429({ 'Retry-After': '4.2' })).toBe(5);
  });

  it('accepts a zero delta', () => {
    // 0 is falsy; a truthiness check on the parsed number would discard it and
    // fall through to the RateLimit-Reset branch.
    expect(at429({ 'Retry-After': '0' })).toBe(0);
  });

  it('parses an HTTP-date Retry-After into seconds from now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    expect(at429({ 'Retry-After': 'Thu, 01 Jan 2026 00:00:45 GMT' })).toBe(45);
    jest.restoreAllMocks();
  });

  it('clamps an HTTP-date already in the past to zero', () => {
    const now = Date.parse('2026-01-01T00:01:00Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    expect(at429({ 'Retry-After': 'Thu, 01 Jan 2026 00:00:00 GMT' })).toBe(0);
    jest.restoreAllMocks();
  });

  it('falls back to RateLimit-Reset when Retry-After is absent', () => {
    expect(at429({ 'RateLimit-Reset': '12' })).toBe(12);
  });

  it('returns undefined when neither header is readable', () => {
    // The common production case: the header exists but is not CORS-exposed.
    // Undefined lets the caller degrade to generic copy instead of rendering
    // "wait NaN seconds".
    expect(at429({})).toBeUndefined();
  });

  it('returns undefined for an unparseable Retry-After', () => {
    expect(at429({ 'Retry-After': 'soon' })).toBeUndefined();
  });

  it('returns undefined for a negative Retry-After rather than falling through to the date branch', () => {
    // "-5" is a number, just not a usable one. Letting it reach the HTTP-date
    // branch is what produced a countdown at all: Date.parse("-5") happens to
    // succeed, and the result clamps to 0. A value that parsed as a number has
    // already been judged; it must not get a second reading as a date.
    expect(at429({ 'Retry-After': '-5' })).toBeUndefined();
  });

  it('still falls back to RateLimit-Reset when Retry-After is a negative number', () => {
    // Rejecting the bad header must not also discard the good one.
    expect(at429({ 'Retry-After': '-5', 'RateLimit-Reset': '12' })).toBe(12);
  });

  it('does not read retry headers for a non-429 status', () => {
    // A 500 that happens to carry a proxy's Retry-After must not render as a
    // rate-limit countdown.
    const err = ApiError.fromResponse(
      fakeResponse({ status: 500, headers: { 'Retry-After': '30' } }),
      {},
    );
    expect(err.retryAfterSeconds).toBeUndefined();
  });
});

describe('readErrorBody / toApiError', () => {
  it('returns the parsed JSON body when the response is JSON', async () => {
    const body = await readErrorBody(fakeResponse({ status: 400, json: () => ({ error: 'nope' }) }));
    expect(body).toEqual({ error: 'nope' });
  });

  it('wraps a non-JSON body as { error: text }', async () => {
    // An HTML error page from a proxy. Without this the user sees the generic
    // default and the actual gateway message is lost.
    const body = await readErrorBody(fakeResponse({ status: 502, text: () => 'Bad Gateway' }));
    expect(body).toEqual({ error: 'Bad Gateway' });
  });

  it('returns an empty object for an empty body', async () => {
    expect(await readErrorBody(fakeResponse({ status: 204, text: () => '' }))).toEqual({});
  });

  it('returns an empty object when both json() and text() throw', async () => {
    // The error reader must never itself throw, or the real failure is replaced
    // by an unhandled rejection with no context at all.
    expect(await readErrorBody(fakeResponse({ status: 500 }))).toEqual({});
  });

  it('toApiError builds the ApiError from the read body', async () => {
    const err = await toApiError(
      fakeResponse({ status: 422, json: () => ({ error: 'bad name', code: 'VALIDATION_ERROR' }) }),
      'fallback',
      { url: '/x', method: 'PUT' },
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('bad name');
    expect(err.requestMethod).toBe('PUT');
  });
});

describe('getFieldErrors', () => {
  const validation = (details: unknown) =>
    getFieldErrors(new ApiError('bad', { code: 'VALIDATION_ERROR', details }));

  it('returns nothing for a non-ApiError or an ApiError with no details', () => {
    expect(getFieldErrors(new Error('x'))).toEqual([]);
    expect(getFieldErrors(new ApiError('x', { code: 'VALIDATION_ERROR' }))).toEqual([]);
  });

  it('returns nothing when the code is not VALIDATION_ERROR', () => {
    // The case this exists for: PLAN_LIMIT_REACHED ships
    // { resource, limit, planId }. Rendering those values under a form field
    // shows the user internal plan keys and a bare number as if they were
    // validation advice.
    const err = new ApiError('limit', {
      code: 'PLAN_LIMIT_REACHED',
      details: { resource: 'maxMatters', limit: 25, planId: 'plan_pro' },
    });
    expect(getFieldErrors(err)).toEqual([]);
  });

  it.each([
    ['reads a plain string detail', 'Name is required', ['Name is required']],
    ['ignores a whitespace-only string detail', '   ', []],
    [
      'reads a Zod flatten() result from both formErrors and fieldErrors',
      { formErrors: ['Form is invalid'], fieldErrors: { email: ['Not an email'], name: ['Too short', 'Too plain'] } },
      ['Form is invalid', 'Not an email', 'Too short', 'Too plain'],
    ],
    ['reads an ad-hoc field map of arrays', { email: ['Not an email'] }, ['Not an email']],
    ['reads an ad-hoc field map of bare strings', { dependency: 'Matter must be closed first' }, ['Matter must be closed first']],
    ['drops non-string entries rather than rendering "[object Object]"', { a: 1, b: null, c: { nested: 'x' }, d: 'kept' }, ['kept']],
    // Without fieldErrors present, formErrors is pushed once explicitly and
    // again by the Object.values sweep over the same object.
    ['de-duplicates repeated messages', { formErrors: ['Same'], other: 'Same' }, ['Same']],
    ['returns nothing for a numeric details value', 42, []],
    ['reads an array details value as a list of messages', ['a'], ['a']],
  ] as Array<[string, unknown, string[]]>)('%s', (_label, details, expected) => {
    expect(validation(details)).toEqual(expected);
  });

  it('caps the list at six messages', () => {
    // A form with thirty invalid fields must not push an unbounded wall of text
    // into the UI.
    const fieldErrors = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`f${i}`, [`msg ${i}`]]),
    );
    expect(validation({ fieldErrors })).toHaveLength(6);
  });
});

describe('getErrorMessage', () => {
  it('returns a non-empty string argument as-is, and the fallback for an empty one', () => {
    expect(getErrorMessage('Already readable')).toBe('Already readable');
    expect(getErrorMessage('', 'fb')).toBe('fb');
  });

  it('returns the fallback for a value that is not an Error', () => {
    expect(getErrorMessage({ message: 'looks like one' }, 'fb')).toBe('fb');
    expect(getErrorMessage(null, 'fb')).toBe('fb');
    expect(getErrorMessage(undefined, 'fb')).toBe('fb');
  });

  it('translates a fetch TypeError into connection copy', () => {
    // fetch() network failures surface as TypeError with browser-specific
    // wording. Showing the raw "Failed to fetch" tells a user nothing they can
    // act on.
    expect(getErrorMessage(new TypeError('Failed to fetch'))).toBe(API_UNREACHABLE_MESSAGE);
    expect(getErrorMessage(new TypeError('NetworkError when attempting to fetch'))).toBe(
      API_UNREACHABLE_MESSAGE,
    );
  });

  it('leaves an unrelated TypeError alone', () => {
    // Only fetch-shaped TypeErrors are network failures. A genuine
    // "x is not a function" must not be reported as an internet problem.
    expect(getErrorMessage(new TypeError('x is not a function'))).toBe('x is not a function');
  });

  it('uses the message of a plain Error, or the fallback when it is empty', () => {
    expect(getErrorMessage(new Error('specific thing'))).toBe('specific thing');
    expect(getErrorMessage(new Error(''), 'fb')).toBe('fb');
  });

  it('reports an unreachable network by code', () => {
    expect(getErrorMessage(new ApiError('raw', { code: NETWORK_UNREACHABLE_CODE }))).toBe(
      API_UNREACHABLE_MESSAGE,
    );
  });

  it('reports a timeout with copy that says the work may still land', () => {
    expect(getErrorMessage(new ApiError('raw', { code: REQUEST_TIMEOUT_CODE }))).toBe(
      REQUEST_TIMEOUT_MESSAGE,
    );
  });

  it('reports an inactive subscription by code AND by 402, reassuring about data', () => {
    // The copy promises the firm's data is preserved. A firm owner who reads a
    // generic "something went wrong" on every screen concludes they lost it.
    expect(getErrorMessage(new ApiError('raw', { code: BILLING_INACTIVE_CODE }))).toBe(
      BILLING_INACTIVE_MESSAGE,
    );
    expect(getErrorMessage(new ApiError('raw', { status: 402 }))).toBe(BILLING_INACTIVE_MESSAGE);
  });

  it('ranks 402 above the 5xx branch', () => {
    // Ordering check. A 402 carrying a requestId must not pick up the
    // "contact support with error ID" tail, which sends a billing problem to
    // the wrong place.
    const err = new ApiError('raw', { status: 402, requestId: 'req-1' });
    expect(getErrorMessage(err)).toBe(BILLING_INACTIVE_MESSAGE);
    expect(getErrorMessage(err)).not.toMatch(/req-1/);
  });

  it('reports maintenance mode', () => {
    expect(
      getErrorMessage(new ApiError('raw', { status: 503, code: MAINTENANCE_MODE_CODE })),
    ).toMatch(/undergoing maintenance/);
  });

  it.each(['TEMPLATE_FILL_BUSY', 'CONVERSION_BUSY'])(
    'reports a %s answer as a busy document queue, not as maintenance',
    (code) => {
      const msg = getErrorMessage(new ApiError('Something went wrong', { status: 503, code, requestId: 'req-9' }));
      expect(msg).toBe('Too many documents are being prepared right now. Please try again in a moment.');
    },
  );

  it('keeps the server copy for a busy answer that sent its own', () => {
    expect(
      getErrorMessage(new ApiError('Verification is busy right now. Try again in a minute.', {
        status: 503, code: 'SIGNING_BUSY',
      })),
    ).toBe('Verification is busy right now. Try again in a minute.');
  });

  it('renders a rate-limit countdown with the right singular or plural unit', () => {
    expect(getErrorMessage(new ApiError('raw', { status: 429, retryAfterSeconds: 30 }))).toBe(
      "You're doing that too quickly. Please wait 30 seconds and try again.",
    );
    expect(getErrorMessage(new ApiError('raw', { status: 429, retryAfterSeconds: 1 }))).toBe(
      "You're doing that too quickly. Please wait 1 second and try again.",
    );
  });

  it('prefers the server copy over a generic line when there is no countdown', () => {
    // Some limiters ship curated wording (per-network, per-signing-session).
    // Overwriting it loses the only clue about WHICH limit was hit.
    expect(getErrorMessage(new ApiError('Too many signing attempts.', { status: 429 }))).toBe(
      'Too many signing attempts.',
    );
  });

  it('falls back to generic rate-limit copy when the server sent none', () => {
    expect(getErrorMessage(new ApiError('', { status: 429 }))).toBe(
      'You are making requests too quickly. Please wait a moment and try again.',
    );
  });

  it('ignores a zero or negative countdown rather than saying "wait 0 seconds"', () => {
    expect(getErrorMessage(new ApiError('curated', { status: 429, retryAfterSeconds: 0 }))).toBe(
      'curated',
    );
  });

  it('reports every session-expiry code with the same log-in-again copy', () => {
    // Six codes, one meaning. A user who is told "authentication failed" for
    // one and "token revoked" for another cannot tell they are the same fix.
    for (const code of [
      'TOKEN_EXPIRED',
      'TOKEN_REVOKED',
      'AUTH_FAILED',
      'INVALID_TOKEN',
      'AUTHENTICATION_FAILED',
      'AUTHENTICATION_EXPIRED',
    ]) {
      expect(getErrorMessage(new ApiError('raw', { code }))).toBe(
        'Your session has expired. Please log in again.',
      );
    }
  });

  it('reports a disabled account', () => {
    expect(getErrorMessage(new ApiError('raw', { code: 'ACCOUNT_DISABLED' }))).toBe(
      'Your account has been disabled. Please contact support.',
    );
  });

  it('names the resource and the number in a plan-limit message', () => {
    expect(
      getErrorMessage(
        new ApiError('raw', { code: 'PLAN_LIMIT_REACHED', details: { resource: 'maxMatters', limit: 25 } }),
      ),
    ).toBe('Your plan allows 25 matters and you are using all 25. Upgrade your plan to add more.');
    expect(
      getErrorMessage(
        new ApiError('raw', { code: 'PLAN_LIMIT_REACHED', details: { resource: 'maxMembers', limit: 3 } }),
      ),
    ).toBe('Your plan allows 3 team members and you are using all 3. Upgrade your plan to add more.');
  });

  it('degrades a plan-limit message when the limit or resource is missing', () => {
    expect(getErrorMessage(new ApiError('raw', { code: 'PLAN_LIMIT_REACHED', details: {} }))).toBe(
      "Your plan's items limit has been reached. Upgrade your plan to add more.",
    );
    expect(getErrorMessage(new ApiError('raw', { code: 'PLAN_LIMIT_REACHED' }))).toBe(
      "Your plan's items limit has been reached. Upgrade your plan to add more.",
    );
  });

  it('keeps a specific 403 message but replaces the backend placeholder', () => {
    // "Access denied" is the backend's generic scrub text and tells the user
    // nothing about what to do next; a curated 403 message does.
    expect(getErrorMessage(new ApiError('Only the matter owner can close it.', { status: 403 }))).toBe(
      'Only the matter owner can close it.',
    );
    expect(getErrorMessage(new ApiError('Access denied', { status: 403 }))).toBe(
      'You do not have permission to do this. Ask a firm admin if you need access.',
    );
  });

  it('ranks the 403 branch above the 5xx branch for a FORBIDDEN code', () => {
    // A FORBIDDEN code arriving with a 500 status must still read as a
    // permission problem, not as a server crash to report to support.
    const err = new ApiError('Access denied', { status: 500, code: 'FORBIDDEN', requestId: 'req-2' });
    expect(getErrorMessage(err)).toBe(
      'You do not have permission to do this. Ask a firm admin if you need access.',
    );
  });

  it('appends the request id to a 5xx so a user can quote it to support', () => {
    expect(getErrorMessage(new ApiError('Something went wrong', { status: 500, requestId: 'req-7' }))).toBe(
      'Something went wrong on our end. Please try again. If it keeps happening, contact support with error ID req-7.',
    );
  });

  it('keeps curated 5xx copy instead of overwriting it, and still appends the id', () => {
    // Status 500 rather than 503: a 503 is claimed by the maintenance branch
    // above regardless of what copy the server sent, which is itself the
    // ordering this suite pins.
    expect(
      getErrorMessage(new ApiError('The document converter is offline.', { status: 500, requestId: 'req-8' })),
    ).toBe('The document converter is offline. If it keeps happening, contact support with error ID req-8.');
  });

  it('does not let a 503 without the maintenance code claim the maintenance branch', () => {
    // A codeless 503 is the platform's answer (Cloud Run shedding load answers
    // with an HTML page, not our JSON), so its body is not copy for a user.
    expect(
      getErrorMessage(new ApiError('<html>Service Unavailable</html>', { status: 503 })),
    ).toBe('Something went wrong on our end. Please try again.');
  });

  it('omits the support tail when there is no request id', () => {
    // A dangling "contact support with error ID undefined" is worse than no
    // instruction at all.
    const msg = getErrorMessage(new ApiError('Something went wrong', { status: 500 }));
    expect(msg).toBe('Something went wrong on our end. Please try again.');
    expect(msg).not.toMatch(/undefined/);
  });

  it('falls through to the server message for an unclassified 4xx', () => {
    expect(getErrorMessage(new ApiError('Name already taken', { status: 409 }))).toBe(
      'Name already taken',
    );
  });

  it('falls back when an unclassified ApiError carries no message', () => {
    expect(getErrorMessage(new ApiError('', { status: 409 }), 'fb')).toBe('fb');
  });
});

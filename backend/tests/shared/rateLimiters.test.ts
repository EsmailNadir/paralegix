/**
 * Rate limiter wiring - unit tests against a fake Postgres pool, no database.
 *
 * Nothing used to assert that a limiter actually rejects, so a misconfigured one
 * (wrong key, wrong envelope, a store that silently no-ops) would have shipped
 * unnoticed. These pin the four properties the rest of the system depends on:
 *
 *  - the cap is enforced at the cap, not one either side of it
 *  - a rejection is a normal AppError (429 / RATE_LIMITED), so the central error
 *    handler adds the requestId and the frontend sees the code it looks for
 *  - each limiter has its own keyspace, so one prefix cannot spend another's
 *    allowance out of the shared `rate_limits` table
 *  - a database failure fails OPEN, because a limiter outage must not become an
 *    API outage
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/rateLimiters.test.js
 */

// An in-memory stand-in for the `rate_limits` table, driven by the same two
// statements the store issues. Keyed exactly as the store keys it, so a shared
// keyspace bug would show up here as a shared counter.
const mockRows = new Map();
let mockFailQueries = false;

jest.mock('../../src/shared/database/db', () => ({
  pool: {
    query: async (text: any, params: any) => {
      if (mockFailQueries) throw new Error('connection terminated unexpectedly');
      text = typeof text === 'string' ? text : text.text;
      if (text.startsWith('insert into rate_limits')) {
        const [key, windowMs] = params;
        const now = Date.now();
        const existing = mockRows.get(key);
        if (!existing || existing.expiresAt <= now) {
          mockRows.set(key, { hits: 1, expiresAt: now + Number(windowMs) });
        } else {
          existing.hits += 1;
        }
        const row = mockRows.get(key);
        return { rows: [{ hits: row.hits, expires_at: new Date(row.expiresAt) }] };
      }
      if (text.startsWith('delete from rate_limits')) {
        mockRows.clear();
        return { rows: [] };
      }
      return { rows: [] };
    },
  },
}));

const { makeLimiter } = require('../../src/shared/middleware/rateLimiters');
const { AppError } = require('../../src/shared/errors/AppError');

// Minimal express doubles. Only uid- and token-keyed limiters are exercised, so
// none of express's IP/trust-proxy plumbing is needed.
function fakeRes() {
  const headers: Record<string, any> = {};
  return {
    headersSent: false,
    setHeader: (name: any, value: any) => { headers[name] = value; },
    getHeader: (name: any) => headers[name],
    headers,
  };
}

// Runs one request through a limiter and resolves with the error it passed to
// next(), or null when the request was allowed through.
function run(limiter: any, req: any, res = fakeRes()) {
  return new Promise((resolve, reject) => {
    try {
      limiter(req, res, (err: any) => resolve(err || null));
    } catch (err) {
      reject(err);
    }
  });
}

beforeEach(() => {
  mockRows.clear();
  mockFailQueries = false;
});

describe('makeLimiter', () => {
  test('allows exactly the cap, then rejects with a 429 AppError', async () => {
    const limiter = makeLimiter({
      prefix: 'test-cap',
      windowMs: 60_000,
      max: 3,
      keyBy: (req: any) => req.user.uid,
      message: 'Slow down please.',
    });
    const req = { user: { uid: 'user-a' } };

    expect(await run(limiter, req)).toBeNull();
    expect(await run(limiter, req)).toBeNull();
    expect(await run(limiter, req)).toBeNull();

    const rejection: any = await run(limiter, req);
    expect(rejection).toBeInstanceOf(AppError);
    expect(rejection.statusCode).toBe(429);
    expect(rejection.code).toBe('RATE_LIMITED');
    expect(rejection.message).toBe('Slow down please.');
  });

  test('a rejection carries Retry-After and the RateLimit headers', async () => {
    const limiter = makeLimiter({
      prefix: 'test-headers',
      windowMs: 60_000,
      max: 1,
      keyBy: (req: any) => req.user.uid,
    });
    const req = { user: { uid: 'user-a' } };

    await run(limiter, req);
    const res = fakeRes();
    await run(limiter, req, res);

    // The frontend reads Retry-After first and falls back to RateLimit-Reset to
    // render its "try again in N seconds" copy, so both must be present.
    expect(Number(res.getHeader('Retry-After'))).toBeGreaterThan(0);
    expect(res.getHeader('RateLimit-Limit')).toBe('1');
    expect(res.getHeader('RateLimit-Remaining')).toBe('0');
    expect(Number(res.getHeader('RateLimit-Reset'))).toBeGreaterThan(0);
  });

  test('each key gets its own allowance', async () => {
    const limiter = makeLimiter({
      prefix: 'test-keys',
      windowMs: 60_000,
      max: 1,
      keyBy: (req: any) => req.user.uid,
    });

    expect(await run(limiter, { user: { uid: 'user-a' } })).toBeNull();
    // A different account must not inherit the first one's spent allowance.
    expect(await run(limiter, { user: { uid: 'user-b' } })).toBeNull();
    expect(await run(limiter, { user: { uid: 'user-a' } })).toBeInstanceOf(AppError);
  });

  test('limiters with different prefixes do not share a bucket', async () => {
    const first = makeLimiter({
      prefix: 'test-first', windowMs: 60_000, max: 1, keyBy: (req: any) => req.user.uid,
    });
    const second = makeLimiter({
      prefix: 'test-second', windowMs: 60_000, max: 1, keyBy: (req: any) => req.user.uid,
    });
    const req = { user: { uid: 'user-a' } };

    expect(await run(first, req)).toBeNull();
    // Same key, same table, different limiter: spending one must not spend the
    // other, which is what the per-limiter prefix buys.
    expect(await run(second, req)).toBeNull();
    expect(await run(first, req)).toBeInstanceOf(AppError);
  });

  test('a token-keyed limiter counts per token, not per caller', async () => {
    const limiter = makeLimiter({
      prefix: 'test-token',
      windowMs: 60_000,
      max: 1,
      keyBy: (req: any) => req.params.token,
    });

    expect(await run(limiter, { params: { token: 'session-1' } })).toBeNull();
    expect(await run(limiter, { params: { token: 'session-2' } })).toBeNull();
    // Rotating IPs cannot buy more attempts on the same signing session.
    expect(await run(limiter, { params: { token: 'session-1' } })).toBeInstanceOf(AppError);
  });

  test('fails open when the database is unreachable', async () => {
    const limiter = makeLimiter({
      prefix: 'test-failopen',
      windowMs: 60_000,
      max: 1,
      keyBy: (req: any) => req.user.uid,
    });
    const req = { user: { uid: 'user-a' } };

    mockFailQueries = true;
    // A limiter outage must not become an API outage: every request is allowed,
    // however many arrive.
    expect(await run(limiter, req)).toBeNull();
    expect(await run(limiter, req)).toBeNull();
    expect(await run(limiter, req)).toBeNull();
  });

  test('a skip predicate bypasses the limiter entirely', async () => {
    const limiter = makeLimiter({
      prefix: 'test-skip',
      windowMs: 60_000,
      max: 1,
      keyBy: (req: any) => req.user.uid,
      skip: (req: any) => req.originalUrl === '/api/health',
    });

    for (let i = 0; i < 5; i += 1) {
      expect(await run(limiter, { user: { uid: 'user-a' }, originalUrl: '/api/health' })).toBeNull();
    }
  });
});

describe('uid-keyed limiters', () => {
  test('report a legible error when mounted before verifyToken', async () => {
    // A silent 500 from `cannot read properties of undefined` is a bad way to
    // learn about a middleware ordering mistake.
    const { heavyReadLimiter } = require('../../src/shared/middleware/rateLimiters');
    const rejection: any = await run(heavyReadLimiter, {});
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toMatch(/before verifyToken/);
  });
});

describe('the identity verification start limiter', () => {
  const { identityVerificationStartLimiter } = require('../../src/shared/middleware/rateLimiters');
  const start = (uid: string) => run(identityVerificationStartLimiter, {
    user: { uid },
    ip: '203.0.113.7',
    headers: {},
    app: { get: () => false },
  });

  test('allows ten starts per account, refuses the eleventh, and counts each account separately', async () => {
    // Each start opens a paid provider session, so the cap is per account.
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await start('portal-client-a')).toBeNull();
    }
    const rejection: any = await start('portal-client-a');
    expect(rejection).toBeInstanceOf(AppError);
    expect(rejection.statusCode).toBe(429);
    expect(rejection.code).toBe('RATE_LIMITED');

    // Same address, another account: its own allowance.
    expect(await start('portal-client-b')).toBeNull();
  });
});

describe('the public intake limiters', () => {
  const {
    intakeGateLimiter,
    intakeReadLimiter,
  } = require('../../src/shared/middleware/rateLimiters');

  // A visitor to the public intake surface carries no account, so the address
  // and the token in the URL are the only two things a limiter can key on.
  // Which one each route picks IS the security property, and neither can be
  // exercised through the in-process harness (it sets RATE_LIMITS_DISABLED), so
  // the limiters are driven directly here.
  const attempt = (limiter: any, token: string, ip: string) => run(limiter, {
    params: { token },
    ip,
    originalUrl: `/api/intake/${token}`,
    // `headers` and `app` are what express-rate-limit's trust-proxy validation
    // reads before it keys on the address; without them it logs a warning on
    // every request and drowns a real failure.
    headers: {},
    app: { get: () => false },
  });

  test('the access-code gate counts per FORM TOKEN, not per address', async () => {
    // Five guesses at one form, every one from a DIFFERENT address...
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await attempt(intakeGateLimiter, 'form-token-1', `203.0.113.${i}`)).toBeNull();
    }

    // ...and the sixth is refused even though that address has never been seen
    // before. Keyed on the address (which is what the shared read limiter did),
    // rotating IPs bought unlimited guesses at a code the FIRM types by hand.
    const rejection: any = await attempt(intakeGateLimiter, 'form-token-1', '198.51.100.9');
    expect(rejection).toBeInstanceOf(AppError);
    expect(rejection.statusCode).toBe(429);
    expect(rejection.code).toBe('RATE_LIMITED');

    // The keyspace is per form, so one form's spent allowance cannot refuse
    // guesses at another one.
    expect(await attempt(intakeGateLimiter, 'form-token-2', '203.0.113.0')).toBeNull();
  });

  test('the form READ stays keyed on the address, so no one can take a form offline', async () => {
    // Thirty reads of THIRTY DIFFERENT forms from one address exhaust ONE
    // bucket, which is only true if the key is the address.
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await attempt(intakeReadLimiter, `read-token-${i}`, '203.0.113.1')).toBeNull();
    }
    expect(await attempt(intakeReadLimiter, 'read-token-fresh', '203.0.113.1'))
      .toBeInstanceOf(AppError);

    // Deliberate, and the reason the gate got its OWN limiter rather than a
    // `keyBy` added to this one: GET /api/intake/:token is a lead-generation
    // page whose token is public by design, so keying it on the token would let
    // any anonymous caller spend a firm's whole allowance and blank the form for
    // every real prospect. A second visitor must still be able to load a form
    // someone else just read.
    expect(await attempt(intakeReadLimiter, 'read-token-0', '198.51.100.2')).toBeNull();
  });
});

describe('RATE_LIMITS_DISABLED', () => {
  test('makes a limiter inert, and only while it is set', async () => {
    // The in-process harness sets this so a suite replaying a month of traffic
    // in seconds is not answered 429 by caps sized for one human. Asserted here
    // rather than trusted, because a flag that silently stopped working would
    // turn every rate limit in the API off in production.
    const { makeLimiter } = require('../../src/shared/middleware/rateLimiters');
    const limiter = makeLimiter({ prefix: 'inert-probe', windowMs: 60000, max: 1 });
    // `headers` is required once the flag is off: express-rate-limit's default
    // key generator inspects the forwarded header before it keys on the ip.
    const req = { ip: '203.0.113.7', originalUrl: '/api/probe', headers: {} };

    process.env.RATE_LIMITS_DISABLED = 'true';
    for (let i = 0; i < 10; i += 1) {
      expect(await run(limiter, req)).toBeNull();
    }

    // Same limiter, same key, flag off: the cap of 1 is enforced again, so the
    // bypass is genuinely reading the variable per request.
    delete process.env.RATE_LIMITS_DISABLED;
    expect(await run(limiter, req)).toBeNull();
    const rejection: any = await run(limiter, req);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.statusCode).toBe(429);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};

describe('the global per-IP limiter', () => {
  const { globalApiLimiter } = require('../../src/shared/middleware/rateLimiters');
  const CAP = Number(process.env.GLOBAL_RATE_LIMIT_MAX || 1000);
  const OFFICE_IP = '198.51.100.20';

  const request = (path: string, authorization?: string) => ({
    ip: OFFICE_IP,
    originalUrl: path,
    headers: authorization ? { authorization } : {},
    app: { get: () => false },
  });

  // Fires `count` requests and returns how many the limiter turned away.
  const rejectedOf = async (count: number, make: () => any) => {
    let rejected = 0;
    for (let i = 0; i < count; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await run(globalApiLimiter, make())) rejected += 1;
    }
    return rejected;
  };

  test('does not count signed-in firm traffic, so one office NAT never shares a bucket', async () => {
    // A firm's whole staff behind one public address: past the cap, every one of
    // them still gets through. Each request is bounded per ACCOUNT instead, by
    // perUserApiLimiter once verifyToken has the uid, and a forged token is
    // charged to the per-IP authFailureLimiter.
    const rejected = await rejectedOf(CAP + 50, () => request('/api/lawfirms/firm-1/matters', 'Bearer some.id.token'));
    expect(rejected).toBe(0);
  });

  test('still caps anonymous traffic from one address at the cap', async () => {
    const rejected = await rejectedOf(CAP + 5, () => request('/api/lawfirms/firm-1/matters'));
    expect(rejected).toBe(5);
  });

  test('a bearer header buys nothing outside the always-authenticated firm routes', async () => {
    // Public routes (signing links, intake forms, shares) never verify a token,
    // so a made-up header must not take a caller out of the per-IP bucket there.
    const rejected = await rejectedOf(CAP + 5, () => request('/api/signing/some-token', 'Bearer made.up.token'));
    expect(rejected).toBe(5);
  });
});

// These requests never reach the token verifier's failed-auth bucket.
describe('global limiter bypass boundaries', () => {
  const { globalApiLimiter } = require('../../src/shared/middleware/rateLimiters');
  const cap = Number(process.env.GLOBAL_RATE_LIMIT_MAX || 1000);
  test.each([
    ['/api/lawfirms/', 'Bearer forged'],
    ['/api/lawfirms//', 'Bearer forged'],
    ['/api/lawfirms/firm/matters', 'bearer forged'],
    ['/api/lawfirms/firm/matters', 'Bearer\tforged'],
  ])('caps requests to %s carrying %s', async (originalUrl, authorization) => {
    let rejected = 0;
    for (let i = 0; i < cap + 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await run(globalApiLimiter, {
        ip: '198.51.100.21', originalUrl, headers: { authorization }, app: { get: () => false },
      })) rejected += 1;
    }
    expect(rejected).toBe(5);
  });
});

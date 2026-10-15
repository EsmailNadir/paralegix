/**
 * The global per-IP limiter skips bearer requests to the firm routes, so that a
 * whole office behind one NAT does not share a bucket. That is only safe if a
 * FORGED bearer is still bounded per address. It is: every /api/lawfirms route
 * runs verifyToken, which charges each failed verification to the per-IP
 * authFailureLimiter. This drives the two middlewares in the order app.ts
 * mounts them, against a fake Postgres pool and a Firebase that rejects every
 * token, and proves a spray of made-up tokens is cut off at that limit.
 */

const mockRows = new Map();

jest.mock('../../src/shared/database/db', () => ({
  pool: {
    query: async (text: any, params: any) => {
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
      return { rows: [] };
    },
  },
}));

jest.mock('../../src/shared/database/firebase', () => ({
  auth: {
    verifyIdToken: async () => {
      const err: any = new Error('Decoding Firebase ID token failed.');
      err.code = 'auth/argument-error';
      throw err;
    },
  },
}));

const { globalApiLimiter } = require('../../src/shared/middleware/rateLimiters');
const { verifyToken } = require('../../src/shared/middleware/auth');

const FAILURE_CAP = Number(process.env.AUTH_FAILURE_RATE_LIMIT_MAX || 100);
const ATTACKER_IP = '203.0.113.99';

function fakeRes() {
  const res: any = {
    headersSent: false,
    statusCode: 200,
    headers: {} as Record<string, any>,
    setHeader(name: string, value: any) { res.headers[name] = value; },
    getHeader(name: string) { return res.headers[name]; },
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; res.headersSent = true; return res; },
  };
  return res;
}

// One request through the two middlewares in mount order. Resolves to the
// status the caller saw: the 401 verifyToken writes itself, or the status of
// the error a middleware handed to next().
function send(n: number): Promise<number> {
  const req: any = {
    ip: ATTACKER_IP,
    originalUrl: '/api/lawfirms/firm-1/matters',
    headers: { authorization: `Bearer forged.token.${n}` },
    app: { get: () => false },
    log: { warn: () => {} },
  };
  const res = fakeRes();
  return new Promise((resolve) => {
    // verifyToken answers a plain 401 itself through res.json rather than
    // through next(), so both exits settle the same promise.
    res.json = (body: any) => { res.body = body; res.headersSent = true; resolve(res.statusCode); return res; };
    globalApiLimiter(req, res, (globalErr: any) => {
      if (globalErr) return resolve(globalErr.statusCode);
      verifyToken(req, res, (authErr: any) => resolve(authErr ? authErr.statusCode : 200));
    });
  });
}

beforeEach(() => mockRows.clear());

test('a spray of forged bearer tokens to a firm route is cut off by the per-IP failure limit', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < FAILURE_CAP + 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    statuses.push(await send(i));
  }

  // Every forged token was verified and refused...
  expect(statuses.slice(0, FAILURE_CAP).every((s) => s === 401)).toBe(true);
  // ...and past the failure budget the address is refused outright, even
  // though the global per-IP limiter let every one of these through.
  expect(statuses.slice(FAILURE_CAP)).toEqual(Array(10).fill(429));
});

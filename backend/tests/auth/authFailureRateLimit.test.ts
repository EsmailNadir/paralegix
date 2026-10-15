/**
 * Authentication-failure rate-limit tests.
 *
 * The in-process harness deliberately sets RATE_LIMITS_DISABLED=true, which is
 * right for ordinary route specs but would make an auth-failure limiter test a
 * false pass. This file loads the real middleware with a one-attempt cap and
 * the bypass explicitly disabled, while replacing only its Postgres store.
 */

const mockRows = new Map<string, { hits: number; expiresAt: number }>();
const mockVerifyIdToken = jest.fn();

jest.mock('../../src/shared/database/firebase', () => ({
  auth: { verifyIdToken: mockVerifyIdToken },
}));

jest.mock('../../src/shared/database/infrastructureQuery', () => ({
  infrastructureRootSql: async (text: string, params: unknown[]) => {
    if (!text.startsWith('insert into rate_limits')) return { rows: [] };

    const [key, windowMs] = params as [string, number];
    const now = Date.now();
    const existing = mockRows.get(key);
    if (!existing || existing.expiresAt <= now) {
      mockRows.set(key, { hits: 1, expiresAt: now + Number(windowMs) });
    } else {
      existing.hits += 1;
    }
    const row = mockRows.get(key)!;
    return { rows: [{ hits: row.hits, expires_at: new Date(row.expiresAt) }] };
  },
}));

function requestFor(token: string, ip = '203.0.113.8') {
  return {
    headers: { authorization: `Bearer ${token}` },
    id: 'auth-failure-rate-limit-test',
    ip,
    app: { get: () => false },
    log: { warn: jest.fn() },
  };
}

function response() {
  const headers: Record<string, unknown> = {};
  return {
    headersSent: false,
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    setHeader: (name: string, value: unknown) => { headers[name] = value; },
    getHeader: (name: string) => headers[name],
    status(this: any, statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    json(this: any, body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe('authentication-failure rate limiter', () => {
  const originalDisabled = process.env.RATE_LIMITS_DISABLED;
  const originalMax = process.env.AUTH_FAILURE_RATE_LIMIT_MAX;

  beforeEach(() => {
    mockRows.clear();
    mockVerifyIdToken.mockReset();
    mockVerifyIdToken.mockRejectedValue(Object.assign(new Error('invalid token'), {
      code: 'auth/argument-error',
    }));

    // The limiter reads its cap on module load but the disabled flag per
    // request. Resetting modules here gives this spec a tiny deterministic cap
    // instead of inheriting the harness's production-sized/default setting.
    process.env.RATE_LIMITS_DISABLED = 'false';
    process.env.AUTH_FAILURE_RATE_LIMIT_MAX = '1';
    jest.resetModules();
  });

  afterAll(() => {
    if (originalDisabled === undefined) delete process.env.RATE_LIMITS_DISABLED;
    else process.env.RATE_LIMITS_DISABLED = originalDisabled;
    if (originalMax === undefined) delete process.env.AUTH_FAILURE_RATE_LIMIT_MAX;
    else process.env.AUTH_FAILURE_RATE_LIMIT_MAX = originalMax;
  });

  it('charges invalid tokens to a dedicated per-IP bucket when the suite bypass is off', async () => {
    const { verifyToken } = require('../../src/shared/middleware/auth');
    const firstResponse = response();
    const secondResponse = response();
    const firstNext = jest.fn();
    const secondNext = jest.fn();

    await verifyToken(requestFor('invalid-token-one'), firstResponse, firstNext);
    await verifyToken(requestFor('invalid-token-two'), secondResponse, secondNext);

    // The first failed Firebase verification gets its normal, actionable 401.
    expect(firstResponse.statusCode).toBe(401);
    expect(firstResponse.body).toMatchObject({ code: 'INVALID_TOKEN' });
    expect(firstNext).not.toHaveBeenCalled();

    // A second distinct bad token from the same IP is not allowed to sidestep
    // the cap by rotating token strings. The limiter's standard AppError is
    // handed to the central error middleware through next().
    expect(secondResponse.statusCode).toBeUndefined();
    expect(secondNext).toHaveBeenCalledTimes(1);
    expect(secondNext.mock.calls[0][0]).toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: 'Too many failed authentication attempts. Please wait a moment and try again.',
    });
    expect(mockVerifyIdToken).toHaveBeenCalledTimes(2);
  });

  it('keeps failure limiting isolated to the source IP', async () => {
    const { verifyToken } = require('../../src/shared/middleware/auth');
    const firstResponse = response();
    const otherIpResponse = response();

    await verifyToken(requestFor('invalid-token-one', '203.0.113.8'), firstResponse, jest.fn());
    await verifyToken(requestFor('invalid-token-two', '198.51.100.9'), otherIpResponse, jest.fn());

    expect(firstResponse.statusCode).toBe(401);
    expect(otherIpResponse.statusCode).toBe(401);
    expect(otherIpResponse.body).toMatchObject({ code: 'INVALID_TOKEN' });
  });
});

export {};

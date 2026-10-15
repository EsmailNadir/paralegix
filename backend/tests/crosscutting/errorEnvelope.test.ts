/**
 * What leaves the building when something fails.
 *
 * `errorHandler` is the last middleware in the app and decides the body of every
 * failed request. Nothing imported it. A few calendar specs assert that one of
 * their own routes answers a scrubbed 500, which exercises the handler by
 * accident rather than pinning its rules.
 *
 * The rule that matters is one boolean expression:
 *
 *     const looksThirdParty = Boolean(err.response || err.config || err.raw || err.isAxiosError);
 *     const exposeMessage = isClientError && !looksThirdParty && ...
 *
 * gaxios, googleapis, axios, GCS and Stripe all throw errors carrying a status,
 * and their messages can name internal urls, bucket paths, request config and
 * account detail. That expression is what stands between an SDK's internals and
 * the client. It is also easy to weaken by accident, because every branch of it
 * looks like defensive noise until you see what the messages contain.
 *
 * Driven as a unit, because the handler IS a pure function of (err, req) and
 * routing a real request through each error SHAPE (a body-parser overflow or a
 * gaxios failure) would mean provoking several different
 * subsystems to test one file. A real-route control at the end proves the
 * handler is actually mounted and produces the same envelope.
 */
import { ownerOf, createFirm } from '../support/setupInProcess';
import {
  AppError,
  ForbiddenError,
  ValidationError,
} from '../../src/shared/errors/AppError';

const { errorHandler } = require('../../src/shared/middleware/errorHandler');

const REQUEST_ID = 'req-11111111-2222-3333-4444-555555555555';

/** A minimal Express request, with a silent logger so a spec does not print. */
function fakeReq(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    method: 'POST',
    url: '/api/lawfirms/firm-a/matters',
    originalUrl: '/api/lawfirms/firm-a/matters',
    headers: {},
    log: { error: () => {}, warn: () => {}, info: () => {} },
    user: { uid: 'member-1' },
    ...overrides,
  } as any;
}

/** Captures what the handler sent, instead of writing to a socket. */
function fakeRes() {
  const sent: { status?: number; body?: any } = {};
  const res: any = {
    status(code: number) { sent.status = code; return res; },
    json(body: any) { sent.body = body; return res; },
  };
  return { res, sent };
}

function handle(err: unknown, req = fakeReq()) {
  const { res, sent } = fakeRes();
  errorHandler(err, req, res, () => {});
  return sent;
}

describe('every error carries the envelope a caller can act on', () => {
  it('answers an AppError with its own message, code and the request id', async () => {
    const sent = handle(new AppError('Name is required', 400, 'VALIDATION_ERROR'));

    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({
      error: 'Name is required',
      code: 'VALIDATION_ERROR',
      requestId: REQUEST_ID,
    });
  });

  it('carries the request id on every branch, so a report can be correlated', async () => {
    // The id is what turns "it broke" into a log line. It reveals nothing on its
    // own, which is why it is the one internal value that IS exposed.
    const errors = [
      new ForbiddenError('Access denied'),
      Object.assign(new Error('legacy'), { statusCode: 400 }),
      Object.assign(new Error('legacy server'), { statusCode: 502 }),
      Object.assign(new Error('too big'), { type: 'entity.too.large' }),
      new Error('completely unexpected'),
    ];

    for (const err of errors) {
      expect(handle(err).body.requestId).toBe(REQUEST_ID);
    }
  });

  it('includes details only when the error carried them', async () => {
    // `details` is how a form knows WHICH field to mark. Only ValidationError
    // sets it: the base AppError constructor takes (message, statusCode, code)
    // and nothing else, and ValidationError takes the DETAILS rather than a
    // message, deriving the message from them. Both halves are spelled out
    // because my first version of this test passed a sentence to
    // ValidationError, which type-checks and quietly puts the sentence in
    // `details`.
    const withDetails = handle(new ValidationError({ name: 'Name is required' } as never));

    expect(withDetails.body.details).toEqual({ name: 'Name is required' });
    expect(withDetails.body.error).toBe('Name is required');

    const withoutDetails = handle(new AppError('Invalid', 400, 'VALIDATION_ERROR'));
    expect(withoutDetails.body).not.toHaveProperty('details');
  });
});

describe('a 4xx from our own code is shown; a 4xx from an SDK is not', () => {
  it('shows the message of a plain legacy 4xx, which we authored', async () => {
    const sent = handle(Object.assign(new Error('That matter is already closed'), { statusCode: 409 }));

    expect(sent.status).toBe(409);
    expect(sent.body.error).toBe('That matter is already closed');
  });

  it.each([
    ['gaxios/googleapis, which carries .response', { response: { status: 403, data: { error: 'insufficient scope' } } }],
    ['axios, which carries .config', { config: { url: 'https://internal.example/token' } }],
    ['axios, which sets .isAxiosError', { isAxiosError: true }],
    ['stripe, which carries .raw', { raw: { message: 'No such customer: cus_SECRET123' } }],
  ])('scrubs a 4xx from %s', async (_label, shape) => {
    // Each of these is a real SDK's error surface. The message can name an
    // internal url, a bucket path, a customer id or the request config, and none
    // of that is ours to hand to a caller.
    const err = Object.assign(new Error('Bucket paralegix-prod-files denied for key firms/9/secret.pdf'), {
      statusCode: 403,
      ...shape,
    });

    const sent = handle(err);

    expect(sent.status).toBe(403);
    expect(sent.body.error).not.toMatch(/paralegix-prod-files/);
    expect(sent.body.error).not.toMatch(/secret\.pdf/);
    expect(sent.body.error).toBe('You do not have permission to perform this action.');
  });

  it('never shows a 5xx message, even from our own code', async () => {
    // The asymmetry is deliberate. A 4xx message tells a user what to change; a
    // 5xx message describes our internals and can only leak.
    const sent = handle(Object.assign(
      new Error('relation "trust_transactions" does not exist at character 42'),
      { statusCode: 500 },
    ));

    expect(sent.status).toBe(500);
    expect(sent.body.error).not.toMatch(/trust_transactions/);
    expect(sent.body.error).not.toMatch(/character 42/);
  });

  it('keeps the SDK error CODE while dropping its message', async () => {
    // The code is a short symbol we can branch on; the message is prose we did
    // not write. Keeping one and dropping the other is the point.
    const sent = handle(Object.assign(new Error('No such customer: cus_SECRET123'), {
      statusCode: 400,
      code: 'resource_missing',
      raw: {},
    }));

    expect(sent.body.code).toBe('resource_missing');
    expect(JSON.stringify(sent.body)).not.toMatch(/cus_SECRET123/);
  });
});

describe('an unexpected error discloses nothing at all', () => {
  it('answers a generic 500 with no message, stack or property from the error', async () => {
    const err: any = new Error('connect ECONNREFUSED 10.0.0.7:5432');
    err.query = 'select * from users where email = $1';
    err.stack = 'Error: connect ECONNREFUSED\n    at Pool.connect (/app/src/db.ts:63:9)';

    const sent = handle(err);
    const body = JSON.stringify(sent.body);

    expect(sent.status).toBe(500);
    expect(sent.body.code).toBe('INTERNAL_ERROR');
    expect(body).not.toMatch(/ECONNREFUSED/);
    expect(body).not.toMatch(/10\.0\.0\.7/);
    expect(body).not.toMatch(/select \* from/);
    expect(body).not.toMatch(/\/app\/src/);
    expect(body).not.toMatch(/at Pool\.connect/);
  });

  it('answers the same way for a thrown string or object', async () => {
    // Not everything thrown is an Error. A bare string or object must not fall
    // through to a different shape, or a caller parsing the envelope breaks
    // exactly when something is already wrong.
    //
    // `null` and `undefined` are deliberately NOT in this list. The handler
    // reads `err.status` unguarded and throws a TypeError on them, but Express
    // treats a falsy value passed to `next()` as "no error" and never calls the
    // error middleware, so the case is unreachable through the app. Asserting it
    // would pin a promise the handler does not make. See D12 in the ledger.
    for (const thrown of ['a bare string', { message: 'a bare object' }]) {
      const sent = handle(thrown);
      expect(sent.status).toBe(500);
      expect(sent.body.code).toBe('INTERNAL_ERROR');
    }
  });
});

describe('a unique-constraint race is a conflict, not a crash', () => {
  /** What node-postgres throws for a duplicate key, with the parts it leaks. */
  function uniqueViolation() {
    return Object.assign(new Error('duplicate key value violates unique constraint "signature_fields_pkey"'), {
      code: '23505',
      constraint: 'signature_fields_pkey',
      table: 'signature_fields',
      detail: 'Key (session_id, id)=(5a1e, sig-1) already exists.',
    });
  }

  it('answers a raw unique violation with 409 CONFLICT and a generic message', async () => {
    const sent = handle(uniqueViolation());
    const body = JSON.stringify(sent.body);

    expect(sent.status).toBe(409);
    expect(sent.body).toEqual({
      error: 'This conflicts with existing data. Please refresh and try again.',
      code: 'CONFLICT',
      requestId: REQUEST_ID,
    });
    // The constraint, table and key values describe the schema and the row.
    expect(body).not.toMatch(/signature_fields/);
    expect(body).not.toMatch(/sig-1/);
  });

  it('recognises the violation when a query layer wraps it as the cause', async () => {
    const wrapped = Object.assign(new Error('Failed query: insert into signature_fields ...'), {
      cause: uniqueViolation(),
    });

    const sent = handle(wrapped);

    expect(sent.status).toBe(409);
    expect(sent.body.code).toBe('CONFLICT');
    expect(JSON.stringify(sent.body)).not.toMatch(/insert into/);
  });

  it('still answers any other database error with a generic 500', async () => {
    // A foreign-key violation is a bug in our own write, not a race the caller
    // can resolve by refreshing.
    const sent = handle(Object.assign(new Error('insert violates foreign key'), { code: '23503' }));

    expect(sent.status).toBe(500);
    expect(sent.body.code).toBe('INTERNAL_ERROR');
  });
});

describe('payload rejections get their own answer', () => {
  it('answers a body-parser overflow with 413 rather than a generic 500', async () => {
    const sent = handle(Object.assign(new Error('request entity too large'), { type: 'entity.too.large' }));

    expect(sent.status).toBe(413);
    expect(sent.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('does not rewrite a 413 we raised ourselves into upload copy', async () => {
    // A storage-quota AppError is also a 413 and carries its own message. The
    // parser branch matches on the parser's error TYPE for exactly this reason.
    const sent = handle(new AppError('Your firm has used its storage allowance.', 413, 'STORAGE_QUOTA_EXCEEDED'));

    expect(sent.status).toBe(413);
    expect(sent.body.error).toMatch(/storage allowance/);
    expect(sent.body.code).toBe('STORAGE_QUOTA_EXCEEDED');
  });
});

describe('an error after the response has started', () => {
  it('hands the error to Express instead of writing a second response', () => {
    // A route that kept working past a 504 from the request deadline, then
    // failed. A second write throws ERR_HTTP_HEADERS_SENT from inside the error
    // handler; Express's own handler closes the connection instead.
    const writes: string[] = [];
    const headersSent = () => { throw Object.assign(new Error('Cannot set headers after they are sent'), { code: 'ERR_HTTP_HEADERS_SENT' }); };
    const res: any = {
      headersSent: true,
      status() { writes.push('status'); return headersSent(); },
      json() { writes.push('json'); return headersSent(); },
      set() { writes.push('set'); return headersSent(); },
    };
    const err = new AppError('Too late', 409, 'CONFLICT');
    const next = jest.fn();

    expect(() => errorHandler(err, fakeReq(), res, next)).not.toThrow();

    expect(writes).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('the handler is actually mounted', () => {
  it('produces the same envelope through a real request', async () => {
    // The control for every case above, which all call the function directly. If
    // the handler were unmounted, or mounted before the routes, they would keep
    // passing while real failures answered with Express's default HTML page.
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);

    const res = await owner.api.post(`/api/lawfirms/${firmId}/matters`).send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });
});

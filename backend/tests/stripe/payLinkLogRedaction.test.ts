/**
 * The secure payment link's token never reaches the request log.
 *
 * The token in `/api/pay/<token>` is the link's only credential: anyone who
 * reads it can open the pay page and start checkout. The request logger writes
 * a URL for every write and every 4xx, so it would land in Cloud Logging for
 * anyone with log access. The logger writes `/api/pay/:token` instead, the way
 * the frontend's analytics sanitizer does, and the public share and intake
 * links get the same treatment.
 *
 * Red if any log line written for these requests carries the raw token, or if
 * no request line was written at all (which would make the first check vacuous).
 */
import { request } from '../support/setupInProcess';

const pino = require('pino');
const { logger } = require('../../src/shared/utils/logger');
const { requestContext, getRequestContext } = require('../../src/shared/utils/requestContext');

const TOKEN = 'live_pay_link_token_0123456789abcdefABCDEF';

let lines: string[];
let previousStream: unknown;
let previousLevel: string;

beforeEach(() => {
  // The harness silences the logger; capture what it would have written.
  lines = [];
  previousStream = logger[pino.symbols.streamSym];
  previousLevel = logger.level;
  logger[pino.symbols.streamSym] = { write: (line: string) => { lines.push(line); } };
  logger.level = 'info';
});

afterEach(() => {
  logger[pino.symbols.streamSym] = previousStream;
  logger.level = previousLevel;
});

/** The completed-request lines the logger wrote for `path`'s route shape. */
function requestLines(shape: string) {
  return lines.map((line) => JSON.parse(line)).filter((entry) => typeof entry.req?.url === 'string' && entry.req.url.includes(shape));
}

it('logs a pay page 404 with the token redacted', async () => {
  const res = await request().get(`/api/pay/${TOKEN}`);
  expect(res.status).toBe(404);

  const logged = requestLines('/api/pay/');
  expect(logged).toHaveLength(1);
  expect(logged[0].req.url).toBe('/api/pay/:token');
  expect(logged[0].message).toBe('GET /api/pay/:token 404');
  expect(lines.join('\n')).not.toContain(TOKEN);
});

it('logs a pay link checkout with the token redacted', async () => {
  const res = await request().post(`/api/pay/${TOKEN}/checkout`).send({ method: 'card' });
  expect(res.status).toBe(404);

  const logged = requestLines('/api/pay/');
  expect(logged).toHaveLength(1);
  expect(logged[0].req.url).toBe('/api/pay/:token/checkout');
  expect(logged[0].message).toBe('POST /api/pay/:token/checkout 404');
  expect(lines.join('\n')).not.toContain(TOKEN);
});

it('logs public share and intake links with the token redacted', async () => {
  await request().get(`/api/share/${TOKEN}`);
  await request().get(`/api/intake/${TOKEN}`);

  expect(requestLines('/api/share/').map((e) => e.req.url)).toEqual(['/api/share/:token']);
  expect(requestLines('/api/intake/').map((e) => e.req.url)).toEqual(['/api/intake/:token']);
  expect(lines.join('\n')).not.toContain(TOKEN);
});

it('keeps an ordinary firm route intact', async () => {
  const path = '/api/lawfirms/00000000-0000-4000-8000-000000000000/billing/invoices/pay/abc';
  await request().get(path);

  expect(requestLines('/api/lawfirms/').map((e) => e.req.url)).toEqual([path]);
});

it('labels the request context (the slow-query and pool-wait route) with the token redacted', () => {
  let route: string | null = null;
  requestContext()(
    { originalUrl: `/api/pay/${TOKEN}/checkout?x=1`, method: 'POST', id: 'r1' },
    {},
    () => { route = getRequestContext()?.route ?? null; },
  );
  expect(route).toBe('/api/pay/:token/checkout');
});

it('names a refused public link in the authz security event with the token redacted', () => {
  // The intake form's wrong-access-code refusal is a 403, which the error
  // handler records as an `authz.denied` event carrying the request path.
  const { errorHandler } = require('../../src/shared/middleware/errorHandler');
  const { ForbiddenError } = require('../../src/shared/errors/AppError');
  const res: any = { headersSent: false, status: () => res, json: () => res, set: () => res };

  errorHandler(
    new ForbiddenError('Incorrect access code'),
    { originalUrl: `/api/intake/${TOKEN}/verify-access-code`, method: 'POST', id: 'r2' },
    res,
    () => {},
  );

  const events = lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'authz.denied');
  expect(events).toHaveLength(1);
  expect(events[0].path).toBe('/api/intake/:token/verify-access-code');
  expect(lines.join('\n')).not.toContain(TOKEN);
});

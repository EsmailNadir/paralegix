import type { NextFunction, Request, Response } from 'express';

const { AppError } = require('../errors/AppError');

/**
 * Ceiling on how long a write (and anything that is not a GET or HEAD) may take
 * to produce a response.
 *
 * Sits ABOVE the pool's `statement_timeout` (30s, see `database/db.js`) on
 * purpose: a query that exhausts its own limit must be allowed to fail and be
 * turned into a real error by its handler, rather than being pre-empted here and
 * reported as a timeout when the database already had a better answer. The
 * browser's write budget (`REQUEST_TIMEOUT_MS.write`, 45s) sits above this in
 * turn, so the client receives that answer instead of guessing whether its
 * write committed.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 40000);

/**
 * Ceiling on how long a read (GET or HEAD) may take to produce a response.
 *
 * Equal to the browser's read budget (`REQUEST_TIMEOUT_MS.read` in
 * `frontend/src/lib/constants/requestTimeouts.ts`), and deliberately not above
 * it: the browser has already abandoned a read at that point, so a longer
 * server deadline answers nobody and logs a 200 for a request the user saw
 * fail. The browser's clock starts before this one (network, queueing, a cold
 * start), so a 504 from here lands at or after the client gave up, never before.
 *
 * Unlike a write, a read has no outcome the client needs to learn once it has
 * stopped waiting, so pre-empting the pool's 30s `statement_timeout` costs
 * nothing. The one read the browser waits longer for is `BOOTSTRAP_READ`, below.
 */
export const DEFAULT_READ_REQUEST_TIMEOUT_MS = Number(process.env.READ_REQUEST_TIMEOUT_MS || 20000);

/**
 * Ceiling for a request that queues behind the document converter: a template
 * fill and a signing DOCX conversion.
 *
 * Both legitimately outlive the write budget under load. A fill waits up to 30s
 * for its render slot (`TEMPLATE_FILL_QUEUE_TIMEOUT_MS`), then up to 45s for the
 * conversion slot (`DOC_CONVERT_QUEUE_TIMEOUT_MS`), then for the conversion
 * itself (the worker allows 55s); the signing conversion skips the first wait.
 * This sits above that sum, so a request that is merely queued is never cut
 * off, and below the browser's upload budget (`REQUEST_TIMEOUT_MS.upload`,
 * 300s), so the server still answers before the client gives up. Unlike the
 * long-running exemptions below it is a real deadline: a request stuck past
 * every queue answers 504 rather than holding its socket open indefinitely.
 */
export const DEFAULT_CONVERSION_REQUEST_TIMEOUT_MS = Number(process.env.CONVERSION_REQUEST_TIMEOUT_MS || 180000);

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * The workspace shell's bootstrap read, `GET /api/lawfirms/:lawFirmId`.
 *
 * The frontend grants it `REQUEST_TIMEOUT_MS.bootstrap` (45s) because it is
 * usually the request that wakes a scaled-to-zero API. Held to the read budget
 * it would get a 504 while the browser is still waiting, so it keeps the
 * general budget instead, which sits under the browser's 45s.
 */
const BOOTSTRAP_READ = /^\/api\/lawfirms\/[^/]+\/?$/;

/**
 * Routes whose duration is set by their payload rather than by a query, and for
 * which the general budget would break a working feature: file transfer to and
 * from GCS, document conversion, bulk generation. Webhooks and cron are exempt
 * for a different reason: nobody is waiting on them, and cutting one short
 * turns a slow sync into a failed one.
 *
 * The frontend grants these same routes its own longer budget
 * (`REQUEST_TIMEOUT_MS.upload`); the two lists have to agree, or the server will
 * answer 504 on a request the client is still happily waiting on.
 *
 * Matched against the path only, never the query string.
 */
const LONG_RUNNING_PATTERNS = [
  /^\/api\/webhooks\//,
  /^\/api\/cron\//,
  /\/files(\/|$)/,
  /\/upload/,
  /\/download/,
  /\/export/,
  /\/signatures\/convert/,
  /\/templates\/[^/]+\/preview$/,
  /\/signing\/verify$/,
  /\/invoices\/bulk/,
];

export function isLongRunning(path: string) {
  return LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Routes held to `DEFAULT_CONVERSION_REQUEST_TIMEOUT_MS` rather than the write
 * budget. Anchored whole, so nothing that merely resembles them gains the
 * longer deadline.
 */
const QUEUED_CONVERSION_PATTERNS = [
  /^\/api\/lawfirms\/[^/]+\/templates\/[^/]+\/fill$/,
  /^\/api\/signing\/convert-upload-finalize$/,
];

export function isQueuedConversion(path: string) {
  return QUEUED_CONVERSION_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Answer a request that has run past its budget.
 *
 * What this does NOT do is stop the handler. Express has no way to abort a
 * running one, and threading an AbortSignal through every repository would be a
 * far larger change than the problem warrants. Marking the request aborted and
 * refusing its later queries at the pool hook was considered and rejected:
 * requests share in-flight promises (a calendar token refresh is awaited by
 * every request that needs it) and background writes inherit the request's
 * async context, so one caller's abort would fail work that belongs to others.
 * The pool's `statement_timeout` bounds the expensive part. What this buys is
 * that the CLIENT stops waiting and is told why, in the same
 * `{ error, code, requestId }` envelope as every other failure, and that a read
 * the browser abandoned is logged as the 504 it was rather than as a 200.
 *
 * @param {number} [timeoutMs] Budget for writes and the bootstrap read. Zero disables.
 * @param {number} [readTimeoutMs] Budget for every other GET and HEAD. Zero disables.
 * @param {number} [conversionTimeoutMs] Budget for a queued conversion. Zero disables.
 */
export function requestTimeout(
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  readTimeoutMs = DEFAULT_READ_REQUEST_TIMEOUT_MS,
  conversionTimeoutMs = DEFAULT_CONVERSION_REQUEST_TIMEOUT_MS,
) {
  return function requestTimeoutMiddleware(req: Request, res: Response, next: NextFunction) {
    const path = (req.originalUrl || req.url || '').split('?')[0];
    if (isLongRunning(path)) return next();
    const isRead = READ_METHODS.has(req.method) && !BOOTSTRAP_READ.test(path);
    let budget = isRead ? readTimeoutMs : timeoutMs;
    if (isQueuedConversion(path)) budget = conversionTimeoutMs;
    if (!budget) return next();

    const timer = setTimeout(() => {
      // The handler may have started streaming in the meantime; there is no
      // clean way to prepend an error to a response already on the wire.
      if (res.headersSent || res.writableEnded) return;
      next(new AppError(
        'The server took too long to answer this request. Please try again.',
        504,
        'REQUEST_TIMEOUT',
      ));
    }, budget);

    // Never let the deadline itself hold the process open during a drain.
    if (typeof timer.unref === 'function') timer.unref();

    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
}

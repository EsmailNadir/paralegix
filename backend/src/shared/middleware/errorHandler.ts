import type { NextFunction, Request, Response } from 'express';

const { AppError } = require('../errors/AppError');
const { logger } = require('../utils/logger');
const { logSecurityEvent } = require('../utils/securityLog');
const { redactSecretPath } = require('../utils/redactSecretPath');

// Flag a 403 response as an authorization-denied security event. A spike of
// these from one actor is the signature of authz probing — someone walking
// resource ids they cannot access (IDOR hunting). Only 403s are flagged;
// validation (400) and not-found (404) errors flow through the same branches
// but are not authz signals. Drives the authz-probing alert in infra/monitoring.
function flagIfAuthzDenied(req: Request, statusCode: number, code: string) {
  if (statusCode === 403) {
    logSecurityEvent(req, 'authz.denied', {
      level: 'warn',
      statusCode,
      code: code || null,
      method: req.method,
      // A public link's token is its credential, so it is redacted from the log.
      path: redactSecretPath((req.originalUrl || req.url || '').split('?')[0]),
    });
  }
}

// Default user-facing messages per status for errors whose own message cannot
// be trusted (hand-rolled or third-party errors that carry a status code).
const GENERIC_STATUS_MESSAGES = {
  400: 'The request could not be processed. Please check your input and try again.',
  401: 'Authentication required. Please log in again.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested resource was not found.',
  409: 'This conflicts with existing data. Please refresh and try again.',
  429: 'Too many requests. Please wait a moment and try again.',
};

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  // Every error response carries the request id so a user-reported error can
  // be correlated with the server logs. The id itself reveals nothing.
  const requestId = req.id || null;

  // The response already started: a route that kept working past the request
  // deadline's 504, or a stream that failed partway. A second write throws
  // ERR_HTTP_HEADERS_SENT from in here, so hand the error to Express's default
  // handler, which closes the connection rather than writing again.
  if (res.headersSent) {
    (req.log || logger).warn({
      event: 'server.error.after_headers_sent',
      errName: err?.name,
      errMessage: err?.message,
      errCode: err?.code,
      requestId,
    }, 'Error raised after the response was sent');
    return next(err);
  }

  // Body-parser rejection (express.json size limit). Matched on the parser's
  // error type only: other 413s (e.g. storage-quota AppErrors) carry their own
  // message and code and must not be rewritten into payload copy.
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'The request content is too large. Please reduce its size and try again.',
      code: 'PAYLOAD_TOO_LARGE',
      requestId,
    });
  }

  // Handle our custom AppError subclasses. These messages are authored by us
  // and safe to show to users verbatim.
  if (err instanceof AppError) {
    flagIfAuthzDenied(req, err.statusCode, err.code);
    // A refusal that is about load, not about the request, says when to retry.
    if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.details && { details: err.details }),
      requestId,
    });
  }

  // Plain errors with a numeric .status/.statusCode. Two very different
  // things land here: our own service code throwing `const e = new Error(msg);
  // e.statusCode = 400;` (message written for the user — safe to show), and
  // third-party SDK errors that happen to carry a status (gaxios/googleapis,
  // axios, GCS, Stripe). SDK messages can reveal internal URLs, bucket names,
  // or config, so: 5xx messages are never exposed, and 4xx messages are
  // exposed only when the error does not look like an HTTP-client/SDK error.
  const numericStatus =
    (typeof err.status === 'number' && err.status) ||
    (typeof err.statusCode === 'number' && err.statusCode) ||
    null;
  if (numericStatus && numericStatus >= 400 && numericStatus < 600) {
    flagIfAuthzDenied(req, numericStatus, err.code);
    const isClientError = numericStatus < 500;
    // gaxios/googleapis/axios carry .response/.config; Stripe carries .raw.
    const looksThirdParty = Boolean(err.response || err.config || err.raw || err.isAxiosError);
    const exposeMessage = isClientError && !looksThirdParty && typeof err.message === 'string' && err.message;
    if (!exposeMessage) {
      // Log a trimmed shape, not the full error: SDK errors (gaxios/axios/
      // Stripe) carry the whole request config and response payload as
      // enumerable props, which would bloat every log line and can include
      // request headers.
      const log = req.log || logger;
      log.warn({
        event: 'server.error.scrubbed',
        errName: err.name,
        errMessage: err.message,
        errCode: err.code,
        status: numericStatus,
        requestId,
        actorUid: req.user && req.user.uid ? req.user.uid : null,
      }, 'Error message scrubbed from response');
    }
    const message = exposeMessage
      ? err.message
      : ((GENERIC_STATUS_MESSAGES as Record<number, string | undefined>)[numericStatus]
        || (isClientError
          ? 'The request could not be processed. Please try again.'
          : 'Something went wrong on our end. Please try again.'));
    return res.status(numericStatus).json({
      error: message,
      ...(typeof err.code === 'string' && { code: err.code }),
      requestId,
    });
  }

  const log = req.log || logger;

  // A Postgres unique violation (SQLSTATE 23505) that no service translated:
  // two writes raced for the same key. That is a conflict the caller can retry,
  // not a server fault. The driver's message, constraint and `detail` name the
  // table and the duplicated values, so only the generic copy goes out; the
  // constraint is logged for diagnosis. Query layers may wrap it as `cause`.
  const uniqueViolation = err?.code === '23505' ? err : (err?.cause?.code === '23505' ? err.cause : null);
  if (uniqueViolation) {
    log.warn({
      event: 'server.error.unique_violation',
      constraint: uniqueViolation.constraint || null,
      table: uniqueViolation.table || null,
      requestId,
      actorUid: req.user && req.user.uid ? req.user.uid : null,
    }, 'Unique violation answered as 409');
    return res.status(409).json({
      error: GENERIC_STATUS_MESSAGES[409],
      code: 'CONFLICT',
      requestId,
    });
  }

  // A Postgres restrict violation (SQLSTATE 23001): a write the database
  // refused to protect existing data, such as a trigger that freezes a time
  // entry once an invoice holds it. The caller lost a race with another change,
  // which is a conflict, not a server fault. A trigger raises its own message,
  // written for people, so that text goes out. A foreign key restrict names its
  // table and constraint in the driver message, so only the generic copy does.
  const restrictViolation = err?.code === '23001' ? err : (err?.cause?.code === '23001' ? err.cause : null);
  if (restrictViolation) {
    const raisedByTrigger = !restrictViolation.constraint && typeof restrictViolation.message === 'string'
      && restrictViolation.message.replace(/ \(id=[^)]*\)$/, '');
    log.warn({
      event: 'server.error.restrict_violation',
      constraint: restrictViolation.constraint || null,
      table: restrictViolation.table || null,
      requestId,
      actorUid: req.user && req.user.uid ? req.user.uid : null,
    }, 'Restrict violation answered as 409');
    return res.status(409).json({
      error: raisedByTrigger || GENERIC_STATUS_MESSAGES[409],
      code: 'CONFLICT',
      requestId,
    });
  }

  // Unexpected errors. Prefer the request-scoped logger so the line carries the
  // request id / actor / firm; fall back to the shared logger if it is absent.
  log.error({
    event: 'server.error',
    err,
    requestId,
    actorUid: req.user && req.user.uid ? req.user.uid : null,
  }, 'Unhandled error');
  res.status(500).json({
    error: 'Something went wrong on our end. Please try again, and contact support with the error ID if it persists.',
    code: 'INTERNAL_ERROR',
    requestId,
  });
}

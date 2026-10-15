import type { NextFunction, Request, Response } from 'express';

/**
 * Ambient per-request context, carried through async boundaries.
 *
 * Exists so code far below the route handler — the database layer above all —
 * can name the request it is serving without every intermediate function
 * growing a parameter it does not otherwise use. A slow-query line that says
 * `GET /api/lawfirms/:id/dashboard` points at a feature; the same line carrying
 * only SQL points at a string.
 *
 * `AsyncLocalStorage` survives `await`, promise chains, and timers, so the
 * context set once by the middleware is still readable inside a repository call
 * several layers down. Anything running outside a request (cron passes started
 * by their own handler, the outbox worker, boot-time sweeps) simply reads
 * `undefined`, which callers must tolerate.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { redactSecretPath } from './redactSecretPath';

/** What every statement logged during a request is attributed to. */
export interface RequestContext {
  route: string;
  method: string;
  requestId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `context` readable by everything it awaits. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current request's context, or `undefined` outside a request. */
export function getRequestContext() {
  return storage.getStore();
}

/**
 * Express middleware that opens the context for the rest of the request.
 *
 * Mount it after the request logger so `req.id` is already assigned, and ahead
 * of every route so no handler escapes it.
 */
export function requestContext() {
  return function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
    // The path without its query string: query strings carry ids and search
    // terms, and this label ends up in logs. A public link's token is redacted
    // for the same reason.
    const route = redactSecretPath((req.originalUrl || req.url || '').split('?')[0]);
    runWithRequestContext(
      { route, method: req.method, requestId: req.id ? String(req.id) : null },
      next,
    );
  };
}

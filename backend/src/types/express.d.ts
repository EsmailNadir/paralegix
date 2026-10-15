import type { DecodedIdToken } from 'firebase-admin/auth';

// Pulled in for its side effect only: pino-http augments http.IncomingMessage
// with `id` and `log`, and Express's Request extends IncomingMessage, so this is
// what makes `req.id` resolve. Without the explicit reference the augmentation
// loads only in programs that happen to import pino-http already -- which is why
// `tsc` accepted `req.id` while ts-jest, building its own program, did not.
import type {} from 'pino-http';

/**
 * What this application's middleware attaches to the Express request.
 *
 * These are set by middleware and read by every route, so declaring them once
 * here is what lets a converted route reach `req.user.uid` without a cast. The
 * alternative -- casting at each of several hundred call sites -- would make the
 * conversion noisier than the code it is typing.
 *
 * Everything is optional because the property only exists AFTER its middleware
 * has run. `optionalVerifyToken` in particular sets `req.user = null` on an
 * anonymous request, so the null is real and callers have to handle it.
 */
declare global {
  namespace Express {
    interface Request {
      /** Set by `verifyToken` / `optionalVerifyToken`. Null when unauthenticated. */
      user?: DecodedIdToken | null;
      /** Start of a signing completion request, used to bound inline queue waits. */
      completionStartedAt?: number;
      /** The caller's IANA timezone, resolved by `requireTimezone`. */
      tz?: string;
      /** The firm membership row, set by the membership middleware. */
      member?: Record<string, unknown> | null;
      /** The `users` row for `req.user`, when a route has loaded it. */
      userData?: Record<string, unknown> | null;
      /** Set by `requireIsAdmin` for platform-admin routes. */
      adminUser?: Record<string, unknown> | null;
    }
  }
}

export {};

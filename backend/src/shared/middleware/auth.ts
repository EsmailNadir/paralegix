const { auth } = require('../database/firebase');
const { AppError, NotFoundError, ForbiddenError } = require('../errors/AppError');
const { logger } = require('../utils/logger');
const { perUserApiLimiter, authFailureLimiter } = require('./rateLimiters');

/**
 * Server-side email verification enforcement.
 *
 * Mirrors the client logic in frontend/src/lib/utils/emailVerification.ts so
 * server and client agree on who counts as "verified":
 *  - OAuth users (google.com / microsoft.com) are verified by their provider,
 *    so Firebase sets email_verified=true and they pass naturally.
 *  - A small whitelist of test accounts bypasses verification. Unlike the
 *    frontend, the backend MUST NOT ship a hardcoded list. It is read from the
 *    EMAIL_VERIFICATION_WHITELIST env var (comma-separated emails), default empty.
 *
 * Only password (email/password) sign-ins with email_verified=false and an email
 * not on the whitelist are rejected.
 */
// The verification whitelist is the REAL security boundary: a verification-exempt
// account MUST appear here or the API rejects it with 403 EMAIL_NOT_VERIFIED, no
// matter what the frontend thinks. It has TWO sources, unioned in
// shared/utils/emailWhitelist: the EMAIL_VERIFICATION_WHITELIST env var
// (deploy-time) plus the email_verification_whitelist table (managed live from the
// admin panel). The frontend has a parallel NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST
// (frontend/src/lib/utils/emailVerification.ts) used only for client-side route
// guards; keep them in sync per-environment. Default empty (no account is exempt).
const { isWhitelisted, ENV_WHITELIST } = require('../utils/emailWhitelist');

// A non-empty env whitelist in production means some accounts skip email-verification
// enforcement, which is a real security relaxation. Warn loudly so it is not left
// on by accident. The count is logged rather than the addresses to avoid putting
// account emails in logs. (DB-managed test accounts are intentional and not warned.)
if (process.env.NODE_ENV === 'production' && ENV_WHITELIST.length) {
  console.warn(`[startup] WARNING: email-verification bypass is ACTIVE in production. ${ENV_WHITELIST.length} account(s) on EMAIL_VERIFICATION_WHITELIST are exempt from email verification.`);
}

function isEmailVerifiedToken(decoded: any) {
  if (decoded.email_verified) return true;

  // Only enforce verification for password-based sign-ins. OAuth providers
  // already vouch for the email, and any non-password provider should not be
  // blocked by this check.
  if (decoded.firebase?.sign_in_provider !== 'password') return true;

  const email = (decoded.email || '').toLowerCase();
  if (email && isWhitelisted(email)) return true;

  return false;
}

/**
 * Short-TTL verified-token cache.
 *
 * HISTORY / SAFETY: A previous cache keyed on the Firebase UID caused a critical
 * cross-user bug: User A's decoded token was served for User B's request after a
 * logout/login on the same browser. The root cause was the KEY: a uid is shared
 * across many tokens/sessions, so it can't identify "this exact token".
 *
 * This cache is keyed on the FULL ID-TOKEN STRING, which is safe because:
 *  - A token string uniquely identifies exactly one user + one session. Two
 *    different users (or two logins) never produce the same token string, so a
 *    cache hit returns the decoded payload of THAT token and no other.
 *  - The token carries its own `exp`. We refuse to serve an entry once the
 *    token itself is expired (decoded.exp), independent of our TTL.
 *  - Entries also expire after a short wall-clock TTL (TOKEN_CACHE_TTL_MS) and
 *    the map is bounded (TOKEN_CACHE_MAX) with simple LRU eviction.
 *
 * What is cached is ONLY the result of a successful `verifyIdToken(token, true)`,
 * i.e. a token that Firebase already validated for signature, issuer,
 * not-expired AND not-revoked (checkRevoked: true). We never cache failures.
 *
 * REVOCATION: the fresh path passes `checkRevoked: true`, so a token revoked via
 * `auth.revokeRefreshTokens()` or a disabled account is rejected on the next
 * COLD-cache verify (this costs one extra Firebase network round-trip per cold
 * verify, the intended security/perf trade-off; the 30s cache still shields
 * repeat calls). Revocation latency is therefore bounded by the cache TTL: a
 * token already in the cache continues to be honored for up to 30s after it is
 * revoked, then the next verify re-checks Firebase and rejects it.
 */
const TOKEN_CACHE_TTL_MS = 30 * 1000; // 30s: short enough to bound staleness
const TOKEN_CACHE_MAX = 5000;         // bound memory; LRU-evict the oldest

// Map<tokenString, { decoded, cachedAt }>. Insertion order = LRU order:
// re-inserting on hit moves an entry to the most-recently-used (end) position.
const tokenCache = new Map();

// Map<tokenString, Promise<decoded>> of in-flight Firebase verifications, used to
// collapse concurrent cold-cache verifies of the SAME token into one round-trip
// (see makeVerifyToken). Entries are removed as soon as the verify settles.
const inflightVerifications = new Map();

// Periodic prune so expired entries don't linger up to the 5000-entry cap. Each
// ID token rotates ~hourly (and force-refreshes mint new strings), so a burst of
// distinct tokens would otherwise sit in the map until LRU overflow pushes them
// out. Eviction is still primarily lazy (on access); this just sweeps the tail.
const TOKEN_CACHE_SWEEP_MS = 60 * 1000; // 60s
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenCache) {
    const ttlExpired = now - entry.cachedAt > TOKEN_CACHE_TTL_MS;
    const tokenExpired = entry.decoded.exp && now >= entry.decoded.exp * 1000;
    if (ttlExpired || tokenExpired) tokenCache.delete(token);
  }
}, TOKEN_CACHE_SWEEP_MS);
// Don't keep the event loop alive for the sweep (e.g. during graceful shutdown).
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

function getCachedDecoded(token: any) {
  const entry = tokenCache.get(token);
  if (!entry) return null;

  const now = Date.now();

  // TTL eviction: bound how stale a cached verification can be.
  if (now - entry.cachedAt > TOKEN_CACHE_TTL_MS) {
    tokenCache.delete(token);
    return null;
  }

  // Never serve a token past its own Firebase expiry, regardless of TTL.
  // `exp` is in seconds since epoch.
  if (entry.decoded.exp && now >= entry.decoded.exp * 1000) {
    tokenCache.delete(token);
    return null;
  }

  // Mark as most-recently-used for LRU.
  tokenCache.delete(token);
  tokenCache.set(token, entry);
  return entry.decoded;
}

function setCachedDecoded(token: any, decoded: any) {
  // Don't cache an already-expired token.
  if (decoded.exp && Date.now() >= decoded.exp * 1000) return;

  if (tokenCache.has(token)) tokenCache.delete(token);
  tokenCache.set(token, { decoded, cachedAt: Date.now() });

  // Bounded LRU: evict the oldest (first-inserted) entry on overflow.
  if (tokenCache.size > TOKEN_CACHE_MAX) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey !== undefined) tokenCache.delete(oldestKey);
  }
}

/**
 * Maps a Firebase verification failure onto the 401 response body. Split out of
 * the catch block so the failure path can run the per-IP failure limiter first
 * and still answer with the right copy.
 *
 * The `error` field is what generic frontend code displays, so it carries the
 * user-actionable copy; `message` keeps the previous secondary text for
 * compatibility.
 */
function authFailurePayload(error: any) {
  switch (error.code) {
    case 'auth/id-token-expired':
      return {
        error: 'Your session has expired. Please refresh and try again.',
        code: 'TOKEN_EXPIRED',
        message: 'Please refresh your session',
      };
    // With checkRevoked: true, Firebase throws this when the session has been
    // revoked (auth.revokeRefreshTokens).
    case 'auth/id-token-revoked':
      return {
        error: 'Your session has been revoked. Please log in again.',
        code: 'TOKEN_REVOKED',
        message: 'Your session has been revoked. Please log in again.',
      };
    // Disabled accounts are also surfaced by checkRevoked: true.
    case 'auth/user-disabled':
      return {
        error: 'Your account has been disabled. Please contact support.',
        code: 'ACCOUNT_DISABLED',
        message: 'Your account has been disabled. Please contact support.',
      };
    case 'auth/argument-error':
      return {
        error: 'Your session is invalid. Please log in again.',
        code: 'INVALID_TOKEN',
        message: 'The provided token is malformed',
      };
    default:
      return {
        error: 'Authentication failed. Please log in again.',
        code: 'AUTH_FAILED',
        message: 'Authentication failed',
      };
  }
}

// Factory so we can expose two variants that share identical token-verification
// logic and only differ on whether an unverified email is allowed through.
// `verifyToken` (the default) enforces email verification; the bootstrap
// registration route uses `verifyTokenAllowUnverified` because a brand-new
// email/password user has not (and cannot yet) verify their email at the
// moment they create their Postgres record.
const makeVerifyToken = ({ requireVerifiedEmail, allowErasedIdentity = false }: { requireVerifiedEmail: boolean; allowErasedIdentity?: boolean }) => async (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'You are not signed in. Please log in and try again.',
      code: 'NO_TOKEN',
      requestId: req.id || null,
    });
  }

  const token = authHeader.split('Bearer ')[1];

  if (!token) {
    return res.status(401).json({
      error: 'You are not signed in. Please log in and try again.',
      code: 'NO_TOKEN',
      requestId: req.id || null,
    });
  }

  // A handful of paths pass through `verifyToken` more than once: `app.js`
  // mounts it on the `app.use(...)` line so `requireFeature` runs behind auth,
  // and the module router then applies it per route as well. Re-verifying is
  // wasted work, and because the per-account limiter runs here it would also
  // charge the caller two or three times for one request, quietly cutting their
  // effective allowance to a half or a third. Recognize the repeat pass by the
  // exact token string already verified on THIS request (matching the cache key
  // rule: a token string identifies one user and one session) and re-run only
  // the email gate, which is pure and cheap.
  if (req.__verifiedToken === token && req.user) {
    if (requireVerifiedEmail && !isEmailVerifiedToken(req.user)) {
      return next(new AppError(
        'Email not verified. Please verify your email address before continuing.',
        403,
        'EMAIL_NOT_VERIFIED'
      ));
    }
    return next();
  }

  try {
    // Short-TTL cache keyed on the FULL token string (see comment above for why
    // that key is safe). On a miss we verify fresh with Firebase and cache the
    // decoded payload; on a hit we reuse the exact same decoded payload. The
    // email-verification gate below runs on the decoded payload either way, so
    // cached and fresh paths behave identically.
    let decodedToken = getCachedDecoded(token);
    if (!decodedToken) {
      // De-dup concurrent cold-cache verifies of the SAME token: the first
      // request kicks off the Firebase call and stashes its promise; any other
      // request arriving with the same token before it resolves awaits that one
      // promise instead of issuing its own (redundant) Firebase round-trip.
      let inflight = inflightVerifications.get(token);
      if (!inflight) {
        // checkRevoked: true makes Firebase reject revoked/disabled sessions on
        // the cold path (see header comment): one extra network round-trip.
        inflight = auth.verifyIdToken(token, true);
        inflightVerifications.set(token, inflight);
        // Always clean up the in-flight entry, success or failure. The trailing
        // .catch() is essential: .finally() returns a NEW promise that rejects
        // whenever `inflight` rejects (e.g. a transient Firebase/DNS network
        // blip). That derivative promise is never awaited, so without a catch
        // handler its rejection becomes an unhandledRejection and crashes the
        // whole process. Awaiting callers still observe the original rejection
        // via `await inflight` inside the try/catch below.
        inflight.finally(() => inflightVerifications.delete(token)).catch(() => {});
      }
      decodedToken = await inflight;
      setCachedDecoded(token, decodedToken);
    }

    // Enforce email verification server-side. The client also checks this, but
    // a valid-but-unverified token could otherwise call the API directly.
    if (requireVerifiedEmail && !isEmailVerifiedToken(decodedToken)) {
      return next(new AppError(
        'Email not verified. Please verify your email address before continuing.',
        403,
        'EMAIL_NOT_VERIFIED'
      ));
    }

    // Attach the decoded token to the request. `__verifiedToken` records WHICH
    // token this was, so a second pass through this middleware on the same
    // request can skip straight past the verify and the per-account limiter.
    req.user = decodedToken;
    req.__verifiedToken = token;

    const usersRepo = require('../../modules/users/users.repository');
    const userData = await usersRepo.findById(decodedToken.uid);
    if (userData) req.userData = userData;
    if (userData?.deletedAt && !allowErasedIdentity) {
      return next(new AppError('This account has been closed.', 401, 'ACCOUNT_ERASED'));
    }

    // Per-account rate limit. It runs HERE rather than as a mount in app.js
    // because the uid it keys on only exists once the token is verified, and
    // every authenticated route reaches the API through this middleware, so one
    // call covers all of them. Requests that never authenticate are left to the
    // IP-keyed global limiter. See shared/middleware/rateLimiters.js for why the
    // account, not the IP, is the right key and how the cap is sized.
    return perUserApiLimiter(req, res, next);

  } catch (error: any) {
    // Token verification failed. Use the request-scoped logger when present so
    // the line carries the request id; fall back to the shared logger otherwise.
    // The `event` + `ip` fields make this a counted security signal: a spike of
    // auth.failed from one IP is the signature of credential stuffing / brute
    // force (see the auth-failure alert in infra/monitoring).
    (req.log || logger).warn({
      event: 'auth.failed',
      requestId: req.id,
      ip: req.ip,
      code: error.code,
      err: error,
    }, 'verifyToken failed');

    // Charge the failure to the per-IP failure budget before answering. Only
    // FAILED verifications are counted, so ordinary traffic never touches this
    // bucket, while a caller spraying garbage tokens (each one a Firebase
    // round-trip on the cold path) is cut off long before the 1000/min global
    // cap would notice. Over the budget the limiter hands its 429 back through
    // this callback instead of letting the 401 through.
    return authFailureLimiter(req, res, (limiterError: any) => {
      if (limiterError) return next(limiterError);
      const payload = authFailurePayload(error);
      return res.status(401).json({ ...payload, requestId: req.id || null });
    });
  }
};

// Default: requires a verified email (the security boundary for the whole API).
export const verifyToken = makeVerifyToken({ requireVerifiedEmail: true });

/** Only the erasure endpoint may use a tombstoned identity to retry cleanup. */
export const verifyTokenForErasure = makeVerifyToken({ requireVerifiedEmail: true, allowErasedIdentity: true });

// Same fresh token verification, but does NOT block unverified emails. Use ONLY
// for the registration bootstrap (`POST /api/auth/create-user`), where a valid
// token exists but the email is verified moments later via the email link.
export const verifyTokenAllowUnverified = makeVerifyToken({ requireVerifiedEmail: false });

/**
 * Optional: Middleware that verifies token but doesn't require it
 * Useful for endpoints that work with or without authentication
 */
export const optionalVerifyToken = async (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No token provided, but that's okay for optional auth
    req.user = null;
    return next();
  }

  const token = authHeader.split('Bearer ')[1];

  if (!token) {
    req.user = null;
    return next();
  }

  // Same short-TTL cache as `verifyToken`, keyed on the full token string, and
  // safe for the same reason (see the cache header comment). Without it every
  // poll of a public signing session by a signed-in user cost a fresh Firebase
  // round-trip, even though the identical request a second earlier had just
  // verified the identical token.
  const cached = getCachedDecoded(token);
  if (cached) {
    req.user = cached;
    return next();
  }

  try {
    // checkRevoked: true for parity with verifyToken. A revoked/disabled
    // session must not pass even on optional-auth (public signing) routes.
    const decodedToken = await auth.verifyIdToken(token, true);
    setCachedDecoded(token, decodedToken);
    req.user = decodedToken;
    return next();
  } catch (error: any) {
    // An invalid token is fine here: these routes work anonymously, and the
    // caller simply continues without a user. But a token that FAILS still cost
    // a Firebase round-trip, and unlike the required-auth path there is no
    // account to charge it to, so the failure goes to the same per-IP bucket
    // `verifyToken` uses. A genuinely anonymous caller sends no Authorization
    // header at all and never reaches this branch, so public access is
    // untouched.
    console.warn('optionalVerifyToken - Invalid token, proceeding without auth');
    return authFailureLimiter(req, res, (limiterError: any) => {
      if (limiterError) return next(limiterError);
      req.user = null;
      return next();
    });
  }
};

/**
 * Middleware to verify user is a specific type (client or firm_member)
 * Use after verifyToken middleware
 */
export const requireUserType = (allowedTypes: any) => {
  return async (req: any, res: any, next: any) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'AUTH_REQUIRED'));
    }

    try {
      // Reuse the per-request user profile if a prior middleware already loaded
      // it (e.g. a chained requireUserType, or a future loader). This avoids the
      // redundant users.findById on routes that resolve the user more than once.
      let userData = req.userData && req.userData.id === req.user.uid ? req.userData : null;

      if (!userData) {
        const usersRepo = require('../../modules/users/users.repository');
        userData = await usersRepo.findById(req.user.uid);
        // Memoize for downstream handlers / middleware on this request.
        if (userData) req.userData = userData;
      }

      if (!userData) {
        return next(new NotFoundError('User'));
      }

      const userType = userData.userType;

      if (!allowedTypes.includes(userType)) {
        return next(new ForbiddenError(
          `This endpoint requires userType: ${allowedTypes.join(' or ')}`
        ));
      }

      next();

    } catch (error: any) {
      console.error('requireUserType - Error:', error);
      // Surface a typed error through the centralized handler instead of a bare
      // generic 500, so the cause/code is clearer to the client and in logs.
      return next(new AppError(
        'Failed to verify user type',
        500,
        'USER_TYPE_LOOKUP_FAILED'
      ));
    }
  };
};

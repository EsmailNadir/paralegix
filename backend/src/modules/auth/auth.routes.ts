import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../shared/http/handler';
const express = require('express');
const router = express.Router();

const { verifyToken, verifyTokenAllowUnverified } = require('../../shared/middleware/auth');
const { AppError } = require('../../shared/errors/AppError');
const { validate } = require('../../shared/middleware/validate');
const {
  authLimiter,
  userExistsLimiter,
  oauthCallbackLimiter,
} = require('../../shared/middleware/rateLimiters');

const {
  checkUserExistsSchema,
  completeRegistrationSchema,
  loginSchema,
  createUserSchema,
  refreshMicrosoftTokenSchema,
  connectMicrosoftSchema,
  connectGoogleSchema,
} = require('./auth.validation');
const authService = require('./auth.service');
const docsSession = require('./docsSession');
import { handler } from '../../shared/http/handler';
import { CalendarConnectError } from '../calendar/shared/calendarGrant';

/** Matches the lifetime of the `oauth_states` row the cookie names. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Reads one query parameter as a plain string.
 *
 * The OAuth callbacks below cannot use `validate()`: a validation failure there
 * has to redirect the browser back with a fixed error code, not throw the JSON
 * error envelope the user would otherwise land on. They still
 * need the guard, because Express parses `?code=a&code=b` into an array and
 * `?code[x]=1` into an object, either of which would reach the token exchange
 * as a non-string.
 * A repeated parameter resolves to its last value; anything else resolves to
 * empty and fails the presence checks the callbacks already perform.
 */
function queryString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return typeof last === 'string' ? last : '';
  }
  return '';
}

// ── Public routes (token verified in service, not middleware) ────────────

// POST /api/auth/check-user-exists
// Tighter dedicated limiter than the shared authLimiter: this endpoint reveals
// whether an address has an account, so it is a stricter enumeration surface.
router.post('/check-user-exists',
  userExistsLimiter,
  validate(checkUserExistsSchema),
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await authService.checkUserExists({ body: req.body });
      res.status(200).json(result);
    } catch (err: any) {
      // Auth errors → 401. Do not include err.message: Firebase SDK text is
      // developer copy, not user copy. The SDK code is logged by the handler.
      if (err.code === 'auth/id-token-expired' || err.code === 'auth/argument-error') {
        return next(new AppError('Your session is invalid. Please log in again.', 401, 'UNAUTHORIZED'));
      }
      next(err);
    }
  },
);

// POST /api/auth/complete-registration
router.post('/complete-registration',
  authLimiter,
  validate(completeRegistrationSchema),
  handler(async (req) => authService.completeRegistration({ body: req.body })),
);

// POST /api/auth/login
router.post('/login',
  authLimiter,
  validate(loginSchema),
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await authService.login({
        body: req.body,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.status(200).json(result);
    } catch (err: any) {
      if (err.code && err.code.startsWith('auth/')) {
        return next(new AppError('Your session is invalid. Please log in again.', 401, 'UNAUTHORIZED'));
      }
      next(err);
    }
  },
);

// POST /api/auth/create-user
// Uses the unverified-allowed variant: a brand-new email/password user creates
// their Postgres record immediately after Firebase signup, before they can have
// verified their email. A valid token is still required.
router.post('/create-user',
  authLimiter,
  verifyTokenAllowUnverified,
  validate(createUserSchema),
  handler(async (req) => authService.createUser({
    userId: req.user.uid,
    authEmail: req.user.email || null,
    body: req.body,
  })),
);

// POST /api/auth/refresh-microsoft-token  (token in body, not header)
router.post('/refresh-microsoft-token',
  authLimiter,
  validate(refreshMicrosoftTokenSchema),
  handler(async (req) => ({ refreshed: await authService.refreshMicrosoftToken({ body: req.body }) })),
);

// ── Authenticated routes (Bearer token in header) ───────────────────────

// GET /api/auth/user-type
// Allows unverified: the /verify-email page polls this (via checkRegistrationStatus)
// while the user's email/password account is still unverified. It only returns the
// caller's own user type, so it is safe to expose pre-verification.
router.get('/user-type',
  verifyTokenAllowUnverified,
  handler(async (req) => authService.getUserType({ userId: req.user.uid })),
);

// GET /api/auth/check-microsoft
router.get('/check-microsoft',
  verifyToken,
  handler(async (req) => authService.checkMicrosoft({ userId: req.user.uid })),
);

// POST /api/auth/unlink-microsoft
router.post('/unlink-microsoft',
  verifyToken,
  handler(async (req) => authService.unlinkMicrosoft({ userId: req.user.uid, removeParalegixEvents: req.body?.removeParalegixEvents === true })),
);

// POST /api/auth/unlink-google
router.post('/unlink-google',
  verifyToken,
  handler(async (req) => authService.unlinkGoogle({ userId: req.user.uid, removeParalegixEvents: req.body?.removeParalegixEvents === true })),
);

// GET /api/auth/check-calendar-access
router.get('/check-calendar-access',
  verifyToken,
  handler(async (req) => authService.checkCalendarAccess({ userId: req.user.uid })),
);

/**
 * The cookie that binds an OAuth state to the browser that started the
 * connection. Without it a state minted by one signed-in person could be
 * completed by whoever that person sends the provider URL to, landing the
 * victim's calendar tokens on the minter's account. The provider's return is a
 * top-level GET on this host, so a SameSite=Lax cookie rides along.
 *
 * Over HTTPS the cookie carries the `__Host-` prefix, which a browser accepts
 * only when it is Secure, host-only and on path `/`, so a sibling subdomain can
 * neither plant nor overwrite it. Local development over plain HTTP cannot set
 * a Secure cookie, so it keeps the unprefixed name scoped to `/api/auth`.
 */
function oauthStateCookie(req: AuthedRequest) {
  const secure = req.secure || process.env.NODE_ENV === 'production';
  return secure
    ? { name: '__Host-plx_oauth_state', options: { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' } }
    : { name: 'plx_oauth_state', options: { httpOnly: true, secure: false, sameSite: 'lax' as const, path: '/api/auth' } };
}

/** Read one cookie off the raw header; the app carries no cookie parser. */
function readCookie(req: AuthedRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(at + 1).trim()); } catch { return null; }
  }
  return null;
}

/**
 * Send the browser back from a callback. Only `<provider>_connected=true` or a
 * fixed `<provider>_error` code is ever appended, never a provider or server
 * message, and a missing return URL lands on the dashboard.
 */
function connectRedirect(res: Response, provider: 'google' | 'microsoft', returnUrl: string | null, outcome: string) {
  const base = returnUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard`;
  const sep = base.includes('?') ? '&' : '?';
  const param = outcome === 'connected'
    ? `${provider}_connected=true`
    : `${provider}_error=${encodeURIComponent(outcome)}`;
  res.redirect(`${base}${sep}${param}`);
}

/** One handler for both provider callbacks. */
function oauthCallback(provider: 'google' | 'microsoft', complete: (input: any) => Promise<{ returnUrl: string | null }>) {
  return handler(async (req, res) => {
    const cookie = oauthStateCookie(req);
    const browserState = readCookie(req, cookie.name);
    res.clearCookie(cookie.name, cookie.options);
    try {
      const result = await complete({
        code: queryString(req.query.code),
        state: queryString(req.query.state),
        browserState,
        providerError: queryString(req.query.error),
        providerErrorDescription: queryString(req.query.error_description),
      });
      connectRedirect(res, provider, result.returnUrl, 'connected');
    } catch (err: any) {
      if (err instanceof CalendarConnectError) {
        console.warn(`auth.routes: ${provider} connection refused:`, err.code);
        return connectRedirect(res, provider, err.returnUrl, err.code);
      }
      console.error(`auth.routes: ${provider} callback error:`, err?.cause?.code ?? err?.code ?? 'unknown');
      connectRedirect(res, provider, null, 'exchange_failed');
    }
  });
}

// POST /api/auth/connect-google (Initiate OAuth2 code flow for Google calendar tokens)
router.post('/connect-google',
  verifyToken,
  validate(connectGoogleSchema),
  handler(async (req, res) => {
    const { state, ...body } = await authService.initGoogleConnect({
      userId: req.user.uid,
      returnUrl: req.body.returnUrl,
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
    const cookie = oauthStateCookie(req);
    res.cookie(cookie.name, state, { ...cookie.options, maxAge: OAUTH_STATE_TTL_MS });
    return body;
  }),
);

// GET /api/auth/google-callback (OAuth2 callback from Google)
router.get('/google-callback',
  oauthCallbackLimiter,
  oauthCallback('google', authService.handleGoogleCallback),
);

// POST /api/auth/connect-microsoft (Initiate OAuth2 code flow for Microsoft calendar tokens)
router.post('/connect-microsoft',
  verifyToken,
  validate(connectMicrosoftSchema),
  handler(async (req, res) => {
    const { state, ...body } = await authService.initMicrosoftConnect({
      userId: req.user.uid,
      returnUrl: req.body.returnUrl,
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
    const cookie = oauthStateCookie(req);
    res.cookie(cookie.name, state, { ...cookie.options, maxAge: OAUTH_STATE_TTL_MS });
    return body;
  }),
);

// GET /api/auth/microsoft-callback (OAuth2 callback from Microsoft)
router.get('/microsoft-callback',
  oauthCallbackLimiter,
  oauthCallback('microsoft', authService.handleMicrosoftCallback),
);

// ── Documentation site session ───────────────────────────────────────────

// POST /api/auth/docs-session
// Trade the caller's verified Firebase ID token for the docs cookie. The app's
// /docs entry page calls this immediately before sending the user to the docs
// host, so an expired cookie re-mints itself on the next visit.
// verifyToken already applies the per-user limiter on success and the failure
// limiter on a bad token, so no extra IP-keyed limiter here: sharing authLimiter
// with the login endpoints would let one office's docs traffic throttle its own
// sign-ins.
router.post('/docs-session',
  verifyToken,
  handler(async (req, res) => {
    const expiresIn = docsSession.issue(res, { uid: req.user.uid, email: req.user.email });
    return { expiresIn };
  }),
);

// DELETE /api/auth/docs-session
// Deliberately unauthenticated: sign-out has already discarded the ID token by
// the time the app calls this, and requiring one would mean the cookie outlived
// every sign-out. Clearing a cookie the caller already holds grants nothing.
router.delete('/docs-session', (req: any, res: any) => {
  docsSession.clear(res);
  res.status(200).json({ message: 'Documentation session cleared' });
});

export = router;

const rateLimit = require('express-rate-limit');
const { createPgRateLimitStore } = require('./pgRateLimitStore');
const { AppError } = require('../errors/AppError');

/**
 * Shared factory for express-rate-limit limiters backed by the cross-instance
 * Postgres store (`rate_limits` table). Centralizing keeps every limiter
 * consistent (standard headers, error envelope, durable store) and tunable.
 *
 * Every limiter MUST pass a UNIQUE `prefix` so limiters don't share a keyspace
 * in the shared table. Per-IP limiters should OMIT `keyBy`: the library default
 * keys by the client IP (with IPv6 normalization). Pass `keyBy` only to key on
 * something other than the IP, e.g. a URL token param or the caller's uid.
 *
 * Every limiter lives in this file rather than next to the route it guards, so
 * the whole rate-limit surface can be read and tuned in one place.
 */

const DEFAULT_MESSAGE = 'Too many requests. Please wait a moment and try again.';

export function makeLimiter({ prefix, windowMs, max, keyBy, message, skip }: any) {
  const options = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: createPgRateLimitStore(prefix),
    // Rejections go through the app's error pipeline instead of
    // express-rate-limit's own response, so a 429 carries the same envelope as
    // every other error (`{ error, code, requestId }`). `Retry-After` and the
    // `RateLimit-*` headers are already set by the time this runs, and the
    // frontend reads them to render a countdown.
    handler: (req: any, res: any, next: any) => next(
      new AppError(message || DEFAULT_MESSAGE, 429, 'RATE_LIMITED'),
    ),
  };
  if (keyBy) (options as Record<string, unknown>).keyGenerator = keyBy;

  // RATE_LIMITS_DISABLED makes every limiter inert. It exists for the in-process
  // test harness (tests/support/setupInProcess.ts sets it), where live limiters
  // do two kinds of damage: the store is Postgres-backed, so each request gains
  // a write and unrelated specs couple through one shared table, and the caps are
  // sized for one human rather than a suite replaying a month of traffic in
  // seconds, so a correctly behaving test is answered 429.
  //
  // Deliberately NOT keyed on NODE_ENV, which Jest sets to 'test' for every spec
  // including tests/shared/rateLimiters.test.ts, whose whole purpose is to assert
  // that a limiter rejects at its cap. An explicit flag lets that suite keep
  // testing real behaviour while the in-process suite opts out.
  const disabledByEnv = () => process.env.RATE_LIMITS_DISABLED === 'true';
  (options as Record<string, unknown>).skip = skip
    ? (req: any, res: any) => disabledByEnv() || skip(req, res)
    : disabledByEnv;

  return rateLimit(options);
}

const MINUTE = 60 * 1000;

// Key for the per-ACCOUNT limiters. They must be mounted after `verifyToken`
// (or on a router that applies it); the explicit throw turns a mis-mount into a
// legible server error instead of a bare "cannot read properties of undefined".
const byUid = (req: any) => {
  if (!req.user?.uid) {
    throw new Error('A uid-keyed rate limiter was mounted before verifyToken');
  }
  return req.user.uid;
};

// Per-ACCOUNT backstop for every authenticated request, applied by `verifyToken`
// once the caller's uid is known (shared/middleware/auth.js).
//
// The IP-keyed global limiter is the wrong instrument for signed-in traffic in
// both directions: a law firm behind one office NAT shares a single bucket no
// matter how many people are working, while one account driving traffic from
// rotating IPs never fills any bucket at all. Keying on the Firebase uid gives
// every user their own allowance, so adding users or data can never make the
// firm as a whole run out.
//
// The cap is a nonsense detector, not a throttle. The server-paged grids turned
// what used to be one bulk fetch into a request per page change, sort, filter
// and settled search keystroke, but even a busy screen is tens of requests, not
// hundreds: 600/min leaves an order of magnitude of headroom over anything a
// person clicking a UI can produce. Raise USER_RATE_LIMIT_MAX if that ever
// proves tight.
export const perUserApiLimiter = makeLimiter({
  prefix: 'user-api',
  windowMs: MINUTE,
  max: Number(process.env.USER_RATE_LIMIT_MAX || 600),
  keyBy: byUid,
  message: 'Too many requests from this account. Please wait a moment and try again.',
});

// Tighter per-ACCOUNT bucket for the reads whose cost did NOT fall when the
// lists were server-paged, and which therefore multiply badly now that a screen
// issues many requests instead of one:
//   - the firm billing lists build their whole derived set in memory and then
//     slice it, so every page costs what the unpaged read used to
//     (billing/shared/firmBillingWindow.js)
//   - the files folder listing, search, folder download and storage-usage
//     recount all scan the entire recursive storage subtree, because a
//     subfolder's counts are derived from that scan
//   - the client-portal document lists page their storage prefix to exhaustion
//
// Still generous: 240/min is a sustained four requests a second on these
// endpoints alone, well past anything a paging UI generates, so a firm with a
// large matter or a long invoice history is unaffected. Its job is to stop one
// account from parking on a scan-heavy endpoint in a loop.
//
// Mount it AFTER `verifyToken` (or on a router that applies it), which is what
// lets it key on the uid unconditionally.
export const heavyReadLimiter = makeLimiter({
  prefix: 'heavy-read',
  windowMs: MINUTE,
  max: Number(process.env.HEAVY_READ_RATE_LIMIT_MAX || 240),
  keyBy: byUid,
  message: 'Too many requests for this data. Please wait a moment and try again.',
});

// Per-ACCOUNT bucket for resumable upload handshakes that mint signed URLs.
//
// The per-account cap alone would allow 600 of these a minute, a very large
// ceiling on transient memory and inbound bandwidth. The firm storage quota
// bounds what is finally PERSISTED, not what is buffered and then rejected, so
// uploads need their own smaller allowance. 120/min is two a second sustained,
// far past what picking files in a browser produces.
//
export const uploadLimiter = makeLimiter({
  prefix: 'upload',
  windowMs: MINUTE,
  max: Number(process.env.UPLOAD_RATE_LIMIT_MAX || 120),
  keyBy: byUid,
  message: 'Too many uploads. Please wait a moment and try again.',
});

// Coarse per-IP backstop across the whole API, stopping volumetric abuse from a
// single source. Tune with GLOBAL_RATE_LIMIT_MAX. Skips health, cron, and
// webhooks: those carry their own auth/signature gates, and provider push
// webhooks (Google/Outlook/Stripe) can be legitimately high-frequency from one IP.
//
// It also skips bearer requests to the firm routes. A law office shares one
// public address, and a staging load test measured about 22 requests a minute
// per active user, so roughly 45 people in one office would exhaust a single
// per-IP bucket. Every route under /api/lawfirms runs verifyToken, so those
// requests stay bounded either way: a valid token by perUserApiLimiter on its
// uid, a forged one by the per-IP authFailureLimiter. Elsewhere a bearer header
// is not verified by every route, so it buys nothing there.
const FIRM_ROUTES = /^\/api\/lawfirms\/[^/]+(?:\/|$)/;
const hasBearer = (req: any) => /^Bearer \S+/.test(String(req.headers?.authorization || ''));

export const globalApiLimiter = makeLimiter({
  prefix: 'global',
  windowMs: MINUTE,
  max: Number(process.env.GLOBAL_RATE_LIMIT_MAX || 1000),
  message: 'Too many requests from this network. Please slow down and try again shortly.',
  skip: (req: any) => {
    const path = (req.originalUrl || req.url || '').split('?')[0];
    return path === '/api/health'
      || path.startsWith('/api/webhooks/')
      || path.startsWith('/api/cron/')
      || (FIRM_ROUTES.test(path) && hasBearer(req));
  },
});

// Per-IP limiter for the public auth endpoints. Each call runs a Firebase token
// verification (and registration additionally fans out invite-processing
// queries), so this bounds abuse and enumeration.
export const authLimiter = makeLimiter({
  prefix: 'auth',
  windowMs: MINUTE,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 30),
});

// Per-IP limiter for FAILED token verifications, applied in `verifyToken`'s
// catch block (shared/middleware/auth.js).
//
// The per-account limiter can only run once a token has verified, so a caller
// spraying garbage tokens never reaches a per-account bucket and is bounded only
// by the 1000/min global cap. Every cold verify is a network round-trip to
// Firebase, which makes that a cheap way to burn quota and add latency. Counting
// only failures leaves legitimate traffic untouched: a real client produces a
// burst of 401s at most when its token expires mid-page, then refreshes.
export const authFailureLimiter = makeLimiter({
  prefix: 'auth-fail',
  windowMs: MINUTE,
  max: Number(process.env.AUTH_FAILURE_RATE_LIMIT_MAX || 100),
  message: 'Too many failed authentication attempts. Please wait a moment and try again.',
});

// Tighter per-IP bucket for the email-existence oracle. check-user-exists lets a
// caller probe whether an address has an account, so it gets a stricter cap than
// the general auth bucket to blunt enumeration.
export const userExistsLimiter = makeLimiter({
  prefix: 'user-exists',
  windowMs: MINUTE,
  max: Number(process.env.USER_EXISTS_RATE_LIMIT_MAX || 10),
});

// Per-IP limiter for the public OAuth callbacks. The `state` param is already a
// single-use 256-bit token (invalid/expired state is rejected and consumed), so
// this is a cheap backstop against someone spraying random state values.
export const oauthCallbackLimiter = makeLimiter({
  prefix: 'oauth-cb',
  windowMs: MINUTE,
  max: Number(process.env.OAUTH_CALLBACK_RATE_LIMIT_MAX || 20),
});

// Per-IP limiter for the public, unauthenticated invitation-lookup reads. Invite
// tokens are 256-bit random so enumeration is infeasible; this bounds scraping
// and abusive polling.
export const inviteLookupLimiter = makeLimiter({
  prefix: 'invite-lookup',
  windowMs: MINUTE,
  max: Number(process.env.INVITE_LOOKUP_RATE_LIMIT_MAX || 30),
});

// Per-IP limiter for the public file-share links. The token in the URL is the
// sole credential, so this blunts token and share-password guessing.
export const publicShareLimiter = makeLimiter({
  prefix: 'public-share',
  windowMs: MINUTE,
  max: Number(process.env.PUBLIC_SHARE_RATE_LIMIT_MAX || 30),
  message: 'Too many requests for this link. Please wait a moment and try again.',
});

// The secure payment link's public routes, keyed by IP like the share links.
export const publicPayLimiter = makeLimiter({
  prefix: 'public-pay',
  windowMs: MINUTE,
  max: Number(process.env.PUBLIC_PAY_RATE_LIMIT_MAX || 30),
  message: 'Too many requests for this payment link. Please wait a moment and try again.',
});

// Per-ACCOUNT write cap for in-app messaging, covering firm direct sends, firm
// group sends and client group sends (they share this bucket). Keyed on the uid
// rather than the IP: an office on one NAT would otherwise share a single
// allowance between everyone, while 30/min is a message every two seconds for
// ONE person, already past human typing speed.
export const messageSendLimiter = makeLimiter({
  prefix: 'msg-send',
  windowMs: MINUTE,
  max: Number(process.env.MESSAGE_SEND_RATE_LIMIT_MAX || 30),
  keyBy: byUid,
  message: 'You are sending messages too quickly. Please wait a moment and try again.',
});

// The client portal's own message-send bucket, kept separate from the firm side
// so a noisy portal client can never consume a firm member's allowance.
export const portalMessageSendLimiter = makeLimiter({
  prefix: 'portal-msg-send',
  windowMs: MINUTE,
  max: Number(process.env.PORTAL_MESSAGE_SEND_RATE_LIMIT_MAX || 30),
  keyBy: byUid,
  message: 'You are sending messages too quickly. Please wait a moment and try again.',
});

// Per-ACCOUNT cap on starting an identity verification. Each start opens a paid
// provider session, and a person verifies once, so ten an hour leaves room for
// retries after a cancel or a failed scan while bounding what one account can
// cost the firm.
export const identityVerificationStartLimiter = makeLimiter({
  prefix: 'identity-verify-start',
  windowMs: 60 * MINUTE,
  max: Number(process.env.IDENTITY_VERIFICATION_START_RATE_LIMIT_MAX || 10),
  keyBy: byUid,
  message: 'Too many identity verification attempts. Please wait a while and try again.',
});

// Per-ACCOUNT cap on document conversion (DOCX and friends to PDF), which shells
// out to a converter and is the most CPU-expensive authenticated request in the
// app. Keyed on the uid: keyed on the IP this was 20 per 15 minutes for an
// entire office, which one person preparing a batch of signature packets could
// exhaust on their own.
export const documentConvertLimiter = makeLimiter({
  prefix: 'convert',
  windowMs: 15 * MINUTE,
  max: Number(process.env.CONVERT_RATE_LIMIT_MAX || 30),
  keyBy: byUid,
  message: 'Too many document conversions. Please wait a few minutes and try again.',
});

// Per-ACCOUNT cap on template renders: fill, preview and PDF export share one
// allowance, because each ends in a render on the same small resource (one
// export and two fills per API instance, a two-instance document worker). Its
// own keyspace rather than `documentConvertLimiter`'s: a Word download of an
// HTML template is an export AND a conversion, and someone generating a batch
// of letters would exhaust a shared thirty. The in-flight cap in
// `templateFillSlot.ts` handles bursts; this bounds a sustained stream.
export const templateRenderLimiter = makeLimiter({
  prefix: 'template-render',
  windowMs: 15 * MINUTE,
  max: Number(process.env.TEMPLATE_RENDER_RATE_LIMIT_MAX || 60),
  keyBy: byUid,
  message: 'Too many documents prepared in a short time. Please wait a few minutes and try again.',
});

// Signing action limiter, keyed on the URL signing token (NOT the IP): the
// expensive, email-sending, side-effectful signer actions (complete/decline)
// are per-session, so a single link can't be hammered even from rotating IPs.
export const signingActionLimiter = makeLimiter({
  prefix: 'sign-action',
  windowMs: MINUTE,
  max: Number(process.env.SIGNING_ACTION_RATE_LIMIT_MAX || 10),
  keyBy: (req: any) => req.params.token,
  message: 'Too many attempts on this signing session. Please wait a moment and try again.',
});

// Per-IP limiter for the public signing reads (status poll, session metadata,
// document stream). Bounds enumeration and bandwidth abuse while staying well
// above what a legitimate signer polling their own session needs.
export const signingReadLimiter = makeLimiter({
  prefix: 'sign-read',
  windowMs: MINUTE,
  max: Number(process.env.SIGNING_READ_RATE_LIMIT_MAX || 120),
});

// Per-IP limiter for the fully anonymous signed-PDF verification endpoint, which
// accepts an upload and hashes it. Tight because there is no token or account to
// key on and the work is entirely attacker-triggered.
export const signingVerifyLimiter = makeLimiter({
  prefix: 'sign-verify',
  windowMs: MINUTE,
  max: Number(process.env.SIGNING_VERIFY_RATE_LIMIT_MAX || 10),
  message: 'Too many verification attempts. Please wait a moment and try again.',
});

// Access-code gate on a signing session, keyed on the signing token. This is the
// fast outer layer only: the real brute-force control is the durable soft/hard
// lock recorded on the signature session itself, which survives a degraded
// limiter.
export const signingGateLimiter = makeLimiter({
  prefix: 'gate-verify',
  windowMs: MINUTE,
  max: Number(process.env.SIGNING_GATE_RATE_LIMIT_MAX || 5),
  keyBy: (req: any) => req.params.token,
  message: 'Too many verification attempts. Please wait a moment and try again.',
});

// Per-IP limiter for the public intake form READ (GET /api/intake/:token).
//
// Deliberately keyed on the address and NOT on the token. That token is public
// by design: it is the whole of a firm's lead-generation link, printed on a
// site, an email footer or an ad. Keyed on the token, the 30/min allowance is
// firm-wide for that form, so any anonymous caller could spend it in two seconds
// and blank the page for every real prospect. Guessing a token is infeasible
// (it is random), so per-address is the right shape for this route: it bounds
// scraping without giving anyone a way to take the form down.
export const intakeReadLimiter = makeLimiter({
  prefix: 'intake-read',
  windowMs: MINUTE,
  max: Number(process.env.INTAKE_READ_RATE_LIMIT_MAX || 30),
});

// Access-code gate on a public intake form, keyed on the URL token. Mirrors
// `signingGateLimiter`, and mounted on POST /:token/verify-access-code ONLY.
//
// The gate needs the OPPOSITE key from the read above, which is why it is a
// separate limiter rather than a `keyBy` added to `intakeReadLimiter`. Here the
// secret is the access code, and the code is typed by a firm member rather than
// generated, so its entropy is whatever someone chose. Keyed on the address, a
// caller with rotating IPs gets unlimited guesses. Keyed on the token, every
// guess at one form counts against one bucket however many addresses it comes
// from. The two routes cannot share a bucket: one limiter covering both would
// force one key on both, and keying the pair by token would cap the public
// page's LOAD at the same allowance, trading a confidentiality hole for an
// availability hole on the surface that exists to attract clients.
//
// This is the ONLY brute-force control on the intake gate, and unlike signing
// there is deliberately no durable lock behind it. Signing's lock lives on
// `signature_participants`, so tripping it denies ONE named signer. The intake
// code lives on the TEMPLATE (`intake_form_templates.access_code_hash`) and is
// shared by every recipient, so the same design here would let a stranger
// hard-lock a firm's entire lead pipeline with a handful of wrong guesses. If a
// durable counter is ever wanted, it belongs on `intake_submissions`, the true
// per-recipient analogue of a signing participant, and it can only cover the
// targeted-send token space, never the generic embed.
export const intakeGateLimiter = makeLimiter({
  prefix: 'intake-gate',
  windowMs: MINUTE,
  max: Number(process.env.INTAKE_GATE_RATE_LIMIT_MAX || 5),
  keyBy: (req: any) => req.params.token,
  message: 'Too many attempts on this form. Please wait a moment and try again.',
});

// Per-token limiter for intake form submits so one link cannot be submission-bombed.
export const intakeSubmitLimiter = makeLimiter({
  prefix: 'intake-submit',
  windowMs: MINUTE,
  max: Number(process.env.INTAKE_SUBMIT_RATE_LIMIT_MAX || 5),
  keyBy: (req: any) => req.params.token,
  message: 'Too many submissions for this form. Please wait a moment and try again.',
});

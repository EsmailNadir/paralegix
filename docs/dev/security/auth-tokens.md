# Authentication & Token Model

How Paralegix identifies a caller, verifies their Firebase ID token on every request, and decides who counts as "verified".

## Summary

Every authenticated API request carries a Firebase ID token in the
`Authorization: Bearer <token>` header. The backend verifies that token with the
**Firebase Admin SDK**, and never trusts a token it has not validated itself. A
cold verify calls Firebase with `checkRevoked: true`; a 30s cache keyed on the
full token string absorbs repeats, so revocation latency is bounded to that TTL
rather than being unbounded. Firebase is used **only** for Auth (and, separately, GCS
storage) — it is never a data store. Identity comes from the decoded token
(`req.user.uid`, the Firebase UID); everything else about a user (their
`userType`, firm memberships, permissions) is read from Postgres.

Verification is centralized in `backend/src/shared/middleware/auth.ts`, which
exposes four middlewares:

- `verifyToken` — the default gate. Verifies the token **and** enforces email
  verification. Nearly every route uses it.
- `verifyTokenAllowUnverified` — same fresh verification, but does **not** block
  an unverified email. Used only by the registration bootstrap
  (`POST /api/auth/create-user`), where a brand-new email/password user has a
  valid token but cannot have verified their email yet, and by
  `GET /api/auth/user-type`, which the verify-email page polls and which returns
  only the caller's own user type (`backend/src/modules/auth/auth.routes.ts:127`).
- `optionalVerifyToken` — attaches `req.user` if a valid token is present,
  otherwise sets `req.user = null` and proceeds. For endpoints that work with or
  without auth (e.g. public signing routes).
- `requireUserType(allowedTypes)` — runs after `verifyToken`; loads the user's
  Postgres profile and rejects unless their `userType` is in the allow-list.

## Key Takeaways

- **Tokens are re-verified every request, never cached across identities.** The
  cold path calls `auth.verifyIdToken(token, true)` — the `true` is
  `checkRevoked`, so a revoked session or disabled account is rejected on the
  next cold verify. There is a short-TTL cache, but it is keyed on the **full
  token string** (not the UID) and only stores successful verifications. See the
  cache section for why the key matters.
- **Server-side email verification is a real boundary, not a UI hint.** A valid
  but unverified password token is rejected with `403 EMAIL_NOT_VERIFIED` even
  if it calls the API directly. OAuth sign-ins pass automatically because the
  provider vouches for the email.
- **The verification allow-list is the exemption mechanism.** Only accounts on
  the `EMAIL_VERIFICATION_WHITELIST` (env, deploy-time) or the
  `email_verification_whitelist` table (managed live from the admin panel) skip
  the check. Default is empty — no account is exempt.
- **Firebase is Auth + storage only.** `backend/src/shared/database/firebase.ts`
  exports `auth` and an `admin` shim (`admin.storage()`); it never touches
  data. All data access goes through Postgres.
- **The frontend never persists the raw token.** The Firebase SDK owns session
  persistence; the live token is fetched on demand. Nothing is written to
  `localStorage`.

## Request-time verification

`makeVerifyToken({ requireVerifiedEmail })` in
`backend/src/shared/middleware/auth.ts:201` is the factory behind both
`verifyToken` and `verifyTokenAllowUnverified`. Per request it:

1. Rejects a missing/malformed `Authorization` header with `401 NO_TOKEN`.
2. Looks the token up in the short-TTL cache; on a miss, verifies fresh against
   Firebase with `checkRevoked: true` and caches the decoded payload.
3. Runs the email-verification gate on the decoded payload (see below).
4. Attaches the decoded token to `req.user` and calls `next()`.

Verification failures are logged as a counted security signal
(`event: 'auth.failed'` with the client `ip`) at `auth.ts:303`, then mapped to
specific responses:

| Firebase error code | HTTP | Response `code` |
|---|---|---|
| `auth/id-token-expired` | 401 | `TOKEN_EXPIRED` |
| `auth/id-token-revoked` | 401 | `TOKEN_REVOKED` |
| `auth/user-disabled` | 401 | `ACCOUNT_DISABLED` |
| `auth/argument-error` | 401 | `INVALID_TOKEN` |
| anything else | 401 | `AUTH_FAILED` |

The `id-token-revoked` and `user-disabled` branches are only reachable because
the cold path passes `checkRevoked: true`.

The factory also applies rate limiting: a verified request runs through
`perUserApiLimiter`, and a failed verify runs `authFailureLimiter` (per IP)
before the error response (`auth.ts:295`, `auth.ts:317`; both from
`shared/middleware/rateLimiters`). Routes that sit behind `verifyToken` therefore
need no extra IP-keyed limiter of their own.

### The verified-token cache

The cache (`auth.ts:80`) is a bounded LRU `Map` with a 30-second TTL and a
periodic sweep. Its safety hinges on the **key**:

- **Keyed on the full ID-token string, not the UID.** A prior cache keyed on the
  Firebase UID caused a critical cross-user bug: user A's decoded token was
  served for user B after a logout/login in the same browser, because a UID is
  shared across many tokens/sessions. A token string uniquely identifies exactly
  one user and one session, so a hit can only ever return that token's own
  payload.
- **Never serves a stale or expired entry.** An entry is dropped once either the
  30s wall-clock TTL passes or the token's own `exp` is reached.
- **Only successful verifications are cached.** Failures are never stored.
- **Revocation latency is bounded by the TTL.** A token already cached is
  honored for up to 30s after `auth.revokeRefreshTokens()`; the next cold verify
  then re-checks Firebase and rejects it.

Concurrent cold-cache verifies of the **same** token are collapsed into one
Firebase round-trip via an in-flight promise map (`auth.ts:254`), so a burst of
requests with one fresh token does not fan out into many redundant network
calls.

## Email verification enforcement

`isEmailVerifiedToken(decoded)` at `auth.ts:37` decides who is "verified",
mirroring the client logic so server and client agree:

- `email_verified === true` on the token → verified.
- Non-password sign-in providers (`google.com` / `microsoft.com`) → verified.
  OAuth providers already vouch for the email.
- A password sign-in with `email_verified === false` → verified **only** if the
  email is on the allow-list (`isWhitelisted`, sourced from
  `shared/utils/emailWhitelist`, unioning the `EMAIL_VERIFICATION_WHITELIST` env
  var and the `email_verification_whitelist` table).
- Otherwise → rejected with `403 EMAIL_NOT_VERIFIED`.

A non-empty **env** allow-list in production logs a loud startup warning
(`auth.ts:33`) because it is a real security relaxation; the count is logged,
never the addresses. DB-managed test accounts are intentional and not warned.

## Sign-in paths

Three paths mint the tokens the backend later verifies. All converge on the same
`req.user` decoded-token shape.

1. **Email / password + verification.** The client signs up via the Firebase
   SDK, then verifies the email through a Firebase link. The bootstrap route
   `POST /api/auth/create-user` uses `verifyTokenAllowUnverified` so the Postgres
   user record can be created in the window before the email link is clicked;
   every other route except `GET /api/auth/user-type` then requires the verified
   email.
2. **Google / Microsoft OAuth.** The provider popup returns a token with
   `email_verified: true` and a non-password `sign_in_provider`, so it clears the
   verification gate automatically. Calendar-connect OAuth (a separate
   authorization-code flow for calendar scopes) is CSRF-protected by the
   `oauth_states` table — see below.
3. **Login.** An existing user signs in through the SDK; subsequent API calls
   carry the ID token and flow through `verifyToken` like any other request.

## User types

The Postgres `users` table (`user_type`, `backend/db/schema/10_identity.sql:10`) constrains a user to
one of three types: `firm_member`, `client`, or `pending` (the default at
signup, before a type is chosen). `requireUserType(allowedTypes)` at
`auth.ts:392` loads the profile via `users.repository.findById(req.user.uid)`,
memoizes it on `req.userData`, and throws `403` unless the user's type is
allowed. The Firebase UID is the identity key throughout (`users.id` is the
Firebase UID, a `text` column, not a UUID).

## OAuth state (CSRF protection)

The calendar OAuth authorization-code flows in
`backend/src/modules/auth/auth.service.ts` guard against CSRF and replay with the
`oauth_states` table (`backend/db/schema/10_identity.sql:151`):

- On init (`initGoogleConnect` / `initMicrosoftConnect`), a single-use
  **256-bit** `state` is generated with `crypto.randomBytes(32)` and inserted
  alongside the `user_id`, `provider`, `redirect_uri`, and a sanitized
  `return_url` (`auth.service.ts:833`).
- On callback (`handleGoogleCallback` / `handleMicrosoftCallback`), the `state`
  row is looked up through `tokenQuery` (the state is the bound token); a missing
  row is rejected as invalid, and a row older than the 10-minute TTL is deleted
  and rejected as expired (`auth.service.ts:871`).
- The row is **deleted immediately on use** (`auth.service.ts:878`), so a `state`
  can never be replayed.

## Docs-site session (`plx_docs`)

The internal docs site is a separate static deployment that cannot read the
Firebase session, so the app trades a verified ID token for a second, much
narrower credential (`backend/src/modules/auth/docsSession.ts`):

- **`POST /api/auth/docs-session`** runs behind `verifyToken` (so email
  verification and the rate limiters above apply) and sets an httpOnly cookie
  holding an HS256 JWT signed with `DOCS_SESSION_SECRET`. Claims are `sub` (the
  Firebase uid), `email`, and `scope: 'docs'`; lifetime is 12 hours
  (`TTL_SECONDS`).
- **Cookie attributes** come from one `cookieOptions()` so issue and clear always
  match: `SameSite=Lax`, `Secure` in production, `path=/`, and a parent-domain
  `Domain` from `DOCS_COOKIE_DOMAIN` (unset in local dev). The name is
  `DOCS_COOKIE_NAME`, default `plx_docs`; staging and prod share a parent domain,
  so they need distinct names.
- **Verification is offline.** `docs/middleware.ts` (Vercel edge) checks the
  HMAC and requires `scope === 'docs'`. It serves 503 when `DOCS_SESSION_SECRET`
  is unset, and the API answers `503 DOCS_SESSION_UNCONFIGURED` when asked to mint
  without it.
- **It authorizes reading the guide and nothing else.** It carries no firm scope
  or permissions, and no API route accepts it as authentication. Because
  verification is offline, revocation is bounded by the 12-hour TTL.
- **`DELETE /api/auth/docs-session`** clears the cookie and is deliberately
  unauthenticated: sign-out has already discarded the ID token by then.

## Where the frontend holds auth

Auth is **not** a React context. `frontend/src/hooks/useAuth.ts` subscribes to
Firebase `onAuthStateChanged` and returns `{ user, loading }`; sign-in/up/out
live in `frontend/src/services/auth.service.ts`. Read the Firebase user through
`useAuth()` from `@/hooks/useAuth` and nowhere else.

> There used to be a second `frontend/src/context/AuthContext.js` whose provider
> was never mounted, so every consumer silently received an undefined user (Log
> Time, for one, never pre-selected the timekeeper). It has been deleted. If you
> find an import of it in an old branch or doc, that code was reading `undefined`.

The raw ID token is deliberately **not** persisted. The Firebase SDK manages
session persistence and the live token is fetched on demand, keeping an
XSS-reachable, staleness-prone token out of `localStorage`. Sign-out also sweeps
the app's own `localStorage` / `sessionStorage` keys that carry matter, client or
billing content (timers, note drafts, list filters, calendar-sync state), listed
in `CLEAR_ON_SIGN_OUT_PREFIXES` in `frontend/src/services/auth.service.ts`, so
none of it outlives the session on a shared workstation. UI-only preferences such
as the theme are kept.

## Source

- `backend/src/shared/middleware/auth.ts` — `verifyToken`, `verifyTokenAllowUnverified`, `optionalVerifyToken`, `requireUserType`, token cache, email gate
- `backend/src/shared/database/firebase.ts` — Firebase Admin init; Auth + GCS only
- `backend/src/shared/utils/emailWhitelist.ts` — allow-list sources unioned
- `backend/src/modules/auth/auth.service.ts` — OAuth init/callback + `oauth_states`
- `backend/src/modules/auth/docsSession.ts`: docs-site session cookie; `docs/middleware.ts`: its edge verifier
- `backend/db/schema/10_identity.sql`: `oauth_states` table, `users.user_type` constraint (`backend/db/schema.sql` is generated from `backend/db/schema/*.sql`)
- `frontend/src/hooks/useAuth.ts`: client auth state, no token persistence
- `frontend/src/services/auth.service.ts`: sign-in/out, sign-out storage sweep

## Related

- [/dev/security/rbac-permissions](/dev/security/rbac-permissions) — permissions after authentication
- [/dev/security/multi-tenancy](/dev/security/multi-tenancy) — tenant isolation
- [/dev/admin/rate-limiting](/dev/admin/rate-limiting) — throttling the auth surface

# Authentication & Email Verification

## Summary

Paralegix uses **Firebase Authentication** as its sole identity provider (email/password plus Google and Microsoft OAuth). Firebase issues a JWT ID token to the browser; the Express backend verifies that token with the **Firebase Admin SDK** and uses the decoded Firebase UID as the primary key of the Postgres `users` table. There is no app-managed password store or session table — Firebase owns credentials and sessions, Postgres owns the user profile (`user_type`, name, email) and all tenant data.

Email verification is a **server-side security boundary**. The default `verifyToken` middleware rejects valid-but-unverified password tokens with a 403 (`EMAIL_NOT_VERIFIED`); OAuth/non-password sign-ins and an env-configured whitelist are exempt. A second `verifyTokenAllowUnverified` variant — produced by the same `makeVerifyToken` factory — is wired into exactly the onboarding routes (`POST /api/auth/create-user`, `GET /api/auth/user-type`), where a brand-new email/password user legitimately holds a valid token before they can possibly have clicked the verification link.

Token verification is now backed by a **short-TTL (30s) cache keyed on the full ID-token string** so the per-request Firebase round-trip is skipped on hot paths, without re-introducing the cross-user bug that a UID-keyed cache once caused. The cold (cache-miss) path now passes `checkRevoked: true` to Firebase, de-dups concurrent verifies of the same token, and a periodic sweep prunes expired entries.

## Key Takeaways

- **Identity = Firebase, profile = Postgres.** Firebase Admin (`backend/src/shared/database/firebase.ts`) is retained ONLY for Auth and GCS, never data. The `users` table PK is the Firebase UID, stored as `text` (`backend/db/schema/10_identity.sql:5-26`).
- **Tokens are verified through a short-TTL cache keyed on the full token string.** `makeVerifyToken` (`backend/src/shared/middleware/auth.ts:201`) checks `getCachedDecoded(token)` first and only calls `auth.verifyIdToken(token, true)` on a miss (`auth.ts:248-271`). The cache key is the **entire token string** (`tokenCache`, `auth.ts:86`), which uniquely identifies one user+session. That is the deliberate fix for the old UID-keyed cache that bled User A's decoded token into User B's request (history at `auth.ts:52-80`).
- **The cache never serves a stale token.** Entries evict after a 30s wall-clock TTL (`TOKEN_CACHE_TTL_MS`, `auth.ts:81,116-119`) AND are refused once the token's own `exp` passes (`auth.ts:121-126`); `setCachedDecoded` won't store an already-expired token (`auth.ts:136`). The map is bounded at 5000 entries with LRU eviction (`auth.ts:82,142-145`). A 60s `setInterval` sweep purges expired entries and is `unref()`'d (`auth.ts:97-107`).
- **The cold path verifies revocation and de-dups concurrent verifies.** On a miss, `auth.verifyIdToken(token, true)` runs with `checkRevoked: true` (`auth.ts:258`), so a revoked session or disabled account is rejected on the next cold verify. Concurrent cold verifies of the **same** token share one Firebase call via `inflightVerifications` (`auth.ts:91,254-269`); the entry is removed in a `.finally()` with a trailing `.catch()` so a failed verify cannot become an unhandled rejection (`auth.ts:267`). Only successes are cached.
- **A second pass on the same request is free.** `app.ts` mounts `verifyToken` ahead of `requireFeature`/`requireActiveBilling` and the module routers apply it again per route. The middleware recognises the repeat by `req.__verifiedToken === token` and re-runs only the email gate, so the per-account rate limiter is not charged twice (`auth.ts:222-240,286-287`).
- **Rate limiting lives in the middleware.** A verified request is charged to `perUserApiLimiter` keyed on the uid (`auth.ts:295`); a failed verify is charged to the per-IP `authFailureLimiter` before the 401 is sent (`auth.ts:311-321`). The public auth routes add `authLimiter`, `userExistsLimiter` and `oauthCallbackLimiter` (`auth.routes.ts:7-11`).
- **Email verification is enforced on the server.** `verifyToken` (the default, `auth.ts:326`) calls `isEmailVerifiedToken(decoded)` and returns a 403 `EMAIL_NOT_VERIFIED` for unverified password sign-ins (`auth.ts:38-50,275-281`). The frontend layout guards mirror this, but the security boundary lives on the backend, and it runs identically on cached and fresh paths.
- **Revoked/disabled sessions surface as 401.** `authFailurePayload` maps `auth/id-token-revoked` → `TOKEN_REVOKED` and `auth/user-disabled` → `ACCOUNT_DISABLED` (`auth.ts:157-193`).
- **An onboarding-window exemption exists.** `verifyTokenAllowUnverified` (`auth.ts:331`) skips the email check and is wired into exactly two routes, `POST /api/auth/create-user` and `GET /api/auth/user-type` (`auth.routes.ts:102-111,126-129`), because a just-registered email/password user must create their Postgres record and poll their type before the verification email can possibly be clicked.
- **The backend whitelist has two sources; the frontend has one.** Backend: the `EMAIL_VERIFICATION_WHITELIST` env var (parsed once) UNION the `email_verification_whitelist` table, which admins manage live; `isWhitelisted` reads an in-memory set refreshed on a timer and never throws (`shared/utils/emailWhitelist.ts`, table at `10_identity.sql:42-47`). A non-empty env list in production logs a startup warning (`auth.ts:30-36`). Frontend: `NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST` (`emailVerification.ts:45-49`); unset, it falls back to the hardcoded `DEV_VERIFICATION_WHITELIST` (`:21`) only outside production.
- **`user_type` is a 3-value enum**: `firm_member`, `client`, `pending` (`10_identity.sql:10-11`). New OAuth users land as `pending` and must pass through `/complete-registration`, which always sets them to `firm_member` (see below). Once set, a type other than `pending` cannot be changed by re-running registration (`auth.service.ts:410-414,605-611`).
- **Invites are auto-claimed only for a verified email.** `createUser` and `completeRegistration` run `checkAndProcessMemberInvites` / `checkAndProcessClientInvites` only when `userRecord.emailVerified` is true (`auth.service.ts:436-444,625-633`). A fresh email/password signup is never verified at that point, so it claims its invite later through the explicit token-accept flow, which is email-matched.
- **Never-verified accounts are swept.** Signup writes the Firebase identity and the `users` row before the address is proven, so a stranger's email could be squatted forever. `purgeUnverifiedAccounts` (`modules/users/unverifiedAccounts.service.ts`) runs from `POST /api/cron/housekeeping` (`app.ts:728,757`), defaults to **dry-run** (`UNVERIFIED_ACCOUNT_SWEEP_MODE`, `:52`), and keeps anything admin, whitelisted, invited, on a firm's client books, verified, non-password, younger than the grace period (default 7 days), or still referenced (`blockedReason`, `:128-170`; `findAccountActivity`). It deletes the row before the Firebase identity so the database is the last guard.
- **The docs site gets its own cookie.** `POST /api/auth/docs-session` (behind `verifyToken`) trades a verified ID token for a 12-hour HS256 JWT set as an httpOnly `SameSite=Lax` cookie on the parent domain; the VitePress deployment's edge verifies it offline with `DOCS_SESSION_SECRET`. The cookie carries `scope: 'docs'`, no firm scope, and no API route accepts it (`modules/auth/docsSession.ts:1-88`, `auth.routes.ts:249-264`). `DELETE /api/auth/docs-session` is deliberately unauthenticated so sign-out can clear it after the ID token is gone.
- **Self-serve signup is firm-only; client accounts are invite-only.** `/register` (email/password) and `/complete-registration` (OAuth) no longer offer a Client/Law Firm choice; both hardcode `userType: 'firm_member'`. The only way a `client` user is ever created is through the invite flow (`/register/invite` → `/accept-invite`, see [Invitations](/features/invitations)), which sets `userType: 'client'` directly and never renders either of these pages' forms.
- **OAuth users skip email verification** on both ends: any non-`password` sign-in provider passes the backend gate (`auth.ts:44`), and `isEmailVerified()`/`isOAuthUser()` short-circuit for `google.com`/`microsoft.com` (`frontend/src/lib/utils/emailVerification.ts:58,78,118`).
- **The frontend no longer persists the raw ID token.** `useAuth()` keeps the Firebase `User` in React state only; the live token is fetched on demand via `getFirebaseToken()` and any legacy `localStorage('authToken')` is proactively cleared on logout (`useAuth.ts`, `auth.service.ts`).
- **Public auth routes verify the token inside the service, not via middleware** (`auth.routes.ts:47-118`): `/login`, `/complete-registration`, `/check-user-exists` and `/refresh-microsoft-token` take the ID token in the JSON body and call `verifyIdToken()`, which also passes `checkRevoked: true` (`auth.service.ts:74-76`).
- **Password reset is Firebase-client-only; there is no backend route.** The login page calls `authService.forgotPassword()` → Firebase `sendPasswordResetEmail()` (`frontend/src/services/auth.service.ts:436-439`). No `/api/auth/forgot-password` exists anywhere in the backend.

---

## How It Works

### Recoverable account erasure

Self-service erasure closes application access when the SQL tombstone commits. Successful cleanup returns 200/completed; a provider failure returns 202/pending. Housekeeping retries tombstones with a null `identity_erased_at`, and stamps completion after identity cleanup succeeds. The authenticated erasure endpoint alone permits a closed identity to retry. Firm owners must still transfer or delete their firms first. See `privacySubjectRights.test.ts` for provider failure, retry and recovery coverage.

### Registration invitation isolation

The member-invite sweep uses its batched membership and seat reads as early filters. Before joining, it locks the user's row, rereads their memberships, claims the invitation, locks the firm and rereads the effective seat limit and member count on that transaction. The claim rolls back when capacity is unavailable. This prevents registration from exceeding caps while another request adds the same user or fills the firm (`auth.service.ts::checkAndProcessMemberInvites`).


### Entry Points

**Backend** — all mounted at `/api/auth` (`backend/src/app.ts`):

| Route | Auth | Purpose | Handler |
|---|---|---|---|
| `POST /api/auth/login` | token in body, `authLimiter` | Resolve/create user on sign-in, record a login audit event | `auth.service.ts:500` |
| `POST /api/auth/create-user` | `authLimiter` + `verifyTokenAllowUnverified` (Bearer) | Email/password profile creation | `auth.service.ts:590` |
| `POST /api/auth/complete-registration` | token in body, `authLimiter` | Set `user_type` for OAuth users | `auth.service.ts:399` |
| `POST /api/auth/check-user-exists` | token in body, `userExistsLimiter` | Does this OAuth user need registration | `auth.service.ts:381` |
| `POST /api/auth/refresh-microsoft-token` | token in body, `authLimiter` | Refresh the stored Microsoft token server-side; answers `{ refreshed: true }` and never returns the token | `auth.service.ts` (`refreshMicrosoftToken`) |
| `GET /api/auth/user-type` | `verifyTokenAllowUnverified` (Bearer) | `{ userType, needsRegistration }` | `auth.service.ts:640` |
| `POST /api/auth/docs-session` | `verifyToken` | Mint the docs-site cookie | `auth.routes.ts:249`, `docsSession.ts:68` |
| `DELETE /api/auth/docs-session` | none | Clear the docs-site cookie | `auth.routes.ts:261` |

There is **no backend forgot-password route**; password resets go entirely through the Firebase client SDK (see Flow 5). The remaining authenticated routes (`/check-microsoft`, `/unlink-microsoft`, `/unlink-google`, `/check-calendar-access`, `/connect-google`, `/connect-microsoft`, `auth.routes.ts:131-205`) all use the default `verifyToken` and therefore require a verified email. The two OAuth2 calendar callbacks (`/google-callback`, `/microsoft-callback`, `auth.routes.ts:167,208`) are unauthenticated apart from `oauthCallbackLimiter`; they validate a server-stored `state` instead, and coerce repeated or object-shaped query params to strings first (`queryString`, `auth.routes.ts:38-45`).

The middleware that protects every other module's routes: `verifyToken` (`auth.ts:326`), then `requirePermission(...)` (`backend/src/modules/lawfirms/roles/requirePermission.ts:80`).

**Frontend**: pages and the client auth surface:

| Page / module | Path | Role |
|---|---|---|
| Login | `frontend/src/app/login/LoginClient.tsx` (rendered by `login/page.tsx`) | Email + OAuth sign-in, forgot-password |
| Register | `frontend/src/app/register/RegisterClient.tsx` (rendered by `register/page.tsx`) | Email + OAuth sign-up |
| Docs hand-off | `frontend/src/app/docs/page.tsx` → `DocsClient.tsx` | Calls `authService.startDocsSession()` (`auth.service.ts:377`) then forwards to the docs host |
| Verify email | `frontend/src/app/verify-email/page.tsx` | Poll + resend verification |
| Auth action | `frontend/src/app/auth/action/page.tsx` | Handles Firebase `verifyEmail` / `resetPassword` links |
| Complete registration | `frontend/src/app/complete-registration/page.tsx` | OAuth user confirms firm-workspace creation (self-serve is firm-only; no picker) |
| Auth state hook | `frontend/src/hooks/useAuth.ts` | Subscribes to `onAuthStateChanged`, returns `{ user, loading }` |
| Auth service | `frontend/src/services/auth.service.ts` | All Firebase client calls + backend fetches |
| Verification helper | `frontend/src/lib/utils/emailVerification.ts` | `isEmailVerified` / `isOAuthUser` / `isWhitelistedEmail` / `reloadAndCheckVerified` |
| Token helper | `frontend/src/lib/utils/auth.ts` | `getFirebaseToken` / `refreshToken` / `clearTokenCache` (in-memory token cache) |

Auth is **not** a React context. `useAuth()` (`frontend/src/hooks/useAuth.ts`) wires `onAuthStateChanged` to keep `user` in React state, dynamically imports the Firebase client config (SSR safety), and falls back to `loading = false` after 10s if Firebase never responds. It deliberately does **not** write the token to `localStorage`.

> There was previously a `frontend/src/context/AuthContext.js` whose provider was never mounted, so its five consumers silently read an undefined user (Log Time never pre-selected the timekeeper as a result). It has been deleted; `@/hooks/useAuth` is the only way to read the Firebase user.

### Data Flow

#### Flow 1 — Email/Password Signup → Verify

1. User submits the register form (`frontend/src/app/register/RegisterClient.tsx`, rendered by `register/page.tsx`); `handleSubmit` validates password match/length (`RegisterClient.tsx:81-90`). There is no `userType` choice on this page, since self-serve signup is firm-only, so the call below always sends `userType: 'firm_member'`.
2. `authService.signUp()` calls Firebase `createUserWithEmailAndPassword`, sets the display name, then mints an ID token with no fixed sleep; if the first `getIdToken()` races it force-refreshes once (`frontend/src/services/auth.service.ts:327-345`).
3. The token is sent as a Bearer header to `POST /api/auth/create-user` with `{ email, name, userType: 'firm_member' }` (`auth.service.ts:348`). On any non-OK response the just-created Firebase user is **rolled back** with `user.delete()` (`auth.service.ts:359`).
4. Backend `verifyTokenAllowUnverified` decodes the Bearer token **without** blocking the unverified email (`auth.routes.ts:102-111`), then `createUser()` rejects a requested email that differs from the authenticated one, rejects a change to an already-set `user_type`, and upserts the `users` row keyed by UID (`backend/src/modules/auth/auth.service.ts:590-618`). Pending invites are auto-processed only if Firebase already reports the address verified, which a brand-new password signup never is (`auth.service.ts:620-633`).
5. Back on the client: if the email is on the frontend whitelist, redirect straight in via `getRedirectPath()`; otherwise `sendVerificationEmail()` fires the Firebase verification email, the address is stashed in `sessionStorage('verify-email-address')`, and the user is sent to `/verify-email` (`RegisterClient.tsx:115-128`).
6. `/verify-email` polls every 5s (`POLL_INTERVAL_MS`, `verify-email/page.tsx:15,165`) by calling `currentUser.reload()` and checking `emailVerified`; once verified it force-refreshes the token (so the new claim propagates) and redirects via `getRedirectPath()` (`verify-email/page.tsx:75-86,129`). An unverified account that never completes this step is eventually removed by the unverified-account sweep (see Key Takeaways).

#### Flow 2 — OAuth (Google / Microsoft) Login → Complete Registration → Dashboard

1. User clicks Google/Microsoft; `signInWithGoogle()`/`signInWithMicrosoft()` both obtain the Firebase auth instance via the shared `this.getAuth()` helper and open a popup that requests identity scopes only (no calendar or mailbox permission), then read the Firebase ID token (`frontend/src/services/auth.service.ts`).
2. Only the ID token is POSTed to `/api/auth/login` as `{ token }`. A provider access token from the popup is never sent; connecting a calendar is the separate server-side flow described under Key Logic.
3. Backend `login()` verifies the token (with `checkRevoked`), fires a best-effort login audit event per firm (`recordLoginEvent`, `auth.service.ts:458`), and looks up the `users` row by UID. If none exists it creates a `pending` user from the decoded token / `auth.getUser()` provider data and returns `needsRegistration: true`; if the row exists but is still `pending`, it also returns `needsRegistration: true` (`auth.service.ts:500-547`). Login never processes invites.
4. The login page sees `needsRegistration` and routes to `/complete-registration` (`LoginClient.tsx:148-149`).
5. The user confirms firm-workspace creation on a single static tile (no Client/Law Firm picker); `completeOAuthRegistration('firm_member')` POSTs the token and hardcoded `userType` to `/api/auth/complete-registration` (`complete-registration/page.tsx:54`).
6. Backend `completeRegistration()` rejects a change to an already-set `user_type`, upserts the `users` row and processes pending invites only when the email is verified (`auth.service.ts:399-452`).
7. The page polls `getUserTypeFromProfile()` until `userType === 'firm_member'` is visible, then redirects to `/dashboard` (`complete-registration/page.tsx:79-80`). There is no `/client/dashboard` branch here; this flow never produces a `client` `userType`.

#### Flow 3: Login → reloadAndCheckVerified → Dashboard or /verify-email

1. On the login page, a single `useEffect` runs once the Firebase `user` is present, guarded by a `cancelled` abort flag so a stale resolution can't call `router.replace` after `user`/`authLoading` change or the component unmounts (`LoginClient.tsx:48-95`).
2. It calls the centralized `reloadAndCheckVerified()` helper, which `reload()`s the live Firebase user then evaluates `isEmailVerified()`, returning `'verified' | 'not-verified' | 'no-user'` (`emailVerification.ts:96`).
3. `'not-verified'` → `router.replace('/verify-email')` (`LoginClient.tsx:65-69`).
4. Otherwise `checkRegistrationStatus()` hits `GET /api/auth/user-type`; if `needsRegistration` → `/complete-registration` (`LoginClient.tsx:75-77`).
5. Otherwise `getRedirectPath()` resolves the landing route from `userType` and firm membership (`frontend/src/lib/utils/redirect.ts`): `client` → `/client/dashboard`; a member with exactly one firm → `/lawfirm/{id}`; otherwise `/dashboard`.

The synchronous submit and OAuth paths run the same gate after sign-in (`LoginClient.tsx:114-154`).

#### Flow 4 — Verification Link (`/auth/action?mode=verifyEmail`)

1. Firebase emails a link to `/auth/action?mode=verifyEmail&oobCode=...`. The page reads `mode` and `oobCode` from query params.
2. `mode === 'resetPassword'` is forwarded to `/reset-password`; `mode !== 'verifyEmail'` or a missing `oobCode` renders an error.
3. For `verifyEmail`, `applyActionCode(firebaseAuth, oobCode)` confirms the address with Firebase, shows a success card, and redirects to `/login` after a short delay.
4. Specific Firebase error codes (`expired-action-code`, `invalid-action-code`, `network-request-failed`) map to tailored messages with a resend button.

#### Flow 5 — Forgot Password (Firebase client only)

The login page's "Forgot password?" toggles `forgotPasswordMode` (`LoginClient.tsx:29`) and calls `authService.forgotPassword(email)`, a thin wrapper over Firebase's client `sendPasswordResetEmail()` (`auth.service.ts:436-439`). **No backend route is involved.** Firebase sends the email and hosts the `/auth/action?mode=resetPassword` link, which `/auth/action` forwards to `/reset-password`.

#### Flow 6 — Layout Route Protection (email-verification gating)

All three authenticated shells run the same client-side guard pattern in a `useEffect` (a defense-in-depth mirror of the now-server-enforced check):

1. **Dashboard** (`frontend/src/app/dashboard/DashboardLayoutClient.tsx:20-31`): no user → `/login`; user but `!isEmailVerified` → `/verify-email`; renders `null` until verified.
2. **Law firm** (`frontend/src/app/lawfirm/[lawFirmId]/layout.tsx:147-159`): same guard, then fetches the firm and wraps children in `PermissionsProvider`/`FirmSettingsProvider`/etc.
3. **Client portal** (`frontend/src/app/client/ClientLayoutClient.tsx:309`): same guard, then additionally checks the profile and redirects non-clients to `/dashboard` and `pending` users to `/complete-registration`.

#### Protected request: token verification (the common path)

1. The browser attaches `Authorization: Bearer <idToken>`. A missing or malformed header is a 401 `NO_TOKEN` (`auth.ts:204-220`).
2. If this token was already verified on this request, only the email gate re-runs (`auth.ts:231-240`). Otherwise `verifyToken` resolves the decoded token: `getCachedDecoded(token)` on a hit, else an in-flight-deduped `auth.verifyIdToken(token, true)` followed by `setCachedDecoded` (`auth.ts:248-271`).
3. The email gate (`isEmailVerifiedToken`, `auth.ts:38-50`): passes if `email_verified` is true, OR the sign-in provider is not `password` (OAuth), OR `isWhitelisted(email)` (env ∪ DB whitelist); otherwise it forwards an `AppError(403, 'EMAIL_NOT_VERIFIED')` to the error handler (`auth.ts:275-281`).
4. `req.user` and `req.__verifiedToken` are set and the request is charged to `perUserApiLimiter` (`auth.ts:286-295`).
5. On a Firebase failure the attempt is logged as `auth.failed`, charged to the per-IP `authFailureLimiter` (429 once over budget), and otherwise answered 401 with `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `ACCOUNT_DISABLED`, `INVALID_TOKEN` or `AUTH_FAILED` (`auth.ts:297-321`, `:157-193`).
6. For firm-scoped routes, `requirePermission(perm)` then resolves the member via a `members⋈roles` JOIN, lets firm owners pass unconditionally, otherwise checks the permission is present, attaching `req.member` for downstream handlers.

### Data Model

The `users` table (`backend/db/schema/10_identity.sql:5-37`):

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | **The Firebase UID**, the identity key, not a uuid |
| `email` | `citext NOT NULL` | **NOT unique**; duplicates are possible, UID is identity. Indexed plain and on `lower(email)` |
| `name` | `text` | Display name |
| `photo_object_path` | `text` | Profile picture (GCS object path) |
| `user_type` | `text` | CHECK `firm_member` \| `client` \| `pending`, default `pending` |
| `is_admin` | `boolean` | Platform super-admin |
| `terms_accepted_at`, `privacy_accepted_at`, `consent_version`, `consent_ip` | | Consent record |
| `timezone` | `text` | The user's IANA zone, captured from the browser |
| `preferences` | `jsonb` | Per-user settings (see [Settings](/features/settings)); the `loggedInWithGoogle/Microsoft` keys are no longer written there; the settings read derives them from the stored grant |
| `deleted_at` | `timestamptz` | Set when the privacy erase anonymizes the row (tombstone) |
| `identity_erased_at` | `timestamptz` | Set after external identity cleanup succeeds; null on a tombstone means pending recovery |
| `created_at` / `updated_at` | `timestamptz` | ISO strings on read |

Related identity/RBAC tables:
- **`members`** `(law_firm_id, user_id)` PK: firm membership; `is_owner` (at most one per firm), `role_id` single-column FK → `roles(id) on delete set null`.
- **`roles`**: `permissions text[]`; built-in + custom roles per firm.
- **`clients.user_id`** → `users.id`: links a portal client identity to a firm.
- **`user_oauth_tokens`** `(user_id, provider)`: calendar access/refresh tokens plus per-provider sync state (`10_identity.sql:129-149`). The old `user_settings` table is gone (folded into `users` and this table).
- **`oauth_states`**: short-lived CSRF state for the backend OAuth2 code flow (`10_identity.sql:151-158`).
- **`email_verification_whitelist`**: the DB half of the verification whitelist (`10_identity.sql:42-47`).

Firebase Admin is initialized once (`firebase.ts`) and exports only `{ admin, auth }`. It is used for Auth and GCS storage only.

### Key Logic & Rules

- **The verified-token cache is keyed on the full token string.** `getCachedDecoded`/`setCachedDecoded` use the entire JWT as the Map key (`auth.ts:86,109-146`). A token string identifies exactly one user + one session, so a hit returns the decoded payload of THAT token and no other (history: `auth.ts:52-80`). Only successful verifications are cached.
- **Two staleness guards on the cache.** A hit is dropped if either the 30s wall-clock TTL elapsed (`auth.ts:116-119`) or the token's own `exp` has passed (`auth.ts:121-126`). The store side also refuses an already-expired token (`auth.ts:136`). Size is bounded at 5000 with LRU eviction (`auth.ts:142-145`).
- **Two token-verification variants from one factory.** `makeVerifyToken({ requireVerifiedEmail })` (`auth.ts:201`) produces `verifyToken` (enforces email, `auth.ts:326`) and `verifyTokenAllowUnverified` (does not, `auth.ts:331`). Both share the identical cache+verify path and only differ on the email gate.
- **Email verification is server-side.** `isEmailVerifiedToken` (`auth.ts:38-50`) mirrors the frontend logic and is consulted by `verifyToken`. A valid-but-unverified password token calling the protected API directly is rejected with 403 `EMAIL_NOT_VERIFIED` (`auth.ts:275-281`).
- **Onboarding window.** Only `/create-user` and `/user-type` allow unverified tokens (`auth.routes.ts:104,127`). Everything else (calendar connect, settings, docs session, all firm/client modules) requires a verified email.
- **OAuth ⇒ verified.** Server-side, any non-`password` sign-in provider passes the gate (`auth.ts:44`). Client-side, `isOAuthUser()`/`isEmailVerified()` short-circuit for `google.com`/`microsoft.com` (`emailVerification.ts:58,78,118`).
- **`pending` is a real state.** New OAuth users sit at `user_type = 'pending'` until `/complete-registration`. `getUserType()` and `checkUserExists()` both treat `pending` as `needsRegistration: true` (`auth.service.ts:381-396,640-647`).
- **`user_type` is immutable once resolved.** Both `completeRegistration` and `createUser` throw a `ValidationError` if the stored type is set, not `pending`, and differs from the requested one (`auth.service.ts:410-414,605-611`). Portal, messaging and signing gates trust the stored value.
- **Email ↔ token must match on create.** `createUser()` rejects the request if the requested email (normalized) differs from the authenticated Firebase email (`auth.service.ts:596-600`).
- **No fabricated emails; a clearly-marked sentinel is used only for the NOT NULL column.** `extractEmail()` returns `null` when no genuine provider email is resolvable (`auth.service.ts:341-352`). Because `users.email` is `citext NOT NULL`, `emailForUserRow()` writes a visibly-fake, uid-scoped sentinel (`no-email+${uid}@users.noreply.paralegix`) **only for the row** and logs a warning (`auth.service.ts:359-363`), never for invite matching.
- **Invite auto-processing on first profile creation, verified emails only.** `createUser` and `completeRegistration` look up pending, unexpired rows in `invitations` by lowercased email and `invite_type` (`checkAndProcessMemberInvites`, `auth.service.ts:137-246`; `checkAndProcessClientInvites`, `:252-293`), then atomically claim + join through `claimAndJoinInviteById` (`:121-129`), respecting the per-user firm cap and the firm's seat limit, and emit `MEMBER_ADDED` after commit. Both calls are skipped unless `userRecord.emailVerified`.
- **Signing in never connects a calendar.** The Firebase Google and Microsoft providers request identity scopes only, and `/login` and `/complete-registration` ignore any provider token in the body, so a sign-in with one account can never overwrite or create the calendar connection of another.
- **The calendar connection is a separate server-side code flow.** `/connect-google` and `/connect-microsoft` store a random `state` in `oauth_states` and set it in an httpOnly, `SameSite=Lax`, 10-minute cookie (`__Host-plx_oauth_state` with `Path=/` and `Secure` over HTTPS; `plx_oauth_state` on `/api/auth` over local http), so the callback only completes in the browser that started it. The callback spends the state in one statement that also checks the provider, then validates before any write: the granted scope must include Google `https://www.googleapis.com/auth/calendar` or Microsoft `Calendars.ReadWrite` (Microsoft scopes are URL-decoded and the Graph prefix stripped), the ID token must name the account (Google `sub`, Microsoft `tid:oid`), and a refresh token must be present or already stored for that same account. A refusal leaves the existing connection untouched. A row with no stored account (connected before identity was recorded) has its old refresh token redeemed once so its ID token can decide; a refused one counts as a different account, a transient failure refuses the reconnect with `exchange_failed`. A different account is a disconnect followed by a fresh connection: the delete, the imports cleanup and the new tokens commit in one transaction under the `OAUTH_REFRESH` lock, and stopping the old channel or subscription and revoking the old Google grant run only after commit. Google is never revoked when the accounts are the same, because revoking ends the whole grant, new token included. The redirect carries only a fixed code (`google_connected=true` or `google_error=<code>`, likewise for Microsoft) and goes to the starting page, or `/dashboard` when there is none. Rules and states: `calendar/shared/calendarGrant.ts`; see [Calendar](/features/calendar).
- **Calendar account changes are serialized through provider cleanup.** A separate `CALENDAR_CONNECTION` lease covers the callback's token exchange, connection transaction and deferred provider cleanup, and the full disconnect. A reconnect cannot exchange a new grant while disconnect is still revoking the prior Google grant. This lease is separate from `OAUTH_REFRESH`, because stopping the old subscription may need to refresh captured credentials. The transaction rereads account identity before retaining a refresh token; an unknown replacement requires a new refresh token and resets local connection state without revoking an unidentified grant (`auth.service.ts::withConnectionLifecycle`, `::completeConnection`).
- **`requireUserType` / `optionalVerifyToken` are live.** `requireUserType(['client'])` (`auth.ts:392-436`) gates the client portal, messaging client routes, and a signing route; it reuses a per-request `req.userData` if already loaded and returns typed errors (`NotFoundError`, `ForbiddenError`, or `AppError('USER_TYPE_LOOKUP_FAILED', 500)`). `optionalVerifyToken` (`auth.ts:337-386`) powers public signing links; it now reads the same token cache and charges failed tokens to `authFailureLimiter`.

### Dependencies

| Dependency | Where | Used for |
|---|---|---|
| Firebase Admin SDK (`firebase-admin`) | `backend/src/shared/database/firebase.ts` | `auth.verifyIdToken`, `auth.getUser`, `auth.getUsers`/`deleteUser` (sweep) |
| Firebase Client SDK (`firebase/auth`) | `frontend/src/services/auth.service.ts`, `hooks/useAuth.ts` | sign-in/up, popups, `applyActionCode`, `sendEmailVerification`, `sendPasswordResetEmail` |
| Postgres via audited Drizzle contexts (`systemQuery('auth_identity', ...)`) | `auth.service.ts`, `users.repository.ts` | `users`, `members`, `roles`, `oauth_states`, `user_oauth_tokens`, `invitations`, `email_verification_whitelist` |
| `jsonwebtoken` | `docsSession.ts` | HS256 docs-session cookie |
| Google / Microsoft OAuth2 token endpoints | `auth.service.ts` (`fetch`) | code→token exchange, MS refresh |

**Env vars:** Backend: `FIREBASE_SERVICE_ACCOUNT_KEY` (or `serviceAccountKey.json` / ADC), `DATABASE_URL`, `GCS_BUCKET`, `FRONTEND_URL`, `EMAIL_VERIFICATION_WHITELIST` (comma-separated, default empty, unioned with the DB table), `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_REDIRECT_URI`, `MICROSOFT_CLIENT_ID/SECRET`, `MICROSOFT_REDIRECT_URI`, `DOCS_SESSION_SECRET` (docs cookie; unset → 503 `DOCS_SESSION_UNCONFIGURED`), `DOCS_COOKIE_DOMAIN`, `DOCS_COOKIE_NAME`, `UNVERIFIED_ACCOUNT_SWEEP_MODE` (`off` \| `dry-run` default \| `on`), `UNVERIFIED_ACCOUNT_GRACE_DAYS` (default 7, floored at 1), `UNVERIFIED_ACCOUNT_SWEEP_BATCH` (default 200, max 1000). Frontend: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST` (when unset, the dev list applies outside production; `emailVerification.ts:45-49`).

### Example

A protected GET to list a firm's tasks:

```
GET /api/lawfirms/8f3.../tasks
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...   (Firebase ID token)
```

1. `verifyToken` → `getCachedDecoded(token)` (hit) or `auth.verifyIdToken(token, true)` + cache (miss) → email-verification gate → `req.user = { uid: 'abc123', email: '...', email_verified: true, ... }` → per-user limiter (`auth.ts:248-295`).
2. `requirePermission('tasks.view')` → resolve member via `members⋈roles` JOIN → owner bypass or permission present → `req.member` set.
3. Handler runs scoped to `lawFirmId` + `req.user.uid`.

An unverified password user hitting the same route:

```json
HTTP/1.1 403
{ "error": "Email not verified. Please verify your email address before continuing.", "code": "EMAIL_NOT_VERIFIED" }
```

(`auth.ts:275-281` → `AppError` → centralized error handler)

---

## What Can Be Improved

> **Resolved and dropped:** the token-string cache with TTL/exp guards, the 60s sweep, in-flight de-dup and `checkRevoked` on the cold path; the frontend no longer persists the raw ID token; `extractEmail` no longer fabricates an address; `reloadAndCheckVerified()` replaced the `setTimeout` races; the login redirect effect has an abort guard; `requireUserType` returns typed errors; `optionalVerifyToken` now reads the token cache (`auth.ts:358-362`); a repeat `verifyToken` on the same request no longer re-verifies or double-charges the rate limiter (`auth.ts:231-240`); registration can no longer flip an existing `user_type`; invites are no longer auto-claimed for an unverified address.

### Still open

- **Revocation latency is bounded by the cache TTL, not eliminated.** `checkRevoked: true` only runs on a cache MISS (`auth.ts:258`); a cached token keeps passing for up to `TOKEN_CACHE_TTL_MS` (30s) after `revokeRefreshTokens()` (`auth.ts:109-132`). The header documents this as the accepted trade-off (`auth.ts:73-79`). If a hard kill switch is ever required, the cache entry must be invalidated rather than left to expire.

- **`checkRevoked: true` adds a Firebase round-trip on every cold verify** (`auth.ts:258`). The 30s cache shields repeats, but every distinct token string (each force-refresh mints one) pays it once. Intended trade-off; revisit only if cold-verify latency shows up.

- **The two whitelists can disagree, now in both directions.** The backend reads env ∪ the admin-managed `email_verification_whitelist` table (`shared/utils/emailWhitelist.ts`); the frontend reads only `NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST` or its dev fallback (`emailVerification.ts:21,45-49`). An address an admin whitelists in the DB passes the API but is still sent to `/verify-email` by the client guards, and a dev-fallback address passes the client but gets 403 from the API. Serve the effective list to the frontend, or drop the client-side whitelist.

- **`requireUserType` still issues its own DB read on most client routes.** The `req.userData` memo (`auth.ts:402-409`) only helps when a prior middleware already loaded the user; nothing does today, so client portal / messaging routes perform a `users.findById` that the handler often repeats. A shared per-request user loader would remove the duplicate fetch.

- **`optionalVerifyToken` has no in-flight de-dup.** It now reads and writes the token cache, but a cold miss calls `auth.verifyIdToken(token, true)` directly (`auth.ts:367`), so concurrent polls of a public signing page with the same fresh token each pay a Firebase round-trip. Route it through the `inflightVerifications` path in `makeVerifyToken`.

- **The docs cookie outlives revocation.** It is a 12-hour offline-verified JWT (`docsSession.ts:25`) with no revocation list, so a disabled account keeps docs access until expiry or sign-out. It authorizes reading the guide and nothing else, so this is low risk, but it should be a stated decision.

- **The unverified-account sweep deletes nothing until someone turns it on.** `UNVERIFIED_ACCOUNT_SWEEP_MODE` defaults to `dry-run` (`unverifiedAccounts.service.ts:52`), so squatted addresses stay occupied until an operator sets `on`. Whether any environment has done so is not visible in the repo. Separately, a crash between the row delete and the Firebase delete leaves an orphaned Firebase identity that keeps the address blocked until cleared by hand (see the deletion-order comment above `purgeUnverifiedAccounts`).

- **`complete-registration` polling can fan out into several profile fetches.** The page polls `getUserTypeFromProfile()` (`complete-registration/page.tsx:32,79`) while `getRedirectPath()` makes its own profile (+ `getMyLawFirms`) calls. A single OAuth login therefore issues several sequential profile fetches. Consolidate to one source of truth.

- **The frontend in-memory token cache is UID-guarded but lives 5 minutes.** `getFirebaseToken()` caches the minted ID token for 5 minutes keyed on `{uid, expiry}` and clears on a UID mismatch (`auth.ts:2-3,64-85`). It can hand back a token whose underlying claims (e.g. a just-completed email verification) are up to 5 minutes stale unless a caller passes `forceRefresh`/`refreshToken()`. The verify-email and login flows force-refresh at the right moments, but any new caller relying on `getFirebaseToken()` after a claim change should be aware of the window.

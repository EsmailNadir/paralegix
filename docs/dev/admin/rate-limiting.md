# Rate Limiting

How Paralegix throttles abuse-prone endpoints, what is covered, and how to tune it.

## Summary

Rate limiting protects the public and expensive surfaces of the backend from
brute force, enumeration, mail-bombing, and volumetric abuse. It is enforced in
the application layer with [`express-rate-limit`](https://www.npmjs.com/package/express-rate-limit),
backed by a **shared Postgres store** so limits are coordinated across all Cloud
Run instances rather than counted per-process.

Every limiter is:

- **Durable and cross-instance** — counters live in the `rate_limits` table, not
  in per-process memory, so the effective cap does not scale up with instance
  count.
- **Fail-open** — on any database error (including the table not existing yet)
  the limiter allows the request and logs, so a DB hiccup never turns into a
  self-inflicted outage. Critical brute-force controls (the signing access-code
  cap) are additionally enforced durably in domain tables, so a degraded limiter
  never removes the real protection.
- **Env-tunable** — every cap is read from an environment variable with a safe
  default, so any limit can be adjusted without a code change. The full list is in
  `backend/.env.example`.

## Key Takeaways

- **Login and signup are already covered.** They flow through the backend and sit
  behind the shared `authLimiter`. Password reset and email verification do **not**
  hit the backend at all — they are handled client-side by the Firebase SDK
  (`sendPasswordResetEmail` / `sendEmailVerification`), which enforces its own
  abuse limits. There is nothing for Paralegix to rate-limit there.
- **One store, one factory, one file.** Every limiter is built by `makeLimiter()`
  in `backend/src/shared/middleware/rateLimiters.ts` and declared there rather
  than next to the route it guards, so the whole surface can be read and tuned in
  one place. Adding one is a few lines with a unique `prefix`.
- **Keying is deliberate.** Authenticated routes key on the **Firebase uid**;
  public routes key on the **client IP** (with `trust proxy` set so the forwarded
  IP is trustworthy and not spoofable); the signing action and gate limiters, and
  the intake gate and submit limiters, key on the **URL token**, so one session or
  form can't be hammered even from rotating IPs.
- **Signed-in traffic is limited per account, not per IP.** An IP is the wrong
  key once a request is authenticated: a firm behind one office NAT would share a
  single bucket no matter how many people are working, while one account driving
  traffic from rotating IPs would never fill any bucket. `perUserApiLimiter` runs
  inside `verifyToken`, so every authenticated route is covered by one call at the
  point the uid first exists, and `verifyToken` is idempotent per request so a
  path that passes through it twice is still charged once.
- **Paging depth is bounded.** `page`/`offset` are capped so no request can ask
  for a window a million rows deep. Not a throttle; see *Paging bounds* below.
- **Expensive work is rejected before it runs.** The upload, conversion and
  signing-action limiters run before the handler mints a storage session URL,
  parses a body, or starts PDF/crypto work. Most uploads no longer pass through
  the API at all (see *Uploads*).
- **Failed logins are counted separately.** A caller spraying garbage tokens
  never reaches a per-account bucket (there is no account yet), so failures are
  charged to a per-IP bucket inside `verifyToken`'s catch block.
- **Every rejection is a normal API error.** A 429 carries the standard envelope
  (`{ error, code: 'RATE_LIMITED', requestId }`) plus `Retry-After` and the
  `RateLimit-*` headers, which the frontend reads to render a countdown.
- **A per-recipient email cap** in the single `sendEmail()` chokepoint stops any
  one inbox from being mail-bombed through the public signing endpoints, even if
  a request-level limit were bypassed.

## Coverage

### Application limiters

| Endpoint(s) | Limiter | Keyed by | Default | Env var |
|---|---|---|---|---|
| Every route (coarse backstop) | `globalApiLimiter` | IP | 1000 / min | `GLOBAL_RATE_LIMIT_MAX` |
| Every **authenticated** route (via `verifyToken`) | `perUserApiLimiter` | **uid** | 600 / min | `USER_RATE_LIMIT_MAX` |
| Scan-heavy reads (see *Heavy reads*) | `heavyReadLimiter` | **uid** | 240 / min | `HEAVY_READ_RATE_LIMIT_MAX` |
| Every route that accepts bytes (see *Uploads*) | `uploadLimiter` | **uid** | 120 / min | `UPLOAD_RATE_LIMIT_MAX` |
| **Failed** token verifications (via `verifyToken`) | `authFailureLimiter` | IP | 100 / min | `AUTH_FAILURE_RATE_LIMIT_MAX` |
| `POST /api/auth/login`, `/create-user`, `/complete-registration`, `/refresh-microsoft-token` | `authLimiter` | IP | 30 / min | `AUTH_RATE_LIMIT_MAX` |
| `POST /api/auth/check-user-exists` | `userExistsLimiter` | IP | 10 / min | `USER_EXISTS_RATE_LIMIT_MAX` |
| `GET /api/auth/google-callback`, `/microsoft-callback` | `oauthCallbackLimiter` | IP | 20 / min | `OAUTH_CALLBACK_RATE_LIMIT_MAX` |
| `GET /api/invitations/accept/:token`, `/member-accept/:token` | `inviteLookupLimiter` | IP | 30 / min | `INVITE_LOOKUP_RATE_LIMIT_MAX` |
| `POST /api/signing/:token/complete`, `/:token/complete-upload-init`, `/:token/decline` | `signingActionLimiter` | **token** | 10 / min | `SIGNING_ACTION_RATE_LIMIT_MAX` |
| `GET /api/signing/:token`, `/:token/status`, `/:token/file` | `signingReadLimiter` | IP | 120 / min | `SIGNING_READ_RATE_LIMIT_MAX` |
| `POST /api/signing/verify` (posts a SHA-256, not the document) | `signingVerifyLimiter` | IP | 10 / min | `SIGNING_VERIFY_RATE_LIMIT_MAX` |
| `POST /api/signing/:token/verify-access-code` | `signingGateLimiter` + durable brute-force lock | **token** | 5 / min | `SIGNING_GATE_RATE_LIMIT_MAX` |
| `POST /api/signatures/convert/upload-init`, `/convert/run`, `POST /api/signing/convert-upload-init`, `/convert-upload-finalize` | `documentConvertLimiter` | **uid** | 30 / 15 min | `CONVERT_RATE_LIMIT_MAX` |
| `POST /api/lawfirms/:lawFirmId/templates/:templateId/export-pdf`, `/fill`, `GET .../:templateId/preview` (one shared bucket) | `templateRenderLimiter` | **uid** | 60 / 15 min | `TEMPLATE_RENDER_RATE_LIMIT_MAX` |
| `GET /api/intake/:token` | `intakeReadLimiter` | IP | 30 / min | `INTAKE_READ_RATE_LIMIT_MAX` |
| `POST /api/intake/:token/verify-access-code` | `intakeGateLimiter` | **token** | 5 / min | `INTAKE_GATE_RATE_LIMIT_MAX` |
| `POST /api/intake/:token/submit` | `intakeSubmitLimiter` | **token** | 5 / min | `INTAKE_SUBMIT_RATE_LIMIT_MAX` |
| `POST /api/lawfirms/:lawFirmId/messaging/send`, `/messaging/groups/:id/messages`, `POST /api/messaging/client-groups/:id/messages` | `messageSendLimiter` | **uid** | 30 / min | `MESSAGE_SEND_RATE_LIMIT_MAX` |
| `POST /api/client-portal/lawfirm/:lawFirmId/messages` | `portalMessageSendLimiter` | **uid** | 30 / min | `PORTAL_MESSAGE_SEND_RATE_LIMIT_MAX` |
| `GET /api/share/:token`, `POST /api/share/:token/download` | `publicShareLimiter` | IP | 30 / min | `PUBLIC_SHARE_RATE_LIMIT_MAX` |

The three `messageSendLimiter` routes share **one** bucket (prefix `msg-send`),
so direct sends, firm group sends and client group sends draw from the same
30/min for a given person. The client portal's send has its own bucket, so a
noisy client can never consume a firm member's allowance.

Every cap is env-tunable; the defaults live in `rateLimiters.ts`, and most have a
commented entry in `backend/.env.example` (the three `INTAKE_*` variables do not
yet).

Signing completion (`POST /api/signing/:token/complete`) is JSON only, with its
own 1 MB body limit (`SIGNING_COMPLETION_BODY_LIMIT`, applied in `app.ts` ahead of
the 2 MB default). A fieldless session uploads its executed copy straight to
storage through `complete-upload-init`, which draws on the same per-token bucket.

### Intake forms

The public intake routes need opposite keys, which is why they are three
limiters. The form read keys on the **IP**: the token is a firm's public
lead-generation link, and a per-token bucket would let any caller spend the whole
form's allowance and blank it for real prospects. The access-code gate and the
submit key on the **token**, so guesses or submissions against one form count
against one bucket from any number of addresses. Unlike signing, the intake gate
has **no durable lock** behind it: the code lives on the template and is shared
by every recipient, so a hard lock would let a stranger shut a firm's intake
pipeline. The limiter is the only brute-force control there.

### Heavy reads

Server-side pagination shrank the response payload of the list endpoints, but not
always the work behind them. These read paths still cost roughly what the unpaged
version cost, on every call:

- **Firm billing lists** (`/billing/invoices/firm`, `/billing/time-entries/firm`,
  `/billing/workbench`) build the entire derived set in memory and then slice it.
  Invoice status, remaining balance, matter-client attribution and rate resolution
  all live in that in-memory pipeline, which is deliberate: it keeps one
  definition of the money model. See `billing/shared/firmBillingWindow.ts`.
- **Files `/list`, `/list-folder` and `/search`** scan the whole recursive storage
  subtree, because each subfolder's file and folder counts are derived from that
  scan and storage offers no recursive-count primitive.
- **Files `POST /export-jobs`** creates a folder or multi-file archive job. The
  archive is built later by the `/api/cron/signing-jobs` drain, but each selected
  folder costs a subtree scan, so creation is limited. The selection is capped at
  `MAX_ZIP_SELECTION` (5000 items) so one request cannot ask for unbounded work.
  Polling (`GET /export-job`) and cancel are not heavy-read limited.
- **Files `/usage`** walks every object the firm owns. A 6h TTL keeps the common
  case cached, but `?refresh=1` bypasses it and is caller-controlled, so the TTL
  alone does not bound how often the walk happens.
- **Client-portal document lists** page their storage prefix to exhaustion, which
  is a correctness requirement: the scan used to stop early and hide documents the
  firm had shared. The portal's billing list and dashboard carry the same limiter
  (`portal.routes.ts`).

These carry `heavyReadLimiter` in addition to the per-account limiter. At 240/min
it allows a sustained four requests a second on these endpoints alone, far past
what a paging UI produces, so a firm with a large matter or a long invoice history
is unaffected. Its job is to stop one account from parking on a scan-heavy
endpoint in a loop.

Mount it **after** `verifyToken` (or on a router that applies it): it keys on
`req.user.uid`, and throws a legible "mounted before verifyToken" error rather
than a bare undefined-property crash if that order is broken.

### Uploads

`uploadLimiter` (120/min per account) guards every route that opens an upload.
Almost all of them are now `upload-init` handshakes that mint a resumable storage
session URL, so the bytes go browser-to-storage and never enter the API
(`backend/src/shared/storage/directUpload.ts`): files `upload-init`, the client
portal's matter-document, document-request and message-attachment `upload-init`
routes, messaging attachments `upload-init`, signing `upload-init` and
`convert-upload-init`, and the template DOCX, overlay and placement-image routes.

The matching `upload-finalize` routes are not upload-limited; they verify what
storage recorded against what was declared. No file-upload route parses a
multipart request body in the API process. The firm storage quota bounds what is
finally persisted; this limiter bounds how fast one account can open uploads.

### Paging bounds

Not a rate limit, but the same concern, in
`backend/src/shared/database/pagination.ts` and
`backend/src/shared/validation/listQuery.ts`.

A deep offset is not free: Postgres produces and discards every row ahead of the
window, and an offset past the end returns an empty page, which is precisely the
case `resolveWindowTotal` answers with a second `count(*)` query. `?page=10000000`
therefore cost two full scans of the filtered set and returned nothing.

`MAX_PAGE_OFFSET` (1,000,000) bounds it in two places:

- The route schemas reject an out-of-range `page`/`offset` with a 400.
- `resolvePage` clamps the resolved offset, so the bound holds for any caller that
  builds its params directly. This is the single point where both the SQL reads
  (through `buildPageClause`) and the in-memory billing windows resolve a window.

The ceiling is far above anything reachable: a million rows deep is 100,000 pages
at the UI's default page size of 10, and 5,000 pages at the largest page size any
route accepts. Pinned by `backend/tests/shared/pagination.test.ts`, which tests
both directions — that nonsense values are cut off, and that realistic deep paging
is untouched.

### Per-recipient email cap

Every outbound email funnels through `sendEmail()` in
`backend/src/shared/services/emailService.ts`. Before spending a send, it enforces
a **per-recipient daily cap** (default 100/recipient/day, `EMAIL_MAX_PER_RECIPIENT_PER_DAY`,
set to `0` to disable). This is a defense-in-depth control against mail-bombing a
specific inbox through the public, unauthenticated endpoints that trigger mail
(e.g. signing complete/decline). It uses the same `rate_limits` table and fails
open.

### The signing access-code gate (defense in depth)

`POST /api/signing/:token/verify-access-code` has two layers: the `signingGateLimiter`
(5/min per token) **and** a durable brute-force lock stored in the signature
tables — a soft window (5 tries → 60s lock) plus a hard cumulative cap (20 total
failures → effectively permanent lock; the sender must re-issue the link). The
durable lock is the real control and survives a degraded limiter.

## What is intentionally NOT rate-limited

- **Password reset / email verification** — client-side Firebase, never reaches
  the backend (see Key Takeaways).
- **Stripe & calendar webhooks** (`/api/webhooks/*`) — gated by signature/secret
  verification. Their gate *is* the control, and provider push webhooks can be
  legitimately high-frequency, so the global limiter skips them.
- **Cron endpoints** (`/api/cron/*`) — gated by a timing-safe `CRON_SECRET`.
- **Health check** (`/api/health`) — trivial, hit constantly by Cloud Run; the
  global limiter skips it.

## Architecture

```
Request
  │
  ├─ globalApiLimiter                (coarse per-IP backstop; skips health/cron/webhooks)
  │
  ├─ verifyToken ──┬─ ok      ──► perUserApiLimiter        (per-account backstop, once per request)
  │                └─ failed  ──► authFailureLimiter      (per-IP, failures only)
  │
  ├─ <route-specific limiter>        (heavy read / upload / signing / invite / oauth ... )
  │        │
  │        └─ pgRateLimitStore  ──►  rate_limits (Postgres, shared across instances)
  │
  └─ handler
           └─ sendEmail() ──► per-recipient daily cap ──► rate_limits
```

- **Factory:** `makeLimiter({ prefix, windowMs, max, keyBy, message, skip })`
  in `rateLimiters.ts`. Each limiter passes a unique `prefix` so buckets don't
  collide in the shared table.
- **Store:** `createPgRateLimitStore(prefix)` in `pgRateLimitStore.ts` — an
  atomic upsert per hit (`INSERT ... ON CONFLICT`), a periodic sweep of expired
  windows, and fail-open error handling.
- **Table:** `rate_limits (key, hits, expires_at)` with an index on
  `expires_at`, in `backend/db/schema.sql`. Because the store fails open when
  the table is absent, the limiter code is safe to run against a database that
  does not have it yet.
- **Test switch:** `RATE_LIMITS_DISABLED=true` makes every limiter inert. The
  in-process test harness sets it; `tests/shared/rateLimiters.test.ts` does not,
  so it still asserts real rejections. Never set it on a deployed service.

### Request cost model

Every limiter that runs costs **one synchronous Postgres write** (the upsert)
before the handler starts. That is worth knowing when reading a latency graph:

| Request | Limiter writes |
|---|---|
| Unauthenticated public route | 1 (global) + 1 if the route has its own limiter |
| Ordinary authenticated route | 2 (global + per-account) |
| Scan-heavy authenticated read | 3 (global + per-account + heavy-read) |
| Upload | 3 (global + per-account + upload) |
| Failed authentication | 2 (global + auth-failure) |

All requests sharing a key contend on the **same row**, so `global:<ip>` is the
hottest row in the table for a firm behind one office NAT. The statements are
single-shot autocommit upserts, so each lock is held for well under a
millisecond, but it is still a serialization point, and every one of these writes
draws a connection from the same pool (`PG_POOL_MAX`) the handlers use. If the
pool saturates, the limiters fail open and every cap silently disappears until
the database recovers. That is the deliberate trade (availability over
enforcement) and the reason the signing brute-force lock is enforced separately.

### What the client does with a 429

The backend exposes `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` through the CORS `exposedHeaders` list (`backend/src/app.ts`),
so browser JS can read them cross-origin. `ApiError.fromResponse`
(`frontend/src/lib/utils/apiErrors.ts`) parses `Retry-After`, falls back to
`RateLimit-Reset`, and `getErrorMessage()` renders "You're doing that too
quickly. Please wait N seconds and try again." React Query is configured with
`retry: 1`, so a 429 is retried once and then surfaced. Note that
`standardHeaders: true` resolves to the **draft-6** header set in
express-rate-limit v8, which is what emits the `RateLimit-*` names the frontend
reads. Switching to `'draft-7'` or `'draft-8'` would collapse them into a single
`RateLimit` header and break that parsing.

### Is the counter itself reachable by an attacker?

No. `rate_limits` has no RLS policy, but the Supabase `anon` role has no
privileges on the `public` schema at all, so PostgREST rejects a request for the
table with `42501 permission denied for schema public` before RLS would even
matter (verified against the staging project with the public anon key). Only the
handful of tables with explicit `grant select ... to authenticated` in
`schema.sql` (notifications, the messaging tables, signature sessions and
participants) are reachable that way, and those all carry RLS policies.

## Tuning & operations

- **Adjust a limit:** set the corresponding env var (see the table) and redeploy
  config — no code change needed. Set `EMAIL_MAX_PER_RECIPIENT_PER_DAY=0` to
  disable the email cap.
- **Shared office IPs:** law firms often sit behind one NAT IP with many
  employees. The global cap (1000/min) is deliberately generous so this never
  trips; raise `GLOBAL_RATE_LIMIT_MAX` if a large firm ever hits it. The global
  limiter is a blunt volumetric backstop, not the primary control — for signed-in
  traffic that role belongs to `perUserApiLimiter`, which gives every account its
  own allowance, so a firm cannot run out by adding people.
- **Sizing the per-account caps:** treat them as nonsense detectors. The
  server-paged grids turned what used to be one bulk fetch into a request per page
  change, sort, filter and settled search keystroke, so a busy screen is tens of
  requests. 600/min leaves an order of magnitude of headroom over anything a
  person clicking a UI can produce. If a 429 is ever reported by a real user,
  raise the cap and find out what generated the volume — do not assume abuse.
- **Keep `TRUST_PROXY_HOPS` in step with the real hop count.** `app.ts` sets
  `app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1))`, and the
  default of 1 is correct for Cloud Run's single Google front-end hop. Putting
  anything else in front (Cloud Armor, an external HTTPS load balancer, a CDN)
  adds a hop, and if this value is not raised to match, express resolves `req.ip`
  to the proxy's address instead of the client's. Every IP-keyed limiter then
  collapses into one bucket shared by all traffic, which trips constantly and
  looks like an outage. Setting it too high is the opposite failure: a client can
  spoof `X-Forwarded-For` and get a fresh bucket per request.
- **Running the LIVE test suite (`npm run test:live`):** those tests drive ONE account from ONE IP,
  so a fast run can spend the per-account or global allowance and fail with 429s
  that look like unrelated bugs. Start the server under test with the caps lifted:
  `USER_RATE_LIMIT_MAX=100000 GLOBAL_RATE_LIMIT_MAX=100000 npm run dev`.
- **Monitoring:** limiter rejections return HTTP 429 and are logged as client
  errors (warn level). A skipped email logs `recipient daily cap reached`. Alert
  on a spike in 429s to a single endpoint. A 429 whose body code is
  `RATE_LIMITED` came from a limiter; anything else with that status did not.
- **Manual reset:** delete the offending rows from `rate_limits` (keys are
  `"<prefix>:<client-key>"`), or let the window expire.

## Fixed in the 2026-07-28 review

A review of the whole rate-limit surface found seven problems. All are fixed;
this section records what they were, because each one is a shape that can come
back.

1. **Six route trees double-counted every request against the per-account cap.**
   `verifyToken` is mounted both on the `app.use(...)` line in `app.ts` (so
   `requireFeature` runs behind auth) and again per route inside the module
   router, and the per-account limiter lives inside `verifyToken`. Every pass
   charged the caller again: `/trust`, `/billing/analytics`, `/file-share-links`,
   `/signature-links` and `/signing-templates` cost 2 hits per request, and
   `/templates` cost 3, because it was mounted twice on the same path. Effective
   caps there were 300/min and 200/min rather than 600/min, and nothing said so:
   express-rate-limit's `ERR_ERL_DOUBLE_COUNT` guard cannot catch it, because
   every validator in v8 disables itself after its first invocation and so only
   ever inspects the first request after boot. `verifyToken` is now idempotent
   per request (it records which token string it verified on `req`, and a second
   pass re-runs only the email gate), and the two `/templates` mounts were merged
   into one. Measured before and after: `/templates` went from 3 hits to 1.
2. **Three limiters keyed on the IP on routes that were already authenticated.**
   Messaging sends, portal sends and document conversion all shared one bucket
   across everyone behind an office NAT. Conversion was the worst: 20 per 15
   minutes for a whole firm, which one person preparing signature packets could
   exhaust. All three now key on the uid.
3. **The heaviest file endpoints had no heavy-read limiter** while `/list-folder`
   and `/search` did. `download-folder`, `download-zip` and `usage` now carry it,
   and `download-zip` caps its `objectPaths` list.
4. **Uploads had no dedicated limiter**, only the 600/min account cap. Added
   `uploadLimiter` to the direct-upload initialization and finalization routes.
5. **Three different 429 body shapes**, one of them a bare `text/html` string,
   none carrying a `code` or `requestId`. The frontend defined `RATE_LIMITED` and
   nothing ever sent it. `makeLimiter` now rejects through the normal error
   pipeline, so every 429 is `{ error, code: 'RATE_LIMITED', requestId }`.
6. **The integration suite could trip its own limits** (one account, one IP, no
   override anywhere) and nothing tested that a limiter rejects at all. The env
   override is documented in `backend/AGENTS.md` and `.env.example`, and
   `backend/tests/shared/rateLimiters.test.ts` pins the cap, the envelope, the
   headers, keyspace isolation and fail-open behaviour.
7. **Unauthenticated token verification was bounded only by the global cap**, so
   garbage tokens could burn 1000 Firebase round-trips a minute per IP. Failures
   now go through `authFailureLimiter` (100/min per IP) inside `verifyToken`'s
   catch block. Successful traffic never touches that bucket.

Two smaller ones went with them: the expired-window sweep was running once per
store (about 20 identical full-table deletes every 10 minutes) and is now a single
process-wide timer, and all six inline limiters moved into `rateLimiters.ts`, so
every cap is env-tunable instead of only the ones the factory built.

## Accepted trade-offs

Known, deliberate, and not worth changing today:

- **Fail-open.** A database problem disables every cap rather than failing
  requests. The signing brute-force lock is enforced separately and durably for
  exactly this reason.
- **The global limiter runs after body parsing.** `app.use(globalApiLimiter)` sits
  below the JSON parsers (2 MB by default, 50 MB on the template routes), so an
  over-limit request still has its body parsed before rejection. Moving it above the parsers would also move it
  above the request-id and logging middleware, which is a worse trade: 429s would
  lose their request id.
- **Expired rows outlive their window.** The sweep only runs in-process, so
  counters expire logically (the upsert resets on a stale `expires_at`) well
  before their rows are deleted. Harmless; the table stays small.
- **No infrastructure layer.** See below.
## Deferred / infrastructure-layer controls

These complement the application limiters but require infra or account setup and
are **not** in the codebase today:

- **Cloud Armor** (edge rate limiting / IP ban-lists in front of Cloud Run) — the
  right layer for volumetric and DDoS defense; offloads cost before traffic
  reaches Node.
- **Firebase App Check** — attests requests come from the real Paralegix
  frontend, blocking scripted abuse of the public endpoints. Needs a staged
  rollout so it can't lock out real users.
- **CAPTCHA / Turnstile** — a velocity-triggered challenge for the fully
  anonymous, expensive endpoints (e.g. `POST /api/signing/verify`).

## Source

- `backend/src/shared/middleware/rateLimiters.ts` — factory + every limiter
- `backend/src/shared/middleware/pgRateLimitStore.ts` — Postgres store
- `backend/src/shared/middleware/auth.ts` — where `perUserApiLimiter` and `authFailureLimiter` are applied
- `backend/src/shared/database/pagination.ts` — `MAX_PAGE_OFFSET` + the clamp
- `backend/src/shared/validation/listQuery.ts` — bounded `page` / `offset` params
- `backend/src/shared/services/emailService.ts` — per-recipient email cap
- `backend/src/app.ts` — global limiter mount, `trust proxy`, CORS `exposedHeaders`
- `frontend/src/lib/utils/apiErrors.ts` — 429 parsing and the user-facing copy
- `backend/tests/shared/rateLimiters.test.ts` — cap, envelope, headers, keyspace,
  fail-open
- `backend/db/schema.sql`: the `rate_limits` table
- `backend/src/modules/intake/intake.routes.ts`: the three intake limiters

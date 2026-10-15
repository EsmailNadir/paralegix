# Incident Runbook

On-call reference for reading logs, interpreting the error codes users hit, and applying the concrete levers that unstick a blocked user or throttle a runaway surface.

## Summary

The backend is one Express API on Cloud Run (plus a private document-conversion worker service, covered at the end) with structured (pino-http) logging where every request carries a `requestId`, a global maintenance kill switch for writes, a centralized error handler that returns a stable `{ error, code, requestId }` envelope, and several durable Postgres-backed guards (the rate-limit store, the signing access-code lock) that an operator can inspect and reset directly. Most user-facing incidents are one of a handful of coded responses: 402 billing inactive, 403 email-not-verified or plan-limit, 410 legacy/expired link, 429 rate limited, or a 5xx correlated by `requestId`. This runbook maps each to its cause and the exact step to clear it. Cross-references: /dev/admin/rate-limiting, /dev/ops/cron-jobs, /dev/ops/webhooks.

## Key Takeaways

- **`requestId` is the correlation key.** Every error response includes it and every log line for that request carries it. Ask a user for the error ID, then grep logs by it.
- **Log level encodes HTTP outcome.** 5xx/uncaught → `error`, 4xx → `warn`, success/redirect → `info`. Successful reads are dropped by default (`LOG_SUCCESS_SAMPLE_RATE=0`); raise it temporarily to trace a read.
- **Maintenance mode blocks writes only.** `MAINTENANCE_MODE=true` returns 503 `MAINTENANCE_MODE` for POST/PUT/PATCH/DELETE; reads pass. Use it for a data cutover, not a full outage.
- **Rate limits and email caps are rows in `rate_limits`.** Keys look like `"<prefix>:<key>"`. Delete the row to clear a stuck limiter; the store fails open, so deleting is always safe.
- **The signing access-code lock is durable in the signature tables**, not the limiter. Clearing a `rate_limits` row will NOT unlock a hard-capped signer — you must reset the gate columns or re-issue the link.
- **403s are security-flagged.** The error handler emits an `authz.denied` event on every 403; a spike from one actor is IDOR probing.
- **Revocation is bounded by a 30s token cache.** `auth.revokeRefreshTokens(uid)` takes effect on the next cold verify, up to ~30s later.

## Reading logs by requestId

Every request gets an id at `app.ts`: pino-http reuses an inbound `x-request-id` header if present, else mints a UUID (`genReqId`). The id is exposed three ways:

- On the response body of any error as `requestId`.
- On every log line for the request via `customProps` (also `actorUid` and `lawFirmId`).
- As `req.id` / `req.log` inside handlers.

To investigate, take the `requestId` from the user's error and filter Cloud Logging on it. In `gcloud`:

```bash
gcloud logging read 'jsonPayload.requestId="<request-id>"' --limit=50 --freshness=1d
```

Notes on what you will and won't see:

- **`/api/health` and the Google/Outlook calendar webhooks are never logged** (`autoLogging.ignore`), so their absence is expected; sync failures still surface via handler/error logs. For a real reachability check, call `GET /api/health/deep` with the `CRON_SECRET`: it reports database latency and pool saturation (`total`, `idle`, `waiting`, `max`).
- **Successful reads are dropped by default.** `LOG_SUCCESS_SAMPLE_RATE` (0..1, default `0`, `app.ts:421`) samples successful GET/HEAD/OPTIONS; set it to `1` and redeploy config to log every read while chasing an intermittent bug, then set it back.
- Request/response bodies and most headers are never logged (serializers trim to id/method/url/status; sensitive headers are redacted).
- `customLogLevel` maps status → severity, so you can alert on `severity>=WARNING` without inspecting bodies.

## Error codes users hit

The centralized handler (`errorHandler.ts`) returns `{ error, code, requestId }`; AppError messages are user-safe, 5xx and third-party SDK messages are scrubbed and logged instead.

| Status | Code | Meaning | Operator action |
|---|---|---|---|
| 401 | `NO_TOKEN` / `TOKEN_EXPIRED` / `INVALID_TOKEN` / `AUTH_FAILED` | No/invalid/expired Firebase token. | Have the user re-login/refresh. Repeated `auth.failed` from one IP = credential stuffing. |
| 401 | `TOKEN_REVOKED` / `ACCOUNT_DISABLED` | Session revoked or account disabled (surfaced by `checkRevoked`). | Expected after a revoke/disable; user must log in again. |
| 402 | `BILLING_INACTIVE` | Firm subscription not access-granting (incomplete/past_due/canceled). Blocks per-firm data routes; `/subscriptions` and `/invitations` stay open. | User must complete payment. If Stripe shows active, run `/api/cron/reconcile-billing` (see /dev/ops/cron-jobs). |
| 403 | `EMAIL_NOT_VERIFIED` | Password sign-in with `email_verified=false`, not whitelisted. | User verifies email, or add to `EMAIL_VERIFICATION_WHITELIST` / the admin-managed whitelist table (test accounts only). |
| 403 | `PLAN_LIMIT_REACHED` | Plan count/feature limit hit; `details` carries `{ resource, current, limit, planId }`. | Upgrade plan, or apply a comp/override/`unlimitedOverride` on the firm. |
| 403 | (permission) | Missing RBAC permission. Emits an `authz.denied` security event. | Legitimate denial. A spike from one `actorUid` = IDOR probing — investigate. |
| 410 | `GONE` | Signing link expired/consumed. | Sender must re-issue the link. |
| 413 | `PAYLOAD_TOO_LARGE` / `CONVERSION_TOO_LARGE` | JSON body over its limit (2 MB default, 1 MB on signing completion, 50 MB on template finalization; `app.ts`), or a document over the conversion cap. | User reduces payload/file size. Uploads go straight to storage and are sized against the plan's per-file limit and the firm quota instead. |
| 429 | (rate limit) | A limiter tripped. | See "Clear a rate limit" below. Alert on 429 spikes to one endpoint. |
| 503 | `MAINTENANCE_MODE` | Writes blocked during a cutover. | Expected while `MAINTENANCE_MODE=true`; unset it when done. |
| 500 | `INTERNAL_ERROR` | Unhandled server error; message scrubbed. | Correlate by `requestId`; the full error is in the `server.error` log line. |
| 504 | `REQUEST_TIMEOUT` | The request outlived its budget (`READ_REQUEST_TIMEOUT_MS`, default 20s, for a GET or HEAD; `REQUEST_TIMEOUT_MS`, default 40s, for a write or the bootstrap firm read) and the client was answered so it would stop waiting. A read 504 usually means the browser had already given up at its own 20s budget. | Correlate by `requestId` and find what was slow. A 504 is a symptom, not a cause. See below. |

## Investigate a 504 REQUEST_TIMEOUT

`requestTimeout` answers the client when a request passes its budget; it does **not** abort the handler, which keeps running to completion. So a 504 tells you a request was slow, never why.

Two layers bound the work, and which one fired tells you where to look:

| Symptom | Layer | Where the cause is |
|---|---|---|
| `504 REQUEST_TIMEOUT` and no DB error in the logs | The request budget (`READ_REQUEST_TIMEOUT_MS`, 20s, for reads; `REQUEST_TIMEOUT_MS`, 40s, for writes) | Application work: an N+1, a large in-memory derivation, a slow third-party call. Check the `SLOW_READ_LOG_MS` slow-query lines for the same `requestId`. |
| A query error mentioning `statement_timeout` | The pool's `PG_STATEMENT_TIMEOUT_MS` (30s) | One query. It fails as itself and the handler turns it into a real error, which is why the DB limit sits *below* the write budget. A read is cut off at 20s first, because the browser has stopped waiting for it by then. |

Raising `REQUEST_TIMEOUT_MS` hides the symptom without fixing anything, so treat it as a last resort. If a legitimately long route is being cut short, add it to `LONG_RUNNING_PATTERNS` in `requestTimeout.ts` instead (webhooks, cron, files, uploads, downloads, exports and conversion are already there). Add the matching entry on the frontend too, or the client keeps waiting on a request the server has already given up answering.

## Enable maintenance mode

`maintenanceMode.ts` gates on `MAINTENANCE_MODE`. Set `MAINTENANCE_MODE=true` on the Cloud Run service (or `backend/.env` locally) and redeploy config. Effect: every mutating request (POST/PUT/PATCH/DELETE) returns 503 `MAINTENANCE_MODE`; GETs continue to serve, so the app stays readable during a data migration. Unset the var (or set `false`) to lift it. Use this for a controlled data cutover, not for shedding load on an outage.

## Clear a stuck rate limit

Limiter counters live in the Postgres `rate_limits` table (`key, hits, expires_at`), shared across instances. Keys are `"<prefix>:<client-key>"`. The prefix identifies the limiter. The client-key is the IP for public routes, the Firebase **uid** for signed-in limiters (`user-api:`, `heavy-read:`, `upload:`, `convert:`, `msg-send:`), and the URL **token** for `sign-action:`, `gate-verify:`, `intake-gate:` and `intake-submit:`. The full prefix list is in /dev/admin/rate-limiting. The per-recipient email cap uses keys like `"email-daily:<lowercased-address>"`.

To release a specific blocked client:

```sql
-- find the offending rows
select key, hits, expires_at from rate_limits where key like 'global:%' order by hits desc limit 20;

-- clear one client's window
delete from rate_limits where key = 'global:203.0.113.7';

-- or lift a recipient email cap
delete from rate_limits where key = 'email-daily:person@example.com';
```

The store **fails open** — a missing table or row simply allows requests — so deleting a row is always safe and never worse than letting the window expire. Alternatively, raise the cap's env var (see /dev/admin/rate-limiting) and redeploy config.

## Unlock a signing access-code gate

The `POST /api/signing/:token/verify-access-code` endpoint has two layers: the `signingGateLimiter` (5/min per token, a `gate-verify:<token>` row in `rate_limits`) **and** a durable brute-force lock in the signature tables. The durable lock is the real control: clearing a `rate_limits` row does not touch it.

`recordGateFailure` (`signatures.repository.ts`) increments the counters on the participant's `signature_challenges` row. Each gate is one row, `kind = 'access_code'` or `kind = 'otp'` (these used to be ten columns on the participant):

- `attempts`: soft counter; every `GATE_SOFT_ATTEMPT_LIMIT` (5) failures sets a 60s soft lock.
- `lifetime_attempts`: cumulative; at `GATE_HARD_ATTEMPT_CAP` (20) it sets `locked_until` ~1 year out (effectively permanent).
- `locked_until`: the active lock timestamp.

To unlock a legitimately locked-out signer, either have the sender **re-issue the link** (the intended path), or, for a support override, reset the row:

```sql
update signature_challenges c
   set attempts = 0,
       lifetime_attempts = 0,
       locked_until = null
  from signature_sessions s
 where c.session_id = s.id
   and s.token = '<token>'
   and c.participant_id = '<participant-id>'
   and c.kind = 'access_code';
```

Swap `kind` for `'otp'` to clear the emailed one-time code gate instead.

Confirm the requester is the real signer before overriding — the hard cap exists to stop code-guessing.

## Revoke a session

Token verification never caches a *decision* longer than a short window: `verifyToken` (`auth.ts`) verifies fresh with `auth.verifyIdToken(token, true)` (`checkRevoked: true`) on a cold cache, and caches the decoded payload keyed on the **full token string** for 30s. To force a user out:

```js
// Firebase Admin (backend context)
await admin.auth().revokeRefreshTokens('<firebase-uid>');
```

The next **cold** verify rejects the token with 401 `TOKEN_REVOKED`; a token already in the 30s cache keeps working until its entry expires, so revocation latency is bounded by ~30s. Disabling the account in Firebase surfaces as 401 `ACCOUNT_DISABLED` through the same path. There is no server-side session store to clear beyond this.

## Common playbooks

- **A firm reports "billing inactive" but paid.** Confirm Stripe shows an active subscription, then POST `/api/cron/reconcile-billing` with the `CRON_SECRET` — it rewrites firms whose status diverged from Stripe. See /dev/ops/cron-jobs and /dev/ops/webhooks (a missed subscription webhook is the usual cause).
- **A signer is locked out of a document.** Check the gate columns above; prefer re-issuing the link over a manual reset.
- **One IP is 429ing on everything.** It hit `globalApiLimiter` (1000/min). If it is a large firm behind one NAT, raise `GLOBAL_RATE_LIMIT_MAX`; otherwise delete its `global:` row only if the traffic is legitimate.
- **Intermittent 500 with an error ID.** Grep `jsonPayload.requestId="<id>"` for the `server.error` line; the scrubbed response never carries the cause, the log does.
- **A user can't upload a large file.** Uploads go browser-to-storage, so the refusal comes from `upload-init` (plan per-file limit or firm quota) or `upload-finalize` (what storage recorded differs from what was declared), not from an uploaded request body. A 413 `PAYLOAD_TOO_LARGE` means a JSON body over its limit. The limits are intentional.
- **Document conversion fails** (503 `CONVERSION_UNAVAILABLE` "temporarily unavailable" when the worker cannot reach storage or LibreOffice, or 422 `CONVERSION_FAILED` when the document itself cannot be converted). **PDF export fails** with 422 `PDF_RENDER_TIMEOUT`, `PDF_RENDER_TOO_LARGE` or `PDF_RENDER_FAILED` (the worker logs `[document-worker] render failed` with the `reason`), or 503 `PDF_RENDER_UNAVAILABLE` when the worker cannot be reached. Check which adapter ran: API logs carry `[document-conversion] conversion completed|failed` with `adapter`, and the worker logs `[document-worker] conversion failed` with the `conversionId`. In `worker` mode, check the worker's `GET /health`, that `DOCUMENT_WORKER_URL` / `DOCUMENT_WORKER_AUDIENCE` are set on the API, and that the API identity still holds `roles/run.invoker` on the worker. To roll back, deploy with `_DOCUMENT_CONVERTER=local`: the deploy step rewrites `DOCUMENT_CONVERTER` on every build, so a console-only change is lost on the next deploy (see /dev/ops/deployment).

## Source

- `backend/src/app.ts` — pino-http config (`requestId`, `customLogLevel`, `autoLogging`, `LOG_SUCCESS_SAMPLE_RATE`), cron authorizer
- `backend/src/shared/middleware/maintenanceMode.ts` — write kill switch
- `backend/src/shared/middleware/errorHandler.ts` — error envelope + 403 security flag
- `backend/src/shared/middleware/pgRateLimitStore.ts` + the `rate_limits` table — limiter store
- `backend/src/modules/signatures/signing.routes.ts` (GATE_POLICY) + `signatures.repository.ts` (`recordGateFailure`) — signing access-code lock
- `backend/src/shared/middleware/auth.ts` — token verification, `checkRevoked`, revocation window
- `backend/src/shared/middleware/requestTimeout.ts`: `REQUEST_TIMEOUT_MS` and `LONG_RUNNING_PATTERNS`
- `backend/src/shared/documentConversion/converter.ts`, `backend/src/document-worker.ts`: conversion adapter and worker logs

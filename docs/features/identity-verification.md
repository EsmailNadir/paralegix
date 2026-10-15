# Client Identity Verification (Credence ID)

## Summary

A portal client can prove who they are by presenting the mobile driver's license in their phone
wallet. The firm then sees a **Verified** state on that client's record, with the name the license
states, the issuing jurisdiction and when the check happened. The checking itself is done by the
Credence ID Cloud SDK; Paralegix proxies every call to it, keeps a small record of the outcome, and
throws the rest of the credential away.

This page is the engineering reference for the backend (`backend/src/modules/identityVerification/`).
It is a staging demo: the feature is off wherever the four `CREDENCE_*` variables are unset. Portal
identity and the active-client selector: [Clients](/features/clients).

## Key Takeaways

- **The license key never reaches the browser.** The portal calls our routes; `credence.client.ts`
  calls Credence with the key, sending `Origin: CREDENCE_ORIGIN` on every request so the provider's
  registered-domain check is explicit (`credence.client.ts:55-83`).
- **An attempt belongs to one client row and one portal user.** It is stored against
  `(law_firm_id, client_id, user_id)`; only that user can complete or poll it, once, inside a
  ten-minute window. Someone else's attempt reads as **404**, never 403, so its existence is not
  revealed (`identityVerification.repository.ts:48-55`, `identityVerification.service.ts:240-255`).
- **Data minimization is the design.** The table has columns only for the given and family name,
  issuer, document type, credential expiry, the per-check results and a failure reason. The
  portrait, signature image, license number, address and birth date have nowhere to go, and the
  checks are copied from a fixed allow-list (`identityVerification.service.ts:116-134`).
- **The provider's session id never leaves the backend.** `formatResult` builds every response
  and has no field for it (`identityVerification.service.ts:54-73`).
- **A name mismatch is a flag, not a refusal.** A differing name is still `verified`, with
  `nameMatchesRecord = false`. Names compare after NFKD, accent stripping, lowercasing and folding
  spaces and hyphens, against the client's single `name` column
  (`identityVerification.service.ts:98-114`).
- **Success is audited and announced.** A verified outcome writes an `audit_events` row
  (`client.identity_verified`) and emits `CLIENT_IDENTITY_VERIFIED`, which notifies the firm owner
  and every member with `clients.view` (`identityVerification.events.ts`).
- **Person clients only.** An active association that is an organization answers 403
  (`identityVerification.service.ts:229-238`).

## How It Works

### Flows

| Flow | `method` | Credence endpoints | Wallet |
|---|---|---|---|
| A | `mdoc_dcapi` | `/v1/getDocRequest`, `/v1/verifyDocRequest` | Apple Wallet (Safari, iOS 17.4+), Chrome 141+ |
| B | `openid4vp_dcapi` | `/dcapi/openid4vp/v1/initiate`, `/dcapi/openid4vp/v1/validate` | Google Wallet, Chrome Android |
| D | `w3c_openid4vp` | `/w3c/openid4vp/v1/initiate`, `/w3c/openid4vp/v1/validate` (202 = pending) | Wallet apps such as CA DMV Wallet, through a link or QR code |

Flows A and B run the browser's Digital Credentials API (`navigator.credentials.get`) and hand its
response to **complete**. Flow D hands the client an `openid4vp://` link and the browser **polls**
until the wallet app answers.

### Routes

The portal routes live in `identityVerification.portal.routes.ts` and are mounted by
`clients/portal/portal.routes.ts:138` at `/api/client-portal/lawfirm/:lawFirmId/identity`, after
the portal router's `verifyToken`, `requireUserType(['client'])` and its per-firm billing and
`clientPortal` gate, so they inherit all three. The active client is resolved by
`getActiveClientAccessContext`, honouring the same `clientRecordId` selector as every portal route.

| Method | Path (under `/api/client-portal/lawfirm/:lawFirmId`) | Body | Answer |
|---|---|---|---|
| GET | `/identity` | none | 200 `{ configured, latest }` |
| POST | `/identity/verifications` | `{ method }` | 201 `{ verificationId, method, request }` |
| POST | `/identity/verifications/:verificationId/complete` | `{ data }` (at most 200,000 chars) | 200 `{ result }` |
| POST | `/identity/verifications/:verificationId/poll` | none | 200 `{ result }` |

`request` is Credence's `dcRequest` (A), its `payload` (B), or `{ walletUrl }` (D), where
`walletUrl` is `openid4vp://authorize?client_id=...&request_uri=...` with both values URI-encoded.

The firm route, `GET /api/lawfirms/:lawFirmId/clients/:clientId/identity-verification`, runs
`verifyToken`, `requirePermission('clients.view')` and then `assertLawFirmMembership`. It answers
`{ verified, latestAttempt }`: the newest verified attempt and the newest attempt of any status.
It is mounted ahead of the client router in `app.ts` so the client router's `/:clientId` routes
cannot shadow it.

Every `result`, `latest`, `verified` and `latestAttempt` is a `VerificationResult`:
`verificationId`, `method`, `status`, `verifiedName { given, family } | null`, `issuer`,
`docType`, `credentialExpiresOn` (`YYYY-MM-DD`), `nameMatchesRecord`, `checks`,
`failureReason`, `createdAt`, `completedAt`.

### Errors

| Status | When |
|---|---|
| 400 | Unknown `method`; `data` missing or over the cap; completing a Flow D attempt or polling an A/B one |
| 403 | Not associated with the firm, or the active client is an organization |
| 404 | The verification is not the caller's (any firm, any user) |
| 409 | The attempt already finished, or its window closed (the row is then marked `expired`) |
| 429 | More than 10 starts per account per hour (`identityVerificationStartLimiter`, `rateLimiters.ts:261`) |
| 502 | Provider error (`IDENTITY_PROVIDER_ERROR`), generic copy only |
| 503 | `IDENTITY_VERIFICATION_UNCONFIGURED`, or `IDENTITY_PROVIDER_DOMAIN` on a Credence `DOMAIN_MISMATCH` |

### Lifecycle of one attempt

1. **Start** (`identityVerification.service.ts:305`). Resolve the active person client first, so an
   unassociated caller never causes a provider call. Then check configuration, ask Credence for a
   request, and insert a `pending` row holding Credence's `sessionId` in `provider_session_id`.
   `expires_at` defaults to ten minutes after insert.
2. **Complete** (A, B; `:343`) or **poll** (D; `:361`). Load the row by id AND the caller's uid
   (404 otherwise), re-resolve the client the row is bound to, then `assertOpen`: a finished row
   is 409, and a pending row past `expires_at` is marked `expired` and answered 409. Both use the
   database clock. Only then is Credence called.
3. **Interpret.** For A and B (`interpretDcAnswer`, `:147`): `cancelled` sets `cancelled`;
   `res === false` sets `failed` with `failure_reason` from `authentication.authenticationResult`
   and stores no names; `res === true` parses `resDetails`, takes `documents[0]` or the top level,
   and keeps only the allow-listed fields. For D (`interpretW3cAnswer`, `:186`): a 202 leaves the
   row pending; otherwise success needs the provider's `success` AND every boolean in
   `verificationDetails`, which become the `checks`.
4. **Finish once** (`:260`). `finishPending` updates only a row that is still `pending` and inside
   its window, so two racing completions write one outcome and the other gets 409. A verified
   outcome then records the audit entry and emits the event.

### Credence client

`credence.client.ts` caches the access token per process. Concurrent callers share one in-flight
acquisition (`token`, `:115`). A token within 60 seconds of expiry is refreshed with
`/v1/refresh`; a refused refresh falls back to `/v1/setup` (`acquireToken`, `:96`). A failed call
logs the status and up to 500 characters of the body with the license key redacted, and throws an
`AppError` with generic copy, so the provider's body never reaches a client
(`call`, `:55-83`). `isCredenceConfigured()` reports whether all four variables are set without
throwing; the portal summary uses it for `configured`.

### Data model

`client_identity_verifications` (migration `0049_client_identity_verifications.sql`, domain file
`backend/db/schema/20_parties.sql`): tenant key `unique (law_firm_id, id)`, composite FK
`(law_firm_id, client_id) -> clients` with `on delete cascade`, `user_id -> users(id) on delete
restrict` (the row is the firm's evidence and should not vanish with an account; the privacy
erase tombstones users rather than deleting them), `provider_session_id` unique, CHECKs on
`method` and `status`, and `completed_at` required once the status leaves `pending`. The boolean
is `is_name_match` (the schema convention requires an `is_` prefix); the API names it
`nameMatchesRecord`. Indexes: `(law_firm_id, client_id, created_at desc)` for the reads and the
cascade, `(user_id)` for the users FK.

### Configuration

Four variables, all server-side and commented in `backend/.env.example`: `CREDENCE_BASE_URL`,
`CREDENCE_LICENSE_KEY`, `CREDENCE_PROFILE_ID`, `CREDENCE_ORIGIN`. Optional:
`IDENTITY_VERIFICATION_START_RATE_LIMIT_MAX` (default 10 per hour).

### Tests

- `backend/tests/identityVerification/credence.client.test.ts`: token sharing, refresh and its
  fallback, headers, `DOMAIN_MISMATCH` mapping, license-key redaction, 202 on poll, missing config.
- `backend/tests/identityVerification/identityVerification.routes.test.ts`: cross-firm callers
  first, then ownership inside a firm, the organization refusal, double completion, expiry, every
  outcome branch, minimization (no portrait, license number, birth date or address in the row or
  any response), the audit entry and notification, and the firm read.
- `backend/tests/shared/rateLimiters.test.ts`: the start limiter's cap and per-account keying.

## What Can Be Improved

- **Not for production yet.** The feature is a staging demo pending legal sign-off on retention
  of the verified name and on the consent copy.
- **No retention policy.** Failed, cancelled and expired attempts are kept indefinitely. A sweep
  could drop them after a period, keeping verified rows.
- **Privacy erase does not touch these rows.** An erased client's verified name stays on the
  attempt row; the erase flow could null the name columns.
- **Name matching is whole-string.** A middle name on the license, or a record name in "Last,
  First" order, reads as a mismatch. It is a flag, so this costs a human glance, not a refusal.
- **Poll after completion is 409.** A browser that polls once more after the wallet answered gets
  409 rather than the finished result; the frontend has to stop polling on the first non-pending
  answer.
- **Migration number.** `0049` follows this branch's `0048_word_templates.sql`; `origin/staging`
  already has `0049` to `0053`, so the file needs renumbering when this branch is merged there.

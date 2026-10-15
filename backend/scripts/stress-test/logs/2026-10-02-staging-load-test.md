# Staging load test log: 2026-10-02

How Paralegix staging held up with 1, 10 and 50 simultaneous firm users across everyday screens,
e-signatures and templates. It covers what was built, how it was run, what was changed on staging,
how that change was reversed, and what needs fixing.

Times are UTC (the runs happened on the evening of 2026-10-02 US time, which is 2026-10-03 UTC).

## Summary

- **Everyday use scales fine.** At 50 users doing normal work (about 1,100 requests a minute),
  there were zero errors. Screens stayed under 1 second at the 95th percentile, on a single API
  instance.
- **Documents are the limit.** When many users generate documents at the same moment, they queue
  behind about 2 concurrent document jobs.
  - **At 10 users:** waits were 20 to 37 seconds and 2 template fills were refused.
  - **At 50 users:** 243 of 1,525 calls failed.
  - **What failed:** template fills and exports were refused as busy, and Word conversions and
    signature completions timed out.
- **Signatures were never lost.** All 100 signing sessions in the 50-user burst completed in the
  database, including the 26 where the signer was shown a timeout.
- **Staging config was changed once, temporarily, and fully restored.** The change raised the
  per-IP global rate limit for the 50-user runs. Every stress-test login was deleted afterwards.

## What was built

A reusable harness at `backend/scripts/stress-test/`. Its usage is in the README beside it.

**Commands:**
- **`npm run stress:setup`** creates a comped test firm with no plan limits, plus N Attorney users.
  It runs through `adminCreateAccount` with `DB_TARGET=staging`. Every address is on the reserved
  `.test` TLD, so nothing can be emailed.
- **`npm run stress:run`** signs the users in with Firebase Admin custom tokens and drives them
  through one of two profiles. It writes a markdown and JSON report to `reports/`.
- **`npm run stress:teardown`** deletes the Firebase identities. Firebase is shared across
  environments, so these must not linger. The firm and its rows stay in the disposable staging
  database.

**Profiles:**
- **`realistic`:** each user loops with a 2 to 6 second pause between screens. Each loop picks one
  flow:
  - 65%: everyday screens (dashboard, matters, tasks, time entries, invoices, clients, messages).
  - 15%: a full e-signature round trip: upload a PDF, create a copy-link session, sign as the
    recipient, download the sealed PDF.
  - 5%: a Word file converted for signing.
  - 10%: a Word template filled to PDF.
  - 5%: an HTML template exported to PDF.
- **`docs-burst`:** every user fires the same document operation at the same instant, in waves:
  1. template fill to PDF
  2. Word conversion for signing
  3. HTML export
  4. signing round trip

**Safety built in:**
- The target is an allowlist: `api-staging.paralegix.com` over https, `localhost` and `127.0.0.1`.
  Production and raw Cloud Run URLs are refused.
- Setup refuses any `DB_TARGET` except `staging` or `local`.
- The run refuses users created against a different database from the target.
- No email is ever sent: signing uses copy links, and all addresses are on `.test`.

**Tests:**
- 21 unit tests in `backend/tests/scripts/stressTest/` cover the production guard, argument
  parsing, the percentile and error accounting, token caching and the fixtures.
- Three were mutation-checked: breaking the guard, the token cache or the timeout counting turns
  them red.

## Pre-flight checks before touching staging

- `DATABASE_URL_STAGING`, `TEST_FIREBASE_API_KEY` and `serviceAccountKey.json` were present.
- The service account's Firebase project matched the staging frontend's project, and the local
  web API key matched the staging key.
- There was no schema drift between this branch and `origin/staging` in `db/migrations` or
  `db/schema`.
- `GET /api/health` on staging returned 200 in 0.18s.

## Runs

| # | Time (UTC) | Users | Profile | Requests | Errors | Report |
| --- | --- | ---: | --- | ---: | ---: | --- |
| 1 | 01:35 | 1 | realistic, 30s | 34 | 2 (harness bugs) | `2026-10-03T01-35-30-761Z-realistic.md` |
| 2 | 01:36 | 1 | docs-burst, 1 round | 19 | 0 | `2026-10-03T01-36-37-440Z-docs-burst.md` |
| 3 | 01:42 | 10 | realistic, 5 min | 1,366 | 0 | `2026-10-03T01-42-18-740Z-realistic.md` |
| 4 | 01:48 | 10 | docs-burst, 3 rounds | 441 | 2 | `2026-10-03T01-48-04-305Z-docs-burst.md` |
| 5 | 02:29 | 50 | realistic, 5 min | 6,320 | 0 | `2026-10-03T02-29-24-104Z-realistic.md` |
| 6 | 02:35 | 50 | docs-burst, 2 rounds | 1,525 | 243 | `2026-10-03T02-35-50-845Z-docs-burst.md` |

The reports are in `backend/scripts/stress-test/reports/`, which is gitignored and stays local to
the machine that ran them.

### Run 1: smoke test, 1 user

This run was there to catch harness mistakes. It found two, both in the harness:

- **Signature field ids reused.** The harness sent fixed ids (`sig-1`, `name-1`). The second
  session collided with the first on `signature_fields_pkey`, because field ids are a global
  primary key. The API answered **500** instead of a 4xx, so that part is a real server bug (Fix
  6).
  - **Found via:** the staging error log through `gcloud logging read`.
  - **Harness fix:** fresh UUIDs per session.
- **Download used the wrong token.** The firm download route looks a session up by the session
  token, not the signer's participant token. The harness now uses `sessionToken`.

### Run 2: one-user baseline

Every step succeeded. These are the single-user costs everything else is compared against:

| Step | Time |
| --- | --- |
| Template fill to PDF | 6.8s |
| HTML export to PDF | 7.6s (includes a worker cold start) |
| Word conversion for signing | 2.9s |
| Signature completion | 3.7s |

### Run 3: 10 users, realistic, 5 minutes

1,366 requests (244/min) with zero errors. Every everyday screen had a p95 under 0.6s. All 16
signing round trips completed (completion p50 3.5s). Template fills ran at p50 5.1s and p95 10.6s.

### Run 4: 10 users, docs-burst, 3 rounds

| Step | p50 | p95 | Errors |
| --- | ---: | ---: | --- |
| Word conversion for signing | 22.3s | 37.2s | 0 |
| Template fill to PDF | 20.6s | 33.4s | 2 of 30: 503 `TEMPLATE_FILL_BUSY` |
| HTML export | 12.1s | 23.7s | 0 |
| Signature completion | 6.9s | 11.8s | 0 |

**Worker logs for the window:**
- It scaled to both allowed instances.
- It served 88 requests, all 200.
- Each request took p50 2.5s and max 4.3s.

**So the worker itself was healthy.** The user-facing waits were queueing in front of a capacity of
two jobs at once.

### Runs 5 and 6: 50 users

At 50 users the realistic profile needs about 1,100 requests a minute from one machine. That exceeds
the global limit of 1,000 requests per minute **per IP**. Real users arrive from many IPs, so this
would have produced throttling that only exists because of the test setup. With approval, the limit
was raised for these two runs only (see "Staging changes and reversal").

**Run 5, realistic:**
- 6,320 requests (1,119/min) with zero errors.
- Everyday screens: p50 0.2 to 0.4s, p95 under 1s.
- All 73 signing round trips completed (completion p95 4.8s).
- Template fill p95 rose to 31.3s even at realistic pacing.
- The API stayed on one instance.

**Run 6, docs-burst, 2 rounds:** 243 of 1,525 calls failed.

| Step | Failed | Response |
| --- | --- | --- |
| Template fill to PDF | 79 of 100 | 503 `TEMPLATE_FILL_BUSY` at about 30s |
| Word conversion for signing | 79 of 100 | 504 `REQUEST_TIMEOUT` at about 40s |
| HTML export | 59 of 100 | 503 `TEMPLATE_FILL_BUSY` at about 46s |
| Signature completion | 26 of 100 | 504 `REQUEST_TIMEOUT` at about 40 to 42s |

- **Not affected:** uploads, session creation, signer views and downloads all succeeded, at 1 to 8
  seconds.
- **Signatures completed regardless.** A query on staging showed all 100 signing sessions created
  in the burst window with status `completed`, including the 26 that returned 504 to the signer.
- **The API did not crash or restart.** It stayed on one instance. During the burst it logged
  repeated `MaxListenersExceededWarning` (11 close/error listeners on a `PassThrough`). See Fix 7.

## Staging changes and reversal

The only cloud change made during the whole exercise:

| When | Service | Change | New revision |
| --- | --- | --- | --- |
| Before run 5 | `paralegix-api-staging` | `--update-env-vars GLOBAL_RATE_LIMIT_MAX=5000` | `00354-ls5` |
| After run 6 | `paralegix-api-staging` | `--remove-env-vars GLOBAL_RATE_LIMIT_MAX` | `00355-4mw` |

**How the reversal was verified:**
- Before the change, the full service description was saved. Revision `00353-mxc` had 41
  environment variables and no rate-limit variables.
- After the reversal, the live service was compared against that snapshot:
  - the environment variables (names, values and secret references) are identical;
  - scaling (`maxScale 1`, CPU throttling, startup boost) is identical;
  - container resources and image are identical;
  - no rate-limit variable remains;
  - revision `00355-4mw` serves 100% of traffic.
- **The document worker was not touched.** `paralegix-document-worker-staging` is still on
  revision `00107-m6z`, created 2026-10-02T02:44Z, before this exercise began.

## Cleanup

**Removed:**
- **Firebase:** every stress-test identity was deleted by `stress:teardown` (10 after the first
  pair of runs, 50 after the second). A full scan of the Firebase project afterwards found 104
  users and **0** on `@stress.paralegix.test`.
- **Local state:** `scripts/stress-test/.state.json` has been removed.

**Left in the staging database** (disposable, and easy to recognise by name):
- "Stress Test Firm murpyamh" (`52d45f1f-ce45-4271-9f01-aa74053d422f`)
- "Stress Test Firm murropsg" (`132520e8-253a-4e86-b356-a4f6edf77a2f`)

Their test matters, tasks, time entries, templates and signed documents stay with them.

## Other things that happened

- **The full backend suite was run once by accident.** Passing a test path after
  `npx jest --selectProjects unit` makes Jest read the path as a second project name, so all 556
  suites ran (about 3 minutes). The correct form is `npm test -- <path>`. `backend/package.json`
  documents this trap.
- **A test was already failing on the current commit**, unrelated to this work:
  `tests/shared/moduleScopeCaches.test.ts` flags `GLYPH_TABLES` in
  `src/modules/templates/overlayFill.service.ts`. See Fix 8.

## Fixes required

Ordered by user impact. Each fix was traced in the code after the runs. Where a claim was
re-checked by hand, it says so.

### Fix 1: Sending from a signing template a second time fails with a 500 (bug, high)

**Problem:**
- `signature_fields.id` is a **global** text primary key (`db/schema/87_signatures.sql`). It is
  filled straight from client-supplied field ids, and the server never generates one.
- Loading a signing template spreads the template's stored fields, ids included, into the new
  session (`frontend/src/components/signaturesComp/SignatureFieldPlacer.tsx`, verified).
- So the second session sent from the same template collides on `signature_fields_pkey`. The
  error handler has no case for Postgres `23505`, so it answers `500 INTERNAL_ERROR`.
- This is the exact failure the harness hit in run 1.
- **Cross-firm side effect:** one firm can block another firm from using a given id, and the 500
  reveals that an id exists somewhere.

**Fix:**
- A migration that makes the key `(session_id, id)` and replaces `unique (law_firm_id, id)`. No
  foreign key references the table, and every lookup is already per session.
- Tighten the id validation (trim, 1 to 200 characters).
- Map `23505` to 409 in `src/shared/middleware/errorHandler.ts` as a general safety net.
- `signature_participants.id` has the same client-supplied global-key pattern. Foreign keys do
  point at it, so the server should generate participant ids and map the client's `signerId`s.

**Tests:**
- Two sessions created from the same template both succeed.
- A unique violation answers 409.

### Fix 2: Signers are told signing failed when it succeeded (bug, high)

**Problem:**
- `POST /api/signing/:token/complete` commits the consent and the finalize job first. It then
  waits for the per-instance PDF transfer slot (3 at a time).
- That slot's queue deadline is **60s** (`src/shared/utils/transferSlot.ts`, verified), longer
  than the **40s** request deadline. Under load the middleware answers 504 while the handler keeps
  waiting, and later it finishes.
- This is why all 100 sessions in run 6 completed, even though 26 signers got a 504.
- `RestrictedSigningView` shows "took too long, try again" on a 504. A retry with the same key is
  safe because the idempotency replay handles it.
- `PDFAnnotator` (fieldless signing) cannot recover: its retry calls `complete-upload-init`, which
  404s once the token is consumed, so the signer sees "link expired".
- After the 504, the route's own `res.json` throws `ERR_HTTP_HEADERS_SENT`, which logs a false
  "Failed to complete signing session".

**Fix:**
- **Backend:**
  - Give the slot a per-call queue timeout well under the request deadline.
  - The durable path already exists: `runJobNow` turns a queue timeout into `busy`, which answers
    202 `processing`, and the cron drain finishes the job.
  - Guard the response write with `res.headersSent`.
  - Move `deliverCompletedSession` (Resend emails) out of the slot so the slot covers CPU work
    only.
- **Frontend:**
  - On a 504 or network error, check `GET /:token/status` before showing an error.
  - In `PDFAnnotator`, honour `consentRecorded` and `state`, and skip `complete-upload-init` on a
    retry.

**Tests:**
- A saturated slot answers 202, not 504.
- A retry after a timeout replays instead of erroring.

### Fix 3: Every busy error is shown as "Paralegix is undergoing maintenance" (bug, medium)

**Problem:**
- `ApiError.isMaintenanceMode` is `status === 503 || code === 'MAINTENANCE_MODE'`
  (`frontend/src/lib/utils/apiErrors.ts`, verified), and `getErrorMessage` checks it first.
- So a `TEMPLATE_FILL_BUSY` or `SIGNING_BUSY` 503 tells a user the whole product is down.
- `apiFetch` and the firm layout's maintenance screen key off the same check.
- Nothing retries a busy response.

**Fix:**
- Check the maintenance code only.
- Add a small retry helper for busy codes: about 3 attempts with jittered backoff, honouring
  `Retry-After`, with a "Queued, retrying..." state.
- Have the backend set `Retry-After` on busy 503s.

**Test:** a 503 with a busy code renders the busy message, not maintenance.

### Fix 4: The global rate limit will throttle a whole office (bug, medium, production impact)

**Problem:**
- `globalApiLimiter` is keyed by **IP** at 1,000 requests a minute, and runs before auth on every
  `/api/lawfirms` route.
- A law office typically shares one public IP. At the measured ~22 requests a minute per active
  user, about 45 active staff behind one IP get 429s.
- This is exactly what the 50-user run would have hit without the temporary override.
- The file's own comments disagree about whether IP keying is safe for NAT'd firms.

**Fix:**
- Skip the global limiter for requests carrying a Bearer token. Once verified they are bounded per
  user by `perUserApiLimiter` (600 a minute).
- Forged tokens stay bounded per IP by `authFailureLimiter`, and anonymous routes keep the IP limit.

**Tests:**
- A bearer request is not counted by the global limiter; an anonymous one is.
- No current test pins the global limiter's key, so this changes no pinned behaviour.

### Fix 5: Two document routes time out at 40s instead of waiting (bug, medium)

**Problem:**
- `POST /templates/:id/fill` and `POST /api/signing/convert-upload-finalize` are missing from
  `LONG_RUNNING_PATTERNS` (`src/shared/middleware/requestTimeout.ts`, verified). `/\/upload/`
  needs a slash before "upload", and `/\/signatures\/convert/` does not match `/signing/`.
- Both can legitimately queue past 40s:
  - **Fill:** a 30s slot wait, then a 45s conversion wait.
  - **Conversion:** a 45s conversion wait.
- The frontend already gives both 300s. This caused the 79 conversion 504s in run 6.
- After that 504 the conversion handler's `finally` deletes the source upload, so a retry fails
  and the converted PDF is orphaned.
- A conversion queue timeout also surfaces as a raw 500, because `ConcurrencyQueueTimeoutError` has
  no status.

**Fix:**
- Add both paths to `LONG_RUNNING_PATTERNS` and pin them in `tests/shared/requestTimeout.test.ts`.
- Map the conversion queue timeout to 503 `CONVERSION_BUSY`, the way `createTemplateFillSlot` does
  for fills.

### Fix 6: Document throughput is capped at about one conversion at a time (capacity)

**Problem:**
- Even in worker mode, every LibreOffice conversion passes through `CONVERT_LIMIT`, which is
  `DOC_CONVERT_CONCURRENCY` = **1** per API instance (`src/modules/signatures/signatures.service.ts`,
  verified).
- The template fill slot (2) is held for the whole conversion wait, so in practice both slots wait
  on one conversion.
- That explains about 21 of 100 fills succeeding in a 30s window at about 3s per job.
- The worker's second instance is effectively reserved for HTML export, which is capped at 1.
- The fill, export and per-person limits are hard-coded constants.
- `cloudbuild.yaml` passes only `MAX_INSTANCES` and `DOCUMENT_CONVERTER` to the API.
- `tests/config/deployBudget.test.ts` enforces
  `apiMax * (convert + export) <= workerMax` using the code defaults.

**Fix:**
- **Code:**
  - Make the template limits and queue timeouts env-configurable.
  - Hold the fill slot only around the in-memory render and upload, not the conversion wait.
  - Size `CONVERT_LIMIT` from the worker's capacity in worker mode.
- **Deploy:**
  - Pass the new variables through `cloudbuild.yaml`, and have the budget test read them.
  - An example step up: API max 2, convert 2, export 1, worker max at least 2 x (2 + 1) = 6.
- **Database limit:** going past 2 API instances also needs the Supabase pooler `pool_size` and
  `POOLER_CEILING_SAFE` raised together, because `PG_POOL_MAX` is `floor(17 / MAX_INSTANCES)`.

**Production:** it still converts inside the 512Mi API (`DOCUMENT_CONVERTER=local`) and has no
worker. These numbers describe staging, and moving production onto the worker should come with
this sizing.

### Fix 7: `MaxListenersExceededWarning` during the burst (investigate)

**Problem:**
- The API logged 11 close and 11 error listeners on one `PassThrough` during run 6.
- No app code creates a `PassThrough` or a module-scope stream. GCS's own wrapper would print
  `PassThroughShim`.
- The likely candidates are dependency internals on the upload path: node-fetch via teeny-request,
  retry-request, gaxios.
- It may be harmless noise from many waiters, but that is unconfirmed.

**Fix, step 1:**
- Log the warning's stack: `process.on('warning', ...)` in `server.ts`, or
  `NODE_OPTIONS=--trace-warnings` on staging.
- Rerun `npm run stress:run -- --profile docs-burst`.
- Then fix whichever code the stack names, whether it is ours or a dependency.

### Fix 8: `moduleScopeCaches` test already failing on this commit (test, low)

**Problem:**
- `GLYPH_TABLES` in `src/modules/templates/overlayFill.service.ts` holds one parsed font per
  bundled font file. It is keyed only by the fixed `fontFamilies()` table, so it never exceeds 16
  entries and does not grow with traffic.
- The test fails because the cache has no ALLOWED entry.

**Fix:** add an ALLOWED entry in `tests/shared/moduleScopeCaches.test.ts`, matching the existing
`EMBEDDED_FONT_BYTES` entry.

### Suggested order

1. **Correctness first:** Fixes 1, 2, 3, 5 and 8.
2. **Then the office rate-limit risk:** Fix 4.
3. **Then capacity:** Fix 6, followed by a rerun of the 50-user burst to measure the gain.
4. **Fix 7 rides along with that rerun.**

Every change ships with the tests listed beside it.

## Fixes applied (2026-10-02, uncommitted)

All eight fixes are in the working tree with tests that fail on the old code. Each new or changed
test was also mutation-checked: breaking the code it guards turns it red.

**Verification on the combined tree:**
- Backend: `npm run typecheck`, `npm run lint`, `db:catalog-parity`, `db:dead-exports` and
  `db:raw-query-ratchet` all pass.
- Backend tests for every touched area pass: 165 suites, 2,883 tests across `tests/signatures`,
  `tests/templates`, `tests/shared`, `tests/config`, `tests/crosscutting`, `tests/schema` and
  `tests/scripts`. The full suite was not run.
- Frontend: `npm run ci:checks` and `test:unit` pass (503 suites, 5,512 tests).

| Fix | What changed |
| --- | --- |
| 1 | Migration `0017_signature_fields_session_scoped_key.sql` keys `signature_fields` on `(session_id, id)`. The server now generates participant ids and remaps `signerId`s; duplicate signer ids in one request get a 400. Field ids are trimmed, 1 to 200 characters. Postgres `23505` answers 409 with no constraint details. |
| 2 | `createLimiter` takes a per-call queue timeout. `/complete` bounds its inline wait to the time left before the request deadline (minus a 15s margin) and answers 202 `processing` when the slot is busy; the cron drain finishes the job. A late response write is skipped instead of logged as a failure. Completion emails now send after the PDF slot is released. In the frontend, both signing screens check `/status` after a 504 or network error before showing an error, and retry with the same key. `PDFAnnotator` reuses its upload on retry instead of hitting "link expired". |
| 3 | Only `code: MAINTENANCE_MODE` means maintenance. Busy codes get their own message. A new `busyRetry` helper retries `TEMPLATE_FILL_BUSY`/`CONVERSION_BUSY` up to 3 times, honouring `Retry-After`; it never retries a 429, a 504 or a network error. Busy 503s now send `Retry-After`. |
| 4 | The global per-IP limiter skips bearer requests to `/api/lawfirms/*`. Every route there verifies the token, so those requests are bounded per user, and forged tokens per IP by the auth-failure limiter. Public routes keep the IP limit. |
| 5 | Template fill and `/api/signing/convert-upload-finalize` are exempt from the 40s deadline. A conversion queue timeout is now 503 `CONVERSION_BUSY` (shared `busyGate` helper), and a busy refusal keeps the uploaded source so a retry works. |
| 6 | Template gate limits and queue timeouts are env-configurable, with defaults unchanged. A fill holds its slot only for the in-memory render; the conversion is gated by `CONVERT_LIMIT` alone. `cloudbuild.yaml` passes the knobs through substitutions equal to today's values, with the capacity-step comment, and `deployBudget.test.ts` checks them. Neither live service had hand-set values these would overwrite. |
| 7 | `installWarningLogger` (`src/shared/utils/processWarnings.ts`) logs every process warning with its stack and, for listener warnings, the emitter type, event and count. |
| 8 | The `GLYPH_TABLES` ALLOWED entry. The test was already failing on the commit before this work, and it now passes. |

**Before this ships:**
- Migration `0017` must be applied to staging. `/push-to-staging` does this before the code goes
  out.
- After deploying, rerun `npm run stress:run -- --users 50 --profile docs-burst --rounds 2`. It
  will measure the gain and capture the stack for Fix 7.
- Capacity numbers (worker max instances, `DOC_CONVERT_CONCURRENCY`, API instances) are unchanged.
  Raising them is a deploy decision, and the capacity-step comment in `cloudbuild.yaml` says what
  moves together.

**Known gaps left on purpose:**
- **Completion emails are still at-most-once.** A crash between marking a session complete and
  sending its emails loses the emails. This was true before; fixing it needs a per-session
  "delivered" marker, which is a schema change.
- **Two routes can still mishandle a busy converter.**
  - DOCX template preview still holds the fill slot across its conversion.
  - `/api/signatures/convert/run` still deletes its source after a busy 503.
- **Two callers still hide the busy error.** The template preview and overlay-upload conversion
  wrap every converter error in a 502, so busy still reads as a failure there.
- **The error handler does not check `res.headersSent`.** A real error thrown after a 504 still
  attempts a second write.
- **Two routes now have no 40s server deadline.** Template fill and convert-upload-finalize are
  bounded only by their queue timeouts and the 3600s Cloud Run limit.

## Second round of fixes (2026-10-02, uncommitted)

The first round shipped in `6ee85b11`. A review of it, plus the gaps listed above, produced this
round.

**Signing:**
- Completion emails now send after the HTTP answer, not before it.
- A `202 processing` answer kicks a background drain on the instance (one drain at a time, bounded
  by the transfer slot), so owed signatures finish without waiting for the per-minute cron.
- Delivery is tracked per session by migration `0018_signature_sessions_delivery_marker.sql`,
  which adds an owed marker, a delivery lease, an attempt count and `delivered_at`. A crash between
  completion and the emails is redelivered by the drain, and concurrent deliverers send once.
  Sessions completed before the migration are not owed, so nothing old is re-sent.
- The error handler no longer writes a second response after headers were sent.
- `signingParallelCreateStorageFailure` targets the failing signer by identity again, not by
  position.

**Conversion and templates:**
- `/api/signatures/convert/run` keeps its upload on a busy 503, through a shared
  `consumeScratchSource` helper also used by convert-upload-finalize and overlay upload.
- Production (local converter) template fills are back on the in-memory path: no staging round
  trip and no per-fill warning.
- Preview and overlay upload pass `CONVERSION_BUSY` through as 503 instead of 502.
- Worker-mode preview converts in place, without a fill slot.
- Template fill and convert-upload-finalize have a 180s server deadline instead of none.
- Converter settings are validated as positive integers (`positiveIntFromEnv`).

**Frontend:**
- A 409 "already completed" during signing recovery is checked against `/status` before showing
  an error, and the retry waits 1.5s and re-reads status first.
- Cancelled or expired sessions map to the existing "cannot be finalized" message.
- Template preview and overlay upload retry when busy, without re-uploading the file.

**Tests and checks:**
- A forged bearer token on a firm route is proven to be cut off by the per-IP auth-failure limit.
- A delivery test that checked for the parked email one tick too early now waits for it to
  arrive, and was mutation-checked against a route that sends the emails before answering.
- On the combined tree:
  - backend typecheck, lint, `db:catalog-parity`, `db:dead-exports` and `db:raw-query-ratchet`
    pass;
  - backend tests for every touched area pass (169 suites, 2,921 tests);
  - frontend `ci:checks` and `test:unit` pass (511 suites, 5,580 tests).
- `db:drift` flags only the uncommitted `0018` columns, which the regenerated Drizzle model
  already contains, and passes once committed.

**Not done:**
- `InPersonSigningFlow` shows "finalized" while a document is still processing. Fixing it needs a
  new finalizing state on that screen, which is a UI decision.
- Capacity changes and moving production onto the document worker remain deploy decisions.

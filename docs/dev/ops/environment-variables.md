# Environment Variables

Every environment variable and feature flag the Paralegix backend, frontend, and docs build read, grouped by surface with purpose, whether it is required, and the in-code default.

## Summary

Configuration is env-driven. The backend reads `process.env.*` directly at the point of use (there is no central config module), so a variable's default lives next to its reader. Nearly every optional variable has a safe fallback baked into code, so a bare deployment boots; the *required* set is what makes data, auth, storage, payments, and email actually work. The frontend only sees `NEXT_PUBLIC_*` variables (inlined at build time by Next.js). Staging and production each carry their own full copy of these values pointing at isolated backing services (separate Supabase project, GCS bucket, Stripe test vs live). See /STAGING_SETUP for the per-environment wiring and /dev/security/secrets for which values are secrets and where they are stored.

## Key Takeaways

- **Defaults live in code, not a schema.** An optional var read as `Number(process.env.X || 30000)` documents its own default; this page mirrors those.
- **Secrets vs config.** `DATABASE_URL` (and the `DATABASE_URL_<TARGET>` variants), `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `FIREBASE_SERVICE_ACCOUNT_KEY`, `STRIPE_SECRET_KEY`, the Stripe webhook secrets, OAuth client secrets, `RESEND_API_KEY`, `CRON_SECRET`, `DOCS_SESSION_SECRET`, and `P12_PASSPHRASE` are secrets and belong in Secret Manager (Cloud Run) or Vercel encrypted env, never in the repo. See /dev/security/secrets.
- **`backend/.env.example` is the checked-in list.** It carries every variable a deployment is expected to set, with the reasoning for each. Some tunables below are read by code but deliberately left out of it; their defaults are in code.
- **Feature flags default OFF/safe.** `EVENT_OUTBOX_WORKER`, `MAINTENANCE_MODE`, `STRIPE_AUTO_RECOVERY_ENABLED`, `TEMPLATES_GC_DELETE`, `UNVERIFIED_ACCOUNT_SWEEP_MODE` (defaults to `dry-run`) and `DOCUMENT_CONVERTER` (defaults to `local`) all default to preserving current behavior, so flipping one is a deliberate act.
- **`RBAC_ENFORCED` is the exception: its default is unsafe.** Off (unset, or anything but `true`) gives every member the full permission set, so every role limit is ignored. `backend/.env.example` sets it to `true`, but `cloudbuild.yaml` does not pass it, so each deployed service needs it set explicitly. Confirm it on staging and production.
- **Production startup check.** With `NODE_ENV=production`, `server.ts` exits if `DATABASE_URL` is unset and logs a warning for each of `SUPABASE_JWT_SECRET`, `CRON_SECRET`, `DOCS_SESSION_SECRET`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` that is missing.
- **The frontend is public.** Anything in `NEXT_PUBLIC_*` ships to the browser. Never put a secret there; the Firebase web config and Supabase anon key are publishable by design.
- **`DB_TARGET` is a developer convenience,** not a production knob. Cloud Run sets plain `DATABASE_URL`.

## Backend

Read from `backend/.env` locally, or Cloud Run service env / Secret Manager in deployed environments.

### Core / database

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `DATABASE_URL` | Postgres (Supabase) connection string, the sole data store. Resolved by `resolveDbUrl.ts` when `DB_TARGET` is unset. | Yes | none (queries fail; a production boot exits) |
| `DATABASE_URL_LOCAL` / `DATABASE_URL_STAGING` / `DATABASE_URL_PROD` | Per-target connection strings selected by `DB_TARGET` (`resolveDbUrl.ts`). Developer convenience. | No | none (falls back to `DATABASE_URL`) |
| `DATABASE_URL_TEST` | Base name for the Jest suite's databases; `tests/support/db.ts` appends `_$JEST_WORKER_ID`. Built by `npm run test:db`. Never point it at real data. | Tests only | none |
| `PG_POOL_MAX` | Max node-postgres pool size (`connectionBudget.ts`). An explicit value always wins. | No | `10`, or `floor(POOLER_CEILING_SAFE / MAX_INSTANCES)` when `MAX_INSTANCES` is set |
| `MAX_INSTANCES` | Cloud Run `--max-instances`, used to derive the per-instance pool size. Unset means "not decided", not "one". | No | unset |
| `POOLER_CEILING_SAFE` | Connections the app may use across all instances (`connectionBudget.ts`). Must stay below the Supabase session pooler's `pool_size`, which is 20 on staging since 2026-09-16. | No | `17` |
| `PG_POOL_RESERVE` | Connections held back in each pool for work other than a dashboard fan-out (`connectionBudget.ts`). | No | `3` |
| `PG_CONNECTION_TIMEOUT_MS` | How long a checkout waits for a free/new pool connection (`db.ts`). | No | `10000` |
| `PG_STATEMENT_TIMEOUT_MS` | Server-side `statement_timeout` on every pooled session — the real bound on a runaway query (`db.ts`). | No | `30000` |
| `PG_IDLE_TX_TIMEOUT_MS` | `idle_in_transaction_session_timeout`; kills a transaction left open by a crashed handler (`db.ts`). | No | `60000` |
| `PORT` | HTTP listen port (`server.ts`). Cloud Run injects `8080`. | No | `5001` |
| `NODE_ENV` | Runtime mode. Gates the cron dev-bypass and error scrubbing; Dockerfile forces `production`. | No | `production` (in image) |
| `TRUST_PROXY_HOPS` | Trusted reverse-proxy hop count for `trust proxy` (`app.ts:168`); bounds forwarded-IP spoofing behind Cloud Run. Raise it if a load balancer or CDN sits in front, or every IP-keyed limiter collapses into one bucket. | No | `1` |
| `CORS_ORIGINS` | Comma-separated allowed browser origins (`app.ts:338`). When unset, production allows only `paralegix.com` and `www.paralegix.com`; localhost is added only outside production. | No | prod origins (+ `localhost:3000/3001/3002` off-prod) |
| `CRON_SECRET` | Bearer/`x-cron-secret` shared secret for `/api/cron/*` and `GET /api/health/deep` (`app.ts:217`), timing-safe compared. Required on every deployed environment, staging included. | Yes (every deployed env) | none (cron returns 503) |
| `CRON_LOCK_MAX_HOLD_MS` | Lease length of a cron pass's `CRON_PASS` lock row; after it a crashed or wedged pass stops blocking the next run (`app.ts:278`). | No | `600000` |
| `CRON_FIRM_PAGE_SIZE` | Firms fetched per page by the per-firm cron passes (`reminderHelpers.ts`). | No | `200` |
| `MAINTENANCE_MODE` | See feature-flag table. | No | `false` |

### Timeouts & lifecycle

The request-level budget sits **above** the pool's `statement_timeout` on purpose: a query that exhausts its own limit should fail as itself rather than be pre-empted and reported as a timeout. See [Incident Runbook](/dev/ops/incident-runbook).

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `REQUEST_TIMEOUT_MS` | Ceiling on how long a write (any method but GET/HEAD), and the bootstrap read `GET /api/lawfirms/:lawFirmId`, may take before the client is answered `504 REQUEST_TIMEOUT` (`requestTimeout.ts`). Sits above the pool's 30s `statement_timeout` and below the frontend's 45s write budget. `0` disables. Long-running routes (webhooks, cron, files, upload/download, export, conversion, bulk invoices) are exempt. | No | `40000` |
| `READ_REQUEST_TIMEOUT_MS` | The same ceiling for every other GET and HEAD (`requestTimeout.ts`). Equal to the frontend's read budget (`REQUEST_TIMEOUT_MS.read`), since the browser has abandoned the read by then; change both together. `0` disables. Same exemptions. | No | `20000` |
| `SOCKET_REQUEST_TIMEOUT_MS` | Node's `server.requestTimeout` — the socket-level ceiling on receiving a complete request (`server.ts`). | No | `60000` |
| `KEEP_ALIVE_TIMEOUT_MS` | `server.keepAliveTimeout`; sits above the Cloud Run idle window so the proxy, not the app, closes idle connections. `headersTimeout` is this plus 1s (`server.ts`). | No | `620000` |
| `SHUTDOWN_TIMEOUT_MS` | Grace period for in-flight requests on SIGTERM before the process exits anyway (`server.ts`). | No | `8000` |
| `SLOW_READ_LOG_MS` | Threshold above which a read query is logged as slow (`queryTiming.ts`). | No | `1000` |
| `REMINDER_CRON_BUDGET_MS` | Wall-clock budget for a cron request (`reminderHelpers.ts`); the pass stops, checkpoints and reports `truncated` rather than running past it. The default sits inside the 180s Cloud Scheduler attempt deadline. `reconcile-billing` and `reconcile-trust-deposits` cannot resume, so they default to `240000` instead; setting this variable overrides both. | No | `150000` |
| `SHUTDOWN_HOOK_TIMEOUT_MS` | Per-hook ceiling for shutdown hooks run on SIGTERM (`shutdownHooks.ts`). | No | `2000` |
| `SLOW_QUERY_LOG_MS` | Statement duration above which any query is logged (`queryInstrumentation.ts`). `0` or below disables statement logging. | No | `200` |
| `POOL_WAIT_LOG_MS` | Pool checkout wait above which saturation is logged (`queryInstrumentation.ts`). | No | `500` |
| `UNPAGED_READ_CEILING` | Rows one unpaged list read may return (`readCeiling.ts`). Past it the read FAILS rather than returning a short array. | No | `5000` |

### Supabase / Firebase / storage

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `SUPABASE_URL` | Supabase project URL. | Yes (messaging/realtime) | none |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (secret). | Yes (messaging/realtime) | none |
| `SUPABASE_JWT_SECRET` | Mints Firebase-UID JWTs for messaging Realtime/RLS (`messaging.realtime.ts:16`). | Yes (messaging) | none |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Firebase Admin service-account JSON, as a single-line string (it is `JSON.parse`d, not treated as a path), for Auth + GCS (`firebase.ts:7`). | Yes (outside Cloud Run) | falls back to `backend/serviceAccountKey.json`, then Application Default Credentials |
| `GCS_BUCKET` | Google Cloud Storage bucket for file bytes (`firebase.ts:27` and many modules). | Yes | `lawfirms` |

### URLs / OAuth

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `FRONTEND_URL` | Base URL for links in email, redirects, invitations. | Yes | none (links break) |
| `APP_URL` | Base for email preference links (`emailService.ts:75`), public intake links (`intakeSend.service.ts`) and signing emails (`signingNotifications.ts`, which falls back to `FRONTEND_URL`). | No | `https://paralegix.com` |
| `APP_ORIGIN` | Listed in `backend/.env.example`, but **no code reads it any more**. Setting it has no effect. | No | n/a |
| `WEBHOOK_BASE_URL` | Public base for calendar watch/subscription callbacks (`google.service.ts`, `outlook.service.ts`). | Yes (calendar sync) | none |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google OAuth + Calendar (`auth.service.ts`, `calendarHelpers.ts`). | Yes (Google login/sync) | none |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_REDIRECT_URI` | Microsoft OAuth + Outlook (`auth.service.ts`, `calendarHelpers.ts`). | Yes (Microsoft login/sync) | none |

### Email (Resend)

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `RESEND_API_KEY` | Resend API key (secret) (`emailService.ts:133`); unset disables sending. | Yes (email) | none (email inert) |
| `EMAIL_FROM` | From header (`emailService.ts:7`). | No | `Paralegix <noreply@paralegix.com>` |
| `SUPPORT_EMAIL` | Support address in email footer (`emailService.ts:76`). | No | `support@paralegix.com` |
| `COMPANY_POSTAL_ADDRESS` | CAN-SPAM/CASL footer address (`emailService.ts:63`). | No | placeholder string |
| `DISABLE_ALL_REMINDER_EMAILS` | Kill switch for reminder crons (`reminderControl.ts:17`); set `true` on staging. | No | `false` |

### Stripe / billing

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe API key (secret) (`stripe.config.ts:3`). Unset makes both Stripe webhooks answer 503. | Yes (billing) | none |
| `STRIPE_WEBHOOK_SECRET` | Signature secret for `/api/webhooks/stripe` (`stripe.webhook.routes.ts:36`). | Yes (billing) | none |
| `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` | Signature secret for `/api/webhooks/stripe-subscriptions` (`subscriptions.webhook.routes.ts:21`). | Yes (subscriptions) | none |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Signature secret of the separate Connect endpoint (connected-account `account.updated`), which also points at `/api/webhooks/stripe`. An event only this secret verifies must carry `event.account`. See /dev/ops/webhooks. | Yes on staging and production; not needed locally (the CLI signs everything with one secret) | none (only `STRIPE_WEBHOOK_SECRET` is tried) |
| `STRIPE_{BASIC,PROFESSIONAL,ENTERPRISE}_{MONTHLY,ANNUAL}_PRICE_ID` (six) | Plan price ids (`stripePrices.ts`). A missing id rejects checkout for that tier and interval with "Invalid plan or interval". Nothing at runtime checks that an id bills what `PLAN_TIERS` says: run `npx tsx backend/scripts/verify-stripe-prices.ts` with each environment's values. It found every annual id in local and staging to be a copy of the monthly one (annual plans billed monthly and were recorded as monthly), since fixed. | Yes (checkout) | none |
| `STRIPE_APPLICATION_FEE_RATE` / `STRIPE_APPLICATION_FEE_FIXED_CENTS` | Platform fee on client payments; rate is decimal, fixed is cents (`stripe.service.ts:64`). | No | `0.038` / `30` (3.8% + 30¢) |
| `STRIPE_DIRECT_APPLICATION_FEE_RATE` / `STRIPE_DIRECT_APPLICATION_FEE_FIXED_CENTS` | Paralegix's fee on a DIRECT charge (a firm on its own Standard account, which pays Stripe's processing fee itself). See `DIRECT_CHARGE_MIGRATION.md`. | No | `0.009` / `0` (0.9%) |
| `STRIPE_TRUST_ACH_FEE_RATE` / `STRIPE_TRUST_ACH_FEE_CAP_CENTS` | Processing fee on an electronic trust deposit, billed to the firm's operating side (`stripe.service.ts:72`). | No | `0.008` / `500` (0.8%, capped at $5) |
| `STRIPE_CONNECT_PAYOUT_DELAY_DAYS` | Connected-account payout delay, in days (`stripe.service.ts:80`). | No | `7` |
| `STRIPE_AUTO_RECOVERY_ENABLED` | Clawback recovery on a dispute, refund or ACH return (`stripe.service.ts:89`): reverses the connected transfer, and for a trust deposit already paid out, charges the firm's operating card for the shortfall; a won dispute refunds that card charge and returns the rest. Off means the code only logs what it WOULD reverse, so every clawback is a platform loss. On for local and staging; the recommendation for production is on, set at the cutover. The test harness forces it off; only `stripeAutoRecovery.test.ts` turns it on. | No | off |
| `STRIPE_PAYMENT_INTENT_LOCK_MAX_HOLD_MS` | How long a payment-intent lock may be held before it counts as abandoned (`stripe.service.ts:48`). | No | `120000` |

### E-signature

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `SIGNING_P12_PATH` | Path to the PKCS#12 signing certificate (`digitalSign.ts:19`). | Yes (signing) | none |
| `P12_PASSPHRASE` | Passphrase for the signing cert (secret) (`digitalSign.ts:22`). | Yes (signing) | none |
| `SIGNING_JOB_LEASE_SECONDS` / `SIGNING_JOB_DRAIN_BUDGET_MS` / `SIGNING_JOB_HEADROOM_MS` / `SIGNING_JOB_MAX_ATTEMPTS` | Durable signing queue drained by `POST /api/cron/signing-jobs` (`signingJobs.ts`): claim lease, one budget per drain request, time left unused at the end, attempts before a job fails. | No | `60` s / `1500000` (25 min) / `300000` (5 min) / `6` |
| `TRANSFER_SLOT_CONCURRENCY` / `TRANSFER_SLOT_TIMEOUT_MS` | Heavy transfers at once PER INSTANCE, shared by signing and folder exports, and how long a caller queues for a slot (`transferSlot.ts`). Total concurrency is this times the instance count. | No | falls back to `SIGNING_PDF_SLOT_CONCURRENCY` / `SIGNING_PDF_SLOT_TIMEOUT_MS`, then `3` / `60000` |
| `SIGNING_UPLOAD_BUFFER_BYTES` | Largest non-PDF source converted to PDF for signing (`signingConversionCapBytes()`, `signing.validation.ts`). Unset, it follows `DOCUMENT_CONVERTER`. | No | 100 MiB on the worker, 25 MiB otherwise |
| `SIGNING_INLINE_PREPARE_BYTES` / `SIGNING_INLINE_FINALIZE_BYTES` | Largest source whose preparation, or finalize, runs inside the request; past it the route answers `202` and the drain finishes it (`signing.validation.ts`). | No | 8 MiB / 32 MiB |
| `SIGNING_ATTACHMENT_MAX_BYTES` | Largest executed document mailed as an attachment; above it each recipient gets a per-recipient link (`signingDelivery.ts`). | No | `5242880` (5 MiB) |
| `SIGNING_CONTENTS_CAPACITY` / `SIGNING_MAX_CONTENTS_CAPACITY` | Starting and maximum bytes reserved per seal; the reservation grows to fit the chain (`signingPipeline.ts`). | No | `8192` / `65536` |
| `SIGNING_MAX_SOURCE_BYTES`, `SIGNING_MAX_SOURCE_PAGES`, `SIGNING_MAX_CERTIFICATE_PAGES`, `SIGNING_MAX_IMAGE_PIXELS`, `SIGNING_MAX_SIGNATURE_IMAGE_BYTES`, `SIGNING_MAX_SIGNATURE_IMAGE_TOTAL_BYTES`, `SIGNING_MAX_COMPLETION_BYTES` | The versioned signing profile: what the service will sign (`signingProfile.ts`). The profile version is stamped on every admitted source. | No | e.g. `2000` pages, `20` certificate pages, 8 MiB completion body |
| `PDF_*` (`PDF_MAX_READ_BYTES`, `PDF_MAX_XREF_BYTES`, `PDF_MAX_REVISIONS`, `PDF_MAX_PAGE_TREE_NODES`, `PDF_DIGEST_WINDOW_BYTES`, and further parser ceilings in `backend/src/modules/signatures/pdf/`) | The PDF engine's own ceilings, which the signing profile reads rather than restating. | No | code defaults per file |

### Document conversion

DOCX and other non-PDF sources are converted by LibreOffice. `local` runs it inside the API process (the developer default); `worker` sends the object to the separate document-worker service (`backend/Dockerfile.document-worker`, `src/document-worker.ts`), so the bytes never enter the API. Switching to `worker` is a deliberate deploy step.

The same switch decides where HTML template PDF export runs Chromium (`POST /templates/:templateId/export-pdf`, `shared/documentConversion/pdfRenderer.ts`). `worker` renders on the document worker. Anything else renders in the API process, and only when `NODE_ENV` is not `production`: a deployed API that has not been switched to the worker answers 503 `PDF_RENDER_NEEDS_WORKER` rather than start a browser.

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `DOCUMENT_CONVERTER` | `worker` routes conversions to the document worker; anything else converts locally (`converter.ts:280`). Converting from storage without the worker downloads the source into the API process. | No | `local` |
| `DOCUMENT_WORKER_URL` | Worker base URL. Unset while `DOCUMENT_CONVERTER=worker` answers 503. | Yes (worker mode) | none |
| `DOCUMENT_WORKER_AUDIENCE` | Audience for the Cloud Run identity token sent to the worker. | No | the worker URL |
| `DOCUMENT_WORKER_ID_TOKEN` | Fixed identity token, used instead of the metadata server (off-GCP testing). | No | none |
| `DOCUMENT_WORKER_TIMEOUT_MS` / `DOCUMENT_WORKER_URL_TTL_MS` | Worker call timeout, and lifetime of the signed URLs handed to it. | No | `55000` / `90000` |
| `DOCUMENT_CONVERTER_MAX_BYTES` | Largest document either side will convert (`converter.ts`, `document-worker.ts`). | No | `104857600` (100 MiB) |
| `DOC_CONVERT_CONCURRENCY` / `DOC_CONVERT_QUEUE_TIMEOUT_MS` | Local conversions at once per instance, and how long one waits for a turn (`signatures.service.ts`). | No | `1` / `45000` |
| `CHROMIUM_PATH` | The Chromium binary PDF export launches. The worker image sets `/usr/bin/chromium`. In local development it is optional: unset, the API uses the browser the backend `puppeteer` dev dependency installed. | Yes (worker) | none |

### Files, exports & templates

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `FILES_RETENTION_DAYS` | Days a deleted document is kept before the housekeeping files sweep destroys its object and row (`files.sweeper.ts`). | No | `30` |
| `FILES_UNFINALIZED_HOURS` | Age at which a claimed-but-never-finished upload row is collected. | No | `24` |
| `FILES_SWEEP_LIMIT` | Rows destroyed per sweep pass. | No | `500` |
| `FILES_SUBTREE_PAGE_SIZE` | Tree rows per page when walking a folder (`files.repository.ts`). | No | `200` |
| `FILES_EXPORT_LEASE_SECONDS` / `FILES_EXPORT_DRAIN_BUDGET_MS` / `FILES_EXPORT_HEADROOM_MS` / `FILES_EXPORT_MAX_ATTEMPTS` | Folder-export job queue (`zipExportJobs.ts`), drained by `POST /api/cron/signing-jobs`. | No | `120` s / 25 min / 5 min / `5` |
| `FILES_EXPORT_PAGE_SIZE` / `FILES_EXPORT_MAX_BYTES` | Tree rows held at once while zipping, and the largest archive allowed. | No | `FILES_SUBTREE_PAGE_SIZE` / 20 GiB |
| `FILES_EXPORT_TTL_MS` / `FILES_EXPORT_URL_TTL_MS` | How long a finished archive stays fetchable, and how long one minted URL lasts. | No | 24 h / 1 h |
| `TEMPLATE_MAX_BYTES` / `TEMPLATE_IMAGE_MAX_BYTES` / `TEMPLATE_IMAGE_TOTAL_MAX_BYTES` | Bounds on filling a template, checked from object metadata before the read (`templates.service.ts`). | No | 25 MiB / 10 MiB / code default |
| `TEMPLATE_RENDER_TTL_MS` / `TEMPLATE_RENDER_URL_TTL_MS` | Lifetime of a rendered template object (collected by housekeeping) and of its download URL. | No | 24 h / 15 min |
| `INVOICE_PDF_MAX_BYTES` | Largest invoice PDF accepted, checked against the size storage recorded (`invoices.routes.ts`). | No | 20 MiB |

### Housekeeping sweeps

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `UNVERIFIED_ACCOUNT_SWEEP_MODE` | `dry-run` reports what the never-verified-account sweep would delete; `on` deletes; `off` skips the pass (`unverifiedAccounts.service.ts`). Read a few dry runs before `on`. | No | `dry-run` |
| `UNVERIFIED_ACCOUNT_GRACE_DAYS` / `UNVERIFIED_ACCOUNT_SWEEP_BATCH` | Age before an unverified account is eligible, and accounts per run (capped at 1000). | No | `7` / `200` |
| `FIRM_DELETION_RETENTION_YEARS` | Years a soft-deleted firm is retained before the housekeeping firm purge (`lawfirms.service.ts`). | No | `10` |

### Misc backend

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `LOG_LEVEL` | Pino log level (`logger.ts:18`). | No | `info` |
| `POLICY_VERSION` | Current privacy/policy version stamped on consent (`privacy.service.ts:25`). | No | `1.0` |
| `RBAC_ENFORCED` | `true` enforces role permissions (`roles.service.ts:17`); off, every member gets the full permission set. Verify every member has a role before enabling. | No | off |
| `MAX_LAW_FIRMS_PER_USER` | Per-user firm cap (`userLimits.ts:1`). | No | `1` |
| `TEMPLATES_GC_DELETE` | `true` lets the housekeeping template GC delete orphaned template objects; off, it only reports them (dry run). Expired renders are collected either way (`templates.routes.ts:497`). | No | off |
| `K_REVISION` | Set by Cloud Run. Names the drain owner (`<revision>:<pid>`) on signing and export job leases (`app.ts`). | No | `local` |
| `*_CONCURRENCY` and `*_CACHE_MAX_ENTRIES` tunables | Per-instance fan-out and in-memory cache caps, e.g. `UPLOAD_INIT_CONCURRENCY` (6), `UPLOAD_FINALIZE_CONCURRENCY` (4), `ATTACHMENT_SIGN_CONCURRENCY` (8), `GCS_PAGE_CONCURRENCY` (24), `EVENT_OUTBOX_DISPATCH_CONCURRENCY` (4), `PERMISSION_CACHE_MAX_ENTRIES` (5000). Also `CALENDAR_LOCK_TIMEOUT_MS` (10000) and `CALENDAR_LOCK_MAX_HOLD_MS` (120000). None are in `.env.example`; grep `process.env` for the full set. | No | per reader |
| `SHARE_DIGEST_DEBOUNCE_MS` | Quiet period before a client file-share digest email goes out, so a burst of shares becomes one email (`shareNotifications.service.ts:11`). | No | `60000` (1 min) |
| `SHARE_DIGEST_MAX_WAIT_MS` | Ceiling on that debounce, so a steady drip of shares still notifies (`shareNotifications.service.ts:12`). | No | `300000` (5 min) |
| `COURTLISTENER_TOKEN` | Optional CourtListener API token for the one-off court seed script; raises its rate limit (`backend/db/seed/import-courts.ts`). Not read by the running app. | No | none (unauthenticated) |

### Docs sign-in gate

The API mints the session cookie the docs site's edge middleware verifies. Both sides must agree or the gate fails closed. See the [docs package guide](/dev/ops/deployment#docs-site).

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `DOCS_SESSION_SECRET` | HMAC secret for the `plx_docs` session JWT minted by `POST /api/auth/docs-session` (`docsSession.ts`). Must match the docs Vercel project's value exactly. | Yes (docs gate) | none (gate serves 503) |
| `DOCS_COOKIE_DOMAIN` | Parent domain the cookie is scoped to (e.g. `.paralegix.com`), so the app and the docs site both see it (`docsSession.ts:34`). Leave it blank locally, where a host-only cookie already spans the localhost ports. | Yes (deployed docs gate) | unset (host-only cookie) |
| `DOCS_COOKIE_NAME` | Cookie name, read by BOTH `docsSession.ts:24` and `docs/middleware.ts`. Change both sides or neither. | No | `plx_docs` |

### Product analytics (PostHog)

The backend sends only server-authoritative product events. It does not read the browser's
analytics choice. See [PostHog Analytics & Cookie Consent](/dev/security/posthog-analytics) for
the event catalog, data limits and consent flow.

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `POSTHOG_PROJECT_TOKEN` | Public ingestion token for backend firm, subscription and client invoice payment events (`serverAnalytics.ts`). Match the frontend token for the same environment. The test harness forces it empty. | No | unset disables server events |
| `POSTHOG_HOST` | Direct ingestion host for backend events (`serverAnalytics.ts`); use the host matching the project's data region. | No | `https://us.i.posthog.com` |
| `POSTHOG_PERSONAL_API_KEY` | **Secret.** Personal API key with person write scope on this environment's project only. Account erasure uses it to delete the person from PostHog (`deleteAnalyticsPerson`, `serverAnalytics.ts`), which the privacy policy promises. The test harness forces it empty. | Yes (staging, prod) | unset (erasure skips PostHog) |
| `POSTHOG_PROJECT_ID` | Numeric PostHog project id the personal key acts on (staging `623432`, production `623394`). | Yes (staging, prod) | unset (erasure skips PostHog) |
| `POSTHOG_API_HOST` | PostHog private API host for that call. | No | `https://us.posthog.com` |

## Frontend

Only `NEXT_PUBLIC_*` variables reach the browser (inlined at build; set per Vercel branch). None are secrets.

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | Backend base URL every service class calls (e.g. `auth.service.ts:33`). | Yes (deployed) | `http://localhost:5001/api` |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase web config (`config.ts:5`). | Yes | none |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase web config. | Yes | none |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase web config. | Yes | none |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Firebase web config. | Yes | none |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase web config. | Yes | none |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | Firebase analytics id (`config.ts:10`). | No | none |
| `NEXT_PUBLIC_APP_URL` | Origin used to build public intake-form links (`intakeForms.ts`). | No | the browser's own origin |
| `NEXT_PUBLIC_SITE_URL` | Canonical marketing-site URL for SEO metadata (`lib/seo/site.ts`). | No | `https://www.paralegix.com` |
| `VERCEL_ENV` | Set by Vercel. The site is indexable only when it is `production`; previews and local builds are `noindex` (`lib/seo/site.ts`). | No | set by platform |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL for Realtime messaging (`realtimeClient.ts:19`). | Yes (messaging) | none |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon (publishable) key (`realtimeClient.ts:20`). | Yes (messaging) | none |
| `NEXT_PUBLIC_DOCS_URL` | Origin of the VitePress docs site that the in-app `/docs` entry page hands off to after minting the session cookie (`app/docs/DocsClient.tsx`). | Yes (deployed) | `http://localhost:3005/docs` |
| `NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST` | Client-side route-guard bypass list (`emailVerification.ts`). Mirror of the backend var; keep in sync per env. | No | empty |
| `NEXT_PUBLIC_DUP_FETCH_WARN` | Dev-only diagnostic (`duplicateRequestGuard.ts`): warns in the console when the same GET is issued twice within 2s. On by default in development; `off` silences it. Always a no-op when `NODE_ENV=production`. | No | on (dev only) |
| `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` | Public browser ingestion token (`analytics.ts`). Match the backend token for this environment; unset disables browser analytics. Inlined at build time. | No | unset (off) |
| `NEXT_PUBLIC_POSTHOG_HOST` | Ingestion host used by the `/ingest` rewrite in `next.config.ts`; match the project's data region. Inlined at build time. | No | `https://us.i.posthog.com` |
| `NEXT_PUBLIC_POSTHOG_UI_HOST` | PostHog application host passed to the browser SDK (`analytics.ts`). Inlined at build time. | No | `https://us.posthog.com` |

## Feature flags & tunables

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `EVENT_OUTBOX_WORKER` | `true` enables the durable event-outbox worker (persist + retry) (`eventOutbox.ts:56`). Off = live emit is the sole dispatch path, no outbox writes. Retention runs from `POST /api/cron/housekeeping`, not the worker. | No | `false` (off) |
| `MAINTENANCE_MODE` | `true` returns 503 `MAINTENANCE_MODE` for all writes (POST/PUT/PATCH/DELETE); reads pass (`maintenanceMode.ts:6`). | No | `false` |
| `DB_TARGET` | `local`\|`staging`\|`prod` selects `DATABASE_URL_<TARGET>` (`resolveDbUrl.ts:12`); dev convenience, falls back to `DATABASE_URL`. `db/apply-schema.ts` refuses to run without it. | No | unset (uses `DATABASE_URL`) |
| `LOG_SUCCESS_SAMPLE_RATE` | 0..1 fraction of successful reads to log (`app.ts:421`); `1` logs every read, `0` none. Writes/errors always logged. | No | `0` |
| `DOCUMENT_CONVERTER` | `worker` sends conversions to the document worker; see [Document conversion](#document-conversion). | No | `local` |
| `RATE_LIMITS_DISABLED` | `true` skips every rate limiter (`rateLimiters.ts:50`). Set by the in-process test harness only; never in a deployment. | No | unset |
| `DOCS_INCLUDE_DEV` | `true` includes the internal Dev docs section in the VitePress build (`docs/.vitepress/config.ts`). Public build excludes it. | No | `false` |

### Rate limiting

Every cap is env-tunable with a safe default. See /dev/admin/rate-limiting for the full model.

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `GLOBAL_RATE_LIMIT_MAX` | Coarse per-IP backstop across all routes (`rateLimiters.ts`). | No | `1000` / min |
| `USER_RATE_LIMIT_MAX` | Per-**uid** cap across every authenticated route, applied inside `verifyToken`. | No | `600` / min |
| `HEAVY_READ_RATE_LIMIT_MAX` | Per-uid cap on scan-heavy reads (firm billing lists, files list/search/usage). | No | `240` / min |
| `UPLOAD_RATE_LIMIT_MAX` | Per-uid cap on direct-upload initialization and finalization routes. | No | `120` / min |
| `AUTH_RATE_LIMIT_MAX` | `POST /api/auth/login`, `/create-user`, `/complete-registration`, `/refresh-microsoft-token`. | No | `30` / min |
| `AUTH_FAILURE_RATE_LIMIT_MAX` | Per-IP cap on **failed** token verifications, charged in `verifyToken`'s catch. | No | `100` / min |
| `USER_EXISTS_RATE_LIMIT_MAX` | `POST /api/auth/check-user-exists` cap. | No | `10` / min |
| `OAUTH_CALLBACK_RATE_LIMIT_MAX` | OAuth callback cap. | No | `20` / min |
| `INVITE_LOOKUP_RATE_LIMIT_MAX` | Invitation-accept lookup cap. | No | `30` / min |
| `PUBLIC_SHARE_RATE_LIMIT_MAX` | Public share-link view/download cap. | No | `30` / min |
| `MESSAGE_SEND_RATE_LIMIT_MAX` | Firm-side message sends (direct + group share one bucket). | No | `30` / min |
| `PORTAL_MESSAGE_SEND_RATE_LIMIT_MAX` | Client-portal message sends, on their own bucket. | No | `30` / min |
| `CONVERT_RATE_LIMIT_MAX` | Document conversion (`/api/signatures/convert`, `/convert-docx`). | No | `30` / 15 min |
| `TEMPLATE_RENDER_RATE_LIMIT_MAX` | Template renders per user: PDF export, fill and preview share one bucket. At most two per user are also in flight at once (`templateFillSlot.ts`), which is not configurable. | No | `60` / 15 min |
| `SIGNING_ACTION_RATE_LIMIT_MAX` | Signing complete/decline cap (keyed by token). | No | `10` / min |
| `SIGNING_READ_RATE_LIMIT_MAX` | Signing read cap. | No | `120` / min |
| `SIGNING_VERIFY_RATE_LIMIT_MAX` | `POST /api/signing/verify` cap. | No | `10` / min |
| `SIGNING_GATE_RATE_LIMIT_MAX` | Access-code verification cap (keyed by token). Backed by a durable brute-force lock in the signature tables. | No | `5` / min |
| `INTAKE_READ_RATE_LIMIT_MAX` | Public intake-form read (`GET /api/intake/:token`), keyed per IP so nobody can exhaust a firm's public link. | No | `30` / min |
| `INTAKE_GATE_RATE_LIMIT_MAX` | Intake access-code verification, keyed on the URL token. The only brute-force control on that gate; there is deliberately no durable lock. | No | `5` / min |
| `INTAKE_SUBMIT_RATE_LIMIT_MAX` | Intake submissions, keyed on the URL token. | No | `5` / min |

### Email abuse controls

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `EMAIL_MAX_PER_RECIPIENT_PER_DAY` | Per-recipient daily send cap in `sendEmail()` (`emailService.ts:16`); `0` disables. | No | `100` / day |
| `EMAIL_VERIFICATION_WHITELIST` | Comma-separated emails exempt from server-side email-verification enforcement (`auth.ts`, `emailWhitelist.ts:23`). Unioned with a DB-managed table. A non-empty value in prod logs a startup warning. | No | empty (no exemptions) |

### Event-outbox worker tunables

Only relevant when `EVENT_OUTBOX_WORKER=true`. All read in `eventOutbox.ts`.

| Variable | Purpose | Default |
|---|---|---|
| `EVENT_OUTBOX_POLL_MS` | Dispatch poll interval. | `30000` |
| `EVENT_OUTBOX_BATCH` | Rows claimed per cycle. | `20` |
| `EVENT_OUTBOX_MAX_ATTEMPTS` | Attempts before dead-lettering. | `5` |
| `EVENT_OUTBOX_BACKOFF_MS` | Base retry backoff. | `30000` |
| `EVENT_OUTBOX_LEASE_MS` | Abandoned-row reclaim lease. | `300000` |
| `EVENT_OUTBOX_DISPATCH_CONCURRENCY` | Claimed rows dispatched at once. A row runs its listeners in sequence, so this is also the peak number of listener chains. | `4` |
| `EVENT_OUTBOX_RETENTION_MS` | Retention for `done` rows, applied by the housekeeping cron's `outboxRetention` pass. | 7 days |
| `EVENT_OUTBOX_FAILED_RETENTION_MS` | Retention for terminal/stale rows, same pass. | 30 days |
| `EVENT_OUTBOX_CLEANUP_MS` | Inert: the retention sweep moved to `POST /api/cron/housekeeping`, and this value now only appears in the worker's startup log line. | 1 hour |

## Docs build

The VitePress site under `docs/` reads these at build time (`docs/.vitepress/config.ts`) and, for the sign-in gate, in its Vercel Edge Middleware (`docs/middleware.ts`). See `docs/AGENTS.md`.

| Variable | Purpose | Required? | Default |
|---|---|---|---|
| `DOCS_INCLUDE_DEV` | `true` builds the internal Dev section; the default public build excludes `dev/**`, `features/**`, and internal specs via `srcExclude`. | No | `false` |
| `DOCS_SESSION_SECRET` | Verifies the `plx_docs` cookie at the edge. Must match the API's value exactly. | Yes (Vercel docs project) | none (gate serves 503) |
| `DOCS_APP_URL` | App origin the middleware redirects an unauthenticated visitor to. | Yes (Vercel docs project) | none (gate serves 503) |
| `DOCS_COOKIE_NAME` | Cookie name; must match the API side. | No | `plx_docs` |
| `ALGOLIA_APP_ID` / `ALGOLIA_SEARCH_KEY` / `ALGOLIA_INDEX_NAME` | Algolia DocSearch. Leave unset: the gate blocks the crawler, so local search is the mode in use and the build warns if these are set. | No | unset |

## Source

- `backend/.env.example`: the checked-in list of what a deployment sets
- `backend/src/server.ts`: production startup check, socket and shutdown timeouts
- `backend/src/shared/database/db.ts`, `resolveDbUrl.ts`, `connectionBudget.ts`: DB connection, `DB_TARGET`, pool sizing
- `backend/src/app.ts`: CORS, trust proxy, cron secret and lock, log sampling
- `backend/src/shared/documentConversion/converter.ts`, `workerClient.ts`, `pdfRenderer.ts`: `DOCUMENT_CONVERTER`, the worker vars and `CHROMIUM_PATH`
- `backend/src/modules/signatures/signingProfile.ts`, `signingJobs.ts`, `signing.validation.ts`: signing limits and queue
- `backend/src/modules/files/files.sweeper.ts`, `zipExportJobs.ts`: files sweep and folder exports
- `backend/src/shared/middleware/rateLimiters.ts` — rate-limit caps
- `backend/src/shared/services/emailService.ts` — email vars + per-recipient cap
- `backend/src/shared/events/eventOutbox.ts` — outbox worker tunables
- `backend/src/shared/middleware/auth.ts`, `backend/src/shared/utils/emailWhitelist.ts` — verification whitelist
- `frontend/src/lib/firebase/config.ts`, `frontend/src/lib/supabase/realtimeClient.ts` — frontend public vars
- `docs/.vitepress/config.ts` — `DOCS_INCLUDE_DEV`
- `docs/STAGING_SETUP.md` — per-environment values

# Secrets

Every application secret Paralegix depends on, what it unlocks, its blast radius if leaked, and where it lives per environment.

## Summary

Paralegix's secrets fall into four buckets: the **database** (`DATABASE_URL`,
Supabase keys), **Firebase/GCS** credentials (Auth + storage only, never data),
**payment/webhook** secrets (Stripe), and **operational** secrets (Resend,
`CRON_SECRET`, `DOCS_SESSION_SECRET`, the document-signing certificate). In
deployed environments these are Cloud Run environment variables (staging and
prod hold separate values); for local dev they come from `backend/.env` plus a
gitignored `serviceAccountKey.json`.

Startup performs a **fail-fast / warn** pass in production
(`backend/src/server.ts:10`): `DATABASE_URL` missing is fatal; missing
`SUPABASE_JWT_SECRET`, `CRON_SECRET`, `DOCS_SESSION_SECRET`, or Stripe webhook
secrets only disable the dependent feature and log a loud warning. The signing
certificate has its own production guard that refuses to boot-sign with the
bundled dev key.

For the full variable list and where each is set, cross-reference
/dev/ops/environment-variables.

## Key Takeaways

- **`DATABASE_URL` is the crown jewel.** It is the sole data store for every
  tenant. Leaking it exposes all firms' data. It is fatal-on-missing in prod.
- **The backend connects as `postgres` and bypasses RLS.** Tenant isolation is the
  *application's* job (every query is scoped by `law_firm_id`), so
  `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` carry no row-level safety net —
  treat them as god-mode.
- **Firebase creds are Auth + GCS only.** `FIREBASE_SERVICE_ACCOUNT_KEY` /
  `serviceAccountKey.json` never touch data (Firestore is gone). Blast radius is
  auth-identity management and the GCS bucket, not the database.
- **`serviceAccountKey.json` is gitignored and required in `/backend` for local
  dev.** In deployed environments the key comes from `FIREBASE_SERVICE_ACCOUNT_KEY`
  or Cloud Run's attached service account (ADC), not the file.
- **Webhook secrets are the *only* gate on webhook routes.** They are excluded
  from rate limiting; their signature check *is* the control. A leaked
  `STRIPE_WEBHOOK_SECRET` lets an attacker forge billing/payment events.
- **`CRON_SECRET` is compared timing-safe** (`app.ts` `timingSafeMatch`) and is the
  sole gate on `/api/cron/*` — leaking it lets anyone trigger reconciliation /
  reminder jobs.
- **Key rotation is an open backlog item.** No automated rotation exists, and
  moving live keys off `.env.production` into a managed secret store is a tracked
  ops task (see Rotation status).

## Inventory

| Secret | Purpose | Blast radius if leaked | Where stored | Rotation |
|---|---|---|---|---|
| `DATABASE_URL` | Supabase Postgres connection — all data access | **Total**: every tenant's data; connects as `postgres`, bypasses RLS | Cloud Run env (per-env); `backend/.env` locally | Manual, unrotated |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role (admin) API key; the backend uses it only to post content-free Realtime broadcast pings | Full Supabase project access, RLS bypass | Cloud Run env; `.env` | Manual, unrotated |
| `SUPABASE_JWT_SECRET` | Signs the Firebase-UID JWT for Realtime reads under RLS | Forge Realtime tokens for any uid, then read that user's rows in the RLS tables (messaging, notifications, signatures) | Cloud Run env; `.env` | Manual; **absence disables Realtime** (warned at startup) |
| `FIREBASE_SERVICE_ACCOUNT_KEY` / `serviceAccountKey.json` | Firebase Admin — **Auth + GCS storage only** | Mint/verify auth tokens, manage identities, full GCS bucket access | Env var (deployed) **or** gitignored file in `/backend` (local) **or** ADC (Cloud Run attached SA) | Manual, unrotated |
| `GCS_BUCKET` | Target storage bucket name (not itself secret) | Low — a name; access is gated by the Firebase/SA credential | Cloud Run env; `.env` (default `lawfirms`) | N/A |
| `STRIPE_SECRET_KEY` | Stripe API calls (checkout, Connect, refunds) | Charge/refund/move money, read customer + payout data | Cloud Run env (test key on staging, live on prod); `.env` | Manual, unrotated |
| `STRIPE_WEBHOOK_SECRET` | Verify `/api/webhooks` (payments) signatures | Forge payment/dispute/refund webhook events | Cloud Run env; `.env` | Manual; missing = webhook signature checks fail (warned) |
| `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` | Verify subscription/plan webhook signatures | Forge plan/billing-status changes | Cloud Run env; `.env` | Manual; missing = plan updates stop syncing (warned) |
| `RESEND_API_KEY` | Outbound email via Resend | Send mail as Paralegix; deliverability/reputation abuse | Cloud Run env; `.env` | Manual; **absence skips all email** (not fatal) |
| `CRON_SECRET` | Bearer/`x-cron-secret` gate on `/api/cron/*` | Trigger reconciliation/reminder/backfill jobs | Cloud Run env; `.env` | Manual; timing-safe compared; absence → cron returns 503 everywhere except a local loopback request |
| `P12_PASSPHRASE` | Passphrase for the PKCS#12 signing cert | Digitally seal PDFs as "Paralegix" | Staging: Secret Manager `staging-signing-p12-passphrase`, injected as env; prod: **not provisioned**; **not** in repo | Manual; **required in prod** (guard below) |
| `SIGNING_P12_PATH` | Path to the provisioned signing `.p12` cert | Same as above, the sealing private key | Staging: Secret Manager `staging-signing-p12`, mounted at `/secrets/signing/paralegix-signing.p12`; prod: **not provisioned** | Manual; **required in prod** |
| `DOCS_SESSION_SECRET` | Signs the HS256 JWT that gates the docs site (`POST /api/auth/docs-session`) | Mint a valid docs-site session cookie for any account | Cloud Run env; `.env`; must match the value set on the docs Vercel project | Manual; absence warned at startup, docs sign-in fails |

## Database & Supabase

`DATABASE_URL` is the sole data store and is fatal-on-missing in production
(`server.ts:10`). Locally, `DB_TARGET=local|staging|prod` selects
`DATABASE_URL_LOCAL` / `_STAGING` / `_PROD` instead, falling back to
`DATABASE_URL` (`backend/src/shared/database/resolveDbUrl.ts`), so a developer
`.env` can hold the production connection string: treat it with the same care.
`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL` are read only by
`broadcastConversationEvent`, which posts an ids-only Realtime broadcast ping
(`backend/src/modules/messaging/messaging.realtime.ts:63`). `SUPABASE_JWT_SECRET`
signs the Firebase-UID JWT that lets the browser read Realtime through Postgres
RLS (`messaging.realtime.ts:14`); if unset, Realtime is explicitly unconfigured
and errors on use, and prod warns at startup (`server.ts:16`). Because the
backend connects as `postgres` and bypasses RLS everywhere except that Realtime
JWT path (messaging, notification and signature tables, see
/dev/security/multi-tenancy), these secrets grant unscoped access to all tenants.
There is no database-enforced isolation behind them.

## Firebase & GCS

`backend/src/shared/database/firebase.ts` initializes Firebase Admin for **Auth
and GCS only**; it never touches data. Credential resolution order (`firebase.ts:6`):

1. `FIREBASE_SERVICE_ACCOUNT_KEY` (JSON string in env) — deployed default.
2. `require('../../../serviceAccountKey.json')` — the **gitignored** file required
   in `/backend` for local dev.
3. Application Default Credentials (ADC) — Cloud Build / Cloud Run's attached
   service account, when neither of the above is present.

`GCS_BUCKET` selects the storage bucket (default `lawfirms`); it is a name, not a
secret, but must match across every storage module. Blast radius of the Firebase
credential is auth-identity management and full bucket access — never the database.

## Stripe & webhooks

`STRIPE_SECRET_KEY` (`backend/src/modules/stripe/stripe.config.ts:4`) drives all
Stripe API calls; staging uses test-mode keys, prod uses live. Two independent
webhook signing secrets gate the two webhook routers:

- `STRIPE_WEBHOOK_SECRET` — payments webhook
  (`backend/src/modules/stripe/stripe.webhook.routes.ts:36`).
- `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` — subscription/plan webhook
  (`backend/src/modules/subscriptions/subscriptions.webhook.routes.ts:21`).

Webhook routes are intentionally exempt from rate limiting: the signature check is
their sole gate (see /dev/admin/rate-limiting). Missing either secret in prod does
not crash the server but silently breaks signature verification, so plan/billing
updates stop syncing, hence the loud startup warning (`server.ts:23`).

## Operational secrets

- **`CRON_SECRET`** — the sole gate on `/api/cron/*`. The request must present it
  as a `Bearer` token or `x-cron-secret` header, compared with
  `crypto.timingSafeEqual` (`backend/src/app.ts` `authorizeCronRequest`). If it is
  unset, cron endpoints return 503 ("Cron authorization is not configured")
  rather than running unauthenticated, in every environment. The one exception
  is a developer's own process: `NODE_ENV` of exactly `test` or `development`,
  a connection from the loopback socket with no forwarding header, and
  `x-cloudscheduler: true`. A bare `x-cloudscheduler` header no longer
  authorizes anything on a deployed server.
- **`RESEND_API_KEY`**: outbound email. Absence is non-fatal:
  `initResend()` logs a warning and every send is skipped
  (`backend/src/shared/services/emailService.ts:130`).
- **`DOCS_SESSION_SECRET`** signs the HS256 JWT the docs site uses as its
  sign-in cookie (`POST /api/auth/docs-session`,
  `backend/src/modules/auth/docsSession.ts`). Must match the value configured
  on the separate docs Vercel project (`docs/AGENTS.md`), or a minted cookie
  fails verification there. Missing in prod logs a startup warning, the API
  answers `503 DOCS_SESSION_UNCONFIGURED` to a mint request, and the docs site
  itself fails closed (503, `docs/middleware.ts`) without it. Two companion
  settings are not secret but must agree across both deployments:
  `DOCS_COOKIE_NAME` (default `plx_docs`, read by both sides; staging and prod
  share a parent domain, so they need distinct names) and `DOCS_COOKIE_DOMAIN`
  (API only). See /dev/security/auth-tokens.

## Document-signing certificate

`backend/src/modules/signatures/digitalSign.ts` embeds a PKCS#7/CMS signature
into sealed PDFs using a PKCS#12 (`.p12`) certificate. Loading
(`digitalSign.ts:18`):

- Cert path is `SIGNING_P12_PATH` (resolved absolute) or, in dev only, the
  in-repo `paralegix-signing.p12`.
- Passphrase is `P12_PASSPHRASE` (default empty string for the dev cert).
- The buffer is read once and cached (`digitalSign.ts:24`).

**Production guard.** `assertProductionCertConfig()` (`digitalSign.ts:30`) runs at
certificate load (first sign / startup smoke) and, when
`NODE_ENV === 'production'`, **throws** if `P12_PASSPHRASE` is unset/empty *or* if
`SIGNING_P12_PATH` is unset / still resolves to the bundled dev cert. This makes a
misprovisioned prod deploy fail loudly rather than silently sealing documents with
an empty-passphrase dev key. The cert's private key is the highest-value signing
secret: leaking it lets an attacker forge "Signed by Paralegix" seals.

**Where it lives.** Staging holds a self-signed, passphrase-protected cert in
Secret Manager: `staging-signing-p12` is mounted into the container as a file and
`staging-signing-p12-passphrase` is injected as `P12_PASSPHRASE`, both read by the
service's runtime identity through `roles/secretmanager.secretAccessor`. These are
the only two values in Secret Manager today; the rest of the service environment is
still set by hand. Production has neither value, so it must get its own cert, never
staging's, before cutover. Provisioning and rotation steps: /STAGING_SETUP.

## Rotation status

No automated rotation exists for any secret today. Per the compliance audit, the
open ops items are: **rotate the live keys currently in `backend/.env.production`**
and **move them into a managed secret manager** rather than an env file. Staging's
signing certificate is already in Secret Manager; production's is not provisioned. Track these under
/dev/ops/environment-variables. Until then, rotation is a manual, per-environment
process: update the value in the Cloud Run service (and `.env` locally), redeploy,
and — for Stripe/webhook secrets — re-issue the corresponding secret in the Stripe
dashboard.

## Local dev rules

- `serviceAccountKey.json` is **gitignored** and **required in `/backend`** for
  local dev (Firebase Auth + GCS). It is never committed and never used in
  deployed environments.
- `backend/.dockerignore` excludes env files from the image so secrets are not
  baked into the container.
- Local runs read secrets from `backend/.env`; staging and prod each hold their own
  isolated values (separate Supabase project, GCS bucket, and Stripe mode).

## Source

- `backend/src/server.ts` — production fail-fast / warn on required secrets
- `backend/src/shared/database/firebase.ts` — Firebase Auth + GCS credential resolution
- `backend/src/shared/database/db.ts`, `resolveDbUrl.ts`: Postgres pool and `DB_TARGET` / `DATABASE_URL` resolution
- `backend/src/modules/auth/docsSession.ts`, `docs/middleware.ts`: `DOCS_SESSION_SECRET` issue and verify
- `backend/src/modules/stripe/stripe.config.ts` — `STRIPE_SECRET_KEY`
- `backend/src/modules/stripe/stripe.webhook.routes.ts`, `subscriptions/subscriptions.webhook.routes.ts` — webhook secret verification
- `backend/src/modules/messaging/messaging.realtime.ts` — `SUPABASE_JWT_SECRET`
- `backend/src/app.ts` — `CRON_SECRET` timing-safe cron gate
- `backend/src/shared/services/emailService.ts` — `RESEND_API_KEY`
- `backend/src/modules/signatures/digitalSign.ts` — P12 cert load + production guard

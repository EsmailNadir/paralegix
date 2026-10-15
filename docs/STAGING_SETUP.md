# Staging Environment Setup (`staging.paralegix.com`)

Goal: a `staging` branch deployed at `https://staging.paralegix.com` (frontend) plus a
dedicated staging backend, fully isolated from production data, for pre-release
verification and ongoing use as a staging tier.

Stack: **Frontend** = Next.js on Vercel · **Backend** = Express on **GCP Cloud Run**
(built by Cloud Build → Artifact Registry) · **DB** = Postgres (Supabase) · **Auth** =
Firebase Auth · **Storage** = GCS · **Payments** = Stripe.

> The `staging` git branch carries the application plus the config commits described below.

---

## Status (already done)

- ✅ The **Staging** Supabase project exists with the schema applied and current, including
  the trust expansion; `schema.sql` itself has been verified canonical against it (see the
  schema notes below). A dedicated **production** Supabase project has not been provisioned
  yet, because `main` does not yet carry this application: standing one up and applying
  `schema.sql` to it is cutover work, tracked in [Production Cutover](/PRODUCTION_CUTOVER).
- ✅ Code is env-configurable for staging: CORS origins via `CORS_ORIGINS`, Cloud Build
  service name via `_SERVICE_NAME`.

## Backing-service isolation posture

| Service | Posture |
|---|---|
| Postgres (Supabase) | **Staging** has its own project, schema applied and current. **Production** project not yet provisioned; see [Production Cutover](/PRODUCTION_CUTOVER). |
| GCS bucket | **Separate bucket** for staging. |
| Stripe | **Test-mode keys** for staging. |
| Firebase Auth | Separate project preferred; sharing tolerable early. |
| Resend (email) | Sandbox key or shared with a clear `EMAIL_FROM`; set `DISABLE_ALL_REMINDER_EMAILS=true` on staging. |

---

## 1. Code changes (already committed on `staging`)

- **`backend/src/app.ts`** — CORS origins read from `CORS_ORIGINS` (comma-separated),
  falling back to prod + localhost defaults.
- **`backend/cloudbuild.yaml`** — deploy step parameterized with `_SERVICE_NAME` /
  `_REGION` substitutions (defaults `paralegix-api` / `us-east4`).

---

## 2. Cloud Run: staging backend service

1. Create a Cloud Build trigger on the `staging` branch → `backend/cloudbuild.yaml`, with
   substitutions `_SERVICE_NAME=paralegix-api-staging` and
   `_DOCUMENT_WORKER_SERVICE_NAME=paralegix-document-worker-staging`.
2. First run creates the `paralegix-api-staging` service.
3. Set env vars/secrets on the service (see §5). Use Secret Manager for secrets.
4. Map a domain (e.g. `api-staging.paralegix.com`); add the DNS record Cloud Run provides.
5. Runtime settings are pinned in `backend/cloudbuild.yaml`, not set by hand: `min-instances=0`,
   `max-instances` via the `_MAX_INSTANCES` substitution (staging runs 1), `concurrency=80`,
   `cpu=1`, `memory=512Mi`, `timeout=3600`, request-based CPU allocation. See
   /dev/ops/deployment for what each one is for and what the instance ceiling actually is.
   The previous advice here, that a single max-instance was required because the in-process
   event outbox and calendar coalescing assume one instance, was not accurate; the real
   constraint is the Postgres connection budget.
6. Before the first build containing the document worker, create
   `document-worker@your-gcp-project.iam.gserviceaccount.com`. It must be a dedicated runtime
   identity with no database, Stripe, Supabase, Firebase Admin, or application secrets. The
   Cloud Build identity needs permission to attach it to Cloud Run. The build deploys the worker
   privately and grants only the API runtime identity permission to invoke it.
   Create a GCS lifecycle rule on the staging bucket that deletes objects under
   `document-conversion/` after one day. This is the backstop for a request that loses its API
   connection while the worker is finishing its short-lived conversion output.
7. The staging API is cut over to `DOCUMENT_CONVERTER=worker`, with `DOCUMENT_WORKER_URL`
   and `DOCUMENT_WORKER_AUDIENCE` pointing to the staging worker URL. The API service account
   (`344489562949-compute@developer.gserviceaccount.com`) is granted `roles/run.invoker` on
   `paralegix-document-worker-staging`. In Cloud Build, `_DOCUMENT_CONVERTER` is parameterized
   and defaults to `local` on production while staging runs with `worker`.

## 3. Vercel: staging frontend at `staging.paralegix.com`

1. Vercel → Domains: add `staging.paralegix.com`, assign to the `staging` branch; add the
   CNAME in DNS.
2. Branch-scoped env vars for `staging`:
   - `NEXT_PUBLIC_API_URL=https://api-staging.paralegix.com`
   - `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` → **Staging** project
   - `NEXT_PUBLIC_FIREBASE_*` → staging (or shared prod) Firebase
   - `NEXT_PUBLIC_DOCS_URL` → staging docs origin, e.g.
     `https://docs-staging.paralegix.com/docs` (see §5a)
   - `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_vZsdBPiANpcFoZWpf4K96L7arPGghZhRfGENAxsHecVd` (the **staging** PostHog
     project; a public, send-only token) and `NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com`
   - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` → the platform's **test-mode** publishable key (`pk_test_...`).
     The card form on the pay page and in the client portal loads Stripe.js with it, passing the
     firm's connected account. Without it, card payments that carry a credit card fee can't be taken.
3. Redeploy the branch.

## 4. Auth wiring (commonly missed)

- **Firebase Auth → authorized domains**: add `staging.paralegix.com`.
- **Google & Microsoft OAuth consoles**: register the staging redirect URIs
  (`https://api-staging.paralegix.com/api/auth/google-callback` and
  `https://api-staging.paralegix.com/api/auth/microsoft-callback`) and set
  `GOOGLE_REDIRECT_URI` / `MICROSOFT_REDIRECT_URI` to match. Otherwise OAuth fails with
  `redirect_uri_mismatch`.

## 5. Backend env vars (staging Cloud Run service)

Derived from the actual `process.env.*` reads in `backend/src`.

**Core:** `NODE_ENV=production` (Dockerfile default), `PORT` (unset — Cloud Run injects 8080),
`DATABASE_URL` (Staging Supabase, session-pooler), `PG_POOL_MAX` (optional),
`CORS_ORIGINS=https://staging.paralegix.com`, `TRUST_PROXY_HOPS` (match prod),
`CRON_SECRET` (staging-only).

**Analytics:** `POSTHOG_PROJECT_TOKEN=phc_vZsdBPiANpcFoZWpf4K96L7arPGghZhRfGENAxsHecVd` (the staging PostHog
project) and `POSTHOG_HOST=https://us.i.posthog.com`. Unset turns server events off. Also
`POSTHOG_PROJECT_ID=623432` and `POSTHOG_PERSONAL_API_KEY` (a secret personal key with person write
scope on the staging project), which account erasure uses to delete the person from PostHog.

**URLs:** `FRONTEND_URL` / `APP_URL` = `https://staging.paralegix.com`;
`WEBHOOK_BASE_URL=https://api-staging.paralegix.com`.

**Supabase:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` (Staging).

**Storage:** `GCS_BUCKET=<staging bucket>`. **Firebase:** `FIREBASE_SERVICE_ACCOUNT_KEY`.

**Email (Resend):** `RESEND_API_KEY` (sandbox), `EMAIL_FROM`, `SUPPORT_EMAIL`,
`COMPANY_POSTAL_ADDRESS`, `DISABLE_ALL_REMINDER_EMAILS=true`.

**OAuth:** `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, `MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI`.

**Stripe (TEST MODE):** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`, all six `STRIPE_*_PRICE_ID`,
`STRIPE_APPLICATION_FEE_RATE`, `STRIPE_APPLICATION_FEE_FIXED_CENTS`.

**E-signature (required):** `SIGNING_P12_PATH` and `P12_PASSPHRASE`. With
`NODE_ENV=production` the backend refuses to seal a document without both
(`assertProductionCertConfig`, `digitalSign.ts:30`). Every finalize job then fails with
`P12_PASSPHRASE must be set in production`, and the signer's page waits on "Sealing document"
until it times out. Production has no certificate either, so there is nothing to reuse.

Staging's certificate is a self-signed, passphrase-protected `.p12` held in Secret Manager.
The file is mounted into the container and the passphrase is injected as an env var:

| Secret Manager secret | Reaches the service as |
|---|---|
| `staging-signing-p12` | file at `/secrets/signing/paralegix-signing.p12` |
| `staging-signing-p12-passphrase` | env var `P12_PASSPHRASE` |

`SIGNING_P12_PATH=/secrets/signing/paralegix-signing.p12` is a plain env var. To provision it
again or rotate it:

```bash
# 1. Generate a passphrase and a .p12 encrypted with it. backend/scripts/generate-signing-cert.ts
#    writes an EMPTY passphrase, which production refuses, so pass one to node-forge yourself
#    (3DES, the only PKCS#12 cipher node-forge can read back).
openssl rand -hex 32 | tr -d '\n' > passphrase

# 2. Store both. Use `gcloud secrets versions add` instead of `create` to rotate.
gcloud secrets create staging-signing-p12 --data-file=paralegix-signing.p12
gcloud secrets create staging-signing-p12-passphrase --data-file=passphrase

# 3. Let the service's runtime identity read them (repeat for the passphrase secret).
gcloud secrets add-iam-policy-binding staging-signing-p12 \
  --member=serviceAccount:344489562949-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

# 4. Wire them into the service. `gcloud run deploy` from cloudbuild.yaml keeps these settings.
gcloud run services update paralegix-api-staging --region=us-east4 \
  --update-secrets=/secrets/signing/paralegix-signing.p12=staging-signing-p12:latest,P12_PASSPHRASE=staging-signing-p12-passphrase:latest \
  --update-env-vars=SIGNING_P12_PATH=/secrets/signing/paralegix-signing.p12

# 5. Delete the local passphrase and .p12 files.
```

A self-signed certificate seals correctly and tamper detection works, but Adobe Reader shows
the signer identity as not verified.

**Docs gate:** `DOCS_SESSION_SECRET` (generate per environment: `openssl rand -base64 48`;
the docs deployment needs the SAME value), `DOCS_COOKIE_DOMAIN=.paralegix.com` (the parent
domain, so the app and docs hosts share the cookie). Optionally `DOCS_COOKIE_NAME` (defaults
to `plx_docs`) — since prod and staging share that parent domain, set this to a
staging-specific value (e.g. `plx_docs_staging`) on both the staging backend and the staging
docs deployment if you want the two environments' docs sessions to stop overwriting each
other; leaving it unset keeps today's shared-name behavior.

**Required for permissions:** `RBAC_ENFORCED=true`. Its default is NOT fine: unset, or any value
other than `true`, makes `resolvePermissions` hand every member the full permission set
(`roles.service.ts:17,181,228`), so role limits and the Staff and Paralegal roles do nothing.
`cloudbuild.yaml` does not set it, so it must be present on the Cloud Run service itself. A
read-only GCP audit on 2026-09-16 UTC found it absent from `paralegix-api-staging`; staging is
therefore still running with RBAC enforcement off until this operational step is completed.

**Optional (defaults fine):** `EVENT_OUTBOX_*`, `MAX_LAW_FIRMS_PER_USER`,
`LOG_LEVEL`, `LOG_SUCCESS_SAMPLE_RATE`, `POLICY_VERSION`, `EMAIL_VERIFICATION_WHITELIST`.

**Document conversion cutover:** Start with `DOCUMENT_CONVERTER=local`. The worker mode also
needs `DOCUMENT_WORKER_URL` and `DOCUMENT_WORKER_AUDIENCE`, both set to the private worker's
Cloud Run `run.app` URL. Do not set `DOCUMENT_WORKER_ID_TOKEN` in Cloud Run. The API obtains its
short-lived ID token from its attached service identity.

## 5a. Docs site (separate Vercel project)

`docs/` is its own Vercel project, gated by `docs/middleware.ts`. Two env vars, both
required — the gate **fails closed** and serves 503 without them, so set them before
pointing a domain at it:

- `DOCS_SESSION_SECRET` — byte-identical to the backend's value for this environment. A
  mismatch rejects every cookie, which shows up as an endless redirect loop between the
  docs host and the app's `/docs` page, not as an error message.
- `DOCS_APP_URL` — the app origin to bounce unauthenticated readers through, e.g.
  `https://staging.paralegix.com`.

Leave `ALGOLIA_*` unset: DocSearch crawls the site, and the gate turns the crawler away, so
the index silently goes stale. VitePress local search is compiled into the build and works
behind the gate.

Set `DOCS_INCLUDE_DEV=true` only on a deploy that is meant to expose the internal/engineering
pages. The sign-in gate admits any authenticated user, including clients on the portal, so it
is not by itself a wall around internal docs.

## 6. Stripe staging webhooks

Create three test-mode webhook endpoints, all on the API version `stripe.config.ts` pins
(`STRIPE_API_VERSION`), and copy each signing secret into the matching env var:

| Endpoint URL | Events from | Env var |
|---|---|---|
| `https://api-staging.paralegix.com/api/webhooks/stripe` | your account | `STRIPE_WEBHOOK_SECRET` |
| `https://api-staging.paralegix.com/api/webhooks/stripe` | connected accounts (`account.updated` only) | `STRIPE_CONNECT_WEBHOOK_SECRET` |
| `https://api-staging.paralegix.com/api/webhooks/stripe-subscriptions` | your account | `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` |

Stripe will not send your own events and connected-account events through one endpoint, so
the payments route verifies against both of its secrets. An event only the Connect secret
verifies must name its connected account, or it is refused.

**Which events each endpoint gets is in `/dev/ops/webhooks`, and the two lists do not
overlap.** Two settings there are easy to miss:

- The Connect endpoint is the one created with **"Listen to events on connected accounts"**.
  Without it `account.updated` never arrives for a connected account, and a firm whose
  charges Stripe disables keeps showing as able to take payments until someone opens the
  settings page.
- Check the six price IDs with `npx tsx backend/scripts/verify-stripe-prices.ts` (run with the
  environment's values). Each annual ID was once a copy of the monthly one, so an annual plan
  billed monthly and was recorded as monthly.
- A webhook payload is rendered in the ENDPOINT's API version, not the SDK's. An endpoint
  left on an older version than `STRIPE_API_VERSION` sends payloads shaped for that version.
  An endpoint's version cannot be changed; create a new endpoint and disable the old one.
- **Decide `STRIPE_AUTO_RECOVERY_ENABLED` deliberately.** It defaults to off, and while it
  is off a dispute, refund or ACH return debits the platform and the code only logs what it
  would have reversed. Off is a reasonable choice for staging; leaving it unconsidered in
  production is not.

## 7. Cron / scheduled jobs

Either create staging Cloud Scheduler jobs hitting the staging backend with the staging
`CRON_SECRET`, or leave them off. Keep `DISABLE_ALL_REMINDER_EMAILS=true` regardless.

Staging runs four jobs, all in `us-east4`, all sending the secret as `x-cron-secret`. This
inventory was verified against Cloud Scheduler on 2026-09-16 UTC:

| Job | Schedule | Endpoint | Attempt deadline |
|---|---|---|---|
| `cron-staging-signing-jobs` | every minute | `/api/cron/signing-jobs` | 1800s |
| `cron-staging-housekeeping` | `30 3 * * *` | `/api/cron/housekeeping` | 300s |
| `cron-staging-reconcile-billing` | `0 9 * * *` | `/api/cron/reconcile-billing` | 180s |
| `cron-staging-trust-fee-sweep` | `0 10 * * *` | `/api/cron/trust-fee-sweep` | 180s |

**Signing does not finish without `cron-staging-signing-jobs`.** A document too large to seal
inside the signer's request, or one whose first seal attempt failed, waits in
`signature_processing_jobs` until this job drains it. Six failed attempts dead-letter the job.

The signing job already exists. The command below records its required shape for disaster
recovery or deliberate recreation:

```bash
gcloud scheduler jobs create http cron-staging-signing-jobs \
  --location=us-east4 \
  --schedule="* * * * *" \
  --uri="https://api-staging.paralegix.com/api/cron/signing-jobs" \
  --http-method=POST \
  --headers="x-cron-secret=$CRON_SECRET" \
  --attempt-deadline=1800s \
  --description="Drains durable signing jobs and folder export archives"
```

**Use `x-cron-secret`, not `Authorization`.** This job was first created with an
`Authorization` header whose stored value was the bare secret, with no `Bearer ` prefix. The
backend only strips a `Bearer ` prefix, so every run answered `403` and no signing job drained
on staging. The live job now has the working `x-cron-secret` header but still carries that
obsolete `Authorization` header too; it is redundant and can be removed during routine cleanup.
Recent attempts returned HTTP 200 during the 2026-09-16 UTC audit. Check a job with
`gcloud logging read` on `resource.labels.job_id`: a healthy run ends in an `AttemptFinished`
entry with no `PERMISSION_DENIED`.

## 8. DNS

| Host | Type | Target |
|---|---|---|
| `staging.paralegix.com` | CNAME | Vercel |
| `api-staging.paralegix.com` | CNAME/A | Cloud Run domain mapping |

## 9. Verification checklist

- [ ] `https://api-staging.paralegix.com/api/health` → 200
- [ ] `https://staging.paralegix.com` loads and calls the staging API
- [ ] Email/password sign-up → verify → login
- [ ] Google + Microsoft OAuth login (redirect URIs registered)
- [ ] Create firm/matter/client/task → rows land in **Staging** Supabase
- [ ] File upload/download hits the **staging** GCS bucket
- [ ] Messaging realtime works (Supabase RLS + JWT)
- [ ] Stripe test checkout completes and the staging webhook updates the firm
- [ ] No staging traffic in prod Supabase / prod GCS / live Stripe
- [ ] A staging login shows up in the **staging** PostHog project, not production
- [ ] Worker `/health` is healthy, unauthenticated worker invocation is denied, and only the API
  runtime identity has `roles/run.invoker`
- [ ] With `DOCUMENT_CONVERTER=worker`, authenticated conversions, signing preparation, template
  conversion, and anonymous signing links with and without an access code work

---

## Database schema notes (important)

- **Build new databases from `schema.sql` only**: `DB_TARGET=local npx tsx backend/db/apply-schema.ts`,
  or for a fresh non-local database `DB_TARGET=<target> npx tsx backend/db/apply-schema.ts
  --allow-nonlocal-create`. The script refuses a missing `DB_TARGET`, and refuses a non-local
  target without that flag. `schema.sql` is generated from `backend/db/schema/*.sql`
  (`npm run db:schema:build`) and already contains every numbered migration, so do **not**
  replay `migrations/*.sql` on a fresh DB. The old `0001`..`0262` chain was collapsed into it
  and deleted, and numbering restarted at `0001`.
- Existing databases advance through numbered files in `backend/db/migrations/` using
  `DB_TARGET=<local|staging> npx tsx backend/db/run-sql.ts <file>`. The runner records every file
  and checksum in `schema_migrations`, skips an exact match, and refuses a changed/replayed file.
- New migrations declare `-- migration-mode: expand` or `contract`. Apply expand migrations to
  local and staging **before** pushing code that requires them. Contract migrations are a separate
  later deployment and require explicit `--allow-contract` authorization.
- `apply-schema.ts --reset` is local-only and requires `--confirm-local-reset`; never reset staging
  or production. Use numbered forward migrations for every existing database.
- Staging was rebuilt from `schema.sql` when the chain was collapsed, so its
  `schema_migrations` ledger records only migrations written since. `npm run db:catalog-parity`
  (from `backend/`) is the check that a database built from `schema.sql` matches one migrated
  from `origin/staging` plus every migration since. The fixed counts once quoted here (92
  tables, 1271 columns, 125 functions) predate the collapse and are no longer maintained.

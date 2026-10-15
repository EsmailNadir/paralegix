# Deployment

What deploys where, how the backend image is built and shipped to Cloud Run, how CORS and environment isolation work, and how the docs site itself is published.

## Summary

Paralegix has four deployable surfaces: the **Next.js frontend** on Vercel, the public **Express API** on Cloud Run, the private **document worker** on Cloud Run, and the VitePress docs site on Vercel. Production tracks `main`; the `staging` branch deploys a fully isolated tier (`staging.paralegix.com` frontend, `api-staging.paralegix.com` backend) with its own Supabase project, GCS bucket, and Stripe test-mode keys. The backend build is environment-agnostic: one `cloudbuild.yaml` deploys either the prod or staging services by overriding substitutions on the branch trigger, and browser origins are set per-service via `CORS_ORIGINS`. The docs default build is public and excludes internal pages; the admin build sets `DOCS_INCLUDE_DEV=true` behind access control. The full staging setup/runbook lives at /STAGING_SETUP.

## Key Takeaways

- **Four targets, two platforms.** Frontend + docs on Vercel; API + document worker on Cloud Run.
- **`main` = production, `staging` = isolated staging.** Separate Supabase project, GCS bucket, and Stripe mode — no staging traffic ever touches prod backing services.
- **One `cloudbuild.yaml`, per-branch substitutions.** The staging trigger overrides `_SERVICE_NAME=paralegix-api-staging` and `_DOCUMENT_WORKER_SERVICE_NAME=paralegix-document-worker-staging`; prod uses the defaults `paralegix-api` and `paralegix-document-worker`. `_REGION` defaults to `us-east4`, and the Artifact Registry host is derived from it. Columbus (`us-east5`) is the intended home and is blocked on moving the service env vars into Secret Manager; see /dev/ops/cloud-architecture.
- **The build gates on typecheck, lint, repo guards, a compile, and a boot test** against `GET /api/health` before it ever builds an image, so a broken deploy fails in Cloud Build, not in production.
- **CORS is env-driven.** `CORS_ORIGINS` (comma-separated) sets allowed browser origins per service; unset falls back to the prod origins only in production, and adds localhost everywhere else.
- **The image forces `NODE_ENV=production`** so the cron authorizer and error scrubbing never fall back to dev behavior.
- **Docs isolation is build-time.** The public build omits `dev/**` entirely; only a `DOCS_INCLUDE_DEV=true` build (deployed behind auth) includes it.

## Backend — Cloud Run via Cloud Build

`backend/cloudbuild.yaml` runs these steps in order:

1. `npm ci --include=dev`.
2. `npm run typecheck` (both `src/` and the `db/` + `scripts/` tooling), `npm run lint`, then four repo guards: `db/check-js-count.ts`, `db/check-raw-query-count.ts`, `db/check-files-tree.ts`, and `db/build-schema.ts --check` (the assembled `db/schema.sql` must match `db/schema/*.sql`). The step runs under `set -euo pipefail`, so any one of them fails the build. It did not until 2026-09-15: bash reported only the last command's status, so a failing typecheck, lint or guard printed its error and the build deployed anyway, which is how three staging builds shipped while `check-files-tree` was failing.
3. `npm run build`, so the boot test has a `dist/` to run.
4. Boot test: start `dist/server.js` on port 8080, wait 5 seconds, and require a 200 from `GET /api/health`.
5. Build and push both images, then deploy both Cloud Run services.

The API image is `${_REGION}-docker.pkg.dev/$PROJECT_ID/paralegix-backend/api`; the worker image is `${_REGION}-docker.pkg.dev/$PROJECT_ID/paralegix-backend/document-worker`. Each is tagged with `:$COMMIT_SHA` and `:latest`, and the services deploy the `:$COMMIT_SHA` tag.

The Artifact Registry host is built from `_REGION` so the images and the services cannot land in different regions. Build logs use `CLOUD_LOGGING_ONLY`.

### Substitutions

```yaml
substitutions:
  _SERVICE_NAME: paralegix-api      # prod default; staging trigger overrides to paralegix-api-staging
  _DOCUMENT_WORKER_SERVICE_NAME: paralegix-document-worker
  _DOCUMENT_WORKER_SERVICE_ACCOUNT: document-worker@your-gcp-project.iam.gserviceaccount.com
  _REGION: us-east4                 # Columbus (us-east5) is intended; see cloud-architecture.
  _MAX_INSTANCES: '1'               # API ceiling, also passed as the MAX_INSTANCES env var
  _DOCUMENT_WORKER_MAX_INSTANCES: '2'
  _DOCUMENT_CONVERTER: 'local'      # written to the API on every deploy; see the cutover below
```

Set up **two Cloud Build triggers**: one on `main` (uses defaults), one on `staging` (override `_SERVICE_NAME=paralegix-api-staging` and `_DOCUMENT_WORKER_SERVICE_NAME=paralegix-document-worker-staging`). Both build from `backend/cloudbuild.yaml`. Before the first worker deployment, create the environment's `document-worker` service account and allow the Cloud Build identity to attach it. As a one-time bootstrap, grant the API runtime identity `roles/run.invoker` on only that worker service. Do not add `allUsers`. The build identity deliberately does not mutate Cloud Run IAM policy.

### The image

`backend/Dockerfile` is the API image. It keeps LibreOffice only while the local conversion fallback remains enabled. `backend/Dockerfile.document-worker` is the conversion image and starts `dist/document-worker.js` on port 8080. Both use multi-stage builds, `npm ci --omit=dev`, and copied `dist/` output only. The worker image installs only the packages the worker imports: its build stage runs `scripts/write-worker-manifest.ts` and prunes a copy of the lockfile to match, and `tests/config/documentWorkerImage.test.ts` fails when the worker imports a package that list does not name. Neither image contains `docs/`.

### Document worker boundary and cutover

The worker has no public invoker. The API authenticates the browser or public signing link before it mints a conversion command, then calls the worker with a Google-signed Cloud Run ID token. GCS signed URLs transfer document bytes between the services and are never returned to a browser or logged.

The worker (`backend/src/document-worker.ts`) is a bare `http` server with three routes: `GET /health`, `POST /internal/convert` (LibreOffice) and `POST /internal/render-pdf` (Chromium, for HTML template PDF export; see `shared/documentConversion/htmlPdf.ts`). A render command names signed URLs for the filled HTML, each template image and the output PDF, and is held to the same storage-host and 120-second rules as a conversion command. A command is a small JSON body naming a conversion id, an output format, and two V4 signed URLs; the worker refuses any URL that is not `https://storage.googleapis.com` with an `X-Goog-Expires` of 120 seconds or less. It downloads the source, runs LibreOffice, PUTs the result, and answers 422 with a generic message on any failure. The API side is `backend/src/shared/documentConversion/converter.ts`: it signs 90-second URLs (`DOCUMENT_WORKER_URL_TTL_MS`), waits up to 55 seconds (`DOCUMENT_WORKER_TIMEOUT_MS`), and caps a document at 100 MiB (`DOCUMENT_CONVERTER_MAX_BYTES`, read by both services).

`DOCUMENT_CONVERTER` is **pinned by the deploy step**: `--update-env-vars` writes `DOCUMENT_CONVERTER=${_DOCUMENT_CONVERTER}` on every API deploy, and the substitution defaults to `local`. Setting the variable by hand in the console is therefore undone by the next build. `local` preserves the pre-worker behavior and is the rollback setting. In `local` mode, a conversion of a document already in storage is either downloaded into the API process first (`convertStoredDocumentOrDownload`, which logs a warning) or refused with 503 (`convertStoredDocument`).

After the worker is healthy and the API identity can invoke it, cut over in one full revision rollout with no traffic split: set the two worker variables on the API service, and override `_DOCUMENT_CONVERTER=worker` on that environment's Cloud Build trigger so the build writes it.

```text
DOCUMENT_CONVERTER=worker            # via the trigger's _DOCUMENT_CONVERTER substitution
DOCUMENT_WORKER_URL=https://<worker Cloud Run URL>
DOCUMENT_WORKER_AUDIENCE=https://<worker Cloud Run URL>
```

**Staging was cut over on 2026-09-16.** Its trigger carries
`_DOCUMENT_CONVERTER=worker` and the running service holds the same value, so
LibreOffice no longer starts inside the API container there. The API service
stays at 512 MiB deliberately: the worker is the 1 GiB container, and in-process
conversion was what pushed the API past its limit three times in the fortnight
before the cutover.

**Production has NOT been cut over.** There is no `paralegix-document-worker`
service yet. The first `main` build after the code cutover creates it, but the
build deliberately does not mutate IAM. After that first deployment, grant the
production API runtime identity `roles/run.invoker` on that worker, set its URL
and audience on the API, and change the main trigger to
`_DOCUMENT_CONVERTER=worker` for the next full revision rollout.

A rollback is one variable in each place, the service and the trigger. Changing
only the service is undone by the next deploy, because the deploy step writes
`DOCUMENT_CONVERTER` from the substitution on every build.

The worker does not need database, Stripe, Supabase, Firebase Admin, or browser-session secrets. Its service identity is intentionally separate. Test authenticated conversion, signing upload/link preparation, template fill, and an anonymous signing link with and without an access code before removing LibreOffice from the API image.

### Runtime settings

These are **pinned in `backend/cloudbuild.yaml`'s deploy step**, so a service deployed from the
current pipeline receives them from versioned config rather than the console. They describe the
live staging services and the next production deployment. The old production revision predates
these flags and still has a 300s request timeout.

| Setting | staging | production | Why |
|---|---|---|---|
| `--max-instances` | 1 | 1 | Via the `_MAX_INSTANCES` substitution, `backend/cloudbuild.yaml`. See the ceiling below. |
| `--min-instances` | 0 | 0 | Scale to zero. The one Cloud Run setting that adds a **cost floor** rather than tracking usage, so it stays at 0. |
| `--concurrency` | 80 | 80 | Requests served simultaneously per instance. |
| `--cpu` | 1 | 1 | |
| `--memory` | 512Mi | 512Mi | API setting. The worker uses 1Gi and concurrency 1. |
| `--timeout` | 3600s | 3600s | The Cloud Run maximum. `/api/cron/signing-jobs` holds its request for up to 25 minutes (`SIGNING_JOB_DRAIN_BUDGET_MS`) while it drains signing and folder-export jobs; the other cron passes carry their own 150s budget (`REMINDER_CRON_BUDGET_MS`, 240s for the two reconcile passes that cannot resume). |
| `--cpu-throttling` | on | on | **Request-based** CPU allocation. Load-bearing; see below. |

Region is `us-east4` for both.

### Live GCP audit (2026-09-16 UTC)

The checked-in deploy step and the live staging tier agree: `paralegix-api-staging` has one
maximum instance, concurrency 80, 1 vCPU, 512 MiB, a 3600s timeout, request-based CPU, and
`DOCUMENT_CONVERTER=worker`; its private worker has concurrency 1, 1 vCPU, 1 GiB, a 120s
timeout, and a two-instance ceiling. The worker's only invoker is the API runtime service
account. The staging API sends 100 percent of traffic to its latest revision.

The same read-only audit found two important production/cutover facts:

- `paralegix-api` is still the older production revision. It has a 300s timeout and there is no
  `paralegix-document-worker` service yet.
- `RBAC_ENFORCED` is absent from the live staging API environment. Because the code defaults
  this flag off, custom role limits are not currently enforced on staging. Set it to `true`
  through a full revision rollout with no traffic split, after confirming every member has a
  valid role. The checked-in deploy step still does not manage this value.

**`_MAX_INSTANCES` is `1`, deliberately, for now.** The app is not technically limited to one instance: the multi-instance-readiness work is complete, and the durable outbox worker claims rows with `for update skip locked`, which is safe across concurrent instances. With staging's current `pool_size=20` and `POOLER_CEILING_SAFE=17`, one instance derives a 17-connection pool and two instances would derive 8 each. The service stays at one while there is no load reason to scale out. The deploy step also passes `--update-env-vars=MAX_INSTANCES=${_MAX_INSTANCES}` so `connectionBudget.ts` derives the same number the Cloud Run flag sets, deliberately `--update-env-vars` rather than `--set-env-vars` since the latter would replace every env var on the service.

Production is also a separate, pre-migration codebase that isn't live through this pipeline yet, so its `1` is doubly moot today. When production is eventually cut over to this branch, re-derive its own connection budget rather than inheriting staging's number: see the production cutover checklist below.

If a Cloud Build trigger in the GCP console carries its own `_MAX_INSTANCES` override outside this file (rather than inheriting the substitutions block here), update it by hand too. This file only controls the checked-in default.

> **Note for the eventual production cutover, not a current action.** Production runs a different, pre-migration codebase, and everything on this page describes the `staging` branch. When staging is eventually merged and production is rebuilt, two things will matter. First, the `paralegix-api` service spec currently references an image tag that Artifact Registry garbage-collected, and the digest its serving revision runs is gone too (Cloud Run keeps serving it from cache), so prod cannot be updated *in place* — the first real deploy from the merged branch pushes a fresh image and resolves it. Second, the retention policy that caused that has been fixed (30 days / keep 10, up from 1 hour / keep 3), so it will not recur. Prod is serving normally throughout; nothing here needs doing before the cutover.

**Request-based CPU allocation has consequences worth knowing.** Outside an in-flight request the instance's CPU is throttled to near zero, and at `min-instances=0` the steady state for a quiet API is no instance at all. So a `setInterval` in the backend does **not** run on a schedule: 24-hour sweeps effectively never fire, because no autoscaled instance lives that long. Background work belongs behind `/api/cron/*` where Cloud Scheduler guarantees it a request. If anyone ever switches this to `--no-cpu-throttling`, that reasoning changes, and so does the cost model.

**The worker owns document-conversion memory.** Its concurrency is 1, memory is 1Gi, timeout is 120 seconds, and its instance ceiling has its own substitution. This isolates `soffice` from ordinary API cold starts. Removing LibreOffice from the API is a later cleanup after a defined worker acceptance window.

### A flag that is read once at boot

**`RBAC_ENFORCED`** (`roles.service.ts`) picks which permission model is enforced, and it is
captured at module load rather than per request.

Because it is boot-cached, **an instance keeps the value it started with for its whole life**.
During a traffic split or a rolling revision, some instances answer with the old value and some with
the new one, so the same user can get two different answers depending on which instance takes their
request. That is a security-relevant inconsistency, not a cosmetic one.

**The rule: flip it with a full revision rollout and no traffic split**, and let the old revision
drain completely before considering the change live.

### How many instances can we actually run?

`DATABASE_URL` is the Supabase **session** pooler (Supavisor) on port 5432. Session mode hands every client connection a real Postgres backend with no multiplexing, so **per-instance pool size × instance count must fit inside the pooler's `pool_size`**. That setting is the limit that binds, not the database's `max_connections` (60 on staging). The staging pool size is **20**, raised from 15 on 2026-09-16. A connection past it is refused at once with `(EMAXCONNSESSION) max clients reached in session mode`; it does not wait for a free slot.

The ceiling was once sized against `max_connections` instead, at 40. With one instance that gave a 40-connection pool, and the first page load after an idle period opened more than 15 connections at once. Every query that could not get one failed, which the dashboard showed as several "Couldn't load, retry" widgets. `POOLER_CEILING_SAFE` tracks the pool size less 3 for migrations, `psql` and the Supabase dashboard. The pool size was raised from the Nano default of 15 to 20 on 2026-09-16, verified by opening 19 concurrent connections against staging, so the ceiling is now 17. Raising one without the other either wastes the headroom or brings the refusal back.

`backend/src/shared/database/connectionBudget.ts` derives the pool size and the dashboard fan-out limit from that ceiling and asserts the result at startup. At the current safe ceiling, one instance gets 17 connections and two get 8 each. Three would get 5 each, leaving only two after the three-connection reserve, so the dashboard would serialize heavily even though the arithmetic still passes. Raise the pool size in the Supabase dashboard before raising the instance ceiling beyond two, then raise `POOLER_CEILING_SAFE` to match. Re-measure this independently for production.

The old guidance here recommended a **single** max instance because "the in-process event outbox and calendar-sync coalescing assume one instance". That was never quite right: the outbox claims rows with `for update skip locked` and a lease, which is the standard multi-worker design, and the worker is off by default. The multi-instance correctness plan has since closed and its file was deleted, so the real constraint is the connection budget above.

### CORS

`backend/src/app.ts:338` reads `CORS_ORIGINS` (comma-separated), trims, and filters; unset falls back to `DEFAULT_CORS_ORIGINS`, which is the prod domains only when `NODE_ENV=production` and adds `localhost:3000/3001/3002` otherwise, so a deploy that forgets the variable fails closed. The exposed response headers are `Retry-After`, the three `RateLimit-*` headers, and `x-request-id`. Staging sets `CORS_ORIGINS=https://staging.paralegix.com`. `TRUST_PROXY_HOPS` (default `1`) matches the single Google front-end hop in front of Cloud Run so the forwarded client IP is trustworthy for rate limiting and audit.

## Frontend — Vercel

The Next.js app deploys on Vercel with a branch-per-environment model: `main` → production, `staging` → `staging.paralegix.com`. Environment values are branch-scoped Vercel env vars (all `NEXT_PUBLIC_*`, inlined at build): `NEXT_PUBLIC_API_URL` points at the matching backend (`https://api-staging.paralegix.com` for staging), and `NEXT_PUBLIC_SUPABASE_*` / `NEXT_PUBLIC_FIREBASE_*` point at that environment's projects. See /dev/ops/environment-variables for the full frontend list.

Auth wiring that must match per environment (commonly missed): add the frontend domain to Firebase Auth authorized domains, and register the staging OAuth redirect URIs in the Google/Microsoft consoles with matching `GOOGLE_REDIRECT_URI` / `MICROSOFT_REDIRECT_URI`, or OAuth fails with `redirect_uri_mismatch`.

## Staging vs production isolation

| Backing service | Posture |
|---|---|
| Postgres (Supabase) | Separate project per environment |
| GCS bucket | Separate bucket for staging |
| Stripe | Test-mode keys for staging, live for prod |
| Firebase Auth | Separate project preferred; sharing tolerable early |
| Resend (email) | Sandbox key; staging sets `DISABLE_ALL_REMINDER_EMAILS=true` |

Each environment carries its own full copy of the backend env vars pointing at its own services, plus two Stripe webhook endpoints (`/api/webhooks/stripe`, `/api/webhooks/stripe-subscriptions`) whose signing secrets go into `STRIPE_WEBHOOK_SECRET` / `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`. Cron jobs are per-environment Cloud Scheduler jobs authorized by that environment's `CRON_SECRET`. The staging verification checklist and DNS records are in /STAGING_SETUP.

> Production (`main`) is currently a different, older codebase that has not received the Postgres migration. The Postgres schema, billing/trust hardening, and the reconciliation crons described across these docs are live on `staging` only until the owner promotes them.

## Docs site

The docs live under `docs/` and build with VitePress. `docs/vercel.json` sets `buildCommand: npm run build`, `outputDirectory: .vitepress/dist`, `framework: vitepress`.

Two builds, gated by `DOCS_INCLUDE_DEV` in `docs/.vitepress/config.ts`:

- **Public build (default):** `DOCS_INCLUDE_DEV` unset/false. `srcExclude` drops the entire Dev section (`dev/**`, `features/**`, and internal specs like `STAGING_SETUP.md`) — the pages are not emitted at all, so the public site never serves internal architecture, admin, or ops content.
- **Admin build:** `DOCS_INCLUDE_DEV=true` includes the Dev section. Deploy this build behind access control (e.g. Vercel Password Protection or SSO) — it exposes ops, admin, and security pages.

Raw working design specs under `superpowers/**` are always excluded (they contain markup VitePress cannot render).

## Cron / scheduled jobs

The eight cron endpoints (`/api/cron/reminders`, `/api/cron/digest`, `/api/cron/calendar-watch`, `/api/cron/trust-fee-sweep`, `/api/cron/reconcile-billing`, `/api/cron/reconcile-trust-deposits`, `/api/cron/housekeeping`, and `/api/cron/signing-jobs`) are authorized by a timing-safe `CRON_SECRET` (Bearer or `x-cron-secret`); an unconfigured secret returns 503 in production. The same authorizer gates `GET /api/health/deep`, the operator probe that reports database reachability and pool saturation. Cloud Run's own probe stays on the shallow `/api/health`.

`/api/cron/signing-jobs` is the long-running exception. Staging schedules it every minute;
production must provision its counterpart during cutover. It drains
durable signing work (preparation hashes and finalization seals), then folder
export jobs (`zipExportJobs.ts`), then sweeps expired export archives. None of
that can
run inside the request that triggers them because Cloud Run stops scheduling CPU
once a response is sent. It holds an open request for up to 25 minutes, well
inside the 3600s Cloud Run ceiling, and leaves whatever it does not reach queued
with its attempt counts intact.

Provision it at **one minute** with a **30 minute HTTP attempt deadline**. The
scheduler's default attempt deadline is far shorter than the work, and one that
gives up mid-drain retries a job the drain is still inside. Running it every
minute is safe: mutual exclusion is per JOB, through a lease token re-checked on
every write, so two instances may drain at once and still cannot be inside the
same job. That is also why this route does not take the `CRON_PASS` lease the
other cron passes take: that lease expires after `CRON_LOCK_MAX_HOLD_MS` (10
minutes), far short of a 25 minute drain, and per-job exclusion is finer anyway.

Each run also fully re-reads ONE sampled sealed artifact and checks it against
what its session says it is. Production verification resumes the same saved hash
state that signing used, so a defect in that path would be invisible to it; this
is the only reader that recomputes from nothing. A mismatch is logged as an
alert and recorded on the session. See /dev/ops/cron-jobs. Webhook endpoints (Stripe, calendar) are covered in /dev/ops/webhooks.

## Source

- `backend/cloudbuild.yaml` — Cloud Build steps + `_SERVICE_NAME`/`_REGION` substitutions
- `backend/Dockerfile` / `backend/Dockerfile.document-worker`: API and conversion runtime images
- `backend/src/document-worker.ts`, `backend/src/shared/documentConversion/converter.ts`: the worker and the API's `DOCUMENT_CONVERTER` adapter
- `backend/src/app.ts` — CORS origins, trust proxy, cron authorizer
- `docs/vercel.json` — docs build config
- `docs/.vitepress/config.ts` — `DOCS_INCLUDE_DEV` gating
- `docs/STAGING_SETUP.md` — full staging setup + verification runbook

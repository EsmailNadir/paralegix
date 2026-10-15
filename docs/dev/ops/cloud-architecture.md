# Cloud Architecture

Where every piece of Paralegix runs today, which regions those pieces are in, and the target
architecture we intend to move toward. Complements /dev/ops/deployment (how code ships) and
/dev/ops/database (how the schema is managed).

## Summary

Paralegix runs across three vendors: **Vercel** (Next.js frontend and the VitePress docs),
**GCP Cloud Run** (the Express backend, built by Cloud Build into Artifact Registry), and
**Supabase** (Postgres plus Realtime). Two further Google services sit alongside Cloud Run:
**GCS** for file bytes and **Firebase Auth** for identity. The backend is therefore a GCP
workload talking to a database hosted on AWS, which is the single most consequential fact
about the current topology.

The current stack has three live Cloud Run services: the older production API
(`paralegix-api`), plus the staging API and its private document-conversion worker
(`paralegix-api-staging` and `paralegix-document-worker-staging`). The staging pair comes from
one `backend/cloudbuild.yaml` run and uses the same commit. The production worker does not exist
yet; the first post-cutover `main` build will create it. The remaining target work is completing
that production cutover, removing LibreOffice from the API image after the rollback window,
moving cron off HTTP endpoints and onto Cloud Run Jobs,
moving Postgres to **Cloud SQL** on a private IP, and replacing Supabase Realtime with SSE
fanned out through Postgres `LISTEN`/`NOTIFY`. Firebase Auth, GCS, and Vercel stay exactly
where they are.

**We are deliberately not moving to Cloud SQL yet.** Supabase is cheaper at our current user
count and the platform extras (Realtime, the dashboard, cheap staging) have real value while
the user base is small. Cloud SQL is the intended destination once cost and compliance
justify it. The section [Why we are staying on Supabase for
now](#why-we-are-staying-on-supabase-for-now) records that decision and the triggers that
would reverse it.

## Key Takeaways

- **The backend is on GCP, the database is on AWS.** Every query crosses clouds. That is the
  defining property of the current setup.
- **The compute is still in the wrong city, and the reason is the service environment.** The
  GCS buckets (`us-east5`) and Supabase (`us-east-2`) are in **Columbus**. Cloud Run is in
  `us-east4`, **Ashburn, Northern Virginia**, roughly 300 miles away, costing 10 to 20 ms on
  every database call plus cross-region transfer on every server-side file operation.
  `_REGION: us-east5` was tried on 2026-09-08 and the deploy failed. **A Cloud Run service
  cannot change region**, so the deploy created a NEW service, and a new service inherits only
  the environment `cloudbuild.yaml` passes it: `MAX_INSTANCES` (and now `DOCUMENT_CONVERTER`), and nothing else. The other 34
  variables were set on the `us-east4` services by hand and live nowhere in this repo, so the
  Columbus service booted without `DATABASE_URL` and its own startup guard exited it. Nothing
  broke: the `us-east4` services kept serving throughout.
  **The region move is blocked on making the service environment reproducible**, which means
  moving those values into Secret Manager and referencing them from `cloudbuild.yaml` with
  `--set-secrets`. Do that first, then the region flip is the one-line change it appears to be.
  Cloud Scheduler has no `us-east5` location either way, and that is free: every job is an
  empty POST to `https://api.paralegix.com`, so it carries no payload.
- **Multi-instance-ready, currently dialed to one.** The durable outbox worker claims rows
  with `for update skip locked` and a lease, which is safe for concurrent workers, so nothing
  in the app forces a single instance. `_MAX_INSTANCES` (`backend/cloudbuild.yaml`) is
  set to `1`. The Supabase session pooler's `pool_size` was raised from 15 to 20 on
  2026-09-16 (`POOLER_CEILING_SAFE=17`), which is enough for two instances of 8
  connections each. Raise the pool size in Supabase before raising it further.
  See /dev/ops/deployment.
- **The API image carries LibreOffice** (`backend/Dockerfile:22`), which makes it roughly 1 GB
  and makes cold starts slow. Staging's private document worker
  (`backend/Dockerfile.document-worker`) already handles conversion; production has no worker
  service yet. The API image keeps its own LibreOffice copy as the rollback path until the
  production cutover and worker acceptance window are complete. See
  /dev/ops/deployment.
- **File bytes mostly bypass the backend.** Uploads use resumable GCS URLs and downloads use
  signed URLs, so the browser talks to GCS directly. Signing, templating, folder exports and
  record archives still move bytes through Cloud Run, mostly in bounded windows or streams;
  the eight remaining whole-object reads are listed in
  `backend/tests/config/wholeObjectDownloadInventory.test.ts`.
- **Supabase lock-in is narrow.** Only `pgcrypto`, `citext` and `pg_trgm` are used
  (`backend/db/schema.sql:11`), so the schema is portable. Realtime is the one genuinely
  proprietary dependency.
- **Staying on Supabase is a cost decision, not an architectural preference.** Cloud SQL is
  the target; the trigger to move is documented below.

---

## Current State

### Compute

The current backend runs as an older production API plus a staging pair on **GCP Cloud Run**.
The staging API and private document-conversion worker are built from the same commit by
`backend/cloudbuild.yaml`. Their images are pushed to Artifact Registry at
`${_REGION}-docker.pkg.dev/$PROJECT_ID/paralegix-backend/api` and
`${_REGION}-docker.pkg.dev/$PROJECT_ID/paralegix-backend/document-worker`. The checked-in
pipeline will create the production worker on the first `main` deployment after cutover.

`_REGION` is `us-east4`. See the Key Takeaways above for why the `us-east5` attempt was reverted:
a region change creates a new service, and a new service does not inherit the 34 environment
variables that were set on these ones by hand.

One pipeline is configured for both tiers: the `main` trigger targets `paralegix-api` and
`paralegix-document-worker`, while the `staging` trigger overrides `_SERVICE_NAME=paralegix-api-staging` and
`_DOCUMENT_WORKER_SERVICE_NAME=paralegix-document-worker-staging` (`backend/cloudbuild.yaml:200`,
/STAGING_SETUP).

The API deploys at 512 MiB, 1 vCPU, concurrency 80, `min-instances=0`, CPU throttled; the worker
at 1 GiB, 1 vCPU, concurrency 1, a 120 s timeout, at most 2 instances, with no unauthenticated
invoker. Both are pinned in the deploy steps; the full table is in /dev/ops/deployment.

Four properties of the current compute setup matter:

| Property | Detail | Consequence |
|---|---|---|
| **Single instance for now** | `_MAX_INSTANCES=1` (`backend/cloudbuild.yaml`), deliberately dialed down; the outbox worker claims rows with `for update skip locked`, so nothing in the app requires this | Not a technical ceiling: the Postgres connection budget is the real limit. The current staging pooler safely supports two instances with pools of 8, but the service stays at one until load requires more. See /dev/ops/deployment. |
| **API image still bundles LibreOffice** | `node:22-slim` plus `libreoffice-core` and `libreoffice-writer` (`backend/Dockerfile:22`); staging's private document worker carries the same packages and is live | API image is roughly 1 GB and cold starts are slow, kept until production uses its worker and the rollback window closes. |
| **`min-instances=0`** | Pinned in the API deploy step (`backend/cloudbuild.yaml`) | Every cold start rebuilds the pg pool, which means TLS handshakes across clouds before the first request completes. |
| **Cron is HTTP** | Eight `POST /api/cron/*` routes on the same service, invoked by Cloud Scheduler and gated by `CRON_SECRET` (`backend/src/app.ts:217`) | Scheduled work competes with request traffic on the same instance. See /dev/ops/cron-jobs. |

The connection pool is capped at `PG_POOL_MAX` with a 30 s statement timeout and a 60 s
idle-in-transaction timeout (`backend/src/shared/database/db.ts:55`). Unless `PG_POOL_MAX` is
set explicitly, `connectionBudget.ts` derives it as `floor(POOLER_CEILING_SAFE / MAX_INSTANCES)`,
and falls back to 10 only when `MAX_INSTANCES` is unset. `PG_POOL_MAX` ×
instance count is what `connectionBudget.ts` derives against `POOLER_CEILING_SAFE`, so raising
`_MAX_INSTANCES` raises the platform-wide query ceiling proportionally, not the ten a single
instance implies on its own.

### Data

Postgres on **Supabase**, reached through Drizzle on one `node-postgres` pool. Fluent queries
and audited parameterized SQL share that executor; schema ownership stays with SQL files. Connection selection goes through `DB_TARGET`
(`backend/src/shared/database/resolveDbUrl.ts`), and TLS is enabled only when the URL contains
`supabase`. Production and staging are separate Supabase projects. Full detail in
/dev/ops/database.

Supabase is used for two of its products: Postgres and Realtime. Auth is Firebase and storage
is GCS, so the platform surface we depend on is unusually small.

### Storage

File bytes live in **GCS**, metadata in Postgres. The important detail is that the bulk path
does not traverse the backend:

- **Uploads:** an `upload-init` route reserves quota and mints a resumable GCS session URL, the
  browser PUTs the bytes directly, and an `upload-finalize` route verifies what storage
  recorded (`backend/src/modules/files/files.upload.routes.ts:233`,
  `backend/src/shared/storage/directUpload.ts`). Files, client-portal documents and
  attachments, messaging attachments, signing sources and template uploads all use this
  shape. No file-upload route buffers the request body in the API process.
- **Downloads:** signed URLs, so the browser reads from GCS directly
  (`backend/src/modules/files/files.storage.ts:334`,
  `backend/src/modules/files/shareLinks.service.ts:152`). Folder and multi-file downloads are
  export jobs: the archive is built in storage by the `/api/cron/signing-jobs` drain
  (`backend/src/modules/files/zipExportJobs.ts`) and the browser follows a link to it.

Server-side byte traffic that remains: signing reads bounded windows and appends revisions
rather than holding a document, export jobs stream objects into an archive, and eight calls
still read a whole object into memory (conversion results, record archive artifacts, the
emailed signed copy, template DOCX and HTML), each with a size bound that
`backend/tests/config/wholeObjectDownloadInventory.test.ts` pins. Those paths are free and
fast today only because Cloud Run and GCS are in the same cloud.

There is no storage abstraction layer. `admin.storage().bucket(...)` is called in 30 places
across 27 files.

### Auth and Realtime

**Firebase Auth** is the identity system. The backend surface is small (`verifyIdToken`,
`getUser`, `getUserByEmail`, `revokeRefreshTokens`, `deleteUser`, `createUser`), but
`verifyIdToken(token, true)` passes `checkRevoked`, which forces a network round trip on every
cold-cache verify. A 30 s TTL cache with LRU eviction and in-flight collapsing keeps that
bounded (`backend/src/shared/middleware/auth.ts:75`). `users.id` is the Firebase UID, so
identity is woven through every tenant table.

**Supabase Realtime** drives live updates. Four browser hooks subscribe to `postgres_changes`
(conversations, messages, notifications, signature sessions), authorized by a short-lived
HS256 JWT the backend mints with `SUPABASE_JWT_SECRET`
(`backend/src/modules/messaging/messaging.realtime.ts`). Six RLS policies exist solely to
serve this path. The browser connects to Supabase directly, so this traffic never touches the
backend.

### Outbound dependencies

The backend calls out constantly, and none of these are affected by which cloud hosts it:
Microsoft Graph for Outlook calendar (roughly 20 call sites in
`backend/src/modules/calendar/outlook/outlook.service.ts`), Google Calendar and the OAuth
token endpoint, Firebase Auth verification, Stripe, and Resend.

### Current topology

```
Browser ──► Vercel (Next.js)
   │
   ├──► Firebase Auth            (Google, global)
   ├──► GCS signed URLs          (Google, file bytes)
   ├──► Supabase Realtime        (AWS, WebSocket)
   │
   └──► Cloud Run us-east4 ──┬──► Supabase Postgres  (AWS us-east-2)  ◄── cross-cloud, ~300 miles
                             ├──► Document worker    (Cloud Run us-east4, IAM-private)
                             ├──► GCS                (Google us-east5, cross-region)
                             ├──► Firebase Auth      (Google)
                             └──► Graph / Stripe / Resend (public internet)
```

---

## Target Architecture

The goal is a server side that lives entirely inside one GCP VPC, with no public database
endpoint and no metered hop between compute and data.

| Layer | Target | Change from today |
|---|---|---|
| Frontend | **Vercel** | None |
| Auth | **Firebase Auth**, upgrading to Identity Platform when SAML SSO is required | None |
| Compute | **Cloud Run**, API service, document worker, and Cloud Run Jobs for cron | API service and document worker are already split and deployed; only cron moving off HTTP endpoints into Jobs remains |
| Database | **Cloud SQL for Postgres**, HA, private IP, no public endpoint | Migrate from Supabase |
| Realtime | **SSE from the backend**, fanned out via Postgres `LISTEN`/`NOTIFY` | Replaces Supabase Realtime |
| Storage | **GCS** | None |
| Region | Everything in **`us-east5` (Columbus)**, one VPC, matching where the buckets and database already are | `_REGION` is still `us-east4`; the move is blocked on making the service environment reproducible (see [Aligning on one metro](#aligning-on-one-metro)). Cloud Scheduler has no `us-east5` location and stays in `us-east4`, which is free: every job is an empty POST to the public API domain |

### Compute: one service becomes three

The original single service did three unrelated jobs: it served the API, converted documents,
and ran scheduled work. Splitting them fixes the image-size problem and the cron contention
problem. Two of the three splits are done; the third is still ahead.

1. **API service.** Already split out (`paralegix-api`). It still bundles LibreOffice as the
   rollback path (see the Key Takeaways above), so it has not yet reached the "no LibreOffice,
   fast cold start" end state, but the service itself is live.
2. **Document worker.** Already built and deployed on staging
   (`paralegix-document-worker-staging`, `backend/Dockerfile.document-worker`,
   `backend/src/document-worker.ts`). Staging uses `DOCUMENT_CONVERTER=worker`; production still
   uses local conversion and has no worker service. See /dev/ops/deployment for the cutover
   sequencing.
3. **Cloud Run Jobs for cron.** Not started. The eight `/api/cron/*` endpoints are still plain
   HTTP routes guarded by a shared secret. Turning them into Jobs would stop scheduled work from
   competing with request traffic, and would let `CRON_SECRET` stop being a credential that
   grants access to maintenance operations over the public internet.

### Data: Cloud SQL on a private IP

Cloud SQL bundles point-in-time recovery, where Supabase charges 100 USD per month per 7 days
of retention. For a product holding client trust funds, PITR is not optional, so this is a
direct like-for-like saving rather than a feature trade. Private IP also removes the database
from the public internet entirely, which is a materially better posture for SOC 2 and for
handling trust ledger data.

The schema is portable. Only `pgcrypto`, `citext` and `pg_trgm` are in use
(`backend/db/schema.sql:11`), all stock contrib extensions, and the generated `tsvector`
search columns, 12 functions, and 8 RLS policies are all vanilla Postgres. A migration is
`pg_dump` and `pg_restore` plus a connection string change.

### Realtime: SSE over `LISTEN`/`NOTIFY`

Replacing Supabase Realtime requires a push channel to the browser. Postgres
`LISTEN`/`NOTIFY` is the mechanism: every Cloud Run instance listens on a channel, Postgres
broadcasts, and each instance pushes to its own connected SSE clients. No Redis, no
Memorystore, no third-party pub/sub.

This is orthogonal to the instance count. The app is already multi-instance-ready and the
durable outbox already fans out safely across concurrent workers
(/dev/concepts/event-bus-outbox) regardless of how `_MAX_INSTANCES` is currently set; the
remaining motivation here is purely to replace the browser's WebSocket dependency on Supabase.

### Target topology

```
Browser ──► Vercel (Next.js)
   │
   ├──► Firebase Auth                  (Google, global)
   ├──► GCS signed URLs                (Google, file bytes)
   ├──► SSE from the API service       (our own backend)
   │
   └──► Cloud Run us-east5
          ├── API service (small image)
          ├── Document worker (LibreOffice)
          └── Cloud Run Jobs (cron)
                 │
                 ├──► Cloud SQL us-east5    (private IP, no public endpoint)
                 ├──► GCS us-east5          (same region)
                 └──► Graph / Stripe / Resend (public internet)
```

### Why GCP rather than consolidating on AWS

Three reasons specific to this codebase:

1. **Firebase Auth is the strongest component and it is Google's.** It is free to 50k MAU
   against Cognito's 10k, it already handles the Google and Microsoft OAuth flows, and the
   eventual SAML SSO requirement is a config upgrade to Identity Platform rather than a
   rewrite. On AWS we would either carry a Google dependency forever or downgrade auth.
2. **Cloud Run suits this workload better than Fargate or App Runner.** Scale-to-zero,
   per-request billing, and tolerance for large images all matter here. Fargate has no
   scale-to-zero; App Runner bills for provisioned idle.
3. **AWS adds a NAT Gateway cost that GCP does not have.** Private compute reaching the
   internet on AWS costs roughly 32 USD per month plus 0.045 USD per GB processed. Our backend
   is a heavy outbound caller (Graph, Google Calendar, Firebase, Stripe, Resend), so that is a
   permanent recurring cost against a permanently chatty service.

Moving compute to AWS would also **not** reduce Supabase egress. Supabase meters egress at the
project regardless of where the client connects from, so same-region colocation does not waive
it.

---

## Why we are staying on Supabase for now

Cloud SQL is the intended destination, but the move is deferred deliberately.

At our current user count, Supabase is the better economic choice. The Pro plan at 25 USD per
month plus a small compute add-on covers the workload comfortably, and the usage-based
components are negligible at this scale: egress is included up to 250 GB, disk up to 8 GB, and
Realtime up to 500 peak connections. Firebase Auth handles identity, so Supabase MAU pricing
never applies to us at all. On top of that we get Realtime for free, which is otherwise work
we would have to build, plus a usable SQL editor, log explorer, and a cheap isolated staging
project.

Cloud SQL at an equivalent size costs roughly 100 USD per month before storage, and does not
include Realtime. Paying that now, to solve scaling and compliance problems we do not yet
have, would be optimizing ahead of need.

**Triggers that should reverse this decision.** Any one of these makes Cloud SQL the cheaper
or safer option:

1. **We turn on PITR.** This is the most likely trigger and the clearest. 100 USD per month per
   7 days of retention on Supabase is bundled free with Cloud SQL. The moment trust-accounting
   durability requires PITR, the economics invert.
2. **SOC 2 work begins.** A public database endpoint and a second cloud in the audit boundary
   both become liabilities. Cloud SQL on a private IP removes both.
3. **We outgrow roughly 8 GB of RAM.** Below that, Supabase compute is much cheaper. At and
   above it the two are near parity, and committed-use discounts push GCP ahead.
4. **Egress becomes a real line item.** Roughly 15k to 25k active users, based on an estimate
   of 300 MB to 1 GB of database egress per active user per month.

Until one of those fires, the correct move is to stay on Supabase. Multi-instance readiness,
formerly the actual ceiling, is done (see the Key Takeaways above); the connection budget
against the current Supabase tier is worth watching regardless of
where the database lives.

---

## Regions

The intent was for everything to sit in Columbus. **The storage and the database are in
Columbus. The compute is not.** Cloud Run is the outlier, roughly 300 miles away in Northern
Virginia.

**Verified live against the GCP and Supabase APIs, not inferred from config:**

| Component | Region code | Actual city | How verified |
|---|---|---|---|
| Cloud Run `paralegix-api` | `us-east4` | **Ashburn, N. Virginia** | `gcloud run services list` |
| Cloud Run `paralegix-api-staging` | `us-east4` | **Ashburn, N. Virginia** | `gcloud run services list` |
| Cloud Run `paralegix-document-worker-staging` | `us-east4` | **Ashburn, N. Virginia** | `gcloud run services list` |
| Cloud Run in `us-east5` | none | **Columbus, Ohio** | The failed migration service from 2026-09-08 is no longer present |
| Artifact Registry | `us-east4` and `us-east5` both exist; builds push to `us-east4` (derived from `_REGION`) | **Ashburn, N. Virginia** (the `us-east5` repo is unused) | `gcloud artifacts repositories list` |
| Cloud Scheduler jobs | `us-east4`, and staying there | **Ashburn, N. Virginia** | `gcloud scheduler jobs list` |
| GCS bucket `lawfirms` | `US-EAST5` | **Columbus, Ohio** | `gcloud storage buckets list` |
| GCS bucket `lawfirms-staging` | `US-EAST5` | **Columbus, Ohio** | `gcloud storage buckets list` |
| Supabase Postgres | `us-east-2` (AWS) | **Columbus, Ohio** | Pooler host `aws-1-us-east-2.pooler.supabase.com` |
| Vercel functions | `iad1` (default) | Washington, DC | No `frontend/vercel.json`, so account default |
| Firebase Auth | Global | n/a | No region to set |

The region codes are easy to confuse, which is very likely how this happened:

| Code | Cloud | City |
|---|---|---|
| `us-east-2` | AWS | Columbus, Ohio |
| `us-east4` | GCP | Ashburn, Northern Virginia |
| `us-east5` | GCP | **Columbus, Ohio** |
| `us-east-1` | AWS | Ashburn, Northern Virginia |

**GCP's Columbus region is `us-east5`, not `us-east4`.** The buckets went to Columbus as
intended. Cloud Run, Artifact Registry, and Cloud Scheduler went to Virginia.

`backend/cloudbuild.yaml` targets `us-east4` again (the `us-east5` flip was reverted in
`70905d49`), and the Artifact Registry host is derived from `_REGION` so the two cannot diverge
again. Cloud Scheduler is the one piece that cannot
follow: it has no `us-east5` location at all, which is worth remembering before someone files
its absence as an oversight. It costs nothing, because every job is an empty POST to
`https://api.paralegix.com` rather than a region-specific URL, so the jobs need no change
during the move.

### What this costs today

Two separate penalties, both currently active:

1. **Every database call crosses 300 miles.** Cloud Run in Ashburn to Supabase in Columbus,
   typically 10 to 20 ms of round-trip time per call.
2. **Server-side file operations pay cross-region transfer.** The paths that move bytes
   through the backend (signing windows, document conversion, DOCX templating, folder export
   archives, record archive export) read from a Columbus bucket into Virginia compute. That
   is inter-region egress inside GCP, roughly 0.01 USD per GB, plus the latency. This was
   previously an open question in this document. It is now confirmed to be happening.

Browser traffic is unaffected. Uploads and downloads use resumable and signed URLs straight to
the bucket, so those bytes never cross regions.

### Aligning on one metro

**Move Cloud Run to `us-east5` (Columbus).** This is the correct fix, because Columbus is where
two of the three backing services already live. It colocates the backend with both the GCS
buckets and Supabase in one move, eliminating both penalties above.

The alternative, moving the Supabase projects to `us-east-1` (Northern Virginia), would fix the
database hop but leave the buckets stranded in Columbus, so the file-streaming paths would keep
paying cross-region transfer. It solves one problem and preserves the other.

The service catalog was checked, and it is nearly complete. **Cloud Run supports `us-east5` at
Tier 1 pricing**, the same tier as `us-east4`, so the move is cost-neutral. Artifact Registry
supports it, and the `us-east5` repository already exists. **Cloud Scheduler does not: `us-east5`
is absent from `gcloud scheduler locations list` entirely.** That gap is harmless, because every
job is an empty POST to `https://api.paralegix.com`, so the jobs stay in `us-east4` unchanged.

The blocker is not the catalog. It is that **the service environment is not reproducible.** A
Cloud Run service cannot change region, so flipping `_REGION` creates a new service, and a new
service gets only what `cloudbuild.yaml` passes it. That is `MAX_INSTANCES` and, since
`5f65d632`, `DOCUMENT_CONVERTER`. The other 34
variables (`DATABASE_URL`, `FIREBASE_SERVICE_ACCOUNT_KEY`, the Supabase trio, the Stripe keys and
six price ids, the Google and Microsoft OAuth clients, `CRON_SECRET`, `DOCUMENT_WORKER_URL`) were
set on the `us-east4` services by hand and are recorded nowhere in this repo. The attempt on
2026-09-08 failed exactly there: the Columbus service started with no `DATABASE_URL` and the
app's own startup guard exited it.

Sequence that actually works:

1. Put the 34 values in **Secret Manager**, and reference them from `cloudbuild.yaml` with
   `--set-secrets` / `--set-env-vars` so a fresh service in any region comes up configured.
   This is worth doing on its own merits: today the running configuration exists only on the
   live services and cannot be reviewed, diffed, or rebuilt.
2. Flip `_REGION` to `us-east5` and deploy. The new services now boot.
3. Delete the `us-east4` domain mapping for the hostname and create the `us-east5` one. No DNS
   change: both `api.paralegix.com` and `api-staging.paralegix.com` are unproxied Cloudflare
   CNAMEs to `ghs.googlehosted.com`, which is region-independent. The gap is the managed TLS
   certificate for the new mapping, roughly 15 to 60 minutes.
4. Verify, then delete the `us-east4` services.

One caveat worth weighing: Vercel's functions default to `iad1` (Washington DC), which is close
to `us-east4` and further from `us-east5`. That matters only for server-side rendering that
calls the API, not for browser traffic, so it is a minor consideration against a clear win.

This is the cheapest latency improvement available and should be settled before any larger
hosting change.

Note that only one distinct pooler host appears across the `DATABASE_URL_*` entries, so staging
and production appear to share the `us-east-2` region. Confirm each project separately in the
Supabase dashboard.

---

## What Can Be Improved

Already done, kept here so the history is legible: the app-level single-instance constraint is
removed (multi-instance readiness plan closed out, durable outbox row-claiming is
concurrency-safe; see the Key Takeaways above and /dev/ops/deployment). `_MAX_INSTANCES` is
currently pinned to `1` as a deliberate operational choice, not a technical one, and can be
raised whenever there's a reason to. The Dockerfile dependency install already uses
`npm ci --omit=dev` (`backend/Dockerfile:35`), matching Cloud Build. The migration chain
(`0001` to `0262`) was collapsed into `backend/db/schema.sql`, which is generated from
`backend/db/schema/*.sql` and checked by `db/build-schema.ts --check` in Cloud Build; new
numbered migrations restarted at `0001` and are recorded in the `schema_migrations` ledger
by `run-sql.ts` (/dev/ops/database).

What remains, ordered by value per unit of effort:

- **Move Cloud Run to `us-east5` (Columbus).** The buckets and the database are already there;
  the compute is 300 miles away in Ashburn. This one move removes 10 to 20 ms from every
  database call and stops the server-side file paths paying cross-region transfer. See
  [Aligning on one metro](#aligning-on-one-metro).
- **Finish taking LibreOffice out of the API image** (`backend/Dockerfile:22`). The worker
  exists; what remains is the `DOCUMENT_CONVERTER=worker` cutover, an acceptance window, and
  then deleting the `apt-get` step. Until then roughly 1 GB of image is charged to every cold
  start of a service that mostly serves JSON.
- **Set `min-instances=1` on the production service.** A cold instance rebuilds the pool,
  which means up to ten TLS handshakes across clouds before the first request completes.
- **Introduce a storage abstraction.** `admin.storage().bucket(...)` is called in 30 places
  across 27 files, including a `bucket()` helper redeclared in 12 separate modules. One seam
  makes any future storage change tractable and is good hygiene in its own right.
- **Check the GCS egress line on the GCP bill.** File downloads go browser to GCS over the
  public internet, which is metered. For a document-heavy product this is plausibly the
  largest egress cost, larger than anything Supabase charges, and it is invisible until
  someone looks. If it is significant, a CDN in front of downloads or an S3-compatible store
  with no egress fees is a far smaller change than moving clouds.

### Open questions

- What is the actual measured round-trip time from Cloud Run to Supabase? The 10 to 20 ms
  figure is inferred from the 300 mile Ashburn to Columbus distance, not measured.
  Instrumenting a few representative queries would size the win from the region move.
- ~~Is `us-east5` a complete enough region for us?~~ **Answered: yes.** Cloud Run (Tier 1, same
  price as `us-east4`) and Artifact Registry both support it; Cloud Scheduler does not and stays
  in `us-east4` at no cost. The region move is instead blocked on getting the 34 service
  environment variables into Secret Manager, since a region change creates a new service that
  inherits none of them. Tried and reverted on 2026-09-08 (`b00c0d30`, `70905d49`).
- Is SOC 2 on the roadmap, and on what timeline? It is the strongest trigger for the Cloud SQL
  move and would change the sequencing above.
- How much inter-region transfer are the server-side file paths actually generating?
  Confirmed to be crossing regions, but the volume is unmeasured, so the cost is unknown.

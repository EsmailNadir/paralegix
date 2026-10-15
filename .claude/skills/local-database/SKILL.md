---
name: local-database
disable-model-invocation: true
description: Use when the user wants to run the backend against a local Postgres, switch which database it connects to (local/staging/prod), start or re-clone the local DB, or troubleshoot local DB connection errors. Covers the DB_TARGET env switch and the Podman Postgres container.
---

# Local Database

The backend's data store is Postgres. It can point at the online Supabase instances (staging/prod) or at a local Podman Postgres that holds a clone of staging's data. Which one it uses is controlled by a single env var.

## Switching databases — `DB_TARGET`

`backend/.env` has:

```bash
DB_TARGET=local            # local | staging | prod
DATABASE_URL_LOCAL=postgresql://postgres:postgres@localhost:5433/paralegix
DATABASE_URL_STAGING=postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
DATABASE_URL_PROD=postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
DATABASE_URL=<fallback used when DB_TARGET is unset>
```

`backend/src/shared/database/resolveDbUrl.ts` maps `DB_TARGET` → `DATABASE_URL_<TARGET>`, falling back to plain `DATABASE_URL`. Both the running app (`db.ts`) and `db/apply-schema.ts` use it. SSL is auto-enabled only when the URL contains `supabase`, so `local` runs without TLS.

**To switch:** change `DB_TARGET`, then restart the backend. That's the whole operation. The env
is read at process start, so a running server keeps its old connection until restarted —
`preview_stop`, then `preview_start` with `{ name: "backend" }`. Dev servers go through the
Browser pane rather than Bash; see the `run-local` skill.

`db/run-sql.ts` (the ad-hoc "apply one .sql file" script) honors `DB_TARGET` too — it calls the same `resolveDbUrl()`. So `DB_TARGET=staging npx tsx backend/db/run-sql.ts <file>` really does write to staging; there is no safety net where it quietly falls back to local.

**The test databases are separate and sit outside `DB_TARGET`.** The Jest suite reads
`DATABASE_URL_TEST` and appends `_$JEST_WORKER_ID`, so worker 1 gets `paralegix_test_1`. Build
them with `npm run test:db` (`scripts/setup-test-db.sh`), or `TEST_DB_COUNT=10
./scripts/setup-test-db.sh` for extra slots. They live in the same `paralegix-pg` container as
the dev database, so a stopped container breaks both. `tests/support/db.ts` refuses to run if
`DATABASE_URL_TEST` does not name a test database, and it overwrites `DATABASE_URL_PROD` and
`DATABASE_URL_STAGING` with a blocked URL so no spec can reach them.

## The local DB is a Podman container

- Container: `paralegix-pg` (image `docker.io/library/postgres:17`)
- Persistent volume: `paralegix-pgdata` (data survives restarts and `podman rm`)
- Host port: **5433** (5432 is left free in case a Postgres is already installed on the host)

Starting the backend does **not** start Podman. On macOS the order is:

1. `podman machine start` (skip if already running).
2. `podman start paralegix-pg`
3. Start the backend (`preview_start` with `{ name: "backend" }`).

If the backend throws `ECONNREFUSED ...:5433` on startup while `DB_TARGET=local`, the container isn't running — start it. Confirm health with:

```bash
podman exec paralegix-pg pg_isready -U postgres -d paralegix
```

To make the container come up automatically whenever the Podman VM starts,
enable the restart service once on macOS:

```bash
podman machine ssh systemctl --user enable podman-restart.service
podman update --restart always paralegix-pg
```

## What is NOT local

Even on `DB_TARGET=local`, auth and file storage stay in the cloud:
- **Firebase Auth** — logins still hit Firebase regardless of `DB_TARGET`.
- **GCS** — file byte downloads still hit the cloud bucket; only file *metadata* rows are local.
- **Messaging Realtime / RLS**: local Postgres connects as `postgres` and bypasses RLS. Cloud
  `postgres_changes` cannot observe local rows, but group-message broadcasts still reach
  Supabase when `SUPABASE_URL` and its service key are configured, regardless of `DB_TARGET`.

## Seeding the demo firm and its accounts

On a database with no `law_firms` row (a fresh local DB, or staging right after a rebuild), the
demo data goes in as two steps. Step one has to come first: the seeder needs a firm and an owner
to attach to, and it creates neither.

```bash
DB_TARGET=local npx tsx backend/db/seed/bootstrap-demo-firm.ts
```

`bootstrap-demo-firm.ts` writes the `users`, `law_firms`, `roles` and `members` rows for the three
Firebase accounts (`test1@gmail.com` Owner, `test2@gmail.com` Attorney, `client1@gmail.com` client
portal), creating the firm through the real `createLawFirm` service so it gets the same defaults a
signup would. It prints the firm id and the exact `seed-local-testdata.ts` command to run next.

Both scripts are idempotent, refuse `DB_TARGET=prod`, and need `--allow-remote` to write to a
hosted Supabase database. That flag is how staging gets seeded; there is no other way in.

`--portal-user <uid> --portal-email <email>` on the seeder turns its first client into a working
portal login. Portal access is `clients.user_id` and nothing else, so the uid is stamped onto the
client that already owns matters, invoices, a trust ledger, a conversation and a document request.

Two more scripts fill matters that already exist. Run them in this order, because their folder
names overlap and the later run owns the folders they share:

```bash
DB_TARGET=local npx tsx backend/db/seed/seed-matter-details.ts --firm <lawFirmId>
DB_TARGET=local npx tsx backend/db/seed/seed-matter-files.ts --firm <lawFirmId> --owner <userId>
```

`seed-matter-details.ts` adds notes, contacts, tasks, events, billables, invoices, trust entries
and conversations to every matter in the firm. `--no-files` skips the GCS uploads.
`seed-matter-files.ts` builds a deeper document tree in five of them, found by matter number.
Both write files through `seedFiles.ts`, which uses the same `files.repository` calls the upload
routes use: a folder is a row, a file is a row plus one object at an opaque `object_path`.

For volume and edge cases, run `seed-scenarios.ts` after `seed-local-testdata.ts` (it reuses that
script's stages and billing codes). `--firm` defaults to the one "Paralegix Demo Firm", and
`--allow-remote` works the same way as on the base seeder:

```bash
DB_TARGET=local npx tsx backend/db/seed/seed-scenarios.ts
```

It adds about 50 clients, 50 matters, 160 tasks, 350 activities, 30 invoices and 90 events, plus
the awkward cases: unicode, very long and missing values, every invoice status, a payment plan, a
40-line invoice, a settlement trust ledger, SOL today and passed, a crowded calendar day and a
120-message thread. Its rows are prefixed `5ce4a210`, so it never touches the base seeder's.

## Global reference catalogs

Two global tables (no `law_firm_id`) are filled by their own importers, not by the seeders above
and not by `schema.sql`. On a fresh database both are empty, and nothing errors: the court-name
suggestions and the Charge Codes UTBMS picker just show no results.

```bash
DB_TARGET=local npx tsx backend/db/seed/import-courts.ts   # court_catalog, ~3,400 rows from CourtListener
DB_TARGET=local npx tsx backend/db/seed/import-utbms.ts    # utbms_codes, from db/seed/utbms-codes.json
```

Both are idempotent upserts and honor `DB_TARGET` through `resolveDbUrl()`. They have no
`--allow-remote` guard, so `DB_TARGET=staging` writes to staging directly. `import-courts.ts`
needs network access and waits out CourtListener's rate limit; a `COURTLISTENER_TOKEN` in `.env`
makes it faster.

## Re-cloning staging into local

Do this to refresh the local data. It's a two-step clone (schema from the repo, data from a dump) because a full Supabase dump drags in the `auth`/`storage`/`realtime` schemas and Supabase roles.

Run `pg_dump`/`pg_restore`/`psql` **inside the container** via `podman exec` - the host generally has no Postgres client tools installed, and the in-container binaries always match the server version.

> Windows only: under Git Bash/MSYS, prefix any `podman exec` command that passes a container path (`-f /tmp/...`) with `MSYS_NO_PATHCONV=1`, or the `/tmp` path gets rewritten to a Windows path. Harmless to omit on macOS and Linux.

1. **Reset + apply the repo schema.** First run a shim (Supabase objects `schema.sql` references but vanilla Postgres lacks), then `db/schema.sql`:

   > `schema.sql` applies to an empty database in ONE pass, and must keep doing so. Two rules
   > make that true, and both were broken until 2026-08-29: no table may reference one defined
   > later in the file (put such a foreign key in the DEFERRED CROSS-TABLE FOREIGN KEYS block
   > instead), and the two whole-schema sweeps must stay at the very end, because they act only
   > on the tables that exist when they run. If applying the file ever needs a second pass, that
   > is the bug: fix the ordering rather than running it twice. Running it twice silently
   > produces a DIFFERENT schema, because the sweeps re-run over the newly created tables.
   > `backend/scripts/setup-test-db.sh` applies it strictly and is the regression check.

   ```sql
   -- shim.sql
   do $$ begin
     if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
     if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
     if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
   end $$;
   create schema if not exists auth;
   create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
   create or replace function auth.uid() returns text language sql stable as $$ select null::text $$;
   do $$ begin
     if not exists (select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if;
   end $$;
   ```

   ```bash
   podman cp backend/db/schema.sql paralegix-pg:/tmp/schema.sql
   podman cp shim.sql paralegix-pg:/tmp/shim.sql
   podman exec paralegix-pg psql -U postgres -d paralegix -v ON_ERROR_STOP=1 \
     -c "drop schema if exists public cascade; create schema public;"
   podman exec paralegix-pg psql -U postgres -d paralegix -v ON_ERROR_STOP=1 -f /tmp/shim.sql
   podman exec paralegix-pg psql -U postgres -d paralegix -v ON_ERROR_STOP=1 -f /tmp/schema.sql
   ```

2. **Dump staging data and restore into local.** `--disable-triggers` is required (circular FKs `invoices`↔`billing_plan_periods`, plus the trust append-only trigger):

   `DATABASE_URL_STAGING` lives in `backend/.env` and is NOT exported into your shell, so
   load it first or the dump runs against an empty connection string and fails:

   ```bash
   set -a; . backend/.env; set +a
   podman exec paralegix-pg pg_dump \
     "$DATABASE_URL_STAGING?sslmode=require" \
     --data-only --schema=public --no-owner -Fc -f /tmp/staging-data.dump
   podman exec paralegix-pg pg_restore -U postgres -d paralegix \
     --data-only --disable-triggers --no-owner /tmp/staging-data.dump
   ```

Verify by comparing row counts (`select count(*) from law_firms;` etc.) against staging.

## First-time container creation

If the container doesn't exist at all (e.g. a fresh machine):

On macOS, install Podman (`brew install podman`), then initialize its VM once:

```bash
podman machine init --cpus 4 --memory 8192 --disk-size 60
podman machine start
```

Create Postgres with the 6 GiB memory limit required by the test suite:

```bash
podman run --name paralegix-pg --restart always --memory 6g --memory-swap 6g -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=paralegix \
  -v paralegix-pgdata:/var/lib/postgresql/data -p 127.0.0.1:5433:5432 -d docker.io/library/postgres:17
```

Then follow **Re-cloning staging into local** above to populate it.

## Container engine selection

`backend/scripts/setup-test-db.sh` prefers Podman when installed locally. CI
(`CI=true`) keeps Docker, and machines without Podman also keep Docker. Override
explicitly with `CONTAINER_ENGINE=docker npm run test:db` or
`CONTAINER_ENGINE=podman npm run test:db` from `backend/`. It never switches
engines after a failed health check. Dockerfiles and cloud deployments still use
Docker, and so does CI. Neither runs on a developer machine.

Podman and Docker have separate volumes, even when their names match. Switching
engines requires transferring the database. Keep the old Docker container stopped
and its volume intact until the transferred data is verified. Both containers
cannot bind host port 5433 at once.

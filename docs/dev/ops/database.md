# Database

How the Paralegix Postgres (Supabase) schema is defined, applied, and connected to, plus the tenancy, money, and date conventions every query must respect.

## Summary

Postgres (Supabase) is the **sole data store**. Drizzle is the application query layer, attached to the single `node-postgres` pool in `backend/src/shared/database/db.ts`; the SQL domain files in `db/schema/*.sql` (assembled into the generated `db/schema.sql`) and numbered SQL migrations remain authoritative. Firebase remains only for Auth and GCS, never data. Multi-tenancy is the application's responsibility: audited query contexts require `law_firm_id` on tenant paths, while named privileged contexts cover identity, token, scheduler, and admin work. Money is integer cents; day-only dates are returned as raw strings to avoid timezone drift.

## Key Takeaways

- **`db/schema/*.sql` is the authority; `schema.sql` is GENERATED from it.** Edit the domain file that owns the table, then `npm run db:schema:build` (from `backend/`). Never hand-edit `schema.sql`; `npm run db:schema:check` fails when it is out of date. Build fresh DBs from `schema.sql` with `DB_TARGET=local npx tsx backend/db/apply-schema.ts`, not from the migrations.
- **Migrations are deltas for existing DBs.** The old `0001`-`0262` chain was collapsed into `schema.sql` and the numbering restarted at `0001`. Apply a delta with `DB_TARGET=<target> npx tsx backend/db/run-sql.ts <file>`, which records it in the `schema_migrations` ledger. A shape change is a migration AND a domain-file edit in the same change; `npm run db:catalog-parity` proves the two paths still agree.
- **`--reset` drops and recreates the `public` schema, on local only.** It runs `drop schema if exists public cascade; create schema public;` before applying, and `apply-schema.ts` refuses it unless `DB_TARGET=local`, the host is local, and `--confirm-local-reset` is passed.
- **`DB_TARGET` picks the connection.** `local`\|`staging`\|`prod` map to `DATABASE_URL_<TARGET>`; unset falls back to plain `DATABASE_URL` for the app, but `apply-schema.ts` refuses to run without an explicit `DB_TARGET`, and `run-sql.ts` requires one for numbered migrations. SSL is auto-enabled only when the URL contains `supabase`.
- **Tenancy is enforced in the app, not the DB.** Every table carries `law_firm_id`; audited Drizzle query contexts enforce it on tenant paths, including the Drizzle-backed `DrizzleRepository` CRUD base. Miss it and you leak across tenants.
- **Money = integer cents (`*_cents`, bigint).** Dates split into `timestamptz` (ISO string) and `date` (raw `'YYYY-MM-DD'`) — the oid 1082 parser keeps day-only fields from shifting.

## Connection layer

`backend/src/shared/database/db.ts` exports:

- `pool` — the single `node-postgres` pool that Drizzle uses; connection budgeting and instrumentation remain here.

`drizzleClient.ts` attaches Drizzle to that pool. Application code uses the audited
contexts in `queryContext.ts`; direct `pool.query()`/client `.query()` calls are forbidden.

Pool config: `max` = `PG_POOL_MAX` from `connectionBudget.ts` (default `10`, or `floor(POOLER_CEILING_SAFE / MAX_INSTANCES)` when `MAX_INSTANCES` is set), `idleTimeoutMillis` = 30s, `connectionTimeoutMillis` = `PG_CONNECTION_TIMEOUT_MS` (10s), and server-side `statement_timeout` (30s) and `idle_in_transaction_session_timeout` (60s) on every session, TLS (`rejectUnauthorized: false`) enabled only when `needsSsl()` sees `supabase` in the string. At import time a missing URL only warns rather than throwing, so processes still boot; queries then fail loudly.

The date parser in `db.ts` registers oid 1082 (`DATE`) to return the raw `'YYYY-MM-DD'` string instead of a JS `Date`, which node-pg would otherwise parse at local midnight and risk shifting a day. Day-only fields (`due_date`, `entry_date`, `txn_date`, ...) therefore stay exact; do not wrap them in `new Date()`.

### `DB_TARGET` and `resolveDbUrl`

`resolveDbUrl.ts` maps `DB_TARGET` (upper-cased) to `DATABASE_URL_<TARGET>`, warning and falling back to `DATABASE_URL` if that specific var is empty. Both the running app and database tools use it, so a single env change re-points everything.

## Applying schema & migrations

### Fresh database (canonical)

```bash
cd backend && npm run db:schema:build                      # regenerate schema.sql from db/schema/*.sql
DB_TARGET=local npx tsx backend/db/apply-schema.ts         # apply schema.sql (idempotent create)
DB_TARGET=local npx tsx backend/db/apply-schema.ts --reset --confirm-local-reset
                                                           # DROP + recreate public first (LOCAL ONLY)
```

`db/schema/` holds one file per domain (`00_extensions.sql`, `10_identity.sql`, ... `95_deferred_fks.sql`, `99_sweeps.sql`); `build-schema.ts` concatenates them in filename order into `schema.sql`, and `--check` (`npm run db:schema:check`) fails when the generated file is stale. The file must apply to an empty database in one pass: a foreign key to a table defined later goes in `95_deferred_fks.sql`, and the whole-schema sweeps in `99_sweeps.sql` stay last.

`apply-schema.ts` loads `backend/.env`, resolves the URL via `resolveDbUrl`, applies `schema.sql`, then prints the resulting `BASE TABLE` count. It refuses to run without an explicit `DB_TARGET`, and a non-local target needs `--allow-nonlocal-create` (fresh databases only). `schema.sql` currently has **101 `create table` statements**. When you fold a delta in, the printed count is a quick sanity check that the fold landed.

### Existing database (upgrade delta)

```bash
DB_TARGET=local npx tsx backend/db/run-sql.ts backend/db/migrations/0014_your_migration.sql
```

`run-sql.ts` applies one `.sql` file through the selected database target and, for a file in `db/migrations/`, records its name and checksum in `schema_migrations` in the same transaction. The file's first line declares `-- migration-mode: expand` or `contract`; a contract migration is refused without `--allow-contract`, a concurrent index needs `--non-transactional`, and `DB_TARGET=prod` needs `--allow-prod`. Files must not open their own transaction. After the delta, edit the owning `db/schema/*.sql` file, rebuild, then refresh the Drizzle snapshot (`npm run db:pull`, `npm run db:drift`). The full procedure is the `new-migration` skill.

> Do NOT apply the migration directory to a database built from the current `schema.sql`. Every file there is already folded into it. A fresh database takes `schema.sql` alone; an existing one takes only the migrations missing from its `schema_migrations` ledger. `npm run db:catalog-parity` builds one database each way (current `schema.sql`, versus `origin/staging`'s `schema.sql` plus the newer migrations) and diffs their catalogs.

## Local Postgres clone

For offline development the backend can point at a Podman Postgres holding a clone of staging's data instead of hitting Supabase. Controlled entirely by `DB_TARGET`:

- Container `paralegix-pg` (image `docker.io/library/postgres:17`), volume `paralegix-pgdata`, host port **5433** (5432 is left free for a Postgres already installed on the host). The Jest test databases (`DATABASE_URL_TEST`, one per worker, built by `npm run test:db`) live in the same container.
- `backend/.env`: `DB_TARGET=local`, `DATABASE_URL_LOCAL=postgresql://postgres:postgres@localhost:5433/paralegix`.
- `npm run dev` does not start Podman: `podman machine start`, `podman start paralegix-pg`, then `npm run dev`. `ECONNREFUSED ...:5433` means the container is not running.
- Re-cloning is a two-step operation (repo schema via `apply-schema.ts`, then a `--data-only --disable-triggers` restore of a staging dump) because a full Supabase dump drags in the `auth`/`storage`/`realtime` schemas.
- Seeding an empty database is also two steps, in order: `backend/db/seed/bootstrap-demo-firm.ts` creates the demo firm, its owner and members, then `backend/db/seed/seed-local-testdata.ts` fills that firm (`seed-matter-details.ts` and `seed-matter-files.ts` add more per matter). The first two are idempotent, refuse `DB_TARGET=prod`, and need `--allow-remote` to write to a hosted database.

Even on `DB_TARGET=local`, Firebase Auth, GCS file bytes, and messaging Realtime still hit the cloud; only relational data is local. Full runbook: the `local-database` skill under `.claude/skills/`.

## Multi-tenancy scoping

Nearly every table carries a `law_firm_id` (uuid, FK → `law_firms`) and is keyed by `(law_firm_id, id)`. Tenant isolation is the **application's** job:

- The backend connects as the `postgres` role and **bypasses RLS**. RLS policies exist only on the tables the Supabase Realtime client reads directly through a Firebase-UID JWT: `conversations`, `messages`, `conversation_participants`, `notifications`, `signature_sessions`, `signature_participants`, `signature_sources`, `signature_processing_jobs`.
- Audited Drizzle tenant contexts require a `lawFirmId` scope and verify it survives into emitted SQL. The `DrizzleRepository` CRUD base also requires `lawFirmId`, maps `snake_case` ↔ `camelCase`, serializes jsonb, and executes through Drizzle. UUID tables reject malformed ids as not-found via `validId()`.
- Complex JOINs, junction operations, and transactions use fluent Drizzle where clear, or parameterized SQL through an audited Drizzle context where preserving a proven SQL shape is safer. They must always scope by `law_firm_id`; guard uuid params with `isUuid()` before querying uuid columns.

## Paging, sorting, and counting

Any query that serves an unbounded list goes through
`backend/src/shared/database/pagination.ts` rather than growing its own copy. It
exports `clampLimit`, `resolvePage`, `parseSortModel`, `parseIdList`,
`buildOrderBy`, `buildPageClause`, and `resolveWindowTotal`.

- **Never interpolate `limit`/`offset`.** `buildPageClause` pushes both onto the
  caller's param array and returns the ` limit $N offset $N` fragment. Several
  reads (trust, audit, catalog) previously string-built these and were converted.
- **`buildPageClause({ optional: true })` preserves the unpaginated contract.** A
  caller that sends no `limit` gets every matching row; the count is exact either
  way.
- **`buildOrderBy` whitelists sort fields with own-key lookup only.** A plain
  `map[key]` also resolves `constructor` / `__proto__` off `Object.prototype`,
  which would then be interpolated into the ORDER BY. Every expression in the
  whitelist must resolve in **both** the page CTE and the enriched outer select,
  since the same clause is applied in both positions.
- **The total rides on `count(*) over()` in the page query.** That window is
  evaluated over the returned rows, so an empty page carries no count at all;
  `resolveWindowTotal` issues a fallback count query only for an empty page past
  offset 0 (short-circuiting to 0 at offset 0, where empty genuinely means no
  matches). `countSql` must reuse the page query's WHERE with identical `$N`
  numbering, which is why callers snapshot their params **before**
  `buildPageClause` appends the paging ones.

Because the count window forces Postgres to materialize every matching row before
`LIMIT`, enrichment must not sit in the same select. The page-then-enrich CTE that
solves this is documented in [Server-Side Search](/features/server-side-search).

## Money, timestamps, and dates

- **Money** is stored as integer cents in `*_cents` columns (`bigint`); some totals are `generated always as ... stored`. Never store floats or dollars.
- **`timestamptz`** columns (`created_at`, `updated_at`, ...) come back as JS `Date`; shape to ISO on output. A `set_updated_at` trigger auto-bumps `updated_at` on UPDATE, so app code must not set it (repo helpers strip it).
- **`date`** columns come back as raw `'YYYY-MM-DD'` strings via the oid 1082 parser; treat them as strings, never `new Date()`.
- Text search on `matters`, `tasks`, `clients`, and `contacts` is `ILIKE '%term%'` via `toIlikeTerm()` (`shared/database/searchTerm.ts`), not full-text search; the `pg_trgm` extension and its `gin_trgm_ops` indexes in `schema.sql` are what make those substring matches indexable. Those four tables briefly carried generated `tsvector` `search` columns with GIN indexes, but nothing ever queried them (`to_tsvector('english', ...)` tokenizes names/emails/matter numbers badly), so they were dropped (old migration `0140`, since folded into `schema.sql`). The one remaining genuine full-text user is `court_catalog.search`, matched with `@@ websearch_to_tsquery(...)`.

## Trust & append-only tables

`trust_transactions` is append-only: a DB trigger blocks edit/delete of completed entries, so corrections are reversing entries, not mutations. This is why the local re-clone restore needs `--disable-triggers`, and why any manual data fix on trust rows must be an offsetting insert rather than an UPDATE.

## Source

- `backend/db/schema/*.sql`: per-domain schema files (source of truth)
- `backend/db/schema.sql`: GENERATED canonical schema, built by `backend/db/build-schema.ts` (`npm run db:schema:build` / `db:schema:check`)
- `backend/db/migrations/*.sql` and `README.md`: upgrade deltas since the collapse (numbering restarted at `0001`)
- `backend/db/apply-schema.ts`: apply schema.sql (explicit `DB_TARGET` required; `--reset --confirm-local-reset` on local only)
- `backend/db/run-sql.ts`: apply one `.sql` file, recording numbered migrations in `schema_migrations`
- `backend/scripts/check-catalog-parity.sh`: `npm run db:catalog-parity`, built-vs-migrated catalog diff
- `backend/src/shared/database/drizzle/schema.ts`: introspected Drizzle snapshot (`npm run db:pull`, checked by `npm run db:drift`)
- `backend/src/shared/database/connectionBudget.ts`: pool size derivation
- `.claude/skills/new-migration/SKILL.md`: migration procedure
- `backend/src/shared/database/db.ts` — pool + Postgres type parsers
- `backend/src/shared/database/drizzleClient.ts` — Drizzle attached to the shared pool
- `backend/src/shared/database/queryContext.ts` — audited tenant, token, system, and admin query contexts
- `backend/src/shared/database/resolveDbUrl.ts` — `DB_TARGET` resolution + SSL detection
- `backend/src/shared/database/DrizzleRepository.ts`: tenant-scoped repository base
- `backend/src/shared/database/pagination.ts` — clamped paging, whitelisted sort, window count
- `.claude/skills/local-database/SKILL.md` - local Podman Postgres runbook

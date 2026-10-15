---
paths:
  - "backend/db/**"
  - "backend/src/shared/database/**"
---

# Backend migrations and the database-first Drizzle workflow

`backend/db/schema.sql` is the schema authority. It is GENERATED from the per-domain files in
`backend/db/schema/*.sql` by `npm run db:schema:build`; edit a domain file, never `schema.sql`.
Drizzle is the application query layer only.


- `backend/db/schema.sql` is the complete shape used for a fresh database. Existing databases advance
  through numbered files in `backend/db/migrations/`; never replay all historical migrations on a fresh
  database. Every file there now postdates the collapse: the chain that ran to `0262` was folded into
  `schema.sql` and staging was rebuilt from it, because no database had ever replayed it end to
  end and the two build paths kept drifting apart. Numbering restarts at `0001`.
- **`schema.sql` must apply to an empty database in a single pass.** `backend/db/apply-schema.ts` sends the
  whole file as one statement, so it runs in one transaction: a failure rolls everything back and
  leaves zero tables, not a partial schema. Two ordering rules keep it working. A table may not
  reference one defined later in the file; put that foreign key in the DEFERRED CROSS-TABLE FOREIGN
  KEYS block instead. And the WHOLE-SCHEMA SWEEPS block must stay last, because both sweeps in it
  act only on the tables that exist at the moment they run. Applying the file twice is not a
  workaround: the second pass re-runs those sweeps over the tables the first pass created and
  produces a different schema. `npm run test:db` applies it strictly and is the regression check.
- New migrations declare `-- migration-mode: expand` or `contract`, are applied with
  `DB_TARGET=<local|staging> npx tsx db/run-sql.ts <file>`, and are recorded with a checksum in
  `schema_migrations`. Never edit or force-replay an applied migration.
- Apply migrations to local, then staging, **before** pushing code that requires them. Contract
  migrations need `--allow-contract` but no user approval; `push-to-staging` applies them.
- After a migration, edit the domain file under `backend/db/schema/`, run
  `npm run db:schema:build`, then `npm run db:catalog-parity`, then
  `DB_TARGET=local npm run db:pull`, `DB_TARGET=local npm run db:drift` and `npm run typecheck`.
  The checked-in Drizzle schema is an introspected query model, not a migration source.
- **`db:catalog-parity` is the check that a shape change reached both build paths.** It builds a
  database from `schema.sql` and another from `origin/staging` plus every migration since, and
  compares their catalogs. `db:drift` cannot see this class of defect: it introspects ONE
  database, so it agrees with whichever path built that one.
- `apply-schema --reset` is local-only and requires `--confirm-local-reset`. Never reset staging or
  production. Phase E database work never targets production, whose code/schema lineage is older.
- `npx tsx db/check-raw-query-count.ts` is the application raw-query ratchet. Lower
  `backend/db/raw-query-baseline.json` whenever calls are removed; never raise it for ordinary work.


## Before dropping a column

Find the readers AND the writers. An unused-looking column is not proof:
`invoices.invoice_name` is the invoice's own label, not a copy of anything.

A reader is not proof of life either, which is the half that gets skipped. Five
`contact_clients` columns survived two audits because each found a reader and stopped. Nothing
had written any of them since migration 0174, so the reader that kept them, a probe in
`findAccountActivity`, was matching a column that is always null.

## Writing a new migration

Use the `new-migration` skill. It has the full ordered checklist.

---
name: new-migration
description: Write and apply a numbered Postgres migration. Use whenever a change adds or alters a table, column, index, constraint or trigger; run it yourself without waiting for the user to invoke it.
argument-hint: "[short_slug describing the change]"
---

# New migration

Write a numbered migration for: $ARGUMENTS

`backend/db/schema.sql` is the schema authority for a fresh database, generated from
`backend/db/schema/*.sql`. Existing databases advance
through numbered files in `backend/db/migrations/`. Both must end up describing the same schema.

## Rules that do not bend

- **Never edit or replay an applied migration.** A `PreToolUse` hook blocks an `Edit` of any file
  in `backend/db/migrations/`. Correct a mistake with a new numbered file.
- **Never target production.** The production database target, the `--allow-prod` override and
  `apply-schema --reset` are all blocked by `guard-bash.js`. Production is a separate, much older
  codebase and no tooling in this repo may point at it.
- **Expand before contract.** Prefer a backward-compatible expand migration, which goes to local,
  then staging, **before** the code that needs it is pushed. Write a contract migration only when
  the change cannot be expressed as an expand.
- **No migration waits for the user's approval.** Apply contract migrations with
  `--allow-contract` like any other. A migration that rewrites, merges or removes data gets a dump
  of the affected staging tables first (see `push-to-staging`), then proceeds.

## Steps

### 1. Pick the number and the mode

```bash
ls backend/db/migrations/*.sql 2>/dev/null | tail -3
```

Use the next integer, zero-padded to four digits, then a snake_case slug, for example
`0014_add_matter_archive_flag.sql` after `0013`. The chain that ran to `0262` was folded into
`schema.sql` and the numbering restarted at `0001`, so the numbers here are the new chain. The first line declares the mode:

```sql
-- migration-mode: expand
```

`expand` adds something and leaves the currently deployed code working. `contract` removes or
narrows and breaks it. If you are unsure which it is, it is `contract`.

### 2. Before writing a contract migration, find the readers

An unused-looking column is not proof that it is unused. `invoices.invoice_name` is the
firm's own label for an invoice, unique within its billing context. Grep `backend/src`, `backend/tests`
and `frontend/src` for the column and its camelCase name, and report what you found before
proceeding.

Then look for the WRITERS separately, because a reader is not proof of life. Five
`contact_clients` columns survived two audits on a reader alone; nothing had written them
since migration 0174, and the probe that kept them was matching a column that is always
null.

### 3. Write the file

State the pre-condition and the post-condition as SQL comments at the top, so the verification in
step 4 has something concrete to check. Keep the file to what its mode header claims.

**Follow the conventions in `.claude/rules/backend-data-model.md`.** A new table needs
`unique (law_firm_id, id)`, both timestamps, `is_`/`has_`/`can_` on every boolean, a CHECK on
every fixed vocabulary, an index on every foreign key column, a named `on delete` action on
every FK, and one nullable FK per parent plus a CHECK rather than a `(type, id)` pair.
`backend/tests/schema/conventions.test.ts` and `fkIndexes.test.ts` enforce all of it in step 6,
so reading the rules now is cheaper than discovering them there.

### 4. Apply to local and verify

```bash
DB_TARGET=local npx tsx backend/db/run-sql.ts backend/db/migrations/<file>.sql
```

Two flags matter here. A concurrent index must be a single statement and needs
`--non-transactional`. A **contract** migration is refused outright unless you pass
`--allow-contract`: `run-sql.ts` exits 1 with "Contract migrations are never applied
automatically". Pass the flag: the refusal only stops a contract migration from being applied by
accident, and the user does not want to approve migrations.
(`--record-only` also exists, for a migration already applied by other means.)

Then run the migration's own invariants, plus:

```bash
cd backend && npm run typecheck && DB_TARGET=local npm run db:drift
```

`run-sql.ts` records the file and its checksum in `schema_migrations`.

### 5. Update the schema files and the Drizzle snapshot

**`backend/db/schema.sql` is GENERATED. Never edit it.** Edit the domain file under
`backend/db/schema/` that owns the table, then rebuild and prove the two build paths still
agree:

```bash
cd backend && npm run db:schema:build && npm run db:catalog-parity
cd backend && DB_TARGET=local npm run db:pull && DB_TARGET=local npm run db:drift && npm run typecheck
```

`db:catalog-parity` builds one database from `schema.sql` and another from `origin/staging`
plus every migration since, and compares their catalogs. It is the check that a shape change
reached BOTH paths. `db:drift` cannot do this: it introspects one database and agrees with
whichever path built it.

**A shape change is a migration first and a domain-file edit second, in the same change.**
Changing a table on its way into a domain file, without a migration, makes `schema.sql`
describe a database no deployed environment will ever have. That has happened once and cost a
full repair pass.

Two ordering rules keep `schema.sql` applying to an empty database in one pass, which
`npm run test:db` checks:

- A table may not reference one defined later in the file. Put that foreign key in the DEFERRED
  CROSS-TABLE FOREIGN KEYS block instead.
- The WHOLE-SCHEMA SWEEPS block stays last. Both sweeps act only on the tables that exist at the
  moment they run, so applying the file twice produces a different schema.

The checked-in Drizzle schema is an introspected query model, not a migration source.

### 6. Rebuild the test databases, then run the schema guards

```bash
cd backend && npm run test:db
npx jest tests/schema/
```

`test:db` does one strict pass per Jest worker. A failure there is a real schema defect, not
something to retry past.

`tests/schema/` is the conventions gate and it is not optional: `conventions.test.ts` and
`fkIndexes.test.ts` check every rule in `.claude/rules/backend-data-model.md` against the
catalog. Both carry an allow-list of known violations, checked in BOTH directions, so:

- a new violation fails as `unexpected`. Fix the migration, not the list.
- a violation your migration FIXED fails as `stale`. Delete that entry, in the same change.

**Never run two jest processes against the same test database.** The second gets a bare
`read ECONNRESET` from `truncateAll` that looks like a schema failure and is not.

### 7. Staging

Do not apply to staging by hand from this skill. `/push-to-staging` detects the new file, applies
it to local first, then staging, and only then pushes the code. That ordering is what stops Cloud
Run deploying code before its schema exists.

Staging holds disposable test data. Its ledger was emptied when the chain was collapsed and
staging was rebuilt from `schema.sql`, so it now records only migrations written since. Write
a migration anyway: a rebuild is a one-time event that needs the user's go-ahead, not a way
to avoid writing one.

## Report

Name the file, its mode, what it changed, the drift result, and whether staging still needs it.

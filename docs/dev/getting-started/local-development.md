# Local Development

How to run the Paralegix stack on your machine: install, env, database, servers,
and the checks that must stay green.

## Summary

There is no monorepo tooling. Install dependencies **per directory** and run the
two servers side by side:

```bash
cd backend  && npm install
cd frontend && npm install
```

```bash
# terminal 1 — backend (Express, tsx watch)
cd backend && npm run dev      # http://localhost:5001

# terminal 2 — frontend (Next.js)
cd frontend && npm run dev     # http://localhost:3000
```

The backend port comes from `PORT` (default `5001`, `backend/src/server.ts:33`);
the frontend defaults to `3000`. `npm run dev` runs `tsx watch server.ts`, running
the TypeScript source directly with auto-restart on change (there is also a
`dev:dist` script that builds first and runs `node --watch dist/server.js`
instead). Neither `npm run dev` starts Podman - if you point at a local
Postgres, start the container first (below).

## Key Takeaways

- **Two `node_modules` trees.** Run `npm install` in `backend/` and `frontend/`
  separately. There is no root workspace.
- **`DB_TARGET` picks the database.** One env var switches the backend between a
  local Podman Postgres, staging Supabase, or prod Supabase - no code change.
- **Schema is applied, not migrated, for a fresh DB.** Build a new database with
  `backend/db/apply-schema.ts` (the full, generated `schema.sql`), not by
  replaying migrations.
- **Firebase Auth and GCS are always cloud.** Even on `DB_TARGET=local`, logins hit
  Firebase and file bytes hit GCS; only data rows are local.
- **Green means checks and tests.** Frontend `npm run ci:checks` and the backend's
  `typecheck`, `lint` and `db:*` guards are the static gates, and every change
  also ships with tests (see [Testing](./testing.md)).

## Environment files

| File | Purpose | Gitignored |
|---|---|---|
| `backend/.env` | Backend config — DB, Supabase, Firebase, GCS, Stripe, Resend, cron, CORS. Template: `backend/.env.example`. | yes |
| `backend/serviceAccountKey.json` | Firebase service account for **Auth + GCS only** (never data). | yes |
| `frontend/.env.local` | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_SUPABASE_*` (Realtime messaging). | yes |

Key backend vars (see `backend/.env.example` and
[Environment Variables](/dev/ops/environment-variables) for the full list):
`DATABASE_URL` / `DB_TARGET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_JWT_SECRET`, `GCS_BUCKET`, `FIREBASE_SERVICE_ACCOUNT_KEY`,
`RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `CRON_SECRET`, `CORS_ORIGINS`.

## The database — local vs. remote

`DB_TARGET` in `backend/.env` selects which connection string the app **and**
`apply-schema.ts` use, resolved by
`backend/src/shared/database/resolveDbUrl.ts` (`DB_TARGET` →
`DATABASE_URL_<TARGET>`, falling back to plain `DATABASE_URL`):

```bash
DB_TARGET=local            # local | staging | prod
DATABASE_URL_LOCAL=postgresql://postgres:postgres@localhost:5433/paralegix
DATABASE_URL_STAGING=...   # Supabase pooler URL
DATABASE_URL_PROD=...      # Supabase pooler URL
DATABASE_URL=...           # fallback when DB_TARGET is unset
```

TLS is auto-enabled only when the URL contains `supabase` (`resolveDbUrl.ts:23`),
so `local` runs without SSL. To switch databases, change `DB_TARGET` and restart
`npm run dev`: that is the whole operation.

**Local Postgres is a Podman container** (see the local-database runbook):

- Container `paralegix-pg` (image `docker.io/library/postgres:17`), volume `paralegix-pgdata`.
- Host port **5433** (a native Windows Postgres may already own 5432).
- Order of operations: `podman machine start` → `podman start paralegix-pg` →
  `npm run dev`. `ECONNREFUSED ...:5433` on `DB_TARGET=local` means the container
  is not running.

On macOS, initialize Podman once with
`podman machine init --cpus 4 --memory 8192 --disk-size 60`. See the local-database
runbook for first-time container creation. `npm run test:db` prefers Podman locally
and keeps Docker in CI; `CONTAINER_ENGINE=docker npm run test:db` overrides it.
Docker and Podman volumes are separate, so transfer existing data before switching.

The container holds a clone of staging data; re-clone it with the two-step
schema-then-data-dump procedure in the runbook. Caveat: `apply-schema.ts`,
`run-sql.ts` and most `db/seed/` scripts resolve through `DB_TARGET`, but
`db/seed/import-courts.ts`, `db/seed/import-utbms.ts` and several
`backend/scripts/*.ts` (`verify.ts`, `counts.ts`, the trust backfill and
validation scripts) read plain `DATABASE_URL` and ignore it.

### Applying the schema

`backend/db/schema/*.sql` is the source of truth. `backend/db/schema.sql` is
generated from it: edit the domain files, then run `npm run db:schema:build`
(`npm run db:schema:check` fails CI when the two disagree). Build or reset a
database with:

```bash
npx tsx backend/db/apply-schema.ts                                 # create everything (idempotent)
npx tsx backend/db/apply-schema.ts --reset --confirm-local-reset   # DROP & recreate public schema, local only
```

It loads env from `backend/.env`, resolves the target via `DB_TARGET`, and
guards it (`apply-schema.ts:24`): an explicit `DB_TARGET` is required (the plain
`DATABASE_URL` fallback is refused), `--reset` runs only with `DB_TARGET=local`,
a local host and `--confirm-local-reset`, and a non-local target needs
`--allow-nonlocal-create`, which is only for creating a brand-new database.

For a **fresh** database use `apply-schema.ts`, never a replay of migrations. The
old numbered chain was collapsed into the schema and `backend/db/migrations/`
restarted at `0001`; a migration only upgrades an existing database. Write one
with the `new-migration` skill. See [Database](/dev/ops/database) for the
schema/migration model.

## Stripe on localhost

Billing and subscription flows need Stripe's webhooks forwarded to the local backend
by the Stripe CLI. `brew install stripe/stripe-cli/stripe`, then `stripe login` (a
browser approval, so you run it). The `stripe-dev` skill checks the env vars and starts
both listeners.

**Which Stripe account.** Paralegix has three Stripe environments, and the CLI can be
authorized for all of them (`stripe whoami` lists them):

| Name in the CLI | Account | Used by |
|---|---|---|
| Paralegix (sandbox), shown as "Test mode" in the Dashboard | `acct_1T5hh1PmR13SquBK`, test mode | staging |
| Paralegix (live) | `acct_1T5hh1PmR13SquBK`, live mode | production. Never point local at it |
| Paralegix sandbox | `acct_1T5hhCBPJYwApBSA` | local development |

The CLI must be on the SAME account as `STRIPE_SECRET_KEY` in `backend/.env`, or `stripe
listen` forwards another account's events and every local checkout silently stays unpaid.
Check with `stripe whoami` and `stripe prices retrieve <a configured price id>`; switch
with `stripe switch <account id>` (never add `--live`).

**Listeners.** Stripe CLI 1.51 and later refuses to start without `--events`. Use the
exact lists in /dev/ops/webhooks (the `stripe-dev` skill has both commands):

```bash
stripe listen --forward-to localhost:5001/api/webhooks/stripe \
  --forward-connect-to localhost:5001/api/webhooks/stripe --events <payments list>
stripe listen --forward-to localhost:5001/api/webhooks/stripe-subscriptions --events <subscriptions list>
```

The CLI signs everything it forwards with one `whsec_...` secret per account, so
`STRIPE_WEBHOOK_SECRET` and `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` are both that value
locally, and `STRIPE_CONNECT_WEBHOOK_SECRET` is not needed (`stripe listen --print-secret`
shows it). `stripe trigger payment_intent.succeeded` proves the wiring: the payments
listener logs `[200]`. Test card `4242 4242 4242 4242` succeeds; `4000 0000 0000 9995`
declines; `4000 0025 0000 3155` triggers 3D Secure.

**Prices.** `npx tsx backend/scripts/verify-stripe-prices.ts` checks the six
`STRIPE_*_PRICE_ID` values against the plan table (amount, interval, currency, archived,
one id in two slots). Run it after changing any of them.

**Local uses its own sandbox.** "Paralegix sandbox" keeps local test events and test data
away from staging's account. It has the three plan products and these six prices:

```bash
STRIPE_BASIC_MONTHLY_PRICE_ID=price_1UINEyBPJYwApBSAKVf1sHrX
STRIPE_BASIC_ANNUAL_PRICE_ID=price_1UINEzBPJYwApBSArK1yXhhx
STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID=price_1UINF1BPJYwApBSAbU7cvQ2N
STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID=price_1UINF2BPJYwApBSAVRb9y4PR
STRIPE_ENTERPRISE_MONTHLY_PRICE_ID=price_1UINF4BPJYwApBSA8LAACwCO
STRIPE_ENTERPRISE_ANNUAL_PRICE_ID=price_1UINF5BPJYwApBSACz2qH3d8
```

To set up a new machine: copy the sandbox's secret key from the Dashboard (switch to Paralegix sandbox,
Developers, API keys) into `STRIPE_SECRET_KEY`; replace the six price ids with the block
above; `stripe switch acct_1T5hhCBPJYwApBSA`; set both webhook secrets to the value
`stripe listen --print-secret` prints there; restart the backend; run
`verify-stripe-prices.ts`. Connect onboarding also needs Connect enabled on the sandbox.

## Auth for unverified dev accounts

Firebase email verification normally gates access. To let specific unverified
accounts through in development, add them to `EMAIL_VERIFICATION_WHITELIST`
(comma-separated emails) in `backend/.env`: parsed **once** at module load
(`backend/src/shared/utils/emailWhitelist.ts:21`). The frontend has a parallel
`NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST`. In production, an active whitelist logs
a startup warning (`auth.ts:34`). Use it only for local test accounts; do not put
real credentials in docs.

## Document conversion

Converting a document (to PDF, for signing and previews) runs in-process through
`libreoffice-convert` unless `DOCUMENT_CONVERTER=worker`, so a local conversion
needs LibreOffice (`soffice`) installed on your machine. With
`DOCUMENT_CONVERTER=worker`, the API instead hands signed GCS URLs to the private
worker at `DOCUMENT_WORKER_URL`, built from `backend/Dockerfile.document-worker`
(entry point `backend/src/document-worker.ts`). See
`backend/src/shared/documentConversion/converter.ts`.

## Testing and checks

- **Test suites:** see [Testing](./testing.md) for the full picture. In short,
  `npm test` is offline in both packages and needs no running server or
  credentials; run `npm run test:db` once in `backend/` first to build the
  per-worker Postgres databases. `npm run test:live` in `backend/` is the opt-in
  suite that fetches a real running server and needs `__TEST_TOKEN__`. Neither is
  part of `ci:checks`.
- **Manual API testing** exercises endpoints against the running local backend
  (`http://localhost:5001`), typically by driving the frontend or an HTTP request
  client. `backend/AGENTS.md` documents the request-file convention for this.
- **Frontend gates:** `npm run ci:checks` (in `frontend/`) runs `eslint`,
  `tsc --noEmit`, and five guard scripts in `frontend/scripts/` (service
  transport, class migration, money format, date helpers, modal sizing).
  `next build` does not lint. It DOES type-check the `tests/` tree, so a green
  Jest run is not evidence the build compiles.
- **Backend gates:** `npm run typecheck`, `npm run lint`, and the `db:*` guards
  (`db:schema:check`, `db:drift`, `db:raw-query-ratchet`, `db:user-delete-guards`,
  `db:files-tree`, `db:coverage-scope-check`, `db:dead-exports`,
  `db:catalog-parity`). These are what CI's `backend-static` job runs.
- **CI** (`.github/workflows/ci.yml`) runs on manual dispatch only; nothing runs it
  on push.

## Source

- `backend/src/server.ts`: `PORT` (default 5001) and `app.listen`
- `backend/package.json` / `frontend/package.json`: `dev`, `build`, `ci:checks`
- `backend/.env.example`: backend env template (`DB_TARGET`, DB URLs, Stripe, ...)
- `backend/src/shared/database/resolveDbUrl.ts`: `DB_TARGET` → URL + SSL rule
- `backend/db/apply-schema.ts`: schema apply / `--reset`, with its target guards
- `backend/db/build-schema.ts`: generates `schema.sql` from `backend/db/schema/*.sql`
- `backend/src/shared/documentConversion/converter.ts`: `DOCUMENT_CONVERTER` switch
- `backend/src/shared/utils/emailWhitelist.ts`: `EMAIL_VERIFICATION_WHITELIST`
- `.claude/skills/stripe-dev/SKILL.md`: Stripe CLI listener setup
- `.claude/skills/local-database/SKILL.md` - Podman Postgres + re-clone runbook

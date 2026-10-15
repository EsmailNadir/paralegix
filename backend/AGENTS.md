# Backend Patterns

> **Data store: Postgres (Supabase).** Drizzle is attached to the existing `pg` pool as the single application query layer; the raw-query ratchet is zero and must stay zero. Drizzle does **not** own schema or migrations. `src/shared/database/firebase.ts` exists ONLY for Firebase Auth and GCS storage. Schema source of truth: `db/schema.sql` (+ `db/migrations/*.sql`), generated from `db/schema/*.sql`.

## Where the rest of this lives

This file holds only what is true whatever you touch in `backend/`. Everything else loads on
demand, so it costs nothing until it is relevant.

| Topic | Loads from | When |
|---|---|---|
| Route, service, response and validation patterns; tenant scoping; per-module feature docs | `.claude/rules/backend-module.md` | Reading a file under `src/modules/` |
| Repository pattern and the audited Drizzle contexts | `.claude/rules/backend-repository.md` | Reading a `*.repository.ts` |
| Event bus and the durable outbox | `.claude/rules/backend-events.md` | Reading a `*.events.ts` |
| Table inventory and money/date column rules | `.claude/rules/backend-data-model.md` | Reading anything under `db/` or a repository |
| Migration workflow and the Drizzle introspection loop | `.claude/rules/backend-migrations.md` | Reading anything under `db/` |
| Test harness, the two Jest projects, the actors | `.claude/rules/backend-tests.md` | Reading anything under `tests/` |
| The incremental PDF signing engine and why nothing holds a document | `.claude/rules/signing-pdf-engine.md` | Reading anything under `src/modules/signatures/pdf/` |
| A slow, hanging, segfaulting or 429-ing suite | `backend-testing` skill | On demand |
| Writing a numbered migration | `new-migration` skill | `/new-migration` |
| Scaffolding a module | `new-backend-module` skill | `/new-backend-module` |
| Permission codes, roles, the member baseline | `rbac-permissions` skill | Editing permissions or roles |
| Integer cents, invoices, the trust ledger | `handling-money` skill | Editing billing or trust code |

## Dev Commands

```bash
npm run dev        # tsx watch, port 5001 — runs the TypeScript source tree directly
npm run build      # compile document-layout, then tsc -> dist/, then copy template fonts
npm run typecheck  # three programs: tsc --noEmit, then db/+scripts/ (tsconfig.tools.json),
                   # then tests/ (tsconfig.test.json)
npm run lint       # eslint src db scripts tests
npm start          # production — runs the BUILT output, dist/server.js
npm run test:db    # once: six Postgres databases (TEST_DB_COUNT), for four Jest workers
                   # plus spare slots for a second jest process
npm test           # Jest `unit` project; no server, no credentials, no network
```

The backend is **100% TypeScript**: `src/`, `tests/`, `db/` and `scripts/` hold no `.js` files at
all. `tsconfig.json` still sets `allowJs` with `checkJs: false`, which now only matters if a `.js`
file is deliberately reintroduced. `tsc` emits CommonJS to `dist/`. Consequences:

- **Nothing runs under plain `node` from source.** Node cannot `require()` a `.ts` file.
  `npm run dev` uses `tsx`; so does every tool under `db/` and `scripts/`
  (`npx tsx db/apply-schema.ts`). `npm run dev:dist` builds first and runs `dist/`, which is what
  production does.
- **`npm start` runs `dist/`**, so it needs `npm run build` first. `backend/Dockerfile` does this
  in a separate build stage (devDependencies, including `tsc`, are not in the runtime image).
  `backend/cloudbuild.yaml` is the Cloud Run deploy config beside it.
- **`db/` and `scripts/` are never compiled.** They are operator tooling, and the base
  `tsconfig.json` sets `rootDir: "src"` precisely so `dist/` mirrors `src/`. They are type-checked
  by `tsconfig.tools.json` instead, which is what `npm run typecheck` runs second. `scripts/` is
  still a build INPUT: the Dockerfile's build stage copies it so `npm run build` can run
  `scripts/copy-template-fonts.ts`, which lands the template fonts in `dist/`. Only `dist/` is
  copied into the runtime image.
- **`npx tsx db/check-js-count.ts` ratchets the `.js` count** across `src/`, `db/`, `scripts/` and
  `tests/`. The baseline is **0**, so any new `.js` file fails the build; raise it deliberately in
  `db/js-file-baseline.json` if one is genuinely required.
- New backend files must be written in **TypeScript**.

Other guards: `npm run db:drift`, `npm run db:raw-query-ratchet`,
`npm run db:user-delete-guards` (fails if a new cascading/set-null FK to `users(id)` is not checked by
`findAccountActivity`, which is what stops the unverified-account sweep deleting a real person's data),
`npm run db:dead-exports` (fails on an export nothing outside its own file mentions; it takes
`ts-prune` only as a candidate list, because ts-prune follows ES imports and most of this tree is
reached through `require()`, so run bare it calls about 1,500 live routes dead),
`npm run db:coverage-scope-check` (fails if `jest.config.js`'s `collectCoverageFrom` narrows so a
source file silently drops out of the coverage denominator; runs one cheap no-DB spec under real
coverage instrumentation and diffs the report's file list against an independently-walked `src/**/*.ts`
list, so a coverage percentage can't quietly go up because a file stopped being counted rather than
because a test got written).

### Container engine: Podman

Local Postgres runs under **Podman**. Every developer should use it. `npm run test:db` and
`npm run db:catalog-parity` select Podman when it is on PATH and `CI` is not `true`, and both keep
Docker in CI. Force either engine with `CONTAINER_ENGINE=docker npm run test:db`. Every other
script reaches Postgres over TCP at `localhost:5433`, so the engine is invisible to it.

`scripts/run-signing-benchmark.sh` is the third script that drives a container engine, and the one
exception to both rules above: it hardcodes `podman` with no `CONTAINER_ENGINE` override and no
`CI` check, it builds the backend image locally (`podman build --target build`), and it reaches the
host through `host.containers.internal`, which has no Docker equivalent. So it is Podman-only in
substance, not just in spelling. It is live, not dead: `shared/utils/transferSlot.ts` cites a
measurement taken with it.

Docker stays correct in two places, and neither runs on a developer machine:
`.github/workflows/ci.yml` (GitHub runners have Docker, not Podman) and `Dockerfile` /
`Dockerfile.document-worker`, which Cloud Build compiles.

Two Podman behaviours differ from Docker and both bite once. Podman has no daemon, so
`--restart always` takes effect only after `podman-restart.service` is enabled inside the VM. And
Podman and Docker volumes are separate stores even under one name, so switching engines needs a
data transfer. Full runbook: the `local-database` skill.

## Layout

- `src/app.ts` — Express setup, CORS, route registration, error handler
- `src/modules/` — domain modules (see Module Structure below)
- `src/shared/`: `analytics/`, `attachments/`, `constants/`, `data/`, `database/`, `documentConversion/`, `errors/`,
  `events/`, `http/`, `lookup/`, `middleware/`, `notes/`, `plans/`,
  `referenceData/`, `services/`, `storage/`, `utils/`, `validation/`

**Modules**: `auth`, `admin`, `audit`, `billing` (timeEntries, invoices, flatFees, expenses, expenseCategories, chargeCodes, analytics, reports, plans, plus a `shared/` workbench layer), `calendar` (google, outlook), `catalog`, `clients` (portal, notes), `contacts`, `courts`, `dashboard`, `documentRequests`, `files`, `intake` (public intake forms; separate from `leads`), `invitations`, `lawfirms` (members, roles), `leads` (stages), `matters` (categories, clients, members, notes, stages, pipelines, fields, activity, contacts, deadlineSets), `messaging`, `noteTemplates`, `noteTypes`, `notifications`, `practiceAreas`, `privacy`, `settings`, `share`, `signatures`, `stripe`, `subscriptions`, `tasks` (notes, subtasks), `templates`, `trust`, `users`

**Route convention**: RESTful under `/api/lawfirms/:lawFirmId/...`. Token verification uses `verifyIdToken(token, /*checkRevoked*/ true)` behind a short-lived cache keyed on the full token string (`shared/middleware/auth.ts`, 30s TTL, rejects tokens past their own `exp`): a cold verify hits Firebase and honors revocation; repeats within the TTL reuse the payload, so revocation latency is bounded to ~30s.

## Module Structure

Every module lives at `src/modules/<domain>/`:
```
<domain>.routes.ts      — Express router
<domain>.service.ts     — Business logic
<domain>.repository.ts  — Postgres access through audited Drizzle contexts
<domain>.validation.ts  — Zod schemas
<domain>.events.ts      — (optional) eventBus listeners
```

Checklist when adding a module:
1. Register router in `src/app.ts`
2. Add permission codes to `src/modules/lawfirms/roles/permissions.ts`
3. Add event type constants to `src/shared/events/eventTypes.ts` if emitting events

## Shared document layout

`document-layout/` is the local `@paralegix/document-layout` package shared with the frontend.
It owns text fitting, rich-text fitting and template reflow; existing domain files re-export
its helpers. Edit the package source rather than copying logic into those wrappers. Both
package builds compile `document-layout/tsconfig.json` first.

## Subscription Plans

Four tiers (Starter/Basic/Professional/Enterprise) defined in code at `src/shared/plans/planDefinitions.ts`. Plan data lives on the `law_firms` row in the `plan` jsonb column plus the `plan_id`/`billing_status` columns. Enforce with `enforceCountLimit()` and `enforceFeatureAccess()` from `src/shared/plans/planEnforcement.ts`; count limits throw `PlanLimitError` (403, `PLAN_LIMIT_REACHED`) carrying `{ resource, current, limit, planId }`, while feature denial throws `ForbiddenError` (403). Firms can be comped, carry overrides, or set `unlimitedOverride: true` to bypass all limits. Full detail: `docs/features/lawfirms-rbac-plans.md`.

## Invitations

Member and client invitations share the `invitations` table. Member invites can be auto-processed via `checkAndProcessMemberInvites()`, called from `completeRegistration()` (OAuth) and `createUser()` (email/password), never from `login()`. Full flow: `docs/features/invitations.md`.

## Environment

`.env.example` is the tracked, authoritative list (40 set vars, plus optional knobs as commented lines). Groups worth knowing:

- Database: `DB_TARGET` (`local` | `staging` | `prod`) picks `DATABASE_URL_LOCAL` / `_STAGING` / `_PROD`; `DATABASE_URL` is the fallback. See `src/shared/database/resolveDbUrl.ts` and the `local-database` skill. Pool knobs: `PG_POOL_MAX`, `PG_POOL_RESERVE`, `PG_STATEMENT_TIMEOUT_MS`. `DATABASE_URL_TEST` is separate and sits outside `DB_TARGET`: `tests/support/db.ts` derives the per-worker test databases from it, and refuses to run if it does not name a test database.
- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` (messaging Realtime/RLS).
- Platform: `PORT`, `FRONTEND_URL`, `WEBHOOK_BASE_URL`, `GCS_BUCKET`, `FIREBASE_SERVICE_ACCOUNT_KEY`, `CORS_ORIGINS`, `RBAC_ENFORCED`, `CRON_SECRET`.
- Email: `RESEND_API_KEY`, `EMAIL_FROM`. Without the key, `emailService` warns and skips sending.
- Analytics: `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`. Without the token, `shared/analytics/serverAnalytics.ts` builds no client and every capture is a no-op; the test harness forces it empty. Account erasure also deletes the PostHog person through `POSTHOG_PERSONAL_API_KEY` (a secret) and `POSTHOG_PROJECT_ID`; without both it skips.
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` (optional: the Connect endpoint's secret on the same payments route), six `STRIPE_*_{MONTHLY,ANNUAL}_PRICE_ID`s, `STRIPE_APPLICATION_FEE_RATE`, `STRIPE_APPLICATION_FEE_FIXED_CENTS`.
- Calendar OAuth: `GOOGLE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI`, `MICROSOFT_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI`. Calendar sync does not work without them.
- Docs gate: `DOCS_SESSION_SECRET` + `DOCS_COOKIE_DOMAIN`, optional `DOCS_COOKIE_NAME` (must match the docs project).
- `EVENT_OUTBOX_*` tunes the durable outbox; `EVENT_OUTBOX_WORKER=true` is the on switch. The remaining ~100 vars the backend reads are concurrency, timeout, log and rate-limit knobs with working defaults.

`serviceAccountKey.json` is gitignored and required here for local dev (Firebase Auth/GCS only).

## Timestamps & Dates

Postgres returns native types: a `Date` for `timestamptz`, a `'YYYY-MM-DD'` string for `date`.
- `timestamptz` columns (`created_at`, `updated_at`, …) come back as JS `Date`; convert to ISO when shaping output: `const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);`. `DrizzleRepository.toEntity()` does this automatically, and so does `sqlRowToEntity` (`shared/database/rowShape.ts`) for a raw row.
- `date` columns (day-only: `due_date`, `entry_date`, `txn_date`, …) come back as raw `'YYYY-MM-DD'` strings — `db.ts` registers a type parser for oid 1082 to avoid timezone shifts. Don't wrap these in `new Date()`. `db.ts` registers a second parser for oid 1185 (`timestamptz[]`).
- Triggers (`set_updated_at`) auto-bump `updated_at` on every UPDATE — don't set it in app code (the repo helpers strip it).

```js
// Timezone-aware display helpers, fed a Date or an ISO string:
const { formatForClient, toTimestampOrNull } = require('../../shared/utils/time');
```

## Pagination & Filtering

Push filtering/ordering/limits into SQL — `where`, `order by … nulls last`, `limit`/`offset`, `= any($1)` for id sets.

**Text search is `ILIKE '%term%'`, not full-text search.** Build the term with `toIlikeTerm()` (`shared/database/searchTerm.ts`) and always pair it with `escape '\'`. The generated `tsvector` columns that used to exist on `matters`, `tasks`, `clients`, and `contacts` were dropped before the migration ledger restarted, so `schema.sql` is the only record: nothing read them, and `to_tsvector('english', …)` is the wrong tool for this data anyway — it tokenises an email as one indivisible unit, keeps a leading hyphen on matter-number fragments, and its stop-word list contains "will", so searching for a will matched nothing. `court_catalog` is the one genuine full-text user and keeps its `search @@ websearch_to_tsquery(...)` index.

## Key Shared Utility Imports

| What | Path |
|---|---|
| `verifyToken`, `optionalVerifyToken`, `requireUserType` | `../../shared/middleware/auth` |
| `requireTimezone` | `../../shared/middleware/timezone` |
| `validate` | `../../shared/middleware/validate` |
| `requirePermission` | `../lawfirms/roles/requirePermission` |
| `NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError` | `../../shared/errors/AppError` |
| `assertLawFirmMembership`, `assertMatterMembership` | `../../shared/utils/membership` |
| `formatForClient`, `localInputToUtcDate`, `toTimestampOrNull` | `../../shared/utils/time` |
| `eventBus` | `../../shared/events/eventBus` |
| `DrizzleRepository` | `../../shared/database/DrizzleRepository` |
| `sqlRowToEntity` (raw rows only) | `../../shared/database/rowShape` |
| `isUuid` | `../../shared/utils/isUuid` |
| `pool` (the only export; there is no `query`) | `../../shared/database/db` |
| `admin`, `auth` (Firebase — Auth + GCS only) | `../../shared/database/firebase` |

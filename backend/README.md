# Paralegix Backend

Express 5 (CommonJS) API for Paralegix, a legal practice management SaaS. Postgres
(Supabase) is the sole data store; Firebase is used only for Auth and GCS for file storage.

> Engineering conventions (route/service/repository/validation patterns, error handling,
> the event bus, money/date rules) live in [`AGENTS.md`](./AGENTS.md). Deep-dive docs are in
> the repo-root [`docs/`](../docs) VitePress site. This README is the getting-started map.

## Quick Start

```bash
npm install
npm run dev      # tsx watch, port 5001 (runs the TypeScript source directly)
npm run build    # tsc -> dist/
npm start        # production (node dist/server.js; needs a build first)
```

Requires:
- `serviceAccountKey.json` in `/backend` (Firebase Auth + GCS credentials; gitignored)
- `.env` configured (see [Environment](#environment))

## Stack

Express 5 · Postgres (Supabase) via Drizzle on the existing `pg` pool · Firebase Auth · Google Cloud Storage ·
Stripe (Connect + Billing) · Resend (email). Deployed to GCP Cloud Run.

Data access is Postgres only. Firebase Admin (`src/shared/database/firebase.ts`) exists
**solely** for Auth and `admin.storage()`, never for data. See `AGENTS.md` for the
full guard list.

## Structure

```
src/
├── app.ts              # Express factory: CORS, route registration, error handler
├── modules/            # Domain modules (see below)
└── shared/             # database/, middleware/, errors/, events/, utils/, plans/
server.ts               # Entry point
db/                     # schema.sql (source of truth) + migrations/*.sql
tests/                  # Jest integration suite, one folder per module
scripts/                # Operational scripts (Stripe reconcile, etc.)
```

Each module in `src/modules/<domain>/` follows the same shape:
`<domain>.routes.ts` · `.service.ts` · `.repository.ts` · `.validation.ts` · `.events.ts` (optional).

**Modules**: `admin`, `audit`, `auth`, `billing`, `calendar`, `catalog`, `clients`,
`contacts`, `courts`, `dashboard`, `documentRequests`, `files`, `intake`, `invitations`,
`lawfirms`, `leads`, `matters`, `messaging`, `noteTemplates`, `noteTypes`, `notifications`,
`practiceAreas`, `privacy`, `settings`, `share`, `signatures`, `stripe`, `subscriptions`,
`tasks`, `templates`, `trust`, `users`.

## Routing

RESTful under `/api/lawfirms/:lawFirmId/...`. Middleware order is always
`verifyToken → requirePermission → validate → requireTimezone → handler`. Token
verification uses the Firebase Admin SDK with a short-lived (30s) cache keyed on
the token string.

## Database

- Schema source of truth: `db/schema.sql` — apply with `npx tsx db/apply-schema.ts`
  (`--reset` drops & recreates; **dev only**).
- Numbered migrations layered on top: `db/migrations/*.sql`.
- Multi-tenancy is the app's responsibility: nearly every table carries `law_firm_id` and
  is scoped by audited Drizzle contexts (including the Drizzle-backed `SqlRepository`
  compatibility surface). The backend connects as the `postgres` role and
  bypasses RLS, except the messaging, notification and signature tables, which are read
  through Supabase Realtime with a deliberately scoped Firebase-UID JWT.
- Money is integer cents (`*_cents`, `bigint`). Day-only `date` columns come back as raw
  `'YYYY-MM-DD'` strings; timestamps as ISO strings.

## Testing

Two Jest projects. See `AGENTS.md` for the full picture.

**`unit`** is the default. Everything under `tests/` except `tests/live`: pure-function specs
plus in-process specs that drive the real Express app through `supertest`, with Firebase and
the mail transport mocked. No server, no credentials, no network.

```bash
npm run test:db       # once: build one Postgres database per Jest worker
npm test              # jest --selectProjects unit
npm run test:coverage
npx jest tests/<path>/<file>.test.ts
```

**`live`** is opt-in. `tests/live/` issues plain `fetch` calls against a **running** server
(`TEST_API_URL`, default `http://localhost:5001`) backed by a **real** database and Firebase
Auth.

```bash
npm run test:live
```

It requires test auth env: either `__TEST_TOKEN__` (a pre-fetched Firebase ID token) **or**
`TEST_FIREBASE_API_KEY` + `TEST_EMAIL` + `TEST_PASSWORD`. `tests/live/validate-test-env.ts`
fails fast if neither is present. Point it at a disposable database (the local `DB_TARGET`
clone), never staging or prod.

## Environment

| Variable | Purpose |
|---|---|
| `DB_TARGET` | `local` \| `staging` \| `prod`; picks `DATABASE_URL_LOCAL`/`_STAGING`/`_PROD` |
| `DATABASE_URL` | Postgres connection string; the fallback when `DB_TARGET` is unset |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project access |
| `SUPABASE_JWT_SECRET` | Signs the Firebase-UID JWT for messaging Realtime/RLS |
| `PG_POOL_MAX` | Optional pool size |
| `PORT` | Server port (default 5001) |
| `GCS_BUCKET` | Google Cloud Storage bucket for file bytes |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Firebase credentials (prod; local uses `serviceAccountKey.json`) |
| `CORS_ORIGINS` | Comma-separated allowed origins |
| Stripe / Resend keys | Billing + email (see `docs/dev/ops/environment-variables.md`) |

## Deployment

`main` → production. The `staging` branch deploys to `https://api-staging.paralegix.com`
(Cloud Run), fully isolated from prod (separate Supabase project, GCS bucket, Stripe
test-mode keys). See `docs/STAGING_SETUP.md` for the full runbook.

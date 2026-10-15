# Architecture Overview

The Paralegix system at a glance: how the pieces fit, what backs them, and how a
request travels through the backend. Start here before diving into a module.

## Summary

Paralegix is a legal practice-management SaaS split into two independently
deployed apps in one repo:

- **`frontend/`**: Next.js 16 (App Router, React 19, TypeScript), deployed to
  **Vercel**. Talks to the backend over HTTPS; holds no database credentials.
  Dev runs on Turbopack (the Next 16 default); production builds run on webpack
  (`next build --webpack`), so bundler-level config exists twice in
  `next.config.ts` and must be changed in both places.
- **`backend/`**: Express 5 on CommonJS, deployed to **GCP Cloud Run**. Owns all
  data access, business logic, auth verification, billing, and integrations.

There is **no monorepo tooling**: each side manages its own `node_modules` and
its own `package.json` scripts. The two run side by side in development (backend
on `5001`, frontend on `3000`).

The data store is **Postgres (Supabase)** and nothing else. Firebase is retained
**only** for Auth and GCS access via `backend/src/shared/database/firebase.ts`.

## Key Takeaways

- **One data store and query layer.** All persistence is Postgres through Drizzle attached
  to the single `pg` pool in `backend/src/shared/database/db.ts`. Drizzle does not own the
  schema: `backend/db/schema/*.sql` does. Complex reads may use parameterized SQL only through
  the audited contexts in `queryContext.ts`, and the raw-query ratchet is zero.
- **Tenant scoping is the app's job.** The backend connects as the `postgres`
  role and bypasses row-level security (except messaging Realtime). Every query is
  scoped by `law_firm_id` in application code, not by the DB.
- **Firebase is Auth + storage only.** `verifyToken` verifies the Firebase ID
  token with `checkRevoked: true`, behind a 30s cache keyed on the full token
  string. No Firestore.
- **Modules are uniform.** Each domain is a `routes / service / repository /
  validation / events` quintet, wired into `backend/src/app.ts`.
- **The error handler is centralized.** Services and routes throw typed
  `AppError`s; `errorHandler` renders the envelope and never leaks 5xx or
  third-party SDK messages.

## Monorepo layout

| Path | What lives here |
|---|---|
| `frontend/src/app/` | App Router pages (route = folder). Thin page wrappers delegate to a Grid component. |
| `frontend/src/components/` | `[domain]Comp/` feature folders + `ui/` shared primitives. |
| `frontend/src/services/` | One API-client class per domain. |
| `frontend/src/hooks/` | `[domain]Hooks/`: React Query + modal state. |
| `backend/src/app.ts` | Express setup, middleware chain, route registration, error handler. |
| `backend/src/modules/` | Domain modules (see below). |
| `backend/src/shared/` | `database/`, `middleware/`, `errors/`, `events/`, `plans/`, `storage/`, `documentConversion/`, `utils/`, `services/`, and a few smaller helpers. |
| `backend/src/document-worker.ts` | Entry point of the separate document-conversion worker (image: `backend/Dockerfile.document-worker`). |
| `backend/db/` | `schema/*.sql` (source of truth), the generated `schema.sql`, `migrations/` (restarted at `0001` after the old chain was collapsed into the schema), `seed/`, and the apply/build/check scripts. |

## Backing services

| Concern | Service | Entry point |
|---|---|---|
| Data | Postgres / Supabase (Drizzle on one `pg` pool) | `backend/src/shared/database/drizzleClient.ts` |
| Auth | Firebase Auth (Google/Microsoft OAuth + email) | `backend/src/shared/database/firebase.ts` (`auth`) |
| File storage | Google Cloud Storage (bytes; metadata rows live in Postgres). Uploads go from the browser straight to GCS through a resumable session the backend opens and then verifies. | `firebase.ts` (`admin.storage()`), `backend/src/shared/storage/directUpload.ts` |
| Document conversion | LibreOffice. Runs in-process by default; with `DOCUMENT_CONVERTER=worker` the API sends signed GCS URLs to a private worker service at `DOCUMENT_WORKER_URL` instead. | `backend/src/shared/documentConversion/converter.ts`, `backend/src/document-worker.ts` |
| Payments | Stripe (Connect for client invoice payments; subscriptions for plans) | `backend/src/modules/stripe`, `backend/src/modules/subscriptions` |
| Email | Resend | `backend/src/shared/services/emailService.ts` |

The `pg` pool is created once in `db.ts`; it resolves its connection string via
`resolveDbUrl()` (`DB_TARGET` → `DATABASE_URL_<TARGET>`, falling back to
`DATABASE_URL`). A node-pg type parser for oid `1082` returns `date` columns as
raw `'YYYY-MM-DD'` strings to avoid timezone drift (`db.ts:18`). See
[Local Development](/dev/getting-started/local-development) for how `DB_TARGET`
selects local vs. staging vs. prod.

## Request lifecycle

Global middleware runs in this order in `backend/src/app.ts`:

1. **`helmet`**: baseline security headers; CSP and COEP disabled because this is
   a JSON API + signed-URL redirects, not an HTML origin (`app.ts:319`).
2. **`cors`**: origins from `CORS_ORIGINS` (comma-separated) or the production
   defaults; the localhost origins are added to that fallback only outside
   production, so a deploy that forgets `CORS_ORIGINS` fails closed (`app.ts:342`).
3. **Raw Stripe webhook mounts**: `/api/webhooks/stripe` and
   `/api/webhooks/stripe-subscriptions` are mounted with `express.raw()`
   **before** `express.json()` so signature verification sees the unparsed body
   (`app.ts:361`).
4. **Body parsers**: the default `express.json` ceiling is `2mb`. A per-route
   override table mounted ahead of it gives the public signing-completion route a
   tighter limit and the template editor `50mb`; an oversized body is refused
   with `413` while it is still arriving. `express.urlencoded` stays at `1mb`
   (`app.ts:384`). Large files never come through here: they upload straight to
   GCS.
5. **`maintenanceMode`**: short-circuits with a maintenance response when enabled
   (`app.ts:410`).
6. **`pino-http`**: structured request logging; mints/reuses a request id
   (`req.id`), demotes successful reads to `silent` by default, and attaches
   `actorUid` / `lawFirmId` at response time (`app.ts:434`).
7. **`requestContext`**: makes the route and request id readable from anywhere
   below, so the database layer can tag slow-query lines with the feature that
   issued them (`app.ts:515`).
8. **`auditMutations`**: append-only audit trail of mutating requests, recorded on
   response finish (`app.ts:519`).
9. **`requestTimeout`**: answers `504 REQUEST_TIMEOUT` when a request outlives its
   budget (`READ_REQUEST_TIMEOUT_MS`, default 20s, for GET and HEAD, matching the
   frontend read budget; `REQUEST_TIMEOUT_MS`, default 40s, for writes and the
   bootstrap read `GET /api/lawfirms/:lawFirmId`), so the client stops waiting instead
   of holding a spinner until its own deadline (`app.ts:525`). It does **not**
   abort the handler — the pool's `statement_timeout` bounds the expensive part —
   and it exempts routes whose duration is set by payload rather than by a query
   (webhooks, cron, files, upload/download, export, conversion, template preview,
   signing verify, bulk invoices; `LONG_RUNNING_PATTERNS` in
   `shared/middleware/requestTimeout.ts`). The frontend grants those same routes a
   longer budget; the two lists have to agree.
10. **Unthrottled endpoints**: `GET /api/health`, the `/api/cron/*` handlers
    (guarded by a timing-safe `CRON_SECRET`), and the Stripe webhooks above are all
    registered before the global limiter, so they are never throttled.
11. **`globalApiLimiter`**: coarse per-IP volumetric backstop across every route
    below it; skips health/cron/webhooks (`app.ts:836`). See
    [Rate Limiting](/dev/admin/rate-limiting) for the full limiter set.
12. **Module routes**: mounted under `/api/lawfirms/:lawFirmId/...`. `verifyToken`
    then `requireActiveBilling` are mounted in front of the per-firm data routes;
    the gate returns `402 BILLING_INACTIVE` when the subscription is not
    access-granting. Auth runs first so a locked firm's `402` is not an anonymous
    oracle for firm existence (`app.ts:854`).
13. **Unmatched route**: anything no router claimed gets `404 ROUTE_NOT_FOUND` in
    the standard error envelope rather than Express's HTML page (`app.ts:928`).
14. **`errorHandler`**: the last `app.use`, catches everything thrown upstream.

### Per-route chain

Inside a module router the middleware order is fixed
(`verifyToken → requirePermission → validate → requireTimezone → handler`):

- **`verifyToken`**: verifies the Firebase ID token and populates `req.user`. A
  cold verify calls Firebase with `checkRevoked: true`; a 30s cache keyed on the
  full token string absorbs repeats. See
  [Auth & Tokens](/dev/security/auth-tokens).
- **`requirePermission('domain.action')`**: RBAC check against the firm's role
  permissions.
- **`validate(schema)`**: Zod `safeParse({ body, query, params })`, throws
  `ValidationError` on failure.
- **`requireTimezone`**: sets `req.tz` from the `x-timezone` header (omit for
  time-agnostic routes).
- **handler**: thin; delegates to the service and shapes the response.

Feature-gated route groups add `requireFeature('...')` (e.g. `analytics`,
`documentSigning`, `trustAccounting`, `templates`).

## Module anatomy

Every domain lives at `backend/src/modules/<domain>/`:

| File | Responsibility |
|---|---|
| `<domain>.routes.ts` | Express router; wires middleware + handlers. |
| `<domain>.service.ts` | Business logic; functions take a **destructured object**, never `req`/`res`. Membership assertion first. |
| `<domain>.repository.ts` | Postgres access through audited Drizzle contexts; `DrizzleRepository` is the CRUD base for simple CRUD. |
| `<domain>.validation.ts` | Zod schemas. |
| `<domain>.events.ts` | Optional `eventBus` listeners (always `async` + `try/catch`). |

Services emit domain events through `eventBus.emit(TYPE, { lawFirmId, ... })`;
listeners in `*.events.ts` handle cascades and side effects. See
[Event Bus & Outbox](/dev/concepts/event-bus-outbox).

## Response conventions

Handlers never return bare arrays. The canonical shapes:

| Operation | Envelope |
|---|---|
| List | `{ items: [...], totalItems: N }` (or domain-specific, e.g. `{ tasks, totalTasks }`) |
| Typeahead (`/lookup`) | `{ items: [...], hasMore: bool }`: no count, deliberately |
| Create | `{ message, xId, x }`: HTTP `201` |
| Update | `{ message, x }`: HTTP `200` |
| Delete | `{ message, xId }` |

### Server-side lists

Every unbounded list (matters, tasks, clients, invoices, time entries, trust
transactions, files, conversations) pages, sorts, filters, and searches **in
Postgres**, not in the browser. The shared machinery lives in
`backend/src/shared/database/pagination.ts`; do not hand-roll it in a new module.

- **Paging is opt-in.** A request with no `limit` still returns the complete list
  (`buildPageClause({ optional: true })`), which the billing workbench, the
  billing summary, and the matter/client message tabs rely on. A request with a
  `limit` gets one clamped page.
- **`limit`/`offset` are bound parameters, never interpolated.** `clampLimit`
  bounds the page size; `buildPageClause` pushes both onto the caller's param
  array. `offset` wins over the 1-based `page` when both are sent.
- **Sorting is whitelist-only.** `buildOrderBy` maps a caller field name to a SQL
  expression through an own-keys-only whitelist and always appends a tiebreaker,
  so paging over equal sort keys is deterministic. An unknown field is skipped,
  not interpolated.
- **The total comes from a `count(*) over()` window** on the page query, so the
  common path is one round-trip. `resolveWindowTotal` pays for a second count
  query only on an empty page past offset 0, where the window carries no row to
  read the count from.
- **Reads are scoped, not filtered client-side.** List endpoints accept scope
  params (`clientId`, `clientIds`, `matterId`, `relatedClientId`, `ids`,
  `includeDetails`, `portalOnly`, `excludeArchived`) and push them into the
  query. An unusable scope value returns an empty list rather than the unscoped
  one. Scoping fails closed.

The full model, including the page-then-enrich CTE and the ethical-wall rules,
is in the [Server-Side Search](/features/server-side-search) reference.

Errors are thrown as typed `AppError`s (`NotFoundError` 404, `ForbiddenError` 403,
`ValidationError` 400, `ConflictError` 409) from
`backend/src/shared/errors/AppError.ts`. The centralized `errorHandler` renders
`{ error, code, details?, requestId }`, adds the request id, flags 403 security
events, and never exposes 5xx or third-party SDK (Stripe/gaxios/axios) messages to
the client — those are logged with the request id instead.

Money is integer cents end to end; see [Money Handling](/dev/concepts/money).

## Source

- `backend/src/app.ts`: middleware chain, route registration, cron, error handler
- `backend/src/shared/database/db.ts`: `pg` pool + date type parser
- `backend/src/shared/database/resolveDbUrl.ts`: `DB_TARGET` resolution
- `backend/src/shared/database/firebase.ts`: Firebase Auth + GCS (no Firestore)
- `backend/src/shared/middleware/requestTimeout.ts`: request deadline and the long-running exemptions
- `backend/src/shared/documentConversion/converter.ts`: in-process vs. worker conversion
- `backend/src/document-worker.ts`: the conversion worker's HTTP entry point
- `backend/AGENTS.md`: module, route, service, and repository patterns
- `frontend/AGENTS.md`: frontend page/component/hook patterns

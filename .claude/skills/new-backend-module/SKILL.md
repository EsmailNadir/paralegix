---
name: new-backend-module
description: Scaffold a new backend domain module with its routes, service, repository, validation and tests.
argument-hint: "[domain name, singular or plural as the table is named]"
---

# New backend module

Scaffold the module for: $ARGUMENTS

Follow `test-driven-development`: the first route test is written and watched to fail before the
route exists. Copy `backend/src/modules/leads/` for the current shape. It is the canonical
Drizzle-era module and the patterns below describe it.

## Files

```
backend/src/modules/<domain>/
  <domain>.routes.ts        Express router
  <domain>.service.ts       Business logic
  <domain>.repository.ts    Postgres access through audited Drizzle contexts
  <domain>.validation.ts    Zod schemas
  <domain>.events.ts        Only when the module emits or listens to events
```

## Order of work

### 1. Confirm the table exists

Grep `backend/db/schema.sql` for the table. If it does not exist, stop and run `/new-migration`
first. A module without its table is not scaffolding, it is two half-changes.

Confirm the table carries `law_firm_id` and follows the tenant key conventions in `AGENTS.md`
under Data Model. The primary key is normally `id`; tenant composite foreign keys use a
secondary unique constraint on `(law_firm_id, id)`. If the table is unscoped, say so and ask
before continuing.

### 2. Write the failing test first

```ts
import { createFirm, ownerOf, memberWith, stranger } from '../support/setupInProcess';
```

The first three cases, in this order:

1. **A caller from another firm gets refused.** This is the most expensive defect this codebase
   can ship and it never looks wrong on screen. Write it first.
2. **A member without the permission code gets a 403.**
3. **The owner gets the expected envelope.**

Run them. Watch all three fail for the right reason before writing any source.

### 3. Validation

Zod, one schema per operation, validating `body`, `params` and `query` together. Use `z.coerce`
for numeric query params. Let the centralized `validate` middleware throw `ValidationError`; do
not throw it yourself.

If the module handles money, validate every amount against `MAX_MONEY_AMOUNT` and follow the
`handling-money` skill.

### 4. Repository

Reads and writes go through `shared/database/queryContext` (`tenantQuery`, `firmQuery`,
`tenantAliasedQuery`, and `systemQuery` or `adminQuery` only for genuinely
unscoped infrastructure data) and `shared/database/scopedWrite` (`scopedInsert`,
`scopedInsertMany`, `scopedUpsert`, `scopedUpdate`, `scopedDelete`).

These wrap Drizzle's builder against the introspected schema in `shared/database/drizzle/schema`
and assert that the tenant predicate survived into the compiled SQL. A query that loses its
`law_firm_id` scope throws rather than silently running unscoped. The ESLint rule
`paralegix/safe-drizzle-boundary` fails the build if you reach the raw executor.

- Guard uuid params with `isUuid()` before querying a uuid column, or you get a cast error. It is
  exported from `shared/utils/isUuid`, its own module even though the old base class
  itself is legacy.
- Junctions use replace-set semantics: delete then insert inside `withDrizzleTransaction`,
  passing its executor to every nested call.
- Convert `timestamptz` to ISO per row with `rowIso` from `shared/utils/dateConversion`. Day-only
  `date` columns already arrive as `'YYYY-MM-DD'` strings; never wrap those in `new Date()`.
- Push filtering, ordering and limits into SQL. Do not pull rows into memory to filter them.
- Text search is `ILIKE`, built with `toIlikeTerm()` and always paired with `escape '\\'`. There
  is no full-text search outside `court_catalog`.
- Do not extend `SqlRepository`. It is deleted, and ESLint blocks the shape. Extend `DrizzleRepository`.

### 5. Service

- Accepts a destructured object, never `req` or `res`.
- Starts by asserting membership: `assertLawFirmMembership(lawFirmId, userId)`, plus
  `assertMatterMembership` when the resource is matter-scoped.
- Throws typed errors from `shared/errors/AppError`. Never calls `res.status()`.
- Emits through `eventBus` after a successful write when the domain has events.

### 6. Routes

Middleware order is `verifyToken`, `requirePermission`, `validate`, `requireTimezone`, handler.
Omit `requireTimezone` only when nothing in the route is time-aware.

- List routes come before `/:id` wildcards.
- `201` for a successful create, `200` for every other successful mutation.
- **Wrap every route body in `handler()`** from `backend/src/shared/http/handler.ts`. It returns
  the response body instead of writing it, and the status code is its SECOND argument:
  `handler(async (req) => service.create(...), 201)`. Never call `res.status().json()`; that is
  the shape `handler()` exists to delete from 558 routes.
- **No `try`/`catch` in a handler.** Express 5 forwards a rejected promise to the error
  middleware. Write the happy path and let it throw. Keep a `catch` only when it does real work.
- Response envelopes, never a bare array at the root:

| Operation | Shape |
|---|---|
| List | `{ <domainPlural>, totalItems }`, e.g. `{ leads, totalItems }`. A domain-named key, not `items`. `totalItems` only when `limit` was passed |
| Create | `{ message: 'X created successfully', xId: id, x: formatted }` |
| Update | `{ message: 'X updated successfully', x: formatted }` |
| Delete | `{ message: 'X deleted successfully', xId: id }` |
| Bulk | `{ message, requested, updated/deleted, failed, errors }` |

If the module needs notes, do not write note routes. `createNotesRouter()` from
`shared/notes/notesRouter.ts` generates all fourteen. Mount your module-specific extras onto the
router it returns. The same applies to attaching clients: check whether matters or tasks already
solved it before building a third copy.

### 7. Register it

1. Mount the router in `backend/src/app.ts`. Older mounts carry a `Phase N` comment and the
   newest ones carry a plain descriptive comment instead. Do not invent a new phase number.
2. Add permission codes. Follow `rbac-permissions`: the code goes in **both**
   `backend/src/modules/lawfirms/roles/permissions.ts` and
   `frontend/src/lib/constants/permissions.ts`, plus the authorization matrix test.
3. Add event constants to `backend/src/shared/events/eventTypes.ts` if the module emits. Naming is
   `MODULE_ACTION`. Listeners in `*.events.ts` are async and wrapped in try/catch.

### 8. Verify

```bash
cd backend && npx jest tests/<domain> && npm run typecheck && npm run lint
```

All three must pass before you report. Do not run the full suite unless the user asks.

## Module style

**Write the new module's files in TypeScript with `import` throughout.** Older files mix ES
`import` (Drizzle, schema, query contexts) with CommonJS `require()` (sibling modules and most
`shared/` utils). That mix is history, not a target: when you edit an existing file, match what
it already does rather than converting it mid-change.

---
paths:
  - "backend/src/**/*.repository.ts"
  - "backend/src/shared/database/**"
---

## Repository Pattern

**Write new repositories as fluent Drizzle through the audited query contexts.** Everything
else on this page describes what exists, not what to copy.

```ts
import { and, eq } from 'drizzle-orm';
import { things } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
import { scopedInsert, scopedUpdate } from '../../shared/database/scopedWrite';
import { rowIso } from '../../shared/utils/dateConversion';

const rows = await tenantQuery(things, lawFirmId, ({ executor, scope }) => executor
  .select().from(things).where(and(scope, eq(things.id, id))).limit(1));
```

`backend/src/modules/leads/leads.repository.ts` is the canonical example, including how it
shapes a row for the API (`formatLead`, using `rowIso` for `timestamptz` columns).

**One base class.** `DrizzleRepository` (`shared/database/DrizzleRepository.ts`) gives
tenant-scoped `findById`, `findByIdOrFail`, `findAll`, `findWhere`, `create`, `update`,
`delete` over a Drizzle table object, and `toEntity()` maps `Date` to ISO. Extend it when a
domain really is simple CRUD; reach for `tenantQuery` directly for anything with a join, an
aggregate or custom ordering.

`SqlRepository` was the legacy one, constructed with a snake_case table NAME. It is deleted,
and `no-restricted-syntax` blocks `extends SqlRepository` so the shape cannot return. Two
things that lived on it moved rather than went: `isUuid` is its own module
(`shared/utils/isUuid`), and its row shaping is `sqlRowToEntity` in
`shared/database/rowShape.ts`. Use that one for a read that assembles its own SQL, where the
row arrives keyed by column name: it converts to camelCase, maps `Date` to ISO, and drops the
generated `search` column. Drizzle shapes its own rows and needs none of it.

**Complex reads and writes** (joins, junctions, transactions, derived fields) use the audited
APIs in `shared/database/queryContext.ts`. Prefer fluent Drizzle; use `parameterizedSql`
through an audited context only when preserving a planner-sensitive SQL shape is clearer.
Transactions use `withDrizzleTransaction` and pass its executor to every nested call.

**Side effects of a multi-step write wait for the outer commit.** A service that publishes an
event, sends email or touches Firebase, GCS or Stripe after a write takes an optional
`TransactionEffects` and wraps its work in `withTransactionEffects(work, context)`
(`shared/database/transactionEffects.ts`). Called alone, it opens the transaction; called from
another service, it joins the caller's executor and queues `defer()`ed effects on the caller's
list. A rollback discards the list, so nothing announces a write that never landed. Effects run
after commit and a failing one is logged, not thrown, because the data is already committed.
This is not a distributed transaction: an effect lost to a crash after commit is not retried.
`clients.service.ts` and `lawfirms.service.ts` show the pattern. Its regression tests inject a
fault after the real write has run, then prove that nothing from the transaction survived.

**Module style.** New files are TypeScript with `import`. Many existing files mix `import`
for Drizzle and the query contexts with `require()` for sibling modules and `shared/` utils;
that is history, not a target. Match the surrounding file when editing one, and use `import`
throughout in a new one.

Rules of thumb (the first is also mechanically enforced; see below):
- **Always** use Drizzle-bound values or `parameterizedSql` through an audited context — never
  string-concatenate values.
- **Always** scope by `law_firm_id` (multi-tenant isolation is the app's job, not the DB's).
- Guard uuid params with `isUuid()` before querying uuid columns to avoid cast errors.
- Money is integer cents (`*_cents`). Junctions use replace-set semantics (delete-then-insert in a txn).

The audited-context rule isn't just convention: `backend/eslint.config.mjs` defines a custom rule
(`safe-drizzle-boundary`) that flags Drizzle query-builder calls (`.select().from(...)`, etc.) built
outside the audited contexts. The allowlist is exactly
`tenantQuery`/`firmQuery`/`systemQuery`/`adminQuery`/`tokenQuery`
(`AUDITED_QUERY_CALLS` in `eslint.config.mjs`). `scopedWrite` is not in that set; it is exempted by
file path instead, along with `drizzleClient.ts`, `queryContext.ts` and `DrizzleRepository.ts`.
(There was a fourth, `scoped.ts`, a read-only `scoped(table, lawFirmId)` helper. Nothing ever
called it, so it and its exemption are gone. Reads go through `tenantQuery`.)
Two sibling rules back it up: `no-restricted-imports` blocks the
`**/drizzleClient` group, and `no-restricted-syntax` blocks a direct `require()` of the
unrestricted Drizzle client. `npm run lint` catches a violation before it ships.


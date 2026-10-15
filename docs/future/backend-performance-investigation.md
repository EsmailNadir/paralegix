# Backend Performance: What Needs Digging Into

::: warning INTERNAL — INVESTIGATION LIST
This is a triage list for a follow-up investigator, not a plan. Every item states
whether it is **confirmed** (the defect is proven from the code and schema, and
the fix is known) or **needs measurement** (a suspicion with a specific thing to
go measure). Nothing here should be implemented on the strength of this document
alone. Items marked *needs measurement* should be `EXPLAIN`ed first.
:::

## Scope constraint

**Every item in this document is a code or schema change with no recurring cost
increase.** Deliberately excluded, even where they would help:

- Cloud Run `min-instances`, larger instances, or higher concurrency
- Commercial document-conversion SDKs
- New infrastructure of any kind (Redis, a cache tier, read replicas, a separate
  conversion service, a managed job queue)

Where an item has an obvious "just add infrastructure" answer, the in-process or
in-Postgres alternative is given instead.

## Summary

The query layer is in better shape than a codebase this size usually is. The
`count(*) OVER()` pagination helper is adopted across roughly 20 repositories,
statement and connection timeouts are set with documented reasoning, migration
`0130` was a foreign-key index sweep, plan enforcement short-circuits before
counting, and auth token verification is cached. There is no pile of obvious
low-hanging fruit, and several things that look like problems turn out to be
already solved.

What is left clusters into three recurring patterns, and recognizing the pattern
matters more than any single instance of it:

**Key takeaways:**

- **Pattern A: search infrastructure that exists but is never used.** Five
  generated `tsvector` columns and their GIN indexes are maintained on every
  write. Exactly one query in the entire backend reads one of them. Meanwhile the
  search endpoints on those same tables run `ILIKE '%term%'`, which is a
  guaranteed sequential scan. This is the highest-value finding in the document.
- **Pattern B: anchored `LIKE` without `text_pattern_ops`.** Three instances
  found. The team already diagnosed and fixed this exact class in migration
  `0050`, so the pattern is understood but was not applied consistently.
- **Pattern C: unbounded concurrency against a fixed resource.** The dashboard
  against the pg pool, document conversion against container CPU, GCS calls
  against the network. Same shape, four places.
- **The prerequisite for all of Tier 2 is instrumentation.** There is no query
  timing anywhere, so every "this might be slow" below is inference from code
  shape rather than evidence.

---

## Tier 1: confirmed, worth acting on

### 1.1 Add slow-query logging (confirmed gap, ~15 lines)

`query()` in `backend/src/shared/database/db.ts` is a bare passthrough to
`pool.query`. This describes the pre-Drizzle baseline. Runtime statements are now issued through
Drizzle on the same instrumented pool, so the instrumentation continues to record their duration.

Wrap it to log any statement over a threshold (start around 200ms) with its text,
duration, and row count. Consider tagging by route so the log points at a feature,
not just a SQL string.

**Why this is first:** it converts every Tier 2 item from speculation into a
ranked list using real staging traffic, within a day. Optimizing before this
exists means guessing which of the items below actually matter.

### 1.2 Five full-text search indexes are maintained and never queried (FIXED)

Fixed by migration `0140`, which dropped the generated `tsvector` columns from `matters`,
`tasks`, `clients` and `contacts`. Nothing read them, and `to_tsvector('english', ...)` was the
wrong tool for this data anyway: it tokenises an email as one indivisible unit, keeps a leading
hyphen on matter-number fragments, and its stop-word list contains "will". Search is
`ILIKE '%term%'` through `toIlikeTerm()`. `court_catalog` keeps its index and is the one genuine
full-text user. The original finding follows, for the reasoning.

This was the biggest finding here.

The schema defines generated `tsvector` columns with GIN indexes on five tables:

| Table | Column | Index | Covers |
|---|---|---|---|
| `clients` | `search` | `clients_search_gin` | name, email, organization |
| `contacts` | `search` | `contacts_search_gin` | name, email, organization |
| `matters` | `search` | `matters_search_gin` | see `backend/db/schema.sql:518` |
| `tasks` | `search` | `tasks_search_gin` | see `backend/db/schema.sql:652` |
| `court_catalog` | `search` | `court_catalog_search_gin` | names, citation, state |

A grep for `@@`, `to_tsquery`, `plainto_tsquery`, and `websearch_to_tsquery`
across the entire backend returns **exactly one hit**:

```
backend/src/modules/catalog/catalog.repository.ts:32
  cc.search @@ websearch_to_tsquery('english', $N)
```

So `court_catalog` uses its index. **The other four are dead.** They are
recomputed by Postgres on every insert and update of four of the hottest tables in
the application, their GIN indexes are maintained on every write, and no read path
ever touches them.

Meanwhile, search on those same tables goes through `toIlikeTerm` in
`backend/src/shared/database/searchTerm.ts`, which produces `%term%`. A
leading-wildcard `ILIKE` cannot use a btree index under any configuration. For
example `backend/src/modules/tasks/tasks.repository.ts:338`:

```sql
where (t.title ilike $N escape '\'
       or t.description ilike $N escape '\'
       or t.id in (select tcs.task_id from task_clients tcs ...))
```

`tasks.search` covers `title` and `description`. It is right there. It is not used.

Twelve repositories call `toIlikeTerm`: `lawfirms`, `clients`, `tasks`,
`contacts`, `admin`, `audit`, `users`, `files`, `messaging`, `matters`,
`billingReports`, plus the helper itself.

**So the app pays the full write cost of full-text search, gets none of the read
benefit, and sequentially scans on every search anyway.**

**What to investigate:**

- Confirm with `EXPLAIN (ANALYZE, BUFFERS)` that the search paths on `matters`,
  `tasks`, `clients`, and `contacts` are sequential scans today.
- Decide per table whether to (a) rewrite the predicate to use the existing
  `search @@ websearch_to_tsquery(...)`, or (b) drop the unused column and index.
  These are opposite fixes, and the choice is a product decision rather than a
  performance one: tsvector gives stemming and word matching but **not** substring
  matching, so `"smi"` stops matching `"Smith"`. If substring behaviour is
  required, the answer is a `pg_trgm` GIN index instead, and the tsvector columns
  should be dropped.
- `pg_trgm` is not currently enabled. Check whether Supabase makes it available
  before designing around it.
- A hybrid is possible: use the tsvector for word queries and fall back to `ILIKE`
  only when the tsquery returns nothing.

**Do not skip the write-side win.** Even if search behaviour is left exactly as it
is, dropping four unused generated columns and four unused GIN indexes speeds up
every write to `matters`, `tasks`, `clients`, and `contacts`.

### 1.3 `files.object_path` prefix search cannot use its index (FIXED, and the query is gone)

Fixed by the files tree. `listChildrenByPrefix` no longer exists: a folder is a row, the tree is
`files.parent_id`, and listing a folder's children is an equality match on an indexed uuid rather
than a `LIKE` over a path. An object path is opaque and is never parsed, which
`npm run db:files-tree` enforces. The original finding follows, for the reasoning.

#### Original finding

`backend/src/modules/files/files.repository.ts:114` (`listChildrenByPrefix`)
filters with:

```sql
where f.law_firm_id = $1
  and f.object_path like $2 escape '\'
```

`toPrefixPattern` produces an anchored `prefix%` pattern, which is exactly the
shape a btree can serve, **but only with `text_pattern_ops`**. Under the default
collation a plain btree is useless for `LIKE`. The only index on that column is:

```sql
create index if not exists files_object_path_uidx on files (object_path) where object_path is not null;
```

Default opclass. So the planner almost certainly falls back to `files_firm_idx`
(`law_firm_id` alone) and filters every one of the firm's file rows.

**This is not a hypothesis about Postgres behaviour. The team already hit it and
fixed it elsewhere.** migration `0050`
says the preview "was an O(firm-invoices) scan" and adds:

```sql
on invoices (law_firm_id, invoice_name text_pattern_ops)
```

`files` needs the identical treatment. Note the in-code comment at
`listChildrenByPrefix` explains why the read needs no row cap. That reasoning is
correct about *result* size, but it assumes the `LIKE` is index-served, so the
cost lands in rows examined rather than rows returned.

**Fix:** `create index ... on files (law_firm_id, object_path text_pattern_ops)`.
Confirm with `EXPLAIN (ANALYZE, BUFFERS)` before and after.

### 1.4 Dashboard exhausts the connection pool (FIXED)

Fixed. The multi-instance readiness work covered it, and its conclusions are in
[Deployment](/dev/ops/deployment); the plan file itself was deleted when it completed.

In summary: `backend/src/modules/dashboard/dashboard.service.ts` starts 14
sections at push time (`runSection` is `Promise.resolve().then(fn)`, so the work
begins immediately, not at `allSettled`). Several sections contain inner
`Promise.all`s. One dashboard load issues roughly 20 to 25 concurrent queries
against a `PG_POOL_MAX` of 10. It serializes into waves, and it starves unrelated
concurrent requests into the 10-second `connectionTimeoutMillis`.

### 1.5 Document conversion spawns unbounded processes (confirmed)

`libreoffice-convert` spawns a fresh `soffice` process per call, taking hundreds
of milliseconds to seconds, and it is memory-hungry. Nothing bounds how many run
at once, and they run synchronously inside the request.

Same shape as 1.4, different fixed resource: container CPU and RAM instead of pg
connections. On a single-instance deployment there is no other instance to absorb
the load.

**Fix, with no new infrastructure:** an in-process concurrency-capped queue, one
or two workers, in front of `convertDocument`. See
[Removing LibreOffice](/future/signatures-without-libreoffice) for the persistent
`soffice` server option, which attacks the per-call spawn cost itself.

---

## Tier 2: needs measurement before action

### 2.1 `listMattersPaged` (needs EXPLAIN)

`backend/src/modules/matters/matters.repository.ts` is 1,981 lines.
`listMattersPaged` alone is roughly 1,149 of them, with about 37 subqueries,
LATERAL joins, and `json_agg` calls.

It is the heaviest read in the application **and** it is called by both the matters
list page and the dashboard, so it sits on two hot paths. It is the most likely
place for a real win and the least safe place to change anything without evidence.

`EXPLAIN (ANALYZE, BUFFERS)` against realistic staging data, for the common filter
and sort combinations the UI actually issues. Specifically look for:

- LATERALs re-executing per row rather than being hoisted
- `json_agg` subqueries that could be one grouped join
- Sort spilling to disk (`external merge Disk` in the plan output) on large firms
- Whether the `count(*) OVER()` window forces materializing the entire filtered set
  before the `LIMIT` applies
- Whether the search predicate (see 1.2) dominates everything else when a search
  term is present

**Before optimizing, check whether it needs to do all of this.** A list view
returning 25 rows may be aggregating fields the list never renders. Compare the
selected columns against what the matters list page actually displays.

### 2.2 Messaging conversation list: partial indexes the query shape defeats (needs EXPLAIN, likely confirmed)

Subtle and worth close attention.

Migration `0014_messaging_fields.sql` creates two partial indexes precisely for
unread counting:

```sql
create index messages_firm_unread_idx on messages (conversation_id)
  where sender_type = 'client' and read_by_firm = false;
create index messages_client_unread_idx on messages (conversation_id)
  where sender_type = 'firm_member' and read_by_client = false;
```

But the conversation list at
`backend/src/modules/messaging/messaging.repository.ts:118` counts like this:

```sql
left join lateral (
  select count(*) filter (where um.sender_type = 'client' and um.read_by_firm = false)        as unread_firm,
         count(*) filter (where um.sender_type = 'firm_member' and um.read_by_client = false) as unread_client
    from messages um
   where um.conversation_id = c.id
) uc on true
```

The predicates sit in the aggregate `FILTER`, not in the `WHERE`. The only `WHERE`
clause is `conversation_id = c.id`, so Postgres must read **every message in the
conversation** and evaluate the filters per row. A partial index cannot serve a
condition that is not in the `WHERE`.

So both indexes are probably dead weight, and the conversation list costs O(all
messages in all listed conversations). That grows without bound as conversations
age, which is the worst growth curve possible for an inbox view.

**Fix to test:** replace the single LATERAL with two scalar subqueries, each
carrying its predicate in its own `WHERE` so each can use its matching partial
index. Verify with `EXPLAIN` that both index scans appear.

### 2.3 Billing reports and invoices reads (needs EXPLAIN)

- `backend/src/modules/billing/reports/billingReports.repository.ts`, 589 lines,
  roughly 40 `FROM` clauses against about 5 `LIMIT`s
- `backend/src/modules/billing/invoices/invoices.repository.ts`, 1,166 lines,
  roughly 32 `FROM` against about 5 `LIMIT`

Aggregate reporting legitimately scans a lot, so a low LIMIT ratio is not itself a
defect. But these are the two most likely to degrade non-linearly as a firm
accumulates history, and migration `0130` plus the recent billing-report index
work may or may not cover their actual filter shapes.

Check specifically whether any report scans all of `time_entries` for a firm when
a date range would bound it, and whether date-range predicates are sargable (bare
column on the left, computed expressions on the right).

### 2.4 Task activity aggregation (needs EXPLAIN)

`backend/src/modules/tasks/tasks.repository.ts:677` builds a day-bucketed series:

```sql
select (t.created_at at time zone 'UTC')::date as day, 1 as created, 0 as completed
```

Casting a timestamp to a date in the select list is fine. The question is whether
the surrounding query bounds the row set by a date range *before* aggregating, or
scans the firm's whole task history to build a chart covering a few weeks. Check
the `WHERE` clause and confirm the range predicate sits on the raw `created_at`
column rather than on the computed `day`.

The nearby due-date predicates
(`t.due_date >= (now() at time zone $4)::date`) are correctly shaped, with a bare
column on the left. Those are fine and should not be "fixed."

### 2.5 Long sequential `await` chains (needs profiling)

Files with the most sequential `const x = await ...` at statement level:

| File | Count |
|---|---|
| `backend/src/modules/stripe/stripe.service.ts` | 90 |
| `backend/src/modules/calendar/outlook/outlook.service.ts` | 67 |
| `backend/src/modules/calendar/google/google.service.ts` | 66 |
| `backend/src/modules/clients/portal/portal.service.ts` | 65 |
| `backend/src/modules/billing/invoices/invoices.service.ts` | 63 |

A high count is not automatically a defect. Many are genuinely dependent steps, and
the calendar and Stripe ones are mostly external API calls where ordering is often
required. **`portal.service.ts` is the one worth reading first.** It is on the
client-portal hot path, and portal users are the least tolerant of latency.

**Sequencing constraint:** parallelizing these before fixing 1.4 makes pool
contention *worse*, not better. Any parallelization here should carry a
concurrency bound, using the same helper 1.4 introduces.

---

## Tier 3: smaller, concrete, low individual value

### 3.1 The rate limiter writes to Postgres on every rate-limited request

`backend/src/shared/middleware/pgRateLimitStore.ts` does an
`insert ... on conflict do update` per request, on the request path, competing for
the same 10-connection pool as domain queries.

The store is well built and dedupes its cleanup timer across roughly 20 limiters.
But **the deployment is currently pinned to a single instance**, so the
cross-instance correctness a DB-backed limiter buys is not currently being used.
An in-process counter would be free and correct under today's topology.

Do not simply swap it. The DB store is the right design *if* multi-instance is
coming, and the discrepancy note below bears directly on that. A hybrid
(in-process counting with periodic DB reconciliation) preserves both properties.

### 3.2 `rate_limits` prefix delete: third instance of Pattern B

`resetPrefix` runs `delete from rate_limits where key like $1` with a `prefix:%`
pattern. `rate_limits.key` is the primary key, a default-collation btree, so the
same `text_pattern_ops` problem as 1.3 applies.

Low priority, since the table is small and this is a rare admin path, but it
belongs in the same sweep. **When fixing 1.3, audit every anchored `LIKE` in the
backend rather than fixing instances one at a time.** This class of bug is
invisible until the table grows.

### 3.3 Serial GCS round trips on multi-file upload

`backend/src/modules/files/files.upload.routes.ts:271` calls
`createResumableUpload` inside a `for` loop with `no-await-in-loop` explicitly
disabled. Each file costs a full serial round trip to GCS before the next begins,
so a 10-file upload pays roughly 10x the latency of one.

A bounded `Promise.all` (same helper as 1.4 and 1.5) would cut this to roughly the
slowest few. Bounded, not unbounded, for the Pattern C reason.

### 3.4 Unbounded `Promise.all` over GCS deletes

`backend/src/modules/matters/matters.repository.ts:1776` (`deleteAttachments`)
fans out `bucket.file(path).delete()` across every attachment at once. A matter
with many attachments issues that many simultaneous network calls. Same fix.

### 3.5 Roughly 126 `SELECT *`

Each ships columns nobody reads. On wide rows (`matters`, `invoices`) that is real
bytes over the wire and real memory in the Node process. Worth tightening
opportunistically in files already being edited rather than as a dedicated sweep.
Start with the widest tables.

### 3.6 Batchable write loops

`backend/src/modules/messaging/messaging.repository.ts:581` loops one
`client.query` per participant and per matter. Same shape at
`backend/src/modules/documentRequests/documentRequests.repository.ts:235` and
`backend/src/modules/signatures/signatures.repository.ts:592`.

Small N and inside a transaction, so the direct impact is minor. But `unnest`-based
bulk insert also shortens transaction duration, which matters more than the row
count does: a shorter transaction holds its pool connection for less time, which
feeds back into 1.4.

### 3.7 `PG_POOL_MAX` default of 10

Low for a service of this size. Check which Supabase connection string is in use
first, since the transaction pooler (6543) tolerates a much higher `max` than a
direct connection (5432). This is a free config change, but it is a **mitigation**
for 1.4 rather than a fix, and raising it without bounding the dashboard only moves
the saturation point.

---

## Discrepancy worth resolving first — RESOLVED

**Answered, and the answer was bigger than the question.** Investigated and implemented as
part of the multi-instance readiness work, whose conclusions are in
[Deployment](/dev/ops/deployment); this section is kept as the record of what the suspicion
got right and wrong.

**The outbox half of the suspicion was correct.** `eventOutbox.ts` claims rows with
`for update skip locked`, stamps a lease via `processed_at`, and reclaims rows whose claiming
worker died without incrementing `attempts` at claim time. That is the standard multi-worker
queue design, so the documented justification was false. The worker is also **off by default**,
which this document suspected and which turned out to matter: the doc line had been defending a
feature that was not running.

**The proposed answer — that calendar-sync coalescing is therefore the only remaining
constraint — was too optimistic**, in two directions.

*Coalescing was worse than "degraded optimization".* Both providers decided create-versus-PATCH
from a writeback field on an entity row loaded before the sync began, and the mapping row is
only written *after* a successful create, so two concurrent saves both saw no external id and
both POSTed — duplicate events on a user's real calendar. That is corruption, not a lost
optimization. Fixed by consulting `calendar_mappings` inside a per-entity advisory lock.

*And two larger problems existed that neither document knew about.*

1. **The cron layer had no mutual exclusion at all.** Cloud Scheduler is at-least-once and
   retries on timeout, so overlapping runs were reachable at ONE instance. Overlap clobbered the
   per-firm rotation cursor, cloned recurring tasks, and sent duplicate reminder emails. Every
   handler now takes an advisory lock and answers `200 {"status":"skipped"}` on contention.
2. **The `setInterval` housekeeping layer was already dead.** Under Cloud Run's request-based CPU
   allocation a background timer only gets CPU while a request is in flight, and at
   `min-instances=0` there is often no instance at all — so the three 24-hour sweeps effectively
   never fired, and only their 30-second boot companions ran, once per cold start per instance.
   That work moved to `POST /api/cron/housekeeping`.

**So the ceiling was never really about the outbox.** The real constraint is the Postgres
connection budget, and it is now derived rather than guessed: the session pooler on 5432 holds a
real backend per connection, staging measures `max_connections = 60` with about 13 held by
Supabase itself, so the safe ceiling is 40 and `PG_POOL_MAX × MAX_INSTANCES` must fit inside it.
See `shared/database/connectionBudget.ts`, which asserts that at startup.

**Item 3.1 (the rate limiter) is resolved in favour of keeping the Postgres store.** With
multi-instance no longer hypothetical, an in-process counter would make the effective cap scale
with instance count — a 100/min limit silently becoming 400/min at four instances.

**Item 3.7 (the pooler question) is closed:** it is the **session** pooler on port 5432, the
restrictive one, and it must stay session mode. `pg` delivers `statement_timeout` in the
connection startup packet, which a transaction pooler discards.

**Items 1.4 and 1.5 are done** — the dashboard fan-out is bounded by the derived budget, and
document conversion is capped at one per instance against the 512Mi container.

---

## What is already good: do not "fix" these

Listed so the follow-up investigation does not spend time re-deriving that they are
fine.

- **Pagination.** `count(*) OVER()` single-round-trip paging via
  `backend/src/shared/database/pagination.ts`, adopted across roughly 20
  repositories, with a documented `MAX_PAGE_OFFSET` deep-paging ceiling.
- **Timeout discipline.** `statement_timeout`, `connectionTimeoutMillis`, and
  `idle_in_transaction_session_timeout` are all set in
  `backend/src/shared/database/db.ts`, with reasoning documented inline.
- **No external I/O inside transactions.** A sweep for GCS, Stripe, email, and
  `fetch` calls inside `withTransaction` blocks found none. This is the most common
  way to wedge a connection pool, and the codebase does not do it.
- **Connection handling.** 38 `pool.connect()` calls against 38 `.release()` calls,
  with `finally` blocks where expected. No evidence of leaks.
- **Plan enforcement.** `enforceCountLimit` short-circuits on unlimited plans
  *before* issuing the `COUNT(*)`, with a comment explaining exactly that.
- **Timezone persistence.** `backend/src/shared/middleware/timezone.ts` caches the
  last-written value per user in process, bounded at 5,000 entries, so it writes
  only on change rather than per request.
- **Notification unread counts.** `notifications_unread_idx` is a partial index
  (`where not read`) that correctly matches the query predicate. Contrast with 2.2,
  where the equivalent index does *not* match.
- **`matter_activity`** is correctly indexed for its access pattern
  (`matter_id, created_at desc`).
- **Functional `lower()` index coverage.** The `lower(email)` and `lower(name)`
  lookups in `auth`, `invitations`, `matters`, and `billing` are backed by matching
  expression indexes on `users`, `clients`, and `contacts`.
- **Auth token verification caching** in `backend/src/shared/middleware/auth.ts`.

## Suggested order of work

1. **1.1** slow-query logging, then let it run for a day
2. **The discrepancy above**, since it gates 3.1 and reframes 1.4 and 1.5
3. **1.2** the dead search indexes, starting with the write-side win (dropping what
   is unused), which is safe regardless of how search itself is redesigned
4. **1.3 plus 3.2** as a single `text_pattern_ops` audit
5. **1.4** dashboard bounding, then **1.5**, **3.3**, and **3.4** reusing the helper
6. **Tier 2**, re-ranked by what the slow-query log actually showed

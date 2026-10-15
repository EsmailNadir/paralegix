# Server-Side Search

## Summary

Matters, tasks and clients are unbounded: a firm can accumulate thousands of each. Every screen that used to load one of those lists in full and filter it in the browser now asks the server instead. Two endpoint shapes carry this: a slim `/lookup` typeahead that backs every picker, and a paged list endpoint that backs every grid. On the frontend, `EntityPicker` / `EntityMultiPicker` wrap the typeahead, and the `useXTable` hooks wrap the paged list. Bounded firm catalogs (courts, practice areas, charge codes, UTBMS codes) were deliberately left alone and still use `Dropdown`'s built-in local search.

The same treatment was then extended to the remaining large lists (trust transactions, firm invoices and time entries, the files-page grids, and the conversation list), the shared SQL machinery was extracted into `backend/src/shared/database/pagination.ts`, and the shared list reads gained scope params so a consumer that needs one client's or one matter's rows stops pulling the firm list and filtering in the browser. See [Second Wave](#second-wave-trust-billing-files-messaging) below.

## Key Takeaways

- **Two shapes, two envelopes.** `/lookup` returns `{ items, hasMore }`; the paged list returns `{ items, totalItems }` (tasks: `{ tasks, totalTasks }`). `hasMore` exists so a per-keystroke request never pays for a count query.
- **Paging is opt-in and stays opt-in.** A request with no `limit` still returns the complete list. The billing workbench, the billing summary, and the matter/client message tabs depend on that, so `buildPageClause({ optional: true })` is not an oversight to be tidied away.
- **One implementation of clamp/sort/count.** `shared/database/pagination.ts` owns `clampLimit`, `whitelisted`, `resolvePage`, `parseSortModel`, `parseIdList`, `buildOrderBy`, `buildPageClause`, `resolveWindowTotal`, plus `LIST_CEILING` / `buildCeilingClause` / `applyCeiling` for deliberately unpaged reads and `MAX_PAGE_OFFSET` to bound nonsense page numbers. Each domain had grown its own copy; do not start a sixth.
- **`shared/lookup/` is not this feature.** Despite the name, `createLookupService` / `createLookupRepository` (`backend/src/shared/lookup/`) are the CRUD factory for small firm reference lists (courts, practice areas), ordered by `sort_order, name`. The typeahead is the per-module `/lookup` route described here.
- **Money figures are never derived from a page.** Billing windows the *derived* record set and reads its headline KPIs and tab counts from the firm-wide summary, so a filtered page can never become the number a firm reads as its total.
- **The paged list is page-then-enrich, via a CTE.** `count(*) over()` is a window function, so Postgres materializes the whole matching set before `LIMIT`. Enriching inside that select runs the lateral joins for every match, not just the page. The CTE pages over the bare table, and the enrichment joins onto only the returned ids. **The CTE must lead the `FROM`** or the planner picks a merge join and enriches everything anyway.
- **The ethical wall applies to every matters/tasks read path, lookup included.** `seeAll` (firm owner/admin) drops the membership predicate; false keeps it. It must **AND** with the `ids` branch, never be replaced by it, or id-resolution becomes a way to read matters the user is not a member of.
- **`ids` mode is strictly exclusive and never falls back.** An `ids` request that resolves to nothing returns empty. Falling through to the search branch would label a stale selection with an arbitrary unrelated record.
- **Scoping params fail closed.** `clientId`, `clientIds`, `matterId`, `relatedClientId`, `excludeArchived`, `portalOnly`, `clientType`, `excludeLinkedToClientId`, `includeDetails`, `full`. An unusable scope value returns an empty list rather than the unscoped one, and **every one of them belongs in the React Query key** or a scoped picker will serve an unscoped cache entry.
- **Resolution modes are exclusive too.** Besides `ids`, the clients lookup resolves by portal `userIds` (Firebase UIDs), and all three lookups accept `exactName` for duplicate-name checks. Each is its own branch and its own cache mode in `lookupQueryKey`.
- **`excludeArchived` deliberately does not apply in `ids` mode.** That asymmetry is what lets a trust transaction saved before its client was archived still render that client's name.
- **`EntityPicker` for unbounded entities, `Dropdown` for bounded catalogs.** Do not put a firm's court list behind a typeahead; do not put its matter list in a `Dropdown`.

---

## How It Works

### Entry Points

**Backend routes**

| Method & Path | Permission | Envelope | File:line |
|---|---|---|---|
| `GET /api/lawfirms/:lawFirmId/matters` | `matters.view` | `{ matters, totalItems }` | `matters.routes.ts:37` |
| `GET /api/lawfirms/:lawFirmId/matters/lookup` | `matters.view` | `{ items, hasMore }` | `matters.routes.ts:88` |
| `GET /api/lawfirms/:lawFirmId/tasks` | `tasks.view` | `{ tasks, totalTasks }` | `tasks.routes.ts:24` |
| `GET /api/lawfirms/:lawFirmId/tasks/lookup` | `tasks.view` | `{ items, hasMore }` | `tasks.routes.ts:85` |
| `GET /api/lawfirms/:lawFirmId/clients/lookup` | `clients.view` | `{ items, hasMore }` | `clients.routes.ts:117` |

**Frontend surface**

| Piece | Purpose | File:line |
|---|---|---|
| `EntityPicker` | Single-select typeahead over matters/clients/tasks | `src/components/ui/EntityPicker.tsx:102` |
| `EntityMultiPicker` | Multi-select typeahead, selections pinned above results | `src/components/ui/EntityMultiPicker.tsx:111` |
| `useEntityLookup` | React Query wrapper for the search branch | `src/hooks/useEntityLookup.ts:211` |
| `useEntityByIds` | Resolves labels for ids a form already holds | `src/hooks/useEntityLookup.ts:290` |
| `useEntityByIdsChunked` | Same, split into `LOOKUP_MAX_LIMIT` chunks | `src/hooks/useEntityLookup.ts:355` |
| `useDuplicateNameCheck` | `exactName` lookup for "a record with this name exists" warnings | `src/hooks/useEntityLookup.ts:172` |
| `lookupQueryKey` | The shared cache key; **every scope param belongs in it** | `src/hooks/useEntityLookup.ts:83` |
| `useServerTable` | Page/sort/search state for a grid | `src/hooks/useServerTable.ts` |
| `useMattersTable` / `useTasksTable` | Turn that state into a paged request | `src/hooks/matterHooks/useMattersTable.ts:31`, `src/hooks/taskHooks/useTasksTable.ts:32` |
| Tuning constants | Debounce, page size, `Dropdown` thresholds | `src/lib/constants/search.ts` |

### The Two Endpoint Shapes

**Slim `/lookup` typeahead.** Fires on every keystroke behind a 350 ms debounce (`SEARCH_DEBOUNCE_MS`), asks for 20 rows (`LOOKUP_PAGE_SIZE`), server clamps `limit` to 50 (`LOOKUP_MAX_LIMIT`). It returns `{ id, label, sublabel }` plus a few cheap row fields (matters add number/status/court, clients add `status`, portal `userId` and `clientType`), because hydrating assignees, clients and dependencies through lateral joins to render three fields in a dropdown is wasted work on a per-keystroke request (`tasks.repository.ts:625-632`).

There is no count. The repository fetches `limit + 1` rows and reports `hasMore = rows.length > lim`, then slices back to `lim` (`matters.repository.ts:1189-1190`, `clients.repository.ts:608-609`). One extra row instead of a second full scan per keystroke. The route comments call this out as a deliberate deviation from the `{ items, totalItems }` house envelope (`matters.routes.ts:81-88`).

`ids` and `search` are **strictly exclusive**. Passing `ids` resolves exactly those records; the search predicate is not applied at all. And an `ids` request that resolves to nothing returns empty rather than falling through:

```js
// matters.repository.ts:1134-1142
if (wantsIdResolution) {
  if (!idList.length) return { items: [], hasMore: false };
  params.push(idList);
  where.push(`m.id = any($${params.length}::uuid[])`);
}
```

Without that early return, "label these specific matters" would be answered with an arbitrary page of unrelated ones, and a picker holding a stale id would confidently display the wrong matter as its selection.

**Paged list.** Returns `{ items, totalItems }` from a single round-trip, with the total computed by a `count(*) over()` window rather than a separate `count(*)` query. Backs the matters grid and the tasks grid. Supports filters, free-text search, multi-column sort, and `limit`/`offset` or `page`.

### The Page-Then-Enrich CTE

This is the single most important shape in the feature, and the reason it exists is not obvious.

`count(*) over()` is a **window function**. Postgres must materialize every row matching the `WHERE` clause before `LIMIT` can apply, because the window is evaluated over the full result set. That is a property of windowing over the select, **not** of where the count column sits in the select list; moving the column around the projection changes nothing.

So if the count window lives inside the *enriched* select, the lateral member/client/invoice subqueries run once per **matching** row (thousands) to render one page (tens). The fix is to compute the count somewhere the enrichment is absent:

```sql
-- matters.repository.ts:971-983
with page as (
  select c.id, count(*) over() as total_count
    from matters c
   where <filters>
   order by <sort> limit $n offset $m
)
select <enriched columns>, p.total_count
  from page p
  join matters c on c.id = p.id and c.law_firm_id = $1
  <lateral enrichment joins>
 order by <sort>
```

The CTE pages over the bare table on cheap columns; the enrichment joins onto only the ids that survived the window. The count stays exact. The tasks list uses the identical shape (`tasks.repository.ts:543-556`). The matters list pages with `buildPageClause({ max: 500, optional: true })`, so a request with no `limit` still gets every row (`matters.repository.ts:966-968`).

**The CTE must lead the `FROM` clause.** Appending `join page p on p.id = c.id` after the existing `LEFT JOIN` chain is valid SQL and looks equivalent, but it lets the planner pick a merge join that enriches the full match set anyway. Measured at 5,000 matters, page 100: with `page` leading, enrichment runs `loops=50` (the page size). With the join appended, it runs over the whole match set. The same effect was measured at smaller scale during development: 291 enrichment loops for a 10-row page versus 10 when `page` drives (`matters.repository.ts:883-905`).

Sorting is applied **twice**: inside the CTE, to choose which rows are on the page, and again in the outer select, because the join does not preserve CTE order. Every `SORT_COLUMNS` expression must therefore resolve against the base table alias alone, since the enrichment joins are not in scope inside the CTE. That is why `practiceArea` and `leadUser` sort through scalar subqueries rather than through the joined `pa` / `lu` aliases (`matters.repository.ts:936-953`).

### The Ethical Wall

Matters and tasks are membership-scoped. Every read path must branch on `seeAll`:

| Path | Resolution | File:line |
|---|---|---|
| Matters list | `canViewAllMatters` → `isFirmOwnerOrAdmin` | `matters.service.ts:447-448`, `:474`, `:529` |
| Matters lookup | same | `matters.service.ts:548` |
| Tasks list | `isFirmOwnerOrAdmin` | `tasks.service.ts:406`, `:442` |
| Tasks lookup | same | `tasks.service.ts:478` |

`seeAll = true` (firm owners and admins) drops the membership predicate. `false`, the default, keeps it:

```js
// matters.repository.ts:1113-1117
if (!seeAll) {
  params.push(userId);
  where.push(`exists (select 1 from matter_members mm
                       where mm.matter_id = m.id and mm.user_id = $${params.length})`);
}
```

Tasks add one wrinkle: firm-level (matter-less) tasks are visible to everyone in the firm, matter-scoped tasks require membership of that matter (`tasks.repository.ts:663-669` for the lookup, `:314-316` for the list). The lookup and the paged list must keep that predicate identical or the two views of the same data disagree.

**The wall must AND with the `ids` branch, not be replaced by it.** In every lookup the wall predicate is pushed into `where` *before* the `ids`/`search` split, so both branches inherit it. If id-resolution skipped the wall, any picker would become a read primitive for records the user has no access to: pass an id, get back its name. This is the rule to check first when adding a new lookup endpoint.

Scoping params are likewise **additional** predicates, ANDed with the wall rather than replacing it, so a scoped picker can never widen what the user may see (`matters.repository.ts:1118-1131`).

### Scoping Params

| Param | Applies to | Effect |
|---|---|---|
| `clientId` | matters lookup (one id or a comma list), tasks lookup | Only rows linked to that client |
| `matterId` | clients lookup, tasks lookup | Only clients linked to that matter via `matter_clients`; only that matter's tasks |
| `excludeArchived` | clients lookup | Drops `status = 'archived'`; `inactive` stays selectable |
| `full` | matters, clients lookup | Swaps the slim row for the complete enriched record |
| `portalOnly` | clients lookup | Only clients with a linked portal user (`clients.user_id`). Backs the signature signer picker, where a client with no portal account cannot be a signer |
| `clientType` | clients lookup | Person or company rows only |
| `excludeLinkedToClientId`, `excludeId` | clients lookup | Drop people already linked to a company, or one row, so an "add existing" picker cannot offer a duplicate |
| `userIds` | clients lookup | Resolution mode: resolve rows by portal Firebase UID instead of client id |
| `exactName` (`exactOrganization` for clients) | all three lookups | Resolution mode for duplicate-name warnings |
| `clientIds` | tasks, messaging lists | Restricts to rows tied to any of a set of clients |
| `matterId` | tasks list, messaging lists | Restricts to one matter's rows |
| `relatedClientId` | firm invoices | Invoices related to that client, including through their matters |
| `includeDetails` | firm invoices | Adds the per-invoice detail the caller would otherwise re-fetch per row |

Every slim clients row also carries the linked portal `userId`, so a picker that needs the portal identity does not have to re-request the enriched shape to find it (`clients.repository.ts:637-645`). The signature signer picker uses this and **fails loudly** when a chosen client has no portal account, rather than falling back to the client row id, which would have named the wrong signer.

**An unusable scope returns empty, never an unscoped list.** A malformed `clientId` or `matterId` short-circuits to `{ items: [], hasMore: false }` rather than being ignored (`matters.repository.ts:1118-1126`, `clients.repository.ts:494-499`, `tasks.repository.ts:636-661`). Ignoring it would answer "this client's matters" with every matter in the firm, which is the exact misattribution the scoping exists to prevent: a trust transaction picker offering every firm matter lets one client's IOLTA movement be booked against another client's matter.

`full` runs the enrichment as a **second pass over only the ids the slim query already returned**, so it cannot reach a record the filters or the wall excluded (`matters.repository.ts:1192-1205`, `clients.repository.ts:620-633`). Enriched items keep `label` / `sublabel` alongside the record fields so the same picker component renders either shape.

`excludeArchived` is the one param with a deliberate asymmetry: it applies **only** to the browse/search branch, never to `ids` or `userIds`:

```js
// clients.repository.ts:536-541
} else {
  // Scoped to the browse/search branch: see the note on `excludeArchived`
  // above for why an id-resolution request keeps archived clients.
  if (excludeArchived) where.push(`c.status is distinct from 'archived'`);
  ...
```

Archived means "no longer transacted with", so the trust screens must not offer these clients for new work. But a trust transaction written before the client was archived still has to render that client's name rather than a blank, and that record resolves its label through `ids`. `is distinct from` rather than `<>` so a legacy row with a null status is treated as not-archived instead of dropping out of every picker. Every slim client row carries `status` so a caller that needs to tell the two apart can (`clients.repository.ts:635-645`).

### Frontend: Picker vs Dropdown

**Use `EntityPicker` / `EntityMultiPicker` for matters, clients and tasks.** These are unbounded (a firm can have thousands), so the option list comes from the server typeahead.

**Use `Dropdown` for bounded firm catalogs**: courts, practice areas, charge codes, UTBMS codes, expense categories, statuses, priorities. These are firm-configured and small. `Dropdown` already handles the scale it needs to: it shows a filter input once the option count passes `DROPDOWN_SEARCH_THRESHOLD` (12) and renders at most `DROPDOWN_MAX_RENDERED` (100) rows, counting the rest in a footer that prompts the user to narrow (`Dropdown.tsx:239`, `:258`). Putting a bounded catalog behind a typeahead adds a network round-trip per keystroke for no benefit.

`EntityPicker` is itself a `Dropdown` in controlled-search mode, so both share one menu animation, one keyboard model, and one visual language.

**Two queries back every picker.** One for what the user is typing, one that resolves the label of whatever is already selected (`EntityPicker.tsx:140`, `:160`). The second is what keeps the trigger readable when the selection is archived, renamed, or simply past the first page of results. In `EntityMultiPicker` the resolved selections (`useEntityByIdsChunked`, `:151`) are **pinned above** the search results, which is what makes a server-backed multi-select safe: without pinning, a search term that excludes an existing selection would hide it, and the user could neither see nor remove it (`EntityMultiPicker.tsx:105`, `:182`).

**Every scope param must be in the React Query key.** `lookupQueryKey` (`useEntityLookup.ts:83-125`) is `[entity, lawFirmId, 'lookup', mode, search, exactName, sortedIds, sortedUserIds, clientId, matterId, excludeArchived, excludeMatterId, excludeLinkedToClientId, portalOnly, clientType, full]`, where `mode` is `ids` / `userIds` / `exactName` / `search`. The mode slot keeps a disabled resolution query from observing the cached browse page. A scoped picker sharing a cache entry with an unscoped one would hand a trust transaction another client's matters. Adding a new scope param without adding it to the key produces exactly that bug, silently, and only under a warm cache.

The key deliberately starts with `[entity, lawFirmId]` because that is the cache root every mutation already invalidates by, and React Query matches keys by prefix. Rooting lookups anywhere else (e.g. `['lookup', ...]`) would put them outside the reach of those invalidations, so pickers would keep serving stale options after a create or a rename.

### Grids: Selection, Filters, and CSV Export

The grids hold **one server page**. Three consequences the UI has to respect:

1. **Selection spans the filtered set, not the page.** "Select all" asks the server for every matching id, individually ticked rows survive paging, and a select-all capped by the server's ceiling shows a notice so the count is not read as "everything" (`MattersGrid.tsx:189-198`, `TasksGrid.tsx:707-716`). Changing filters or search still clears the selection, so a bulk action never covers rows the current filters no longer describe (`TasksGrid.tsx:435-443`).
2. **Out-of-range pages self-correct.** If the current page is past the end of the result set (the last page's rows were all deleted), the server returns no rows and a zero total. Both table hooks call `recoverOutOfRangePage` (`useServerTable.ts:53`) during render, guarded on `page > 1` so it cannot loop on a genuinely empty first page (`useMattersTable.ts:52`, `useTasksTable.ts:101`).
3. **CSV export re-requests the whole filtered set.** Exporting `rows` would silently write one page where the user asked for everything that matches. Both grids loop over backend-max windows carrying the same filters/sort/search, capped at 40 pages (`MattersGrid.tsx:554-567`, `TasksGrid.tsx:516-538`). Matters windows at 500 rows, tasks at 200, each being that endpoint's `limit` ceiling. The tasks export surfaces a banner when it hits the cap, so a short file is never mistaken for a complete one.

### Second Wave: trust, billing, files, messaging

The first pass covered matters, tasks and clients. A second pass moved the remaining
large lists off fetch-everything-then-slice, so only one page crosses the wire and a
filter applies across the whole result set rather than across whatever happened to
have loaded.

| Surface | What changed |
|---|---|
| **Trust** | Transactions page against the server; the silent 100-row cap is gone. CSV export re-fetches the full filtered set in batches instead of writing out the visible page. |
| **Billing** | The derived invoice and time-entry sets are windowed; `dueGroup` and `awaiting` filters added. Headline KPIs and tab counts come from the firm-wide summary, not from a page. |
| **Files** | The matters, tasks and clients grids run on the shared table hooks. Bulk select is scoped to the visible page, and a deep-linked entity resolves by id so it survives a reload or a back-navigation. |
| **Messaging** | The conversation list windows with load-more **at offset 0**, and search plus the archive split moved into SQL. |
| **Matters** | The create and edit client roster fetch was replaced by the server typeahead picker. |

Two decisions in there are worth keeping in mind before "fixing" them:

**Billing filters run over the derived record set, not in SQL.** Invoice status, remaining balance, client attribution, rate resolution and `billingStatus` are all computed in JavaScript from several joined reads. A SQL filter would have to re-implement that derivation and could then drift from it, so `firmBillingWindow.ts` filters the derived records instead and mirrors the UI's old client-side predicates field for field. Pushing them down into SQL stays available as a later optimization, but it is a correctness risk, not a free speedup. Its date comparisons are calendar-day comparisons between `'YYYY-MM-DD'` strings in the **viewer's** timezone, never timestamp parses, which is what used to shift day-only columns for viewers behind UTC.

**Messaging loads more at offset 0, not at the next offset.** The conversation list reorders in realtime as messages arrive. Paging by offset against a list that reorders underneath you shuffles rows across page boundaries, so a conversation can be shown twice or skipped entirely. Requesting a larger window from offset 0 avoids that, at the cost of re-sending rows the client already has.

### Shared helpers

`backend/src/shared/database/pagination.ts` holds the machinery every one of these
reads had independently grown:

| Helper | Role |
|---|---|
| `clampLimit` | Bounds a caller's page size into `[1, max]`; a missing or unparseable value falls back rather than erroring (`pagination.ts:35`) |
| `whitelisted` | Own-key lookup in a field → SQL map (`:49-52`) |
| `resolvePage` | Resolves `{ limit, offset, page }` into a concrete row range; `offset` wins over `page` so older query strings keep working; offsets are bounded by `MAX_PAGE_OFFSET` (1,000,000, `:28`) |
| `parseSortModel` / `parseIdList` | Parse the compact `field:dir,field:dir` sort model and the comma-separated `?ids=` param |
| `buildOrderBy` | Whitelist-driven ORDER BY with a mandatory tiebreaker (`:137-151`) |
| `buildPageClause` | Appends bound `limit`/`offset` params and returns the fragment; `optional: true` preserves the unpaginated contract (`:164-174`) |
| `LIST_CEILING` / `buildCeilingClause` / `applyCeiling` | For deliberately unpaged reads: fetch `ceiling + 1` (5000 + 1) rows and report `truncated` so the client can say the list is partial (`:189-215`) |
| `resolveWindowTotal` | Reads the `count(*) over()` total off the page, falling back to a count query only for an empty page past offset 0 (`:232-242`) |

Two details in there are load-bearing:

- **Sort fields are looked up with `hasOwnProperty`, not `map[key]`.** `buildOrderBy` goes through `whitelisted`, because a plain lookup also resolves inherited `Object.prototype` members, so a caller sorting by `constructor` or `__proto__` would get a truthy non-column interpolated into the ORDER BY. Route schemas whitelist field names too, but this is the layer that actually builds SQL, so it does not rely on that.
- **`resolveWindowTotal`'s `countSql` must reuse the page query's WHERE with identical `$N` numbering.** That is why callers snapshot their filter params *before* `buildPageClause` appends the paging ones (`matters.repository.ts:961-963`).

On the frontend, `frontend/src/lib/utils/listQuery.ts` holds the matching `applyListWindow`, `applyListSortSearch` and `serializeListSort`. The tasks query key uses the same encoder as the request, so key and URL cannot drift. `recoverOutOfRangePage` lives in `useServerTable` rather than being duplicated in each table hook.

Alongside the extraction, `limit`/`offset` in trust, audit and catalog were converted from string interpolation to bound, clamped parameters.

### Example: the trust transaction client picker

`TransactionForm` books money into or out of an IOLTA account against one client. Walking it through:

1. The user opens Record Transaction. `EntityPicker entity="clients" excludeArchived` renders with no options loaded (`TransactionForm.tsx:185`).
2. Opening the menu enables the search query. `useEntityLookup` fires with an empty search after the debounce, keyed `['clients', firmId, 'lookup', 'search', null, null, null, null, null, null, 'excludeArchived', null, null, null, null, null]`.
3. `GET /clients/lookup?limit=20&excludeArchived=true` → repository adds `c.status is distinct from 'archived'`, fetches 21 rows, returns 20 plus `hasMore: true`.
4. The user types "acme". Debounced to one request; `hasMore` false this time, so the "keep typing to narrow" footer disappears.
5. Selecting a client fires `onChange` then `onSelectItem`. The form stores `clientId` and `clientName`, and clears `matterId`/`matterName`. A matter left over from the previous client would attribute the trust movement to the wrong client's matter.
6. The matter picker appears, scoped `clientId={clientId}`, so it can only offer matters linked to that client.

Now the archived case. A trust transaction was saved last year; its client has since been archived. Rendering that record's client name goes through `useEntityByIds` → `ids` mode → the `excludeArchived` predicate is not applied → the row comes back with `status: 'archived'` and its label renders. The same client does **not** appear in the browse list for a new transaction. That is the whole point of the carve-out.

### Dependencies

- Plain parameterized `ILIKE` with an escaped term for every search path here, list and typeahead alike, backed by `pg_trgm` (`backend/db/schema/00_extensions.sql:4`) GIN indexes on the searched columns, among them `clients.name/email/organization`, `users.name/email` and `matters.name/matter_number` (`backend/db/schema/95_deferred_fks.sql:85-91`). The old `search` tsvector columns on `matters` / `tasks` / `clients` were dropped since nothing read them; the only `websearch_to_tsquery` caller left is the court catalog (`catalog.repository.ts:51-54`). A user typing `%` searches for a literal percent sign rather than matching everything (`toIlikeTerm` + `escape '\'`).
- `requestDeduplicator` for all lookup GETs, so several pickers mounting at once collapse into one in-flight request per URL.
- React Query for caching, `placeholderData` to hold the previous page while the next loads.
- No new env vars, no new tables, no migrations.

---

## What Can Be Improved

- **Deep-page `OFFSET` cost.** Tasks page 1 measures 5.7 ms; page 100 measures 19.8 ms at 5,000 rows. This is inherent to `OFFSET`, since Postgres still walks the skipped rows. The real fix is keyset (seek) pagination, which would mean giving up arbitrary page jumps in the footer. Not worth it at current scale; revisit if a firm reports slow deep paging (`tasks.repository.ts:543`).
- **`EntityMultiPicker` does not forward `full`.** `EntityPicker` accepts it, the multi-picker does not (`EntityMultiPicker.tsx`). No caller needs it today; add it when one does rather than leaving the asymmetry to be discovered.
- **The lookup SQL is still hand-built strings.** The three `lookup*` methods assemble `where` arrays with `$${params.length}` interpolation and run through `tenantParameterizedQuery` (`matters.repository.ts:1109-1185`, `clients.repository.ts:476-606`, `tasks.repository.ts:633-700`), while the rest of the data layer moved to Drizzle builders. The ids-then-search exclusivity and the wall-before-branch ordering are enforced only by statement order in each copy; a shared builder would put those two rules in one place.
- **Billing filters are applied to the derived record set, not in SQL**, so the whole matching set is still built in memory before it is windowed. Correct, and deliberately so (the derivation lives in JavaScript), but it means billing does not get the wire-size *and* work-size win the SQL-paged surfaces get. Pushing the derivation into SQL is the real fix and is a large piece of work.
- **Messaging's load-more re-requests from offset 0**, so growing the conversation list re-sends rows the client already holds. That is the price of a list that reorders in realtime; a cursor keyed on the sort tuple rather than an offset would fix it properly.
- **No integration test covers the `ids`-mode `excludeArchived` carve-out.** It is the case most likely to regress silently (a future refactor moving the predicate out of the `else` branch would blank the client name on every historical trust transaction) and the least likely to be noticed in manual testing.

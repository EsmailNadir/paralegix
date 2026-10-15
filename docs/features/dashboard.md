# Dashboard (Firm Member Landing)

## Summary

The firm-member dashboard is the landing page at `/lawfirm/[lawFirmId]`: a widget-based home screen showing stat cards plus widgets for recent matters, upcoming tasks, "my assignments", overdue tasks, recent messages, the team roster, pending signatures, a financial snapshot, upcoming payments, upcoming calendar events, a compact calendar, and the current user's logged time (with a start/stop timer). Widgets are user-configurable (visibility, order, two zones "main"/"sidebar") via `PreferencesContext`, and the set of stat cards is also user-selectable (up to 6, `page.tsx:564`, of the 17 keys in `StatCardKey`, `types/preferences.ts:48-65`).

The page is backed by a single backend aggregate endpoint, `GET /api/lawfirms/:lawFirmId/dashboard-summary` (`backend/src/modules/dashboard/`), which computes every stat-card count in SQL and returns the top-N recent matters / upcoming tasks / my-assignments / overdue tasks / recent conversations / aging invoices / upcoming payments / upcoming events / today's time entries in one round trip. The page consumes it through React Query (`useDashboardSummary`).

Note: `/dashboard` (`frontend/src/app/dashboard/page.tsx`) is **not** the widget dashboard: it is a firm *selector* / landing that lists the user's firms and auto-redirects to `/lawfirm/{id}` when there is exactly one firm. The actual widget dashboard documented here is `frontend/src/app/lawfirm/[lawFirmId]/page.tsx`.

## Key Takeaways

- **One aggregate backend endpoint:** `GET /api/lawfirms/:lawFirmId/dashboard-summary`, mounted at `app.ts:920` (`dashboard.routes.ts`, `dashboard.view` + `requireTimezone`, `:24-27`) and served by `getDashboardSummary` (`dashboard.service.ts:614`). It returns `{ stats, recentMatters, upcomingTasks, myAssignments, overdueTasks, recentConversations, teamMembers, pendingSignatures, agingInvoices, upcomingPayments, upcomingEvents, todayTimeEntries, sectionErrors, permissions }`.
- **Stat counts are computed in SQL**, not in the browser: `matterStats` (`:171`, or `firmMatterStats` `:186` for a user who sees every matter), `taskStats` (`:204`), `financialAggregates` (`:300`), `timeStats` (`:460`). The page reads scalar counts straight from `summary.stats`.
- **Twelve independent sections, each permission-gated and error-isolated.** `runSection(name, fn)` returns a `{ section, patch, failed }` result; the work units run through `runWithWeightedConcurrency` with weights from 1 up to 4 for `financial`, so heavy sections cannot starve cheap ones, and patches merge after all settle. The capacity is `DASHBOARD_CONNECTION_CAPACITY` (`connectionBudget.ts`), capped at `DASHBOARD_REQUEST_CONNECTIONS = 5` per request less 1 for the owner/admin probe, so one dashboard load holds at most 5 of the instance's shared pool connections. `tests/dashboard/dashboardConnections.test.ts` measures that peak. A failed section keeps its fallback (`[]` / `null` / absent stat) and sets `sectionErrors[section]`, so the client can tell a transient failure from a permitted-but-empty section.
- **Per-section permission scoping** (`dashboard.service.ts:624-632`): the route gates on `dashboard.view`; the service additionally gates each section on `matters.view` / `tasks.view` / `messaging.view` / `members.view` / `signatures.view` (plus the `documentSigning` plan feature, `:803-809`) / `billing.viewInvoices` (financial and upcoming payments) / `calendar.view` (events; client events additionally require `clients.view`) / `billing.viewTimeEntries` (my time). Owners and firm admins (`isResolvedMemberOwnerOrAdmin`, read off the resolved `member` with no query) skip matter/task/event membership scoping: `visibleMatterIds` returns `ALL_MATTERS` for them (`:144-164`).
- **Cold load is ~4 backend GETs** on `/lawfirm/[lawFirmId]`: firm (layout), members (PermissionsContext), user settings (PreferencesContext), and dashboard-summary. Team roster and pending signatures are folded into the aggregate. Pending signatures still get a realtime subscription + a 5-min fallback poll after first paint.
- **Money is integer cents end to end.** Financial aggregates sum `*_cents` columns in SQL and the page formats them (`formatCentsShort` / `formatCentsFull` in `page.tsx`). Unbilled work is read from `activities` (kinds `time`, `flat_fee`, `expense`) with an anti-join on `invoice_line_items`, the same "unbilled" rule the billing workbench uses.
- **Default layout** (`DEFAULT_DASHBOARD_WIDGETS`, `types/preferences.ts:272-289`): hero, stats, recent matters, upcoming tasks, my assignments, messages, team, upcoming payments and the compact calendar are visible; pending signatures (sidebar), financial, upcoming events, overdue items and my time ship hidden. `DEFAULT_STAT_CARDS` is four cards (`:291-296`). `sanitizeDashboardWidgets` / `sanitizeStatCards` (`:453`, `:480`) append new keys to existing users' saved prefs so they appear in Customize without disturbing current layouts.

---

## How It Works

### Entry Points

| Path | File | Role |
|---|---|---|
| `/lawfirm/[lawFirmId]` | `frontend/src/app/lawfirm/[lawFirmId]/page.tsx` (`LawFirmDashboardPage`) | The widget dashboard |
| Layout wrapper | `frontend/src/app/lawfirm/[lawFirmId]/layout.tsx` (`LawFirmLayout`) | Auth gate, firm fetch, mounts all context providers (incl. `BillingTimerProvider` at `:415`) |
| Aggregate route | `backend/src/modules/dashboard/dashboard.routes.ts` (mounted `app.ts:920`) → `dashboard.service.ts` `getDashboardSummary` (`:614`) | Single dashboard payload |
| Summary hook | `frontend/src/hooks/dashboardHooks/useDashboardSummary.ts` | React Query read of the endpoint |
| Summary service | `frontend/src/services/dashboard.service.ts` | `getDashboardSummary(lawFirmId)` + response contract |
| `/dashboard` | `frontend/src/app/dashboard/page.tsx` | Firm selector (redirects to a firm), not the widget dashboard |
| Preferences | `frontend/src/contexts/PreferencesContext.tsx` | Widget/stat-card/theme config |

The layout mounts the provider stack the page depends on, ending in `BillingTimerProvider`, which the "My Time" widget drives via `useBillingTimer()` (`page.tsx:516`).

### Data Flow: every API call on a cold dashboard load, in order

1. **`GET /api/lawfirms/{id}`**: layout firm fetch. Exposed via `LawFirmContext` and seeds firm settings.
2. **`GET /api/lawfirms/{id}/members`**: `PermissionsContext` resolves the current member's permissions and `member` object.
3. **`GET /api/settings/user?lawFirmId={id}`**: `PreferencesContext` (dashboard widget layout + stat cards + theme).
4. **`GET /api/lawfirms/{id}/dashboard-summary`**: the aggregate read (`useDashboardSummary` → `dashboardService.getDashboardSummary`). The timezone travels in the `x-timezone` header (`requireTimezone` reads `req.tz`), deliberately NOT a query param so the dedup cache key stays stable.

**Net cold-load total:** **4** distinct backend GETs for a full-permission user. After first paint, the pending-signatures widget additionally maintains a realtime subscription (`useFirmSigningRealtime`) and a 5-minute fallback poll (`getPendingForUser`); these do not fire on cold load.

### Aggregate endpoint internals (`dashboard.service.ts`)

`getDashboardSummary({ lawFirmId, userId, member, timezone, getFirmPlan })`:

1. Membership is proven by `requirePermission('dashboard.view')` on the route, which refuses a non-member and a member of a firm pending deletion. The service does not query it again; it refuses with 403 only when no resolved `member` was passed.
2. Resolve per-section permission booleans from `member` (`:624-632`): `canMatters`, `canTasks`, `canMessaging`, `canMembers`, `canSignatures`, `canInvoices`, `canTimeEntries`, `canCalendar`, `canClients`, via `memberHasPermission` (`:106`). Owner ⇒ all true.
3. When `canMatters || canTasks || canCalendar`, decide owner/admin from the resolved `member` (`isResolvedMemberOwnerOrAdmin`, same rule as `isFirmOwnerOrAdmin`: owner, or holds `members.changeRole`) and resolve the visible matter-id set once through `visibleMatterIds` (`:144`): `ALL_MATTERS` for an owner or admin, otherwise the user's `matter_members` rows, `[]` on failure. `matterStats`, `taskStats` and the matter-events query reuse it.
4. Build section units, each wrapped in `runSection(name, fn)` with a weight. Each unit's `fn` resolves to a **patch object**; on throw it logs and resolves to `{ failed: true }`.

The section units:

| Section | Gate | Weight | Produces | file:line |
|---|---|---|---|---|
| `matters` | `canMatters` | 1 | `stats` (open/total/closed) + `recentMatters` (top 6) | `:697` |
| `taskStats` | `canTasks` | 1 | `stats` (pending/completed/total/upcomingDeadlines/overdueTasks) | `:723` |
| `upcomingTasks` | `canTasks` | 1 | `upcomingTasks` (today..+7, limit 15) | `:728` |
| `myAssignments` | `canTasks` | 2 | `myAssignments` (assigned non-completed tasks, limit 15 + total) | `:742` |
| `overdueTasks` | `canTasks` | 1 | `overdueTasks` (limit 15) | `:757` |
| `messaging` | `canMessaging` | 3 | `stats` (unread/conversationCount) + `recentConversations` (top 6) | `:769` |
| `members` | `canMembers` | 1 | `stats.teamSize` + `teamMembers` (roster IS the count) | `:791` |
| `signatures` | `canSignatures` + `documentSigning` feature | 1 | `pendingSignatures` (sessions where the user is an active participant) | `:812` |
| `financial` | `canInvoices` | 4 | `stats` (AR/overdue/collected/WIP) + `agingInvoices` (top 6) | `:852` |
| `upcomingPayments` | `canInvoices` | 1 | `upcomingPayments` (limit 10) | `:862` |
| `events` | `canCalendar` | 1 | `upcomingEvents` (matter + client events, next 7 days, limit 8) | `:872` |
| `myTime` | `canTimeEntries` | 2 | `stats` (hoursToday/hoursThisWeek) + `todayTimeEntries` (limit 10) | `:889` |

5. `runWithWeightedConcurrency(work, capacity)` (`:923`) returns what `Promise.allSettled` would; each non-failed patch merges into local accumulators and each failed section sets `sectionErrors[section] = true`.
6. Assemble the response with `?? null` for any stat whose section was skipped or failed, plus the list payloads, `sectionErrors`, and a `permissions` block (`matters`, `tasks`, `messaging`, `members`, `signatures`, `billing`, `timeEntries`, `calendar`, `clients`).

### Financial / calendar / time queries

All take the request timezone, so "today", "this week" and "this month" are the caller's, not the server's.

- **`financialAggregates(lawFirmId, tz)` (`:300`)**: (a) an invoices aggregate for `outstandingArCents`, `overdueInvoiceCents` and `overdueInvoiceCount`; (b) `collectedThisMonthCents` from `invoice_payments` joined back to `invoices`, where `payment_date` (a real `date` column) falls in the current month and the invoice is not voided (money that lands on a voided invoice is owed back to the payer, so the billing summary and the workbench leave it out of collected too); (c) unbilled work from `activities`: `time` entries and billable `expense`s and `flat_fee`s with no matching `invoice_line_items` row, returned as `unbilledWipCents` plus `unbilledHours`. Non-billable time is excluded, matching what the invoice builder will accept. The overdue and awaiting counts follow the billing workbench's rules: an invoice that owes nothing is in neither, a voided one is in neither, and non-billable time is counted as unbilled by no billing surface.
- **`agingInvoices(lawFirmId, limit, tz)` (`:385`)**: top-N overdue invoices with a client name coalesced from the invoice's own name, the client, the billing email, then the matter name.
- **`upcomingPayments(lawFirmId, limit, tz)` (`:418`)**: invoices coming due within `UPCOMING_PAYMENTS_DAYS = 30` (`:95`).
- **`timeStats(lawFirmId, userId, tz)` (`:460`)**: the user's `hoursToday` and `hoursThisWeek` (Monday-start) from `activities` of kind `time`, keyed on `activity_date`.
- **`todayTimeEntries(lawFirmId, userId, limit, tz)` (`:483`)**: the user's time entries dated today, with a matter/client context name.
- **`upcomingEvents(lawFirmId, matterIds, includeClients, limit)` (`:515`)**: rows from the shared `events` table. Matter events are inner-joined to `matters` and limited to the visible matter ids; when `canClients`, client events (`client_id is not null`) are added firm-wide. Both are filtered to `status <> 'cancelled'` and `date` within the next `UPCOMING_EVENTS_DAYS = 7` (`:98`), merged, date-ordered, and sliced to `limit`.

Money columns (`bigint`) and `numeric` hours come back as strings; the service coerces with `cents()` / `num()` (`:103-104`). Day-only `date` columns are returned as raw `'YYYY-MM-DD'` strings; `timestamptz` event dates as ISO.

### Data Model: what each widget reads

| Widget / element | Source field(s) | `page.tsx` |
|---|---|---|
| Hero banner | `summary.stats` (openMatters, pendingTasks, upcomingDeadlines, unreadMessages) | hero case |
| Stat cards (configurable, 17) | `summary.stats` via `statCardRegistry` (`:985`); money/hours formatted to strings | stats case |
| Recent Matters | `summary.recentMatters` | recentMatters case |
| Upcoming Tasks | `summary.upcomingTasks` grouped by day | upcomingTasks case |
| My Assignments | `summary.myAssignments` | myAssignments case |
| Overdue Tasks | `summary.overdueTasks` | `overdueItems` (`:1880`) |
| Messages | `summary.recentConversations` | messages case |
| Your Team | `summary.teamMembers` | team case |
| Pending Signatures | `summary.pendingSignatures` (seeded; realtime/poll refresh) | pendingSignatures case |
| Financial Snapshot | `summary.stats.*Cents` + `summary.agingInvoices` | `financial` (`:1656`) |
| Upcoming Payments | `summary.upcomingPayments` | `upcomingPayments` (`:1726`) |
| Upcoming Events | `summary.upcomingEvents` | `upcomingEvents` (`:1807`) |
| My Time | `summary.stats.hoursToday/hoursThisWeek` + `summary.todayTimeEntries` + `useBillingTimer()` | `myTime` (`:1932`) |
| Search bar | firm-wide matter / client / task lookups, not the summary | `useDashboardSearch` (`page.tsx:1011`, `hooks/dashboardHooks/useDashboardSearch.ts`) |

Stat card keys/defaults & widget keys/defaults: `frontend/src/types/preferences.ts` (`DashboardWidgetKey`, `StatCardKey`, `DEFAULT_DASHBOARD_WIDGETS`, `DEFAULT_STAT_CARDS`, label maps). Aggregate response contract: `frontend/src/services/dashboard.service.ts` (`DashboardStats`, `DashboardSummaryResponse`, `DashboardAgingInvoice`, `DashboardUpcomingEvent`, `DashboardTodayTimeEntry`, `DashboardSectionErrors`, `DashboardPermissions`).

### Key Logic & Rules

- **React Query for core data.** `useDashboardSummary` keys on `['dashboardSummary', lawFirmId]` and inherits the layout `staleTime`. `dataLoaded = !!summary` drives skeleton→content swaps; a `dashboardLoaded:{id}` `sessionStorage` flag means the full-page spinner only shows on a true cold load.
- **Permission gating is double-layered.** Frontend `hasPermission(...)` gates each widget's render (e.g. `financial` and `upcomingPayments` return `null` without `billing.viewInvoices`, `myTime` without `billing.viewTimeEntries`, `upcomingEvents` without `calendar.view`); the backend gates the route on `dashboard.view` plus per-section booleans.
- **Tenancy.** Every call is firm-scoped by `lawFirmId`; `requirePermission` on the route proves membership first, and every statement scopes by `law_firm_id`, with the shared visible-matter set (or `ALL_MATTERS` for owners/admins) for per-user visibility. Financial figures are firm-wide, not member-scoped: any `billing.viewInvoices` member sees the firm's full AR, mirroring the billing workbench.
- **Time handling.** The route includes `requireTimezone`, and the task, time and financial queries compute "today", "this week" and "this month" in that zone. The `upcomingTasks` list and `upcomingDeadlines` count share one 7-day window; the `overdueTasks` list and count share `due_date < today`. The "My Time" timer itself is client-side, surfaced through `BillingTimerProvider`.
- **Widget config & drag.** Drag-to-reorder buffers changes locally during drag and persists once on drag end via `updateDashboardPreferences`. Stat-card selection is capped at 6 (`page.tsx:564`, `:1165`).

### Dependencies

- **Backend service** imports the matters, tasks, messaging, users and signatures repositories, the shared `matterStatus` constants, `isResolvedMemberOwnerOrAdmin`, and `isFeatureEnabled` over the firm plan (for the `documentSigning` gate). The route passes `getFirmPlan`, the request-scoped `loadFirmPlanForRequest` the workspace billing gate already made, so the dashboard does not load the plan a second time. The financial, payments, events and time aggregates are Drizzle queries against `invoices`, `invoice_payments`, `invoice_line_items`, `activities`, `events`, `matters`, `clients` and `conversations`.
- **`tasks.repository.ts`** exports `findUpcomingForUser` (`:809`), `findOverdueForUser` (`:836`) and `UPCOMING_TASKS_DEFAULT_LIMIT` (`:94`).
- **Frontend page** services: `signatures.service`, `dashboard.service`, and the matter/client/task lookups behind `useDashboardSearch`. Contexts: `PreferencesContext`, `PermissionsContext`, `LawFirmContext`, `NavigationContext`, `BillingTimerContext`, `useAuth`. Libs: `@dnd-kit/core` + `@dnd-kit/sortable`, `useFirmSigningRealtime`, `@tanstack/react-query`, `lucide-react`.

### Example

`GET /api/lawfirms/abc/dashboard-summary` (header `x-timezone: America/New_York`) for a firm owner returns:

```json
{
  "stats": {
    "openMatters": 12, "totalMatters": 40, "closedMatters": 28,
    "pendingTasks": 9, "completedTasks": 31, "totalTasks": 40,
    "upcomingDeadlines": 3, "overdueTasks": 2,
    "unreadMessages": 5, "conversationCount": 14, "teamSize": 6,
    "outstandingArCents": 1875000, "overdueInvoiceCents": 420000, "overdueInvoiceCount": 3,
    "collectedThisMonthCents": 960000, "unbilledWipCents": 530000, "unbilledHours": 12.5,
    "hoursToday": 3.5, "hoursThisWeek": 18
  },
  "recentMatters": [ { "id": "...", "name": "...", "status": "active", "updatedAt": "..." } ],
  "upcomingTasks": [ { "id": "...", "title": "...", "dueDate": "2026-06-15", "priority": "high" } ],
  "myAssignments": { "tasks": [ ... ], "totalTasks": 4 },
  "overdueTasks": [ { "id": "...", "title": "...", "dueDate": "2026-06-09", "priority": "urgent" } ],
  "recentConversations": [ { "conversationId": "...", "clientName": "...", "unreadCountFirm": 2 } ],
  "teamMembers": [ { "uid": "...", "name": "...", "role": "attorney" } ],
  "pendingSignatures": [ ... ],
  "agingInvoices": [ { "id": "...", "invoiceNumber": "INV-014", "clientName": "...", "balanceDueCents": 150000, "dueDate": "2026-05-20", "daysOverdue": 23 } ],
  "upcomingPayments": [ { "id": "...", "invoiceNumber": "INV-019", "balanceDueCents": 90000, "dueDate": "2026-06-30", "status": "sent" } ],
  "upcomingEvents": [ { "id": "...", "source": "matter", "title": "Motion hearing", "type": "hearing", "date": "2026-06-16T14:00:00.000Z", "matterName": "..." } ],
  "todayTimeEntries": [ { "id": "...", "hours": 1.5, "description": "Drafting", "contextName": "Smith v. Jones", "entryDate": "2026-06-12" } ],
  "sectionErrors": {},
  "permissions": { "matters": true, "tasks": true, "messaging": true, "members": true, "signatures": true, "billing": true, "timeEntries": true, "calendar": true, "clients": true }
}
```

If the **financial** section throws at runtime, the client sees the `*Cents` stats as `null`, `agingInvoices: []`, `permissions.billing: true`, **and `sectionErrors.financial: true`**, which the `financial` widget uses to show a retry state. A permission-*denied* member instead gets the same nulls with `permissions.billing: false` and no `sectionErrors` key.

---

## What Can Be Improved

Resolved since the last pass and dropped: malformed payment dates silently dropping out of `collectedThisMonth` (`invoice_payments.payment_date` is a real `date` column now); the search bar only scanning what the page had loaded (it now runs firm-wide matter, client and task lookups, `hooks/dashboardHooks/useDashboardSearch.ts:48`); and an unscoped WIP figure that counted non-billable and already-invoiced work (now billable-only with an `invoice_line_items` anti-join, `dashboard.service.ts:300`).

1. **Unbilled WIP is a floor, not the true figure.** `financialAggregates` (`dashboard.service.ts:300`) sums `activities.amount_cents`, and a time entry whose rate resolves dynamically (charge code, matter member, client or firm default) contributes its full hours but no dollars. The widget mitigates this by also showing `unbilledHours`. An exact figure would need each unbilled entry's rate resolved per load, which was deliberately avoided to keep the dashboard cheap.

2. **Financial figures are firm-wide and recomputed every load.** The invoice aggregate scans all of the firm's invoices, and `collectedThisMonth` joins `invoice_payments → invoices` on every dashboard load (`:300`). A maintained counter or a cached monthly rollup would cap it for firms with many invoices.

3. **`conversationCount` runs an unbounded `count(*)`** over `conversations` with only the tenant predicate (`:240-244`), a firm-partition scan each load. `teamSize` does not: it is the roster length.

4. **Client events in the Upcoming Events widget are firm-wide.** Matter events are scoped to the user's visible matters, but client events (`client_id is not null`) are included for any member with `calendar.view` + `clients.view` regardless of association (`upcomingEvents`, `:546-566`). That matches the client events listing, but is broader than the matter-event scoping beside it.

5. **The closed/terminal status classification is hand-maintained.** The DB CHECK now pins the status vocabulary (`db/schema/30_matters.sql:68`), but which statuses count as closed or terminal lives in `shared/constants/matterStatus.ts` and must be kept in step with the frontend `matterStatusConfig` (`page.tsx`) by hand.

6. **`sectionErrors` coverage is broad but not total.** The page has distinct failure flags for `matters`, `upcomingTasks`, `myAssignments`, `messaging`, `members`, `signatures`, `overdueTasks`, `financial`, `upcomingPayments`, `events` and `myTime` (`page.tsx:956-966`). The `taskStats` section (stat-card numbers) still falls back to zeros with no distinct failure UI.

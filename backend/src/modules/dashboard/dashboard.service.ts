/**
 * Dashboard summary service (Postgres).
 *
 * Aggregates everything the firm dashboard page renders into a SINGLE response so
 * the page can stop firing ~9-11 separate GETs (full task list, full matter list,
 * conversations, unread count, my-assignments, team) and computing stat-card
 * numbers in the browser via `.filter().length`.
 *
 * Counts are computed in SQL with `count(*) filter (where ...)`; the top-N lists
 * reuse the existing matters/tasks/messaging repositories (with small limits) so
 * the per-row shape is byte-identical to the individual endpoints the page used
 * to call.
 *
 * VISIBILITY SCOPING: mirrors the individual endpoints exactly so this endpoint
 * never leaks data the user could not already see:
 *   - matters  : only matters the user is a `matter_members` member of
 *              (matches matters.repository.listMattersPaged with seeAll false)
 *   - tasks  : firm-scoped tasks (matter_id is null) OR tasks on a matter the user is
 *              a member of (matches tasks.repository.findVisibleToUser)
 *   - my-assignments : tasks assigned to the user (task_assignees, non-completed)
 *              (matches tasks.service.getMyAssignments)
 *   - messaging : all firm conversations + firm unread count (firm members all
 *              see the firm's conversations, matches messaging.repository)
 *   - team   : firm member roster (matches users.repository.getLawFirmMembers);
 *              teamSize is derived from its length
 *   - signatures : pending/in-progress signing sessions where the acting user is
 *              an ACTIVE participant (matches signatureLinks pending-for-user)
 *
 * PERMISSION SCOPING: the route gates on `dashboard.view`, but each SECTION is
 * additionally gated on the corresponding view permission resolved for the
 * member (matters.view / tasks.view / messaging.view / members.view). A member who
 * can open the dashboard but lacks (say) messaging.view gets `messaging: null`
 * rather than firm conversation data.
 */

import { and, asc, count, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import {
  clients,
  conversations,
  activities,
  invoicePayments,
  invoices,
  events,
  matterMembers,
  matters,
  tasks,
} from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
const { DASHBOARD_CONNECTION_CAPACITY } = require('../../shared/database/connectionBudget');
const { runWithWeightedConcurrency } = require('../../shared/utils/runWithConcurrency');
const { isResolvedMemberOwnerOrAdmin } = require('../../shared/utils/membership');
const {
  CLOSED_MATTER_STATUSES,
} = require('../../shared/constants/matterStatus');
const mattersRepo = require('../matters/matters.repository');
const tasksRepo = require('../tasks/tasks.repository');
const msgRepo = require('../messaging/messaging.repository');
const usersRepo = require('../users/users.repository');
const signaturesRepo = require('../signatures/signatures.repository');
const { loadFirmPlan } = require('../../shared/plans/planEnforcement');
const { ForbiddenError } = require('../../shared/errors/AppError');
const { isFeatureEnabled } = require('../../shared/plans/featureCheck');

// The heaviest single section's connection weight (the "financial" section: see
// getDashboardSummary below) -- asserted against the pool at import time so a
// budget too small to ever run that section fails a deploy instead of surfacing
// as a permanent "Couldn't load" on that one widget.
const MAX_SECTION_WEIGHT = 4;
if (DASHBOARD_CONNECTION_CAPACITY < MAX_SECTION_WEIGHT) {
  throw new Error(
    `[dashboard.service] DASHBOARD_CONNECTION_CAPACITY is ${DASHBOARD_CONNECTION_CAPACITY}, below the `
    + `heaviest section's own weight of ${MAX_SECTION_WEIGHT} -- that section could never be admitted. `
    + 'Raise PG_POOL_MAX, lower PG_POOL_RESERVE, or lower MAX_INSTANCES.'
  );
}

const RECENT_MATTERS_LIMIT = 6;
// The compact "Upcoming Tasks" widget shows 6 (`page.tsx` `.slice(0, 6)`) and
// search uses at most 5; the desktop grouped-by-day view renders the whole
// 7-day window with no overall cap. 15 keeps comfortable headroom for a busy
// week's grouped view while trimming the heaviest per-row TASK_SELECT JOIN cost
// from the former 25-row cap.
//
// Sourced from the tasks repo's own default so the dashboard cap and the repo's
// `findUpcomingForUser` default cannot drift apart (single source of truth).
const UPCOMING_TASKS_LIMIT = tasksRepo.UPCOMING_TASKS_DEFAULT_LIMIT;
const RECENT_CONVERSATIONS_LIMIT = 6;
const MY_ASSIGNMENTS_LIMIT = 15;
// Top-N caps for the financial / calendar / overdue / time widgets.
const AGING_INVOICES_LIMIT = 6;
const UPCOMING_PAYMENTS_LIMIT = 10;
const UPCOMING_EVENTS_LIMIT = 8;
const OVERDUE_TASKS_LIMIT = 15;
const TODAY_TIME_ENTRIES_LIMIT = 10;
// Window (days ahead) for the "Upcoming Payments" widget.
const UPCOMING_PAYMENTS_DAYS = 30;
// Window (days) for the "Upcoming Events" widget. Mirrors the tasks widget's
// today..+7 horizon so both surface the same week.
const UPCOMING_EVENTS_DAYS = 7;

const { rowIso: iso } = require('../../shared/utils/dateConversion');
// bigint columns come back from node-pg as strings; coerce cent sums to a Number
// (firm-scale cent totals stay well within Number's safe-integer range).
const cents = (v: any) => (v == null ? 0 : Number(v));
const num = (v: any) => (v == null ? 0 : Number(v));

function memberHasPermission(member: any, permission: any) {
  if (!member) return false;
  if (member.isOwner) return true;
  // Fail-closed: a non-owner member whose `resolvedPermissions` was never
  // populated resolves every section to `false` and silently blanks the
  // dashboard. That is the intended (safe) outcome, but if it happens because
  // an upstream change to how `requirePermission` attaches `req.member` dropped
  // `resolvedPermissions`, the dashboard would go blank with no signal. Log
  // it once per request to surface the regression instead of failing silently.
  if (!Array.isArray(member.resolvedPermissions)) {
    if (!member._dashboardPermsWarned) {
      member._dashboardPermsWarned = true;
      console.warn(
        'dashboard.service: req.member present but resolvedPermissions missing/invalid; ' +
          'all dashboard sections will fail-closed (empty). member shape may have changed.'
      );
    }
    return false;
  }
  return member.resolvedPermissions.includes(permission);
}

/**
 * The set of matter ids in this firm the user can see (is a `matter_members`
 * member of). Computed ONCE and reused by the dashboard's own stat queries
 * (matterStats / taskStats) instead of each re-running the same
 * `exists (select 1 from matter_members ...)` correlated probe. Result is
 * identical: `c.id = any(ids)` ≡ the per-row exists test.
 *
 * Returns `ALL_MATTERS` (null) for owners/admins rather than a list. They see
 * every firm matter, so materializing the ids would mean selecting the firm's
 * whole `matters` table and binding it straight back as a `uuid[]` on every
 * dashboard load — the array grows with the firm while saying nothing the
 * consumers don't already know from `seeAll`. Each consumer drops its matter
 * predicate instead; see `scopeToMatters`.
 */
const ALL_MATTERS = null;

async function visibleMatterIds(lawFirmId: string, userId: string, seeAll = false) {
  // Owners/admins see every firm matter (so their matter/task/calendar dashboard
  // sections match the firm-wide matters list); regular members stay scoped to
  // matters they belong to (the ethical wall).
  if (seeAll) return ALL_MATTERS;
  const rows = await tenantQuery(matterMembers, lawFirmId, ({ executor, scope }) => executor
    .select({ matterId: matterMembers.matterId }).from(matterMembers)
    .innerJoin(matters, and(eq(matters.id, matterMembers.matterId), eq(matters.lawFirmId, matterMembers.lawFirmId)))
    .where(and(scope, eq(matterMembers.userId, userId))));
  return rows.map((r: any) => r.matterId);
}

/**
 * Whether a matter-scoped read may skip its matter predicate entirely.
 *
 * `ALL_MATTERS` means "no restriction" — the predicate would be satisfied by
 * every row, so omitting it is equivalent and costs nothing to send. An empty
 * array is the opposite: the user can see no matters, and the predicate must
 * stay so the read returns nothing.
 */
const seesAllMatters = (matterIds: string[]) => matterIds === ALL_MATTERS;

/**
 * Matter stat aggregates, scoped to matters the user is a member of.
 * "open" mirrors the dashboard's `status === 'active'` stat card; "closed"
 * mirrors `status === 'completed' || status === 'closed'`.
 */
async function matterStats(lawFirmId: string, matterIds: string[]) {
  const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor.select({
    total: count(),
    open: sql<number>`count(*) filter (where ${matters.status} = 'active')::int`,
    closed: sql<number>`count(*) filter (where ${inArray(matters.status, CLOSED_MATTER_STATUSES)})::int`,
  }).from(matters).where(and(scope, inArray(matters.id, matterIds))));
  const r = rows[0] || {};
  return { openMatters: r.open || 0, totalMatters: r.total || 0, closedMatters: r.closed || 0 };
}

/**
 * Firm-wide matter stat aggregates for owners/admins (same buckets as
 * matterStats, no membership filter), so the dashboard matter counts match the
 * firm-wide matters list they already see. Regular members keep matterStats.
 */
async function firmMatterStats(lawFirmId: string) {
  const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor.select({
    total: count(),
    open: sql<number>`count(*) filter (where ${matters.status} = 'active')::int`,
    closed: sql<number>`count(*) filter (where ${inArray(matters.status, CLOSED_MATTER_STATUSES)})::int`,
  }).from(matters).where(scope));
  const r = rows[0] || {};
  return { openMatters: r.open || 0, totalMatters: r.total || 0, closedMatters: r.closed || 0 };
}

/**
 * Task stat aggregates, scoped to tasks visible to the user (firm-scoped or
 * matter-member). Mirrors the dashboard's stat cards:
 *   pending          -> status in ('open','in_progress')
 *   completed        -> status = 'completed'
 *   total            -> all visible
 *   upcomingDeadlines-> non-completed, due within today..+7 days (inclusive)
 */
async function taskStats(lawFirmId: string, matterIds: string[], tz: any) {
  const zone = tz || 'UTC';
  // An owner/admin sees every firm task, so the membership predicate is dropped
  // rather than satisfied with a list of every matter id in the firm.
  const scoped = !seesAllMatters(matterIds);
  const rows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => {
    const filters = [scope];
    // sql.param, not a bare interpolation: Drizzle expands an inlined JS array
    // into a parameter list -- `any(($5, $6, ...))` -- which Postgres reads as a
    // record and rejects with "cannot cast type record to uuid[]".
    if (scoped) filters.push(sql`(${tasks.matterId} is null or ${tasks.matterId} = any(${sql.param(matterIds)}::uuid[]))`);
    return executor.select({
       total: count(),
       pending: sql<number>`count(*) filter (where ${tasks.status} in ('open','in_progress'))::int`,
       completed: sql<number>`count(*) filter (where ${tasks.status} = 'completed')::int`,
       upcoming: sql<number>`
       count(*) filter (
         where ${tasks.status} <> 'completed' and ${tasks.dueDate} is not null
           and ${tasks.dueDate} >= (now() at time zone ${zone})::date
           and ${tasks.dueDate} <= (now() at time zone ${zone})::date + 7)::int`,
       overdue: sql<number>`count(*) filter (
         where ${tasks.status} <> 'completed' and ${tasks.dueDate} is not null
           and ${tasks.dueDate} < (now() at time zone ${zone})::date)::int`,
    }).from(tasks).where(and(...filters));
  });
  const r = rows[0] || {};
  return {
    pendingTasks: r.pending || 0,
    completedTasks: r.completed || 0,
    totalTasks: r.total || 0,
    upcomingDeadlines: r.upcoming || 0,
    overdueTasks: r.overdue || 0,
  };
}

/** Conversation count for the firm. */
async function conversationCount(lawFirmId: string) {
  const [row] = await tenantQuery(conversations as any, lawFirmId, ({ executor, scope }) => executor
    .select({ total: count() }).from(conversations).where(scope));
  return row?.total || 0;
}

/** Lightweight task projection for the top-N upcoming/assignment lists. */
function slimTask(t: any) {
  return {
    id: t.id,
    taskId: t.id,
    matterId: t.matterId || null,
    matterName: t.matterName || null,
    title: t.title,
    status: t.status,
    priority: t.priority || 'medium',
    dueDate: t.dueDate || null,
    assignedTo: t.assignedTo || [],
    assignedToName: t.assignedToName || [],
    clientIds: t.clientIds || [],
    clientNames: t.clientNames || [],
    updatedAt: t.updatedAt || null,
    createdAt: t.createdAt || null,
  };
}

/** Lightweight matter projection for the recentMatters list. */
function slimMatter(c: any) {
  return {
    id: c.id,
    matterId: c.id,
    name: c.name,
    matterReferenceId: c.matterReferenceId || null,
    matterNumber: c.matterNumber || null,
    status: c.status,
    clients: (c.clientNames || []).map((name: any) => ({ name })),
    clientNames: c.clientNames || [],
    updatedAt: c.updatedAt || null,
    createdAt: c.createdAt || null,
  };
}

/**
 * Firm-wide financial aggregates for the "Financial Snapshot" widget, all in
 * integer cents. Scoped only by `law_firm_id` (invoices/payments are firm-level,
 * not matter-member scoped. They mirror the billing workbench, which any
 * `billing.viewInvoices` member can already open).
 *
 *   outstandingAr: sum of positive `balance_due_cents` across all non-voided invoices
 *                    (leans on the partial `invoices_outstanding_idx`).
 *   overdue: count + summed balance of unpaid invoices past `due_date`.
 *   collectedMonth: payments recorded this calendar month on invoices that are
 *                    not voided (joined back to invoices so payments with a null
 *                    `law_firm_id` are still firm-scoped).
 *   unbilledWip: LIGHTWEIGHT: explicit-rate time-entry amounts + unbilled
 *                    flat fees + unbilled billable expenses. Per the schema note
 *                    on `activities.amount_cents`, entries that resolve their
 *                    rate dynamically contribute 0 here, so the time portion is a
 *                    floor; `unbilledHours` conveys the full unbilled volume.
 */
/**
 * An invoice past due in `zone`, as SQL: billing's `isPastDue` rule (not
 * voided, a balance left, not marked paid, and its next payment date, else its
 * due date, before today). The dashboard read the due date alone and kept
 * voided invoices, so it disagreed with the billing screens about what is late.
 */
function pastDueSql(zone: string) {
  return sql`(${invoices.status} <> 'voided' and ${invoices.balanceDueCents} > 0 and ${invoices.isPaid} = false
    and coalesce(${invoices.nextPaymentDate}, ${invoices.dueDate}) is not null
    and coalesce(${invoices.nextPaymentDate}, ${invoices.dueDate}) < (now() at time zone ${zone})::date)`;
}

async function financialAggregates(lawFirmId: string, tz: any) {
  const zone = tz || 'UTC';
  const [invoiceAgg, collected, wip] = await Promise.all([
    tenantQuery(invoices, lawFirmId, ({ executor, scope }) => executor.select({
      outstandingCents: sql<number>`coalesce(sum(${invoices.balanceDueCents}) filter (where ${invoices.balanceDueCents} > 0 and ${invoices.status} <> 'voided'), 0)`,
      overdueCents: sql<number>`coalesce(sum(${invoices.balanceDueCents}) filter (where ${pastDueSql(zone)}), 0)`,
      overdueCount: sql<number>`count(*) filter (where ${pastDueSql(zone)})::int`,
    }).from(invoices).where(scope)),
    tenantQuery(invoices, lawFirmId, ({ executor, scope }) => executor.select({
      collectedCents: sql<number>`coalesce(sum(${invoicePayments.amountCents}), 0)`,
    }).from(invoices).innerJoin(invoicePayments, eq(invoicePayments.invoiceId, invoices.id)).where(and(
      scope,
      // Money that arrived on a voided invoice is owed back to the payer, so it
      // is not collected revenue; billing analytics and the workbench leave it
      // out the same way.
      sql`${invoices.status} <> 'voided'`,
      // `payment_date` is a real `date` column (migration 0196). It used to be
      // text holding either 'YYYY-MM-DD' or a full ISO string, which is why
      // this filter carried a regex guard and a to_date(left(...)) wrapper: a
      // row the regex did not match would have raised on the cast. Neither is
      // needed now, and dropping them lets the plain column index serve this.
      sql`${invoicePayments.paymentDate} is not null`,
      sql`${invoicePayments.paymentDate} >= date_trunc('month', (now() at time zone ${zone})::date)::date`,
      sql`${invoicePayments.paymentDate} < (date_trunc('month', (now() at time zone ${zone})::date) + interval '1 month')::date`,
    ))),
    tenantQuery(activities, lawFirmId, ({ executor, scope }) => executor.select({
      teCents: sql<number>`coalesce(sum(${activities.amountCents}), 0)`,
      teHours: sql<number>`coalesce(sum(${activities.hours}), 0)`,
      // "Unbilled" is the anti-join every other reader uses: no line item on any
      // of this firm's invoices names the row as its source. Migration 0228
      // dropped the `billed` / `is_billed` flags these three legs used to filter
      // on, which nothing ever set, so this figure counted billed work as work in
      // progress for as long as the flags existed.
      //
      // Written with explicit aliases rather than `${flatFees.id}`: inside a
      // single-table select Drizzle renders a column reference UNQUALIFIED, so
      // `${flatFees.id}` in the nested subquery became `"id"` and resolved to
      // the line item's own id, which made the anti-join compare a row to
      // itself and exclude nothing.
      ffCents: sql<number>`(select coalesce(sum(ff.amount_cents), 0) from activities ff
        where ff.kind = 'flat_fee' and ff.law_firm_id = ${lawFirmId}
          and not exists (select 1 from invoice_line_items li
                            join invoices i on i.law_firm_id = li.law_firm_id and i.id = li.invoice_id
                           where li.law_firm_id = ff.law_firm_id
                             and li.kind = 'flat_fee' and li.source_id = ff.id::text
                             and i.status <> 'voided'))`,
      exCents: sql<number>`(select coalesce(sum(ex.amount_cents), 0) from activities ex
        where ex.kind = 'expense' and ex.law_firm_id = ${lawFirmId} and ex.billable = true
          and not exists (select 1 from invoice_line_items li
                            join invoices i on i.law_firm_id = li.law_firm_id and i.id = li.invoice_id
                           where li.law_firm_id = ex.law_firm_id
                             and li.kind = 'expense' and li.source_id = ex.id::text
                             and i.status <> 'voided'))`,
      // `billable` as well as `billed`, matching the expenses leg above. They are
      // different questions: `billed` means already on an invoice, `billable`
      // means invoiceable at all. Without this, pro bono and written-off time
      // counted as work in progress, which put this figure at odds with the rest
      // of the app: `firmBilling.service` already filters `billable !== false`
      // for the workbench's own unbilled total, and `invoices.service` THROWS if
      // a non-billable entry reaches an invoice. The dashboard was reporting
      // money the invoice builder refuses to bill.
      //
      // The column is `not null default true`, so the equality is exact. It
      // corrects `unbilledWipCents` and `unbilledHours` together, and hours is
      // where a firm notices first, since an entry with a null rate contributes
      // no dollars but its full hours.
    }).from(activities).where(and(
      scope,
      eq(activities.kind, 'time'),
      sql`not exists (select 1 from invoice_line_items li
                        join invoices i on i.law_firm_id = li.law_firm_id and i.id = li.invoice_id
                       where li.law_firm_id = ${activities.lawFirmId}
                         and li.kind = 'time_entry' and li.source_id = ${activities.id}::text
                         and i.status <> 'voided')`,
      eq(activities.billable, true),
    ))),
  ]);

  const inv = invoiceAgg[0] || {};
  const w = wip[0] || {};
  return {
    outstandingArCents: cents(inv.outstandingCents),
    overdueInvoiceCents: cents(inv.overdueCents),
    overdueInvoiceCount: inv.overdueCount || 0,
    collectedThisMonthCents: cents(collected[0]?.collectedCents),
    unbilledWipCents: cents(w.teCents) + cents(w.ffCents) + cents(w.exCents),
    unbilledHours: num(w.teHours),
  };
}

/** Top-N overdue invoices (oldest due first) with client name + days overdue. */
async function agingInvoices(lawFirmId: string, limit: any, tz: any) {
  const zone = tz || 'UTC';
  const rows = await tenantQuery(invoices, lawFirmId, ({ executor, scope }) => executor.select({
    id: invoices.id,
    invoiceNumber: invoices.invoiceNumber,
    balanceDueCents: invoices.balanceDueCents,
    dueDate: sql<string>`coalesce(${invoices.nextPaymentDate}, ${invoices.dueDate})`,
    daysOverdue: sql<number>`((now() at time zone ${zone})::date - coalesce(${invoices.nextPaymentDate}, ${invoices.dueDate}))::int`,
    clientName: sql<string>`coalesce(nullif(${invoices.clientName}, ''), ${clients.name}, ${invoices.billingEmail}, ${matters.name})`,
  }).from(invoices).leftJoin(clients, eq(clients.id, invoices.clientContextId))
    .leftJoin(matters, eq(matters.id, invoices.matterId)).where(and(
      scope,
      pastDueSql(zone),
    )).orderBy(asc(sql`coalesce(${invoices.nextPaymentDate}, ${invoices.dueDate})`)).limit(limit));
  return rows.map((r: any) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber || null,
    clientName: r.clientName || 'Unknown client',
    balanceDueCents: cents(r.balanceDueCents),
    dueDate: r.dueDate || null,
    daysOverdue: r.daysOverdue || 0,
  }));
}

/**
 * Invoices with outstanding balances that are overdue or due within the next
 * `UPCOMING_PAYMENTS_DAYS` days, ordered by due_date ascending (oldest overdue
 * first, soonest upcoming last within the window). Used by the "Upcoming
 * Payments" dashboard widget.
 */
async function upcomingPayments(lawFirmId: string, limit: any, tz: any) {
  const zone = tz || 'UTC';
  const rows = await tenantQuery(invoices, lawFirmId, ({ executor, scope }) => executor.select({
    id: invoices.id,
    invoiceNumber: invoices.invoiceNumber,
    balanceDueCents: invoices.balanceDueCents,
    totalCents: invoices.totalCents,
    amountPaidCents: invoices.amountPaidCents,
    totalWrittenOffCents: invoices.totalWrittenOffCents,
    status: invoices.status,
    invoiceDate: invoices.invoiceDate,
    // The next amount due is the plan's next instalment when there is one.
    dueDate: sql<string>`coalesce(${invoices.nextPaymentDate}, ${invoices.dueDate})`,
    matterId: invoices.matterId,
    clientContextId: invoices.clientContextId,
    daysRelative: sql<number>`((now() at time zone ${zone})::date - coalesce(${invoices.nextPaymentDate}, ${invoices.dueDate}))::int`,
    clientName: sql<string>`coalesce(nullif(${invoices.clientName}, ''), ${clients.name}, ${invoices.billingEmail}, ${matters.name})`,
  }).from(invoices).leftJoin(clients, eq(clients.id, invoices.clientContextId))
    .leftJoin(matters, eq(matters.id, invoices.matterId)).where(and(
      scope,
      sql`${invoices.status} <> 'voided'`,
      sql`${invoices.balanceDueCents} > 0`,
      eq(invoices.isPaid, false),
      sql`coalesce(${invoices.nextPaymentDate}, ${invoices.dueDate}) is not null`,
      sql`coalesce(${invoices.nextPaymentDate}, ${invoices.dueDate}) <= (now() at time zone ${zone})::date + ${UPCOMING_PAYMENTS_DAYS}::int`,
    )).orderBy(asc(sql`coalesce(${invoices.nextPaymentDate}, ${invoices.dueDate})`)).limit(limit));
  return rows.map((r: any) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber || null,
    clientName: r.clientName || 'Unknown client',
    balanceDueCents: cents(r.balanceDueCents),
    totalCents: cents(r.totalCents),
    amountPaidCents: cents(r.amountPaidCents),
    totalWrittenOffCents: cents(r.totalWrittenOffCents),
    status: r.status || null,
    invoiceDate: r.invoiceDate || null,
    dueDate: r.dueDate || null,
    daysRelative: r.daysRelative || 0,
    // Navigation context for the dashboard widget's detail modal: matter-scoped
    // invoices link to the matter, client-context invoices to the client.
    contextType: r.matterId ? 'matter' : 'client',
    entityId: r.matterId || r.clientContextId || null,
  }));
}

/** Hours the acting user logged today and so-far this week (week starts Monday). */
async function timeStats(lawFirmId: string, userId: string, tz: any) {
  const zone = tz || 'UTC';
  const rows = await tenantQuery(activities, lawFirmId, ({ executor, scope }) => executor.select({
    todayHours: sql<number>`coalesce(sum(${activities.hours}) filter (
      where ${activities.activityDate} = (now() at time zone ${zone})::date), 0)`,
    // Bounded at BOTH ends. With only the lower bound, an entry dated next
    // month counted toward "this week": the figure read high and nothing on
    // screen explained why. `collectedThisMonth` above is the pattern to match.
    weekHours: sql<number>`coalesce(sum(${activities.hours}) filter (
      where ${activities.activityDate} >= date_trunc('week', (now() at time zone ${zone})::date)::date
        and ${activities.activityDate} < (date_trunc('week', (now() at time zone ${zone})::date) + interval '1 week')::date), 0)`,
  }).from(activities).where(and(
    scope,
    eq(activities.kind, 'time'),
    eq(activities.userId, userId),
    sql`${activities.activityDate} >= date_trunc('week', (now() at time zone ${zone})::date)::date`,
    sql`${activities.activityDate} < (date_trunc('week', (now() at time zone ${zone})::date) + interval '1 week')::date`,
  )));
  const r = rows[0] || {};
  return { hoursToday: num(r.todayHours), hoursThisWeek: num(r.weekHours) };
}

/** The acting user's time entries logged today (for the "My Time" widget list). */
async function todayTimeEntries(lawFirmId: string, userId: string, limit: any, tz: any) {
  const zone = tz || 'UTC';
  const rows = await tenantQuery(activities, lawFirmId, ({ executor, scope }) => executor.select({
    id: activities.id,
    hours: activities.hours,
    description: activities.description,
    entryDate: activities.activityDate,
    contextName: sql<string>`coalesce(${matters.name}, ${clients.name})`,
  }).from(activities).leftJoin(matters, eq(matters.id, activities.matterId))
    .leftJoin(clients, eq(clients.id, activities.clientId)).where(and(
      scope,
      eq(activities.kind, 'time'),
      eq(activities.userId, userId),
      sql`${activities.activityDate} = (now() at time zone ${zone})::date`,
    )).orderBy(desc(activities.createdAt)).limit(limit));
  return rows.map((r: any) => ({
    id: r.id,
    hours: num(r.hours),
    description: r.description || '',
    contextName: r.contextName || null,
    entryDate: r.entryDate || null,
  }));
}

/**
 * Upcoming matter + client events in the next `UPCOMING_EVENTS_DAYS` days, merged
 * and date-ordered. Matter events are scoped to the user's visible matter ids
 * (membership = authorization), or unscoped for an owner/admin who sees every
 * matter; standalone client events are firm-wide and only included when
 * `includeClients` (the member has `clients.view`). Cancelled events are
 * excluded.
 */
async function upcomingEvents(lawFirmId: string, matterIds: string[], includeClients: any, limit: any, timezone: string) {
  // A timed event is upcoming until it starts. An all-day event is upcoming for
  // its whole day: its day (the UTC day of its noon anchor) on or after the
  // viewer's today. Holding it to "not started yet" dropped it at noon UTC,
  // partway through its own day for every zone.
  const notOver = sql`((${events.allDay} and (${events.date} at time zone 'UTC')::date >= (now() at time zone ${timezone})::date)
    or (not ${events.allDay} and ${events.date} >= now()))`;
  // Same shape as taskStats: unrestricted for owners/admins (predicate dropped),
  // restricted to the member's matters otherwise, and nothing at all when they
  // belong to none.
  const unrestricted = seesAllMatters(matterIds);
  const matterEventQuery = async () => {
    if (!unrestricted && matterIds.length === 0) return [];
    return tenantQuery(events, lawFirmId, ({ executor, scope }) => {
      const filters = [
        scope,
        ne(events.status, 'cancelled'),
        sql`${events.date} is not null`,
        notOver,
        sql`${events.date} < now() + make_interval(days => ${UPCOMING_EVENTS_DAYS})`,
      ];
      if (!unrestricted) filters.push(inArray(events.matterId, matterIds));
      return executor.select({
        id: events.id,
        title: events.title,
        type: events.type,
        date: events.date,
        allDay: events.allDay,
        locationName: events.locationName,
        matterId: events.matterId,
        matterName: matters.name,
      }).from(events).innerJoin(matters, eq(matters.id, events.matterId))
        .where(and(...filters)).orderBy(asc(events.date)).limit(limit);
    });
  };

  const queries = [
    matterEventQuery(),
    includeClients
      ? tenantQuery(events, lawFirmId, ({ executor, scope }) => executor.select({
          id: events.id,
          title: events.title,
          type: events.type,
          date: events.date,
          allDay: events.allDay,
          locationName: events.locationName,
          clientId: events.clientId,
          clientName: clients.name,
        }).from(events).leftJoin(clients, eq(clients.id, events.clientId)).where(and(
          // Matter and client events share a table since migration 0205. The
          // join to `clients` is LEFT, so it does not narrow; without this every
          // matter event would arrive in the client column. The matter query
          // above needs no equivalent because its join to `matters` is INNER.
          isNotNull(events.clientId),
          scope,
          ne(events.status, 'cancelled'),
          sql`${events.date} is not null`,
          notOver,
          sql`${events.date} < now() + make_interval(days => ${UPCOMING_EVENTS_DAYS})`,
        )).orderBy(asc(events.date)).limit(limit))
      : Promise.resolve([]),
  ];

  const [matterRes, clientRes] = await Promise.all(queries);
  const merged = [
    ...matterRes.map((r: any) => ({
      id: r.id,
      source: 'matter',
      title: r.title,
      type: r.type || null,
      date: iso(r.date),
      allDay: r.allDay === true,
      locationName: r.locationName || null,
      matterId: r.matterId,
      matterName: r.matterName || null,
      clientId: null,
      clientName: null,
    })),
    ...clientRes.map((r: any) => ({
      id: r.id,
      source: 'client',
      title: r.title,
      type: r.type || null,
      date: iso(r.date),
      allDay: r.allDay === true,
      locationName: r.locationName || null,
      matterId: null,
      matterName: null,
      clientId: r.clientId,
      clientName: r.clientName || null,
    })),
  ];
  merged.sort((a, b) => {
    const at = a.date ? new Date(a.date).getTime() : Infinity;
    const bt = b.date ? new Date(b.date).getTime() : Infinity;
    return at - bt;
  });
  return merged.slice(0, limit);
}

/**
 * Build the full dashboard summary in one round trip.
 *
 * @param {object} args
 * @param {string} args.lawFirmId
 * @param {string} args.userId       acting user (req.user.uid)
 * @param {object} args.member       the member `requirePermission` resolved for this firm
 *                                   and user (req.member). It is the membership proof,
 *                                   and it drives per-section gating and the
 *                                   firm-wide versus matter-scoped decision
 * @param {string} args.timezone     req.tz (timezone-aware display)
 * @param {Function} [args.getFirmPlan] loads the firm plan; the route passes the
 *                                   request-scoped load the billing gate already made
 */
export async function getDashboardSummary({ lawFirmId, userId, member, timezone, getFirmPlan }: any) {
  // Membership was proven by `requirePermission` on the route, which refuses a
  // non-member and a member of a firm pending deletion before this runs, so it
  // is not queried a second time. Without a resolved member there is no proof
  // at all, so refuse with the answer a non-member gets.
  if (!member) {
    throw new ForbiddenError('Law Firm does not exist or user is not a member of this law firm');
  }

  // Day-based windows (today / this week / this month / overdue) roll over at
  // the VIEWER's local midnight, not the server's (Cloud Run is UTC). Every
  // helper that buckets by calendar day binds this zone as a query param and
  // computes `(now() at time zone $N)::date`. Defaulting to 'UTC' reproduces the
  // server-tz behavior when the request carries no timezone.
  const tz = timezone || 'UTC';

  const canMatters = memberHasPermission(member, 'matters.view');
  const canTasks = memberHasPermission(member, 'tasks.view');
  const canMessaging = memberHasPermission(member, 'messaging.view');
  const canMembers = memberHasPermission(member, 'members.view');
  const canSignatures = memberHasPermission(member, 'signatures.view');
  const canInvoices = memberHasPermission(member, 'billing.viewInvoices');
  const canTimeEntries = memberHasPermission(member, 'billing.viewTimeEntries');
  const canCalendar = memberHasPermission(member, 'calendar.view');
  const canClients = memberHasPermission(member, 'clients.view');

  // Fire the independent section queries concurrently.
  //
  // PER-SECTION ERROR ISOLATION: every section unit is wrapped in `runSection`,
  // which RETURNS a `{ section, patch, failed }` result rather than mutating
  // shared closure state. On success the section's `fn` resolves to a `patch`
  // object that the assembler merges after `Promise.allSettled`; on failure the
  // unit catches + LOGS and resolves to `{ failed: true }` (no patch), so the
  // section keeps its fallback (empty list / null / absent stat). Because each
  // unit is the sole producer of its own patch and merging happens AFTER all
  // units settle, isolation is structural. A future section that writes an
  // overlapping `stats` key can no longer interleave non-deterministically with
  // another unit. A failed section also records a `sectionErrors` flag so the
  // client can distinguish a transient fetch failure ("couldn't load, retry")
  // from a genuinely empty/permission-gated section.
  const work = [];
  const runSection = (name: any, fn: any) =>
    Promise.resolve()
      .then(fn)
      .then((patch: any) => ({ section: name, patch: patch || {}, failed: false }))
      .catch((err) => {
        console.error(`dashboard.service: section "${name}" failed; returning empty fallback:`, err);
        return { section: name, patch: {}, failed: true };
      });

  // The user's visible matter-id set is needed by BOTH the matter and task stat
  // aggregates; probe `matter_members` once here and reuse it instead of having
  // each aggregate re-run its own correlated `exists (...)` subquery.
  // Owners/admins see firm-wide matters, tasks, and calendar on the dashboard
  // (matching the firm-wide matters list), which `visibleMatterIds` reports as
  // ALL_MATTERS rather than by listing the firm's every matter id; regular
  // members stay membership-scoped.
  // Owner/admin is read off the member `requirePermission` resolved, so it costs
  // no query. It stays a promise because the sections and the visible-matter-id
  // probe below already chain off it.
  const seeAllMattersPromise = Promise.resolve(
    (canMatters || canTasks || canCalendar) && isResolvedMemberOwnerOrAdmin(member),
  );

  // The failure fallback is the RESTRICTIVE end of the scale (an empty array, not
  // ALL_MATTERS): a probe that failed knows nothing about what this user may see,
  // so the matters/tasks sections render empty rather than firm-wide.
  // Started eagerly, and it must STAY eager: several sections await it, so if it
  // were queued as a thunk behind the concurrency limit it could sit waiting for
  // a slot that only frees when one of those very sections completes. That is a
  // deadlock, not a slowdown. It is one probe shared by all of them, so it costs
  // one connection regardless.
  const matterIdsPromise: Promise<any> =
    canMatters || canTasks || canCalendar
      ? seeAllMattersPromise.then((seeAll: any) => visibleMatterIds(lawFirmId, userId, seeAll)).catch((err: any) => {
          console.error('dashboard.service: visibleMatterIds probe failed; treating as empty set:', err);
          return [];
        })
      : Promise.resolve([]);

  if (canMatters) {
    work.push({ weight: 1, run: () => runSection('matters', async () => {
      // Owners/admins see firm-wide matter counts + recent matters, matching the
      // firm-wide matters list they already get; regular members stay scoped to
      // their matters (the ethical wall). `firmMatterStats` is the unscoped
      // variant rather than `matterStats` over every id, for the same reason
      // ALL_MATTERS exists: the id list would be the whole `matters` table.
      const seeAllMatters = await seeAllMattersPromise;
      const cs = seeAllMatters
        ? await firmMatterStats(lawFirmId)
        : await matterStats(lawFirmId, await matterIdsPromise);
      // Reuse the matters repo's enriched read, ordered by `updated_at desc`
      // directly in SQL so the candidate set is the actually most-recently-updated
      // matters. The previous approach fetched the 6 most-recently-CREATED and
      // re-sorted that page by updatedAt, so an older matter that was just updated
      // never entered the candidate set and was missed by this widget.
      const { matters: list } = await mattersRepo.listMattersPaged(lawFirmId, userId, {
        seeAll: seeAllMatters,
        limit: RECENT_MATTERS_LIMIT,
        sortBy: 'updatedAt',
        order: 'desc',
      });
      return { stats: cs, recentMatters: list.map(slimMatter) };
    }) });
  }

  if (canTasks) {
    work.push({ weight: 1, run: () => runSection('taskStats', async () => {
      const ts = await taskStats(lawFirmId, await matterIdsPromise, tz);
      return { stats: ts };
    }) });

    work.push({ weight: 1, run: () => runSection('upcomingTasks', async () => {
      // Visible-to-user, non-completed tasks due within today..+7 days, ordered
      // by due_date and capped. The 7-day predicate + ORDER BY + LIMIT are all
      // pushed into SQL. The window uses the SAME viewer-tz `today .. today + 7`
      // bounds (computed as `(now() at time zone $tz)::date`) as taskStats'
      // `upcomingDeadlines` count so the list and the count agree at timezone
      // edges.
      const upcoming = await tasksRepo.findUpcomingForUser(lawFirmId, userId, UPCOMING_TASKS_LIMIT, tz);
      return { upcomingTasks: upcoming.map(slimTask) };
    }) });

    // Weight 2: the assignee list and the total count run as a simultaneous
    // `Promise.all`, so this section holds two pool connections at its peak,
    // not one.
    work.push({ weight: 2, run: () => runSection('myAssignments', async () => {
      // My assignments: assigned non-completed tasks (already ordered due_date asc
      // nulls last by the repo). Same shape as tasks.service.getMyAssignments.
      const [assignedTasks, totalAssigned] = await Promise.all([
        tasksRepo.findAssignedToUser(lawFirmId, userId, { limit: MY_ASSIGNMENTS_LIMIT }),
        tasksRepo.countAssignedToUser(lawFirmId, userId),
      ]);
      return {
        myAssignments: {
          tasks: assignedTasks.map(slimTask),
          totalTasks: totalAssigned,
        },
      };
    }) });

    work.push({ weight: 1, run: () => runSection('overdueTasks', async () => {
      // Visible-to-user, non-completed tasks already past their due date. Uses
      // the same viewer-tz `today` boundary (`(now() at time zone $tz)::date`)
      // as taskStats' `overdueTasks` count so the list and the count agree.
      const overdue = await tasksRepo.findOverdueForUser(lawFirmId, userId, OVERDUE_TASKS_LIMIT, tz);
      return { overdueTasks: overdue.map(slimTask) };
    }) });
  }

  if (canMessaging) {
    // Weight 3: conversations + unread count + conversation count all run as
    // one simultaneous `Promise.all`.
    work.push({ weight: 3, run: () => runSection('messaging', async () => {
      const [{ conversations: convos }, unread, convCount] = await Promise.all([
        msgRepo.getConversationsByLawFirm(lawFirmId, { limit: RECENT_CONVERSATIONS_LIMIT }),
        msgRepo.getFirmUnreadCount(lawFirmId),
        conversationCount(lawFirmId),
      ]);
      return {
        stats: { unreadMessages: unread, conversationCount: convCount },
        recentConversations: convos.map((c: any) => ({
          conversationId: c.conversationId,
          clientId: c.clientId,
          clientName: c.clientName,
          clientEmail: c.clientEmail || '',
          lastMessageAt: c.lastMessageAt,
          lastMessagePreview: c.lastMessagePreview || '',
          unreadCountFirm: c.unreadCountFirm || 0,
        })),
      };
    }) });
  }

  if (canMembers) {
    work.push({ weight: 1, run: () => runSection('members', async () => {
      // Fold the team roster into the aggregate so the dashboard's "Your Team"
      // widget no longer fires its own `GET /lawfirm/:id/users`. The roster
      // rows ARE the team count, so derive teamSize from the same fetch instead
      // of running a separate `count(*)` over members.
      const team = await usersRepo.getLawFirmMembers(lawFirmId);
      return { stats: { teamSize: team.length }, teamMembers: team };
    }) });
  }

  // The signatures section is plan-gated as well as permission-gated. It mirrors
  // `GET /signature-links/pending-for-user`, which sits behind
  // `requireFeature('documentSigning')` and answers 403 without it, so a firm on
  // a plan that excludes signing must not keep receiving signing sessions here
  // (a firm that downgraded off Professional otherwise kept seeing the sessions
  // it opened on the old plan). Loaded only when the permission already passed,
  // so the plan read costs nothing for members who would not get the section.
  const signingEnabled = canSignatures
    && isFeatureEnabled(await (getFirmPlan ? getFirmPlan() : loadFirmPlan(lawFirmId)), 'documentSigning');

  if (signingEnabled) {
    work.push({ weight: 1, run: () => runSection('signatures', async () => {
      // Fold the "needs my signature" list into the aggregate so the dashboard's
      // "Pending Signatures" widget no longer fires its own
      // `GET /signature-links/pending-for-user`. Mirrors that route's logic:
      // pending/in-progress sessions where the acting user is an ACTIVE
      // participant — the repository applies that test in SQL, so this widget
      // cannot lose a session behind a firm-wide cap. Realtime + the fallback
      // poll still refresh it after load.
      const sessions = await signaturesRepo.listPendingOrInProgressForUser(lawFirmId, userId);
      const pending = [];
      for (const data of sessions) {
        const mine = (data.participants || []).find(
          (p: any) => p.memberUserId === userId && p.status === 'active'
        );
        if (!mine) continue;
        pending.push({
          sessionToken: data.token,
          fileName: data.fileName,
          routingMode: data.routingMode || 'sequential',
          createdAt: iso(data.createdAt),
          participantId: mine.participantId,
          participantRole: mine.roleLabel,
          publicToken: mine.publicToken || null,
          totalParticipants: (data.participants || []).length,
          completedParticipants: (data.participants || []).filter((p: any) => p.status === 'completed').length,
        });
      }
      pending.sort((a, b) => {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bt - at;
      });
      return { pendingSignatures: pending };
    }) });
  }

  if (canInvoices) {
    // Weight 4: `financialAggregates` is itself a 3-way `Promise.all`, run
    // simultaneously with `aging` here -- this section peaks at 4 connections,
    // the heaviest of the fan-out.
    work.push({ weight: 4, run: () => runSection('financial', async () => {
      // Firm-wide AR / overdue / collections / unbilled-WIP figures plus the
      // top-N aging invoice list, for the "Financial Snapshot" widget.
      const [agg, aging] = await Promise.all([
        financialAggregates(lawFirmId, tz),
        agingInvoices(lawFirmId, AGING_INVOICES_LIMIT, tz),
      ]);
      return { stats: agg, agingInvoices: aging };
    }) });

    work.push({ weight: 1, run: () => runSection('upcomingPayments', async () => {
      // Overdue + due-soon invoices for the "Upcoming Payments" widget.
      // Returns invoices with outstanding balances due within the next
      // UPCOMING_PAYMENTS_DAYS days or already overdue, sorted by due_date asc.
      const payments = await upcomingPayments(lawFirmId, UPCOMING_PAYMENTS_LIMIT, tz);
      return { upcomingPayments: payments };
    }) });
  }

  if (canCalendar) {
    // Weight 2: `upcomingEvents` runs the matter-event and client-event reads as
    // one simultaneous `Promise.all`.
    work.push({ weight: 2, run: () => runSection('events', async () => {
      // Upcoming matter events (court dates/hearings, scoped to the user's matters)
      // plus standalone client events (only when the member has clients.view),
      // merged and date-ordered for the "Upcoming Events" widget.
      const events = await upcomingEvents(
        lawFirmId,
        await matterIdsPromise,
        canClients,
        UPCOMING_EVENTS_LIMIT,
        timezone,
      );
      return { upcomingEvents: events };
    }) });
  }

  if (canTimeEntries) {
    // Weight 2: today's stats and today's entries run as a simultaneous
    // `Promise.all`.
    work.push({ weight: 2, run: () => runSection('myTime', async () => {
      // Hours the acting user logged today / this week, plus today's entries.
      // for the "My Time" widget (the start/stop timer itself is client-side).
      const [ts, today] = await Promise.all([
        timeStats(lawFirmId, userId, tz),
        todayTimeEntries(lawFirmId, userId, TODAY_TIME_ENTRIES_LIMIT, tz),
      ]);
      return { stats: ts, todayTimeEntries: today };
    }) });
  }

  // allSettled (paired with runSection's per-unit catch) guarantees the request
  // resolves even if an individual section threw. Each settled result carries
  // its own `{ patch, failed }`; we merge the patches into local accumulators
  // here. AFTER all units have settled, so no section ever mutates another
  // section's slot mid-flight (isolation is structural, not incidental).
  //
  // Admitted by summed connection WEIGHT, not by section count: some sections
  // above run their own internal `Promise.all` of 2-4 simultaneous queries
  // (financial peaks at 4, messaging at 3), so a limiter that only counted
  // "sections" could admit several heavy ones together and put more
  // connections in flight than the pool actually has -- which is exactly what
  // used to surface as a random widget's "Couldn't load, retry" under
  // concurrent traffic, not only on a cold start. `DASHBOARD_CONNECTION_CAPACITY`
  // is derived from the connection budget, never hardcoded here -- a fan-out
  // sized against the wrong pool is how this defect returns. One connection of
  // that capacity is reserved for the `seeAllMattersPromise`/`matterIdsPromise`
  // probes above, which run outside this batch and can briefly overlap its start.
  //
  // `runWithWeightedConcurrency` returns exactly what `Promise.allSettled` would,
  // in input order, so the merge loop below is unchanged and per-section error
  // isolation still works the same way.
  const probeReserve = (canMatters || canTasks || canCalendar) ? 1 : 0;
  const capacity = Math.max(1, DASHBOARD_CONNECTION_CAPACITY - probeReserve);
  const settled = await runWithWeightedConcurrency(work, capacity);

  const stats: Record<string, any> = {};
  let recentMatters = [];
  let upcomingTasks = [];
  let myAssignments = null;
  let recentConversations = [];
  let teamMembers = [];
  let pendingSignatures = [];
  let overdueTasks = [];
  let agingInvoicesList = [];
  let upcomingPaymentsList = [];
  let upcomingEventsList = [];
  let todayTimeEntriesList = [];
  // sectionErrors: a section whose permission WAS granted (so it ran) but whose
  // fetch FAILED at runtime. Lets the client distinguish a transient failure
  // ("couldn't load, retry") from a permitted-but-empty section. The previous
  // shape made those two matters byte-identical. Permission-gated sections never
  // run, so they never appear here.
  const sectionErrors: Record<string, any> = {};

  for (const r of settled) {
    // runSection always resolves (its own catch), so settled entries are
    // 'fulfilled'; guard defensively regardless.
    if (r.status !== 'fulfilled' || !r.value) continue;
    const { section, patch, failed } = r.value;
    if (failed) {
      sectionErrors[section] = true;
      continue;
    }
    if (patch.stats) Object.assign(stats, patch.stats);
    if (patch.recentMatters) recentMatters = patch.recentMatters;
    if (patch.upcomingTasks) upcomingTasks = patch.upcomingTasks;
    if (patch.myAssignments) myAssignments = patch.myAssignments;
    if (patch.recentConversations) recentConversations = patch.recentConversations;
    if (patch.teamMembers) teamMembers = patch.teamMembers;
    if (patch.pendingSignatures) pendingSignatures = patch.pendingSignatures;
    if (patch.overdueTasks) overdueTasks = patch.overdueTasks;
    if (patch.agingInvoices) agingInvoicesList = patch.agingInvoices;
    if (patch.upcomingPayments) upcomingPaymentsList = patch.upcomingPayments;
    if (patch.upcomingEvents) upcomingEventsList = patch.upcomingEvents;
    if (patch.todayTimeEntries) todayTimeEntriesList = patch.todayTimeEntries;
  }

  return {
    stats: {
      // matters
      openMatters: stats.openMatters ?? null,
      totalMatters: stats.totalMatters ?? null,
      closedMatters: stats.closedMatters ?? null,
      // tasks
      pendingTasks: stats.pendingTasks ?? null,
      completedTasks: stats.completedTasks ?? null,
      totalTasks: stats.totalTasks ?? null,
      upcomingDeadlines: stats.upcomingDeadlines ?? null,
      overdueTasks: stats.overdueTasks ?? null,
      // messaging
      unreadMessages: stats.unreadMessages ?? null,
      conversationCount: stats.conversationCount ?? null,
      // team
      teamSize: stats.teamSize ?? null,
      // financial (integer cents; null when the member lacks billing.viewInvoices)
      outstandingArCents: stats.outstandingArCents ?? null,
      overdueInvoiceCents: stats.overdueInvoiceCents ?? null,
      overdueInvoiceCount: stats.overdueInvoiceCount ?? null,
      collectedThisMonthCents: stats.collectedThisMonthCents ?? null,
      unbilledWipCents: stats.unbilledWipCents ?? null,
      unbilledHours: stats.unbilledHours ?? null,
      // my time (acting user; null when the member lacks billing.viewTimeEntries)
      hoursToday: stats.hoursToday ?? null,
      hoursThisWeek: stats.hoursThisWeek ?? null,
    },
    recentMatters,
    upcomingTasks,
    myAssignments,
    overdueTasks,
    recentConversations,
    // Team roster + pending signatures folded into the aggregate so the page no
    // longer issues `GET /lawfirm/:id/users` and the signatures pending-for-user
    // GET on cold load. Empty arrays when the section is permission-gated or
    // failed at runtime (see sectionErrors).
    teamMembers,
    pendingSignatures,
    // Financial / calendar / time widget payloads. Empty arrays when the section
    // is permission-gated or failed at runtime (see sectionErrors).
    agingInvoices: agingInvoicesList,
    upcomingPayments: upcomingPaymentsList,
    upcomingEvents: upcomingEventsList,
    todayTimeEntries: todayTimeEntriesList,
    // Additive, optional field: keys present only for sections that were
    // attempted (permitted) but failed at runtime. An empty object means every
    // attempted section succeeded. Existing fields above are unchanged.
    sectionErrors,
    permissions: {
      matters: canMatters,
      tasks: canTasks,
      messaging: canMessaging,
      members: canMembers,
      signatures: canSignatures,
      billing: canInvoices,
      timeEntries: canTimeEntries,
      calendar: canCalendar,
      clients: canClients,
    },
  };
}

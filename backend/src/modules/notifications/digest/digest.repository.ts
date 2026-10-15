/**
 * Windowed reads for the daily digest.
 *
 * Every query takes the recipient's local day window as 'YYYY-MM-DD' strings and
 * their IANA zone, so day bucketing happens in the recipient's own calendar
 * rather than UTC. Day-only columns (`tasks.due_date`, `invoices.due_date`,
 * `matters.statute_of_limitations_date`) compare directly; `events.date`
 * is a timestamptz and is projected into the recipient's zone before comparison.
 *
 * Visibility rule, consistent across entity types: an item assigned to the
 * recipient is theirs; an item with no assignee at all falls back to the matter
 * team. That keeps orphaned work visible without drowning a partner on 40
 * matters in everyone else's assignments.
 */

import { and, asc, eq, lt, ne, sql } from 'drizzle-orm';
import {
  digestSends,
  invoices,
  events,
  matters,
  members,
  tasks,
} from '../../../shared/database/drizzle/schema';
import { systemQuery, tenantQuery } from '../../../shared/database/queryContext';
import {
  scopedDelete,
  scopedInsertOnConflictDoNothing,
} from '../../../shared/database/scopedWrite';
const { isUuid } = require('../../../shared/utils/isUuid');

/**
 * Highest-priority-first ordering. `priority` is a text column with an
 * app-managed vocabulary, so a plain `order by priority desc` would sort
 * alphabetically (urgent, medium, low, high) rather than by severity.
 */
const PRIORITY_RANK = sql<number>`
  case ${tasks.priority}
    when 'urgent' then 4
    when 'high'   then 3
    when 'medium' then 2
    when 'low'    then 1
    else 0
  end`;

/** Event types whose deadlines are unrecoverable if missed. */
const CRITICAL_EVENT_TYPES = ['court_date', 'statute_of_limitations'];

/**
 * How far back the overdue bucket reaches, in days before the recipient's today.
 *
 * A daily digest is for work someone can still act on today. Something a month
 * past due needs a cleanup sweep, not a daily nag the recipient has already
 * learned to scroll past. The floor also protects the row limits: ordering is
 * oldest-first, so without it a firm carrying a long tail of abandoned work
 * would spend its entire digest on the same ancient rows every morning while
 * genuinely recent overdue items never surfaced.
 */
export const DIGEST_OVERDUE_FLOOR_DAYS = 30;

/** Every member of a firm. Returns a plain array of user ids. */
export async function listFirmMemberIds(lawFirmId: string) {
  if (!isUuid(lawFirmId)) return [];
  const rows = await tenantQuery(members, lawFirmId, ({ executor, scope }) => executor
    .select({ userId: members.userId }).from(members).where(scope));
  return rows.map((r: any) => r.userId).filter(Boolean);
}

/**
 * Reserve today's digest for one recipient. THIS is the idempotency mechanism.
 *
 * The digest cron fires hourly because recipients choose a delivery hour in
 * their own timezone, so the same recipient is evaluated many times per day.
 * The `(law_firm_id, user_id, sent_on)` primary key turns "have we already sent
 * today?" into an atomic insert: only the caller that gets a row back may send.
 * A double-fire, an overlapping run, and a manual re-trigger therefore cannot
 * produce a second email, with no advisory lock or read-then-write race.
 *
 * Claim BEFORE sending, not after — a claim made after the send would leave a
 * window in which a concurrent run sends a duplicate.
 *
 * @param {string} sentOn recipient's LOCAL date, 'YYYY-MM-DD'
 * @returns {Promise<boolean>} true when this caller owns the send
 */
export async function claimDigestSend(lawFirmId: string, userId: string, sentOn: any, itemCount = 0) {
  if (!isUuid(lawFirmId) || !userId || !sentOn) return false;
  const rows = await scopedInsertOnConflictDoNothing(digestSends, lawFirmId, {
    userId,
    sentOn,
    itemCount: Number.isFinite(itemCount) ? itemCount : 0,
  }, [digestSends.lawFirmId, digestSends.userId, digestSends.sentOn]);
  return rows.length > 0;
}

/**
 * Drop a claim whose send failed, so the next hourly run retries the recipient
 * instead of silently skipping them for the rest of their local day.
 *
 * Errors are swallowed: this runs on the failure path, and a failure to release
 * must not mask the send error the caller is already handling. The cost of a
 * lost release is one missed digest, not a duplicate.
 */
export async function releaseDigestSend(lawFirmId: string, userId: string, sentOn: any) {
  if (!isUuid(lawFirmId) || !userId || !sentOn) return;
  try {
    await scopedDelete(digestSends, lawFirmId, and(
      eq(digestSends.userId, userId),
      eq(digestSends.sentOn, sentOn),
    )!);
  } catch (err: any) {
    console.error(`[digest] Failed to release send claim for ${lawFirmId}/${userId} on ${sentOn}:`, err.message);
  }
}

/**
 * Drop claim rows older than `keepDays`. They only exist to answer "already sent
 * today?", so anything past the retention horizon is dead weight.
 *
 * @returns {Promise<number>} rows removed
 */
export async function purgeOldDigestSends(keepDays = 30) {
  const days = Number.isFinite(Number(keepDays)) ? Math.max(0, Math.trunc(Number(keepDays))) : 30;
  const rows = await systemQuery('scheduler', (executor) => executor.delete(digestSends)
    .where(lt(digestSends.sentOn, sql`current_date - ${days}::int`))
    .returning({ userId: digestSends.userId }));
  return rows.length;
}

/**
 * Open tasks the recipient should see, due between the overdue floor and
 * `windowEnd`.
 *
 * The lower bound sits at `DIGEST_OVERDUE_FLOOR_DAYS` before the recipient's
 * today, NOT at today itself: a `due_date` earlier than today is exactly what
 * fills the overdue bucket, and clipping to today would hide the work the
 * digest exists to surface. The floor only drops items too stale to act on.
 *
 * `task_assignees` carries no `law_firm_id`, so tenant scoping comes from the
 * `tasks` row it hangs off.
 */
export async function findDigestTasks(lawFirmId: string, userId: string, today: any, windowEnd: any) {
  if (!isUuid(lawFirmId) || !userId || !today || !windowEnd) return [];
  const rows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor.select({
    id: tasks.id,
    title: tasks.title,
    dueDate: tasks.dueDate,
    priority: tasks.priority,
    matterId: tasks.matterId,
    matterName: matters.name,
  }).from(tasks).leftJoin(matters, and(
    eq(matters.lawFirmId, tasks.lawFirmId),
    eq(matters.id, tasks.matterId),
  )).where(and(
    scope,
    ne(tasks.status, 'completed'),
    sql`${tasks.dueDate} is not null`,
    sql`${tasks.dueDate} >= (${today}::date - ${DIGEST_OVERDUE_FLOOR_DAYS}::int)`,
    sql`${tasks.dueDate} <= ${windowEnd}::date`,
    sql`(
          exists (
            select 1 from task_assignees ta where ta.task_id = ${tasks.id} and ta.user_id = ${userId}
          )
          or (
            not exists (select 1 from task_assignees ta where ta.task_id = ${tasks.id})
            and (
              ${tasks.matterId} is null
              or exists (
                select 1 from matter_members mm where mm.law_firm_id = ${tasks.lawFirmId}
                  and mm.matter_id = ${tasks.matterId} and mm.user_id = ${userId}
              )
            )
          )
        )`,
  )).orderBy(asc(tasks.dueDate), sql`${PRIORITY_RANK} desc`).limit(200));

  return rows.map((r: any) => ({
    kind: 'task',
    id: r.id,
    title: r.title,
    day: r.dueDate,
    priority: r.priority || null,
    matterId: r.matterId || null,
    matterName: r.matterName || null,
  }));
}

/**
 * Upcoming matter events landing inside the recipient's local window.
 *
 * `events.date` is a timestamptz, so it is projected into the
 * recipient's zone before the day comparison — an 8pm Pacific hearing must not
 * bucket as tomorrow because it is already tomorrow in UTC. Unlike tasks this
 * DOES take a lower bound: a hearing that has already happened is history, not
 * an overdue deadline.
 *
 * Assignment lives in a jsonb array rather than a junction table, so the
 * assigned/unassigned fallback is expressed with containment. The type check
 * guarding `jsonb_array_length` is load-bearing: that function raises on any
 * non-array input, so a single malformed `assigned_to` would abort the digest
 * for every recipient in the firm. A value that cannot be read as a list of
 * assignees falls back to matter-team visibility, same as an empty one.
 */
export async function findDigestEvents(lawFirmId: string, userId: string, today: any, windowEnd: any, timezone = 'UTC') {
  if (!isUuid(lawFirmId) || !userId || !today || !windowEnd) return [];
  // The day an event falls on for the recipient. A timed event is read in their
  // zone. An all-day one is stored at its day's noon-UTC anchor, which is its UTC
  // day everywhere; read in the recipient's zone it moved to the next day at
  // UTC+12 and beyond.
  const eventDay = sql`(case when ${events.allDay} then (${events.date} at time zone 'UTC')::date
                             else (${events.date} at time zone ${timezone})::date end)`;
  const rows = await tenantQuery(events, lawFirmId, ({ executor, scope }) => executor.select({
    id: events.id,
    title: events.title,
    type: events.type,
    date: events.date,
    allDay: events.allDay,
    matterId: events.matterId,
    matterName: matters.name,
    localDay: sql<string>`${eventDay}::text`,
  }).from(events).innerJoin(matters, and(
    eq(matters.lawFirmId, events.lawFirmId),
    eq(matters.id, events.matterId),
  )).where(and(
    scope,
    eq(events.status, 'upcoming'),
    sql`${events.date} is not null`,
    sql`${eventDay} between ${today}::date and ${windowEnd}::date`,
    // An event with assignees is for those people; one with none falls back to
    // the matter's members. Both halves are index-served now: the containment
    // test this replaced could use no index at all (migration 0218).
    sql`(
          case when exists (select 1 from event_assignees ea
                             where ea.law_firm_id = ${events.lawFirmId}
                               and ea.event_id = ${events.id})
               then exists (select 1 from event_assignees ea
                             where ea.law_firm_id = ${events.lawFirmId}
                               and ea.event_id = ${events.id}
                               and ea.user_id = ${userId})
               else exists (
                 select 1 from matter_members mm
                  where mm.law_firm_id = ${events.lawFirmId}
                    and mm.matter_id = ${events.matterId}
                    and mm.user_id = ${userId}
               )
          end
        )`,
  )).orderBy(asc(events.date)).limit(200));

  return rows.map((r: any) => ({
    kind: 'event',
    id: r.id,
    title: r.title,
    day: r.localDay,
    at: r.date,
    allDay: r.allDay === true,
    eventType: r.type || null,
    critical: CRITICAL_EVENT_TYPES.includes(r.type),
    matterId: r.matterId || null,
    matterName: r.matterName || null,
  }));
}

/**
 * Outstanding invoices due on or before `windowEnd`, firm-wide.
 *
 * Not scoped to a recipient: invoices belong to the firm's books rather than to
 * a matter team, so the caller gates this on a billing permission instead.
 *
 * "Outstanding" is unpaid, not voided, with a positive balance. Every such
 * invoice counts, emailed or not, since an invoice is delivered once it is
 * visible in the client portal. `balance_due_cents` is generated from
 * total/paid/written-off, which also excludes fully written-off invoices.
 *
 * Like tasks, the lower bound is the overdue floor rather than today, so
 * already-overdue invoices still appear until they age out.
 *
 * `today` is taken rather than derived from `windowEnd` so the floor means the
 * same span here as it does for tasks. Deriving it would anchor the floor to
 * the end of the digest window instead of the current day, making the two
 * finders silently disagree about how far back "overdue" reaches — and drift
 * further apart if the window length ever changes.
 */
export async function findDigestInvoices(lawFirmId: string, today: any, windowEnd: any) {
  if (!isUuid(lawFirmId) || !today || !windowEnd) return [];
  // The day a payment is next expected: a payment plan keeps `next_payment_date`
  // on its next unpaid installment while `due_date` is the plan's last one, the
  // same precedence the billing workbench uses.
  const payDay = sql`coalesce(${invoices.nextPaymentDate}, ${invoices.dueDate})`;
  const rows = await tenantQuery(invoices, lawFirmId, ({ executor, scope }) => executor.select({
    id: invoices.id,
    invoiceNumber: invoices.invoiceNumber,
    payDay: sql<string>`${payDay}`,
    balanceDueCents: invoices.balanceDueCents,
    matterId: invoices.matterId,
    clientContextId: invoices.clientContextId,
    clientName: invoices.clientName,
    matterName: matters.name,
  }).from(invoices).leftJoin(matters, and(
    eq(matters.lawFirmId, invoices.lawFirmId),
    eq(matters.id, invoices.matterId),
  )).where(and(
    scope,
    eq(invoices.isPaid, false),
    ne(invoices.status, 'voided'),
    sql`${invoices.balanceDueCents} > 0`,
    sql`${payDay} is not null`,
    sql`${payDay} >= (${today}::date - ${DIGEST_OVERDUE_FLOOR_DAYS}::int)`,
    sql`${payDay} <= ${windowEnd}::date`,
  )).orderBy(asc(payDay)).limit(200));

  return rows.map((r: any) => ({
    kind: 'invoice',
    id: r.id,
    title: `Invoice ${r.invoiceNumber}`,
    day: r.payDay,
    amountCents: Number(r.balanceDueCents) || 0,
    matterId: r.matterId || null,
    clientContextId: r.clientContextId || null,
    // Client-context invoices have no matter, so the denormalized client name is
    // the only label available for them.
    matterName: r.matterName || r.clientName || null,
  }));
}

/**
 * Statute-of-limitations dates on the recipient's open matters.
 *
 * A missed statute date is the one deadline in the product that cannot be
 * recovered from, which is why these are always marked critical and are read
 * separately from ordinary matter events.
 *
 * Openness is decided by `close_date is null` rather than by a `status`
 * allow-list: `matters.status` has eight values whose "terminal" set is a
 * product decision that changes, while a null close date is unambiguous.
 *
 * Scoped to matters the recipient is actually on — there is no unassigned
 * fallback here because a matter always has a team.
 *
 * A statute date that has already passed on a matter that is still open is a
 * claim the firm may no longer be able to bring: it means either the filing
 * happened and the matter's date was never cleared, or the deadline was missed.
 * Both are real conditions worth surfacing, and neither is resolved by an email.
 * So this takes the SAME `DIGEST_OVERDUE_FLOOR_DAYS` lower bound as tasks and
 * invoices: a passed statute leads the digest for a month, which is long enough
 * for anyone who will act on it to act, and then stops. Without a floor the row
 * would reappear every single morning for as long as the matter stayed open —
 * and because critical items are never truncated, one stale matter from years
 * ago would head the digest forever and train the recipient to ignore the block
 * that exists precisely because it must never be ignored.
 */
export async function findDigestStatuteDates(lawFirmId: string, userId: string, today: any, windowEnd: any) {
  if (!isUuid(lawFirmId) || !userId || !today || !windowEnd) return [];
  const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor.select({
    id: matters.id,
    name: matters.name,
    statuteDate: matters.statuteOfLimitationsDate,
  }).from(matters).where(and(
    scope,
    sql`${matters.statuteOfLimitationsDate} is not null`,
    sql`${matters.statuteOfLimitationsDate} >= (${today}::date - ${DIGEST_OVERDUE_FLOOR_DAYS}::int)`,
    sql`${matters.statuteOfLimitationsDate} <= ${windowEnd}::date`,
    sql`${matters.closeDate} is null`,
    sql`exists (
          select 1 from matter_members mm
           where mm.law_firm_id = ${matters.lawFirmId}
             and mm.matter_id = ${matters.id}
             and mm.user_id = ${userId}
        )`,
  )).orderBy(asc(matters.statuteOfLimitationsDate)).limit(50));

  return rows.map((r: any) => ({
    kind: 'statute',
    id: r.id,
    title: 'Statute of limitations',
    day: r.statuteDate,
    critical: true,
    matterId: r.id,
    matterName: r.name || null,
  }));
}

const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
const { dayAnchor } = require('../../shared/utils/time');

import { and, asc, desc, eq, inArray, ne, notInArray, sql, isNull} from 'drizzle-orm';
import {
  clientCompanyLinks,
  clients,
  conflictCheckRecords,
  courts,
  invoices,
  lawFirms,
  matterMembers,
  matterClients,
  notes,
  matters,
  members,
  practiceAreas,
  tasks,
  users,
  legalHolds,
} from '../../shared/database/drizzle/schema';
import {
  firmQuery,
  rootQueryExecutor,
  systemQuery,
  tenantAliasedQuery,
  tenantParameterizedQuery,
  tenantQuery,
  withDrizzleTransaction,
} from '../../shared/database/queryContext';
import {
  scopedDelete,
  scopedInsert,
  scopedInsertMany,
  scopedInsertManyOnConflictDoNothing,
  scopedUpdate,
  setColumn,
  type InsertValues,
  type UpdateValues,
  type WritableColumn,
} from '../../shared/database/scopedWrite';

type MatterUpdate = UpdateValues<typeof matters>;
type MatterColumn = WritableColumn<typeof matters>;
type TaskColumn = WritableColumn<typeof tasks>;

/** Attachment objects deleted at once. Network-bound GCS calls. */
const ATTACHMENT_DELETE_CONCURRENCY = Number(process.env.ATTACHMENT_DELETE_CONCURRENCY) || 16;
'use strict';

/**
 * Matters repository (Postgres).
 *
 * The legacy Firestore matter document was heavily denormalized: it embedded a
 * `members[]` array (with name + totalHours snapshots), `memberUserIds[]`,
 * `clientNames[]` / `clientUserIds[]` / `clientCount`, and name copies for the
 * practice area / court / lead user. The normalized schema stores those in
 * junction tables (`matter_members`, `matter_clients`) and resolves names via JOINs.
 *
 * This repository reconstructs the legacy entity shape on read (so the service
 * + frontend are largely unchanged) while persisting normalized rows on write.
 *
 *   members[]      <- matter_members JOIN users (name) + activities (totalHours)
 *   memberUserIds  <- array_agg(matter_members.user_id)
 *   clientNames    <- matter_clients JOIN clients (name)
 *   clientUserIds  <- matter_clients JOIN clients (user_id)
 *   clients[]      <- matter_clients JOIN clients ({ id, name, email })
 *   practiceAreaName / courtName / leadUserName <- LEFT JOINs
 */

const { isUuid } = require('../../shared/utils/isUuid');
const { toIlikeTerm, escapeLikeLiteral } = require('../../shared/database/searchTerm');
const { readNotesPage, readNoteTimeCounts } = require('../../shared/database/notesPage');

/**
 * SQL expressions the shared notes filter builder uses against `notes`.
 *
 * Every expression is qualified with `notes.` even though the matter
 * notes query has no join today, because the firm-wide notes list joins
 * `matters` and an unqualified column here (`law_firm_id`, `created_by`) would
 * become ambiguous between the two tables.
 *
 * `hasTime` is an EXISTS against `activities` rather than a column: a note's
 * time lives entirely in the billing tables now, and a note can carry several
 * entries, so "has time" is a question about that table and not a flag the note
 * keeps in sync.
 */
const MATTER_NOTE_COLUMNS = {
  content: 'notes.content',
  subject: 'notes.subject',
  // The author's CURRENT name, joined at search time. `created_by_name` was a
  // frozen copy, so a renamed member could not be found under the name their
  // colleagues actually use. A subquery rather than a join alias because this
  // expression also runs inside the count and page-locator queries, which
  // have no join to alias against.
  author: '(select u.name from users u where u.id = notes.created_by)',
  author_id: 'notes.created_by',
  noteType: 'notes.note_type',
  noteDate: 'notes.note_date',
  hasTime: `exists (
    select 1 from activities te
     where te.kind = 'time'
       and te.law_firm_id = notes.law_firm_id
       and te.linked_note_id = notes.id
  )`,
};

/**
 * The count query behind both the out-of-range page fallback and the tab counts.
 * `extra` is an additional aggregate the tab counts add; the WHERE and its $N
 * numbering are shared so one filter build serves both.
 */
const matterNotesCountSql = (where: any, extra: any) =>
  `select count(*) as total${extra ? `, ${extra}` : ''} from notes
    where notes.law_firm_id = $1 and notes.matter_id = $2${where}`;
const { clampLimit, buildOrderBy, buildPageClause, resolveWindowTotal } = require('../../shared/database/pagination');
const { admin } = require('../../shared/database/firebase');
const { TERMINAL_MATTER_STATUSES } = require('../../shared/constants/matterStatus');

const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';
const bucket = admin.storage().bucket(BUCKET_NAME);

const { rowIso: iso } = require('../../shared/utils/dateConversion');
const centsToDollars = (c: any) => (c == null ? null : Number(c) / 100);
const dollarsToCents = (d: any) =>
  d == null || d === '' ? null : Math.round(Number(d) * 100);

/** Enriched matter projection: reconstructs the legacy denormalized shape. */
const MATTER_SELECT = `
  select
    c.*,
    pa.name as practice_area_name,
    ct.name as court_name,
    lu.name as lead_user_name,
    st.name as stage_name,
    st.color as stage_color,
    st.is_closed as stage_is_closed,
    msp.name as stage_pipeline_name,
    coalesce(m.members, '[]'::json)        as members_json,
    coalesce(m.member_user_ids, '{}')      as member_user_ids,
    coalesce(cl.client_names, '{}')        as client_names,
    coalesce(cl.client_user_ids, '{}')     as client_user_ids,
    coalesce(cl.client_details, '[]'::json) as client_details,
    coalesce(cl.client_count, 0)           as client_count,
    coalesce(bal.outstanding_balance_cents, 0) as outstanding_balance_cents,
    coalesce(billed.billed_total_cents, 0)     as billed_total_cents,
    -- The live hold, if any. A released row is kept as the record of what was
    -- held, so only an unreleased row counts (migration 0221).
    (lh.id is not null) as legal_hold,
    lh.reason          as legal_hold_reason,
    lh.placed_at       as legal_hold_at,
    lh.placed_by       as legal_hold_by
  from matters c
  left join practice_areas pa on pa.id = c.practice_area_id
  left join courts         ct on ct.id = c.court_id
  left join users          lu on lu.id = c.lead_user_id
  left join matter_stages  st on st.id = c.stage_id
  left join matter_stage_pipelines msp on msp.id = c.stage_pipeline_id
  left join legal_holds lh
    on lh.law_firm_id = c.law_firm_id and lh.matter_id = c.id and lh.released_at is null
  left join lateral (
    select
      json_agg(json_build_object(
        'userId',     cm.user_id,
        'name',       coalesce(u.name, ''),
        'role',       cm.role,
        'hourlyRate', cm.hourly_rate_cents,
        'joinedAt',   cm.joined_at,
        'totalHours', coalesce(th.total_hours, 0)
      ) order by cm.joined_at nulls first) as members,
      array_agg(cm.user_id)                as member_user_ids
    from matter_members cm
    left join users u on u.id = cm.user_id
    -- Pre-aggregate this matter's time entries once (grouped by user_id) instead of
    -- running a correlated sum per member row. One grouped scan feeds every member.
    left join (
      select te.user_id, sum(te.hours) as total_hours
      from activities te
      where te.kind = 'time' and te.matter_id = c.id
      group by te.user_id
    ) th on th.user_id = cm.user_id
    where cm.matter_id = c.id
  ) m on true
  left join lateral (
    select
      -- Ordered by name so clientNames[0] is deterministic. Without the ORDER BY
      -- the aggregate follows join order, and callers that show "the client" of a
      -- multi-client matter would pick a different one run to run.
      array_remove(array_agg(cli.name order by cli.name), null)      as client_names,
      array_remove(array_agg(cli.user_id order by cli.name), null)   as client_user_ids,
      json_agg(json_build_object(
        'id',    cli.id,
        'name',  coalesce(cli.name, ''),
        'email', cli.email
      ) order by cli.name)                                           as client_details,
      count(*)                                                       as client_count
    from matter_clients ccj
    join clients cli on cli.id = ccj.client_id
    where ccj.matter_id = c.id
  ) cl on true
  -- Sum of unpaid balances on this matter's non-voided invoices. Feeds the derived
  -- "payment ongoing" flag (an outstanding balance on a done matter).
  left join lateral (
    select coalesce(sum(inv.balance_due_cents), 0) as outstanding_balance_cents
    from invoices inv
    where inv.matter_id = c.id and inv.law_firm_id = c.law_firm_id
      and inv.status <> 'voided'
  ) bal on true
  -- Total invoiced-to-date for this matter, voided invoices excluded, feeding the budget burn indicator.
  left join lateral (
    select coalesce(sum(inv.total_cents), 0) as billed_total_cents
    from invoices inv
    where inv.matter_id = c.id and inv.law_firm_id = c.law_firm_id
      and inv.status <> 'voided'
  ) billed on true
`;

/**
 * Lighter list projection. Drops the per-member `activities` grouped scan
 * (list consumers never read `members[].totalHours`) while keeping the exact
 * same hydrated entity shape. Member `totalHours` is reported as 0 on the list.
 * The heavy enriched `MATTER_SELECT` is still used for the single-matter detail read.
 *
 * Deliberately split into its select list and its JOIN chain (rather than one
 * ready-made SELECT string) so the paged read can put a pre-paged CTE ahead of
 * `matters` in the FROM. A paginated read needs a total count, and computing that
 * count with a `count(*) over()` window inside THIS select would force Postgres to
 * materialize every matching row before LIMIT applies, running the lateral
 * member/client/invoice enrichment across the whole match set to display one page.
 * Keeping the pieces separate lets the count live in a CTE over the bare `matters`
 * table while these joins only ever see the ids that survived the window.
 * See `listMattersPaged`.
 */
const LIST_MATTER_COLUMNS = `
    c.*,
    pa.name as practice_area_name,
    ct.name as court_name,
    lu.name as lead_user_name,
    st.name as stage_name,
    st.color as stage_color,
    st.is_closed as stage_is_closed,
    msp.name as stage_pipeline_name,
    coalesce(m.members, '[]'::json)        as members_json,
    coalesce(m.member_user_ids, '{}')      as member_user_ids,
    coalesce(cl.client_names, '{}')        as client_names,
    coalesce(cl.client_user_ids, '{}')     as client_user_ids,
    coalesce(cl.client_details, '[]'::json) as client_details,
    coalesce(cl.client_count, 0)           as client_count,
    coalesce(bal.outstanding_balance_cents, 0) as outstanding_balance_cents,
    (lh.id is not null) as legal_hold,
    lh.reason          as legal_hold_reason,
    lh.placed_at       as legal_hold_at,
    lh.placed_by       as legal_hold_by`;

/** JOIN chain for `LIST_MATTER_COLUMNS`. Assumes `matters` is already aliased `c`. */
const LIST_MATTER_JOINS = `
  left join practice_areas pa on pa.id = c.practice_area_id
  left join courts         ct on ct.id = c.court_id
  left join users          lu on lu.id = c.lead_user_id
  left join matter_stages  st on st.id = c.stage_id
  left join matter_stage_pipelines msp on msp.id = c.stage_pipeline_id
  left join legal_holds lh
    on lh.law_firm_id = c.law_firm_id and lh.matter_id = c.id and lh.released_at is null
  left join lateral (
    select
      json_agg(json_build_object(
        'userId',     cm.user_id,
        'name',       coalesce(u.name, ''),
        'role',       cm.role,
        'hourlyRate', cm.hourly_rate_cents,
        'joinedAt',   cm.joined_at,
        'totalHours', 0
      ) order by cm.joined_at nulls first) as members,
      array_agg(cm.user_id)                as member_user_ids
    from matter_members cm
    left join users u on u.id = cm.user_id
    where cm.matter_id = c.id
  ) m on true
  left join lateral (
    select
      -- Ordered by name so clientNames[0] is deterministic. Without the ORDER BY
      -- the aggregate follows join order, and callers that show "the client" of a
      -- multi-client matter would pick a different one run to run.
      array_remove(array_agg(cli.name order by cli.name), null)      as client_names,
      array_remove(array_agg(cli.user_id order by cli.name), null)   as client_user_ids,
      json_agg(json_build_object(
        'id',    cli.id,
        'name',  coalesce(cli.name, ''),
        'email', cli.email
      ) order by cli.name)                                           as client_details,
      count(*)                                                       as client_count
    from matter_clients ccj
    join clients cli on cli.id = ccj.client_id
    where ccj.matter_id = c.id
  ) cl on true
  -- Sum of unpaid balances on this matter's non-voided invoices. Feeds the derived
  -- "payment ongoing" flag (an outstanding balance on a done matter).
  left join lateral (
    select coalesce(sum(inv.balance_due_cents), 0) as outstanding_balance_cents
    from invoices inv
    where inv.matter_id = c.id and inv.law_firm_id = c.law_firm_id
      and inv.status <> 'voided'
  ) bal on true
`;

/** Map an enriched DB row to the legacy matter entity shape. */
function hydrate(row: any) {
  if (!row) return null;
  const members = (row.members_json || []).map((mem: any) => ({
    ...mem,
    hourlyRate: centsToDollars(mem.hourlyRate),
    joinedAt: mem.joinedAt || null,
    totalHours: Number(mem.totalHours) || 0,
  }));
  const outstandingBalanceCents = Number(row.outstanding_balance_cents) || 0;
  const paymentOngoingManual = row.payment_ongoing === true;
  // The flag is only meaningful once a matter is functionally done, so it's
  // surfaced only on terminal statuses. Effective = manual override OR an
  // actual outstanding invoice balance (so nobody has to remember to toggle it).
  const paymentOngoing =
    TERMINAL_MATTER_STATUSES.includes(row.status) &&
    (paymentOngoingManual || outstandingBalanceCents > 0);
  return {
    id: row.id,
    matterId: row.id,
    lawFirmId: row.law_firm_id,
    name: row.name,
    matterNumber: row.matter_number,
    matterReferenceId: row.matter_reference_id,
    description: row.description,
    status: row.status,
    paymentOngoing,
    paymentOngoingManual,
    outstandingBalanceCents,
    category: row.category,
    practiceAreaId: row.practice_area_id,
    practiceAreaName: row.practice_area_name || null,
    courtId: row.court_id,
    courtName: row.court_name || null,
    // Primary lead (the matters.lead_user_id column) plus the full lead set,
    // derived from matter_members with the `lead` role. A matter can have many
    // leads; leadUserId is just the primary/first for single-value consumers.
    leadUserId: row.lead_user_id,
    leadUserName: row.lead_user_name || null,
    leadUserIds: members.filter((mem: any) => mem.role === 'lead').map((mem: any) => mem.userId),
    customFields: row.custom_fields || {},
    // Pipeline stage (distinct from the coarse status enum).
    stageId: row.stage_id || null,
    stageName: row.stage_name || null,
    stageColor: row.stage_color || null,
    stageIsClosed: row.stage_is_closed === true,
    stagePipelineId: row.stage_pipeline_id || null,
    stagePipelineName: row.stage_pipeline_name || null,
    // Billing preferences.
    billingMethod: row.billing_method || 'hourly',
    isBillable: row.is_billable !== false,
    budgetCents: row.budget_cents == null ? null : Number(row.budget_cents),
    budget: centsToDollars(row.budget_cents),
    budgetIncludesExpenses: row.budget_includes_expenses !== false,
    contingencyPercent: row.contingency_percent == null ? null : Number(row.contingency_percent),
    billedTotalCents: Number(row.billed_total_cents) || 0,
    // Key dates (day-only 'YYYY-MM-DD' strings; never wrapped in new Date()).
    openDate: row.open_date || null,
    closeDate: row.close_date || null,
    statuteOfLimitationsDate: row.statute_of_limitations_date || null,
    members,
    memberUserIds: row.member_user_ids || [],
    clientNames: row.client_names || [],
    clientUserIds: row.client_user_ids || [],
    // The matter's clients as identifiable records. Billing needs the client id
    // (to know who an invoice or time entry is billed to), which the parallel
    // name/userId arrays can't supply.
    clients: row.client_details || [],
    clientCount: Number(row.client_count) || 0,
    fileNames: [],
    legalHold: row.legal_hold === true,
    legalHoldReason: row.legal_hold_reason || null,
    legalHoldAt: iso(row.legal_hold_at),
    legalHoldBy: row.legal_hold_by || null,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * WHERE clause + params shared by every matter-list read: the enriched paged
 * list and the ids-only read behind "select all". Both must agree exactly on
 * what the current filters match, so the predicate lives here once rather than
 * being written twice.
 *
 * `c` is the `matters` alias, and $1 is always the law firm. Filters are appended
 * in order and index off `params.length`, so the caller can keep appending its own
 * (paging) params afterwards.
 *
 * @returns {{ whereSql: string, params: any[] }}
 */
function buildMatterListWhere(lawFirmId: string, userId: string, {
  seeAll = false,
  status,
  paymentOngoing = false,
  practiceAreaId,
  leadUserId,
  clientId,
  category,
  search,
}: any = {}) {
  const where = ['c.law_firm_id = $1'];
  const params: unknown[] = [lawFirmId];

  // The ethical wall. Owners/admins (`seeAll`) skip the membership probe, so
  // every later filter indexes off params.length rather than a fixed $N.
  if (!seeAll) {
    params.push(userId);
    where.push(`exists (select 1 from matter_members cm2
                         where cm2.matter_id = c.id and cm2.user_id = $${params.length})`);
  }

  if (status) { params.push(status); where.push(`c.status = $${params.length}`); }

  // "Payment ongoing" is a derived flag, not a stored one, so it cannot be a
  // value of the `status` enum and gets its own filter. It reproduces exactly
  // the expression `hydrate()` exposes as `paymentOngoing`: a terminal-status
  // matter carrying either the manual `payment_ongoing` override or a real
  // outstanding invoice balance. The balance is summed (rather than probed with
  // EXISTS) so credit-note negatives cancel here the same way they do in
  // `outstandingBalanceCents`.
  if (paymentOngoing) {
    params.push(TERMINAL_MATTER_STATUSES);
    where.push(`(c.status = any($${params.length}::text[])
                 and (c.payment_ongoing = true
                      or (select coalesce(sum(inv.balance_due_cents), 0)
                            from invoices inv
                           where inv.matter_id = c.id
                             and inv.law_firm_id = c.law_firm_id
                             and inv.status <> 'voided') > 0))`);
  }

  // Categories are stored on `matters.category` as the full ' > '-joined path
  // of the `matter_categories` tree ("Litigation > Appeals"), not as an id, so
  // an equality match would exclude every child of the selected node. Match the
  // exact path OR anything beneath it. The filter value is escaped for LIKE
  // (a category literally containing `%` must not turn into a wildcard) and the
  // stored value is trimmed on both sides so stray whitespace in either does not
  // hide a matter. `matters.category` carries no index, so btrim costs nothing.
  const categoryPath = escapeLikeLiteral(category);
  if (categoryPath) {
    params.push(String(category).trim());
    const eq = params.length;
    params.push(`${categoryPath} > %`);
    where.push(`(btrim(c.category) = $${eq} or btrim(c.category) like $${params.length} escape '\\')`);
  }

  if (isUuid(practiceAreaId)) {
    params.push(practiceAreaId);
    where.push(`c.practice_area_id = $${params.length}`);
  }
  if (leadUserId) { params.push(leadUserId); where.push(`c.lead_user_id = $${params.length}`); }
  // `clientId` accepts either a single client id or an already-resolved array
  // (the client-detail Matters tab widens it to that client's id plus every
  // company it's linked to via `client_company_links`). A single id is
  // wrapped so the `= any(...)` shape below covers both callers identically.
  const clientIdList = Array.isArray(clientId)
    ? clientId.filter(isUuid)
    : (isUuid(clientId) ? [clientId] : []);
  if (clientIdList.length) {
    params.push(clientIdList);
    where.push(`c.id in (
      select mc.matter_id
        from matter_clients mc
       where mc.law_firm_id = $1
         and mc.client_id = any($${params.length}::uuid[])
    )`);
  }

  // Free-text search over the matter's own text columns plus the names of its
  // linked clients. Parameterized ILIKE with an escaped term, so a user typing
  // `%` searches for a literal percent sign instead of matching everything.
  //
  // The client-name arm is an UNCORRELATED `in (...)`, pinned to the firm by $1
  // on both `clients` and `matter_clients`, and that shape is load-bearing. Written
  // as a correlated `exists (... where mc.matter_id = c.id)` it reads more naturally
  // and returns the same rows, but the planner can only run it as a SubPlan once per
  // CANDIDATE matter, so its cost tracks the firm's total matter count rather than
  // the page size. Measured over a 5,000-matter firm asking for 25 rows: the
  // correlated form looped the SubPlan 5,000 times for 30,213 shared buffers, the
  // uncorrelated form evaluates it once into a hash and probes that, for 389.
  //
  // Pinning to $1 rather than `c.law_firm_id` is what makes it uncorrelated, and it
  // keeps the tenant scope explicit: `clients` is still reached firm-scoped through
  // its (law_firm_id, id) index and is never scanned across tenants.
  //
  // `in` is safe against NULL semantics here because `matter_clients.matter_id` is
  // NOT NULL, so the subquery can never yield a NULL that would turn the predicate
  // UNKNOWN instead of false.
  const term = toIlikeTerm(search);
  if (term) {
    params.push(term);
    const p = params.length;
    // UNION of index-friendly arms rather than one OR containing a correlated
    // subquery. In the old shape the client-name arm re-ran per candidate row —
    // measured at 3.7 SECONDS over 40k matters — because an OR that reaches
    // another table cannot be index-served, so Postgres scanned and filtered.
    // Each arm below hits one table and seeks its own trigram index. Same rows,
    // measured 3,658ms -> 0.14ms; see migration 0141's header.
    where.push(`c.id in (
                   select id from matters where law_firm_id = $1 and name ilike $${p} escape '\\'
             union select id from matters where law_firm_id = $1 and matter_number ilike $${p} escape '\\'
             union select id from matters where law_firm_id = $1 and description ilike $${p} escape '\\'
             union select mc.matter_id from matter_clients mc
                    join clients cl on cl.id = mc.client_id and cl.law_firm_id = $1
                   where mc.law_firm_id = $1 and cl.name ilike $${p} escape '\\'
                 )`);
  }
  const whereSql = where.join(' and ');

  return { whereSql: where.join(' and '), params };
}

/**
 * The columns a matter's client list projects, shared by the per-matter read and
 * the batched one so the two can never select different fields.
 */
const MATTER_CLIENT_COLUMNS = {
  id: clients.id,
  userId: clients.userId,
  clientType: clients.clientType,
  name: clients.name,
  email: clients.email,
  phone: clients.phone,
  organization: clients.organization,
  address: clients.address,
  preferredContactMethod: clients.preferredContactMethod,
  billingPortionBp: matterClients.billingPortionBp,
};

/** One row of the projection above, as the matter-clients API returns it. */
function toMatterClient(r: any) {
  return {
    id: r.id,
    userId: r.userId || null,
    clientType: r.clientType || 'person',
    name: r.name || '',
    email: r.email || '',
    phone: r.phone || '',
    organization: r.organization || '',
    address: r.address || '',
    // Null when the firm cleared the preference ("None"); reading it as 'email'
    // would show a cleared preference as Email the next time it is edited.
    preferredContactMethod: r.preferredContactMethod || null,
    // Null until the matter is configured for split billing. The read keeps it
    // null rather than defaulting to an even share, because "not configured"
    // and "configured as an equal split" bill differently once there are three
    // payers and the shares do not divide evenly.
    billingPortionBp:
      typeof r.billingPortionBp === 'number' ? r.billingPortionBp : null,
  };
}


/**
 * A new client's preferred contact method: an explicit null is a chosen "None"
 * and is kept; an absent value takes the 'email' default.
 */
function contactMethodOrDefault(method: string | null | undefined) {
  return method === null ? null : (method || 'email');
}

class MattersRepository {
  /** Enriched single matter (or null). */
  async findByIdRaw(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return null;
    const { rows } = await tenantAliasedQuery(matters, lawFirmId, 'c', ({ executor, scope }) => executor.execute(
      sql`${sql.raw(MATTER_SELECT)} where ${scope} and c.id = ${matterId} limit 1`,
    ));
    return rows[0] ? hydrate(rows[0]) : null;
  }

  /** Batched enriched-matter read (replaces per-matter findByIdRaw N+1). */
  async findByIdsRaw(lawFirmId: string, matterIds: string[]) {
    const ids = (matterIds || []).filter(isUuid);
    if (!ids.length) return [];
    const { rows } = await tenantAliasedQuery(matters, lawFirmId, 'c', ({ executor, scope }) => executor.execute(
      sql`${sql.raw(MATTER_SELECT)} where ${scope} and c.id = any(${sql.param(ids)}::uuid[])`,
    ));
    return rows.map(hydrate);
  }

  /**
   * Count how many of the given ids reference matters that actually exist in this
   * firm. A `count(*)` equivalent of `findByIdsRaw(...).length` that doesn't
   * hydrate any rows. Used by the portal dashboard summary to read a matter count
   * without fetching the full matter list.
   */
  async countByIds(lawFirmId: string, matterIds: string[]) {
    const ids = (matterIds || []).filter(isUuid);
    if (!ids.length) return 0;
    const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
      .select({ total: sql<number>`count(*)::int` }).from(matters)
      .where(and(scope, inArray(matters.id, ids))));
    return rows[0]?.total || 0;
  }

  /** Lightweight existence/raw check returning the core row. */
  async getCoreById(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return null;
    const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
      .select().from(matters).where(and(scope, eq(matters.id, matterId))).limit(1));
    return rows[0] || null;
  }

  /**
   * Take the matter row lock inside `executor`'s transaction and report whether
   * the matter exists. Work that decides from the matter's member list and then
   * changes it holds this lock from the read to the commit, so two such requests
   * on one matter run one after the other.
   */
  async lockMatterRow(lawFirmId: string, matterId: string, executor: any) {
    if (!isUuid(matterId)) return false;
    const rows = await tenantQuery(matters, lawFirmId, ({ executor: q, scope }) => q
      .select({ id: matters.id }).from(matters)
      .where(and(scope, eq(matters.id, matterId))).limit(1).for('update'), executor);
    return rows.length > 0;
  }

  /** Batched id -> name map (replaces per-matter getMatterName N+1). */
  async getNamesByIds(lawFirmId: string, matterIds: string[]) {
    const ids = (matterIds || []).filter(isUuid);
    if (!ids.length) return {};
    const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
      .select({ id: matters.id, name: matters.name }).from(matters)
      .where(and(scope, inArray(matters.id, ids))));
    return Object.fromEntries(rows.map((r: any) => [r.id, r.name || null]));
  }

  /**
   * Client names per matter for a set of matters, as `{ [matterId]: string[] }`.
   *
   * The calendar labels an event with its matter's clients. Resolving them here
   * means the event payload carries the names, so the calendar does not have to
   * load every matter in the firm just to build a lookup table.
   */
  async getClientNamesByIds(lawFirmId: string, matterIds: string[]) {
    const ids = (matterIds || []).filter(isUuid);
    if (!ids.length) return {};
    const rows = await tenantQuery(matterClients, lawFirmId, ({ executor, scope }) => executor
      .select({ matterId: matterClients.matterId, name: clients.name })
      .from(matterClients).innerJoin(clients, and(
        eq(clients.id, matterClients.clientId),
        eq(clients.lawFirmId, matterClients.lawFirmId),
      )).where(and(scope, inArray(matterClients.matterId, ids))).orderBy(asc(clients.name)));
    const map: Record<string, any> = {};
    for (const row of rows) {
      if (!row.name) continue;
      if (!map[row.matterId]) map[row.matterId] = [];
      map[row.matterId].push(row.name);
    }
    return map;
  }

  /**
   * Column map for a matters INSERT. Shared by the plain createMatter path and the
   * transactional createMatterWithMembersTx so the two never drift on which
   * columns/defaults a new matter row carries.
   */
  _matterInsertCols(lawFirmId: string, matterData: any, referenceId: any): InsertValues<typeof matters> {
    return {
      name: matterData.name,
      matterNumber: matterData.matterNumber ?? null,
      matterReferenceId: referenceId,
      description: matterData.description ?? null,
      status: matterData.status || 'active',
      category: matterData.category ?? null,
      practiceAreaId: isUuid(matterData.practiceAreaId) ? matterData.practiceAreaId : null,
      courtId: isUuid(matterData.courtId) ? matterData.courtId : null,
      leadUserId: matterData.leadUserId ?? null,
      stageId: isUuid(matterData.stageId) ? matterData.stageId : null,
      stagePipelineId: isUuid(matterData.stagePipelineId) ? matterData.stagePipelineId : null,
      billingMethod: matterData.billingMethod || 'hourly',
      isBillable: matterData.isBillable === false ? false : true,
      budgetCents: matterData.budgetCents ?? null,
      budgetIncludesExpenses: matterData.budgetIncludesExpenses === false ? false : true,
      contingencyPercent: matterData.contingencyPercent ?? null,
      openDate: matterData.openDate ?? null,
      closeDate: matterData.closeDate ?? null,
      statuteOfLimitationsDate: matterData.statuteOfLimitationsDate ?? null,
      customFields: matterData.customFields || {},
      createdBy: matterData.createdBy ?? null,
    };
  }

  /** True when `err` is the matters (law_firm_id, matter_reference_id) unique violation. */
  _isReferenceIdCollision(err: any) {
    return err.code === '23505'
      && typeof err.constraint === 'string'
      && err.constraint.includes('matter_reference_id');
  }

  /**
   * Insert a matters row via `executor`, returning the new id. The
   * (law_firm_id, matter_reference_id) unique constraint can collide if the
   * pre-generated reference id was claimed by a concurrent create; on that
   * specific violation the insert retries with a freshly generated id. When run
   * inside a transaction (`inTransaction`), each attempt is wrapped in a SAVEPOINT
   * so a collision rolls back only the failed insert, not the whole transaction.
   * Reusing the same savepoint name across retries is intentional and legal in
   * Postgres (a re-declared name shadows the older frame); the capped REF_RETRIES
   * bounds it, and all frames are released by the outer commit/rollback.
   */
  async _insertMatterRow(executor: any, lawFirmId: string, matterData: any, { inTransaction = false }: any = {}) {
    const REF_RETRIES = 5;
    let referenceId = matterData.matterReferenceId;
    for (let attempt = 0; ; attempt += 1) {
      const cols = this._matterInsertCols(lawFirmId, matterData, referenceId);
      // eslint-disable-next-line no-await-in-loop
      if (inTransaction) await executor.execute(sql.raw('savepoint matter_insert'));
      try {
        // eslint-disable-next-line no-await-in-loop
        const rows = await scopedInsert(matters, lawFirmId, cols, executor);
        // eslint-disable-next-line no-await-in-loop
        if (inTransaction) await executor.execute(sql.raw('release savepoint matter_insert'));
        return rows[0].id;
      } catch (err: any) {
        // eslint-disable-next-line no-await-in-loop
        if (inTransaction) await executor.execute(sql.raw('rollback to savepoint matter_insert'));
        if (!this._isReferenceIdCollision(err) || attempt >= REF_RETRIES) throw err;
        // eslint-disable-next-line no-await-in-loop
        referenceId = await this.generateUniqueMatterReferenceId(lawFirmId);
      }
    }
  }

  async createMatter(lawFirmId: string, matterData: any) {
    const id = await this._insertMatterRow(rootQueryExecutor, lawFirmId, matterData);
    return this.findByIdRaw(lawFirmId, id);
  }

  /**
   * Atomically create a matter together with its member rows (every lead, plus the
   * acting user as a plain member) and any linked clients, in ONE transaction. A
   * failure at any step rolls the whole thing back, so a create can never leave a
   * matter with zero members (the orphan state member-removal deliberately guards
   * against) or orphan unlinked client rows. Returns the fully-enriched matter.
   *
   * `beforeInsert(conn)`, when given, runs first, on the SAME transaction
   * executor as the insert that follows. The `maxMatters` plan-limit check is
   * passed in this way (see `matters.service.ts#createMatter`) so it can lock
   * the firm row and re-count inside this transaction, after the lock, rather
   * than as a separate unlocked check before the transaction even opens. See
   * `lockFirmForMatterCountCheck` for why an unlocked check outside this
   * transaction cannot stop two concurrent creates both landing on the same
   * final open slot.
   */
  async createMatterWithMembersTx(
    lawFirmId: string,
    matterData: any,
    { leadIds = [], actingUserId = null, clients = [], beforeInsert, afterInsert }: {
      /** User ids to record as the matter's lead attorneys. */
      leadIds?: string[];
      /** Added as a plain member when not already a lead. */
      actingUserId?: string | null;
      /** Client records to find-or-create and attach. */
      clients?: unknown[];
      /** Runs inside the transaction before the insert, so a caller can lock the firm row first. */
      beforeInsert?: (conn: unknown) => Promise<void>;
      /** Writes related state after clients and members exist, before committing. */
      afterInsert?: (matterId: string, clientIds: string[], conn: unknown) => Promise<void>;
    } = {},
  ) {
    const matterId = await withDrizzleTransaction(async (conn: any) => {
      if (beforeInsert) await beforeInsert(conn);
      const id = await this._insertMatterRow(conn, lawFirmId, matterData, { inTransaction: true });

      const leads = [...new Set((leadIds || []).filter(Boolean))];
      if (leads.length) await this.upsertLeads(lawFirmId, id, leads, conn);
      if (actingUserId && !leads.includes(actingUserId)) {
        await this.upsertMember(lawFirmId, id, actingUserId, { role: 'member', executor: conn });
      }

      const clientList = Array.isArray(clients) ? clients : [];
      let clientIds: string[] = [];
      if (clientList.length) {
        clientIds = await this.findOrCreateClientsForMatter(lawFirmId, clientList, conn);
        await this.addMatterClients(lawFirmId, id, clientIds, conn);
      }
      if (afterInsert) await afterInsert(id, clientIds, conn);
      return id;
    });
    return this.findByIdRaw(lawFirmId, matterId);
  }

  /** Generate a unique matterReferenceId of the form CP-XXXXXX within a firm. */
  async generateUniqueMatterReferenceId(lawFirmId: string) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const generate = () => {
      let result = 'CP-';
      for (let i = 0; i < 6; i += 1) result += chars.charAt(Math.floor(Math.random() * chars.length));
      return result;
    };
    for (let attempts = 0; attempts < 20; attempts += 1) {
      const candidate = generate();
      // eslint-disable-next-line no-await-in-loop
      const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
        .select({ id: matters.id }).from(matters)
        .where(and(scope, eq(matters.matterReferenceId, candidate))).limit(1));
      if (!rows.length) return candidate;
    }
    return generate();
  }

  /**
   * Update core matter columns. Accepts a camelCase patch (subset).
   *
   * `propagatePracticeAreaToTasks` copies a changed practice area onto every task
   * of the matter in the same transaction as the matter row, the way the
   * dedicated practice-area operations do, so editing the area through the
   * general edit route cannot leave tasks on the old one.
   */
  async updateMatter(
    lawFirmId: string, matterId: string, updates: any,
    { propagatePracticeAreaToTasks = false }: { propagatePracticeAreaToTasks?: boolean } = {},
  ) {
    if (!isUuid(matterId)) return null;
    const map = {
      name: 'name', matterNumber: 'matterNumber', description: 'description', status: 'status',
      paymentOngoing: 'paymentOngoing', category: 'category', practiceAreaId: 'practiceAreaId',
      courtId: 'courtId', leadUserId: 'leadUserId', stageId: 'stageId', stagePipelineId: 'stagePipelineId',
      billingMethod: 'billingMethod', isBillable: 'isBillable', budgetCents: 'budgetCents',
      budgetIncludesExpenses: 'budgetIncludesExpenses', contingencyPercent: 'contingencyPercent',
      openDate: 'openDate', closeDate: 'closeDate',
      statuteOfLimitationsDate: 'statuteOfLimitationsDate',
    } satisfies Record<string, MatterColumn>;
    const values: MatterUpdate = {};
    for (const [field, col] of Object.entries(map)) {
      if (updates[field] !== undefined) {
        let v = updates[field];
        if ((col === 'practiceAreaId' || col === 'courtId' || col === 'stageId' || col === 'stagePipelineId') && !isUuid(v)) v = null;
        setColumn<typeof matters>(values, col, v);
      }
    }
    if (updates.customFields !== undefined) values.customFields = updates.customFields;
    if (propagatePracticeAreaToTasks && updates.practiceAreaId !== undefined) {
      await withDrizzleTransaction(async (client: any) => {
        if (Object.keys(values).length) {
          await scopedUpdate(matters, lawFirmId, eq(matters.id, matterId), values, client);
        }
        await this._applyTaskUpdate(client, lawFirmId, matterId, { practiceAreaId: updates.practiceAreaId });
      });
    } else if (Object.keys(values).length) {
      await scopedUpdate(matters, lawFirmId, eq(matters.id, matterId), values);
    }
    return this.findByIdRaw(lawFirmId, matterId);
  }

  async deleteMatter(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return;
    // Child rows (members, clients, notes, tasks FK) cascade / set-null at the DB.
    await scopedDelete(matters, lawFirmId, eq(matters.id, matterId));
  }

  /**
   * Set or clear a matter's legal hold. Enabling stamps who placed it and when
   * (and an optional reason); disabling clears all hold metadata. Returns the
   * enriched matter, or null when no matter matched.
   */
  async setLegalHold(lawFirmId: string, matterId: string, { legalHold, reason = null, actingUserId = null }: any) {
    if (!isUuid(matterId)) return null;
    const matterRows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
      .select({ id: matters.id }).from(matters).where(and(scope, eq(matters.id, matterId))).limit(1));
    if (!matterRows.length) return null;

    // Releasing KEEPS the row: which evidence was held, by whom and for how long
    // is the record a hold exists to produce (migration 0221). Only an
    // unreleased row counts, so releasing is stamping `released_at`.
    if (legalHold === true) {
      const live = await tenantQuery(legalHolds, lawFirmId, ({ executor, scope }) => executor
        .select({ id: legalHolds.id }).from(legalHolds).where(and(
          scope, eq(legalHolds.matterId, matterId), isNull(legalHolds.releasedAt),
        )).limit(1));
      if (live.length) {
        await scopedUpdate(legalHolds, lawFirmId, eq(legalHolds.id, live[0].id), {
          reason: reason || null,
        });
      } else {
        await scopedInsert(legalHolds, lawFirmId, {
          matterId, reason: reason || null, placedBy: actingUserId,
        });
      }
    } else {
      await scopedUpdate(legalHolds, lawFirmId, and(
        eq(legalHolds.matterId, matterId), isNull(legalHolds.releasedAt),
      )!, { releasedAt: sql`now()`, releasedBy: actingUserId });
    }
    return this.findByIdRaw(lawFirmId, matterId);
  }

  /**
   * Which of these matters carry a live (unreleased) legal hold, in one query.
   * Used where a batch of rows each belonging to some matter must be refused
   * when that matter is held, without one lookup per row.
   */
  async findHeldMatterIds(lawFirmId: string, matterIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(matterIds.filter((id) => isUuid(id)))];
    if (!ids.length) return new Set();
    const rows = await tenantQuery(legalHolds, lawFirmId, ({ executor, scope }) => executor
      .selectDistinct({ matterId: legalHolds.matterId }).from(legalHolds)
      .where(and(scope, inArray(legalHolds.matterId, ids), isNull(legalHolds.releasedAt))));
    return new Set(rows.map((r: { matterId: string | null }) => r.matterId as string));
  }

  /**
   * Transactional matter-row delete. Wraps the `matters` row delete (and its
   * cascading child deletes) in a single BEGIN/COMMIT so a mid-cascade failure
   * rolls back atomically rather than leaving a half-deleted matter. Used by the
   * per-item `bulkDelete` path so a failure on one matter never half-applies it.
   */
  async deleteMatterTx(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return;
    await withDrizzleTransaction((transaction) =>
      scopedDelete(matters, lawFirmId, eq(matters.id, matterId), transaction));
  }

  /**
   * Atomically apply a `matters`-row update AND propagate its practice area to the
   * matter's `tasks` rows inside a single transaction. Used by the practice-area
   * operations so a mid-item failure (e.g. the task UPDATE) rolls back the
   * matter-row change too. No partial per-item state. Returns the enriched matter.
   * Status is never propagated: task status is a separate vocabulary.
   */
  async updateMatterAndTasksTx(lawFirmId: string, matterId: string, updates: any) {
    if (!isUuid(matterId)) return null;
    await withDrizzleTransaction(async (client: any) => {
      await this._applyMatterUpdate(client, lawFirmId, matterId, updates);
      await this._applyTaskUpdate(client, lawFirmId, matterId, updates);
    });
    return this.findByIdRaw(lawFirmId, matterId);
  }

  /** Apply a camelCase matter patch on a supplied client (txn participant). */
  async _applyMatterUpdate(client: any, lawFirmId: string, matterId: string, updates: any) {
    const map = {
      name: 'name', matterNumber: 'matterNumber', description: 'description', status: 'status',
      paymentOngoing: 'paymentOngoing', category: 'category', practiceAreaId: 'practiceAreaId',
      courtId: 'courtId', leadUserId: 'leadUserId',
    } satisfies Record<string, MatterColumn>;
    const values: MatterUpdate = {};
    for (const [field, col] of Object.entries(map)) {
      if (updates[field] !== undefined) {
        let v = updates[field];
        if ((col === 'practiceAreaId' || col === 'courtId') && !isUuid(v)) v = null;
        setColumn<typeof matters>(values, col, v);
      }
    }
    if (updates.customFields !== undefined) values.customFields = updates.customFields;
    if (!Object.keys(values).length) return;
    await scopedUpdate(matters, lawFirmId, eq(matters.id, matterId), values, client);
  }

  /**
   * Propagate the practice area to the matter's tasks on a txn client. A matter
   * `status` in `updates` is deliberately not copied: the tasks status CHECK
   * allows only open/in_progress/completed/blocked, and each task's status is
   * its own progress, not the matter's.
   */
  async _applyTaskUpdate(client: any, lawFirmId: string, matterId: string, updates: any) {
    const map = { practiceAreaId: 'practiceAreaId' } satisfies Record<string, TaskColumn>;
    const values: UpdateValues<typeof tasks> = {};
    for (const [field, col] of Object.entries(map)) {
      if (updates[field] !== undefined) {
        let v = updates[field];
        if (col === 'practiceAreaId' && !isUuid(v)) v = null;
        setColumn<typeof tasks>(values, col, v);
      }
    }
    if (!Object.keys(values).length) return;
    await scopedUpdate(tasks, lawFirmId, eq(tasks.matterId, matterId), values, client);
  }

  /**
   * The single enriched matters-list read: visibility scoping, filtering, free-text
   * search, multi-column sorting, and optional windowing, all pushed into SQL.
   *
   * VISIBILITY. `seeAll` is the ethical wall. False (the default) restricts the
   * result to matters the user is a `matter_members` row for; true drops the
   * predicate entirely and is only ever passed for firm owners/admins. Callers
   * resolve it through `canViewAllMatters`.
   *
   * SHAPE. The query is page-then-enrich, and that ordering is the whole point:
   *
   *   with page as (select c.id, count(*) over() from matters c where ... limit ...)
   *   select <enriched columns> from page p join matters c on c.id = p.id <joins>
   *
   * `count(*) over()` is a window function, so Postgres must materialize every
   * matching row before LIMIT applies. Putting that window anywhere in the enriched
   * select therefore runs the lateral member/client/invoice subqueries once per
   * MATCHING row (thousands) to display one page (tens). This is a property of
   * windowing over an enriched select, not of where the count column sits in the
   * select list: moving it around the projection changes nothing. The only fix is
   * to compute the count somewhere the enrichment is absent, hence the CTE over the
   * bare `matters` table, which keeps the count exact while the enrichment joins
   * only the ids that survived the window.
   *
   * `page` must also LEAD the FROM. Appending `join page p on p.id = c.id` after the
   * LEFT JOIN chain is valid SQL and looks equivalent, but it lets the planner pick
   * a merge join that enriches the full match set anyway (measured: 291 enrichment
   * loops for a 10-row page, versus 10 when `page` drives).
   *
   * WINDOWING. Optional and off by default: with `limit` null the LIMIT/OFFSET
   * clause is omitted and every visible matter comes back (the historic behaviour
   * the unpaginated list contract depends on), with `totalItems` still exact.
   * `offset` wins over `page` when both are supplied, so the older
   * `?limit=&offset=` query string keeps working.
   *
   * SORTING. `sort` is an ordered array of `{ field, dir }` over the SORT_COLUMNS
   * whitelist; unknown fields are skipped. It falls back to the single
   * `sortBy`/`order`, then to `createdAt desc`. `c.id asc` is always appended as a
   * stable tiebreaker so paging over equal sort keys is deterministic. The same
   * ORDER BY is applied inside the CTE (to choose the page) and again outside (the
   * join does not preserve CTE order); every expression resolves against `c` in
   * both positions.
   *
   * @returns {Promise<{ matters: object[], totalItems: number }>}
   */
  async listMattersPaged(lawFirmId: string, userId: string, {
    seeAll = false,
    page = 1,
    limit = null,
    offset = null,
    status,
    paymentOngoing = false,
    practiceAreaId,
    leadUserId,
    clientId,
    category,
    search,
    sort,
    sortBy = 'createdAt',
    order = 'desc',
  }: any = {}) {
    const { whereSql, params } = buildMatterListWhere(lawFirmId, userId, {
      seeAll, status, paymentOngoing, practiceAreaId, leadUserId, clientId, category, search,
    });

    // Whitelist sortable fields -> real ORDER BY expressions. Caller input is only
    // ever used as a key into this map, never interpolated. Every expression must
    // resolve against `c` alone, because the same ORDER BY is applied inside the
    // page CTE (which selects from the bare `matters` table, with none of the
    // enrichment joins in scope) and again in the outer select. practiceArea and
    // leadUser therefore sort by name through scalar subqueries, aliased pa_s /
    // lu_s so they do not shadow the `pa` / `lu` joins of the enriched select.
    const SORT_COLUMNS = {
      name: 'c.name',
      status: 'c.status',
      matterNumber: 'c.matter_number',
      category: 'c.category',
      createdAt: 'c.created_at',
      updatedAt: 'c.updated_at',
      practiceArea: '(select pa_s.name from practice_areas pa_s where pa_s.id = c.practice_area_id)',
      leadUser: '(select lu_s.name from users lu_s where lu_s.id = c.lead_user_id)',
    };
    const orderSql = buildOrderBy({
      sort, sortBy, order,
      columns: SORT_COLUMNS,
      fallback: { field: 'createdAt', dir: 'desc' },
      tiebreaker: 'c.id asc',
    });

    // Snapshot the filter params before the paging params are appended, so the
    // out-of-range count below can reuse `whereSql` with identical $N numbering.
    const filterParams = params.slice();
    // `max` matches the ceiling the list endpoint's schema accepts, so a request
    // at that ceiling is served in full rather than silently truncated.
    const { pageClause, pageOffset } = buildPageClause({
      limit, offset, page, params, max: 500, optional: true,
    });

    const { rows } = await tenantParameterizedQuery(matters, lawFirmId,
      `with page as (
         select c.id, count(*) over() as total_count
           from matters c
          where ${whereSql}
          order by ${orderSql}${pageClause}
       )
       select ${LIST_MATTER_COLUMNS},
              p.total_count
         from page p
         join matters c on c.id = p.id and c.law_firm_id = $1
         ${LIST_MATTER_JOINS}
        order by ${orderSql}`,
      params,
      'c',
    );

    const totalItems = await resolveWindowTotal({
      rows,
      pageOffset,
      countSql: `select count(*)::int as total from matters c where ${whereSql}`,
      filterParams,
      countQuery: async () => {
        const result = await tenantParameterizedQuery(
          matters,
          lawFirmId,
          `select count(*)::int as total from matters c where ${whereSql}`,
          filterParams,
          'c',
        );
        return result.rows;
      },
    });

    return { matters: rows.map(hydrate), totalItems };
  }

  /**
   * The caller's accessible matters reduced to the three fields the billing reads
   * actually consume: `id`, `name` and `clientNames`.
   *
   * Billing loads EVERY accessible matter (no window — the money aggregates cover
   * the whole firm), and it used to do that through `listMattersPaged`, which
   * hydrates each row with its members, client details, stage, practice area,
   * court, lead user and outstanding balance. None of that is read: the billing
   * services only ever touch `matterRecord.id`, `.name` and `.clientNames`. On a
   * 12,000-matter firm the enriched read took ~1.1s and ran on every billing
   * request, several times per page.
   *
   * The ethical wall is the same `buildMatterListWhere` predicate the enriched
   * list uses, so this cannot return a matter the paged list would have hidden.
   * Ordering is by id: no caller sorts these (they are turned straight into a Map
   * or joined against per-matter data), and a stable order keeps the output
   * deterministic.
   *
   * The client names come from one pre-grouped join rather than a correlated
   * subquery per row. Because the read is unwindowed, a correlated form runs its
   * two-table lookup once for every matter in the firm — on a 13,000-matter firm
   * that measured ~105,000 buffer hits and ~67ms, against ~580 hits and ~19ms for
   * the single grouped pass below. Aggregating the firm's `matter_clients` once
   * costs the same regardless of how many matters the caller can see, so it stays
   * flat as the firm grows instead of scaling with the matter count.
   */
  async listAccessibleMatterNames(lawFirmId: string, userId: string, { seeAll = false }: any = {}) {
    const { whereSql, params } = buildMatterListWhere(lawFirmId, userId, { seeAll });
    const { rows } = await tenantParameterizedQuery(matters, lawFirmId,
      `select c.id, c.name, coalesce(mcn.client_names, '{}') as client_names
         from matters c
         left join (
                select mc.matter_id,
                       array_agg(cl.name order by cl.name) as client_names
                  from matter_clients mc
                  join clients cl on cl.id = mc.client_id and cl.law_firm_id = mc.law_firm_id
                 where mc.law_firm_id = $1 and cl.name is not null
                 group by mc.matter_id
              ) mcn on mcn.matter_id = c.id
        where ${whereSql}
        order by c.id`,
      params,
      'c',
    );
    return rows.map((r: any) => ({ id: r.id, name: r.name, clientNames: r.client_names || [] }));
  }

  /**
   * Every matter id matching the same filters `listMattersPaged` would apply,
   * ignoring pagination. Backs the grid's "select all", where the user means the
   * whole filtered set rather than the page in front of them.
   *
   * Deliberately id-only: no enrichment joins, no ORDER BY (a selection is a set),
   * so the cost is one index scan over `matters` regardless of how many match.
   *
   * `max` bounds the answer. One extra row is fetched to detect the overflow, so a
   * caller can tell "exactly max matched" from "more than max matched" and say so
   * instead of silently selecting a subset.
   *
   * @returns {Promise<{ ids: string[], truncated: boolean }>}
   */
  async listMatterIds(lawFirmId: string, userId: string, { max = 5000, ...filters }: any = {}) {
    const { whereSql, params } = buildMatterListWhere(lawFirmId, userId, filters);
    params.push(max + 1);
    const { rows } = await tenantParameterizedQuery(matters, lawFirmId,
      `select c.id from matters c where ${whereSql} limit $${params.length}`,
      params,
      'c',
    );
    return { ids: rows.slice(0, max).map((r: any) => r.id), truncated: rows.length > max };
  }

  /**
   * Slim typeahead source for matter pickers. Deliberately does NOT reuse
   * LIST_MATTER_SELECT: a dropdown needs a label and a disambiguating subtitle,
   * not the full enriched matter with its lateral JOINs.
   *
   * Two strictly exclusive modes:
   *  - `ids` given: resolve exactly those matters (used to label an already-saved
   *    selection that isn't in the current search results).
   *  - otherwise: substring search over name + matter number.
   *
   * `seeAll` mirrors the service's canViewAllMatters: false keeps the caller
   * membership-scoped so the ethical wall holds inside pickers too.
   *
   * `clientId` narrows the result to matters linked to that client via
   * `matter_clients`. It is an ADDITIONAL predicate, ANDed with the wall rather
   * than replacing it, so a scoped picker can never widen what the user may see.
   * Scoping matters here is a correctness requirement, not a convenience: a trust
   * transaction picker that offered every firm matter would let one client's IOLTA
   * movement be attributed to another client's matter.
   *
   * `full` swaps the slim row for the complete enriched matter (the same entity
   * the list and detail reads return), for the one picker that feeds its selection
   * into template placeholder auto-fill and needs more than a label. The
   * enrichment runs as a second pass over ONLY the ids the slim visibility query
   * already returned, so it cannot reach a matter the wall excluded. Enriched
   * items keep `label`/`sublabel` alongside the matter fields so the same picker
   * component renders either shape.
   *
   * Fetches limit+1 rows so the caller can report `hasMore` without a count.
   */
  async lookupMatters(lawFirmId: string, { userId, seeAll = false, search, exactName, ids, clientId, limit = 20, full = false }: any = {}) {
    const where = [`m.law_firm_id = $1`];
    const params: unknown[] = [lawFirmId];

    if (!seeAll) {
      params.push(userId);
      where.push(`exists (select 1 from matter_members mm
                           where mm.matter_id = m.id and mm.user_id = $${params.length})`);
    }

    if (clientId !== undefined && clientId !== null && clientId !== '') {
      const rawList = Array.isArray(clientId)
        ? clientId
        : typeof clientId === 'string'
          ? clientId.split(',')
          : [clientId];
      const clientIdList = rawList.map((id: any) => String(id).trim()).filter(isUuid);
      if (!clientIdList.length) return { items: [], hasMore: false };
      params.push(clientIdList);
      where.push(`exists (select 1 from matter_clients mc2
                           where mc2.matter_id = m.id
                             and mc2.law_firm_id = m.law_firm_id
                             and mc2.client_id = any($${params.length}::uuid[]))`);
    }

    const wantsIdResolution = Array.isArray(ids) && ids.length > 0;
    const idList = wantsIdResolution ? ids.filter(isUuid) : [];

    if (wantsIdResolution) {
      // An id-resolution request that matches nothing must return nothing. Falling
      // through to the search branch here would answer "label these specific
      // matters" with an arbitrary page of unrelated ones, so a picker holding a
      // stale or malformed id would display the wrong matter as its selection.
      if (!idList.length) return { items: [], hasMore: false };
      params.push(idList);
      where.push(`m.id = any($${params.length}::uuid[])`);
    } else if (typeof exactName === 'string' && exactName.trim()) {
      params.push(exactName.trim());
      where.push(`lower(btrim(m.name)) = lower($${params.length})`);
    } else {
      const term = toIlikeTerm(search);
      if (term) {
        params.push(term);
        const p = params.length;
        // Client name is part of the search because a firm looks a matter up by
        // whose matter it is at least as often as by its name or number, and the
        // rows already display their clients in `sublabel`, so a client-name hit
        // is visible in the result rather than looking unrelated.
        // UNION of index-friendly arms; see the matching comment on the main
        // matters list predicate above and migration 0141's benchmark.
        where.push(`m.id in (
                       select id from matters where law_firm_id = $1 and name ilike $${p} escape '\\'
                 union select id from matters where law_firm_id = $1 and matter_number ilike $${p} escape '\\'
                 union select mcs.matter_id from matter_clients mcs
                        join clients cls on cls.id = mcs.client_id and cls.law_firm_id = $1
                       where mcs.law_firm_id = $1 and cls.name ilike $${p} escape '\\'
                     )`);
      }
    }

    const lim = clampLimit(limit, { fallback: 20, max: 50 });
    params.push(lim + 1);

    // court_id/court_name ride along because task forms prefill the task's court
    // from the chosen matter. Two scalar columns on <=51 rows, not an enrichment JOIN.
    const { rows } = await tenantParameterizedQuery(matters, lawFirmId,
      `select m.id, m.name, m.matter_number, m.status, m.court_id,
              (select name from courts where id = m.court_id) as court_name,
              (select string_agg(cl.name, ', ' order by cl.name)
                 from matter_clients mc
                 join clients cl on cl.id = mc.client_id
                where mc.matter_id = m.id) as client_names
         from matters m
        where ${where.join(' and ')}
        order by m.name asc nulls last, m.created_at desc
        limit $${params.length}`,
      params,
      'm',
    );

    const hasMore = rows.length > lim;
    const pageRows = rows.slice(0, lim);

    if (full) {
      const enriched = await this.findByIdsRaw(lawFirmId, pageRows.map((r: any) => r.id));
      const byId = new Map(enriched.map((matter: any) => [matter.id, matter]));
      return {
        items: pageRows
          .map((r: any) => {
            const matter = byId.get(r.id);
            if (!matter) return null;
            return { ...matter, label: r.name || 'Unnamed Matter', sublabel: r.client_names || null };
          })
          .filter(Boolean),
        hasMore,
      };
    }

    return {
      items: pageRows.map((r: any) => ({
        id: r.id,
        label: r.name || 'Unnamed Matter',
        sublabel: r.client_names || null,
        matterNumber: r.matter_number || null,
        status: r.status || null,
        courtId: r.court_id || null,
        courtName: r.court_name || null,
      })),
      hasMore,
    };
  }

  /**
   * Count the matter's billing records (matter-context invoices, time entries,
   * flat fees, expenses). Used to block deletion so a matter's financial history
   * isn't silently destroyed by the DB `on delete cascade`. Mirrors the client
   * repo's countBillingRecords.
   */
  async countBillingRecords(lawFirmId: string, matterId: string) {
    const { rows } = await tenantParameterizedQuery(invoices, lawFirmId,
      `select
         (select count(*) from invoices inv where inv.law_firm_id = $1 and inv.matter_id = $2)
       + (select count(*) from activities a where a.law_firm_id = $1 and a.matter_id = $2) as n`,
      [lawFirmId, matterId],
      'inv',
    );
    return Number(rows[0]?.n || 0);
  }

  /** Subset of `matterIds` that exist within the firm (one query). */
  async filterExistingMatterIds(lawFirmId: string, matterIds: string[]) {
    const ids = (matterIds || []).filter(isUuid);
    if (!ids.length) return new Set();
    const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
      .select({ id: matters.id }).from(matters).where(and(scope, inArray(matters.id, ids))));
    return new Set(rows.map((r: any) => r.id));
  }

  /**
   * Add one user to many matters in a single statement. Returns the matter_ids that
   * were newly inserted (existing memberships left untouched). The caller still
   * emits a per-matter MATTER_MEMBERS_UPDATED event for each inserted matter.
   */
  async addMemberToMatters(lawFirmId: string, matterIds: string[], userId: string, { role = 'member' }: any = {}) {
    const ids = (matterIds || []).filter(isUuid);
    if (!ids.length || !userId) return [];
    const rows = await scopedInsertManyOnConflictDoNothing(
      matterMembers,
      lawFirmId,
      ids.map((matterId: string) => ({ matterId, userId, role, joinedAt: new Date() })),
      [matterMembers.matterId, matterMembers.userId],
    );
    return rows.map((row) => row.matterId);
  }

  /** Subset of `matterIds` where `userId` is already a member (one query). */
  async filterMatterIdsWithMember(lawFirmId: string, matterIds: string[], userId: string) {
    const ids = (matterIds || []).filter(isUuid);
    if (!ids.length || !userId) return new Set();
    const rows = await tenantQuery(matterMembers, lawFirmId, ({ executor, scope }) => executor
      .select({ matterId: matterMembers.matterId })
      .from(matterMembers)
      .where(and(scope, inArray(matterMembers.matterId, ids), eq(matterMembers.userId, userId))));
    return new Set(rows.map((r: any) => r.matterId));
  }

  /** Member user-ids for many matters at once: { matterId: [userId, ...] }. */
  async getMemberUserIdsForMatters(lawFirmId: string, matterIds: string[]) {
    const ids = (matterIds || []).filter(isUuid);
    if (!ids.length) return {};
    const rows = await tenantQuery(matterMembers, lawFirmId, ({ executor, scope }) => executor
      .select({ matterId: matterMembers.matterId, userId: matterMembers.userId })
      .from(matterMembers).where(and(scope, inArray(matterMembers.matterId, ids))));
    const byMatter: Record<string, any> = {};
    for (const row of rows) (byMatter[row.matterId] ||= []).push(row.userId);
    return byMatter;
  }

  /** { clientIds, clientNames } for event payloads. */
  async getMatterClientsSummary(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return { clientIds: [], clientNames: [] };
    const rows = await tenantQuery(matterClients, lawFirmId, ({ executor, scope }) => executor
      .select({ id: clients.id, name: clients.name }).from(matterClients)
      .innerJoin(clients, and(
        eq(clients.id, matterClients.clientId),
        eq(clients.lawFirmId, matterClients.lawFirmId),
      )).where(and(scope, eq(matterClients.matterId, matterId))));
    return {
      clientIds: rows.map((r: any) => r.id),
      clientNames: rows.map((r: any) => r.name || 'Unknown'),
    };
  }

  /** Full matterClients list (JOIN clients) for the matterClients endpoint. */
  async listMatterClients(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return [];
    const rows = await tenantQuery(matterClients, lawFirmId, ({ executor, scope }) => executor
      .select(MATTER_CLIENT_COLUMNS).from(matterClients).innerJoin(clients, and(
        eq(clients.id, matterClients.clientId),
        eq(clients.lawFirmId, matterClients.lawFirmId),
      )).where(and(scope, eq(matterClients.matterId, matterId))).orderBy(asc(clients.name)));
    return rows.map(toMatterClient);
  }

  /**
   * The same rows `listMatterClients` returns, for MANY matters, in one query:
   * `{ [matterId]: [client, ...] }`.
   *
   * Every API instance shares a 12-connection pool, so a caller holding a list of
   * matters (an invoice run covering every unbilled matter) cannot afford a round
   * trip each. Both reads project the same columns and shape their rows through
   * the same function, so the batched answer is the per-matter answer, matter by
   * matter, rather than a second definition of it that can drift.
   *
   * A matter id with no clients gets an empty array rather than no key, so the
   * caller can tell "this matter has no clients" from "you cannot see this
   * matter", which is a distinction the access check above this makes and the
   * grouping alone would lose.
   */
  async listMatterClientsForMatters(lawFirmId: string, matterIds: string[]) {
    const ids = (matterIds || []).filter(isUuid);
    if (!ids.length) return {};
    const rows = await tenantQuery(matterClients, lawFirmId, ({ executor, scope }) => executor
      .select({ matterId: matterClients.matterId, ...MATTER_CLIENT_COLUMNS })
      .from(matterClients).innerJoin(clients, and(
        eq(clients.id, matterClients.clientId),
        eq(clients.lawFirmId, matterClients.lawFirmId),
      )).where(and(scope, inArray(matterClients.matterId, ids))).orderBy(asc(clients.name)));
    const byMatter: Record<string, any[]> = {};
    for (const id of ids) byMatter[id] = [];
    for (const row of rows) byMatter[(row as any).matterId].push(toMatterClient(row));
    return byMatter;
  }

  // ── matter_members junction ops ─────────────────────────────────────
  async getMemberUserIds(lawFirmId: string, matterId: string, txExecutor?: any) {
    const rows = await tenantQuery(matterMembers, lawFirmId, ({ executor, scope }) => executor
      .select({ userId: matterMembers.userId }).from(matterMembers)
      .where(and(scope, eq(matterMembers.matterId, matterId))), txExecutor);
    return rows.map((row) => row.userId);
  }

  async getMember(lawFirmId: string, matterId: string, userId: string) {
    const rows = await tenantQuery(matterMembers, lawFirmId, ({ executor, scope }) => executor
      .select().from(matterMembers).where(and(
        scope, eq(matterMembers.matterId, matterId), eq(matterMembers.userId, userId),
      )).limit(1));
    return rows[0] || null;
  }

  /** Insert a member if absent; update role if present and role provided. Returns true if inserted. */
  async upsertMember(lawFirmId: string, matterId: string, userId: string, { role = 'member', executor = rootQueryExecutor }: any = {}) {
    const match = and(eq(matterMembers.matterId, matterId), eq(matterMembers.userId, userId))!;
    const updated = await scopedUpdate(matterMembers, lawFirmId, match, { role }, executor);
    if (updated.length) return false;
    const inserted = await scopedInsertManyOnConflictDoNothing(
      matterMembers,
      lawFirmId,
      [{ matterId, userId, role, joinedAt: new Date() }],
      [matterMembers.matterId, matterMembers.userId],
      undefined,
      executor,
    );
    if (inserted.length) return true;
    await scopedUpdate(matterMembers, lawFirmId, match, { role }, executor);
    return false;
  }

  /** Subset of the given user ids that are members of this firm. */
  async filterFirmMemberIds(lawFirmId: string, userIds: string[]) {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return new Set();
    const rows = await tenantQuery(members, lawFirmId, ({ executor, scope }) => executor
      .select({ userId: members.userId }).from(members)
      .where(and(scope, inArray(members.userId, ids as string[]))));
    return new Set(rows.map((row) => row.userId));
  }

  /** Subset of the given user ids that are members of THIS matter. */
  async filterMatterMemberIds(lawFirmId: string, matterId: string, userIds: string[]) {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!isUuid(matterId) || !ids.length) return new Set();
    const rows = await tenantQuery(matterMembers, lawFirmId, ({ executor, scope }) => executor
      .select({ userId: matterMembers.userId }).from(matterMembers).where(and(
        scope, eq(matterMembers.matterId, matterId), inArray(matterMembers.userId, ids as string[]),
      )));
    return new Set(rows.map((row) => row.userId));
  }

  /** Upsert each user as a matter member with the `lead` role (batch). */
  async upsertLeads(lawFirmId: string, matterId: string, userIds: string[], executor = rootQueryExecutor) {
    const ids = [...new Set<string>((userIds || []).filter(Boolean) as string[])];
    if (!isUuid(matterId) || !ids.length) return;
    await scopedUpdate(matterMembers, lawFirmId, and(
      eq(matterMembers.matterId, matterId), inArray(matterMembers.userId, ids),
    )!, { role: 'lead' }, executor);
    await scopedInsertManyOnConflictDoNothing(
      matterMembers,
      lawFirmId,
      ids.map((userId) => ({ matterId, userId, role: 'lead', joinedAt: new Date() })),
      [matterMembers.matterId, matterMembers.userId],
      undefined,
      executor,
    );
  }

  /** Demote every `lead` member NOT in `keepUserIds` back to `member`. */
  async demoteLeadsExcept(lawFirmId: string, matterId: string, keepUserIds: any) {
    if (!isUuid(matterId)) return;
    const keep = [...new Set((keepUserIds || []).filter(Boolean))];
    if (keep.length) {
      await scopedUpdate(matterMembers, lawFirmId, and(
        eq(matterMembers.matterId, matterId), eq(matterMembers.role, 'lead'),
        notInArray(matterMembers.userId, keep as string[]),
      )!, { role: 'member' });
    } else {
      await scopedUpdate(matterMembers, lawFirmId, and(
        eq(matterMembers.matterId, matterId), eq(matterMembers.role, 'lead'),
      )!, { role: 'member' });
    }
  }

  /**
   * Replace a matter's lead set with exactly `leadUserIds`: promote each to the
   * `lead` role, demote any prior lead not in the list. A matter may have zero,
   * one, or many leads; the lead is an accountability attribute, not an access gate.
   */
  async syncMatterLeads(lawFirmId: string, matterId: string, leadUserIds: string[]) {
    const ids = [...new Set((leadUserIds || []).filter(Boolean))];
    await this.upsertLeads(lawFirmId, matterId, ids);
    await this.demoteLeadsExcept(lawFirmId, matterId, ids);
  }

  /**
   * Point matters.lead_user_id at a current `lead` member (the earliest-joined,
   * i.e. the primary), or NULL if the matter has no leads. Keeps the scalar
   * column consistent with the matter_members role rows for member add/remove
   * paths that touch lead roles without going through syncMatterLeads.
   */
  async reconcileLeadColumn(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return;
    await scopedUpdate(matters, lawFirmId, eq(matters.id, matterId), {
      leadUserId: sql`(
        select ${matterMembers.userId} from ${matterMembers}
         where ${matterMembers.lawFirmId} = ${lawFirmId}
           and ${matterMembers.matterId} = ${matterId}
           and ${matterMembers.role} = 'lead'
         order by ${matterMembers.joinedAt} nulls last, ${matterMembers.userId}
         limit 1
      )`,
    });
  }

  /**
   * Batch upsert members. Inserts all `(matterId, userId)` rows in one statement;
   * existing rows are left untouched (role NOT changed on conflict, matching the
   * `addMembers` semantics that only count genuinely-new inserts). Returns the
   * list of user_ids that were newly inserted (so the caller can emit the right
   * `addedUserIds`).
   */
  async upsertMembers(lawFirmId: string, matterId: string, userIds: string[], { role = 'member' }: any = {}) {
    const ids = Array.from(new Set((userIds || []).filter(Boolean)));
    if (!isUuid(matterId) || !ids.length) return [];
    const rows = await scopedInsertManyOnConflictDoNothing(
      matterMembers,
      lawFirmId,
      (ids as string[]).map((userId) => ({ matterId, userId, role, joinedAt: new Date() })),
      [matterMembers.matterId, matterMembers.userId],
    );
    return rows.map((row) => row.userId);
  }

  async removeMembers(lawFirmId: string, matterId: string, userIds: string[], executor?: any) {
    if (!userIds?.length) return [];
    const rows = await scopedDelete(matterMembers, lawFirmId, and(
      eq(matterMembers.matterId, matterId), inArray(matterMembers.userId, userIds),
    )!, executor);
    return rows.map((row) => row.userId);
  }

  async updateMemberHourlyRate(lawFirmId: string, matterId: string, userId: string, hourlyRate: any) {
    const rows = await scopedUpdate(matterMembers, lawFirmId, and(
      eq(matterMembers.matterId, matterId), eq(matterMembers.userId, userId),
    )!, { hourlyRateCents: dollarsToCents(hourlyRate) });
    return rows.length > 0;
  }

  /** How many notes a matter has, for the notes tab badge. */
  async countMatterNotes(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return 0;
    const rows = await tenantQuery(notes, lawFirmId, ({ executor, scope }) => executor
      .select({ total: sql<number>`count(*)` }).from(notes)
      .where(and(scope, eq(notes.matterId, matterId))));
    return Number(rows[0].total) || 0;
  }

  /**
   * One page of the firm's notes across every matter the reader can see.
   *
   * The visibility predicate is part of the query rather than a filter applied
   * afterwards: narrowing a page that was already selected would silently
   * shrink pages and make the total wrong. Owners/admins skip the
   * matter-membership join entirely, since they can see every matter anyway.
   */
  async getFirmNotes(lawFirmId: string, { userId, seesAllMatters, page, limit, offset, matterId, ...filters }: any = {}) {
    const { formatNote } = require('./notes/matterNotes.repository');
    const visibility = seesAllMatters
      ? ''
      : ` and exists (
            select 1 from matter_members mm
             where mm.law_firm_id = notes.law_firm_id
               and mm.matter_id = notes.matter_id
               and mm.user_id = $3
          )`;
    const baseParams: any[] = [lawFirmId, matterId && isUuid(matterId) ? matterId : null];
    if (!seesAllMatters) baseParams.push(userId);

    const scopeSql = `notes.law_firm_id = $1
        and ($2::uuid is null or notes.matter_id = $2::uuid)${visibility}`;

    return readNotesPage({
      query: (text: string, params: unknown[]) => tenantParameterizedQuery(
        notes, lawFirmId, text, params,
      ),
      baseParams,
      filters,
      columns: MATTER_NOTE_COLUMNS,
      paging: { page, limit, offset },
      selectSql: (where: any, pageClause: any) =>
        `select notes.*, m.name as matter_name, m.matter_number,
                author.name as created_by_name,
                editor.name as edited_by_name,
                count(*) over() as total_count
           from notes
           join matters m on m.law_firm_id = notes.law_firm_id
                         and m.id = notes.matter_id
           left join users author on author.id = notes.created_by
           left join users editor on editor.id = notes.edited_by
          where ${scopeSql}${where}
          order by notes.note_date desc, notes.created_at desc, notes.id desc${pageClause}`,
      countSql: (where: any) =>
        `select count(*) as total from notes
           join matters m on m.law_firm_id = notes.law_firm_id
                         and m.id = notes.matter_id
          where ${scopeSql}${where}`,
      format: (row: any) => ({
        ...formatNote(row),
        matterId: row.matterId,
        matterName: row.matterName || null,
        matterNumber: row.matterNumber || null,
      }),
    });
  }

  /**
   * All / with-time / without-time counts for the firm-wide notes page, over
   * the same visibility and filters `getFirmNotes` uses (minus the time
   * filter, which these describe).
   *
   * No join to `matters` needed: the visibility and filter predicates only
   * reference `notes` and `matter_members`.
   */
  async getFirmNoteCounts(lawFirmId: string, { userId, seesAllMatters, matterId, ...filters }: any = {}) {
    const visibility = seesAllMatters
      ? ''
      : ` and exists (
            select 1 from matter_members mm
             where mm.law_firm_id = notes.law_firm_id
               and mm.matter_id = notes.matter_id
               and mm.user_id = $3
          )`;
    const baseParams: any[] = [lawFirmId, matterId && isUuid(matterId) ? matterId : null];
    if (!seesAllMatters) baseParams.push(userId);
    const scopeSql = `notes.law_firm_id = $1
        and ($2::uuid is null or notes.matter_id = $2::uuid)${visibility}`;

    return readNoteTimeCounts({
      query: (text: string, params: unknown[]) => tenantParameterizedQuery(
        notes, lawFirmId, text, params,
      ),
      baseParams,
      filters,
      columns: MATTER_NOTE_COLUMNS,
      countSql: (where: any, extra: any) =>
        `select count(*) as total${extra ? `, ${extra}` : ''} from notes
          where ${scopeSql}${where}`,
    });
  }

  /**
   * Find an existing firm client (by linked userId) or create a new client row,
   * mirroring the legacy matterClients behaviour of always backing a matter-client
   * with a firm-level client record. Returns the client uuid.
   *
   * `c.clientType === 'company'` creates a company client instead of a person:
   * `c.name` is the company's own legal name (never `clients.user_id`, per the
   * DB invariant, and `c.email`/`c.phone`/`c.organization` are ignored - they
   * describe a person, not the organization). An optional `c.rosterContact =
   * { name, email, phone }` creates that company's first linked person - a
   * brand-new Person `clients` row plus a `client_company_links` row
   * (mirroring `clients.service.ts`'s `createClientContact`) - in the SAME
   * transaction as the company insert: if either half fails, neither persists.
   */
  async findOrCreateClientForMatter(lawFirmId: string, c: any, actingUserId: string) {
    const isCompany = c.clientType === 'company';
    const name = (c.name || '').trim();
    const email = (c.email || '').trim().toLowerCase() || null;

    if (!isCompany && c.userId) {
      const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
        .select({ id: clients.id }).from(clients)
        .where(and(scope, eq(clients.userId, c.userId))).limit(1));
      if (rows[0]) {
        // Reuse the existing firm client as-is. Do NOT overwrite its stored
        // `name` on match. Two matters supplying different display names for the
        // same user-linked client would otherwise clobber each other. The name is
        // only set when the client row is first inserted (below).
        return rows[0].id;
      }
    }

    // A company has no `user_id` to match on, so this path used to insert
    // unconditionally: every matter and every converted lead naming the same
    // organization produced another "Acme Corp" row, each with its own roster,
    // its own canonical conversation and its own invoices. Match an existing
    // company by normalized name instead, case-insensitively.
    // Companies only -- a person sharing a name is a different person, which is
    // why the person branch above keys on `user_id` and nothing else. Oldest
    // match wins, for stability. An ARCHIVED company is skipped: the firm put it
    // away, so new work under that name gets a live record rather than reviving
    // one.
    if (isCompany && name) {
      const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
        .select({ id: clients.id }).from(clients)
        .where(and(
          scope,
          eq(clients.clientType, 'company'),
          ne(clients.status, 'archived'),
          eq(sql`lower(${clients.name})`, name.toLowerCase()),
        ))
        .orderBy(asc(clients.createdAt), asc(clients.id))
        .limit(1));
      if (rows[0]) {
        // Reusing the company must not lose the person who came with this
        // request. Add them to the existing roster instead, unless someone with
        // the same address is already on it. Not primary and not a billing
        // recipient: the company already has both, and a second lead from the
        // same organization must not quietly redirect its invoices.
        if (c.rosterContact) {
          await this.addRosterContactToCompany(lawFirmId, rows[0].id, c.rosterContact, actingUserId);
        }
        return rows[0].id;
      }
    }

    return withDrizzleTransaction(async (conn: any) => {
      const clientRows = await scopedInsert(clients, lawFirmId, {
        clientType: isCompany ? 'company' : 'person',
        userId: isCompany ? null : (c.userId || null),
        name: name || email || (isCompany ? 'Unnamed Organization' : 'Unnamed Client'),
        email: isCompany ? null : email,
        phone: isCompany ? null : ((c.phone || '').trim() || null),
        organization: isCompany ? null : (c.organization || null),
        address: c.address || null,
        preferredContactMethod: contactMethodOrDefault(c.preferredContactMethod),
        status: 'active',
      }, conn);
      const clientId = clientRows[0].id;

      const rosterContact = c.rosterContact;
      if (isCompany && rosterContact) {
        const contactName = (rosterContact.name || '').trim();
        const contactEmail = (rosterContact.email || '').trim().toLowerCase() || null;
        const personRows = await scopedInsert(clients, lawFirmId, {
          clientType: 'person',
          name: contactName || contactEmail || 'Unnamed Client',
          email: contactEmail,
          phone: (rosterContact.phone || '').trim() || null,
          status: 'active',
        }, conn);
        await scopedInsert(clientCompanyLinks, lawFirmId, {
          personClientId: personRows[0].id,
          companyClientId: clientId,
          isPrimary: true,
          // The company's own `email` is deliberately null (that column
          // describes a person), so this contact is the only address the
          // organization has. `is_email_recipient` defaults to false, which left
          // every company created this way with no billing recipient at all: the
          // first attempt to send its invoice failed and a firm member had to
          // find the flag by hand. The sole primary contact IS the billing
          // recipient until the firm says otherwise.
          isEmailRecipient: true,
          createdBy: actingUserId,
        }, conn);
      }

      return clientId;
    });
  }

  /**
   * Add one incoming contact to an EXISTING company's roster, for the
   * find-or-create paths that matched a company rather than creating it.
   *
   * Deduped on the contact's email against the company's current roster, so
   * converting several leads from the same organization, or naming the same
   * person on two matters, does not stack duplicate people onto it. A contact
   * with no email cannot be matched against anyone, so it is added as given.
   *
   * Never primary and never a billing recipient: those belong to whoever the
   * firm already designated on this company, and a later arrival must not
   * silently take over where its invoices go.
   */
  async addRosterContactToCompany(lawFirmId: string, companyClientId: any, rosterContact: any, actingUserId: string, executor: any = null) {
    const contactName = (rosterContact?.name || '').trim();
    const contactEmail = (rosterContact?.email || '').trim().toLowerCase() || null;
    if (!contactName && !contactEmail) return null;

    if (contactEmail) {
      const existing = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor: queryExecutor, scope }) => queryExecutor
        .select({ id: clients.id })
        .from(clientCompanyLinks)
        .innerJoin(clients, and(
          eq(clients.id, clientCompanyLinks.personClientId),
          eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
        ))
        .where(and(
          scope,
          eq(clientCompanyLinks.companyClientId, companyClientId),
          eq(sql`lower(${clients.email}::text)`, contactEmail),
        ))
        .limit(1), executor || undefined);
      if (existing[0]) return existing[0].id;
    }

    // The person and their link go in together or not at all. `executor` carries
    // the caller's own transaction connection when it has one: opening a second
    // transaction from the pool inside an open one would put these two writes on
    // a different connection from the client insert they belong with.
    const insertBoth = async (conn: any) => {
      const personRows = await scopedInsert(clients, lawFirmId, {
        clientType: 'person',
        name: contactName || contactEmail || 'Unnamed Client',
        email: contactEmail,
        phone: (rosterContact?.phone || '').trim() || null,
        status: 'active',
      }, conn);
      await scopedInsert(clientCompanyLinks, lawFirmId, {
        personClientId: personRows[0].id,
        companyClientId,
        createdBy: actingUserId,
      }, conn);
      return personRows[0].id;
    };
    return executor ? insertBoth(executor) : withDrizzleTransaction(insertBoth);
  }

  /**
   * Batched find-or-create for a list of matter clients (the create path). Mirrors
   * `findOrCreateClientForMatter` but collapses N round-trips into at most two:
   *   1. one query resolves every userId-linked client that already exists, and
   *   2. one multi-row insert creates every remaining client (each carrying its
   *      own contact fields).
   * Returns the resolved client uuids in the SAME ORDER as the input `clients`.
   * Existing user-linked clients are reused as-is (name is never overwritten).
   *
   * An item with `c.clientType === 'company'` and a `c.rosterContact = { name,
   * email, phone }` also gets a first linked person created (a Person `clients`
   * row plus a `client_company_links` row) for that company, in the SAME
   * transaction as the client insert (both callers already run this inside
   * `withDrizzleTransaction`, so `executor` is always the transaction connection
   * in practice). This is opt-in: a caller that never sets `rosterContact` (e.g.
   * `matterClients.service.ts`'s ordinary add-company-client flow, where the
   * firm types the company's own email/phone directly onto its row) keeps its
   * existing behaviour unchanged.
   */
  async findOrCreateClientsForMatter(lawFirmId: string, clientInputs: any, executor = rootQueryExecutor) {
    const list = Array.isArray(clientInputs) ? clientInputs : [];
    if (!list.length) return [];

    // 1a. Reuse explicitly-chosen existing firm clients by their real id. The
    // "add existing client" UI sends the chosen clients.id; verify each id truly
    // belongs to this firm before trusting it (don't reuse another firm's row).
    const explicitIds = Array.from(new Set(list.map((c) => c.clientId).filter(isUuid)));
    const validClientIds = new Set();
    if (explicitIds.length) {
      const rows = await tenantQuery(clients, lawFirmId, ({ executor: queryExecutor, scope }) => queryExecutor
        .select({ id: clients.id }).from(clients)
        .where(and(scope, inArray(clients.id, explicitIds as string[]))), executor);
      for (const r of rows) validClientIds.add(r.id);
    }

    // 1b. Resolve remaining existing clients for the linked userIds in one query.
    const userIds = Array.from(new Set(list.map((c) => c.userId).filter(Boolean)));
    const existingByUserId: Record<string, any> = {};
    if (userIds.length) {
      const rows = await tenantQuery(clients, lawFirmId, ({ executor: queryExecutor, scope }) => queryExecutor
        .selectDistinctOn([clients.userId], { id: clients.id, userId: clients.userId })
        .from(clients).where(and(scope, inArray(clients.userId, userIds as string[])))
        .orderBy(clients.userId, asc(clients.createdAt)), executor);
      for (const row of rows) if (row.userId) existingByUserId[row.userId] = row.id;
    }

    // 1c. Match companies named inline against the firm's existing companies.
    // A company has no userId to resolve on, so a typed name that already
    // belongs to a client used to insert a second row for the same
    // organization, each with its own roster, conversation and invoices.
    // Case-insensitive on the name, companies only, oldest match wins.
    const companyNames = Array.from(new Set(list
      .filter((c) => c.clientType === 'company' && !isUuid(c.clientId))
      .map((c) => (c.name || '').trim().toLowerCase())
      .filter(Boolean)));
    const existingCompanyByName: Record<string, any> = {};
    if (companyNames.length) {
      const rows = await tenantQuery(clients, lawFirmId, ({ executor: queryExecutor, scope }) => queryExecutor
        .selectDistinctOn([sql`lower(${clients.name})`], { id: clients.id, name: clients.name })
        .from(clients)
        .where(and(
          scope,
          eq(clients.clientType, 'company'),
          ne(clients.status, 'archived'),
          inArray(sql`lower(${clients.name})`, companyNames),
        ))
        .orderBy(sql`lower(${clients.name})`, asc(clients.createdAt)), executor);
      for (const row of rows) existingCompanyByName[(row.name || '').trim().toLowerCase()] = row.id;
    }

    // 2. Resolve in order; collect the ones that still need inserting.
    const result = new Array(list.length).fill(null);
    const toInsert: any[] = [];
    const rosterOntoExisting: any[] = [];
    list.forEach((c, idx) => {
      const companyMatch = c.clientType === 'company' && !isUuid(c.clientId)
        ? existingCompanyByName[(c.name || '').trim().toLowerCase()]
        : null;
      if (c.clientId && validClientIds.has(c.clientId)) {
        result[idx] = c.clientId;
        // A company chosen by id takes the request's contact onto its roster,
        // the same as one matched by name below.
        if (c.clientType === 'company' && c.rosterContact) rosterOntoExisting.push({ companyClientId: c.clientId, c });
      } else if (c.userId && existingByUserId[c.userId]) {
        result[idx] = existingByUserId[c.userId];
      } else if (companyMatch) {
        result[idx] = companyMatch;
        // Reusing the company must not drop the contact that came with this
        // request; add them to the existing roster after the inserts below.
        if (c.rosterContact) rosterOntoExisting.push({ companyClientId: companyMatch, c });
      } else {
        toInsert.push({ idx, c });
      }
    });

    if (toInsert.length) {
      const values = toInsert.map(({ c }) => {
        const name = (c.name || '').trim();
        const email = (c.email || '').trim().toLowerCase() || null;
        const clientType = c.clientType === 'company' ? 'company' : 'person';
        return {
          clientType,
          // A company can never carry clients.user_id directly (DB invariant);
          // the caller (matterClients.service.ts) already withholds userId for
          // a company request, but this stays defensive against a future caller
          // that doesn't.
          userId: clientType === 'company' ? null : (c.userId || null),
          name: name || email || 'Unnamed Client',
          email,
          phone: (c.phone || '').trim() || null,
          organization: c.organization || null,
          address: c.address || null,
          preferredContactMethod: contactMethodOrDefault(c.preferredContactMethod),
          status: 'active',
        };
      });
      const rows = await scopedInsertMany(clients, lawFirmId, values, executor);
      // Postgres returns inserted rows in the VALUES order, so map 1:1 back.
      toInsert.forEach(({ idx }, i) => { result[idx] = rows[i].id; });

      // Create the opt-in first linked person for any freshly-inserted company
      // client that asked for one. Sequential (not concurrent) since these share
      // one transaction connection.
      for (let i = 0; i < toInsert.length; i += 1) {
        const { c } = toInsert[i];
        const rosterContact = c.rosterContact;
        if (values[i].clientType !== 'company' || !rosterContact) continue;
        const clientId = rows[i].id;
        const contactName = (rosterContact.name || '').trim();
        const contactEmail = (rosterContact.email || '').trim().toLowerCase() || null;
        // eslint-disable-next-line no-await-in-loop
        const personRows = await scopedInsert(clients, lawFirmId, {
          clientType: 'person',
          name: contactName || contactEmail || 'Unnamed Client',
          email: contactEmail,
          phone: (rosterContact.phone || '').trim() || null,
          status: 'active',
        }, executor);
        // eslint-disable-next-line no-await-in-loop
        await scopedInsert(clientCompanyLinks, lawFirmId, {
          personClientId: personRows[0].id,
          companyClientId: clientId,
          isPrimary: true,
          // See findOrCreateClientForMatter: the company's own `email` column is
          // never populated, so this sole primary contact is the organization's
          // only billing address. Left at the schema default of false, every
          // company created here had no billing recipient and its first invoice
          // send failed.
          isEmailRecipient: true,
          createdBy: c.actingUserId || null,
        }, executor);
      }
    }

    // Contacts belonging to a company this call matched rather than created.
    for (const { companyClientId, c } of rosterOntoExisting) {
      // eslint-disable-next-line no-await-in-loop -- shares one transaction connection
      await this.addRosterContactToCompany(lawFirmId, companyClientId, c.rosterContact, c.actingUserId || null, executor);
    }

    return result;
  }

  /** Batch-insert firm client rows from `{ name }` shapes; returns inserted ids in order. */
  async createClientsByName(lawFirmId: string, names: any, executor = rootQueryExecutor) {
    const clean = (names || []).map((n: any) => (n || '').trim()).filter(Boolean);
    if (!clean.length) return [];
    const rows = await scopedInsertMany(clients, lawFirmId, clean.map((name: string) => ({ clientType: 'person', name, status: 'active' })), executor);
    return rows.map((r: any) => r.id);
  }

  /** Batch-link multiple clients to a matter (idempotent). */
  async addMatterClients(lawFirmId: string, matterId: string, clientIds: string[], executor = rootQueryExecutor) {
    const ids = (clientIds || []).filter(isUuid);
    if (!isUuid(matterId) || !ids.length) return;
    await scopedInsertManyOnConflictDoNothing(
      matterClients,
      lawFirmId,
      ids.map((clientId: string) => ({ matterId, clientId })),
      [matterClients.matterId, matterClients.clientId],
      undefined,
      executor,
    );
  }

  /**
   * Atomically find-or-create the backing firm clients for a matter AND link them
   * via matter_clients in a single BEGIN/COMMIT transaction. Without this, a crash
   * between the client-insert and the matter_clients-insert leaves orphan (unlinked)
   * `clients` rows. Mirrors the find-or-create + link the create path used to run
   * as two separate awaits, now made atomic.
   */
  async findOrCreateClientsAndLinkToMatterTx(lawFirmId: string, matterId: string, clients: any) {
    const list = Array.isArray(clients) ? clients : [];
    if (!list.length) return [];
    return withDrizzleTransaction(async (client: any) => {
      const clientIds = await this.findOrCreateClientsForMatter(lawFirmId, list, client);
      await this.addMatterClients(lawFirmId, matterId, clientIds, client);
      return clientIds;
    });
  }

  /** Look up a platform user by email (users table). Returns { uid, name, email } or null. */
  async findUserByEmail(email: any) {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized) return null;
    const rows = await systemQuery('auth_identity', (executor) => executor
      .select({ id: users.id, name: users.name, email: users.email }).from(users)
      .where(eq(sql`lower(${users.email})`, normalized)).limit(1));
    return rows[0] ? { uid: rows[0].id, name: rows[0].name, email: rows[0].email } : null;
  }

  // ── matter_clients junction ops ─────────────────────────────────────
  async addMatterClient(lawFirmId: string, matterId: string, clientId: string) {
    await scopedInsertManyOnConflictDoNothing(
      matterClients,
      lawFirmId,
      [{ matterId, clientId }],
      [matterClients.matterId, matterClients.clientId],
    );
  }

  /** True if `clientId` is linked to `matterId` within this firm. Guards against IDOR. */
  async isClientLinkedToMatter(lawFirmId: string, matterId: string, clientId: string) {
    if (!isUuid(matterId) || !isUuid(clientId)) return false;
    const rows = await tenantQuery(matterClients, lawFirmId, ({ executor, scope }) => executor
      .select({ id: matterClients.matterId }).from(matterClients).where(and(
        scope, eq(matterClients.matterId, matterId), eq(matterClients.clientId, clientId),
      )).limit(1));
    return rows.length > 0;
  }

  async removeMatterClient(lawFirmId: string, matterId: string, clientId: string) {
    await scopedDelete(matterClients, lawFirmId, and(
      eq(matterClients.matterId, matterId), eq(matterClients.clientId, clientId),
    )!);
  }

  /**
   * Write the billing split for a matter, as clientId -> basis points.
   *
   * One statement per payer inside a single transaction, so a matter is never
   * left with a half-applied split summing to something other than 100%. Passing
   * an empty map clears every portion on the matter, which is how a firm turns
   * split billing back off.
   */
  async setMatterClientBillingPortions(lawFirmId: string, matterId: string, portionsByClientId: any, executor?: any) {
    if (!isUuid(matterId)) return;
    const entries = Object.entries(portionsByClientId || {})
      .filter(([clientId]) => isUuid(clientId))
      .map(([clientId, portion]) => [clientId, Number(portion)] as [string, number]);

    const apply = async (conn: any) => {
      // Clear first, so a client dropped from the split does not keep a stale
      // portion that would make the matter's total exceed 100%.
      await scopedUpdate(
        matterClients,
        lawFirmId,
        eq(matterClients.matterId, matterId),
        { billingPortionBp: null },
        conn,
      );
      for (const [clientId, portion] of entries) {
        await scopedUpdate(
          matterClients,
          lawFirmId,
          and(eq(matterClients.matterId, matterId), eq(matterClients.clientId, clientId))!,
          { billingPortionBp: portion },
          conn,
        );
      }
    };

    if (executor) return apply(executor);
    return withDrizzleTransaction(apply);
  }

  /** Batch-unlink multiple clients from a matter in one statement. */
  async removeMatterClients(lawFirmId: string, matterId: string, clientIds: string[]) {
    const ids = (clientIds || []).filter(isUuid);
    if (!isUuid(matterId) || !ids.length) return;
    await scopedDelete(matterClients, lawFirmId, and(
      eq(matterClients.matterId, matterId), inArray(matterClients.clientId, ids),
    )!);
  }

  // ── validation helpers ────────────────────────────────────────────
  async validatePracticeArea(lawFirmId: string, practiceAreaId: any) {
    if (!isUuid(practiceAreaId)) return null;
    const rows = await tenantQuery(practiceAreas, lawFirmId, ({ executor, scope }) => executor
      .select({ id: practiceAreas.id, name: practiceAreas.name }).from(practiceAreas)
      .where(and(scope, eq(practiceAreas.id, practiceAreaId))).limit(1));
    return rows[0] || null;
  }

  async validateCourt(lawFirmId: string, courtId: any) {
    if (!isUuid(courtId)) return null;
    const rows = await tenantQuery(courts, lawFirmId, ({ executor, scope }) => executor
      .select({ id: courts.id, name: courts.name }).from(courts)
      .where(and(scope, eq(courts.id, courtId))).limit(1));
    return rows[0] || null;
  }

  /** True if `userId` is a member of the firm (owners included). */
  async isFirmMember(lawFirmId: string, userId: string) {
    if (!userId) return false;
    const rows = await tenantQuery(members, lawFirmId, ({ executor, scope }) => executor
      .select({ userId: members.userId }).from(members)
      .where(and(scope, eq(members.userId, userId))).limit(1));
    return rows.length > 0;
  }

  async getUserName(userId: string) {
    if (!userId) return '';
    const rows = await systemQuery('auth_identity', (executor) => executor
      .select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1));
    return rows[0]?.name || '';
  }

  async countMatters(lawFirmId: string, executor?: any) {
    const rows = await tenantQuery(matters, lawFirmId, ({ executor: queryExecutor, scope }) => queryExecutor
      .select({ c: sql<number>`count(*)::int` }).from(matters).where(scope), executor);
    return rows[0].c;
  }

  /**
   * Serialize concurrent matter creates for one firm before the `maxMatters`
   * count check. Counting matters and inserting the new one are two separate
   * statements; without a lock spanning both, two creates racing for the same
   * firm's last open plan slot can each run their count before either commits
   * its insert, each sees the slot as free, and both succeed, over-provisioning
   * the firm's plan.
   *
   * Locking the firm's own row gives every concurrent create for that firm one
   * shared point of contention: the second transaction blocks here until the
   * first commits (or rolls back), and by the time it proceeds, its own count
   * (run on the same executor, so it gets a fresh read-committed snapshot)
   * sees the first transaction's already-committed insert. Same pattern as
   * `invitations.repository.ts#lockFirmForSeatCheck` for the `maxMembers` race.
   */
  async lockFirmForMatterCountCheck(lawFirmId: string, executor: any) {
    await firmQuery(
      lawFirms,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor
        .select({ id: lawFirms.id }).from(lawFirms).where(scope).for('update'),
      executor,
    );
  }

  // ── GCS attachment cleanup (storage retained) ─────────────────────
  async deleteAttachments(attachments: any) {
    if (!Array.isArray(attachments) || attachments.length === 0) return;
    // Bounded here rather than at each caller, so task-delete cleanup (N deleted
    // tasks x M attachments, fired and forgotten after the response) inherits the
    // cap too. Fire-and-forget semantics are unchanged; only the width is.
    await runWithConcurrency(
      attachments.map((attachment) => async () => {
        const path = attachment.objectPath || attachment.object_path;
        if (path) {
          try {
            await bucket.file(path).delete();
          } catch (err: any) {
            console.warn(`Failed to delete attachment: ${path}`, err.message);
          }
        }
      }),
      ATTACHMENT_DELETE_CONCURRENCY,
    );
  }

  parseDateString(dateValue: any) {
    if (!dateValue) return new Date();
    if (dateValue instanceof Date) return dateValue;
    if (typeof dateValue === 'string') {
      const m = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return dayAnchor(dateValue);
      const parsed = new Date(dateValue);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
  }

  /**
   * Conflict-of-interest check. Finds anyone the firm already knows whose name /
   * email / organization matches (case-insensitively) a supplied search value,
   * surfacing the matter they are attached to when there is one.
   *
   * Two sources, because a conflict is not only about who the firm represents:
   *
   *   * `clients` — someone the firm acts for. A match here is the classic
   *     "we already represent the other side".
   *   * `contacts` — the directory of everyone else, which is where opposing
   *     counsel, opposing parties and experts live. A match here catches
   *     "we are already adverse to this company on another matter", which a
   *     client-only search cannot see at all.
   *
   * An organization search value is matched three ways, because an organization
   * is represented three different ways in this data:
   *
   *   * a person's free-text `organization` (their stated employer),
   *   * an ORGANIZATION client's own `name`. That row leaves `organization`
   *     null, so searching organizations used to miss the firm's own client of
   *     exactly that name, which is the most serious hit the check can return,
   *   * the name of an organization a person is linked to through
   *     `client_company_links`. Those people carry no `organization` value
   *     either, so they were invisible to the same search.
   *
   * Every result carries `partyType` and `partyName` so a caller can say which
   * kind of party it found. `clientId`/`clientName` are still populated for
   * client-sourced results, so callers reading those keep working.
   *
   * @returns {Array<{ matchType, matchValue, searchValue, partyType, partyName, clientId, clientName, contactId, contactCategory, matterId, matterName, source }>}
   */
  async findConflicts(lawFirmId: string, {
    names = [],
    emails = [],
    organizations = [],
    excludeClientIds = [],
  }) {
    const norm = (arr: any) => Array.from(new Set(
      (arr || [])
        .map((v: any) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
        .filter(Boolean),
    ));
    const nameSet = norm(names);
    const emailSet = norm(emails);
    const orgSet = norm(organizations);
    const excludedIds = norm(excludeClientIds);

    if (nameSet.length + emailSet.length + orgSet.length === 0) return [];

    // One pass per source, unioned, so each keeps the join that makes sense for
    // it: a client reaches its matters through matter_clients, a directory
    // contact through matter_contacts.
    const { rows } = await tenantParameterizedQuery(clients, lawFirmId,
      `select
         'client'          as party_type,
         cli.id            as party_id,
         cli.name          as party_name,
         cli.email::text   as party_email,
         cli.organization  as party_organization,
         null              as party_category,
         mcl.matter_id     as matter_id,
         m.name            as matter_name,
         lower(cli.name)         = any($2::text[]) as name_match,
         lower(cli.email::text)  = any($3::text[]) as email_match,
         lower(cli.organization) = any($4::text[]) as org_match,
         -- An ORGANIZATION client carries its legal name in the name column and
         -- leaves organization null (that column describes a person's employer),
         -- so an organization search never reached the very record it is about:
         -- the firm's own client of that name.
         (cli.client_type = 'company' and lower(cli.name) = any($4::text[])) as company_name_match,
         -- A person linked to an organization through client_company_links
         -- carries no organization value either, so the same search could not
         -- find the people who work there. Subquery, not a join, so a person
         -- linked to several organizations still yields one row per matter and
         -- their name/email matches are not multiplied. A link to an excluded
         -- client is skipped: when the organization itself is a party to the
         -- matter, the people on its own roster are its representatives, not
         -- someone else the firm already knows.
         (select comp.name
            from client_company_links l
            join clients comp on comp.id = l.company_client_id and comp.law_firm_id = l.law_firm_id
           where l.law_firm_id = cli.law_firm_id and l.person_client_id = cli.id
             and lower(comp.name) = any($4::text[])
             and not (comp.id = any($5::uuid[]))
           order by comp.name
           limit 1) as linked_company_match
       from clients cli
       left join matter_clients mcl on mcl.client_id = cli.id and mcl.law_firm_id = cli.law_firm_id
       left join matters m          on m.id = mcl.matter_id and m.law_firm_id = cli.law_firm_id
       where cli.law_firm_id = $1
         and not (cli.id = any($5::uuid[]))
         and (
           lower(cli.name)         = any($2::text[])
           or lower(cli.email::text)  = any($3::text[])
           or lower(cli.organization) = any($4::text[])
           or (cli.client_type = 'company' and lower(cli.name) = any($4::text[]))
           or exists (
                select 1
                  from client_company_links l
                  join clients comp on comp.id = l.company_client_id and comp.law_firm_id = l.law_firm_id
                 where l.law_firm_id = cli.law_firm_id and l.person_client_id = cli.id
                   and lower(comp.name) = any($4::text[])
                   and not (comp.id = any($5::uuid[]))
              )
         )
       union all
       select
         'contact'         as party_type,
         con.id            as party_id,
         con.name          as party_name,
         con.email::text   as party_email,
         con.organization  as party_organization,
         con.category      as party_category,
         mco.matter_id     as matter_id,
         m2.name           as matter_name,
         lower(con.name)         = any($2::text[]) as name_match,
         lower(con.email::text)  = any($3::text[]) as email_match,
         lower(con.organization) = any($4::text[]) as org_match,
         -- A company contact (an opposing party, an insurer) keeps its name in
         -- the name column and leaves organization null, like an organization
         -- client, so it needs the same clause. The directory has no company
         -- links, so that column is a placeholder for the union.
         (con.contact_type = 'company' and lower(con.name) = any($4::text[])) as company_name_match,
         null::text              as linked_company_match
       from contacts con
       left join matter_contacts mco on mco.contact_id = con.id and mco.law_firm_id = con.law_firm_id
       left join matters m2          on m2.id = mco.matter_id and m2.law_firm_id = con.law_firm_id
       where con.law_firm_id = $1
         and (
           lower(con.name)         = any($2::text[])
           or lower(con.email::text)  = any($3::text[])
           or lower(con.organization) = any($4::text[])
           or (con.contact_type = 'company' and lower(con.name) = any($4::text[]))
         )`,
      [lawFirmId, nameSet, emailSet, orgSet, excludedIds],
      'cli',
    );

    const conflicts = [];
    for (const row of rows) {
      const isClient = row.party_type === 'client';
      const base = {
        partyType: row.party_type,
        partyName: row.party_name,
        // Kept populated for client rows so callers reading `clientId` /
        // `clientName` (and the conflict records already stored with those
        // keys) keep working unchanged.
        clientId: isClient ? row.party_id : undefined,
        clientName: isClient ? row.party_name : undefined,
        contactId: isClient ? undefined : row.party_id,
        contactCategory: isClient ? undefined : row.party_category || undefined,
        matterId: row.matter_id || undefined,
        matterName: row.matter_name || undefined,
        source: isClient
          ? (row.matter_id ? 'matter_client' : 'firm_client')
          : (row.matter_id ? 'matter_contact' : 'firm_contact'),
      };
      if (row.name_match) {
        conflicts.push({ ...base, matchType: 'name', matchValue: row.party_name, searchValue: row.party_name });
      }
      if (row.email_match) {
        conflicts.push({ ...base, matchType: 'email', matchValue: row.party_email, searchValue: row.party_email });
      }
      // One organization line per party, whichever way the organization was
      // reached: the party's own free-text employer field, the party BEING the
      // organization, or the party being linked to it. All three answer the same
      // question, so emitting one of each would just repeat the finding. An
      // organization equal to a name already reported is skipped too: the
      // create-matter check sends an organization's name as both a name and an
      // organization, and the two lines would say the same thing.
      const organizationMatch = row.org_match
        ? row.party_organization
        : row.company_name_match
          ? row.party_name
          : (row.linked_company_match || null);
      const repeatsName = row.name_match
        && String(organizationMatch).trim().toLowerCase() === String(row.party_name).trim().toLowerCase();
      if (organizationMatch && !repeatsName) {
        conflicts.push({ ...base, matchType: 'organization', matchValue: organizationMatch, searchValue: organizationMatch });
      }
    }
    return conflicts;
  }

  /**
   * Persist an evidentiary record that a conflict-of-interest check was performed
   * for a matter: who ran it, the parties searched, and the matched results. The
   * `query_*` columns summarize the parties checked (joined with newlines when a
   * matter has several clients) and `results` stores the raw match array.
   */
  /**
   * List the persisted conflict-of-interest checks recorded for a matter, newest
   * first, joined to the performer's display name. Surfaces the evidentiary record
   * so the firm can show a check was run, by whom, against what, and what matched.
   */
  async listConflictChecks(lawFirmId: string, matterId: string) {
    if (!isUuid(matterId)) return [];
    const rows = await tenantQuery(conflictCheckRecords, lawFirmId, ({ executor, scope }) => executor
      .select({
        id: conflictCheckRecords.id,
        performedBy: conflictCheckRecords.performedBy,
        performedByName: users.name,
        queryName: conflictCheckRecords.queryName,
        queryEmail: conflictCheckRecords.queryEmail,
        queryOrganization: conflictCheckRecords.queryOrganization,
        resultCount: conflictCheckRecords.resultCount,
        results: conflictCheckRecords.results,
        createdAt: conflictCheckRecords.createdAt,
      }).from(conflictCheckRecords).leftJoin(users, eq(users.id, conflictCheckRecords.performedBy))
      .where(and(scope, eq(conflictCheckRecords.matterId, matterId)))
      .orderBy(desc(conflictCheckRecords.createdAt)));
    return rows.map((r: any) => ({
      id: r.id,
      performedBy: r.performedBy || null,
      performedByName: r.performedByName || null,
      queryName: r.queryName || null,
      queryEmail: r.queryEmail || null,
      queryOrganization: r.queryOrganization || null,
      resultCount: Number(r.resultCount) || 0,
      results: r.results || [],
      createdAt: iso(r.createdAt),
    }));
  }

  async recordConflictCheck(lawFirmId: string, {
    matterId,
    performedBy,
    names = [],
    emails = [],
    organizations = [],
    results = [],
  }: any) {
    const joinValues = (arr: any) => Array.from(new Set(
      (arr || [])
        .map((v: any) => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean),
    )).join('\n') || null;
    await scopedInsert(conflictCheckRecords, lawFirmId, {
      performedBy: performedBy || null,
      matterId: isUuid(matterId) ? matterId : null,
      queryName: joinValues(names),
      queryEmail: joinValues(emails),
      queryOrganization: joinValues(organizations),
      resultCount: Array.isArray(results) ? results.length : 0,
      results: Array.isArray(results) ? results : [],
    });
  }
}

export = new MattersRepository();

/**
 * The billing reports roll-up, computed in Postgres.
 *
 * The "Billing by matter" report renders one card per matter with lifetime hours,
 * amounts billed, amounts outstanding and the next payment due. Those numbers
 * used to be reduced in the browser from the firm's COMPLETE time-entry and
 * invoice lists — a download that grows for the life of the firm and is paid for
 * every time the tab is opened. The rows the report actually renders are a GROUP
 * BY, so that is where they are produced now: the response carries a page of
 * aggregate rows plus the totals over the whole match set, and the raw entries
 * never leave the database.
 *
 * The money model mirrors the frontend's `getInvoiceTotal` /
 * `getInvoiceRemainingBalance` / `getInvoiceNextPaymentInfo` exactly, so a card
 * shows the same figures it always did:
 *
 *   total     = total_cents, or flat_fees_amount_cents when the total is zero
 *   remaining = max(0, total - written off - paid)
 *   next due  = the first pending/overdue installment on an enabled payment plan,
 *               else next_payment_date, else due_date — and only for an invoice
 *               that is unpaid, not written off, and still carries a balance
 *   voided invoices still count in invoice_count (the invoice exists and is
 *   listed elsewhere) but add nothing to billed, outstanding or next due
 */

const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../../shared/database/financialQuery');
const { toIlikeTerm } = require('../../../shared/database/searchTerm');
const { buildPageClause, resolveWindowTotal } = require('../../../shared/database/pagination');
const { timedRead } = require('../../../shared/database/queryTiming');

const centsToDollars = (v: any) => Number(v || 0) / 100;

/**
 * Per-invoice money and next-payment CTEs, shared by the page query and the
 * count query so both describe the same set.
 *
 * `$1` is the law firm. The lateral join is what resolves a payment plan's next
 * installment; it is left-joined on `payment_plan_enabled` so an invoice without
 * a plan still produces a row (with null plan columns) rather than dropping out.
 */
const INVOICE_CTES = `
  invoice_money as (
    select i.id,
           i.matter_id,
           -- Who the invoice is billed to, when anyone is: the client context on a
           -- client invoice, or the named client on a matter invoice.
           i.client_context_id,
           i.client_id as billed_client_id,
           i.invoice_name,
           i.invoice_number,
           i.is_paid,
           i.status,
           i.next_payment_date,
           i.due_date,
           case when i.total_cents > 0 then i.total_cents
                when i.flat_fees_amount_cents > 0 then i.flat_fees_amount_cents
                else 0 end as total_cents,
           i.amount_paid_cents,
           i.total_written_off_cents,
           i.payment_plan_enabled
      from invoices i
     where i.law_firm_id = $1
  ),
  invoice_next as (
    select m.*,
           greatest(0, m.total_cents - m.total_written_off_cents - m.amount_paid_cents) as remaining_cents,
           ep.due_day as plan_due_day,
           ep.amount_cents as plan_amount_cents
      from invoice_money m
      left join lateral (
        -- due_date is a date column (migration 0196), so the day IS the column.
        -- It was text holding either 'YYYY-MM-DD' or a full ISO string, and this
        -- took its first ten characters to match the old expression index. The
        -- ::text cast renders it as 'YYYY-MM-DD', matching the shape next_due_day
        -- below coalesces it with.
        select e.due_date::text as due_day, e.amount_cents
          from invoice_expected_payments e
         where e.invoice_id = m.id
           and e.status in ('pending', 'overdue')
           and m.payment_plan_enabled
         order by e.sort_order, e.id
         limit 1
      ) ep on true
  ),
  invoice_due as (
    select n.*,
           case
             -- A voided invoice was cancelled by the firm, so nothing is due on it.
             when n.status = 'voided' or n.is_paid or n.status = 'credited' or n.remaining_cents <= 0 then null
             else coalesce(n.plan_due_day, n.next_payment_date::text, n.due_date::text)
           end as next_due_day
      from invoice_next n
  )`;

/**
 * Per-matter aggregates. Kept separate from the outer select so the same
 * definition backs the page, the count, and the firm-wide totals.
 */
const MATTER_AGG_CTES = `
  matter_time as (
    select t.matter_id,
           count(*)::int as entry_count,
           coalesce(sum(t.hours), 0) as total_hours
      from activities t
     where t.kind = 'time' and t.law_firm_id = $1 and t.matter_id is not null
     group by t.matter_id
  ),
  matter_invoices as (
    select d.matter_id,
           count(*)::int as invoice_count,
           -- A voided invoice counts but is neither billed nor owed.
           coalesce(sum(d.total_cents) filter (where d.status <> 'voided'), 0) as billed_cents,
           coalesce(sum(d.remaining_cents) filter (where d.status <> 'voided'), 0) as outstanding_cents
      from invoice_due d
     where d.matter_id is not null
     group by d.matter_id
  ),
  matter_next as (
    select distinct on (d.matter_id)
           d.matter_id,
           d.next_due_day,
           d.plan_amount_cents,
           d.plan_due_day is not null as from_plan,
           coalesce(nullif(btrim(d.invoice_name), ''), nullif(btrim(d.invoice_number), '')) as invoice_label
      from invoice_due d
     where d.matter_id is not null and d.next_due_day is not null
     order by d.matter_id, d.next_due_day asc
  ),
  matter_clients_agg as (
    select mc.matter_id, array_agg(c.name order by c.name) as client_names
      from matter_clients mc
      join clients c on c.law_firm_id = mc.law_firm_id and c.id = mc.client_id
     where mc.law_firm_id = $1
     group by mc.matter_id
  ),
  matter_rows as (
    select m.id,
           m.name,
           m.status,
           coalesce(pa.name, '') as practice_area_name,
           coalesce(mca.client_names, '{}') as client_names,
           coalesce(mt.entry_count, 0) as entry_count,
           coalesce(mt.total_hours, 0) as total_hours,
           coalesce(mi.invoice_count, 0) as invoice_count,
           coalesce(mi.billed_cents, 0) as billed_cents,
           coalesce(mi.outstanding_cents, 0) as outstanding_cents,
           mn.next_due_day,
           mn.plan_amount_cents,
           mn.from_plan,
           mn.invoice_label
      from matters m
      left join practice_areas pa on pa.id = m.practice_area_id
      left join matter_clients_agg mca on mca.matter_id = m.id
      left join matter_time mt on mt.matter_id = m.id
      left join matter_invoices mi on mi.matter_id = m.id
      left join matter_next mn on mn.matter_id = m.id
     where m.law_firm_id = $1
       -- A matter with no tracked time and no invoices has nothing to report on;
       -- listing it fills the report with $0 rows that bury the matters that do
       -- have money attached. It reappears as soon as work is logged or an
       -- invoice exists.
       and (coalesce(mt.entry_count, 0) > 0 or coalesce(mi.invoice_count, 0) > 0)
  )`;

/**
 * Per-client aggregates.
 *
 * Who a piece of work belongs to follows the same two rules the browser applied:
 *
 *   1. Work that NAMES a client belongs to that client. For a time entry that is
 *      `matter_client_ids`; for an
 *      invoice it is the client context, or the `client_id` on a matter invoice.
 *   2. Work that names nobody belongs to the matter's SOLE client, and to no one
 *      at all on a multi-client matter. Spreading it across every client on the
 *      matter counted the same hours and the same receivable two or three times,
 *      which is the bug that rule exists to prevent.
 *
 * The browser also merged id-less records together by name. That has no analogue
 * here and needs none: `matter_clients` and the invoice client columns are all
 * foreign keys, so every row already carries the client's real id, and grouping
 * on it is the same answer without the name matching.
 */
const CLIENT_AGG_CTES = `
  matter_client_counts as (
    select matter_id, count(*)::int as client_count
      from matter_clients
     where law_firm_id = $1
     group by matter_id
  ),
  -- The one client a matter belongs to, or nothing when it has none or several.
  matter_sole_client as (
    select mc.matter_id, mc.client_id
      from matter_clients mc
      join matter_client_counts cc on cc.matter_id = mc.matter_id and cc.client_count = 1
     where mc.law_firm_id = $1
  ),
  -- One row per (client, time entry) the entry is chargeable to.
  client_time as (
    select c.client_id, count(*)::int as entry_count, coalesce(sum(c.hours), 0) as total_hours
      from (
        -- Client-context work: billed to that client by definition.
        select t.client_id, t.hours
          from activities t
         where t.kind = 'time' and t.law_firm_id = $1 and t.matter_id is null and t.client_id is not null
        union all
        -- Matter work naming one or more clients. matter_client_ids is the only
        -- record of that since migration 0197 folded the singular
        -- matter_client_id into it and dropped the column.
        select (named.value #>> '{}')::uuid as client_id, t.hours
          from activities t
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(t.matter_client_ids) = 'array' and jsonb_array_length(t.matter_client_ids) > 0
                 then t.matter_client_ids
                 else '[]'::jsonb end
          ) as named(value)
         where t.kind = 'time' and t.law_firm_id = $1 and t.matter_id is not null
        union all
        -- Matter work naming nobody: the matter's sole client, or no one.
        select s.client_id, t.hours
          from activities t
          join matter_sole_client s on s.matter_id = t.matter_id
         where t.kind = 'time' and t.law_firm_id = $1
           and t.matter_id is not null
           and case when jsonb_typeof(t.matter_client_ids) = 'array'
                    then jsonb_array_length(t.matter_client_ids) else 0 end = 0
      ) c
     where c.client_id is not null
     group by c.client_id
  ),
  -- One row per (client, invoice) the invoice is a receivable of. An invoice
  -- naming nobody on a multi-client matter appears in neither branch, so it is
  -- nobody's individual receivable — which is the point.
  client_invoice_rows as (
    select coalesce(d.client_context_id, d.billed_client_id) as client_id,
           d.status, d.total_cents, d.remaining_cents, d.next_due_day, d.plan_due_day,
           d.plan_amount_cents, d.invoice_name, d.invoice_number
      from invoice_due d
     where coalesce(d.client_context_id, d.billed_client_id) is not null
    union all
    select s.client_id,
           d.status, d.total_cents, d.remaining_cents, d.next_due_day, d.plan_due_day,
           d.plan_amount_cents, d.invoice_name, d.invoice_number
      from invoice_due d
      join matter_sole_client s on s.matter_id = d.matter_id
     where d.client_context_id is null and d.billed_client_id is null and d.matter_id is not null
  ),
  client_invoices as (
    select r.client_id,
           count(*)::int as invoice_count,
           coalesce(sum(r.total_cents) filter (where r.status <> 'voided'), 0) as billed_cents,
           coalesce(sum(r.remaining_cents) filter (where r.status <> 'voided'), 0) as outstanding_cents
      from client_invoice_rows r
     group by r.client_id
  ),
  client_next as (
    select distinct on (r.client_id)
           r.client_id,
           r.next_due_day,
           r.plan_amount_cents,
           r.plan_due_day is not null as from_plan,
           coalesce(nullif(btrim(r.invoice_name), ''), nullif(btrim(r.invoice_number), '')) as invoice_label
      from client_invoice_rows r
     where r.next_due_day is not null
     order by r.client_id, r.next_due_day asc
  ),
  client_matters_agg as (
    select mc.client_id,
           count(*)::int as matter_count,
           array_agg(m.name order by m.name) as matter_names
      from matter_clients mc
      join matters m on m.law_firm_id = mc.law_firm_id and m.id = mc.matter_id
     where mc.law_firm_id = $1
     group by mc.client_id
  ),
  client_rows as (
    select cl.id,
           cl.name,
           coalesce(cma.matter_count, 0) as matter_count,
           coalesce(cma.matter_names, '{}') as matter_names,
           coalesce(ct.entry_count, 0) as entry_count,
           coalesce(ct.total_hours, 0) as total_hours,
           coalesce(ci.invoice_count, 0) as invoice_count,
           coalesce(ci.billed_cents, 0) as billed_cents,
           coalesce(ci.outstanding_cents, 0) as outstanding_cents,
           cn.next_due_day,
           cn.plan_amount_cents,
           cn.from_plan,
           cn.invoice_label
      from clients cl
      left join client_matters_agg cma on cma.client_id = cl.id
      left join client_time ct on ct.client_id = cl.id
      left join client_invoices ci on ci.client_id = cl.id
      left join client_next cn on cn.client_id = cl.id
     where cl.law_firm_id = $1
       -- Same rule as by-matter: a client with no tracked time and no invoices
       -- has nothing to report on, and $0 rows only bury the clients who owe.
       and (coalesce(ct.entry_count, 0) > 0 or coalesce(ci.invoice_count, 0) > 0)
  )`;

/** Append the report's filters to `params` and return the WHERE body for them. */
function buildMatterFilters({ search, status, practiceArea }: any, params: any) {
  const clauses = [];
  const term = toIlikeTerm(search);
  if (term) {
    params.push(term);
    const p = params.length;
    // Matches the browser filter: the matter's own name, or any client on it.
    clauses.push(`(r.name ilike $${p} escape '\\'
                   or exists (select 1 from unnest(r.client_names) cn where cn ilike $${p} escape '\\'))`);
  }
  if (status) {
    params.push(status);
    clauses.push(`r.status = $${params.length}`);
  }
  if (practiceArea) {
    params.push(practiceArea);
    clauses.push(`r.practice_area_name = $${params.length}`);
  }
  return clauses.length ? ` where ${clauses.join(' and ')}` : '';
}

/**
 * Rows sort by soonest payment first, then by what is most owed. Mirrors the
 * comparator the browser used, so the top of the report doesn't move.
 */
const MATTER_ORDER_BY = `
  order by r.next_due_day asc nulls last,
           r.outstanding_cents desc,
           r.billed_cents desc,
           r.name asc,
           r.id asc`;

/** Append the by-client search to `params` and return the WHERE body for it. */
function buildClientFilters({ search }: any, params: any) {
  const term = toIlikeTerm(search);
  if (!term) return '';
  params.push(term);
  const p = params.length;
  // Matches the browser filter: the client's own name, or any matter they are on.
  return ` where (r.name ilike $${p} escape '\\'
                  or exists (select 1 from unnest(r.matter_names) mn where mn ilike $${p} escape '\\'))`;
}

/**
 * The same ordering as the by-matter report: soonest payment first, then by what
 * is most owed.
 */
const CLIENT_ORDER_BY = `
  order by r.next_due_day asc nulls last,
           r.outstanding_cents desc,
           r.billed_cents desc,
           r.name asc,
           r.id asc`;

function clientRowEntity(r: any) {
  return {
    id: r.id,
    clientId: r.id,
    name: r.name || 'Unnamed Client',
    matterNames: r.matter_names || [],
    matterCount: Number(r.matter_count) || 0,
    timeEntryCount: Number(r.entry_count) || 0,
    totalHours: Number(r.total_hours) || 0,
    invoiceCount: Number(r.invoice_count) || 0,
    totalBilled: centsToDollars(r.billed_cents),
    totalOutstanding: centsToDollars(r.outstanding_cents),
    nextPaymentDate: r.next_due_day || null,
    nextPaymentAmount: r.from_plan && r.plan_amount_cents != null ? centsToDollars(r.plan_amount_cents) : null,
    nextPaymentFromPlan: !!r.from_plan,
    nextPaymentInvoiceName: r.invoice_label || 'Untitled Invoice',
  };
}

function matterRowEntity(r: any) {
  return {
    id: r.id,
    name: r.name || '',
    status: r.status || '',
    practiceAreaName: r.practice_area_name || '',
    clientNames: r.client_names || [],
    timeEntryCount: Number(r.entry_count) || 0,
    totalHours: Number(r.total_hours) || 0,
    invoiceCount: Number(r.invoice_count) || 0,
    totalBilled: centsToDollars(r.billed_cents),
    totalOutstanding: centsToDollars(r.outstanding_cents),
    nextPaymentDate: r.next_due_day || null,
    // Only a payment plan states an installment amount; otherwise the card shows
    // the date alone, exactly as before.
    nextPaymentAmount: r.from_plan && r.plan_amount_cents != null ? centsToDollars(r.plan_amount_cents) : null,
    nextPaymentFromPlan: !!r.from_plan,
    nextPaymentInvoiceName: r.invoice_label || 'Untitled Invoice',
  };
}

class BillingReportsRepository {
  /**
   * One page of the by-matter report, plus the totals and filter options the
   * header needs over the WHOLE match set rather than the page.
   */
  async listByMatter(lawFirmId: string, { search, status, practiceArea, page, limit, offset }: any = {}) {
    const params: unknown[] = [lawFirmId];
    const filterSql = buildMatterFilters({ search, status, practiceArea }, params);
    const filterParams = [...params];
    const { pageClause, pageOffset } = buildPageClause({
      limit, offset, page, params, fallbackLimit: 10, max: 100, optional: true,
    });

    // Timed because this aggregate's cost grows with the firm's history rather
    // than with the page: it is the one read here that a large firm can outgrow.
    const { rows, totalItems } = await timedRead(
      'billing.report.byMatter',
      { lawFirmId, hasSearch: Boolean(search) },
      async () => {
        const page = await financialRootSql(
          `with ${INVOICE_CTES}, ${MATTER_AGG_CTES}
           select r.*, count(*) over() as total_count
             from matter_rows r${filterSql}
           ${MATTER_ORDER_BY}${pageClause}`,
          params
        );
        const total = await resolveWindowTotal({
          rows: page.rows,
          pageOffset,
          countSql: `with ${INVOICE_CTES}, ${MATTER_AGG_CTES}
                     select count(*) as total from matter_rows r${filterSql}`,
          filterParams,
        });
        return { rows: page.rows, totalItems: total };
      }
    );

    return { rows: rows.map(matterRowEntity), totalItems };
  }

  /** One page of the by-client report. */
  async listByClient(lawFirmId: string, { search, page, limit, offset }: any = {}) {
    const params: unknown[] = [lawFirmId];
    const filterSql = buildClientFilters({ search }, params);
    const filterParams = [...params];
    const { pageClause, pageOffset } = buildPageClause({
      limit, offset, page, params, fallbackLimit: 10, max: 100, optional: true,
    });

    const { rows, totalItems } = await timedRead(
      'billing.report.byClient',
      { lawFirmId, hasSearch: Boolean(search) },
      async () => {
        const page = await financialRootSql(
          `with ${INVOICE_CTES}, ${CLIENT_AGG_CTES}
           select r.*, count(*) over() as total_count
             from client_rows r${filterSql}
           ${CLIENT_ORDER_BY}${pageClause}`,
          params
        );
        const total = await resolveWindowTotal({
          rows: page.rows,
          pageOffset,
          countSql: `with ${INVOICE_CTES}, ${CLIENT_AGG_CTES}
                     select count(*) as total from client_rows r${filterSql}`,
          filterParams,
        });
        return { rows: page.rows, totalItems: total };
      }
    );

    return { rows: rows.map(clientRowEntity), totalItems };
  }

  /**
   * One client's roll-up broken down by matter, for the report's detail modal.
   *
   * Applies exactly the attribution rules `CLIENT_AGG_CTES` does, restricted to
   * `clientId` and grouped by matter instead of collapsed — so opening a client
   * cannot show a per-matter breakdown that disagrees with the card it came from.
   */
  async getClientMatterBreakdown(lawFirmId: string, clientId: string) {
    const { rows } = await timedRead(
      'billing.report.clientMatterBreakdown',
      { lawFirmId, clientId },
      () => financialRootSql(
      `with ${INVOICE_CTES}, ${CLIENT_AGG_CTES},
       client_matter_time as (
         select t.matter_id, coalesce(sum(t.hours), 0) as total_hours
           from activities t
          where t.kind = 'time' and t.law_firm_id = $1
            and t.matter_id is not null
            and (
              -- named on the entry
              case when jsonb_typeof(t.matter_client_ids) = 'array'
                   then t.matter_client_ids @> to_jsonb($2::text) else false end
              -- or names nobody and this is the matter's sole client
              or (case when jsonb_typeof(t.matter_client_ids) = 'array'
                       then jsonb_array_length(t.matter_client_ids) else 0 end = 0
                  and exists (select 1 from matter_sole_client s
                               where s.matter_id = t.matter_id and s.client_id = $2::uuid))
            )
          group by t.matter_id
       ),
       client_matter_invoices as (
         select d.matter_id,
                count(*)::int as invoice_count,
                coalesce(sum(d.total_cents) filter (where d.status <> 'voided'), 0) as billed_cents,
                coalesce(sum(d.remaining_cents) filter (where d.status <> 'voided'), 0) as outstanding_cents
           from invoice_due d
          where d.matter_id is not null
            and (
              coalesce(d.client_context_id, d.billed_client_id) = $2::uuid
              or (d.client_context_id is null and d.billed_client_id is null
                  and exists (select 1 from matter_sole_client s
                               where s.matter_id = d.matter_id and s.client_id = $2::uuid))
            )
          group by d.matter_id
       )
       select m.id, m.name, m.status,
              coalesce(t.total_hours, 0) as total_hours,
              coalesce(i.invoice_count, 0) as invoice_count,
              coalesce(i.billed_cents, 0) as billed_cents,
              coalesce(i.outstanding_cents, 0) as outstanding_cents
         from matter_clients mc
         join matters m on m.law_firm_id = mc.law_firm_id and m.id = mc.matter_id
         left join client_matter_time t on t.matter_id = m.id
         left join client_matter_invoices i on i.matter_id = m.id
        where mc.law_firm_id = $1 and mc.client_id = $2::uuid
        order by m.name asc`,
      [lawFirmId, clientId]
      )
    );
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name || '',
      status: r.status || '',
      hours: Number(r.total_hours) || 0,
      billed: centsToDollars(r.billed_cents),
      outstanding: centsToDollars(r.outstanding_cents),
      invoiceCount: Number(r.invoice_count) || 0,
    }));
  }

  /**
   * Money on invoices that belong to no client row: a matter invoice naming
   * nobody on a matter with several clients. It is nobody's individual
   * receivable, so it appears in no row — and the report says so rather than
   * letting the firm total change without explanation between groupings.
   */
  async getUnattributedInvoiceTotals(lawFirmId: string) {
    const { rows } = await financialRootSql(
      `with ${INVOICE_CTES}, ${CLIENT_AGG_CTES}
       select count(*)::int as count, coalesce(sum(d.total_cents), 0) as total_cents
         from invoice_due d
        where d.status <> 'voided'
          and d.client_context_id is null
          and d.billed_client_id is null
          and (d.matter_id is null
               or not exists (select 1 from matter_sole_client s where s.matter_id = d.matter_id))`,
      [lawFirmId]
    );
    return { count: Number(rows[0].count) || 0, totalAmount: centsToDollars(rows[0].total_cents) };
  }

  /**
   * Invoices billed straight to a client, which sit under no matter and so appear
   * in no by-matter row. The report states the shortfall rather than letting the
   * firm total change without explanation when the Group by toggle is switched.
   */
  async getUnlinkedInvoiceTotals(lawFirmId: string) {
    const { rows } = await financialRootSql(
      `with ${INVOICE_CTES}
       select count(*)::int as count, coalesce(sum(d.total_cents), 0) as total_cents
         from invoice_due d
        where d.matter_id is null and d.status <> 'voided'`,
      [lawFirmId]
    );
    return { count: Number(rows[0].count) || 0, totalAmount: centsToDollars(rows[0].total_cents) };
  }

  /**
   * The practice areas the report's dropdown offers. Taken from the matters that
   * appear in the report, so it can never offer a value that selects nothing.
   */
  async listReportPracticeAreas(lawFirmId: string) {
    const { rows } = await financialRootSql(
      `with ${INVOICE_CTES}, ${MATTER_AGG_CTES}
       select distinct r.practice_area_name as name
         from matter_rows r
        where r.practice_area_name <> ''
        order by 1`,
      [lawFirmId]
    );
    return rows.map((r: any) => r.name);
  }
}

export = new BillingReportsRepository();

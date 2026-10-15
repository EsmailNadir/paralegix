/**
 * Billing plans repository (Postgres). Plans are retainers; periods are billing
 * windows. The legacy Firestore repo keyed period docs by their periodStartDate
 * string, which maps cleanly to the `(billing_plan_id, period_start_date)`
 * unique constraint. So the logical period `id` returned here is the
 * period_start_date string (preserving how the service/frontend reference it).
 *
 * covered/overage activity ids live in billing_plan_periods.
 * Money is dollars in the entity, integer cents in the columns.
 */

const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../../shared/database/financialQuery');
const { isUuid } = require('../../../shared/utils/isUuid');
const { buildCeilingClause, applyCeiling, LIST_CEILING } = require('../../../shared/database/pagination');
const { logger } = require('../../../shared/utils/logger');

const num = (v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const toCents = (v: any) => (v == null || v === '' ? null : Math.round(num(v) * 100));
const centsToDollars = (c: any) => (c == null ? 0 : Number(c) / 100);

function dateOnly(v: any) {
  if (!v) return null;
  if (typeof v === 'object' && typeof v.toDate === 'function') return v.toDate().toISOString().slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.slice(0, 10);
  return null;
}
const { rowIso: iso } = require('../../../shared/utils/dateConversion');

/** A Timestamp / Date / ISO string -> a JS Date (preserving time), or null. */
function tsValue(v: any) {
  if (!v) return null;
  if (typeof v === 'object' && typeof v.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function planEntity(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    contextType: r.matter_id ? 'matter' : 'client',
    entityId: r.matter_id || r.client_id,
    planType: r.plan_type,
    name: r.name,
    status: r.status,
    intervalUnit: r.interval_unit,
    intervalCount: r.interval_count,
    startDate: dateOnly(r.start_date),
    nextRunDate: dateOnly(r.next_run_date),
    amount: centsToDollars(r.amount_cents),
    includedHours: r.included_hours == null ? 0 : num(r.included_hours),
    billingEmail: r.billing_email || null,
    defaultDueDays: r.default_due_days == null ? 0 : r.default_due_days,
    defaultClientId: r.default_client_id || null,
    notes: r.notes || null,
    endCondition: r.end_condition || 'manual',
    endDate: dateOnly(r.end_date),
    createdBy: r.created_by || null,
    updatedBy: r.updated_by || null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function periodEntity(r: any, covered: any[] = [], overage: any[] = []) {
  if (!r) return null;
  return {
    id: dateOnly(r.period_start_date),
    periodStartDate: dateOnly(r.period_start_date),
    periodEndDate: dateOnly(r.period_end_date),
    dueDate: dateOnly(r.due_date),
    status: r.status,
    amount: centsToDollars(r.amount_cents),
    includedHours: r.included_hours == null ? 0 : num(r.included_hours),
    consumedHours: r.consumed_hours == null ? 0 : num(r.consumed_hours),
    overageHours: r.overage_hours == null ? 0 : num(r.overage_hours),
    generatedInvoiceId: r.generated_invoice_id || null,
    generatedInvoiceContextType: r.generated_invoice_context_type || null,
    generatedInvoiceEntityId: r.generated_invoice_entity_id || null,
    generatedAt: iso(r.generated_at),
    coveredTimeEntryIds: covered,
    overageTimeEntryIds: overage,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

class PlansRepository {
  async create(lawFirmId: string, data: any) {
    const isMatter = data.contextType === 'matter';
    const { rows } = await financialRootSql(
      `insert into billing_plans
         (law_firm_id, matter_id, client_id, plan_type, name, status, interval_unit, interval_count,
          start_date, next_run_date, end_condition, end_date, amount_cents, included_hours,
          billing_email, default_due_days, default_client_id, notes, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       returning *`,
      [
        lawFirmId,
        isMatter && isUuid(data.entityId) ? data.entityId : null,
        !isMatter && isUuid(data.entityId) ? data.entityId : null,
        data.planType || 'retainer', data.name, data.status || 'active',
        data.intervalUnit || null, data.intervalCount || null,
        dateOnly(data.startDate), dateOnly(data.nextRunDate),
        data.endCondition || 'manual', dateOnly(data.endDate),
        toCents(data.amount), data.includedHours ?? 0,
        data.billingEmail || null, data.defaultDueDays ?? null,
        isUuid(data.defaultClientId) ? data.defaultClientId : null, data.notes || null,
        data.createdBy || null, data.updatedBy || null,
      ]
    );
    return planEntity(rows[0]);
  }

  async findAll(lawFirmId: string) {
    const { rows } = await financialRootSql(
      `select * from billing_plans where law_firm_id = $1 order by created_at desc`,
      [lawFirmId]
    );
    return rows.map(planEntity);
  }

  async findById(lawFirmId: string, planId: string) {
    if (!isUuid(planId)) return null;
    const { rows } = await financialRootSql(
      `select * from billing_plans where law_firm_id = $1 and id = $2 limit 1`,
      [lawFirmId, planId]
    );
    return rows[0] ? planEntity(rows[0]) : null;
  }

  async update(lawFirmId: string, planId: string, data: any) {
    if (!isUuid(planId)) return null;
    const map = {
      name: 'name', status: 'status', intervalUnit: 'interval_unit', intervalCount: 'interval_count',
      billingEmail: 'billing_email', defaultDueDays: 'default_due_days', notes: 'notes',
      endCondition: 'end_condition', updatedBy: 'updated_by',
    };
    const set = [];
    const params: unknown[] = [lawFirmId, planId];
    for (const [field, col] of Object.entries(map)) {
      if (data[field] !== undefined) { params.push(data[field]); set.push(`${col} = $${params.length}`); }
    }
    if (data.amount !== undefined) { params.push(toCents(data.amount)); set.push(`amount_cents = $${params.length}`); }
    if (data.includedHours !== undefined) { params.push(data.includedHours); set.push(`included_hours = $${params.length}`); }
    if (data.defaultClientId !== undefined) { params.push(isUuid(data.defaultClientId) ? data.defaultClientId : null); set.push(`default_client_id = $${params.length}`); }
    if (data.startDate !== undefined) { params.push(dateOnly(data.startDate)); set.push(`start_date = $${params.length}`); }
    if (data.nextRunDate !== undefined) { params.push(dateOnly(data.nextRunDate)); set.push(`next_run_date = $${params.length}`); }
    if (data.endDate !== undefined) { params.push(dateOnly(data.endDate)); set.push(`end_date = $${params.length}`); }

    if (!set.length) return this.findById(lawFirmId, planId);
    set.push('updated_at = now()');
    const { rows } = await financialRootSql(
      `update billing_plans set ${set.join(',')} where law_firm_id = $1 and id = $2 returning *`,
      params
    );
    return rows[0] ? planEntity(rows[0]) : null;
  }

  // ── periods (keyed logically by period_start_date) ────────────────
  async _periodCoverage(periodRowId: any) {
    const { rows } = await financialRootSql(
      `select id as time_entry_id, coverage from activities where billing_plan_period_id = $1`,
      [periodRowId]
    );
    const covered: any[] = [];
    const overage: any[] = [];
    rows.forEach((r: any) => (r.coverage === 'overage' ? overage : covered).push(r.time_entry_id));
    return { covered, overage };
  }

  /**
   * Every period a plan has run, newest first.
   *
   * Deliberately unpaged: the plan detail page renders them all at once, counts
   * the ready-to-bill ones across the whole set, and looks a period up by id from
   * it when generating a draft invoice. Paging it would break all three.
   *
   * Bounded anyway, because a plan mints one period per billing interval forever
   * and nothing ever removes one. `LIST_CEILING` is far past any real plan — over
   * four centuries of monthly periods, and still thirteen years of daily ones —
   * so it caps a runaway rather than real history.
   *
   * The overflow is logged rather than returned: this method's array return type
   * is consumed by `ensurePlanPeriods` in plans.service.js, which maps it
   * straight into the response, leaving nowhere for a flag to ride. Surfacing
   * `truncated` to the client needs that service change too.
   */
  async listPeriods(lawFirmId: string, planId: string) {
    if (!isUuid(planId)) return { periods: [], truncated: false, ceiling: LIST_CEILING };
    const params: unknown[] = [lawFirmId, planId];
    const limitSql = buildCeilingClause({ params });
    const { rows: fetched } = await financialRootSql(
      `select * from billing_plan_periods where law_firm_id = $1 and billing_plan_id = $2
        order by period_start_date desc${limitSql}`,
      params
    );
    const { rows, truncated } = applyCeiling(fetched);
    if (truncated) {
      logger.warn(
        { event: 'plan-periods-truncated', lawFirmId, planId, ceiling: LIST_CEILING },
        `[plans] plan ${planId} has more than ${LIST_CEILING} periods; the oldest are omitted from the plan view`
      );
    }
    // One coverage lookup for every period instead of one per period. This is a
    // plain list GET, and the old shape added a round trip for each billing
    // interval a plan had ever run — so the cost grew forever, by one query per
    // period, for a page that displays them all at once.
    const coverage = await this._periodCoverageBatch(rows.map((r: any) => r.id));
    const periods = rows.map((r: any) => {
      const c = coverage.get(r.id) || { covered: [], overage: [] };
      return periodEntity(r, c.covered, c.overage);
    });
    // An envelope rather than a bare array, so the cap can be reported. A plan
    // page that silently drops the oldest periods reads as the plan's complete
    // billing history, and that history is what a firm invoices from.
    //
    // Acting on a period must NOT depend on it being inside this window — see
    // `createDraftFromPeriod`, which falls back to `findPeriodById`. The ceiling
    // governs what is displayed, never what can be acted on.
    return { periods, truncated, ceiling: LIST_CEILING };
  }

  /**
   * The plan's periods starting on or after `fromStartDate`, newest first.
   *
   * This is what period generation checks against before deciding to write, and
   * it is deliberately NOT subject to `listPeriods`' ceiling. That ceiling keeps
   * the newest periods and drops the oldest, so a plan far enough past it that had
   * its run date rewound would look to the generator as though its earliest
   * periods had never been created — and re-creating a settled period recomputes
   * it against the current unbilled set, which no longer holds the entries its
   * invoice billed. The window is bounded by the schedule the generator walks
   * (run date to today), so it needs no ceiling of its own.
   */
  async listPeriodsFrom(lawFirmId: string, planId: string, fromStartDate: any) {
    if (!isUuid(planId)) return [];
    const from = dateOnly(fromStartDate);
    const params: unknown[] = [lawFirmId, planId];
    let where = 'law_firm_id = $1 and billing_plan_id = $2';
    if (from) { params.push(from); where += ` and period_start_date >= $${params.length}`; }
    const { rows } = await financialRootSql(
      `select * from billing_plan_periods where ${where} order by period_start_date desc`,
      params
    );
    const coverage = await this._periodCoverageBatch(rows.map((r: any) => r.id));
    return rows.map((r: any) => {
      const c = coverage.get(r.id) || { covered: [], overage: [] };
      return periodEntity(r, c.covered, c.overage);
    });
  }

  /** `_periodCoverage` for many periods in one query. Keyed by period row id. */
  async _periodCoverageBatch(periodRowIds: any) {
    const ids = [...new Set((periodRowIds || []).filter(isUuid))];
    const out = new Map();
    if (!ids.length) return out;
    const { rows } = await financialRootSql(
      `select billing_plan_period_id as period_id, id as time_entry_id, coverage
         from activities where billing_plan_period_id = any($1::uuid[])`,
      [ids]
    );
    for (const r of rows) {
      if (!out.has(r.period_id)) out.set(r.period_id, { covered: [], overage: [] });
      const bucket = out.get(r.period_id);
      (r.coverage === 'overage' ? bucket.overage : bucket.covered).push(r.time_entry_id);
    }
    return out;
  }

  async findPeriodById(lawFirmId: string, planId: string, periodStartDate: any) {
    if (!isUuid(planId)) return null;
    // A period's id IS its start date, so this has to be a date before it can go
    // near a `date` column. `dateOnly` only slices the first ten characters, so
    // a uuid arrives as "24a71e09-9" and reaches Postgres as a failed cast: a
    // 500 with the query shape in the log, where the caller should have seen a
    // clean not-found.
    //
    // The uuid is the shape a caller reaches for first, because it is the
    // primary key of the `billing_plan_periods` row and looks like the obvious
    // identifier. Answering not-found is the same treatment `isUuid` above gives
    // a malformed plan id.
    const day = dateOnly(periodStartDate);
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const { rows } = await financialRootSql(
      `select * from billing_plan_periods where law_firm_id = $1 and billing_plan_id = $2 and period_start_date = $3 limit 1`,
      [lawFirmId, planId, day]
    );
    if (!rows[0]) return null;
    const { covered, overage } = await this._periodCoverage(rows[0].id);
    return periodEntity(rows[0], covered, overage);
  }

  /**
   * Upsert a set of periods for one plan, with their coverage, in ONE
   * transaction: a multi-row upsert, a single coverage delete, and a single
   * multi-row coverage insert, regardless of how many periods are being written.
   *
   * The per-period version this replaces cost six round trips each (upsert, then
   * begin/delete/insert/commit for coverage, then a coverage re-read), so a plan
   * backfilling several years of monthly periods spent hundreds of round trips
   * writing what is one logical change. Batching also makes the whole set atomic:
   * a failure part-way through no longer leaves some periods rewritten against a
   * usage calculation whose remaining periods were never persisted.
   *
   * Returns the written periods keyed by `period_start_date`.
   */
  async upsertPeriods(lawFirmId: string, planId: string, entries: any) {
    const out = new Map();
    if (!isUuid(planId) || !entries || !entries.length) return out;

    // The unique constraint is (billing_plan_id, period_start_date), and one
    // statement may not touch the same conflicting row twice. Callers generate
    // strictly increasing dates, so this only guards against a caller that does
    // not; last write wins, matching a sequence of individual upserts.
    const byStart = new Map();
    for (const data of entries) {
      const start = dateOnly(data.periodStartDate);
      if (start) byStart.set(start, data);
    }
    if (!byStart.size) return out;

    const rowsIn = [...byStart.entries()];
    const cols = {
      start: rowsIn.map(([start]) => start),
      end: rowsIn.map(([, d]) => dateOnly(d.periodEndDate)),
      due: rowsIn.map(([, d]) => dateOnly(d.dueDate)),
      status: rowsIn.map(([, d]) => d.status || 'ready_to_bill'),
      amount: rowsIn.map(([, d]) => toCents(d.amount)),
      included: rowsIn.map(([, d]) => d.includedHours ?? 0),
      consumed: rowsIn.map(([, d]) => d.consumedHours ?? 0),
      overage: rowsIn.map(([, d]) => d.overageHours ?? 0),
      invoiceId: rowsIn.map(([, d]) => (isUuid(d.generatedInvoiceId) ? d.generatedInvoiceId : null)),
      invoiceContext: rowsIn.map(([, d]) => d.generatedInvoiceContextType || null),
      invoiceEntity: rowsIn.map(([, d]) => (isUuid(d.generatedInvoiceEntityId) ? d.generatedInvoiceEntityId : null)),
      generatedAt: rowsIn.map(([, d]) => tsValue(d.generatedAt)),
    };

    const written = await withDrizzleTransaction(async (client: any) => {
      // A period linked to an invoice is the record that invoice was built from,
      // and only `updatePeriod` writes it. A read that computed this period before
      // the link landed must not write its unlinked snapshot back, so the conflict
      // update skips linked rows. A skipped row is absent from `returning`, so its
      // coverage below is left alone too.
      const { rows } = await financialSql(client,
        `insert into billing_plan_periods
           (law_firm_id, billing_plan_id, period_start_date, period_end_date, due_date, status,
            amount_cents, included_hours, consumed_hours, overage_hours,
            generated_invoice_id, generated_invoice_context_type, generated_invoice_entity_id, generated_at)
         select $1, $2, *
           from unnest($3::date[], $4::date[], $5::date[], $6::text[], $7::bigint[],
                       $8::numeric[], $9::numeric[], $10::numeric[],
                       $11::uuid[], $12::text[], $13::uuid[], $14::timestamptz[])
         on conflict (billing_plan_id, period_start_date) do update set
           period_end_date = excluded.period_end_date,
           due_date = excluded.due_date,
           status = excluded.status,
           amount_cents = excluded.amount_cents,
           included_hours = excluded.included_hours,
           consumed_hours = excluded.consumed_hours,
           overage_hours = excluded.overage_hours,
           generated_invoice_id = excluded.generated_invoice_id,
           generated_invoice_context_type = excluded.generated_invoice_context_type,
           generated_invoice_entity_id = excluded.generated_invoice_entity_id,
           generated_at = excluded.generated_at,
           updated_at = now()
         where billing_plan_periods.generated_invoice_id is null
         returning *`,
        [
          lawFirmId, planId, cols.start, cols.end, cols.due, cols.status, cols.amount,
          cols.included, cols.consumed, cols.overage,
          cols.invoiceId, cols.invoiceContext, cols.invoiceEntity, cols.generatedAt,
        ]
      );

      // RETURNING order is not the input order for an upsert, so period rows are
      // matched back to their coverage by start date.
      const rowByStart = new Map(rows.map((r: any) => [dateOnly(r.period_start_date), r]));
      const periodIds: any[] = [];
      const entryIds: any[] = [];
      const coverages: any[] = [];
      for (const [start, data] of byStart) {
        const row: any = rowByStart.get(start);
        if (!row) continue;
        (data.coveredTimeEntryIds || []).filter(isUuid).forEach((id: any) => {
          periodIds.push(row.id); entryIds.push(id); coverages.push('covered');
        });
        (data.overageTimeEntryIds || []).filter(isUuid).forEach((id: any) => {
          periodIds.push(row.id); entryIds.push(id); coverages.push('overage');
        });
      }

      // Coverage lives on the activity itself since migration 0232: one period
      // per entry, so this is a clear-then-set on the touched periods rather
      // than a junction rewrite. An entry that straddles the allowance is
      // pushed onto BOTH lists by the usage computation, covered first; the
      // first mention wins, as the junction's `on conflict do nothing` did.
      const touchedIds = rows.map((r: any) => r.id);
      await financialSql(client,
        `update activities set billing_plan_period_id = null, coverage = null
          where billing_plan_period_id = any($1::uuid[])`,
        [touchedIds]
      );
      const seen = new Set<string>();
      const firstPeriodIds: any[] = [];
      const firstEntryIds: any[] = [];
      const firstCoverages: any[] = [];
      entryIds.forEach((id: any, i: number) => {
        if (seen.has(id)) return;
        seen.add(id);
        firstPeriodIds.push(periodIds[i]); firstEntryIds.push(id); firstCoverages.push(coverages[i]);
      });
      if (firstEntryIds.length) {
        await financialSql(client,
          `update activities a set billing_plan_period_id = v.period_id, coverage = v.coverage
             from unnest($1::uuid[], $2::uuid[], $3::text[]) as v(period_id, entry_id, coverage)
            where a.id = v.entry_id and a.kind = 'time' and a.law_firm_id = $4`,
          [firstPeriodIds, firstEntryIds, firstCoverages, lawFirmId]
        );
      }
      return rows;
    });

    const coverage = await this._periodCoverageBatch(written.map((r: any) => r.id));
    for (const row of written) {
      const c = coverage.get(row.id) || { covered: [], overage: [] };
      out.set(dateOnly(row.period_start_date), periodEntity(row, c.covered, c.overage));
    }
    return out;
  }

  /**
   * Opens the period an invoice was drafted from for billing again, once that
   * invoice no longer holds it (voided). The link is cleared and the status goes
   * back to ready_to_bill; the period's usage is recomputed on its next read.
   */
  async releasePeriodsOfInvoice(lawFirmId: string, invoiceId: string) {
    if (!isUuid(invoiceId)) return;
    await financialRootSql(
      `update billing_plan_periods
          set status = 'ready_to_bill', generated_invoice_id = null,
              generated_invoice_context_type = null, generated_invoice_entity_id = null,
              generated_at = null, updated_at = now()
        where law_firm_id = $1 and generated_invoice_id = $2`,
      [lawFirmId, invoiceId]
    );
  }

  async updatePeriod(lawFirmId: string, planId: string, periodStartDate: any, data: any) {
    const start = dateOnly(periodStartDate);
    const map = { status: 'status', generatedInvoiceContextType: 'generated_invoice_context_type' };
    const set = [];
    const params: unknown[] = [lawFirmId, planId, start];
    for (const [field, col] of Object.entries(map)) {
      if (data[field] !== undefined) { params.push(data[field]); set.push(`${col} = $${params.length}`); }
    }
    if (data.generatedInvoiceId !== undefined) { params.push(isUuid(data.generatedInvoiceId) ? data.generatedInvoiceId : null); set.push(`generated_invoice_id = $${params.length}`); }
    if (data.generatedInvoiceEntityId !== undefined) { params.push(isUuid(data.generatedInvoiceEntityId) ? data.generatedInvoiceEntityId : null); set.push(`generated_invoice_entity_id = $${params.length}`); }
    if (data.generatedAt !== undefined) { params.push(tsValue(data.generatedAt)); set.push(`generated_at = $${params.length}`); }
    if (!set.length) return this.findPeriodById(lawFirmId, planId, start);
    set.push('updated_at = now()');
    const { rows } = await financialRootSql(
      `update billing_plan_periods set ${set.join(',')}
        where law_firm_id = $1 and billing_plan_id = $2 and period_start_date = $3 returning *`,
      params
    );
    if (!rows[0]) return null;
    const { covered, overage } = await this._periodCoverage(rows[0].id);
    return periodEntity(rows[0], covered, overage);
  }

}

export = new PlansRepository();

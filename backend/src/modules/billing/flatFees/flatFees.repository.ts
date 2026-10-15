const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../../shared/database/financialQuery');
const { isUuid } = require('../../../shared/utils/isUuid');

// Map a billing context (matter|client) to the dual-FK columns.
function ctx(context: any) {
  return context.type === 'matter'
    ? { col: 'matter_id', value: context.entityId, matter_id: context.entityId, client_id: null }
    : { col: 'client_id', value: context.entityId, matter_id: null, client_id: context.entityId };
}

function toEntity(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    flatFeeId: r.id,
    // Derived, not stored, exactly as expenses.repository and
    // timeEntries.repository derive them from the same XOR-constrained
    // matter_id/client_id pair. Only `invoices` has real context columns.
    // formatFlatFee already read contextType and clientContextId, and toEntity
    // never set them, so both were permanently null in the API response while
    // the two sibling modules answered correctly. Three near-copies drifting is
    // the failure AGENTS.md names; this is the third catching up.
    contextType: r.matter_id ? 'matter' : 'client',
    entityId: r.matter_id || r.client_id,
    clientContextId: r.client_id,
    lawFirmId: r.law_firm_id,
    matterId: r.matter_id,
    clientId: r.client_id,
    description: r.description || '',
    amount: r.amount_cents == null ? 0 : Number(r.amount_cents) / 100, // cents -> dollars
    // fee_date is a day-only `date` column; node-pg returns it as a raw
    // 'YYYY-MM-DD' string (oid 1082 parser in db.js), so don't wrap it in a Date.
    date: r.activity_date || null,
    createdBy: r.created_by || null,
    createdAt: r.created_at ? r.created_at.toISOString() : null,
    updatedAt: r.updated_at ? r.updated_at.toISOString() : null,
  };
}

// A day-only flat-fee date: keep just the 'YYYY-MM-DD' portion so a `date` column
// stores the calendar day the user picked without any timezone shift.
function toDayOnly(value: any) {
  if (value == null || value === '') return null;
  return String(value).slice(0, 10);
}

const toCents = (v: any) => Math.round((Number(v) || 0) * 100);

class FlatFeesRepository {
  async create(context: any, data: any) {
    const c = ctx(context);
    const { rows } = await financialRootSql(
      // A flat fee is a `kind = 'flat_fee'` row of `activities` (migration 0232).
      // The entered amount is `charge_cents`; `amount_cents` is generated from it.
      `insert into activities (kind, law_firm_id, matter_id, client_id, description, charge_cents, activity_date, created_by)
       values ('flat_fee', $1, $2, $3, $4, $5, $6, $7) returning *`,
      [context.lawFirmId, c.matter_id, c.client_id, (data.description || '').trim(), toCents(data.amount),
        toDayOnly(data.date), data.createdBy || null]
    );
    return toEntity(rows[0]);
  }

  async findById(context: any, flatFeeId: any) {
    if (!isUuid(flatFeeId)) return null;
    const c = ctx(context);
    const { rows } = await financialRootSql(
      `select * from activities where kind = 'flat_fee' and law_firm_id = $1 and ${c.col} = $2 and id = $3`,
      [context.lawFirmId, c.value, flatFeeId]
    );
    return toEntity(rows[0]);
  }

  /**
   * One page of the firm's flat fees, across every context the caller may read.
   *
   * THREE THINGS ARE DELIBERATELY IN SQL HERE rather than in the service.
   *
   * `is_billed` is the same question `billingReads.billedSourceIds` asks per
   * context (an `invoice_line_items` row of kind `flat_fee` whose `source_id`
   * names this row, on an invoice in this row's OWN context), asked once for
   * every row. Answering it in JS would mean loading the firm's line items, and
   * filtering on it in JS would make `total_count` below describe a different set
   * than the rows.
   *
   * The access predicate takes `accessibleMatterIds` from the caller, which is
   * `billingReads.listAccessibleMatters` - the same helper the other firm-wide
   * billing reads use. A client-context fee carries no matter, and the
   * per-client route gates on firm membership alone, so those are visible to any
   * member; the `clients` existence check is what keeps a row naming ANOTHER
   * firm's client out, exactly as `assertClientInFirm` does on that route.
   *
   * `count(*) over ()` and `sum(amount_cents) over ()` ride on the page query, so
   * the total match count and the total value cost no extra round trip. Window
   * functions run after WHERE and before LIMIT, so both describe the whole
   * filtered set rather than the page. They ride on the RETURNED rows, though,
   * so a page past the end carries neither; that case (and `countOnly`) falls to
   * the aggregate-only form, which is the same CTE with a different tail.
   */
  async findForFirm(lawFirmId: string, options: any = {}) {
    const {
      accessibleMatterIds = [],
      matterIds,
      clientId,
      context,
      billingStatuses,
      dateFrom,
      dateTo,
      limit,
      offset = 0,
      countOnly = false,
    } = options;

    const params: unknown[] = [lawFirmId, (accessibleMatterIds || []).filter(isUuid)];
    let where = `a.kind = 'flat_fee' and a.law_firm_id = $1
      and (
        (a.matter_id is not null and a.matter_id = any($2::uuid[]))
        or (a.client_id is not null and exists (
              select 1 from clients cl
               where cl.id = a.client_id and cl.law_firm_id = a.law_firm_id))
      )`;

    // `clientId` and `matterIds` select DIFFERENT context halves, so they are
    // OR'd: a fee holds exactly one of `matter_id` and `client_id`, and ANDing
    // them would return nothing for every caller that sent both. Sending both is
    // the client billing tab's own question - this client's fees, plus the fees
    // on this client's matters - answered in one request.
    const selectors: string[] = [];
    if (clientId !== undefined && clientId !== null) {
      // A non-uuid id cannot match a uuid column, and casting one raises an
      // error rather than returning nothing. Say "matches nothing" in SQL.
      if (isUuid(clientId)) {
        params.push(clientId);
        selectors.push(`a.client_id = $${params.length}`);
      } else {
        selectors.push('false');
      }
    }
    if (Array.isArray(matterIds)) {
      const ids = matterIds.filter(isUuid);
      if (ids.length) {
        params.push(ids);
        selectors.push(`a.matter_id = any($${params.length}::uuid[])`);
      } else {
        selectors.push('false');
      }
    }
    if (selectors.length) where += ` and (${selectors.join(' or ')})`;

    if (context === 'matter') where += ' and a.matter_id is not null';
    if (context === 'client') where += ' and a.client_id is not null';
    if (dateFrom) {
      params.push(dateFrom);
      where += ` and a.activity_date >= $${params.length}`;
    }
    if (dateTo) {
      params.push(dateTo);
      where += ` and a.activity_date <= $${params.length}`;
    }

    // Applied OUTSIDE the CTE, where `is_billed` exists. WHERE runs before the
    // window functions, so the totals still describe the narrowed set.
    let billedWhere = '';
    const statuses = Array.isArray(billingStatuses) ? billingStatuses : [];
    if (statuses.length === 1 && statuses[0] === 'billed') billedWhere = 'where is_billed';
    if (statuses.length === 1 && statuses[0] === 'unbilled') billedWhere = 'where not is_billed';

    const cte = `with visible as (
      select a.*,
             exists (
               select 1
                 from invoice_line_items li
                 join invoices i on i.id = li.invoice_id
                where i.law_firm_id = a.law_firm_id
                  and li.kind = 'flat_fee'
                  and li.source_id = a.id::text
                  and i.status <> 'voided'
                  and case when a.matter_id is not null
                           then i.matter_id = a.matter_id
                           else i.client_context_id = a.client_id end
             ) as is_billed
        from activities a
       where ${where}
    )`;

    const aggregate = async () => {
      const { rows } = await financialRootSql(
        `${cte}
         select count(*) as total, coalesce(sum(amount_cents), 0) as total_cents
           from visible ${billedWhere}`,
        params,
      );
      return {
        totalItems: Number(rows[0]?.total) || 0,
        totalCents: Number(rows[0]?.total_cents) || 0,
      };
    };

    if (countOnly) {
      const totals = await aggregate();
      return { flatFees: [], ...totals };
    }

    const pageParams = [...params, limit, offset];
    const { rows } = await financialRootSql(
      `${cte}
       select *, count(*) over () as total_count,
              coalesce(sum(amount_cents) over (), 0) as total_cents
         from visible ${billedWhere}
        order by created_at desc, id desc
        limit $${pageParams.length - 1} offset $${pageParams.length}`,
      pageParams,
    );

    const flatFees = rows.map((r: any) => ({ ...toEntity(r), isBilled: r.is_billed === true }));
    if (rows.length) {
      return {
        flatFees,
        totalItems: Number(rows[0].total_count) || 0,
        totalCents: Number(rows[0].total_cents) || 0,
      };
    }
    // An empty page at offset 0 genuinely matched nothing, so the common path
    // stays one round trip; only a page past the end pays for the aggregate.
    if (offset <= 0) return { flatFees, totalItems: 0, totalCents: 0 };
    return { flatFees, ...(await aggregate()) };
  }

  async findByContext(context: any) {
    const c = ctx(context);
    const { rows } = await financialRootSql(
      `select * from activities where kind = 'flat_fee' and law_firm_id = $1 and ${c.col} = $2 order by created_at desc`,
      [context.lawFirmId, c.value]
    );
    return rows.map(toEntity);
  }

  async update(context: any, flatFeeId: any, data: any) {
    if (!isUuid(flatFeeId)) return null;
    const set: any[] = [];
    const params: unknown[] = [context.lawFirmId, flatFeeId];
    const add = (col: any, val: any) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (data.description !== undefined) add('description', String(data.description).trim());
    if (data.amount !== undefined) add('charge_cents', toCents(data.amount));
    if (data.date !== undefined) add('activity_date', toDayOnly(data.date));
    if (!set.length) return this.findById(context, flatFeeId);
    const { rows } = await financialRootSql(
      `update activities set ${set.join(', ')} where kind = 'flat_fee' and law_firm_id = $1 and id = $2 returning *`,
      params
    );
    return toEntity(rows[0]);
  }

  async delete(context: any, flatFeeId: any) {
    if (!isUuid(flatFeeId)) return;
    await financialRootSql(`delete from activities where kind = 'flat_fee' and law_firm_id = $1 and id = $2`, [context.lawFirmId, flatFeeId]);
  }
}

export = new FlatFeesRepository();

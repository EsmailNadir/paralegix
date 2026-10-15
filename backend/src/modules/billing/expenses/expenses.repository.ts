import { ceilingLimit, withinCeiling } from '../../../shared/database/readCeiling';
const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../../shared/database/financialQuery');
const { isUuid } = require('../../../shared/utils/isUuid');

function ctx(context: any) {
  return context.type === 'matter'
    ? { col: 'matter_id', value: context.entityId, matter_id: context.entityId, client_id: null }
    : { col: 'client_id', value: context.entityId, matter_id: null, client_id: context.entityId };
}

const toCents = (v: any) => Math.round((Number(v) || 0) * 100);
const dateOnly = (v: any) => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (typeof v.toDate === 'function') return v.toDate().toISOString().slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
};

function toEntity(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    expenseId: r.id,
    lawFirmId: r.law_firm_id,
    matterId: r.matter_id,
    clientId: r.client_id,
    contextType: r.matter_id ? 'matter' : 'client',
    entityId: r.matter_id || r.client_id,
    clientContextId: r.client_id,
    description: r.description || '',
    amount: r.amount_cents == null ? 0 : Number(r.amount_cents) / 100,
    date: r.activity_date || null,
    category: r.category_code ?? r.category ?? '',
    expenseCategoryId: r.billing_code_id,
    vendor: r.vendor || '',
    billable: r.billable,
    receiptUrl: r.receipt_object_path,
    userId: r.user_id,
    createdBy: r.created_by,
    createdAt: r.created_at ? r.created_at.toISOString() : null,
    updatedAt: r.updated_at ? r.updated_at.toISOString() : null,
  };
}

class ExpensesRepository {
  async create(context: any, data: any) {
    const c = ctx(context);
    const categoryValue = data.expenseCategoryId ? null : ((data.category || '').trim() || null);
    const { rows } = await financialRootSql(
      // An expense is a `kind = 'expense'` row of `activities` (migration 0232).
      // The entered amount is `charge_cents`; `amount_cents` is generated from it.
      `with created as (
         insert into activities
           (kind, law_firm_id, matter_id, client_id, description, charge_cents, activity_date, category,
            billing_code_id, vendor, billable, receipt_object_path, user_id, created_by)
         values ('expense',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *
       )
       select created.*, bc.code as category_code, bc.name as category_name
       from created
       left join billing_codes bc on bc.id = created.billing_code_id`,
      [context.lawFirmId, c.matter_id, c.client_id, (data.description || '').trim(), toCents(data.amount),
       dateOnly(data.date), categoryValue, data.expenseCategoryId || null,
       (data.vendor || '').trim() || null, data.billable !== false, data.receiptUrl || null,
       data.userId || null, data.createdBy || data.userId || null]
    );
    return toEntity(rows[0]);
  }

  async findById(context: any, expenseId: any) {
    if (!isUuid(expenseId)) return null;
    const c = ctx(context);
    const { rows } = await financialRootSql(
      `select a.*, bc.code as category_code, bc.name as category_name
       from activities a
       left join billing_codes bc on bc.id = a.billing_code_id
       where a.kind = 'expense' and a.law_firm_id = $1 and a.${c.col} = $2 and a.id = $3`,
      [context.lawFirmId, c.value, expenseId]
    );
    return toEntity(rows[0]);
  }

  /**
   * Every expense on one matter or client.
   *
   * Unpaged because callers total it. The ceiling refuses instead of
   * truncating: a short array would render as a smaller total, which is a wrong
   * invoice rather than a slow one.
   */
  async findAll(context: any) {
    const c = ctx(context);
    const { rows } = await financialRootSql(
      `select a.*, bc.code as category_code, bc.name as category_name
       from activities a
       left join billing_codes bc on bc.id = a.billing_code_id
       where a.kind = 'expense' and a.law_firm_id = $1 and a.${c.col} = $2
       order by a.activity_date desc nulls last, a.created_at desc limit $3`,
      [context.lawFirmId, c.value, ceilingLimit()]
    );
    return withinCeiling(rows, 'expenses on this record').map(toEntity);
  }

  async update(context: any, expenseId: any, data: any) {
    if (!isUuid(expenseId)) return null;
    const set: any[] = [];
    const params: unknown[] = [context.lawFirmId, expenseId];
    const add = (col: any, val: any) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (data.description !== undefined) add('description', String(data.description).trim());
    if (data.amount !== undefined) add('charge_cents', toCents(data.amount));
    if (data.date !== undefined) add('activity_date', dateOnly(data.date));
    if (data.expenseCategoryId !== undefined) {
      add('billing_code_id', data.expenseCategoryId || null);
      if (data.expenseCategoryId) {
        add('category', null);
      } else if (data.category !== undefined) {
        add('category', (data.category || '').trim() || null);
      }
    } else if (data.category !== undefined) {
      add('category', (data.category || '').trim() || null);
    }
    if (data.vendor !== undefined) add('vendor', (data.vendor || '').trim() || null);
    if (data.billable !== undefined) add('billable', data.billable);
    if (data.receiptUrl !== undefined) add('receipt_object_path', data.receiptUrl || null);
    if (!set.length) return this.findById(context, expenseId);
    const { rows } = await financialRootSql(
      `with updated as (
         update activities set ${set.join(', ')} where kind = 'expense' and law_firm_id = $1 and id = $2 returning *
       )
       select updated.*, bc.code as category_code, bc.name as category_name
       from updated
       left join billing_codes bc on bc.id = updated.billing_code_id`,
      params
    );
    return toEntity(rows[0]);
  }

  async delete(context: any, expenseId: any) {
    if (!isUuid(expenseId)) return;
    await financialRootSql(`delete from activities where kind = 'expense' and law_firm_id = $1 and id = $2`, [context.lawFirmId, expenseId]);
  }
}

export = new ExpensesRepository();

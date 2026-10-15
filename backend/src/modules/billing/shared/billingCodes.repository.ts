/**
 * One repository for the firm's billing pick lists, parameterised by `kind`.
 *
 * Charge codes and expense categories are the same thing: a per-firm list of
 * `code` / `name` rows the firm orders, activates and retires, optionally
 * adopted from the UTBMS catalog. They lived in two tables with two copies of
 * this file until migration 0231 put them in `billing_codes`, told apart by
 * `kind`. The two route files and services are unchanged; each builds its
 * repository from this factory with its own kind, so a charge-code route can
 * never read or write an expense row, and vice versa.
 *
 * The entity shape is exactly what each module's API returned before the merge
 * (`order` for `sort_order`, ISO timestamps, `defaultRate` as a number). `kind`
 * is never emitted, and the columns that belong to the other kind are left off:
 * an expense category has no `defaultRate`, a charge code no `isDefault`.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { activities, billingCodes } from '../../../shared/database/drizzle/schema';
import { tenantParameterizedQuery, tenantQuery, type DrizzleExecutor } from '../../../shared/database/queryContext';
import { scopedDelete, scopedInsert, scopedInsertManyOnConflictDoNothing, scopedUpdate } from '../../../shared/database/scopedWrite';
import { rowIso } from '../../../shared/utils/dateConversion';
const { isUuid } = require('../../../shared/utils/isUuid');
const { configuredRate } = require('./rateResolution');

export type BillingCodeKind = 'charge' | 'expense';

type Row = typeof billingCodes.$inferSelect;

function formatCode(kind: BillingCodeKind, r: Row | undefined) {
  if (!r) return null;
  const base: Record<string, unknown> = {
    id: r.id,
    lawFirmId: r.lawFirmId,
    code: r.code,
    name: r.name,
    isActive: r.isActive,
    order: r.sortOrder,
    utbmsCodeId: r.utbmsCodeId,
    createdBy: r.createdBy,
    createdAt: rowIso(r.createdAt),
    updatedAt: rowIso(r.updatedAt),
  };
  if (kind === 'charge') {
    // `default_rate` is a `numeric` column, which node-pg hands back as a STRING.
    // Rate resolution and the settings page both decide "a rate is configured" by
    // testing for a number, so it has to be converted here or a code with a rate
    // reads as having none.
    base.defaultRate = configuredRate(r.defaultRateCents != null ? Number(r.defaultRateCents) / 100 : r.defaultRate);
    base.defaultRateCents = r.defaultRateCents != null ? Number(r.defaultRateCents) : (r.defaultRate != null ? Math.round(Number(r.defaultRate) * 100) : null);
    base.memberRates = r.memberRates || {};
  } else {
    base.isDefault = r.isDefault;
  }
  return base;
}

/** camelCase entity fields to Drizzle insert/update values. */
function toValues(kind: BillingCodeKind, data: Record<string, any>) {
  const values: Record<string, unknown> = {};
  const map: Record<string, string> = {
    code: 'code', name: 'name', isActive: 'isActive', isDefault: 'isDefault', order: 'sortOrder',
    defaultRate: 'defaultRate', memberRates: 'memberRates', utbmsCodeId: 'utbmsCodeId', createdBy: 'createdBy',
  };
  for (const [field, column] of Object.entries(map)) {
    if (data[field] === undefined) continue;
    if (field === 'defaultRate') {
      values.defaultRate = data[field] != null ? String(data[field]) : null;
      values.defaultRateCents = data[field] != null ? Math.round(Number(data[field]) * 100) : null;
      continue;
    }
    values[column] = data[field];
  }
  values.kind = kind;
  return values;
}

export function createBillingCodesRepository(kind: BillingCodeKind) {
  const ofKind = eq(billingCodes.kind, kind);

  return {
    /** Every row of this kind for the firm. Ordering is the service's. */
    async findAll(lawFirmId: string) {
      const rows = await tenantQuery(billingCodes, lawFirmId, ({ executor, scope }) => executor
        .select().from(billingCodes).where(and(scope, ofKind)).orderBy(asc(billingCodes.sortOrder), asc(billingCodes.code)));
      return rows.map((r) => formatCode(kind, r));
    },

    async findById(lawFirmId: string, id: unknown) {
      if (!isUuid(id)) return null;
      const rows = await tenantQuery(billingCodes, lawFirmId, ({ executor, scope }) => executor
        .select().from(billingCodes).where(and(scope, ofKind, eq(billingCodes.id, id as string))).limit(1));
      return formatCode(kind, rows[0]);
    },

    async findByCode(lawFirmId: string, code: unknown) {
      const rows = await tenantQuery(billingCodes, lawFirmId, ({ executor, scope }) => executor
        .select().from(billingCodes).where(and(scope, ofKind, eq(billingCodes.code, String(code).toUpperCase()))));
      return rows.map((r) => formatCode(kind, r));
    },

    async getMaxOrder(lawFirmId: string) {
      const rows = await tenantQuery(billingCodes, lawFirmId, ({ executor, scope }) => executor
        .select({ m: sql<number>`coalesce(max(${billingCodes.sortOrder}), 0)::int` })
        .from(billingCodes).where(and(scope, ofKind)));
      return Number(rows[0]?.m) || 0;
    },

    /**
     * Positions become 1..n in the order given. Plain SQL through the audited
     * runner rather than the query builder: the `unnest` join is the shape the
     * planner handles as one update, and the tenant and kind predicates are in
     * the text where the audit can see them.
     */
    async reorder(lawFirmId: string, ids: string[]) {
      const ords = ids.map((_, i) => i + 1);
      await tenantParameterizedQuery(
        billingCodes,
        lawFirmId,
        `update billing_codes c set sort_order = v.ord
           from unnest($2::uuid[], $3::int[]) as v(id, ord)
          where c.law_firm_id = $1 and c.kind = $4 and c.id = v.id`,
        [lawFirmId, ids, ords, kind],
        'c',
      );
    },

    /**
     * True if any work row in the firm references this code: a time entry for a
     * charge code, an expense for an expense category. The delete guard.
     */
    async isInUse(lawFirmId: string, id: unknown) {
      if (!isUuid(id)) return false;
      // Both kinds of code are named by `activities.billing_code_id`: a time
      // entry's charge code, an expense's category.
      const rows = await tenantQuery(activities, lawFirmId, ({ executor, scope }) => executor
        .select({ one: sql`1` }).from(activities).where(and(scope, eq(activities.billingCodeId, id as string))).limit(1));
      return rows.length > 0;
    },

    async create(lawFirmId: string, data: Record<string, any>, executor?: DrizzleExecutor) {
      const rows = await scopedInsert(billingCodes, lawFirmId, toValues(kind, data) as any, executor);
      return formatCode(kind, rows[0]);
    },

    /**
     * Inserts the rows whose code the firm does not have yet, in one statement.
     * A concurrent caller inserting the same codes is skipped rather than
     * refused, so seeding a firm's defaults can run from several requests at once.
     */
    async createManyIfAbsent(lawFirmId: string, rows: Record<string, any>[]) {
      const inserted = await scopedInsertManyOnConflictDoNothing(
        billingCodes,
        lawFirmId,
        rows.map((data) => toValues(kind, data) as any),
        [billingCodes.lawFirmId, billingCodes.kind, billingCodes.code],
      );
      return inserted.map((r) => formatCode(kind, r));
    },

    async update(lawFirmId: string, id: unknown, data: Record<string, any>) {
      if (!isUuid(id)) return null;
      const { kind: _kind, ...values } = toValues(kind, data);
      const rows = await scopedUpdate(billingCodes, lawFirmId, and(ofKind, eq(billingCodes.id, id as string))!, values as any);
      return formatCode(kind, rows[0]);
    },

    async delete(lawFirmId: string, id: unknown) {
      if (!isUuid(id)) return;
      await scopedDelete(billingCodes, lawFirmId, and(ofKind, eq(billingCodes.id, id as string))!);
    },
  };
}

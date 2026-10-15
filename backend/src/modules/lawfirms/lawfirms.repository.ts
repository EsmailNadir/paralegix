import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  lte,
  or,
  sql,
  type SQL, isNull} from 'drizzle-orm';
import {clients, lawFirms, matters, legalHolds } from '../../shared/database/drizzle/schema';
import { adminQuery, firmQuery, systemQuery, tenantQuery, type DrizzleExecutor } from '../../shared/database/queryContext';
const { isUuid } = require('../../shared/utils/isUuid');
import { toIlikeTerm } from '../../shared/database/searchTerm';
import { applyCeiling, LIST_CEILING, resolvePage } from '../../shared/database/pagination';

const BILLING_STATUS_COLUMN_VALUES = new Set([
  'comped', 'active', 'trialing', 'incomplete', 'past_due', 'canceled',
]);

function normalizeBillingStatusColumn(status: any) {
  if (status == null) return status;
  if (BILLING_STATUS_COLUMN_VALUES.has(status)) return status;
  switch (status) {
    case 'unpaid': return 'past_due';
    // 'suspended' is the admin console's own spelling for the same state --
    // admin.validation accepts it and the frontend labels it "Canceled" -- so it
    // must not fall through to the default below, which would turn an admin
    // cancelling a firm into an unexplained 'incomplete'.
    case 'suspended':
    case 'cancelled':
    case 'incomplete_expired': return 'canceled';
    default: return 'incomplete';
  }
}

function toEntity(row: any) {
  if (!row) return null;
  // `plan_id` / `billing_status` are the authoritative store and the jsonb no
  // longer carries them (migration 0200), so these are assignments rather than
  // the fallbacks they used to be. The returned shape is unchanged: every
  // consumer still reads `plan.planId` and `plan.billingStatus`.
  //
  // `incomplete` is the fail-CLOSED default for a missing status, not `comped`.
  // A firm with no status must never be treated as paying; genuinely comped
  // firms carry the value explicitly.
  const plan: any = { ...(row.plan || {}) };
  plan.planId = row.planId || 'starter';
  plan.billingStatus = row.billingStatus || 'incomplete';
  return {
    id: row.id,
    lawFirmId: row.id,
    name: row.name,
    description: row.description || null,
    address: row.address || null,
    city: row.city || null,
    state: row.state || null,
    zip: row.zip || null,
    phone: row.phone || null,
    website: row.website || null,
    email: row.email || null,
    logoObjectPath: row.logoObjectPath || null,
    planId: row.planId,
    billingStatus: row.billingStatus,
    plan,
    settings: row.settings || {},
    storageQuotaBytes: row.storageQuotaBytes == null ? null : Number(row.storageQuotaBytes),
    storageUsedBytes: Number(row.storageUsedBytes || 0),
    storageHardLimit: row.storageHardLimit,
    storageWarnAtPercent: row.storageWarnAtPercent == null ? null : Number(row.storageWarnAtPercent),
    stripeAccountId: row.stripeAccountId || null,
    stripeChargesEnabled: row.stripeChargesEnabled,
    stripeOnboardingComplete: row.stripeOnboardingComplete,
    directChargesEnabled: row.directChargesEnabled === true,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    pendingDeletionAt: row.pendingDeletionAt instanceof Date ? row.pendingDeletionAt.toISOString() : row.pendingDeletionAt || null,
    deletionPurgeAfter: row.deletionPurgeAfter instanceof Date ? row.deletionPurgeAfter.toISOString() : row.deletionPurgeAfter || null,
  };
}

const SCALAR: Record<string, keyof typeof lawFirms.$inferInsert> = {
  name: 'name',
  description: 'description',
  address: 'address',
  city: 'city',
  state: 'state',
  zip: 'zip',
  phone: 'phone',
  website: 'website',
  email: 'email',
  logoObjectPath: 'logoObjectPath',
  planId: 'planId',
  billingStatus: 'billingStatus',
  storageQuotaBytes: 'storageQuotaBytes',
  storageUsedBytes: 'storageUsedBytes',
  storageHardLimit: 'storageHardLimit',
  storageWarnAtPercent: 'storageWarnAtPercent',
  stripeAccountId: 'stripeAccountId',
  stripeChargesEnabled: 'stripeChargesEnabled',
  stripeOnboardingComplete: 'stripeOnboardingComplete',
  directChargesEnabled: 'directChargesEnabled',
};

function firmOrder(sort: any, sortBy: string, order: string) {
  const columns: Record<string, any> = {
    createdAt: lawFirms.createdAt,
    updatedAt: lawFirms.updatedAt,
    name: lawFirms.name,
    planId: lawFirms.planId,
    billingStatus: lawFirms.billingStatus,
    storageUsedBytes: lawFirms.storageUsedBytes,
    memberCount: sql.raw('member_count'),
    matterCount: sql.raw('matter_count'),
    clientCount: sql.raw('client_count'),
  };
  const model = Array.isArray(sort) && sort.length ? sort : [{ field: sortBy, dir: order }];
  const expressions: SQL[] = [];
  for (const item of model) {
    const column = columns[item?.field];
    if (!column) continue;
    const direction = String(item?.dir).toLowerCase() === 'asc' ? sql.raw('asc') : sql.raw('desc');
    expressions.push(sql`${column} ${direction} nulls last`);
  }
  if (!expressions.length) expressions.push(sql`${lawFirms.createdAt} desc nulls last`);
  expressions.push(sql`${lawFirms.id} asc`);
  return expressions;
}

class LawfirmsRepository {
  async findById(lawFirmId: string, executor?: DrizzleExecutor) {
    // `law_firms.id` is a uuid column, so a malformed id reaches Postgres as a
    // cast error and surfaces as a 500 with a query string in the log. A
    // malformed id names no firm, so answering "not found" is both correct and
    // what every caller here already handles. This mirrors what DrizzleRepository
    // does through validId() for the tables it owns.
    if (!isUuid(lawFirmId)) return null;
    const rows = await firmQuery(lawFirms, lawFirmId, ({ executor: queryExecutor, scope }) =>
      queryExecutor.select().from(lawFirms).where(scope).limit(1), executor);
    return toEntity(rows[0]);
  }

  async findByStripeAccountId(accountId: string) {
    if (!accountId) return null;
    const rows = await systemQuery('stripe_idempotency', (executor) => executor.select().from(lawFirms)
      .where(eq(lawFirms.stripeAccountId, accountId)).limit(1));
    return toEntity(rows[0]);
  }

  async listAllCapped({ ceiling = LIST_CEILING }: any = {}) {
    const rows = await adminQuery('capped platform firm export', (executor) => executor.select().from(lawFirms)
      .orderBy(desc(lawFirms.createdAt), asc(lawFirms.id)).limit(ceiling + 1));
    const capped = applyCeiling(rows, ceiling);
    return {
      lawFirms: capped.rows.map(toEntity),
      truncated: capped.truncated,
      ceiling: capped.ceiling,
    };
  }

  async listAllPaged(options: any = {}) {
    const { limit, offset, page, search, sort, sortBy, order, planId, billingStatus } = options;
    const filters: SQL[] = [];
    const term = toIlikeTerm(search);
    if (term) filters.push(or(
      sql`${lawFirms.id}::text ilike ${term} escape '\\'`,
      sql`${lawFirms.name} ilike ${term} escape '\\'`,
      sql`${lawFirms.email}::text ilike ${term} escape '\\'`,
      sql`${lawFirms.phone} ilike ${term} escape '\\'`,
      sql`${lawFirms.city} ilike ${term} escape '\\'`,
      sql`${lawFirms.state} ilike ${term} escape '\\'`,
    )!);
    if (planId) filters.push(eq(lawFirms.planId, planId));
    if (billingStatus) filters.push(eq(lawFirms.billingStatus, billingStatus));
    const predicate = filters.length ? and(...filters) : undefined;
    const paging = limit == null ? null : resolvePage({ limit, offset, page });
    const ordering = firmOrder(sort, sortBy, order);

    const rows = await adminQuery<any[]>('platform firm directory', (executor) => {
      let query: any = executor.select({
        ...getTableColumns(lawFirms),
        totalCount: sql<number>`count(*) over()`,
        memberCount: sql<number>`(
          select count(*)::int from members where law_firm_id = ${lawFirms.id}
        )`.as('member_count'),
        matterCount: sql<number>`(
          select count(*)::int from matters where law_firm_id = ${lawFirms.id}
        )`.as('matter_count'),
        clientCount: sql<number>`(
          select count(*)::int from clients where law_firm_id = ${lawFirms.id}
        )`.as('client_count'),
      }).from(lawFirms).where(predicate).orderBy(...ordering);
      if (paging) query = query.limit(paging.limit).offset(paging.offset);
      return query;
    });
    let totalItems = rows.length ? Number(rows[0].totalCount) : 0;
    if (!rows.length && paging?.offset) {
      const totals = await adminQuery('platform firm directory count', (executor) => executor
        .select({ total: count() }).from(lawFirms).where(predicate));
      totalItems = totals[0]?.total || 0;
    }
    return {
      lawFirms: rows.map((row) => ({
        ...toEntity(row),
        memberCount: Number(row.memberCount) || 0,
        matterCount: Number(row.matterCount) || 0,
        clientCount: Number(row.clientCount) || 0,
      })),
      totalItems,
    };
  }

  async countAll() {
    const [row] = await adminQuery('platform firm count', (executor) => executor
      .select({ total: count() }).from(lawFirms));
    return row?.total || 0;
  }

  async platformStats() {
    const [row] = await adminQuery('platform firm statistics', (executor) => executor.select({
      total: count(),
      new7d: sql<number>`count(*) filter (where ${lawFirms.createdAt} >= now() - interval '7 days')::int`,
      new30d: sql<number>`count(*) filter (where ${lawFirms.createdAt} >= now() - interval '30 days')::int`,
      byPlan: sql<Record<string, number>>`coalesce((
        select jsonb_object_agg(grouped.key, grouped.total) from (
          select coalesce(plan_id, 'none') as key, count(*)::int as total
          from law_firms group by 1
        ) grouped
      ), '{}'::jsonb)`,
      byBillingStatus: sql<Record<string, number>>`coalesce((
        select jsonb_object_agg(grouped.key, grouped.total) from (
          select coalesce(billing_status, 'none') as key, count(*)::int as total
          from law_firms group by 1
        ) grouped
      ), '{}'::jsonb)`,
    }).from(lawFirms));
    return row || { total: 0, new7d: 0, new30d: 0, byPlan: {}, byBillingStatus: {} };
  }

  async listWithStripeSubscription(limit = 1000) {
    const rows = await systemQuery('stripe_idempotency', (executor) => executor.select().from(lawFirms)
      .where(sql`${lawFirms.plan}->>'stripeSubscriptionId' is not null`)
      .orderBy(asc(lawFirms.createdAt)).limit(limit));
    return rows.map(toEntity);
  }

  async mergePlan(lawFirmId: string, planPatch: any, executor?: DrizzleExecutor) {
    // `planId` and `billingStatus` are routed to their columns and kept OUT of
    // the jsonb, which is what makes the columns authoritative rather than a
    // mirror. Callers still pass them on the patch; they just do not land in
    // two places any more.
    const { planId, billingStatus, ...jsonbPatch } = planPatch || {};
    const values: Record<string, unknown> = {
      plan: sql`coalesce(${lawFirms.plan}, '{}'::jsonb) || ${JSON.stringify(jsonbPatch)}::jsonb`,
      updatedAt: sql`now()`,
    };
    if (planId !== undefined) values.planId = planId;
    if (billingStatus !== undefined) {
      values.billingStatus = normalizeBillingStatusColumn(billingStatus);
    }
    const rows = await firmQuery(lawFirms, lawFirmId, ({ executor: queryExecutor, scope }) =>
      queryExecutor.update(lawFirms).set(values).where(scope).returning(), executor);
    return toEntity(rows[0]);
  }

  async create(data: any, executor?: DrizzleExecutor) {
    const values: Record<string, unknown> = { name: data.name?.trim() || 'New Law Firm' };
    if (data.plan) {
      const { planId, billingStatus, ...planJsonb } = data.plan;
      values.planId = planId || 'starter';
      values.billingStatus = normalizeBillingStatusColumn(billingStatus) || 'comped';
      values.plan = planJsonb;
    }
    if (data.settings) values.settings = data.settings;
    for (const [field, schemaKey] of Object.entries(SCALAR)) {
      if (data[field] !== undefined && values[schemaKey] === undefined) values[schemaKey] = data[field];
    }
    const rows = await systemQuery('tenant_provisioning', (queryExecutor) => queryExecutor
      .insert(lawFirms).values(values as any).returning(), executor);
    return toEntity(rows[0]);
  }

  async lockForUpdate(lawFirmId: string, executor: DrizzleExecutor) {
    const rows = await firmQuery(lawFirms, lawFirmId, ({ executor: queryExecutor, scope }) => queryExecutor
      .select({ id: lawFirms.id }).from(lawFirms).where(scope).for('update'), executor);
    return rows[0] || null;
  }

  async update(lawFirmId: string, data: any, executor?: DrizzleExecutor) {
    const values: Record<string, unknown> = {};
    for (const [field, schemaKey] of Object.entries(SCALAR)) {
      if (data[field] !== undefined) values[schemaKey] = field === 'billingStatus'
        ? normalizeBillingStatusColumn(data[field])
        : data[field];
    }
    if (data.plan !== undefined) {
      // A whole-blob replace, so the two authoritative keys are peeled off here
      // too. `values.planId` / `values.billingStatus` may already be set from
      // SCALAR above; an explicit top-level field wins over the blob's copy.
      const { planId, billingStatus, ...planJsonb } = data.plan || {};
      if (planId !== undefined && values.planId === undefined) values.planId = planId;
      if (billingStatus !== undefined && values.billingStatus === undefined) {
        values.billingStatus = normalizeBillingStatusColumn(billingStatus);
      }
      values.plan = planJsonb;
    }
    if (data.settings !== undefined) values.settings = data.settings;
    if (!Object.keys(values).length) return this.findById(lawFirmId, executor);
    values.updatedAt = sql`now()`;
    const rows = await firmQuery(lawFirms, lawFirmId, ({ executor: queryExecutor, scope }) =>
      queryExecutor.update(lawFirms).set(values).where(scope).returning(), executor);
    return toEntity(rows[0]);
  }

  async mergeSettings(lawFirmId: string, patch: any, executor?: DrizzleExecutor) {
    const rows = await firmQuery(lawFirms, lawFirmId, ({ executor: queryExecutor, scope }) =>
      queryExecutor.update(lawFirms).set({
        settings: sql`coalesce(${lawFirms.settings}, '{}'::jsonb) || ${JSON.stringify(patch || {})}::jsonb`,
        updatedAt: sql`now()`,
      }).where(scope).returning(), executor);
    return toEntity(rows[0]);
  }

  async delete(lawFirmId: string, executor?: DrizzleExecutor) {
    await firmQuery(lawFirms, lawFirmId, ({ executor: queryExecutor, scope }) =>
      queryExecutor.delete(lawFirms).where(scope), executor);
  }

  /**
   * Soft-delete: stamp the retention window instead of destroying anything.
   * `retentionYears` is passed in by the service (env-configurable) rather than
   * hardcoded here, so the constant lives in one place.
   */
  async requestDeletion(lawFirmId: string, { requestedBy, retentionYears }: any, executor?: DrizzleExecutor) {
    const rows = await firmQuery(lawFirms, lawFirmId, ({ executor: queryExecutor, scope }) =>
      queryExecutor.update(lawFirms).set({
        pendingDeletionAt: sql`now()`,
        deletionPurgeAfter: sql`now() + make_interval(years => ${retentionYears})`,
        deletionRequestedBy: requestedBy,
        updatedAt: sql`now()`,
      }).where(scope).returning(), executor);
    return toEntity(rows[0]);
  }

  /** Undo a pending soft-delete. Only meaningful before the firm has been purged. */
  async cancelDeletionRequest(lawFirmId: string, executor?: DrizzleExecutor) {
    const rows = await firmQuery(lawFirms, lawFirmId, ({ executor: queryExecutor, scope }) =>
      queryExecutor.update(lawFirms).set({
        pendingDeletionAt: null,
        deletionPurgeAfter: null,
        deletionRequestedBy: null,
        updatedAt: sql`now()`,
      }).where(scope).returning(), executor);
    return toEntity(rows[0]);
  }

  /** Firms whose retention window has cleared and are ready for the purge sweep. */
  async findPurgeEligible(limit = 100) {
    const rows = await systemQuery('scheduler', (executor) => executor.select().from(lawFirms)
      .where(and(sql`${lawFirms.pendingDeletionAt} is not null`, lte(lawFirms.deletionPurgeAfter, sql`now()`)))
      .limit(limit));
    return rows.map(toEntity);
  }

  /**
   * Count matters and clients under legal hold anywhere in the firm. A hold
   * placed on one entity (`PATCH .../matters/:id/legal-hold`, or set directly
   * on a client) blocks that entity's own deletion route, but a firm-wide
   * purge does not go through those routes at all: it is a direct
   * `delete from law_firms` cascade. Without this check the automated
   * retention purge would silently destroy a record under an active
   * litigation hold, the exact outcome the per-entity guard exists to
   * prevent. Mirrors `countPermanentByLawFirmId`'s role as a purge gate.
   */
  async countLegalHoldByLawFirmId(lawFirmId: string) {
    // One table since migration 0221, so one query. Only unreleased holds count:
    // a released row is kept as the record of what was held and when.
    const rows = await tenantQuery(legalHolds, lawFirmId, ({ executor, scope }) => executor
      .select({ n: count() }).from(legalHolds)
      .where(and(scope, isNull(legalHolds.releasedAt))));
    return Number(rows[0]?.n || 0);
  }
}

export = new LawfirmsRepository();

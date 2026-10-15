import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { intakeSubmissions, leads } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
import { scopedDelete, scopedInsert, scopedUpdate } from '../../shared/database/scopedWrite';
import { toIlikeTerm } from '../../shared/database/searchTerm';
import { resolvePage } from '../../shared/database/pagination';

const { isUuid } = require('../../shared/utils/isUuid');
const { rowIso: iso } = require('../../shared/utils/dateConversion');

function formatLead(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    stageId: row.stageId || null,
    stageDate: row.stageDate || null,
    name: row.name || '',
    email: row.email || null,
    phone: row.phone || null,
    organization: row.organization || null,
    referralSource: row.referralSource || null,
    notes: row.notes || null,
    disqualifyReason: row.disqualifyReason || null,
    convertedClientId: row.convertedClientId || null,
    convertedMatterId: row.convertedMatterId || null,
    convertedAt: iso(row.convertedAt),
    createdBy: row.createdBy || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// A submission is created `pending` just before its email goes out. One that is
// still pending after this long belongs to a send that never finished (the
// process died mid-send), so it is reported as failed rather than as sending.
const PENDING_DELIVERY_STALE_MS = 15 * 60 * 1000;

function effectiveDeliveryStatus(row: any) {
  if (row.deliveryStatus !== 'pending') return row.deliveryStatus;
  const createdAt = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime();
  return Date.now() - createdAt > PENDING_DELIVERY_STALE_MS ? 'failed' : 'pending';
}

function formatIntakeStatus(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    deliveryStatus: effectiveDeliveryStatus(row),
    intakeFormTemplateId: row.intakeFormTemplateId,
    sentToEmail: row.sentToEmail || null,
    sentAt: iso(row.sentAt),
    openedAt: iso(row.openedAt),
    completedAt: iso(row.completedAt),
  };
}

const SORT_COLUMNS: Record<string, any> = {
  name: leads.name,
  email: leads.email,
  organization: leads.organization,
  createdAt: leads.createdAt,
  updatedAt: leads.updatedAt,
};

function leadOrder(sort: any, sortBy: string, order: string): SQL[] {
  const model = Array.isArray(sort) && sort.length ? sort : [{ field: sortBy, dir: order }];
  const expressions: SQL[] = [];
  for (const item of model) {
    const column = SORT_COLUMNS[item?.field];
    if (!column) continue;
    const direction = String(item?.dir).toLowerCase() === 'asc' ? asc : desc;
    expressions.push(direction(column));
  }
  if (!expressions.length) expressions.push(desc(leads.createdAt));
  expressions.push(asc(leads.id));
  return expressions;
}

class LeadsRepository {
  async listLeadsPaged(lawFirmId: string, {
    search,
    stageId,
    page = 1,
    limit = null,
    offset = null,
    sort,
    sortBy = 'createdAt',
    order = 'desc',
  }: any = {}) {
    if (stageId != null && stageId !== '' && !isUuid(stageId)) {
      return { leads: [], totalItems: 0 };
    }

    const filters: SQL[] = [];
    if (stageId) filters.push(eq(leads.stageId, stageId));

    const term = toIlikeTerm(search);
    if (term) {
      filters.push(sql`${leads.id} in (
        select id from leads where law_firm_id = ${lawFirmId} and name ilike ${term} escape '\\'
        union select id from leads where law_firm_id = ${lawFirmId} and email ilike ${term} escape '\\'
        union select id from leads where law_firm_id = ${lawFirmId} and organization ilike ${term} escape '\\'
      )`);
    }

    const paging = limit == null ? null : resolvePage({ limit, offset, page, max: 500 });
    const orderBy = leadOrder(sort, sortBy, order);

    const rows: any[] = await tenantQuery(leads, lawFirmId, ({ executor, scope }: any) => {
      const where = filters.length ? and(scope, ...filters) : scope;
      let q = executor.select().from(leads).where(where).orderBy(...orderBy);
      if (paging) q = q.limit(paging.limit).offset(paging.offset);
      return q;
    });

    let totalItems = rows.length;
    if (paging) {
      const countRows: any[] = await tenantQuery(leads, lawFirmId, ({ executor, scope }: any) => {
        const where = filters.length ? and(scope, ...filters) : scope;
        return executor.select({ total: sql<number>`count(*)::int` }).from(leads).where(where);
      });
      totalItems = countRows[0]?.total || 0;
    }

    return { leads: rows.map(formatLead), totalItems };
  }

  async getById(lawFirmId: string, leadId: string) {
    if (!isUuid(leadId)) return null;
    const rows: any[] = await tenantQuery(leads, lawFirmId, ({ executor, scope }: any) => executor
      .select().from(leads).where(and(scope, eq(leads.id, leadId))).limit(1));
    return rows[0] ? formatLead(rows[0]) : null;
  }

  /**
   * Lead plus its most recent intake submission (any status), for the detail
   * badge (Not sent / Sent / Opened / Completed).
   */
  async getByIdWithIntakeStatus(lawFirmId: string, leadId: string) {
    const lead = await this.getById(lawFirmId, leadId);
    if (!lead) return null;

    const submissions: any[] = await tenantQuery(intakeSubmissions, lawFirmId, ({ executor, scope }: any) => executor
      .select().from(intakeSubmissions)
      .where(and(scope, eq(intakeSubmissions.leadId, leadId)))
      .orderBy(desc(intakeSubmissions.createdAt))
      .limit(1));

    return {
      ...lead,
      latestIntakeSubmission: formatIntakeStatus(submissions[0] || null),
    };
  }

  async findByEmail(lawFirmId: string, email: any) {
    if (!email || typeof email !== 'string') return null;
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    const rows: any[] = await tenantQuery(leads, lawFirmId, ({ executor, scope }: any) => executor
      .select().from(leads)
      .where(and(scope, sql`lower(${leads.email}) = ${normalized}`))
      .orderBy(asc(leads.createdAt))
      .limit(1));
    return rows[0] ? formatLead(rows[0]) : null;
  }

  async create(lawFirmId: string, data: any) {
    const rows = await scopedInsert(leads, lawFirmId, {
      name: data.name,
      email: data.email || null,
      phone: data.phone || null,
      organization: data.organization || null,
      referralSource: data.referralSource || null,
      notes: data.notes || null,
      stageId: isUuid(data.stageId) ? data.stageId : null,
      stageDate: data.stageDate || null,
      disqualifyReason: data.disqualifyReason || null,
      createdBy: data.createdBy || null,
    });
    return formatLead(rows[0]);
  }

  async update(lawFirmId: string, leadId: string, updates: any, executor?: any) {
    if (!isUuid(leadId)) return null;
    const values: Record<string, unknown> = {};
    for (const field of [
      'name', 'email', 'phone', 'organization', 'referralSource', 'notes',
      'stageId', 'stageDate', 'disqualifyReason', 'convertedClientId', 'convertedMatterId', 'convertedAt',
    ]) {
      if (updates[field] !== undefined) values[field] = updates[field];
    }
    if (!Object.keys(values).length) return this.getById(lawFirmId, leadId);
    const rows = executor
      ? await scopedUpdate(leads, lawFirmId, eq(leads.id, leadId), values, executor)
      : await scopedUpdate(leads, lawFirmId, eq(leads.id, leadId), values);
    return rows[0] ? formatLead(rows[0]) : null;
  }

  /**
   * Lock the lead row for the duration of the caller's transaction and return
   * its current `convertedAt`, so a conversion can recheck "not yet converted"
   * AFTER acquiring exclusivity rather than trusting an earlier, unlocked read.
   *
   * Without this, `convertLead`'s check (`if (lead.convertedAt) throw`) and its
   * write (`leadsRepo.update(..., { convertedAt: ... })`) are two separate
   * statements with nothing serializing them: two concurrent conversions of the
   * same lead can both read `convertedAt: null` before either commits, and both
   * proceed to create a client (or matter) for the same lead. Locking this row
   * first gives every concurrent conversion of the SAME lead one shared point of
   * contention - the second call blocks here until the first's transaction
   * commits or rolls back, and its own re-read then sees that transaction's
   * already-committed `convertedAt`. Same pattern as
   * `matters.repository.ts#lockFirmForMatterCountCheck`.
   */
  async lockForConversion(lawFirmId: string, leadId: string, executor: any) {
    const rows: any[] = await tenantQuery(leads, lawFirmId, ({ executor: queryExecutor, scope }: any) => queryExecutor
      .select({ convertedAt: leads.convertedAt })
      .from(leads)
      .where(and(scope, eq(leads.id, leadId)))
      .for('update'), executor);
    return rows[0] || null;
  }

  async delete(lawFirmId: string, leadId: string) {
    if (!isUuid(leadId)) return false;
    const rows = await scopedDelete(leads, lawFirmId, eq(leads.id, leadId));
    return rows.length > 0;
  }
}

export = Object.assign(new LeadsRepository(), { formatLead });

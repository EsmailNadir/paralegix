import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { drizzleRowToEntity } from '../../shared/database/DrizzleRepository';
import { auditEvents, lawFirms, users } from '../../shared/database/drizzle/schema';
import {
  adminQuery,
  systemQuery,
  tenantQuery,
  type DrizzleExecutor,
} from '../../shared/database/queryContext';
import { resolvePage } from '../../shared/database/pagination';
import { toIlikeTerm } from '../../shared/database/searchTerm';
const { isUuid } = require('../../shared/utils/isUuid');

function rowToEntity(row: Record<string, unknown> | undefined) {
  return drizzleRowToEntity(row);
}

/** Append one event to the database-enforced append-only audit log. */
export async function insert(event: any = {}, executor?: DrizzleExecutor) {
  const rows = await systemQuery('audit_log', (executor) => executor
    .insert(auditEvents)
    .values({
      lawFirmId: event.lawFirmId || null,
      actorUid: event.actorUid || null,
      actorEmail: event.actorEmail || null,
      action: event.action,
      resourceType: event.resourceType || null,
      resourceId: event.resourceId || null,
      method: event.method || null,
      path: event.path || null,
      statusCode: event.statusCode == null ? null : event.statusCode,
      ip: event.ip || null,
      userAgent: event.userAgent || null,
      metadata: event.metadata || {},
    })
    .returning({ id: auditEvents.id }), executor);
  return rows[0]?.id || null;
}

/** Paginated tenant audit events, newest first. */
export async function listByFirm(
  lawFirmId: string,
  { limit = 50, offset = 0, action, actorUid }: any = {},
) {
  const filters: SQL[] = [];
  if (action) filters.push(eq(auditEvents.action, action));
  if (actorUid) filters.push(eq(auditEvents.actorUid, actorUid));
  const page = resolvePage({ limit, offset, max: 200 });

  const [rows, totals] = await Promise.all([
    tenantQuery(
      auditEvents,
      lawFirmId,
      ({ executor, scope }) => executor
        .select()
        .from(auditEvents)
        .where(and(scope, ...filters))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(page.limit)
        .offset(page.offset),
    ),
    tenantQuery(
      auditEvents,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({ total: count() })
        .from(auditEvents)
        .where(and(scope, ...filters)),
    ),
  ]);

  return {
    items: rows.map((row) => rowToEntity(row)!),
    totalItems: totals[0]?.total || 0,
  };
}

/** Cross-tenant audit read; callers gate this with platform-admin authorization. */
export async function listAll(
  { limit = 50, offset = 0, action, actorUid, lawFirmId, search }: any = {},
) {
  const filters: SQL[] = [];
  if (action) filters.push(eq(auditEvents.action, action));
  if (actorUid) filters.push(eq(auditEvents.actorUid, actorUid));
  if (lawFirmId && isUuid(lawFirmId)) filters.push(eq(auditEvents.lawFirmId, lawFirmId));

  const term = toIlikeTerm(search);
  if (term) {
    const matches = [
      auditEvents.actorEmail,
      auditEvents.actorUid,
      auditEvents.action,
      auditEvents.ip,
      users.name,
      lawFirms.name,
    ].map((column) => sql`${column} ilike ${term} escape '\\'`);
    matches.push(
      sql`${auditEvents.metadata}->>'provider' ilike ${term} escape '\\'`,
      sql`${auditEvents.metadata}->'location'->>'city' ilike ${term} escape '\\'`,
      sql`${auditEvents.metadata}->'location'->>'region' ilike ${term} escape '\\'`,
      sql`${auditEvents.metadata}->'location'->>'country' ilike ${term} escape '\\'`,
    );
    filters.push(or(...matches)!);
  }

  const predicate = filters.length ? and(...filters) : undefined;
  const page = resolvePage({ limit, offset, max: 200 });
  const baseSelection = {
    ...getTableColumns(auditEvents),
    lawFirmName: lawFirms.name,
    actorName: users.name,
  };

  const [rows, totals] = await Promise.all([
    adminQuery('platform audit log', (executor) => executor
      .select(baseSelection)
      .from(auditEvents)
      .leftJoin(lawFirms, eq(lawFirms.id, auditEvents.lawFirmId))
      .leftJoin(users, eq(users.id, auditEvents.actorUid))
      .where(predicate)
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(page.limit)
      .offset(page.offset)),
    adminQuery('platform audit log count', (executor) => executor
      .select({ total: count() })
      .from(auditEvents)
      .leftJoin(lawFirms, eq(lawFirms.id, auditEvents.lawFirmId))
      .leftJoin(users, eq(users.id, auditEvents.actorUid))
      .where(predicate)),
  ]);

  return {
    items: rows.map((row) => rowToEntity(row)!),
    totalItems: totals[0]?.total || 0,
  };
}

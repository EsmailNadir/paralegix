import { and, eq, inArray, sql } from 'drizzle-orm';
import { matterCategories, matters, lawFirms } from '../../../shared/database/drizzle/schema';
import { tenantQuery, firmQuery, withDrizzleTransaction, type DrizzleExecutor } from '../../../shared/database/queryContext';
import { scopedDelete, scopedInsert, scopedUpdate } from '../../../shared/database/scopedWrite';
const { isUuid } = require('../../../shared/utils/isUuid');

const { rowIso: iso } = require('../../../shared/utils/dateConversion');

function toEntity(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    parentId: r.parentId || null,
    path: r.path || r.name,
    level: r.level || 0,
    order: r.sortOrder || 0,
    createdAt: iso(r.createdAt),
    createdBy: r.createdBy || null,
    updatedAt: iso(r.updatedAt),
  };
}

export async function withCategoryTreeTransaction<TResult>(lawFirmId: string, work: (transaction: DrizzleExecutor) => Promise<TResult>) {
  return withDrizzleTransaction(async (transaction) => {
    // Every tree mutation locks the same root before reading ancestry or sibling order.
    await firmQuery(lawFirms, lawFirmId, ({ executor, scope }) => executor
      .select({ id: lawFirms.id }).from(lawFirms).where(scope).for('update'), transaction);
    return work(transaction);
  });
}

export async function findAll(lawFirmId: string) {
  const rows = await tenantQuery(matterCategories, lawFirmId, ({ executor, scope }) => executor
    .select().from(matterCategories).where(scope));
  return rows.map(toEntity);
}

export async function findById(lawFirmId: string, id: any, transaction?: DrizzleExecutor) {
  if (!isUuid(id)) return null;
  const rows = await tenantQuery(matterCategories, lawFirmId, ({ executor, scope }) => executor
    .select().from(matterCategories).where(and(scope, eq(matterCategories.id, id))).limit(1), transaction);
  return rows[0] ? toEntity(rows[0]) : null;
}

export async function findByNameAndParent(lawFirmId: string, name: any, parentId: any, transaction?: DrizzleExecutor) {
  const rows = await tenantQuery(matterCategories, lawFirmId, ({ executor, scope }) => executor
    .select().from(matterCategories).where(and(
      scope,
      eq(matterCategories.name, name),
      sql`${matterCategories.parentId} is not distinct from ${parentId || null}`,
    )), transaction);
  return rows.map(toEntity);
}

export async function findChildren(lawFirmId: string, parentId: any, transaction?: DrizzleExecutor) {
  // `matter_categories.parent_id` is a uuid column, so a malformed parent id
  // reaches Postgres as a cast error and surfaces as a 500. It can never name a
  // real category, so it has no children: answer it the way a well-formed id for
  // a category that does not exist is answered, and let the caller's own 404
  // fire. Null stays legal, since that is how the ROOTS are asked for.
  if (parentId != null && parentId !== '' && !isUuid(parentId)) return [];
  // `is not distinct from`, not `=`, because a root category's parent is null
  // and `parent_id = null` is never true in SQL. Equality here returned no
  // siblings for a root, so the order assigned at creation was always 0 and
  // roots could not be ordered at all. Callers passing a real uuid are
  // unaffected: the two forms agree on every non-null value.
  const rows = await tenantQuery(matterCategories, lawFirmId, ({ executor, scope }) => executor
    .select().from(matterCategories).where(and(
      scope,
      sql`${matterCategories.parentId} is not distinct from ${parentId || null}`,
    )), transaction);
  return rows.map(toEntity);
}

export async function create(lawFirmId: string, data: any, transaction?: DrizzleExecutor) {
  const rows = await scopedInsert(matterCategories, lawFirmId, {
    name: data.name,
    parentId: data.parentId || null,
    path: data.path || null,
    level: data.level || 0,
    sortOrder: data.order || 0,
    createdBy: data.createdBy || null,
  }, transaction);
  return toEntity(rows[0]);
}

export async function update(lawFirmId: string, id: any, patch: any, transaction?: DrizzleExecutor) {
  if (!isUuid(id)) return null;
  const values: Record<string, unknown> = {};
  for (const [field, column] of Object.entries({ name: 'name', parentId: 'parentId', path: 'path', level: 'level', order: 'sortOrder' })) {
    if (patch[field] !== undefined) values[column] = patch[field];
  }
  if (!Object.keys(values).length) return findById(lawFirmId, id, transaction);
  const rows = await scopedUpdate(matterCategories, lawFirmId, eq(matterCategories.id, id), values, transaction);
  return rows[0] ? toEntity(rows[0]) : null;
}

export async function remove(lawFirmId: string, id: any, transaction?: DrizzleExecutor) {
  if (!isUuid(id)) return;
  await scopedDelete(matterCategories, lawFirmId, eq(matterCategories.id, id), transaction);
}

export async function matterUsesCategory(lawFirmId: string, categoryPath: any, transaction?: DrizzleExecutor) {
  const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
    .select({ id: matters.id }).from(matters)
    .where(and(scope, eq(matters.category, categoryPath))).limit(1), transaction);
  return rows.length > 0;
}

/** Matters reference category paths, so tree changes must move their references in the same commit. */
export async function rewriteMatterCategoryPaths(lawFirmId: string, changes: Map<string, string>, transaction: DrizzleExecutor) {
  if (!changes.size) return;
  const clauses = [...changes].map(([before, after]) => sql`when ${before} then ${after}`);
  await scopedUpdate(matters, lawFirmId, inArray(matters.category, [...changes.keys()]), {
    category: sql`case ${matters.category} ${sql.join(clauses, sql` `)} else ${matters.category} end`,
  }, transaction);
}

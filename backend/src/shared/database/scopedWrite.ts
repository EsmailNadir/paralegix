import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  rootQueryExecutor,
  tenantQuery,
  type DrizzleExecutor,
  type Scopable,
} from './queryContext';

/**
 * Exported so repositories that build their write payloads dynamically (from a
 * field map rather than an object literal) can declare the payload against the
 * table instead of widening it to `any`. A column renamed in the Drizzle schema
 * then fails the build at the field map rather than silently ceasing to persist.
 */
export type InsertValues<T extends Scopable> = Omit<
  T['$inferInsert'],
  'lawFirmId' | 'createdAt' | 'updatedAt'
>;

type MutableInsertValues<T extends Scopable> = Omit<
  T['$inferInsert'],
  'id' | 'lawFirmId' | 'createdAt' | 'updatedAt'
>;
export type UpdateValues<T extends Scopable> = {
  [Key in keyof MutableInsertValues<T>]?: MutableInsertValues<T>[Key] | SQL;
};

/** A column on `T` that an application write is allowed to set. */
export type WritableColumn<T extends Scopable> = keyof UpdateValues<T>;

/**
 * Assigns one column onto a write payload being assembled key by key.
 *
 * Repositories that build their values from a field map cannot write an object
 * literal, and TypeScript cannot narrow a per-key value union across a loop.
 * Routing those assignments through here keeps the payload declared against the
 * table, so the column names stay checked at the field map, while confining the
 * widening to one reviewed line. The alternative that grew up instead was an
 * `as any` on the writer call, which erased the column check for the whole
 * payload and let a renamed column fail silently at runtime.
 */
export function setColumn<T extends Scopable>(
  values: InsertValues<T> | UpdateValues<T>,
  column: WritableColumn<T>,
  value: unknown,
): void {
  (values as Record<string, unknown>)[column as string] = value;
}

const IMMUTABLE_WRITE_KEYS = new Set([
  'lawFirmId',
  'law_firm_id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
]);

function sanitize(values: Record<string, unknown>, omitId = false) {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (value === undefined || IMMUTABLE_WRITE_KEYS.has(key) || (omitId && key === 'id')) continue;
    clean[key] = value;
  }
  return clean;
}

/** Insert values are stamped with the trusted tenant id after sanitization. */
export async function scopedInsert<T extends Scopable>(
  table: T,
  lawFirmId: string,
  values: InsertValues<T>,
  executor: DrizzleExecutor = rootQueryExecutor,
): Promise<T['$inferSelect'][]> {
  if (!lawFirmId) throw new Error('scopedInsert lawFirmId is required');
  const clean = sanitize(values as Record<string, unknown>);
  return executor
    .insert(table as any)
    .values({ ...clean, lawFirmId } as any)
    .returning() as any;
}

/** Insert multiple rows with one trusted tenant stamp and one round trip. */
export async function scopedInsertMany<T extends Scopable>(
  table: T,
  lawFirmId: string,
  values: InsertValues<T>[],
  executor: DrizzleExecutor = rootQueryExecutor,
): Promise<T['$inferSelect'][]> {
  if (!lawFirmId) throw new Error('scopedInsertMany lawFirmId is required');
  if (!values.length) return [];
  const stamped = values.map((row) => ({
    ...sanitize(row as Record<string, unknown>),
    lawFirmId,
  }));
  return executor.insert(table as any).values(stamped as any).returning() as any;
}

function assertTenantConflictTarget(table: Scopable, target: PgColumn[]) {
  if (!target.includes(table.lawFirmId)) {
    throw new Error('Tenant upsert conflict target must include lawFirmId.');
  }
}

/** Tenant-safe insert that ignores a conflict on a tenant-bearing key. */
export async function scopedInsertOnConflictDoNothing<T extends Scopable>(
  table: T,
  lawFirmId: string,
  values: InsertValues<T>,
  target: PgColumn[],
  executor: DrizzleExecutor = rootQueryExecutor,
): Promise<T['$inferSelect'][]> {
  if (!lawFirmId) throw new Error('scopedInsertOnConflictDoNothing lawFirmId is required');
  // DO NOTHING cannot mutate the conflicting row, so a legacy unique key that
  // omits lawFirmId is still safe: the inserted row is tenant-stamped and any
  // cross-tenant collision is only skipped.
  const clean = sanitize(values as Record<string, unknown>);
  return executor.insert(table as any)
    .values({ ...clean, lawFirmId } as any)
    .onConflictDoNothing({ target: target as any })
    .returning() as any;
}

/** Bulk variant used by tenant-stamped buffers and junction-table inserts. */
export async function scopedInsertManyOnConflictDoNothing<T extends Scopable>(
  table: T,
  lawFirmId: string,
  values: InsertValues<T>[],
  target: PgColumn[] = [],
  targetWhere?: SQL,
  executor: DrizzleExecutor = rootQueryExecutor,
): Promise<T['$inferSelect'][]> {
  if (!lawFirmId) throw new Error('scopedInsertManyOnConflictDoNothing lawFirmId is required');
  if (!values.length) return [];
  const stamped = values.map((row) => ({
    ...sanitize(row as Record<string, unknown>),
    lawFirmId,
  }));
  const insert = executor.insert(table as any).values(stamped as any);
  const conflict = target.length
    ? insert.onConflictDoNothing({ target: target as any, where: targetWhere })
    : insert.onConflictDoNothing();
  return conflict.returning() as any;
}

/**
 * Tenant-safe upsert; immutable and tenant columns are stripped from updates.
 *
 * `targetWhere` names the partial unique index the conflict is inferred
 * against, when `target`'s columns are covered by more than one such index
 * (e.g. invitations, whose (law_firm_id, client_id) target matches a
 * different partial unique index per invite_type/status combination). Must
 * mirror the index's WHERE clause exactly for Postgres to use it as the
 * arbiter; omit it for a plain (non-partial) unique constraint/index.
 */
export async function scopedUpsert<T extends Scopable>(
  table: T,
  lawFirmId: string,
  values: InsertValues<T>,
  target: PgColumn[],
  updateValues: UpdateValues<T>,
  executor: DrizzleExecutor = rootQueryExecutor,
  targetWhere?: SQL,
): Promise<T['$inferSelect'][]> {
  if (!lawFirmId) throw new Error('scopedUpsert lawFirmId is required');
  assertTenantConflictTarget(table, target);
  const cleanInsert = sanitize(values as Record<string, unknown>);
  const cleanUpdate = sanitize(updateValues as Record<string, unknown>, true);
  return executor.insert(table as any)
    .values({ ...cleanInsert, lawFirmId } as any)
    .onConflictDoUpdate({ target: target as any, targetWhere, set: cleanUpdate as any })
    .returning() as any;
}

/** Update cannot modify the tenant, identity, generated timestamps, or schema version. */
export async function scopedUpdate<T extends Scopable>(
  table: T,
  lawFirmId: string,
  match: SQL,
  values: UpdateValues<T>,
  executor: DrizzleExecutor = rootQueryExecutor,
): Promise<T['$inferSelect'][]> {
  if (!lawFirmId) throw new Error('scopedUpdate lawFirmId is required');
  const clean = sanitize(values as Record<string, unknown>, true);
  if (!Object.keys(clean).length) {
    return tenantQuery(
      table,
      lawFirmId,
      ({ executor: queryExecutor, scope }) =>
        queryExecutor.select().from(table as any).where(and(scope, match)) as any,
      executor,
    );
  }
  return executor
    .update(table as any)
    .set(clean as any)
    .where(and(eq(table.lawFirmId, lawFirmId), match))
    .returning() as any;
}

/** Delete always combines the caller predicate with the trusted tenant predicate. */
export async function scopedDelete<T extends Scopable>(
  table: T,
  lawFirmId: string,
  match: SQL,
  executor: DrizzleExecutor = rootQueryExecutor,
): Promise<T['$inferSelect'][]> {
  if (!lawFirmId) throw new Error('scopedDelete lawFirmId is required');
  return executor
    .delete(table as any)
    .where(and(eq(table.lawFirmId, lawFirmId), match))
    .returning() as any;
}

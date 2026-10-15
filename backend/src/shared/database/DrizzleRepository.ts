import {
  and,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  ne,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { NotFoundError } from '../errors/AppError';
import { tenantQuery, type DrizzleExecutor, type Scopable } from './queryContext';
import { scopedDelete, scopedInsert, scopedUpdate } from './scopedWrite';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EntityAliases = Record<string, string>;
type RepositoryTable = Scopable & { id: PgColumn } & Record<string, PgColumn>;

const OPERATORS: Record<string, (column: PgColumn, value: unknown) => SQL> = {
  '==': eq,
  '===': eq,
  '!=': ne,
  '>': gt,
  '>=': gte,
  '<': lt,
  '<=': lte,
};

/** Preserve the response shape used by the former raw-SQL repository layer. */
export function drizzleRowToEntity(row: Record<string, unknown> | undefined, aliases: EntityAliases = {}) {
  if (!row) return null;
  const reverseAliases = Object.fromEntries(Object.entries(aliases).map(([entity, schema]) => [schema, entity]));
  const entity: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(row)) {
    if (key === 'search') continue;
    entity[reverseAliases[key] || key] = rawValue instanceof Date ? rawValue.toISOString() : rawValue;
  }
  return entity;
}

/** Translate established API entity names to generated Drizzle schema keys. */
export function entityToDrizzleValues(data: Record<string, unknown>, aliases: EntityAliases = {}) {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value !== undefined) values[aliases[key] || key] = value;
  }
  return values;
}

/**
 * Tenant-scoped CRUD base for ordinary tables. Custom repository methods use
 * tenantQuery directly for joins, aggregates, ordering, and pagination.
 */
export class DrizzleRepository {
  readonly table: RepositoryTable;
  readonly idType: 'uuid' | 'text';
  readonly aliases: EntityAliases;

  constructor(table: RepositoryTable, options: { idType?: 'uuid' | 'text'; aliases?: EntityAliases } = {}) {
    this.table = table;
    this.idType = options.idType || 'uuid';
    this.aliases = options.aliases || {};
  }

  validId(id: unknown) {
    return this.idType === 'uuid' ? typeof id === 'string' && UUID_RE.test(id) : id != null;
  }

  toEntity(row: Record<string, unknown> | undefined) {
    return drizzleRowToEntity(row, this.aliases);
  }

  toValues(data: Record<string, unknown>) {
    return entityToDrizzleValues(data, this.aliases);
  }

  async findById(lawFirmId: string, id: unknown, executor?: DrizzleExecutor) {
    if (!this.validId(id)) return null;
    const rows = await tenantQuery(
      this.table,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor
        .select()
        .from(this.table)
        .where(and(scope, eq(this.table.id, id)))
        .limit(1),
      executor,
    );
    return this.toEntity(rows[0] as Record<string, unknown> | undefined);
  }

  async findByIdOrFail(lawFirmId: string, id: unknown, label?: string, executor?: DrizzleExecutor) {
    const found = await this.findById(lawFirmId, id, executor);
    if (!found) throw new NotFoundError(label || 'record');
    return found;
  }

  async findAll(lawFirmId: string, executor?: DrizzleExecutor) {
    const rows = await tenantQuery(
      this.table,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor.select().from(this.table).where(scope),
      executor,
    );
    return rows.map((row) => this.toEntity(row as Record<string, unknown>));
  }

  async findWhere(lawFirmId: string, field: string, operator: string, value: unknown, executor?: DrizzleExecutor) {
    const schemaKey = this.aliases[field] || field;
    const column = this.table[schemaKey];
    if (!column) throw new Error(`Unknown Drizzle field: ${field}`);
    const predicate = (OPERATORS[operator] || eq)(column, value);
    const rows = await tenantQuery(
      this.table,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor
        .select()
        .from(this.table)
        .where(and(scope, predicate)),
      executor,
    );
    return rows.map((row) => this.toEntity(row as Record<string, unknown>));
  }

  async create(lawFirmId: string, data: Record<string, unknown>, executor?: DrizzleExecutor) {
    const rows = await scopedInsert(this.table, lawFirmId, this.toValues(data) as any, executor);
    return this.toEntity(rows[0] as Record<string, unknown>);
  }

  async update(lawFirmId: string, id: unknown, data: Record<string, unknown>, executor?: DrizzleExecutor) {
    if (!this.validId(id)) return null;
    const rows = await scopedUpdate(
      this.table,
      lawFirmId,
      eq(this.table.id, id),
      this.toValues(data) as any,
      executor,
    );
    return this.toEntity(rows[0] as Record<string, unknown> | undefined);
  }

  async delete(lawFirmId: string, id: unknown, executor?: DrizzleExecutor) {
    if (!this.validId(id)) return;
    await scopedDelete(this.table, lawFirmId, eq(this.table.id, id), executor);
  }

  async batchDelete(lawFirmId: string, ids: unknown[], executor?: DrizzleExecutor) {
    if (!ids?.length) return;
    await scopedDelete(this.table, lawFirmId, inArray(this.table.id, ids), executor);
  }
}

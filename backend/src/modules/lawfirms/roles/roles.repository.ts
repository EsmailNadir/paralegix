import { and, eq } from 'drizzle-orm';
import { DrizzleRepository } from '../../../shared/database/DrizzleRepository';
import { roles } from '../../../shared/database/drizzle/schema';
import { tenantQuery, type DrizzleExecutor } from '../../../shared/database/queryContext';
import { withImpliedViewPermissions } from './permissions';

/**
 * The one place a role's permission array is written, so a stored role never
 * holds a manage code without the reads it implies. A write that leaves
 * `permissions` out passes through untouched.
 */
function withImpliedReads(data: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(data.permissions)) return data;
  return { ...data, permissions: withImpliedViewPermissions(data.permissions) };
}

class RolesRepository extends DrizzleRepository {
  constructor() {
    super(roles as any);
  }

  async create(lawFirmId: string, data: Record<string, unknown>, executor?: DrizzleExecutor) {
    return super.create(lawFirmId, withImpliedReads(data), executor);
  }

  async update(lawFirmId: string, id: unknown, data: Record<string, unknown>, executor?: DrizzleExecutor) {
    return super.update(lawFirmId, id, withImpliedReads(data), executor);
  }

  async findByName(lawFirmId: string, name: string, executor?: DrizzleExecutor) {
    const rows = await tenantQuery(
      roles,
      lawFirmId,
      ({ executor, scope }) => executor.select().from(roles)
        .where(and(scope, eq(roles.name, name))).limit(1),
      executor,
    );
    return this.toEntity(rows[0]);
  }

  async findBuiltIn(lawFirmId: string) {
    const rows = await tenantQuery(
      roles,
      lawFirmId,
      ({ executor, scope }) => executor.select().from(roles)
        .where(and(scope, eq(roles.isBuiltIn, true))),
    );
    return rows.map((row) => this.toEntity(row));
  }
}

export = new RolesRepository();

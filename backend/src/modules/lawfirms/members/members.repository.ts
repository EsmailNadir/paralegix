import { and, eq, isNull } from 'drizzle-orm';
import { lawFirms, members, roles } from '../../../shared/database/drizzle/schema';
import { tenantQuery, type DrizzleExecutor } from '../../../shared/database/queryContext';
import {
  scopedDelete,
  scopedUpdate,
  scopedUpsert,
} from '../../../shared/database/scopedWrite';

const dollarsToCents = (value: any) => value == null || value === '' ? null : Math.round(Number(value) * 100);
const centsToDollars = (value: any) => value == null ? null : Number(value) / 100;

function toMember(row: any) {
  if (!row) return null;
  const member = {
    ...row,
    id: row.userId,
    joinedAt: row.joinedAt instanceof Date ? row.joinedAt.toISOString() : row.joinedAt,
    invitedAt: row.invitedAt instanceof Date ? row.invitedAt.toISOString() : row.invitedAt,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    defaultHourlyRate: centsToDollars(row.defaultHourlyRateCents),
  };
  delete member.defaultHourlyRateCents;
  return member;
}

class MembersRepository {
  /** The user id of the firm's owner, or null. A firm has at most one (migration 0223). */
  async findOwnerUserId(lawFirmId: string, executor?: DrizzleExecutor): Promise<string | null> {
    const rows = await tenantQuery(
      members,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor.select({ userId: members.userId }).from(members)
        .where(and(scope, eq(members.isOwner, true))).limit(1),
      executor,
    );
    return rows[0]?.userId || null;
  }

  async findByUserId(lawFirmId: string, userId: string, executor?: DrizzleExecutor) {
    const rows = await tenantQuery(
      members,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor.select().from(members)
        .where(and(scope, eq(members.userId, userId))).limit(1),
      executor,
    );
    return toMember(rows[0]);
  }

  async findByUserIdWithRole(lawFirmId: string, userId: string, executor?: DrizzleExecutor) {
    const rows = await tenantQuery(
      members,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor.select({
        member: members,
        rolePermissions: roles.permissions,
      }).from(members)
        .innerJoin(lawFirms, eq(lawFirms.id, members.lawFirmId))
        .leftJoin(roles, and(eq(roles.lawFirmId, members.lawFirmId), eq(roles.id, members.roleId)))
        .where(and(scope, eq(members.userId, userId), isNull(lawFirms.pendingDeletionAt))).limit(1),
      executor,
    );
    if (!rows[0]) return null;
    return {
      ...toMember(rows[0].member),
      rolePermissions: Array.isArray(rows[0].rolePermissions) ? rows[0].rolePermissions : null,
    };
  }

  async listMembers(lawFirmId: string, executor?: DrizzleExecutor) {
    const rows = await tenantQuery(
      members,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor.select().from(members).where(scope),
      executor,
    );
    return rows.map(toMember);
  }

  async addMember(lawFirmId: string, userId: string, data: any, executor?: DrizzleExecutor) {
    const values = {
      userId,
      roleId: data.roleId ?? null,
      isOwner: data.isOwner ?? false,
      defaultHourlyRateCents: dollarsToCents(data.defaultHourlyRate),
      joinedAt: data.joinedAt ? new Date(data.joinedAt) : new Date(),
      invitedAt: data.invitedAt ? new Date(data.invitedAt) : null,
      invitedBy: data.invitedBy ?? null,
    };
    const rows = await scopedUpsert(
      members,
      lawFirmId,
      values,
      [members.lawFirmId, members.userId],
      { roleId: values.roleId, isOwner: values.isOwner },
      executor,
    );
    return toMember(rows[0]);
  }

  async updateMember(lawFirmId: string, userId: string, data: any, executor?: DrizzleExecutor) {
    const values: Record<string, unknown> = {};
    if (data.roleId !== undefined) values.roleId = data.roleId;
    if (data.isOwner !== undefined) values.isOwner = data.isOwner;
    if (data.defaultHourlyRate !== undefined) values.defaultHourlyRateCents = dollarsToCents(data.defaultHourlyRate);
    if (!Object.keys(values).length) return this.findByUserId(lawFirmId, userId, executor);
    const rows = await scopedUpdate(members, lawFirmId, eq(members.userId, userId), values, executor);
    return toMember(rows[0]);
  }

  async removeMember(lawFirmId: string, userId: string, executor?: DrizzleExecutor) {
    await scopedDelete(members, lawFirmId, eq(members.userId, userId), executor);
  }
}

export = new MembersRepository();

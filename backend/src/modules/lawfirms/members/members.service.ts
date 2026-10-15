import { eq, inArray } from 'drizzle-orm';
import { users } from '../../../shared/database/drizzle/schema';
import { withTransactionEffects, type TransactionEffects } from '../../../shared/database/transactionEffects';
import { systemQuery } from '../../../shared/database/queryContext';
const usersRepo = require('../../users/users.repository');
const lawfirmsRepo = require('../lawfirms.repository');
const membersRepo = require('./members.repository');
const { loadResolvedMember } = require('../roles/requirePermission');
const rolesRepo = require('../roles/roles.repository');
const rolesService = require('../roles/roles.service');
const { hasPermission } = require('../roles/permissions');
const { AppError, ForbiddenError, NotFoundError, ValidationError } = require('../../../shared/errors/AppError');
const eventBus = require('../../../shared/events/eventBus');
const { MEMBER_REMOVED, MEMBER_ROLE_CHANGED } = require('../../../shared/events/eventTypes');
const { signUserPhotoUrl } = require('../../../shared/utils/userPhoto');

/**
 * Look up { name, email } for a set of user ids in one query. Used to enrich
 * member rows for display without pulling in the full listMembers JOIN.
 */
async function resolveMemberNames(userIds: string[]) {
  const map: Record<string, any> = {};
  if (!userIds.length) return map;
  const rows = await systemQuery('auth_identity', (executor) => executor.select({
    id: users.id,
    name: users.name,
    email: users.email,
  }).from(users).where(inArray(users.id, userIds)));
  rows.forEach((u: any) => { map[u.id] = u; });
  return map;
}

/**
 * List all members with their resolved permissions.
 * Enriches each member with name/email from the users collection
 * in matter the member document is missing those fields.
 */
export async function listMembers({ lawFirmId }: any) {
  const members = await membersRepo.listMembers(lawFirmId);

  // Enrich name/email by JOINing users (the columns are no longer denormalized
  // onto member rows).
  const userIds = members.map((m: any) => m.userId).filter(Boolean);
  const userMap: Record<string, any> = {};
  if (userIds.length) {
    const rows = await systemQuery('auth_identity', (executor) => executor.select({
      id: users.id,
      name: users.name,
      email: users.email,
      photoObjectPath: users.photoObjectPath,
      updatedAt: users.updatedAt,
    }).from(users).where(inArray(users.id, userIds)));
    await Promise.all(rows.map(async (u: any) => {
      userMap[u.id] = { ...u, photoUrl: await signUserPhotoUrl(u.photoObjectPath, u.updatedAt) };
    }));
  }

  // Load every role for the firm ONCE and map by id, then resolve each
  // member's permissions in memory. This replaces the previous N+1 pattern
  // (one `resolvePermissions` -> one `roles.findById` per member).
  const { roles } = await rolesService.listRoles({ lawFirmId });
  const roleMap: Record<string, any> = {};
  roles.forEach((r: any) => { roleMap[r.id] = r; });

  const enriched = members.map((member: any) => {
    const role = member.roleId ? roleMap[member.roleId] : null;
    const resolvedPermissions = rolesService.resolveFromRolePermissions(
      member,
      role?.permissions
    );
    const u = userMap[member.userId];
    return {
      ...member,
      name: (u && u.name) || '',
      email: (u && u.email) || '',
      photoUrl: (u && u.photoUrl) || null,
      resolvedPermissions,
    };
  });

  return { members: enriched, totalItems: enriched.length };
}

/**
 * The calling member's own row, with their permissions resolved.
 *
 * A workspace mount needs exactly one member: the viewer's. Finding them in the
 * roster resolves every member's identity and signs every member's avatar, so
 * the cost of "what may I do here" scaled with the size of the firm. This
 * answers it from the same members-to-roles JOIN `requirePermission` already
 * runs, which is why its permission list can never disagree with the roster's,
 * plus one identity lookup for the caller alone.
 *
 * The gate is membership alone. Putting any permission code in front of this
 * would render a narrow member's whole app as denied, since it is the answer the
 * app builds every gated control from. A non-member is refused with the same
 * ForbiddenError the roster route's permission check raises, so an outsider
 * cannot tell the two routes apart.
 */
export async function getMyMembership({ lawFirmId, userId }: any) {
  const member = await loadResolvedMember(lawFirmId, userId);
  if (!member) throw new ForbiddenError('Not a member of this firm');

  const rows = await systemQuery('auth_identity', (executor) => executor.select({
    id: users.id,
    name: users.name,
    email: users.email,
    photoObjectPath: users.photoObjectPath,
    updatedAt: users.updatedAt,
  }).from(users).where(eq(users.id, userId)).limit(1));
  const identity: any = rows[0];

  // Spread onto a fresh object: `loadResolvedMember` can hand back the
  // permission cache's own copy, and enriching it in place would put display
  // fields into the cache every later request reads.
  return {
    member: {
      ...member,
      name: identity?.name || '',
      email: identity?.email || '',
      photoUrl: await signUserPhotoUrl(identity?.photoObjectPath, identity?.updatedAt),
    },
  };
}

/**
 * Get a single member by userId.
 */
export async function getMember({ lawFirmId, userId }: any) {
  const member = await membersRepo.findByUserId(lawFirmId, userId);
  if (!member) throw new NotFoundError('Member');

  member.resolvedPermissions = await rolesService.resolvePermissions(lawFirmId, member);
  return member;
}

/**
 * Remove a member from the law firm.
 */
export async function removeMember({ lawFirmId, targetUserId, actingMember }: any) {
  return withTransactionEffects(async ({ executor, defer }) => {
    await usersRepo.lockForMembershipChange(targetUserId, executor);
    if (!await lawfirmsRepo.lockForUpdate(lawFirmId, executor)) throw new NotFoundError('Law firm');
    const target = await membersRepo.findByUserId(lawFirmId, targetUserId, executor);
    if (!target) throw new NotFoundError('Member');

    // Cannot remove the owner
    if (target.isOwner) {
      throw new ForbiddenError('Cannot remove the firm owner');
    }

    // Remove the member row (membership is the source of truth; no users.lawFirmIds).
    await membersRepo.removeMember(lawFirmId, targetUserId, executor);

    defer(() => { eventBus.emit(MEMBER_REMOVED, { lawFirmId, userId: targetUserId }); });

    return { message: 'Member removed' };
  });
}

/**
 * Change a member's role.
 */
export async function changeRole({ lawFirmId, targetUserId, roleId, actingMember }: any) {
  return withTransactionEffects(async ({ executor, defer }) => {
    await usersRepo.lockForMembershipChange(targetUserId, executor);
    if (!await lawfirmsRepo.lockForUpdate(lawFirmId, executor)) throw new NotFoundError('Law firm');
    const target = await membersRepo.findByUserId(lawFirmId, targetUserId, executor);
    if (!target) throw new NotFoundError('Member');

    // Cannot change the owner's role
    if (target.isOwner) {
      throw new ForbiddenError('Cannot change the firm owner\'s role');
    }

    // Verify the role exists
    const role = await rolesService.getRole({ lawFirmId, roleId }, executor);
    if (!role) throw new NotFoundError('Role');

    // Only the owner can assign the Owner role
    if (role.name === 'Owner' && !actingMember.isOwner) {
      throw new ForbiddenError('Only the firm owner can assign the Owner role');
    }

    // Prevent privilege escalation: a non-owner may not move a member into a role
    // whose effective permissions exceed their own (e.g. a members.manage holder
    // promoting someone, including themselves, to the near-all-powers Admin role). The
    // owner bypasses. Mirrors the invite-member guard.
    if (!actingMember.isOwner) {
      const actorPerms = new Set(actingMember.resolvedPermissions || []);
      const grantedPerms = rolesService.resolveFromRolePermissions(
        { roleId, isOwner: role.name === 'Owner' },
        role.permissions || []
      );
      const excess = grantedPerms.filter((p: any) => !actorPerms.has(p));
      if (excess.length > 0) {
        throw new ForbiddenError('You cannot assign a role with more permissions than you have');
      }
    }

    await membersRepo.updateMember(lawFirmId, targetUserId, { roleId }, executor);

    defer(() => {
      eventBus.emit(MEMBER_ROLE_CHANGED, {
        lawFirmId,
        userId: targetUserId,
        oldRoleId: target.roleId,
        newRoleId: roleId,
        roleName: role.name,
        actorUserId: actingMember?.userId || null,
      });
    });

    return { message: 'Role updated', roleId, roleName: role.name };
  });
}

/**
 * Transfer firm ownership from the current owner to another member. The
 * previous owner keeps their membership, demoted to the built-in Admin role
 * (full access minus owner-only actions) so they don't lose access outright.
 */
export async function transferOwnership({ lawFirmId, actingUserId, targetUserId }: any, context?: TransactionEffects) {
  return withTransactionEffects(async (transition) => {
    const { executor, defer } = transition;
    await usersRepo.lockForMembershipChange(actingUserId, executor);
    if (!await lawfirmsRepo.lockForUpdate(lawFirmId, executor)) throw new NotFoundError('Law firm');
    if (actingUserId === targetUserId) {
      throw new ValidationError('You are already the firm owner');
    }

    const actingMember = await membersRepo.findByUserId(lawFirmId, actingUserId, executor);
    if (!actingMember?.isOwner) {
      throw new ForbiddenError('Only the current firm owner can transfer ownership');
    }

    const target = await membersRepo.findByUserId(lawFirmId, targetUserId, executor);
    if (!target) throw new NotFoundError('Member');

    // Built-in roles are seeded on firm creation; this normally only re-reads
    // their ids.
    let [ownerRole, adminRole] = await Promise.all([
      rolesRepo.findByName(lawFirmId, 'Owner', executor),
      rolesRepo.findByName(lawFirmId, 'Admin', executor),
    ]);

    // Unless the firm deleted one of them. `deleteRole` protects only Owner, so a
    // firm can delete Admin, and then the demotion below would write role_id =
    // null and drop the outgoing owner to the read-only BASELINE rather than to
    // "full access minus owner-only actions". That is silent: the transfer
    // succeeds, and the previous owner finds out at the next thing they try. They
    // cannot restore themselves either, because assigning a role needs a
    // permission the baseline does not carry, so the firm would depend on the new
    // owner to undo it.
    //
    // Re-seeding is safe to call at any time: seedBuiltInRoles looks each role up
    // by name first and reuses the existing id, so this recreates only what is
    // actually missing.
    if (!ownerRole || !adminRole) {
      await rolesService.seedBuiltInRoles(lawFirmId, executor);
      [ownerRole, adminRole] = await Promise.all([
        rolesRepo.findByName(lawFirmId, 'Owner', executor),
        rolesRepo.findByName(lawFirmId, 'Admin', executor),
      ]);
    }

    await membersRepo.updateMember(lawFirmId, actingUserId, { isOwner: false, roleId: adminRole?.id ?? null }, executor);
    await membersRepo.updateMember(lawFirmId, targetUserId, { isOwner: true, roleId: ownerRole?.id ?? null }, executor);

    // Both members' resolved permissions just changed; drop their cached entries.
    defer(() => {
      eventBus.emit(MEMBER_ROLE_CHANGED, {
        lawFirmId,
        userId: actingUserId,
        roleName: adminRole?.name || 'Admin',
        actorUserId: actingUserId,
      });
    });
    defer(() => {
      eventBus.emit(MEMBER_ROLE_CHANGED, {
        lawFirmId,
        userId: targetUserId,
        roleName: ownerRole?.name || 'Owner',
        actorUserId: actingUserId,
      });
    });

    return { message: 'Ownership transferred', previousOwnerId: actingUserId, newOwnerId: targetUserId };
  }, context);
}

/**
 * Handle a member leaving the firm voluntarily.
 */
export async function leaveFirm({ lawFirmId, userId, confirmDeletion, newAdminUserId }: any, context?: TransactionEffects) {
  return withTransactionEffects(async (transition) => {
    const { executor, defer } = transition;
    await usersRepo.lockForMembershipChange(userId, executor);
    if (!await lawfirmsRepo.lockForUpdate(lawFirmId, executor)) throw new NotFoundError('Law firm');
    const member = await membersRepo.findByUserId(lawFirmId, userId, executor);
    if (!member) throw new NotFoundError('Member');

    const allMembers = await membersRepo.listMembers(lawFirmId, executor);

    // The owner of a one-member firm has nobody to hand it to, so leaving means
    // scheduling the firm for deletion. Requires explicit confirmation: this used
    // to fire the (at the time, immediate/destructive) delete as a silent side
    // effect of "leave", which meant someone could nuke a firm's entire history
    // just by leaving it without realizing they were the last member.
    if (member.isOwner && allMembers.length <= 1) {
      if (!confirmDeletion) {
        throw new AppError(
          'You are the only member of this firm. Leaving will schedule it for deletion. Confirm to proceed.',
          409,
          'CONFIRM_FIRM_DELETION_REQUIRED'
        );
      }
      // Lazy-required to avoid a lawfirms <-> members require cycle.
      const lawfirmsService = require('../lawfirms.service');
      await lawfirmsService.requestLawFirmDeletion(lawFirmId, userId, transition);
      return { action: 'deleted', message: 'Law firm scheduled for deletion' };
    }

    // The owner of a multi-member firm must hand ownership to someone else
    // before leaving, since exactly one member always holds isOwner.
    if (member.isOwner) {
      const others = allMembers.filter((m: any) => m.userId !== userId);

      if (!newAdminUserId) {
        const nameMap = await resolveMemberNames(others.map((m: any) => m.userId));
        const eligibleMembers = others.map((m: any) => ({
          userId: m.userId,
          name: nameMap[m.userId]?.name || nameMap[m.userId]?.email || m.userId,
        }));
        const err = new AppError(
          'You are the firm owner. Choose a member to become the new owner before you leave.',
          409,
          'LAST_ADMIN_TRANSFER_REQUIRED'
        );
        (err as any).details = { eligibleMembers };
        throw err;
      }

      if (!others.some((m: any) => m.userId === newAdminUserId)) {
        throw new NotFoundError('Member');
      }

      await transferOwnership({ lawFirmId, actingUserId: userId, targetUserId: newAdminUserId }, transition);
      await membersRepo.removeMember(lawFirmId, userId, executor);
      defer(() => { eventBus.emit(MEMBER_REMOVED, { lawFirmId, userId }); });
      return { action: 'left', message: 'Ownership transferred. You have left the firm.' };
    }

    // Regular member leave
    await membersRepo.removeMember(lawFirmId, userId, executor);

    defer(() => { eventBus.emit(MEMBER_REMOVED, { lawFirmId, userId }); });

    return { action: 'left', message: 'You have left the firm' };
  }, context);
}

/**
 * Update a member's default hourly rate (firm-level per-user fallback).
 */
export async function updateDefaultHourlyRate({ lawFirmId, targetUserId, defaultHourlyRate }: any) {
  const target = await membersRepo.findByUserId(lawFirmId, targetUserId);
  if (!target) throw new NotFoundError('Member');

  await membersRepo.updateMember(lawFirmId, targetUserId, { defaultHourlyRate });
  return { message: 'Default hourly rate updated', defaultHourlyRate };
}

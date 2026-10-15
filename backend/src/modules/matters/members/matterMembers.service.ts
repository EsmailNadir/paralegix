const mattersRepo = require('../matters.repository');
const membersRepo = require('../../lawfirms/members/members.repository');
const eventBus = require('../../../shared/events/eventBus');
const { MATTER_MEMBERS_UPDATED } = require('../../../shared/events/eventTypes');
const { assertLawFirmMembership, assertLawFirmMemberships, assertMatterMembership, getAccessibleMatterIds } = require('../../../shared/utils/membership');
const { runWithConcurrency } = require('../../../shared/utils/runWithConcurrency');
import { withDrizzleTransaction } from '../../../shared/database/queryContext';
import { countMemberWork, pruneMemberAssignments } from './memberAssignments';

/**
 * The most MATTER_MEMBERS_UPDATED listener chains one bulk staffing request may
 * have running at once. Matches BULK_EVENT_CONCURRENCY in matters.service.ts:
 * the bound exists for the same 12-connection instance pool.
 */
const MEMBER_EVENT_CONCURRENCY = 3;

function notFound(msg: any) {
  return Object.assign(new Error(msg), { statusCode: 404 });
}

function forbidden(msg: any) {
  return Object.assign(new Error(msg), { statusCode: 403 });
}

async function assertMatterExists(lawFirmId: string, matterId: string) {
  const row = await mattersRepo.getCoreById(lawFirmId, matterId);
  if (!row) throw notFound('Matter not found');
}

/**
 * Firm owners and firm-level admins may manage matter membership on any matter
 * (so a legitimate administrator can staff a matter they are not personally on).
 * An admin is recognized by the `members.changeRole` permission, which is held
 * only by owner/admin roles and is not part of the default member baseline.
 */
async function isFirmOwnerOrAdmin(lawFirmId: string, userId: string) {
  const member = await membersRepo.findByUserIdWithRole(lawFirmId, userId);
  if (!member) return false;
  if (member.isOwner) return true;
  return Array.isArray(member.rolePermissions) && member.rolePermissions.includes('members.changeRole');
}

/**
 * Enforce the ethical wall on matter-member management: the acting user must
 * already belong to the matter (its lead/colleague flow) UNLESS they are a firm
 * owner/admin. This stops a member with `matters.manageMembers` from adding
 * themselves (or anyone) to a matter they have no access to and reading its
 * confidential contents.
 */
async function assertCanManageMatterMembers(lawFirmId: string, matterId: string, actingUserId: string) {
  if (await isFirmOwnerOrAdmin(lawFirmId, actingUserId)) return;
  try {
    await assertMatterMembership(lawFirmId, matterId, actingUserId);
  } catch (err: any) {
    if (err && (err.statusCode === 403 || err.code === 'FORBIDDEN')) {
      throw forbidden('You must be a member of this matter to manage its members');
    }
    throw err;
  }
}

/**
 * Add multiple users to a matter. Emits MATTER_MEMBERS_UPDATED so the tasks module
 * can sync visibleToUserIds.
 */
export async function addMembers({ lawFirmId, userId, matterId, targetUserIds, role = 'member' }: any) {
  const uniqueIds = [...new Set((targetUserIds || []).filter(Boolean))];
  if (uniqueIds.length === 0) {
    throw Object.assign(new Error('targetUserIds must contain at least one valid user ID'), { statusCode: 400 });
  }

  await assertLawFirmMemberships(lawFirmId, [userId, ...uniqueIds]);
  await assertMatterExists(lawFirmId, matterId);
  // Ethical wall: only matter members (or firm owners/admins) may add members.
  await assertCanManageMatterMembers(lawFirmId, matterId, userId);

  // Batch the upserts into a single multi-row insert; the returned ids are the
  // genuinely-new members (no per-item event is emitted, so batching is safe).
  const idsToInsert = await mattersRepo.upsertMembers(lawFirmId, matterId, uniqueIds, { role });

  // Adding members as 'lead' via this side door must keep matters.lead_user_id
  // consistent with the role rows (the dedicated updateMatter path already does).
  if (role === 'lead') {
    await mattersRepo.reconcileLeadColumn(lawFirmId, matterId);
  }

  if (idsToInsert.length > 0) {
    const memberUserIds = await mattersRepo.getMemberUserIds(lawFirmId, matterId);
    eventBus.emit(MATTER_MEMBERS_UPDATED, { lawFirmId, matterId, memberUserIds, addedUserIds: idsToInsert, actorUserId: userId });
  }

  return { message: 'Members added to matter' };
}

/**
 * Remove multiple users from a matter.
 */
export async function removeMembers({ lawFirmId, userId, matterId, targetUserIds, reassignTo }: any) {
  const uniqueIds = [...new Set((targetUserIds || []).filter(Boolean))];
  if (uniqueIds.length === 0) {
    throw Object.assign(new Error('targetUserIds must contain at least one valid user ID'), { statusCode: 400 });
  }

  await assertLawFirmMembership(lawFirmId, userId);
  await assertMatterExists(lawFirmId, matterId);
  // Ethical wall: only matter members (or firm owners/admins) may remove members,
  // matching addMembers. Without this, any matters.manageMembers holder could
  // strip members off a matter they have no access to.
  await assertCanManageMatterMembers(lawFirmId, matterId, userId);

  // The member list is read, checked and changed under one lock on the matter
  // row, so two overlapping removals run one after the other. Read before the
  // write, each would see a survivor the other was about to remove: a matter
  // could end with no members, or work could be handed to a member who had just
  // left.
  const idsRemoved: string[] = await withDrizzleTransaction(async (transaction) => {
    if (!(await mattersRepo.lockMatterRow(lawFirmId, matterId, transaction))) throw notFound('Matter not found');

    // A matter must never be left with zero members. Firm owners/admins do still see
    // a zero-member matter (their list and read access bypass the membership predicate),
    // but every regular member loses it: it vanishes from their matters list, and the
    // work attached to it goes with it, since task visibility, billing context
    // authorization, and matter file reads all gate on matter membership. Only an
    // owner could then hand it back. Block a removal that would strip the last member.
    const currentMemberIds = await mattersRepo.getMemberUserIds(lawFirmId, matterId, transaction);
    const remainingMemberIds = currentMemberIds.filter((id: any) => !uniqueIds.includes(id));
    if (currentMemberIds.length > 0 && remainingMemberIds.length === 0) {
      throw Object.assign(
        new Error('A matter must keep at least one member. Add another member before removing the last one.'),
        { statusCode: 400 }
      );
    }

    // Validated before anything is removed: the target takes over work on this
    // matter, so it has to be someone who stays on it.
    if (reassignTo && (uniqueIds.includes(reassignTo) || !remainingMemberIds.includes(reassignTo))) {
      throw Object.assign(
        new Error('reassignTo must be a member who stays on this matter'),
        { statusCode: 400 }
      );
    }

    // The membership rows and the removed users' work move together: a failure
    // between them would leave an ex-member still assigned or a member unassigned.
    const removed: string[] = await mattersRepo.removeMembers(lawFirmId, matterId, uniqueIds, transaction);
    for (const removedUserId of removed) {
      await pruneMemberAssignments({
        lawFirmId, userId: removedUserId, matterId, reassignTo: reassignTo || null, executor: transaction,
      });
    }
    return removed;
  });

  if (idsRemoved.length > 0) {
    // A removed member may have been the primary lead; re-point matters.lead_user_id
    // at a remaining lead (or NULL) so it never dangles at a non-member.
    await mattersRepo.reconcileLeadColumn(lawFirmId, matterId);
    const memberUserIds = await mattersRepo.getMemberUserIds(lawFirmId, matterId);
    // `removedUserIds` is what lets the calendar fan-out take the matter back off
    // an ex-member's external calendar. Without it the listener sees an event
    // that names only the survivors and cannot tell who left, so every hearing,
    // deposition and deadline for the matter stays on their real Google/Outlook
    // calendar indefinitely.
    eventBus.emit(MATTER_MEMBERS_UPDATED, {
      lawFirmId, matterId, memberUserIds, removedUserIds: idsRemoved, actorUserId: userId,
    });
  }

  return { message: 'Members removed from matter' };
}

/**
 * What removing these users would touch on this matter, per user. Same audience
 * as `removeMembers`; writes nothing.
 */
export async function previewRemoveMembers({ lawFirmId, userId, matterId, targetUserIds }: any) {
  const uniqueIds = [...new Set((targetUserIds || []).filter(Boolean))] as string[];
  if (uniqueIds.length === 0) {
    throw Object.assign(new Error('targetUserIds must contain at least one valid user ID'), { statusCode: 400 });
  }

  await assertLawFirmMembership(lawFirmId, userId);
  await assertMatterExists(lawFirmId, matterId);
  await assertCanManageMatterMembers(lawFirmId, matterId, userId);

  return { members: await countMemberWork({ lawFirmId, matterId, userIds: uniqueIds }) };
}

/**
 * Update hourly rate for a member in a matter.
 */
export async function updateHourlyRate({ lawFirmId, userId: actingUserId, matterId, targetUserId, hourlyRate }: any) {
  if (hourlyRate !== null && hourlyRate !== undefined && (typeof hourlyRate !== 'number' || hourlyRate < 0)) {
    throw Object.assign(new Error('hourlyRate must be a non-negative number or null'), { statusCode: 400 });
  }

  await assertMatterMembership(lawFirmId, matterId, actingUserId);

  const updated = await mattersRepo.updateMemberHourlyRate(lawFirmId, matterId, targetUserId, hourlyRate);
  if (!updated) throw notFound('Member not found in matter');

  return { message: 'Hourly rate updated successfully' };
}

/**
 * Matters out of `matterIds` that a bulk member change may touch, plus the
 * per-item reasons the rest were rejected. Shared by `bulkAddMember` and its
 * preview so the count shown before the action matches what the action does.
 */
async function resolveBulkMemberScope({ lawFirmId, actingUserId, targetUserId, matterIds }: any) {
  const uniqueMatterIds = [...new Set((matterIds || []).filter(Boolean))];
  if (uniqueMatterIds.length === 0) {
    throw Object.assign(new Error('matterIds must contain at least one valid matter ID'), { statusCode: 400 });
  }

  await assertLawFirmMemberships(lawFirmId, [actingUserId, targetUserId]);

  const failed = [];

  // Validate matter existence in one query; non-existent ids become per-item failures
  // (preserving the prior `failed: [{ matterId, error }]` shape).
  const existing = await mattersRepo.filterExistingMatterIds(lawFirmId, uniqueMatterIds);
  const existingMatterIds = [];
  for (const matterId of uniqueMatterIds) {
    if (existing.has(matterId)) existingMatterIds.push(matterId);
    else failed.push({ matterId, error: 'Matter not found' });
  }

  // Ethical wall: the acting user may only staff matters they are on, unless they
  // are a firm owner/admin. Matters the actor cannot manage become per-item
  // failures instead of silent self-grants.
  const actorIsOwnerOrAdmin = await isFirmOwnerOrAdmin(lawFirmId, actingUserId);
  const manageableMatterIds = actorIsOwnerOrAdmin
    ? new Set(existingMatterIds)
    : await getAccessibleMatterIds(lawFirmId, existingMatterIds, actingUserId);
  const validMatterIds = [];
  for (const matterId of existingMatterIds) {
    if (manageableMatterIds.has(matterId)) validMatterIds.push(matterId);
    else failed.push({ matterId, error: 'You must be a member of this matter to manage its members' });
  }

  return { validMatterIds, failed };
}

/**
 * Split the selected matters the way `bulkAddMember` would, without writing
 * anything. Lets the assign dialog say how many matters the member would
 * actually join, rather than counting every selected matter.
 */
export async function previewBulkAddMember({ lawFirmId, userId: actingUserId, targetUserId, matterIds }: any) {
  const { validMatterIds, failed } = await resolveBulkMemberScope({
    lawFirmId, actingUserId, targetUserId, matterIds,
  });

  const assigned = await mattersRepo.filterMatterIdsWithMember(lawFirmId, validMatterIds, targetUserId);
  const toAdd = [];
  const alreadyAssigned = [];
  for (const matterId of validMatterIds) {
    if (assigned.has(matterId)) alreadyAssigned.push(matterId);
    else toAdd.push(matterId);
  }

  return { toAdd, alreadyAssigned, failed };
}

/**
 * Bulk add a single user to multiple matters at once.
 */
export async function bulkAddMember({ lawFirmId, userId: actingUserId, targetUserId, matterIds }: any) {
  const { validMatterIds, failed } = await resolveBulkMemberScope({
    lawFirmId, actingUserId, targetUserId, matterIds,
  });

  const added = [];
  const alreadyAssigned = [];

  if (validMatterIds.length) {
    // One multi-row insert across all valid matters; the returned ids were newly
    // inserted, the remainder were already assigned.
    const insertedMatterIds = await mattersRepo.addMemberToMatters(lawFirmId, validMatterIds, targetUserId, { role: 'member' });
    const insertedSet = new Set(insertedMatterIds);

    if (insertedMatterIds.length) {
      // One query fetches member ids for every inserted matter for the event payloads.
      const memberIdsByMatter = await mattersRepo.getMemberUserIdsForMatters(lawFirmId, insertedMatterIds);
      // Delivered at a bounded width rather than emitted in a loop. `eventBus.emit`
      // does not await its listeners, so the loop left one detached chain per
      // matter in flight (calendar sync plus a notification write, each with its
      // own queries) against an instance pool of twelve connections. `emitAsync`
      // settles every listener and `runWithConcurrency` never rejects, so a
      // failing listener still cannot change what this route returns.
      await runWithConcurrency(
        insertedMatterIds.map((matterId: string) => () => eventBus.emitAsync(MATTER_MEMBERS_UPDATED, {
          lawFirmId,
          matterId,
          memberUserIds: memberIdsByMatter[matterId] || [],
          addedUserIds: [targetUserId],
          actorUserId: actingUserId,
        })),
        MEMBER_EVENT_CONCURRENCY,
      );
    }

    for (const matterId of validMatterIds) {
      if (insertedSet.has(matterId)) added.push(matterId);
      else alreadyAssigned.push(matterId);
    }
  }

  return { added, alreadyAssigned, failed };
}

const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../database/infrastructureQuery');
const { isUuid } = require('./isUuid');
const { ForbiddenError, NotFoundError } = require('../errors/AppError');

/**
 * Assert the user is a member of the law firm.
 * Members are the source of truth (owners are member rows with is_owner = true).
 */
export async function assertLawFirmMembership(lawFirmId: string, userId: string) {
  // A malformed id is refused BEFORE it reaches the query. `members.law_firm_id`
  // is uuid, so a value like "not-a-uuid" from the URL raised a cast error that
  // surfaced as a 500 INTERNAL_ERROR on every firm-scoped route, which is most
  // of the API. The caller sent bad input, so the answer is the same one a
  // non-member gets: the firm does not exist as far as they are concerned.
  if (!isUuid(lawFirmId)) {
    throw new ForbiddenError('Law Firm does not exist or user is not a member of this law firm');
  }

  const { rows } = await infrastructureRootSql(
    `select m.* from members m
       join law_firms lf on lf.id = m.law_firm_id
      where m.law_firm_id = $1 and m.user_id = $2 and lf.pending_deletion_at is null
      limit 1`,
    [lawFirmId, userId]
  );
  if (rows[0]) return;
  throw new ForbiddenError('Law Firm does not exist or user is not a member of this law firm');
}

/**
 * Assert several users are all members; throws listing any that aren't.
 */
export async function assertLawFirmMemberships(lawFirmId: string, userIds: string[]) {
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  if (!ids.length) return {};
  const { rows } = await infrastructureRootSql(
    `select m.user_id from members m
       join law_firms lf on lf.id = m.law_firm_id
      where m.law_firm_id = $1 and m.user_id = any($2) and lf.pending_deletion_at is null`,
    [lawFirmId, ids]
  );
  const present = new Set(rows.map((r: any) => r.user_id));
  const nonMembers = ids.filter((id: string) => !present.has(id));
  if (nonMembers.length) {
    // Deliberately NOT resolving a display name here, unlike assertMatterMemberships
    // below. These ids are not members of THIS firm at all, so the only global
    // `users` table lookup available has no tenant scope to filter on: it would
    // resolve the real name/email of any user anywhere in the system, including
    // someone at an unrelated firm or a client on the portal. A caller who merely
    // knows (or guesses) another person's Firebase UID could learn their identity
    // through this error message despite sharing no firm with them. The raw id is
    // less friendly but discloses nothing.
    throw new ForbiddenError(`Add ${nonMembers.join(', ')} to this law firm before continuing`);
  }
}

/**
 * Assert the user is a member of the specific matter (firm membership + matter_members).
 */
export async function assertMatterMembership(lawFirmId: string, matterId: string, userId: string) {
  // `matter_id` is a uuid column, so a malformed id reaches Postgres as a cast
  // error and surfaces as a 500. It can never name a real matter, so answer it
  // the same way a well-formed id for a matter that does not exist is answered.
  if (!isUuid(matterId)) throw new NotFoundError('Matter');

  // Fast path: one query that joins the firm-membership check (`members`) with the
  // matter-membership check (`matter_members`). A returned row proves the user is both
  // a firm member AND a member of this matter: the full success condition.
  const fast = await infrastructureRootSql(
    `select 1
       from matter_members cm
       join members m
         on m.law_firm_id = cm.law_firm_id and m.user_id = cm.user_id
      where cm.law_firm_id = $1 and cm.matter_id = $2 and cm.user_id = $3
      limit 1`,
    [lawFirmId, matterId, userId]
  );
  if (fast.rows[0]) return;

  // Slow path only on failure: a single combined existence query lets us reproduce
  // the SAME three distinct error conditions the serial version threw:
  //   not a firm member        -> ForbiddenError (firm)
  //   firm member, no such matter -> NotFoundError('Matter')
  //   firm member, matter exists  -> ForbiddenError (not a matter member)
  const { rows } = await infrastructureRootSql(
    `select
       exists (select 1 from members where law_firm_id = $1 and user_id = $3) as is_firm_member,
       exists (select 1 from matters   where law_firm_id = $1 and id = $2)      as matter_exists`,
    [lawFirmId, matterId, userId]
  );
  const { is_firm_member: isFirmMember, matter_exists: matterExists } = rows[0];
  if (!isFirmMember) {
    throw new ForbiddenError('Law Firm does not exist or user is not a member of this law firm');
  }
  if (!matterExists) throw new NotFoundError('Matter');
  throw new ForbiddenError('User is not a member of this matter');
}

/**
 * Resolve the "owners and firm admins act on any matter, everyone else must be a
 * member" rule shared by matter read and matter edit access.
 */
async function assertMatterFirmWideAccess(lawFirmId: string, matterId: string, userId: string) {
  if (!isUuid(matterId)) throw new NotFoundError('Matter');
  if (await isFirmOwnerOrAdmin(lawFirmId, userId)) {
    // Still confirm the matter is real and belongs to this firm, so a bad id
    // reads as 404 rather than silently succeeding.
    const { rows } = await infrastructureRootSql(
      `select 1 from matters where law_firm_id = $1 and id = $2 limit 1`,
      [lawFirmId, matterId]
    );
    if (!rows[0]) throw new NotFoundError('Matter');
    return;
  }
  return assertMatterMembership(lawFirmId, matterId, userId);
}

/**
 * Assert the user may READ a specific matter.
 *
 * Owners and firm admins may read any matter in the firm; everyone else must be a
 * member of it. This mirrors the visibility the matters list and lookup already
 * grant through `canViewAllMatters`, closing a gap where an owner could see a
 * matter in the list and then get a 403 opening it.
 *
 * Deliberately separate from `assertMatterMembership` rather than an escape hatch
 * added to it. That helper guards roughly sixty call sites, most of which are
 * writes (matter notes, member management, file uploads, signature requests, task
 * creation), where strict membership is the intended rule and silently widening it
 * would be an unreviewed privilege change across every one of them.
 */
export async function assertMatterReadAccess(lawFirmId: string, matterId: string, userId: string) {
  return assertMatterFirmWideAccess(lawFirmId, matterId, userId);
}

/**
 * Assert the user may EDIT a specific matter's own record: its fields, its
 * practice area, and the clients linked to it.
 *
 * Same audience as `assertMatterReadAccess`, because the two always travel
 * together. An owner or firm admin already lists every matter, opens every
 * matter, and staffs every matter (`canViewAllMatters` and
 * `assertCanManageMatterMembers`). Holding their edits to strict membership let
 * them open the Edit Matter dialog on a matter they are not on, see it load with
 * no clients, and then fail on save with "User is not a member of this matter".
 *
 * Scoped to the matter record itself. The confidential work product hanging off a
 * matter - notes, events, files, tasks, time - stays on `assertMatterMembership`,
 * so the ethical wall still holds for everything an administrator has no business
 * reading.
 */
export async function assertMatterWriteAccess(lawFirmId: string, matterId: string, userId: string) {
  return assertMatterFirmWideAccess(lawFirmId, matterId, userId);
}

/**
 * Assert several users are all members of a matter; throws naming any that aren't.
 *
 * Used where a matter-scoped record hands work to a set of people (task assignees).
 * Assigning someone who is not on the matter both crosses the ethical wall and
 * strands the work for billing, since time can only be recorded for matter members.
 */
/**
 * Which of the given users are members of one matter, resolved in a SINGLE query.
 *
 * The set-returning half of `assertMatterMemberships`, split out so a caller
 * holding many records that all point at the SAME destination matter (a bulk
 * task move) can resolve every user id across every record at once and then
 * decide per record in memory, instead of one round trip per record on a pool
 * the whole instance shares. `assertMatterMemberships` is still what turns a
 * miss into the user-facing message, so the wording lives in one place.
 */
export async function resolveMatterMembers(lawFirmId: string, matterId: string, userIds: string[]) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  if (!ids.length) return new Set<string>();
  const { rows } = await infrastructureRootSql(
    `select cm.user_id
       from matter_members cm
       join members m on m.law_firm_id = cm.law_firm_id and m.user_id = cm.user_id
      where cm.law_firm_id = $1 and cm.matter_id = $2 and cm.user_id = any($3)`,
    [lawFirmId, matterId, ids]
  );
  return new Set<string>(rows.map((r: any) => r.user_id));
}

export async function assertMatterMemberships(lawFirmId: string, matterId: string, userIds: string[]) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  if (!ids.length) return;
  const present = await resolveMatterMembers(lawFirmId, matterId, ids);
  const outsiders = ids.filter((id: string) => !present.has(id));
  if (outsiders.length === 0) return;

  // Resolve a display name ONLY for outsiders who are members of THIS SAME firm
  // (the ordinary case: a colleague who just is not staffed on this particular
  // matter yet). Deliberately scoped through `members` rather than a bare
  // `users` lookup: an outsider id can be anyone in the system, including a
  // member of an unrelated firm or a client on the portal, and resolving their
  // real name/email from the global `users` table would disclose it to a firm
  // they have no relationship with. Anyone not in this firm falls back to their
  // raw id, which names nothing.
  const { rows: nameRows } = await infrastructureRootSql(
    `select m.user_id as id, coalesce(u.name, u.email, m.user_id) as display_name
       from members m
       left join users u on u.id = m.user_id
      where m.law_firm_id = $1 and m.user_id = any($2)`,
    [lawFirmId, outsiders]
  );
  const names = new Map(nameRows.map((r: any) => [r.id, r.display_name]));
  const labels = outsiders.map((id: string) => names.get(id) || id);
  throw new ForbiddenError(
    `Add ${labels.join(', ')} to this matter before assigning them work on it`
  );
}

/**
 * Resolve, in a single query, which of the given matter ids the user is a member of
 * (firm member AND matter member). Returns a Set of accessible matter ids. Lets a
 * caller validate a batch of matter-scoped rows without a per-row round-trip.
 */
export async function getAccessibleMatterIds(lawFirmId: string, matterIds: string[], userId: string) {
  const ids = [...new Set((Array.isArray(matterIds) ? matterIds : [matterIds]).filter(Boolean))];
  if (!ids.length) return new Set();
  const { rows } = await infrastructureRootSql(
    `select cm.matter_id
       from matter_members cm
       join members m on m.law_firm_id = cm.law_firm_id and m.user_id = cm.user_id
      where cm.law_firm_id = $1 and cm.user_id = $3 and cm.matter_id = any($2)`,
    [lawFirmId, ids, userId]
  );
  return new Set(rows.map((r: any) => r.matter_id));
}

// The permission that marks a firm-level admin. See isFirmOwnerOrAdmin.
const FIRM_ADMIN_PERMISSION = 'members.changeRole';

/**
 * True if the user is a firm owner or a firm-level admin. Admins are recognized
 * by the `members.changeRole` permission, which is held only by owner/admin roles
 * and is not part of the default member baseline. This is the single source of
 * truth for "trusted to see the whole firm" — matter list visibility, matter-member
 * management, and firm-wide billing all gate on it, so regular members stay behind
 * the ethical wall while owners/admins see everything.
 */
export async function isFirmOwnerOrAdmin(lawFirmId: string, userId: string) {
  const { rows } = await infrastructureRootSql(
    `select m.is_owner, r.permissions as role_permissions
       from members m
       left join roles r on r.law_firm_id = m.law_firm_id and r.id = m.role_id
      where m.law_firm_id = $1 and m.user_id = $2
      limit 1`,
    [lawFirmId, userId]
  );
  const row = rows[0];
  if (!row) return false;
  if (row.is_owner) return true;
  return Array.isArray(row.role_permissions) && row.role_permissions.includes(FIRM_ADMIN_PERMISSION);
}

/**
 * `isFirmOwnerOrAdmin` answered from a member `requirePermission` already
 * resolved (`req.member`), without a query. It reads `resolvedPermissions`,
 * which is the role's codes unioned with DEFAULT_PERMISSIONS; the baseline does
 * not hold `members.changeRole`, so the answer is the same as the role-only read
 * above. A missing member, or one whose permissions were never resolved, is not
 * an admin.
 */
export function isResolvedMemberOwnerOrAdmin(member: any): boolean {
  if (!member) return false;
  if (member.isOwner === true) return true;
  return Array.isArray(member.resolvedPermissions)
    && member.resolvedPermissions.includes(FIRM_ADMIN_PERMISSION);
}

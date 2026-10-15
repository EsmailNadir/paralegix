const rolesRepo = require('./roles.repository');
const { BUILT_IN_ROLES, ALL_PERMISSIONS, DEFAULT_PERMISSIONS } = require('./permissions');
const { ConflictError, ForbiddenError, NotFoundError } = require('../../../shared/errors/AppError');
const eventBus = require('../../../shared/events/eventBus');
const { ROLE_PERMISSIONS_CHANGED } = require('../../../shared/events/eventTypes');
import type { DrizzleExecutor } from '../../../shared/database/queryContext';

/**
 * Master switch for per-role permission enforcement.
 *
 * When OFF (the default), every firm member resolves to the full permission
 * set, so no feature is blocked. The app behaves as "everyone can do
 * everything" while still requiring firm membership (non-members resolve to []
 * and are rejected). Set `RBAC_ENFORCED=true` in the backend environment to
 * turn on real per-role enforcement: members then receive their role's
 * permissions unioned with DEFAULT_PERMISSIONS (the baseline every role gets).
 */
const RBAC_ENFORCED = process.env.RBAC_ENFORCED === 'true';

/**
 * Union a role's stored permissions with the always-on baseline
 * (DEFAULT_PERMISSIONS), de-duplicated.
 */
function withBaseline(rolePermissions: any) {
  const rolePerms = Array.isArray(rolePermissions) ? rolePermissions : [];
  return Array.from(new Set([...DEFAULT_PERMISSIONS, ...rolePerms]));
}

/**
 * Seed built-in roles for a law firm. Called when a firm is created.
 * Returns a map of { roleName: roleId } for easy reference.
 */
export async function seedBuiltInRoles(lawFirmId: string, executor?: DrizzleExecutor) {
  const roleMap: Record<string, any> = {};

  for (const [key, roleDef] of Object.entries(BUILT_IN_ROLES) as Array<[string, any]>) {
    // Check if this role already exists (idempotent)
    const existing = await rolesRepo.findByName(lawFirmId, roleDef.name, executor);
    if (existing) {
      roleMap[key] = existing.id;
      continue;
    }

    const created = await rolesRepo.create(lawFirmId, {
      name: roleDef.name,
      isBuiltIn: true,
      permissions: roleDef.permissions,
    }, executor);
    roleMap[key] = created.id;
  }

  return roleMap;
}

/**
 * Get all roles for a law firm (built-in + custom).
 */
export async function listRoles({ lawFirmId }: any) {
  const roles = await rolesRepo.findAll(lawFirmId);
  return { roles, totalItems: roles.length };
}

/**
 * Get a single role by ID.
 */
export async function getRole({ lawFirmId, roleId }: any, executor?: DrizzleExecutor) {
  return rolesRepo.findByIdOrFail(lawFirmId, roleId, 'Role', executor);
}

/**
 * Create a custom role.
 */

/**
 * Refuse a permission array that grants more than the ACTOR holds.
 *
 * The same guard `changeRole` and `inviteMember` apply, moved here because role
 * EDITING is the shorter path to the same escalation. Assigning a stronger role
 * was blocked; writing stronger permissions onto the role you already hold was
 * not, so a caller with `firm.manageRoles` could grant themselves everything in
 * one request and the two guarded paths became irrelevant.
 *
 * The owner bypasses, because they already resolve to ALL_PERMISSIONS and
 * nothing can be in excess of that. Narrowing a role is never an escalation, so
 * only the codes being ADDED are compared.
 */
function assertNoPermissionEscalation(actingMember: any, permissions: any) {
  if (!actingMember || actingMember.isOwner) return;
  if (!Array.isArray(permissions)) return;

  const actorPerms = new Set(actingMember.resolvedPermissions || []);
  const excess = permissions.filter((p: any) => !actorPerms.has(p));
  if (excess.length > 0) {
    throw new ForbiddenError('You cannot grant a role more permissions than you have');
  }
}

export async function createRole({ lawFirmId, name, permissions, actingMember }: any) {
  assertNoPermissionEscalation(actingMember, permissions);

  const existing = await rolesRepo.findByName(lawFirmId, name);
  if (existing) throw new ConflictError(`Role "${name}" already exists`);

  const role = await rolesRepo.create(lawFirmId, {
    name,
    isBuiltIn: false,
    permissions: permissions || [],
  });

  return { message: 'Role created successfully', roleId: role.id, role };
}

/**
 * Update a role's name or permissions.
 */
export async function updateRole({ lawFirmId, roleId, name, permissions, actingMember }: any) {
  assertNoPermissionEscalation(actingMember, permissions);

  const role = await rolesRepo.findByIdOrFail(lawFirmId, roleId, 'Role');

  // Cannot rename built-in roles
  if (role.isBuiltIn && name && name !== role.name) {
    throw new ForbiddenError('Cannot rename built-in roles');
  }

  const updateData: Record<string, any> = {};
  if (name !== undefined) updateData.name = name;
  if (permissions !== undefined) updateData.permissions = permissions;

  const updated = await rolesRepo.update(lawFirmId, roleId, updateData);

  // Editing a role's permission array changes the effective permission set of
  // every member holding this role. Emit so the permission cache for the firm
  // is invalidated (the cache key is per-member, not per-role, so listeners
  // drop the whole firm's entries).
  if (permissions !== undefined) {
    eventBus.emit(ROLE_PERMISSIONS_CHANGED, { lawFirmId, roleId });
  }

  return { message: 'Role updated successfully', role: updated };
}

/**
 * Delete a role. Any role may be deleted except Owner, which is the firm's
 * structural anchor (every firm must always have an Owner role). Members
 * assigned to the deleted role have their `role_id` set to null by the FK
 * (`members ... on delete set null`) and fall back to the baseline permission
 * set; no member record is removed.
 */
export async function deleteRole({ lawFirmId, roleId }: any) {
  const role = await rolesRepo.findByIdOrFail(lawFirmId, roleId, 'Role');

  if (role.name === 'Owner') {
    throw new ForbiddenError('The Owner role cannot be deleted');
  }

  await rolesRepo.delete(lawFirmId, roleId);

  // Deleting a role changes the effective permission set of every member who
  // held it. The permission cache is keyed per-member (not per-role), so emit
  // ROLE_PERMISSIONS_CHANGED to drop the whole firm's cached entries. Otherwise
  // members of the deleted role keep their cached permissions for up to the TTL.
  eventBus.emit(ROLE_PERMISSIONS_CHANGED, { lawFirmId, roleId });

  return { message: 'Role deleted successfully', roleId };
}

/**
 * Resolve the effective permission set for a member.
 *
 * Owners implicitly hold every permission. When enforcement is disabled (the
 * default (see RBAC_ENFORCED), every member also resolves to the full set.
 * With enforcement on, a member gets their assigned role's permissions
 * (`members.role_id` -> `roles.permissions`) unioned with DEFAULT_PERMISSIONS.
 * A member with no role still gets the baseline; a non-member resolves to []
 * (fail-closed).
 */
export async function resolvePermissions(lawFirmId: string, member: any) {
  if (!member) return [];
  if (member.isOwner) return ALL_PERMISSIONS;
  // Enforcement disabled: every firm member gets everything.
  if (!RBAC_ENFORCED) return ALL_PERMISSIONS;
  if (!member.roleId) return [...DEFAULT_PERMISSIONS];
  // NOTE: do NOT swallow DB errors here. The previous `.catch(() => null)`
  // turned a transient DB failure into an empty permission set, which
  // masquerades as a silent 403 ("access denied") even for users who DO have
  // access. We now let the error propagate so it surfaces as a 500 (transient
  // failure) instead of a wrongful deny.
  //
  // A role that is genuinely GONE is a different case from a DB error, and it
  // resolves to DEFAULT_PERMISSIONS, not to []. `resolveFromRolePermissions`
  // below is reached with `role?.permissions` undefined, and `withBaseline`
  // unions the baseline into it. That is deliberate and matches the rest of the
  // product: the baseline can never be removed from a role (see the comment on
  // DEFAULT_PERMISSIONS), and a member whose role was deleted degrades to
  // read-only pages rather than to a denial screen. A member resolves to []
  // only when they are not a member at all, which is the check at the top.
  let role;
  try {
    role = await rolesRepo.findById(lawFirmId, member.roleId);
  } catch (err: any) {
    console.error('roles.service.resolvePermissions DB error', {
      lawFirmId,
      roleId: member.roleId,
      message: err?.message,
    });
    throw err; // -> 500, never a silent deny and never a grant
  }
  return resolveFromRolePermissions(member, role?.permissions);
}

/**
 * Pure resolver: given a member and the raw permissions array of its assigned
 * role (already fetched, e.g. via the members⋈roles JOIN or a preloaded role
 * map), compute the effective permission set. Identical semantics to
 * resolvePermissions, but performs NO query. Used by the single-JOIN
 * permission path and the listMembers batch path to avoid N+1 lookups.
 *
 *   - no member               -> []
 *   - owner                   -> ALL_PERMISSIONS
 *   - enforcement disabled    -> ALL_PERMISSIONS
 *   - no role / role gone     -> DEFAULT_PERMISSIONS (the baseline)
 *   - role.permissions[]      -> that array unioned with DEFAULT_PERMISSIONS
 */
export function resolveFromRolePermissions(member: any, rolePermissions: any) {
  if (!member) return [];
  if (member.isOwner) return ALL_PERMISSIONS;
  // Enforcement disabled: every firm member gets everything.
  if (!RBAC_ENFORCED) return ALL_PERMISSIONS;
  if (!member.roleId) return [...DEFAULT_PERMISSIONS];
  return withBaseline(rolePermissions);
}

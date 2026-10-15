const membersRepo = require('../members/members.repository');
const rolesService = require('./roles.service');
const permissionCache = require('./permissionCache');
const { ForbiddenError } = require('../../../shared/errors/AppError');
const { isUuid } = require('../../../shared/utils/isUuid');

/**
 * Resolve the requesting member (with `resolvedPermissions`) for a firm.
 *
 * Performance:
 *   - A short-TTL in-memory cache keyed by BOTH (lawFirmId, userId) memoizes
 *     the resolved member so repeated requests skip the DB. See
 *     `permissionCache.js` for why this is safe (it caches a derived permission
 *     set, never an auth token / identity) and how it is invalidated.
 *   - On a miss we do a SINGLE members⋈roles JOIN (one round trip) instead of
 *     the previous two sequential queries (member lookup, then role lookup).
 *
 * The resolved permission set is byte-identical to the legacy path:
 *   - not a member            -> null (caller returns 403)
 *   - owner                   -> ALL_PERMISSIONS (and owner short-circuits)
 *   - member with no/dead role-> DEFAULT_PERMISSIONS (the always-on baseline)
 *   - member with a role      -> that role's `permissions` UNIONED with the
 *                               baseline
 *
 * The two role rows above used to be described here as `[]` (fail closed), and
 * that was never what the code did. `[]` belongs to a NON-member alone. A member
 * whose role was deleted keeps the baseline, because the baseline can never be
 * removed from a role (see DEFAULT_PERMISSIONS) and because this product
 * degrades a narrow role to read-only pages rather than to a denial screen.
 * `tests/permissions/permissionResolution.test.ts` pins each branch.
 *
 * A genuine DB error PROPAGATES (surfaces as 500). It is never converted into
 * an empty permission set (silent 403) and never into granted permissions.
 */
export async function loadResolvedMember(lawFirmId: string, userId: string) {
  // `law_firms.id` is a uuid, so a malformed one can never name a firm anybody
  // is a member of. Without this, the string reaches the members JOIN roles
  // query as a Postgres cast error and the request answers 500 rather than
  // refusing. `requirePermission` below carries the same guard, but it is not
  // always the first gate to run: `requireFeature` calls this function before
  // it, so every plan-gated router crashed on a malformed id. Answering the way
  // a non-member is answered is the same conclusion, reached without the query.
  if (!isUuid(lawFirmId)) return null;

  const cached = permissionCache.get(lawFirmId, userId);
  if (cached) return cached;

  const member = await membersRepo.findByUserIdWithRole(lawFirmId, userId);
  if (!member) return null;

  // rolePermissions came from the JOIN; resolve without a second query.
  member.resolvedPermissions = rolesService.resolveFromRolePermissions(
    member,
    member.rolePermissions
  );
  delete member.rolePermissions; // internal JOIN field, not part of the member shape

  permissionCache.set(lawFirmId, userId, member);
  return member;
}

/**
 * Middleware that checks if the current user has a specific permission
 * within the law firm identified by req.params.lawFirmId.
 *
 * Attaches `req.member` (with `resolvedPermissions`) for downstream use.
 *
 * `permission` may be an ARRAY of alternatives, in which case holding any one of
 * them grants access. That is for routes whose permission code was renamed:
 * custom roles in the database still carry the old code, so both are accepted
 * rather than silently locking those roles out.
 *
 * Usage:
 *   router.put('/:lawFirmId/settings',
 *     verifyToken,
 *     requirePermission('settings.manageFirm'),
 *     handler
 *   );
 */
export function requirePermission(permission: any) {
  const accepted = Array.isArray(permission) ? permission : [permission];
  return async (req: any, res: any, next: any) => {
    // Every firm-scoped route mounts the firm id as `:lawFirmId` (audited: no
    // route file uses `:id` for the firm, and routers use mergeParams so the
    // parent `:lawFirmId` is always visible). The old `|| req.params.id`
    // fallback was a footgun: a route with a different `:id` param could have
    // silently authorized against the wrong firm, so it is intentionally gone.
    const lawFirmId = req.params.lawFirmId;
    if (!lawFirmId) {
      return next(new ForbiddenError('Law firm ID is required'));
    }
    // Refused before it reaches a query. `members.law_firm_id` is uuid, so a
    // malformed value from the URL raised a cast error that surfaced as a 500
    // INTERNAL_ERROR rather than a refusal. Same answer a non-member gets: the
    // caller has no standing in a firm that cannot exist.
    if (!isUuid(lawFirmId)) {
      return next(new ForbiddenError('Not a member of this firm'));
    }

    const userId = req.user?.uid;
    if (!userId) {
      return next(new ForbiddenError('Authentication required'));
    }

    const member = await loadResolvedMember(lawFirmId, userId);
    if (!member) {
      return next(new ForbiddenError('Not a member of this firm'));
    }

    // Owner always passes
    if (member.isOwner) {
      req.member = member;
      return next();
    }

    // Check the specific permission (any one of the accepted alternatives)
    if (!accepted.some((code) => member.resolvedPermissions.includes(code))) {
      const err = new ForbiddenError('You do not have permission to do this. Ask a firm admin to update your role.');
      (err as any).details = { requiredPermission: accepted };
      return next(err);
    }

    req.member = member;
    next();
  };
}

/**
 * Assert a permission for a firm resolved OUTSIDE the URL params (e.g. from the
 * request body). Most routes mount the firm as `:lawFirmId` and use
 * `requirePermission`; a few legacy route families (calendar sync) carry the
 * firm id in the body instead. Same resolution/owner-bypass semantics as
 * `requirePermission`; throws ForbiddenError on non-member or missing permission.
 * Returns the resolved member so callers can attach it to `req`.
 */
export async function assertFirmPermission(lawFirmId: string, userId: string, permission: any) {
  if (!userId) throw new ForbiddenError('Authentication required');
  if (!lawFirmId) throw new ForbiddenError('Law firm ID is required');

  const member = await loadResolvedMember(lawFirmId, userId);
  if (!member) throw new ForbiddenError('Not a member of this firm');
  if (member.isOwner) return member;
  if (!member.resolvedPermissions.includes(permission)) {
    const err = new ForbiddenError('You do not have permission to do this. Ask a firm admin to update your role.');
    (err as any).details = { requiredPermission: [permission] };
    throw err;
  }
  return member;
}

/**
 * Middleware variant of `assertFirmPermission` for routes whose firm id is not a
 * URL param. `getFirmId(req)` resolves the firm id (from body/query/items). When
 * it resolves to nothing the check is a safe no-op — the downstream membership
 * assertion / validation still runs — mirroring the calendar plan gate, which
 * never grants access, only denies a known firm.
 */
export function requirePermissionFrom(getFirmId: any, permission: any) {
  return async (req: any, res: any, next: any) => {
    const lawFirmId = getFirmId(req);
    if (!lawFirmId) return next();
    req.member = await assertFirmPermission(lawFirmId, req.user?.uid, permission);
    next();
  };
}

/**
 * Middleware that resolves the member and permissions without requiring
 * a specific permission. Useful for endpoints where any member can access
 * but you want req.member available.
 */
export function resolveMember() {
  return async (req: any, res: any, next: any) => {
    // Standardized on `:lawFirmId` (see requirePermission audit note above).
    const lawFirmId = req.params.lawFirmId;
    const userId = req.user?.uid;

    if (!lawFirmId || !userId) return next();

    const member = await loadResolvedMember(lawFirmId, userId);
    if (member) {
      req.member = member;
    }

    next();
  };
}

/**
 * Named callers.
 *
 * A spec asks for `ownerOf(firm)` rather than assembling a uid, a role row, a
 * membership row and a token by hand, so the interesting part of the spec stays
 * readable. Every agent carries its caller's token and the `x-timezone` header
 * `requireTimezone` demands.
 */
import { testPool } from './db';
import { tokenFor } from './firebase.mock';
import { createFirmMember, createPortalUser } from './factories';
import { as, type CallerAgent } from './app';

export interface Actor {
  uid: string;
  api: CallerAgent;
}

/**
 * A firm owner: every permission, no role row needed.
 *
 * `uid` lets a spec put the SAME real person in a second firm (see
 * `memberWith` below) to build the A04 fixture: one identity, a different
 * role in each firm. `createFirmMember` tolerates the uid already existing in
 * `users` (see its comment), so calling this twice with the same uid for two
 * different firms is exactly how that person is built.
 */
export async function ownerOf(lawFirmId: string, overrides: { uid?: string } = {}): Promise<Actor> {
  // A firm has AT MOST ONE owner, enforced by `members_one_owner_per_firm_idx`
  // since migration 0223. Calling this twice for one firm used to mint a second
  // owner, which the product has no path to produce; it now returns the owner
  // the firm already has, which is what a caller asking for "the owner" means.
  if (!overrides.uid) {
    const { rows } = await testPool.query(
      'select user_id from members where law_firm_id = $1 and is_owner limit 1',
      [lawFirmId],
    );
    if (rows[0]) {
      const existing = rows[0].user_id as string;
      return { uid: existing, api: as(tokenFor({ uid: existing })) };
    }
  }
  const { uid } = await createFirmMember(lawFirmId, { isOwner: true, uid: overrides.uid });
  return { uid, api: as(tokenFor({ uid })) };
}

/**
 * A member holding exactly the permission codes given, and nothing else. This
 * is the only way to test a partial or read-only role; the live suite has one
 * fully permissioned account and cannot express it.
 *
 * `uid` lets the same real person hold a narrow role in one firm while
 * `ownerOf`/`memberWith` gives them a different standing in another (A04).
 */
export async function memberWith(
  lawFirmId: string,
  permissions: string[],
  overrides: { uid?: string } = {},
): Promise<Actor> {
  const { uid } = await createFirmMember(lawFirmId, { isOwner: false, permissions, uid: overrides.uid });
  return { uid, api: as(tokenFor({ uid })) };
}

/**
 * A portal user, for client-facing and organization-roster routes. Returned
 * before any client record is attached, so a spec decides whether this person is
 * a standalone client, an organization's roster member, or neither.
 */
export async function portalUser(): Promise<Actor> {
  const { uid } = await createPortalUser();
  return { uid, api: as(tokenFor({ uid })) };
}

/** A signed-in caller with no membership anywhere. Useful for isolation checks. */
export function stranger(): Actor {
  const uid = `stranger-${Math.random().toString(36).slice(2, 10)}`;
  return { uid, api: as(tokenFor({ uid })) };
}

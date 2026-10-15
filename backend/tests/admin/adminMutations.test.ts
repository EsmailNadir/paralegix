/**
 * The platform-admin console's WRITE surface.
 *
 * `tests/admin/adminAuthorizationMatrix.test.ts` owns the gate: every admin
 * endpoint refused to every non-admin caller. `tests/users/admin.test.ts` covers
 * what the console reads. Before this file `admin.service.ts` sat at 21%. Everything that CHANGES another firm was untested: editing a firm's
 * profile and storage quota, rewriting a role's permissions, moving or removing
 * a member, deleting an invite, changing a plan, and granting or removing the
 * platform-admin flag itself.
 *
 * These are the most dangerous routes in the product for two reasons.
 *
 *   THEY CROSS FIRM BOUNDARIES ON PURPOSE. Every other module is tested by
 *   proving one firm cannot touch another. Here the reach is the feature, so the
 *   only thing standing between a firm owner and the whole platform is
 *   `requireIsAdmin` (`users.is_admin`, a column on the user row, not a firm
 *   permission). Being a firm owner is the broadest role the product otherwise
 *   grants and it must buy nothing at all here, not even on the owner's OWN
 *   firm.
 *
 *   THEY TAKE A FIRM ID AND AN OBJECT ID SEPARATELY. `PATCH
 *   /lawfirms/:lawFirmId/roles/:roleId` is handed two ids that the caller
 *   controls independently. If the object lookup is not scoped to the firm in
 *   the path, firm A's console edits firm B's role, and the console shows
 *   nothing unusual either side. Several cases below pair one firm's path with
 *   another firm's object id for exactly that reason, and each asserts the other
 *   firm's row is untouched afterwards rather than only reading the status.
 *
 * The platform admin here belongs to NO firm. That is deliberate: an admin who
 * also happened to own the firm under test would let a membership-based
 * authorization pass for the wrong reason.
 *
 * Stripe is configured in this environment, so nothing here touches a route that
 * calls it. `subscription/comp` is the exception and only reaches Stripe when the
 * firm already has a subscription id, which these fixtures never do.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  seedRole,
  as,
  tokenFor,
  type CallerAgent,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { firmRow, platformAdmin, seedInvite } from '../support/rows';

/** A uuid that is well formed but names nothing. */
const ABSENT_ID = '00000000-0000-4000-8000-000000000000';

/** Storage quota of the `basic` tier, from `shared/plans/planDefinitions.ts`. */
const BASIC_QUOTA_BYTES = 3221225472;
/** Storage quota of the `enterprise` tier, which `createFirm` assigns. */
const ENTERPRISE_QUOTA_BYTES = 53687091200;

let firmA: Firm;
let ownerA: Actor;
let firmB: Firm;
let ownerB: Actor;
/** A platform admin who is a member of no firm at all. */
let admin: CallerAgent;
let adminUid: string;

/**
 * Write a firm's stored-usage figures, into the typed columns only.
 *
 * This used to write a `settings->'storage'` jsonb mirror as well, because the
 * quota gate, `updateLawFirm`'s "quota below usage" guard and the plan-usage
 * sweep once read the figure from different places. They no longer do: all
 * three now go through `getLawFirmStorageSettings`, which selects typed columns
 * and nothing else, and migration 0192 deleted the key outright. Seeding it
 * here would make these specs pass against state the product cannot produce.
 */
async function setStorage(
  lawFirmId: string,
  { usedBytes, quotaBytes }: { usedBytes: number; quotaBytes?: number },
): Promise<void> {
  await testPool.query(
    `update law_firms
        set storage_used_bytes = $2::bigint,
            storage_quota_bytes = coalesce($3::bigint, storage_quota_bytes)
      where id = $1`,
    [lawFirmId, usedBytes, quotaBytes ?? null],
  );
}

const roleRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select name, permissions, law_firm_id from roles where id = $1', [id],
  );
  return rows[0];
};

const memberRow = async (lawFirmId: string, userId: string) => {
  const { rows } = await testPool.query(
    'select role_id, is_owner from members where law_firm_id = $1 and user_id = $2',
    [lawFirmId, userId],
  );
  return rows[0];
};

const inviteExists = async (id: string) => {
  const { rows } = await testPool.query('select 1 from invitations where id = $1', [id]);
  return rows.length === 1;
};

const isAdminFlag = async (uid: string) => {
  const { rows } = await testPool.query('select is_admin from users where id = $1', [uid]);
  return rows[0]?.is_admin;
};

const whitelistEmails = async () => {
  const { rows } = await testPool.query(
    'select email::text as email from email_verification_whitelist order by email',
  );
  return rows.map((r) => r.email);
};

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm Alpha' });
  ownerA = await ownerOf(firmA.id);

  firmB = await createFirm({ name: 'Firm Beta' });
  ownerB = await ownerOf(firmB.id);

  const seeded = await platformAdmin();
  adminUid = seeded.uid;
  admin = seeded.api;

  await drainEvents();
});

/**
 * Every refusal of a non-admin caller, on every admin endpoint, is owned by
 * `adminAuthorizationMatrix.test.ts`, which also proves the refused writes
 * changed nothing. What stays here is the admin's side of the same gate.
 */
describe('the gate, from the platform admin side', () => {
  it('ALLOWS the platform admin the same edit', async () => {
    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}`)
      .send({ lawFirm: { name: 'Renamed By Admin' } });

    // The positive half. Without it every refusal in the matrix is satisfied by
    // a route that is simply broken for everyone.
    expect(res.status).toBe(200);
    expect((await firmRow(firmA.id)).name).toBe('Renamed By Admin');
  });

  it('stops allowing them the instant the flag is cleared', async () => {
    await testPool.query('update users set is_admin = false where id = $1', [adminUid]);

    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}`)
      .send({ lawFirm: { name: 'Renamed After Revocation' } });

    // Revocation has to bite on the next request. The middleware reads the user
    // row per call, and a cached decision here would leave a former admin able
    // to write to every firm on the platform until the process restarted.
    expect(res.status).toBe(403);
    expect((await firmRow(firmA.id)).name).toBe('Firm Alpha');
  });
});

describe('one firm in detail', () => {
  it('reports the members, roles and clients of a firm the admin does not belong to', async () => {
    await createPersonClient(firmB.id, { name: 'Beta Client' });
    await seedRole(firmB.id, { name: 'Paralegal', permissions: ['matters.view'] });

    const res = await admin.get(`/api/admin/lawfirms/${firmB.id}`);

    expect(res.status).toBe(200);
    expect(res.body.members.map((m: any) => m.userId)).toContain(ownerB.uid);
    expect(res.body.roles.map((r: any) => r.name)).toContain('Paralegal');
    expect(res.body.clients.map((c: any) => c.name)).toContain('Beta Client');
  });

  it('does NOT mix another firm clients into the detail view', async () => {
    await createPersonClient(firmA.id, { name: 'Alpha Client' });
    await createPersonClient(firmB.id, { name: 'Beta Client' });

    const res = await admin.get(`/api/admin/lawfirms/${firmB.id}`);

    // Cross-firm reach is the point of the console, but a request that names one
    // firm must answer for that firm. A detail view that pooled every firm's
    // clients would put one firm's client list on another firm's page.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.clients)).toContain('Beta Client');
    expect(JSON.stringify(res.body.clients)).not.toContain('Alpha Client');
  });

  it('answers 404 for a firm id that names nothing', async () => {
    const res = await admin.get(`/api/admin/lawfirms/${ABSENT_ID}`);

    expect(res.status).toBe(404);
  });

  it('refuses a malformed firm id without a database error', async () => {
    const res = await admin.get('/api/admin/lawfirms/not-a-uuid');

    // KNOWN FAILURE, left red deliberately. The route has no `validate()` and no
    // `isUuid()` guard, so the path segment reaches `law_firms.id` as a uuid
    // parameter and Postgres raises `invalid input syntax for type uuid`, which
    // the error middleware turns into a 500. Every admin route that forwards
    // `:lawFirmId` to `lawfirmsRepo.findById` behaves the same way. It is a
    // malformed request, not a server fault, and the 500 both misreports it and
    // puts a database error string into the logs on every mistyped link.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('editing a firm profile and its storage quota', () => {
  it('writes the profile fields it was given', async () => {
    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}`)
      .send({ lawFirm: { name: 'Alpha Legal LLP', city: 'Boston' } });

    expect(res.status).toBe(200);
    const row = await firmRow(firmA.id);
    expect(row.name).toBe('Alpha Legal LLP');
    expect(row.city).toBe('Boston');
  });

  it('trims surrounding whitespace off a name', async () => {
    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}`)
      .send({ lawFirm: { name: '  Alpha Legal LLP  ' } });

    // An untrimmed name sorts and searches differently from the same name typed
    // without the space, so the firm goes missing from the console's own list.
    expect(res.status).toBe(200);
    expect((await firmRow(firmA.id)).name).toBe('Alpha Legal LLP');
  });

  it('writes a raised quota to the TYPED column the upload gate reads', async () => {
    await setStorage(firmA.id, { usedBytes: 500, quotaBytes: 1000 });

    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}`)
      .send({ storage: { quotaBytes: 9000 } });

    // `storage_quota_bytes` is what enforcement compares against. Writing the
    // jsonb mirror alone would show the new quota all over the console while
    // uploads kept failing at the old one.
    expect(res.status).toBe(200);
    expect(Number((await firmRow(firmA.id)).storage_quota_bytes)).toBe(9000);
  });

  it('refuses a quota BELOW what the firm has already stored', async () => {
    await setStorage(firmA.id, { usedBytes: 5000, quotaBytes: 9000 });

    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}`)
      .send({ storage: { quotaBytes: 100 } });

    // A quota under current usage puts the firm permanently over limit: every
    // upload is refused and nothing they can delete brings them back under in
    // one step. The quota must not move.
    expect(res.status).toBe(400);
    expect(Number((await firmRow(firmA.id)).storage_quota_bytes)).toBe(9000);
  });

  it('refuses a zero quota', async () => {
    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}`)
      .send({ storage: { quotaBytes: 0 } });

    expect(res.status).toBe(400);
  });

  it('answers 404 when the firm does not exist, writing nothing', async () => {
    const res = await admin.patch(`/api/admin/lawfirms/${ABSENT_ID}`)
      .send({ lawFirm: { name: 'Ghost Firm' } });

    expect(res.status).toBe(404);
  });

  it('answers 404 before touching storage when recounting an unknown firm', async () => {
    const res = await admin.post(`/api/admin/lawfirms/${ABSENT_ID}/storage/recount`);

    // The firm check has to come first. Reaching the bucket for a firm that does
    // not exist would scan a prefix belonging to nobody, and in this suite the
    // GCS stub throws by name, so a 500 here means the order changed.
    expect(res.status).toBe(404);
  });
});

describe('rewriting a role', () => {
  it('replaces a custom role permission set', async () => {
    const roleId = await seedRole(firmB.id, { name: 'Paralegal', permissions: ['matters.view'] });

    const res = await admin.patch(`/api/admin/lawfirms/${firmB.id}/roles/${roleId}`)
      .send({ permissions: ['matters.view', 'clients.view'] });

    expect(res.status).toBe(200);
    expect((await roleRow(roleId)).permissions).toEqual(['matters.view', 'clients.view']);
  });

  it('refuses to RENAME a built-in role, leaving the name alone', async () => {
    const roleId = await seedRole(firmB.id, { name: 'Owner', isBuiltIn: true });

    const res = await admin.patch(`/api/admin/lawfirms/${firmB.id}/roles/${roleId}`)
      .send({ name: 'Overlord' });

    // Built-in role names are matched by name elsewhere (the member-role
    // resolver picks the role called "member"), so renaming one silently breaks
    // those lookups.
    expect(res.status).toBe(400);
    expect((await roleRow(roleId)).name).toBe('Owner');
  });

  it('still allows a built-in role permissions to change', async () => {
    const roleId = await seedRole(firmB.id, {
      name: 'Member', isBuiltIn: true, permissions: ['matters.view'],
    });

    const res = await admin.patch(`/api/admin/lawfirms/${firmB.id}/roles/${roleId}`)
      .send({ permissions: ['matters.view', 'clients.view'] });

    // Only the NAME is frozen on a built-in role. A guard that froze the whole
    // row would make the console unable to tune the default roles at all.
    expect(res.status).toBe(200);
    expect((await roleRow(roleId)).permissions).toEqual(['matters.view', 'clients.view']);
  });

  it('does NOT edit a role belonging to another firm through this firm path', async () => {
    const foreignRoleId = await seedRole(firmB.id, {
      name: 'Paralegal', permissions: ['matters.view'],
    });

    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}/roles/${foreignRoleId}`)
      .send({ permissions: ['matters.view', 'matters.delete', 'clients.view'] });

    // Two caller-controlled ids. An unscoped role lookup would take firm A's
    // path and firm B's role and quietly widen firm B's permissions, which
    // appears nowhere in firm A's console.
    expect(res.status).toBe(404);
    expect((await roleRow(foreignRoleId)).permissions).toEqual(['matters.view']);
  });

  it('takes effect for a member holding the role WITHOUT waiting for a cache expiry', async () => {
    // `firm.viewAuditLog` rather than a view permission: DEFAULT_PERMISSIONS
    // grants every member read access to the ordinary pages, so a role with an
    // empty array is still allowed those and the "before" half of this case
    // would never be a refusal. Firm administration is outside that baseline.
    const roleId = await seedRole(firmA.id, { name: 'Paralegal', permissions: [] });
    const narrow = await createFirmMember(firmA.id, { isOwner: false, permissions: [] });
    await testPool.query(
      'update members set role_id = $1 where law_firm_id = $2 and user_id = $3',
      [roleId, firmA.id, narrow.uid],
    );
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    // Resolve their permissions once so the denial is genuinely CACHED. Without
    // this the case would pass even with the invalidation removed, because
    // nothing stale would exist to serve.
    const before = await narrowApi.get(`/api/lawfirms/${firmA.id}/audit-events`);
    expect(before.status).toBe(403);

    const patch = await admin.patch(`/api/admin/lawfirms/${firmA.id}/roles/${roleId}`)
      .send({ permissions: ['firm.viewAuditLog'] });
    expect(patch.status).toBe(200);
    await drainEvents();

    const after = await narrowApi.get(`/api/lawfirms/${firmA.id}/audit-events`);

    // The permission cache is keyed by (firm, user) and holds for its TTL. An
    // admin edit that did not emit ROLE_PERMISSIONS_CHANGED would leave the firm
    // locked out of what they were just granted, with nothing on screen to
    // explain it.
    expect(after.status).toBe(200);
  });
});

describe('moving and removing members', () => {
  it('assigns a member a different role', async () => {
    const roleId = await seedRole(firmB.id, { name: 'Paralegal', permissions: ['matters.view'] });
    const member = await createFirmMember(firmB.id, { isOwner: false, permissions: [] });

    const res = await admin
      .patch(`/api/admin/lawfirms/${firmB.id}/members/${member.uid}/role`)
      .send({ roleId });

    expect(res.status).toBe(200);
    expect((await memberRow(firmB.id, member.uid)).role_id).toBe(roleId);
  });

  it('refuses to change the OWNER role, leaving them owner', async () => {
    const roleId = await seedRole(firmB.id, { name: 'Paralegal', permissions: [] });

    const res = await admin
      .patch(`/api/admin/lawfirms/${firmB.id}/members/${ownerB.uid}/role`)
      .send({ roleId });

    // Demoting the owner is how a firm ends up with nobody able to administer
    // it, and the owner short-circuits the permission resolver, so the demotion
    // would be immediate and total.
    expect(res.status).toBe(400);
    expect((await memberRow(firmB.id, ownerB.uid)).is_owner).toBe(true);
  });

  it('does NOT assign a role belonging to another firm', async () => {
    const foreignRoleId = await seedRole(firmA.id, {
      name: 'Alpha Partner', permissions: ['matters.delete'],
    });
    const member = await createFirmMember(firmB.id, { isOwner: false, permissions: [] });
    const originalRoleId = (await memberRow(firmB.id, member.uid)).role_id;

    const res = await admin
      .patch(`/api/admin/lawfirms/${firmB.id}/members/${member.uid}/role`)
      .send({ roleId: foreignRoleId });

    // A member pointed at another firm's role row resolves permissions that firm
    // B never granted, and firm B's role screen never shows where they came from.
    expect(res.status).toBe(404);
    expect((await memberRow(firmB.id, member.uid)).role_id).toBe(originalRoleId);
  });

  it('removes a non-owner member', async () => {
    const member = await createFirmMember(firmB.id, { isOwner: false, permissions: [] });

    const res = await admin
      .delete(`/api/admin/lawfirms/${firmB.id}/members/${member.uid}`);

    expect(res.status).toBe(200);
    expect(await memberRow(firmB.id, member.uid)).toBeUndefined();
  });

  it('refuses to remove the OWNER, leaving the membership in place', async () => {
    const res = await admin
      .delete(`/api/admin/lawfirms/${firmB.id}/members/${ownerB.uid}`);

    // Removing the last owner orphans the firm: no one left who can invite,
    // bill, or restore access.
    expect(res.status).toBe(400);
    expect(await memberRow(firmB.id, ownerB.uid)).toBeDefined();
  });

  it('does NOT remove a member of another firm through this firm path', async () => {
    const member = await createFirmMember(firmB.id, { isOwner: false, permissions: [] });

    const res = await admin
      .delete(`/api/admin/lawfirms/${firmA.id}/members/${member.uid}`);

    // The member id is a user id, unique platform-wide, so an unscoped delete
    // would evict someone from a firm nobody named.
    expect(res.status).toBe(404);
    expect(await memberRow(firmB.id, member.uid)).toBeDefined();
  });

  it('answers 404 for a member id that names nobody', async () => {
    const res = await admin
      .delete(`/api/admin/lawfirms/${firmB.id}/members/nobody-at-all`);

    expect(res.status).toBe(404);
  });
});

describe('deleting pending invitations', () => {
  it('deletes a pending member invite', async () => {
    const inviteId = await seedInvite({
      lawFirmId: firmB.id, inviteType: 'member', email: 'recruit@example.test', invitedNow: true,
    });

    const res = await admin
      .delete(`/api/admin/lawfirms/${firmB.id}/pending-invites/${inviteId}`);

    expect(res.status).toBe(200);
    expect(await inviteExists(inviteId)).toBe(false);
  });

  it('deletes a pending client invite', async () => {
    const inviteId = await seedInvite({
      lawFirmId: firmB.id, inviteType: 'client', email: 'portal@example.test', invitedNow: true,
    });

    const res = await admin
      .delete(`/api/admin/lawfirms/${firmB.id}/pending-client-invites/${inviteId}`);

    expect(res.status).toBe(200);
    expect(await inviteExists(inviteId)).toBe(false);
  });

  it('does NOT delete a MEMBER invite through the client-invite endpoint', async () => {
    const inviteId = await seedInvite({
      lawFirmId: firmB.id, inviteType: 'member', email: 'recruit@example.test', invitedNow: true,
    });

    const res = await admin
      .delete(`/api/admin/lawfirms/${firmB.id}/pending-client-invites/${inviteId}`);

    // Both types share one table. Without the type filter the client endpoint
    // would revoke staff invitations, and the firm would see invites disappear
    // from a screen that never listed them.
    expect(res.status).toBe(404);
    expect(await inviteExists(inviteId)).toBe(true);
  });

  it('does NOT delete another firm invite through this firm path', async () => {
    const inviteId = await seedInvite({
      lawFirmId: firmB.id, inviteType: 'member', email: 'recruit@example.test', invitedNow: true,
    });

    const res = await admin
      .delete(`/api/admin/lawfirms/${firmA.id}/pending-invites/${inviteId}`);

    expect(res.status).toBe(404);
    expect(await inviteExists(inviteId)).toBe(true);
  });
});

describe('granting and removing the platform-admin flag', () => {
  it('grants it, and the promoted user can then reach the console', async () => {
    const res = await admin.patch(`/api/admin/users/${ownerB.uid}/admin`)
      .send({ isAdmin: true });

    expect(res.status).toBe(200);
    expect(await isAdminFlag(ownerB.uid)).toBe(true);
    // The flag is only meaningful if the gate honours it, so the grant is
    // checked by its effect rather than by the column alone.
    expect((await ownerB.api.get('/api/admin/lawfirms')).status).toBe(200);
  });

  it('removes it, and the demoted user loses the console', async () => {
    await testPool.query('update users set is_admin = true where id = $1', [ownerB.uid]);

    const res = await admin.patch(`/api/admin/users/${ownerB.uid}/admin`)
      .send({ isAdmin: false });

    expect(res.status).toBe(200);
    expect(await isAdminFlag(ownerB.uid)).toBe(false);
    expect((await ownerB.api.get('/api/admin/lawfirms')).status).toBe(403);
  });

  it('refuses to remove the LAST platform admin', async () => {
    const res = await admin.patch(`/api/admin/users/${adminUid}/admin`)
      .send({ isAdmin: false });

    // `adminUid` is the only admin in this fixture. Clearing the last flag locks
    // every human out of the console, and the only way back is a hand-written
    // UPDATE against production Postgres.
    expect(res.status).toBe(403);
    expect(await isAdminFlag(adminUid)).toBe(true);
  });

  it('allows the second-to-last admin to be removed', async () => {
    const other = await platformAdmin();

    const res = await admin.patch(`/api/admin/users/${other.uid}/admin`)
      .send({ isAdmin: false });

    // The negative half of the lockout guard. A guard that refused every
    // revocation would satisfy the case above and make the flag unremovable.
    expect(res.status).toBe(200);
    expect(await isAdminFlag(other.uid)).toBe(false);
  });

  it('treats a grant to an existing admin as a no-op', async () => {
    const res = await admin.patch(`/api/admin/users/${adminUid}/admin`)
      .send({ isAdmin: true });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('User is already an admin');
    expect(await isAdminFlag(adminUid)).toBe(true);
  });

  it('answers 404 for a user id that names nobody', async () => {
    const res = await admin.patch('/api/admin/users/nobody-at-all/admin')
      .send({ isAdmin: true });

    expect(res.status).toBe(404);
  });
});

describe('plans', () => {
  it('reports a firm limits, features and current usage', async () => {
    await createFirmMember(firmB.id, { isOwner: false, permissions: [] });

    const res = await admin.get(`/api/admin/lawfirms/${firmB.id}/plan`);

    expect(res.status).toBe(200);
    // Two members: the owner the fixture created, and the one added above.
    expect(res.body.usage.members).toBe(2);
    expect(res.body.limits.storageQuotaBytes).toBe(ENTERPRISE_QUOTA_BYTES);
    expect(res.body.features.documentSigning).toBe(true);
  });

  it('changes the tier and re-syncs the TYPED storage quota to it', async () => {
    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}/plan`)
      .send({ planId: 'basic' });

    expect(res.status).toBe(200);
    const row = await firmRow(firmA.id);
    expect(row.plan_id).toBe('basic');
    // The tier change is only real if enforcement follows it. Leaving
    // `storage_quota_bytes` on the old tier lets a downgraded firm keep
    // uploading against the quota they no longer pay for.
    expect(Number(row.storage_quota_bytes)).toBe(BASIC_QUOTA_BYTES);
  });

  it('honours an explicit storage limit override over the tier', async () => {
    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}/plan`)
      .send({ planId: 'basic', limitOverrides: { storageQuotaBytes: 12345678 } });

    expect(res.status).toBe(200);
    expect(Number((await firmRow(firmA.id)).storage_quota_bytes)).toBe(12345678);
  });

  it.each([
    ['storageQuotaBytes', -1048576],
    ['maxFileSizeBytes', -1048576],
    ['storageQuotaBytes', 0],
  ])('refuses a %s override of %s and leaves the quota alone', async (key, value) => {
    const before = await firmRow(firmA.id);

    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}/plan`)
      .send({ limitOverrides: { [key]: value } });

    // Sizes have no unlimited sentinel, unlike the count limits. A zero or
    // negative quota would block every upload the firm makes.
    expect(res.status).toBe(400);
    const after = await firmRow(firmA.id);
    expect(after.storage_quota_bytes).toBe(before.storage_quota_bytes);
    expect(after.plan).toEqual(before.plan);
  });

  it('records who comped a firm and when', async () => {
    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}/plan`)
      .send({ comped: true, compedReason: 'Design partner' });

    expect(res.status).toBe(200);
    const plan = (await firmRow(firmA.id)).plan;
    expect(plan.comped).toBe(true);
    expect(plan.compedBy).toBe(adminUid);
    expect(plan.compedReason).toBe('Design partner');
  });

  it('clears the comp metadata when a firm stops being comped', async () => {
    await admin.patch(`/api/admin/lawfirms/${firmA.id}/plan`)
      .send({ comped: true, compedReason: 'Design partner' });

    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}/plan`)
      .send({ comped: false });

    // Stale comp metadata on a firm that now pays reads as a free account in
    // every report that groups by it.
    expect(res.status).toBe(200);
    const plan = (await firmRow(firmA.id)).plan;
    expect(plan.comped).toBe(false);
    expect(plan.compedBy).toBeNull();
    expect(plan.compedReason).toBeNull();
  });

  it('refuses a plan id that is not a tier', async () => {
    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}/plan`)
      .send({ planId: 'platinum' });

    expect(res.status).toBe(400);
    expect((await firmRow(firmA.id)).plan_id).toBe('enterprise');
  });

  it('comps a firm onto a named tier', async () => {
    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/comp`)
      .send({ planId: 'basic', reason: 'Beta partner' });

    expect(res.status).toBe(200);
    const row = await firmRow(firmA.id);
    expect(row.plan_id).toBe('basic');
    expect(row.billing_status).toBe('comped');
    expect(row.plan.comped).toBe(true);
    expect(row.plan.compedReason).toBe('Beta partner');
  });

  it('lists every plan tier', async () => {
    const res = await admin.get('/api/admin/plans');

    expect(res.status).toBe(200);
    expect(res.body.plans.map((p: any) => p.id))
      .toEqual(['starter', 'basic', 'professional', 'enterprise']);
  });
});

describe('the over-limit sweep', () => {
  it('flags a firm that is over its storage quota and leaves the others alone', async () => {
    await setStorage(firmA.id, { usedBytes: ENTERPRISE_QUOTA_BYTES + 1 });
    await setStorage(firmB.id, { usedBytes: 1024 });

    const res = await admin.get('/api/admin/plan-usage');

    expect(res.status).toBe(200);
    const byId = new Map(res.body.firms.map((f: any) => [f.lawFirmId, f]));
    // Both halves in one case on purpose: a sweep that flagged EVERY firm would
    // satisfy the positive assertion alone and be useless on the screen it feeds.
    expect((byId.get(firmA.id) as any).overLimit).toBe(true);
    expect((byId.get(firmB.id) as any).overLimit).toBe(false);
  });

  it('reports the usage figures behind the flag', async () => {
    await setStorage(firmA.id, { usedBytes: 4096 });
    await createFirmMember(firmA.id, { isOwner: false, permissions: [] });

    const res = await admin.get('/api/admin/plan-usage');

    const firm = res.body.firms.find((f: any) => f.lawFirmId === firmA.id);
    expect(firm.usage.storage.currentBytes).toBe(4096);
    expect(firm.usage.members.current).toBe(2);
  });

  it('says whether the sweep was truncated', async () => {
    const res = await admin.get('/api/admin/plan-usage');

    // A partial sweep that looked complete would report "no firms over limit"
    // for firms it never examined, which is the one answer this screen must
    // never give wrongly.
    expect(res.body.truncated).toBe(false);
    expect(typeof res.body.ceiling).toBe('number');
  });
});

describe('the email-verification whitelist', () => {
  it('adds an address and lists it back', async () => {
    const res = await admin.post('/api/admin/whitelist')
      .send({ email: 'tester@example.test', note: 'QA account' });

    expect(res.status).toBe(201);
    const list = await admin.get('/api/admin/whitelist');
    expect(list.body.entries.map((e: any) => e.email)).toContain('tester@example.test');
  });

  it('stores the address lowercased', async () => {
    const res = await admin.post('/api/admin/whitelist')
      .send({ email: 'Tester@Example.Test' });

    // The verification check looks the address up by the value Firebase reports,
    // which is lowercased. A mixed-case row would never match and the whitelist
    // would silently do nothing.
    expect(res.status).toBe(201);
    expect(await whitelistEmails()).toEqual(['tester@example.test']);
  });

  it('removes an address', async () => {
    await admin.post('/api/admin/whitelist').send({ email: 'tester@example.test' });
    expect(await whitelistEmails()).toEqual(['tester@example.test']);

    const res = await admin.delete('/api/admin/whitelist')
      .send({ email: 'tester@example.test' });

    expect(res.status).toBe(200);
    expect(await whitelistEmails()).toEqual([]);
  });

  it('answers 404 removing an address that was never whitelisted', async () => {
    const res = await admin.delete('/api/admin/whitelist')
      .send({ email: 'never-added@example.test' });

    // A silent 200 here would tell an admin an address was revoked when it never
    // existed, hiding a typo in the address they actually meant to revoke.
    expect(res.status).toBe(404);
  });

  it('refuses a malformed address', async () => {
    const res = await admin.post('/api/admin/whitelist').send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(await whitelistEmails()).toEqual([]);
  });
});

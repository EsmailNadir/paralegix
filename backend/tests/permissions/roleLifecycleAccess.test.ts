/**
 * What happens to a member when the role granting their access is deleted.
 *
 * Three things have to be true at once, and they pull in opposite directions:
 *
 *   1. The elevated permission goes away IMMEDIATELY, not after the 30 second
 *      cache backstop. The resolved permission set is cached per member, so a
 *      revoked role that only expires with the TTL leaves a member creating
 *      matters for half a minute after an owner took the ability away.
 *   2. The member is NOT locked out. `members.role_id` is `on delete set null`,
 *      so the member resolves to DEFAULT_PERMISSIONS, and the product's rule is
 *      that a narrow role degrades to read-only pages rather than to a denial
 *      screen.
 *   3. Nothing they legitimately created disappears.
 *
 * The cache is deliberately NOT cleared between the deletion and the assertion.
 * Clearing it would test the resolver and skip the invalidation listener, which
 * is the part that can actually be missing.
 */
import { ownerOf, memberWith, drainEvents, testPool, createFirm } from '../support/setupInProcess';

const matterBody = (name: string) => ({ name, description: 'Seeded by the role lifecycle spec' });

async function roleIdOf(lawFirmId: string, uid: string) {
  const { rows } = await testPool.query(
    'select role_id from members where law_firm_id = $1 and user_id = $2',
    [lawFirmId, uid],
  );
  return rows[0]?.role_id ?? null;
}

describe('deleting a role revokes its grant without locking the member out', () => {
  it('stops the member creating, keeps them reading, and keeps their work', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const member = await memberWith(firmId, ['matters.create', 'matters.view']);

    // The positive control, and it also WARMS the permission cache. Without it
    // the assertions below would pass against a member who never had the
    // permission in the first place.
    const created = await member.api
      .post(`/api/lawfirms/${firmId}/matters`)
      .send(matterBody('Matter created while the role existed'));
    expect(created.status).toBe(201);

    const roleId = await roleIdOf(firmId, member.uid);
    expect(roleId).not.toBeNull();

    const deleted = await owner.api.delete(`/api/lawfirms/${firmId}/roles/${roleId}`);
    expect(deleted.status).toBe(200);
    await drainEvents();

    // 1. The grant is gone NOW. No cache clearing happened between the delete
    //    and this line, so a missing invalidation would answer 201 here.
    const blocked = await member.api
      .post(`/api/lawfirms/${firmId}/matters`)
      .send(matterBody('Matter attempted after the role was deleted'));
    // Asserted as a PAIR so a failure names the refusal reason rather than just
    // the number. This case failed once in a full parallel run with a 401,
    // meaning the token was refused rather than the permission, and the bare
    // status told us nothing about why. See F09 in the progress ledger.
    expect({ status: blocked.status, code: blocked.body?.code }).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });

    // 2. Not locked out. `matters.view` is in the baseline, which no role can
    //    remove, so the member keeps read access.
    const stillReadable = await member.api.get(`/api/lawfirms/${firmId}/matters`);
    expect(stillReadable.status).toBe(200);

    // 3. Their work survives, and the refused write created nothing.
    const names = (stillReadable.body.matters || []).map((m: any) => m.name);
    expect(names).toContain('Matter created while the role existed');
    expect(names).not.toContain('Matter attempted after the role was deleted');
  });

  it('leaves the member with no role rather than a dangling reference', async () => {
    // The mechanism behind the degrade. The foreign key is `on delete set
    // null`, so the resolver takes its "no role" branch and returns the
    // baseline. Pinned because a schema change to `restrict` or `cascade` would
    // turn this scenario into a failed delete or a deleted member, and neither
    // would look like a permissions bug from the outside.
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const member = await memberWith(firmId, ['matters.create']);

    const roleId = await roleIdOf(firmId, member.uid);
    const del = await owner.api.delete(`/api/lawfirms/${firmId}/roles/${roleId}`);
    expect(del.status).toBe(200);

    expect(await roleIdOf(firmId, member.uid)).toBeNull();

    const { rows } = await testPool.query(
      'select count(*)::int as n from members where law_firm_id = $1 and user_id = $2',
      [firmId, member.uid],
    );
    expect(rows[0].n).toBe(1);
  });

  it('does not disturb a member whose own role was left alone', async () => {
    // The control that makes the revocation specific. A cache invalidation that
    // dropped the whole firm's entries would still be correct here, but a
    // resolver that started refusing everyone after any role delete would not.
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const keeps = await memberWith(firmId, ['matters.create', 'matters.view']);
    const loses = await memberWith(firmId, ['matters.create', 'matters.view']);

    await keeps.api.post(`/api/lawfirms/${firmId}/matters`).send(matterBody('Warm the cache'));

    const doomedRole = await roleIdOf(firmId, loses.uid);
    await owner.api.delete(`/api/lawfirms/${firmId}/roles/${doomedRole}`);
    await drainEvents();

    const stillAllowed = await keeps.api
      .post(`/api/lawfirms/${firmId}/matters`)
      .send(matterBody('Created after someone ELSE lost their role'));

    expect(stillAllowed.status).toBe(201);
  });

  it('refuses the member of another firm entirely, role or no role', async () => {
    // The tenancy control. Everything above is about a member losing a grant
    // inside their own firm; this is the boundary that must never depend on a
    // role at all.
    const { id: firmA } = await createFirm();
    const { id: firmB } = await createFirm();
    await ownerOf(firmA);
    const outsider = await memberWith(firmB, ['matters.create', 'matters.view']);

    const res = await outsider.api
      .post(`/api/lawfirms/${firmA}/matters`)
      .send(matterBody('Matter attempted across the firm boundary'));

    expect(res.status).toBe(403);

    const { rows } = await testPool.query(
      'select count(*)::int as n from matters where law_firm_id = $1',
      [firmA],
    );
    expect(rows[0].n).toBe(0);
  });
  it('lets the role go even when a pending invitation still names it', async () => {
    // The second table carrying the same key. An invitation is written when
    // someone is invited to a role and outlives the invite flow, so a firm that
    // invited a person into a role it later retired could not retire it. The
    // invitation must survive with its pointer cleared, not be deleted: it is
    // audit history of who was invited and by whom.
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const member = await memberWith(firmId, ['matters.view']);
    const roleId = await roleIdOf(firmId, member.uid);

    await testPool.query(
      `insert into invitations (law_firm_id, email, invite_type, role_id, token, status)
       values ($1, $2, 'member', $3, $4, 'pending')`,
      [firmId, 'invited@example.test', roleId, `token-${roleId}`],
    );

    const deleted = await owner.api.delete(`/api/lawfirms/${firmId}/roles/${roleId}`);
    expect(deleted.status).toBe(200);

    const { rows } = await testPool.query(
      'select role_id, email, status from invitations where law_firm_id = $1',
      [firmId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role_id).toBeNull();
    expect(rows[0].email).toBe('invited@example.test');
  });
});

describe('narrowing a role permissions revokes the removed grant without locking the member out', () => {
  it('stops the member creating the moment the permission is removed from their role', async () => {
    // Same shape as the delete case above, but the role survives: only its
    // permission array shrinks. The cache is deliberately NOT cleared between
    // the update and the assertion, so a missing ROLE_PERMISSIONS_CHANGED emit
    // (or a listener that only reacts to role deletion) would leave the member
    // creating matters for up to the 30 second TTL after the permission was
    // taken away.
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const member = await memberWith(firmId, ['matters.create', 'matters.view']);

    const created = await member.api
      .post(`/api/lawfirms/${firmId}/matters`)
      .send(matterBody('Matter created while the role still granted create'));
    expect(created.status).toBe(201);

    const roleId = await roleIdOf(firmId, member.uid);
    const updated = await owner.api
      .put(`/api/lawfirms/${firmId}/roles/${roleId}`)
      .send({ permissions: ['matters.view'] });
    expect(updated.status).toBe(200);
    await drainEvents();

    const blocked = await member.api
      .post(`/api/lawfirms/${firmId}/matters`)
      .send(matterBody('Matter attempted after create was removed from the role'));
    expect({ status: blocked.status, code: blocked.body?.code }).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });

    // The permission left on the role still works: this is a narrowing, not a
    // lockout.
    const stillReadable = await member.api.get(`/api/lawfirms/${firmId}/matters`);
    expect(stillReadable.status).toBe(200);
    const names = (stillReadable.body.matters || []).map((m: any) => m.name);
    expect(names).toContain('Matter created while the role still granted create');
    expect(names).not.toContain('Matter attempted after create was removed from the role');
  });

  it('does not disturb a member holding a different role in the same firm', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const narrowed = await memberWith(firmId, ['matters.create', 'matters.view']);
    const untouched = await memberWith(firmId, ['matters.create', 'matters.view']);

    await untouched.api.post(`/api/lawfirms/${firmId}/matters`).send(matterBody('Warm the cache'));

    const narrowedRoleId = await roleIdOf(firmId, narrowed.uid);
    await owner.api
      .put(`/api/lawfirms/${firmId}/roles/${narrowedRoleId}`)
      .send({ permissions: ['matters.view'] });
    await drainEvents();

    const stillAllowed = await untouched.api
      .post(`/api/lawfirms/${firmId}/matters`)
      .send(matterBody('Created after someone else role was narrowed'));
    expect(stillAllowed.status).toBe(201);
  });
});

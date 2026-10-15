/**
 * A role editor may not grant what they do not hold.
 *
 * This app blocks privilege escalation on two of the three paths that can widen
 * someone's permissions, and both do it the same way: resolve what the target
 * role would grant, subtract what the ACTOR holds, and refuse if anything is
 * left over. `inviteMember` does it, and `changeRole` does it
 * (members.service.ts, `excess.length > 0`).
 *
 * `createRole` and `updateRole` did not. They never received the acting member
 * at all, so a caller holding `firm.manageRoles` could write any array drawn
 * from ALL_PERMISSIONS straight onto a role, including the one they hold
 * themselves. The two guarded paths were then irrelevant: rather than assigning
 * a stronger role, the caller edits their own into one.
 *
 * That reaches further than it looks. `members.changeRole` is what flips
 * `isFirmOwnerOrAdmin`, which is the single source of truth for "sees every
 * matter in the firm", so this is also an ethical-wall bypass on every matter,
 * on top of `trust.manage`, `clients.erase` and `firm.delete`.
 *
 * The route gate is `firm.manageRoles`, which is NOT in DEFAULT_PERMISSIONS, so
 * this needs a role that grants role management without granting everything
 * else. The built-in Owner and Admin roles both already hold everything, so
 * they are unaffected either way; the exposure is a custom role.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const { ALL_PERMISSIONS } = require('../../src/modules/lawfirms/roles/permissions');

let firm: Firm;
let owner: Actor;
let roleEditor: Actor;

/** The role `roleEditor` actually holds, so a case can try to edit it. */
const editorRoleId = async () => (await testPool.query(
  'select role_id from members where law_firm_id = $1 and user_id = $2', [firm.id, roleEditor.uid],
)).rows[0].role_id;

const permissionsOf = async (roleId: string) => (await testPool.query(
  'select permissions from roles where id = $1', [roleId],
)).rows[0].permissions;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  // Role management and nothing else. This is the shape the escalation needs.
  roleEditor = await memberWith(firm.id, ['firm.manageRoles']);
  await drainEvents();
});

describe('editing a role cannot grant more than the editor holds', () => {
  it('refuses to write a permission the editor does not have', async () => {
    const roleId = await editorRoleId();

    const res = await roleEditor.api.put(`/api/lawfirms/${firm.id}/roles/${roleId}`)
      .send({ permissions: ['firm.manageRoles', 'trust.manage'] });

    expect(res.status).toBe(403);
    // The stored array, not the status. A route that answered 403 after writing
    // has already granted the permission, and the cache drop that follows makes
    // it live on the next request.
    expect(await permissionsOf(roleId)).toEqual(['firm.manageRoles']);
  });

  it('refuses the full ALL_PERMISSIONS grab', async () => {
    const roleId = await editorRoleId();

    const res = await roleEditor.api.put(`/api/lawfirms/${firm.id}/roles/${roleId}`)
      .send({ permissions: ALL_PERMISSIONS });

    expect(res.status).toBe(403);
    expect(await permissionsOf(roleId)).toEqual(['firm.manageRoles']);
  });

  it('refuses to build a NEW role stronger than the editor', async () => {
    const res = await roleEditor.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Sneaky', permissions: ['trust.manage', 'clients.erase'] });

    // Creating the role is the same escalation one step removed: the editor
    // then assigns it, or edits their own membership onto it.
    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      'select count(*)::int as n from roles where law_firm_id = $1 and name = $2',
      [firm.id, 'Sneaky'],
    );
    expect(rows[0].n).toBe(0);
  });

  it('still allows granting a permission the editor DOES hold', async () => {
    const wider = await memberWith(firm.id, ['firm.manageRoles', 'trust.manage']);
    const roleId = (await testPool.query(
      'select role_id from members where law_firm_id = $1 and user_id = $2', [firm.id, wider.uid],
    )).rows[0].role_id;

    const res = await wider.api.put(`/api/lawfirms/${firm.id}/roles/${roleId}`)
      .send({ permissions: ['firm.manageRoles', 'trust.manage'] });

    // The half that keeps the fix honest. A guard that refused every edit would
    // satisfy all three cases above and break role management entirely.
    expect(res.status).toBe(200);
    expect(await permissionsOf(roleId)).toEqual(
      expect.arrayContaining(['firm.manageRoles', 'trust.manage']),
    );
  });

  it('lets an editor NARROW a role', async () => {
    const wider = await memberWith(firm.id, ['firm.manageRoles', 'trust.manage']);
    const roleId = (await testPool.query(
      'select role_id from members where law_firm_id = $1 and user_id = $2', [firm.id, wider.uid],
    )).rows[0].role_id;

    const res = await wider.api.put(`/api/lawfirms/${firm.id}/roles/${roleId}`)
      .send({ permissions: ['firm.manageRoles'] });

    // Dropping a permission is never an escalation, and blocking it would trap
    // a firm with a role it cannot tighten.
    expect(res.status).toBe(200);
    expect(await permissionsOf(roleId)).toEqual(['firm.manageRoles']);
  });

  it('lets the OWNER grant anything, since they already hold everything', async () => {
    const roleId = await editorRoleId();

    const res = await owner.api.put(`/api/lawfirms/${firm.id}/roles/${roleId}`)
      .send({ permissions: ['firm.manageRoles', 'trust.manage'] });

    // The owner resolves to ALL_PERMISSIONS, so nothing is ever in excess. This
    // pins that the fix does not break the ordinary administrative path.
    expect(res.status).toBe(200);
  });

  it('lets an editor rename a role without touching permissions', async () => {
    const roleId = await editorRoleId();

    const res = await roleEditor.api.put(`/api/lawfirms/${firm.id}/roles/${roleId}`)
      .send({ name: 'Renamed' });

    // A name-only edit carries no permissions array at all, so the guard must
    // not reject it for having nothing to compare.
    expect(res.status).toBe(200);
    expect(await permissionsOf(roleId)).toEqual(['firm.manageRoles']);
  });
});

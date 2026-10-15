/**
 * The role CRUD surface: `/api/lawfirms/:lawFirmId/roles`.
 *
 * The permissions folder already covers what a role MEANS once it exists:
 * `roleEscalation.test.ts` covers the no-escalation rule, `roleLifecycleAccess`
 * covers what happens to a member when their role is deleted, and
 * `permissionBoundary` covers the always-on baseline. None of them covers the
 * five routes themselves, which is where these rules live:
 *
 *   ONLY 'Owner' IS UNDELETABLE. The guard is on the role's NAME, not on its
 *   `is_built_in` flag, so Admin, Attorney, Paralegal and Staff can all be
 *   removed by a firm that does not want them. That is deliberate, and a test
 *   asserting "built-in roles cannot be deleted" would be asserting a rule the
 *   product does not have.
 *
 *   A BUILT-IN ROLE CANNOT BE RENAMED, but its permissions CAN be changed. The
 *   two halves of the same request are governed separately.
 *
 *   READING ROLES IS `members.view`; CHANGING THEM IS `firm.manageRoles`. Both
 *   are firm-scoped, and neither may reach another firm's roles.
 *
 * Driven through the routes. `createRole` takes `actingMember` from `req.member`,
 * which only the middleware populates, so a service-level call has to invent it
 * and proves nothing about the gate that produced it.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const { BUILT_IN_ROLES } = require('../../src/modules/lawfirms/roles/permissions');

let firm: Firm;
let owner: Actor;
let otherFirm: Firm;
let otherOwner: Actor;

const R = (lawFirmId: string, suffix = '') => `/api/lawfirms/${lawFirmId}/roles${suffix}`;

/**
 * Seed the five built-in roles a real firm is created with.
 *
 * `createFirm` in the test factory writes only the `law_firms` row; the built-in
 * roles are seeded by `lawfirmsService.createLawFirm`, which cannot be used here
 * because it also enforces the per-user firm-membership cap. Seeding from the
 * same `BUILT_IN_ROLES` constant the service reads keeps the two in step.
 */
async function seedBuiltInRoles(lawFirmId: string) {
  const ids: Record<string, string> = {};
  for (const definition of Object.values(BUILT_IN_ROLES) as any[]) {
    const id = randomUUID();
    ids[definition.name] = id;
    // eslint-disable-next-line no-await-in-loop -- a handful of rows, order irrelevant
    await testPool.query(
      `insert into roles (id, law_firm_id, name, is_built_in, permissions)
       values ($1, $2, $3, true, $4)`,
      [id, lawFirmId, definition.name, definition.permissions],
    );
  }
  return ids;
}

async function roleRows(lawFirmId: string) {
  const { rows } = await testPool.query(
    'select * from roles where law_firm_id = $1 order by name', [lawFirmId],
  );
  return rows;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Roles Test Firm' });
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm({ name: 'Neighbour LLP' });
  otherOwner = await ownerOf(otherFirm.id);
});

describe('listing and reading roles', () => {
  it('lists the firm built-in roles', async () => {
    await seedBuiltInRoles(firm.id);

    const res = await owner.api.get(R(firm.id));

    expect(res.status).toBe(200);
    expect(res.body.roles.map((r: any) => r.name).sort())
      .toEqual(['Admin', 'Attorney', 'Owner', 'Paralegal', 'Staff']);
  });

  it('carries each role permission list, not just its name', async () => {
    await seedBuiltInRoles(firm.id);

    const res = await owner.api.get(R(firm.id));

    // The role editor renders the checkbox state from this array. A list that
    // returned names alone would render every role as holding nothing, and
    // saving that screen would strip the role.
    const staff = res.body.roles.find((r: any) => r.name === 'Staff');
    expect(Array.isArray(staff.permissions)).toBe(true);
    expect(staff.permissions).toEqual(expect.arrayContaining(BUILT_IN_ROLES.staff.permissions));
  });

  it('reads one role by its id', async () => {
    const ids = await seedBuiltInRoles(firm.id);

    const res = await owner.api.get(R(firm.id, `/${ids.Attorney}`));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ids.Attorney, name: 'Attorney' });
  });

  it('never lists another firm roles', async () => {
    await seedBuiltInRoles(firm.id);
    await seedBuiltInRoles(otherFirm.id);
    await owner.api.post(R(firm.id)).send({ name: 'Mine Only', permissions: ['matters.view'] });

    const mine = await owner.api.get(R(firm.id));
    const theirs = await otherOwner.api.get(R(otherFirm.id));

    // Both directions. The custom role is the marker: the built-in names are
    // identical at both firms, so only a distinct one can prove the scope.
    expect(mine.body.roles.map((r: any) => r.name)).toContain('Mine Only');
    expect(theirs.body.roles.map((r: any) => r.name)).not.toContain('Mine Only');
  });

  it('does not serve another firm role by its id', async () => {
    const theirs = await seedBuiltInRoles(otherFirm.id);

    const res = await owner.api.get(R(firm.id, `/${theirs.Attorney}`));

    // A real, existing id. The refusal is the tenant scope, not a missing row.
    expect(res.status).toBe(404);
  });

  it('lets a member holding only members.view read the roles', async () => {
    await seedBuiltInRoles(firm.id);
    const viewer = await memberWith(firm.id, []);

    const res = await viewer.api.get(R(firm.id));

    // `members.view` is baseline. The member list shows each person's role, so
    // hiding the role list would leave that column unlabelled.
    //
    // Asserted by NAME rather than by count: `memberWith` expresses a narrow role
    // by creating a role row for it, so the viewer's own role is in this list too.
    expect(res.status).toBe(200);
    expect(res.body.roles.map((r: any) => r.name))
      .toEqual(expect.arrayContaining(['Admin', 'Attorney', 'Owner', 'Paralegal', 'Staff']));
  });
});

describe('creating a custom role', () => {
  it('stores the name and permissions, and marks it not built-in', async () => {
    const res = await owner.api.post(R(firm.id)).send({
      name: 'Paralegal Associate',
      permissions: ['matters.view', 'tasks.view', 'billing.viewRates'],
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      message: 'Role created successfully',
      roleId: expect.any(String),
    });
    const rows = await roleRows(firm.id);
    expect(rows).toHaveLength(1);
    // `is_built_in` decides whether the role can be renamed later, so a custom
    // role created as built-in would be permanently stuck with its first name.
    expect(rows[0]).toMatchObject({ name: 'Paralegal Associate', is_built_in: false });
    expect(rows[0].permissions).toEqual(['matters.view', 'tasks.view', 'billing.viewRates']);
  });

  it('refuses a name the firm already uses', async () => {
    await owner.api.post(R(firm.id)).send({ name: 'Duplicate', permissions: [] });

    const res = await owner.api.post(R(firm.id)).send({ name: 'Duplicate', permissions: [] });

    // Two roles of the same name make the member editor ambiguous: the dropdown
    // shows one entry twice with no way to tell which grant it applies.
    expect(res.status).toBe(409);
    expect(await roleRows(firm.id)).toHaveLength(1);
  });

  it('lets a different firm use the same role name', async () => {
    await owner.api.post(R(firm.id)).send({ name: 'Shared Name', permissions: [] });

    const res = await otherOwner.api.post(R(otherFirm.id))
      .send({ name: 'Shared Name', permissions: [] });

    // The uniqueness rule is per firm. A global one would make one firm's role
    // list depend on every other firm's.
    expect(res.status).toBe(201);
  });

  it('rejects an unknown permission code, and writes nothing', async () => {
    const res = await owner.api.post(R(firm.id))
      .send({ name: 'Invented', permissions: ['matters.view', 'matters.summonDragons'] });

    // A role carrying a code no gate checks is a grant nobody can see and nobody
    // can revoke. The whole array is refused rather than the unknown entry
    // silently dropped.
    expect(res.status).toBe(400);
    expect(await roleRows(firm.id)).toHaveLength(0);
  });

  it('rejects an empty name', async () => {
    const res = await owner.api.post(R(firm.id)).send({ name: '', permissions: [] });

    expect(res.status).toBe(400);
    expect(await roleRows(firm.id)).toHaveLength(0);
  });

  it('refuses a member without firm.manageRoles, and writes nothing', async () => {
    const member = await memberWith(firm.id, ['members.view']);

    const res = await member.api.post(R(firm.id)).send({ name: 'Self Promotion', permissions: [] });

    // By name, not by count: creating the narrow member above already added a
    // role row of its own.
    expect(res.status).toBe(403);
    expect((await roleRows(firm.id)).map((r: any) => r.name)).not.toContain('Self Promotion');
  });

  it('refuses a member of another firm', async () => {
    const res = await otherOwner.api.post(R(firm.id)).send({ name: 'Intruder', permissions: [] });

    expect(res.status).toBe(403);
    expect(await roleRows(firm.id)).toHaveLength(0);
  });
});

describe('updating a role', () => {
  it('renames a custom role and rewrites its permissions', async () => {
    const created = await owner.api.post(R(firm.id))
      .send({ name: 'Before', permissions: ['matters.view'] });
    const roleId = created.body.roleId;

    const res = await owner.api.put(R(firm.id, `/${roleId}`))
      .send({ name: 'After', permissions: ['matters.view', 'tasks.view'] });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query('select * from roles where id = $1', [roleId]);
    expect(rows[0].name).toBe('After');
    expect(rows[0].permissions).toEqual(['matters.view', 'tasks.view']);
  });

  it('replaces the permission list rather than adding to it', async () => {
    const created = await owner.api.post(R(firm.id))
      .send({ name: 'Shrinking', permissions: ['matters.view', 'tasks.view', 'files.view'] });

    await owner.api.put(R(firm.id, `/${created.body.roleId}`))
      .send({ permissions: ['matters.view'] });

    // The role editor submits the full checkbox state, so an update that merged
    // instead of replacing would make it impossible to REMOVE a permission, and
    // nothing on screen would say the unchecked box did not take.
    const { rows } = await testPool.query(
      'select permissions from roles where id = $1', [created.body.roleId],
    );
    expect(rows[0].permissions).toEqual(['matters.view']);
  });

  it('refuses to rename a built-in role', async () => {
    const ids = await seedBuiltInRoles(firm.id);

    const res = await owner.api.put(R(firm.id, `/${ids.Attorney}`)).send({ name: 'Solicitor' });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query('select name from roles where id = $1', [ids.Attorney]);
    expect(rows[0].name).toBe('Attorney');
  });

  it('still allows a built-in role permissions to be customised', async () => {
    const ids = await seedBuiltInRoles(firm.id);

    const res = await owner.api.put(R(firm.id, `/${ids.Paralegal}`))
      .send({ permissions: ['matters.view'] });

    // The rename guard and the permission edit are separate rules. A guard that
    // refused the whole request for a built-in role would make the shipped roles
    // uncustomisable, which is the opposite of the intent.
    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      'select permissions from roles where id = $1', [ids.Paralegal],
    );
    expect(rows[0].permissions).toEqual(['matters.view']);
  });

  it('accepts a request that re-sends a built-in role own name', async () => {
    const ids = await seedBuiltInRoles(firm.id);

    const res = await owner.api.put(R(firm.id, `/${ids.Staff}`))
      .send({ name: 'Staff', permissions: ['matters.view'] });

    // The rename guard compares against the CURRENT name, and the edit form
    // submits the name it loaded. Refusing this would break every save on a
    // built-in role.
    expect(res.status).toBe(200);
  });

  it('does not update another firm role', async () => {
    const theirs = await seedBuiltInRoles(otherFirm.id);

    const res = await owner.api.put(R(firm.id, `/${theirs.Paralegal}`))
      .send({ permissions: ['matters.view'] });

    expect(res.status).toBe(404);
    const { rows } = await testPool.query(
      'select permissions from roles where id = $1', [theirs.Paralegal],
    );
    expect(rows[0].permissions).toEqual(BUILT_IN_ROLES.paralegal.permissions);
  });
});

describe('deleting a role', () => {
  it('deletes a custom role', async () => {
    const created = await owner.api.post(R(firm.id)).send({ name: 'Temporary', permissions: [] });

    const res = await owner.api.delete(R(firm.id, `/${created.body.roleId}`));

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('deleted successfully');
    expect(await roleRows(firm.id)).toHaveLength(0);
  });

  it('refuses to delete the Owner role', async () => {
    const ids = await seedBuiltInRoles(firm.id);

    const res = await owner.api.delete(R(firm.id, `/${ids.Owner}`));

    // Deleting Owner would leave the firm with no role carrying the full
    // permission set, and no way to grant one back.
    expect(res.status).toBe(403);
    const { rows } = await testPool.query('select 1 from roles where id = $1', [ids.Owner]);
    expect(rows).toHaveLength(1);
  });

  it('CHARACTERISATION: allows a built-in role other than Owner to be deleted', async () => {
    const ids = await seedBuiltInRoles(firm.id);

    const res = await owner.api.delete(R(firm.id, `/${ids.Paralegal}`));

    // The guard is on the NAME 'Owner', not on `is_built_in`. A firm that does
    // not use Paralegal can remove it, which is deliberate. Pinned here because
    // "built-in roles are protected" is the intuitive reading and is wrong.
    expect(res.status).toBe(200);
    expect((await roleRows(firm.id)).map((r: any) => r.name).sort())
      .toEqual(['Admin', 'Attorney', 'Owner', 'Staff']);
  });

  it('refuses a member without firm.manageRoles', async () => {
    const created = await owner.api.post(R(firm.id)).send({ name: 'Keep Me', permissions: [] });
    const member = await memberWith(firm.id, ['members.view']);

    const res = await member.api.delete(R(firm.id, `/${created.body.roleId}`));

    expect(res.status).toBe(403);
    expect((await roleRows(firm.id)).map((r: any) => r.name)).toContain('Keep Me');
  });

  it('does not delete another firm role', async () => {
    const theirs = await seedBuiltInRoles(otherFirm.id);

    const res = await owner.api.delete(R(firm.id, `/${theirs.Staff}`));

    expect(res.status).toBe(404);
    expect(await roleRows(otherFirm.id)).toHaveLength(5);
  });

  it('answers 404 for a role id that exists nowhere', async () => {
    expect((await owner.api.delete(R(firm.id, `/${randomUUID()}`))).status).toBe(404);
  });
});

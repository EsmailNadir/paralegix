/**
 * A role that can MANAGE something can always VIEW it.
 *
 * The member baseline carries no financial reads, so a role holding
 * `billing.manageTimeEntries` without `billing.viewRates` would reach the time
 * entry form and 403 on the charge-code picker. `MANAGE_IMPLIES_VIEW` lists
 * each manage code with the reads it must come with, `withImpliedViewPermissions`
 * applies it, and the roles repository applies it on every write.
 *
 * WHAT BREAKS EACH TEST:
 *  - drop a pair from the map and the pure-helper table fails for that code;
 *  - stop normalizing in the repository and the create/update route tests see
 *    the stored array without the implied reads;
 *  - make an update strip the view code when its manage code is removed and the
 *    "removing a manage code" test sees it gone;
 *  - edit a built-in role so it holds a manage code without its reads and the
 *    built-in consistency test names the role.
 */
import {
  testPool,
  createFirm,
  createFirmMember,
  ownerOf,
  tokenFor,
  as,
  seedRole,
  memberWith,
  type Actor,
} from '../support/setupInProcess';
import { resetCaches } from '../support/caches';
import { platformAdmin } from '../support/rows';

const {
  PERMISSIONS, ALL_PERMISSIONS, DEFAULT_PERMISSIONS, BUILT_IN_ROLES,
  MANAGE_IMPLIES_VIEW, withImpliedViewPermissions,
} = require('../../src/modules/lawfirms/roles/permissions');
const { seedBuiltInRoles } = require('../../src/modules/lawfirms/roles/roles.service');

const permsOf = async (id: string) => {
  const { rows } = await testPool.query(`select permissions from roles where id = $1`, [id]);
  return rows[0].permissions as string[];
};

beforeEach(() => resetCaches());

describe('MANAGE_IMPLIES_VIEW', () => {
  it('maps exactly the manage codes of the billing and trust families to their reads', () => {
    expect(MANAGE_IMPLIES_VIEW).toEqual({
      'billing.manageTimeEntries': ['billing.viewTimeEntries', 'billing.viewRates'],
      'billing.manageInvoices': ['billing.viewInvoices', 'billing.viewRates'],
      'billing.recordPayments': ['billing.viewInvoices'],
      'billing.manageRates': ['billing.viewRates'],
      'billing.managePlans': ['billing.viewPlans'],
      'billing.manageExpenses': ['billing.viewExpenses'],
      'trust.manage': ['trust.view'],
      'trust.reconcile': ['trust.view'],
    });
  });

  it('names only codes that exist in the catalog', () => {
    for (const [manage, views] of Object.entries(MANAGE_IMPLIES_VIEW) as Array<[string, string[]]>) {
      expect(ALL_PERMISSIONS).toContain(manage);
      for (const view of views) expect(ALL_PERMISSIONS).toContain(view);
    }
  });

  it('never lists a baseline code as implied, because the baseline is always held', () => {
    for (const views of Object.values(MANAGE_IMPLIES_VIEW) as string[][]) {
      for (const view of views) expect(DEFAULT_PERMISSIONS).not.toContain(view);
    }
  });

  it('describes each implied code as a read', () => {
    for (const views of Object.values(MANAGE_IMPLIES_VIEW) as string[][]) {
      for (const view of views) expect(PERMISSIONS[view]).toMatch(/^View /);
    }
  });
});

describe('withImpliedViewPermissions', () => {
  it.each(Object.entries(MANAGE_IMPLIES_VIEW) as Array<[string, string[]]>)(
    'adds the reads %s needs, after the codes already held',
    (manage, views) => {
      expect(withImpliedViewPermissions(['matters.view', manage])).toEqual(['matters.view', manage, ...views]);
    },
  );

  it('adds nothing for a role with no manage code', () => {
    const input = ['billing.viewInvoices', 'matters.update', 'trust.view'];
    expect(withImpliedViewPermissions(input)).toEqual(input);
  });

  it('skips reads the role already holds and keeps their position', () => {
    expect(withImpliedViewPermissions(['billing.viewRates', 'billing.manageTimeEntries']))
      .toEqual(['billing.viewRates', 'billing.manageTimeEntries', 'billing.viewTimeEntries']);
  });

  it('is idempotent and deterministic regardless of how often it runs', () => {
    const once = withImpliedViewPermissions(['trust.reconcile', 'billing.manageInvoices', 'billing.managePlans']);
    expect(once).toEqual([
      'trust.reconcile', 'billing.manageInvoices', 'billing.managePlans',
      'billing.viewInvoices', 'billing.viewRates', 'billing.viewPlans', 'trust.view',
    ]);
    expect(withImpliedViewPermissions(once)).toEqual(once);
  });

  it('de-duplicates and keeps codes it does not know', () => {
    expect(withImpliedViewPermissions(['custom.code', 'trust.manage', 'trust.manage', 'custom.code']))
      .toEqual(['custom.code', 'trust.manage', 'trust.view']);
  });

  it('does not mutate its input', () => {
    const input = ['billing.manageExpenses'];
    withImpliedViewPermissions(input);
    expect(input).toEqual(['billing.manageExpenses']);
  });
});

describe('built-in role definitions', () => {
  it.each(Object.entries(BUILT_IN_ROLES) as Array<[string, any]>)(
    'the %s role already equals its own implied-view closure',
    (_key, role) => {
      expect(withImpliedViewPermissions(role.permissions)).toEqual(role.permissions);
    },
  );
});

describe('roles API write path', () => {
  it('stores the implied reads when a custom role is created with a manage code', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Timekeeper', permissions: ['billing.manageTimeEntries'] });

    expect(res.status).toBe(201);
    const expected = ['billing.manageTimeEntries', 'billing.viewTimeEntries', 'billing.viewRates'];
    expect(res.body.role.permissions).toEqual(expected);
    expect(await permsOf(res.body.roleId)).toEqual(expected);
  });

  it('stores a role with no manage code exactly as given', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Reader', permissions: ['billing.viewInvoices', 'matters.update'] });

    expect(res.status).toBe(201);
    expect(await permsOf(res.body.roleId)).toEqual(['billing.viewInvoices', 'matters.update']);
  });

  it('adds billing.viewInvoices when an update adds billing.manageInvoices', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const roleId = await seedRole(firm.id, { permissions: ['matters.update'] });

    const res = await owner.api.put(`/api/lawfirms/${firm.id}/roles/${roleId}`)
      .send({ permissions: ['matters.update', 'billing.manageInvoices'] });

    expect(res.status).toBe(200);
    expect(await permsOf(roleId)).toEqual([
      'matters.update', 'billing.manageInvoices', 'billing.viewInvoices', 'billing.viewRates',
    ]);
  });

  it('keeps the read when an update removes its manage code', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Billing clerk', permissions: ['billing.manageExpenses'] });
    expect(await permsOf(created.body.roleId)).toEqual(['billing.manageExpenses', 'billing.viewExpenses']);

    const res = await owner.api.put(`/api/lawfirms/${firm.id}/roles/${created.body.roleId}`)
      .send({ permissions: ['billing.viewExpenses'] });

    expect(res.status).toBe(200);
    expect(await permsOf(created.body.roleId)).toEqual(['billing.viewExpenses']);
  });

  it('leaves permissions alone when an update only renames the role', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const roleId = await seedRole(firm.id, { permissions: ['trust.manage'] });

    const res = await owner.api.put(`/api/lawfirms/${firm.id}/roles/${roleId}`).send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(await permsOf(roleId)).toEqual(['trust.manage']);
  });

  it('normalizes a role edited by a non-owner holding the manage code and the reads', async () => {
    const firm = await createFirm();
    const editor = await memberWith(firm.id, ['firm.manageRoles', 'billing.manageRates', 'billing.viewRates']);

    const res = await editor.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Rate editor', permissions: ['billing.manageRates'] });

    expect(res.status).toBe(201);
    expect(await permsOf(res.body.roleId)).toEqual(['billing.manageRates', 'billing.viewRates']);
  });

  it('stores the implied reads when the platform admin console rewrites a role', async () => {
    const firm = await createFirm();
    const admin = await platformAdmin();
    const roleId = await seedRole(firm.id, { permissions: ['matters.view'] });

    const res = await admin.api.patch(`/api/admin/lawfirms/${firm.id}/roles/${roleId}`)
      .send({ permissions: ['matters.view', 'trust.reconcile'] });

    expect(res.status).toBe(200);
    expect(await permsOf(roleId)).toEqual(['matters.view', 'trust.reconcile', 'trust.view']);
  });

  it('seeds every built-in role exactly as defined', async () => {
    const firm = await createFirm();
    const roleIds = await seedBuiltInRoles(firm.id);

    for (const [key, def] of Object.entries(BUILT_IN_ROLES) as Array<[string, any]>) {
      expect(await permsOf(roleIds[key])).toEqual(def.permissions);
    }
  });
});

describe('a member whose role was saved with only manageTimeEntries', () => {
  async function memberOnRole(lawFirmId: string, roleId: string): Promise<Actor> {
    const { uid } = await createFirmMember(lawFirmId, { isOwner: false });
    await testPool.query(
      'update members set role_id = $3 where law_firm_id = $1 and user_id = $2',
      [lawFirmId, uid, roleId],
    );
    return { uid, api: as(tokenFor({ uid })) };
  }

  it('reaches the charge codes and the time entry list', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Time only', permissions: ['billing.manageTimeEntries'] });
    const member = await memberOnRole(firm.id, created.body.roleId);

    const codes = await member.api.get(`/api/lawfirms/${firm.id}/billing/charge-codes`);
    const entries = await member.api.get(`/api/lawfirms/${firm.id}/billing/time-entries/firm`);

    expect(codes.status).toBe(200);
    expect(entries.status).toBe(200);
  });

  it('is still refused on invoices, expenses and trust, which nothing implies', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Time only', permissions: ['billing.manageTimeEntries'] });
    const member = await memberOnRole(firm.id, created.body.roleId);

    for (const path of ['/billing/invoices/firm', '/trust/accounts', '/billing/plans']) {
      expect((await member.api.get(`/api/lawfirms/${firm.id}${path}`)).status).toBe(403);
    }
  });

  it('is refused on the charge codes when the role skipped the write path', async () => {
    const firm = await createFirm();
    const roleId = await seedRole(firm.id, { permissions: ['billing.manageTimeEntries'] });
    const member = await memberOnRole(firm.id, roleId);

    expect((await member.api.get(`/api/lawfirms/${firm.id}/billing/charge-codes`)).status).toBe(403);
  });
});

/**
 * The escalation guard on role writes against the implied reads.
 *
 * Every read the repository adds comes from a manage code in the request, and a
 * non-owner can only request a manage code they hold, so the reads a caller
 * causes to be stored are always implied by authority they already have.
 *
 * WHAT BREAKS EACH TEST:
 *  - make the guard refuse implied reads the caller lacks and the manage-only
 *    cases below answer 403 instead of storing the reads;
 *  - make the guard skip a requested read the caller lacks (for example by
 *    exempting every code in MANAGE_IMPLIES_VIEW values) and the viewRates and
 *    unheld-code cases below answer 2xx or leave a write behind.
 */
describe('role writes by a non-owner and the implied reads', () => {
  it('stores viewRates for a caller who holds manageRates but not viewRates', async () => {
    const firm = await createFirm();
    const editor = await memberWith(firm.id, ['firm.manageRoles', 'billing.manageRates']);

    const res = await editor.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Rate editor', permissions: ['billing.manageRates'] });

    expect(res.status).toBe(201);
    expect(await permsOf(res.body.roleId)).toEqual(['billing.manageRates', 'billing.viewRates']);
  });

  it('stores viewRates when such a caller updates an existing role', async () => {
    const firm = await createFirm();
    const editor = await memberWith(firm.id, ['firm.manageRoles', 'billing.manageRates']);
    const roleId = await seedRole(firm.id, { permissions: ['matters.update'] });

    const res = await editor.api.put(`/api/lawfirms/${firm.id}/roles/${roleId}`)
      .send({ permissions: ['billing.manageRates'] });

    expect(res.status).toBe(200);
    expect(await permsOf(roleId)).toEqual(['billing.manageRates', 'billing.viewRates']);
  });

  it('still refuses viewRates for a caller who holds neither manageRates nor viewRates', async () => {
    const firm = await createFirm();
    const editor = await memberWith(firm.id, ['firm.manageRoles']);

    const res = await editor.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Rate reader', permissions: ['billing.viewRates'] });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      `select id from roles where law_firm_id = $1 and name = 'Rate reader'`, [firm.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('stores all three codes for a caller holding only manageInvoices who requests it', async () => {
    const firm = await createFirm();
    const editor = await memberWith(firm.id, ['firm.manageRoles', 'billing.manageInvoices']);

    const res = await editor.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Invoicer', permissions: ['billing.manageInvoices'] });

    expect(res.status).toBe(201);
    expect(await permsOf(res.body.roleId)).toEqual([
      'billing.manageInvoices', 'billing.viewInvoices', 'billing.viewRates',
    ]);
  });

  it('refuses a role carrying a code the caller lacks that nothing they hold implies, and writes nothing', async () => {
    const firm = await createFirm();
    const editor = await memberWith(firm.id, ['firm.manageRoles', 'billing.manageRates']);
    const roleId = await seedRole(firm.id, { permissions: ['matters.update'] });

    const updated = await editor.api.put(`/api/lawfirms/${firm.id}/roles/${roleId}`)
      .send({ permissions: ['billing.manageRates', 'billing.viewPlans'] });
    const created = await editor.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Mixed', permissions: ['billing.manageRates', 'billing.viewPlans'] });

    expect(updated.status).toBe(403);
    expect(created.status).toBe(403);
    expect(await permsOf(roleId)).toEqual(['matters.update']);
    const { rows } = await testPool.query(
      `select id from roles where law_firm_id = $1 and name = 'Mixed'`, [firm.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a read implied by a manage code the caller does not hold', async () => {
    const firm = await createFirm();
    const editor = await memberWith(firm.id, ['firm.manageRoles', 'billing.manageRates']);

    const res = await editor.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Plan editor', permissions: ['billing.managePlans'] });

    expect(res.status).toBe(403);
  });

  it('lets the owner store the implied reads unchanged', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Owner made', permissions: ['billing.manageInvoices', 'trust.manage'] });

    expect(res.status).toBe(201);
    expect(await permsOf(res.body.roleId)).toEqual([
      'billing.manageInvoices', 'trust.manage', 'billing.viewInvoices', 'billing.viewRates', 'trust.view',
    ]);
  });
});

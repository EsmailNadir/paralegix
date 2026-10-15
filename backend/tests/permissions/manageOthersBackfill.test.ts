/**
 * Migration 0025 carries `billing.manageOthersTimeEntries` onto every role that
 * could already keep time, so introducing the code changes nobody's behaviour
 * until a firm removes it from a role on purpose.
 *
 * The migration's SQL is read from the file and run against seeded role rows,
 * the way the operator's runner applies it.
 *
 * WHAT BREAKS EACH TEST:
 *  - widen the WHERE and a role that cannot keep time gains the code;
 *  - drop the `not ... any` guard and the second run appends it again, leaving
 *    a duplicate that a "remove from role" edit would only half undo;
 *  - narrow it to built-in roles and a firm's custom bookkeeper role silently
 *    loses the right to touch teammates' entries on the next deploy.
 */
import * as fs from 'fs';
import * as path from 'path';
import { testPool, createFirm, ownerOf } from '../support/setupInProcess';

const {
  ALL_PERMISSIONS, DEFAULT_PERMISSIONS, BUILT_IN_ROLES,
} = require('../../src/modules/lawfirms/roles/permissions');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '0025_backfill_manage_others_time_entries.sql'),
  'utf8',
);

const NEW = 'billing.manageOthersTimeEntries';

async function seedRole(lawFirmId: string, name: string, permissions: string[], isBuiltIn = false) {
  const { rows } = await testPool.query(
    `insert into roles (law_firm_id, name, is_built_in, permissions)
     values ($1, $2, $3, $4) returning id`,
    [lawFirmId, name, isBuiltIn, permissions],
  );
  return rows[0].id as string;
}

const permsOf = async (id: string) => {
  const { rows } = await testPool.query(`select permissions from roles where id = $1`, [id]);
  return rows[0].permissions as string[];
};

it('adds the code to roles holding manageTimeEntries, built-in or custom, and to no others', async () => {
  const firm = await createFirm();
  const custom = await seedRole(firm.id, 'Bookkeeper', ['billing.viewTimeEntries', 'billing.manageTimeEntries']);
  const builtIn = await seedRole(firm.id, 'Legacy Attorney', ['matters.view', 'billing.manageTimeEntries'], true);
  const viewOnly = await seedRole(firm.id, 'Viewer', ['billing.viewTimeEntries']);

  await testPool.query(SQL);

  expect(await permsOf(custom)).toEqual(['billing.viewTimeEntries', 'billing.manageTimeEntries', NEW]);
  expect(await permsOf(builtIn)).toContain(NEW);
  expect(await permsOf(viewOnly)).toEqual(['billing.viewTimeEntries']);
});

it('is idempotent, and leaves a role that already has the code with exactly one copy', async () => {
  const firm = await createFirm();
  const had = await seedRole(firm.id, 'Already', ['billing.manageTimeEntries', NEW]);
  const lacked = await seedRole(firm.id, 'Lacked', ['billing.manageTimeEntries']);

  await testPool.query(SQL);
  await testPool.query(SQL);

  expect(await permsOf(had)).toEqual(['billing.manageTimeEntries', NEW]);
  expect((await permsOf(lacked)).filter((p) => p === NEW)).toHaveLength(1);
});

describe('the permission catalog', () => {
  it('lists the code, keeps it out of the member baseline, and gives it to the roles that keep time', () => {
    expect(ALL_PERMISSIONS).toContain(NEW);
    // Financial access needs an explicit grant; a baseline code could never be
    // taken away from a role, which would defeat "own entries only".
    expect(DEFAULT_PERMISSIONS).not.toContain(NEW);
    const holders = Object.values(BUILT_IN_ROLES)
      .filter((role: any) => role.permissions.includes('billing.manageTimeEntries'))
      .map((role: any) => role.name);
    expect(holders.sort()).toEqual(['Admin', 'Attorney', 'Owner', 'Paralegal']);
    for (const role of Object.values(BUILT_IN_ROLES) as any[]) {
      expect(role.permissions.includes(NEW)).toBe(role.permissions.includes('billing.manageTimeEntries'));
    }
  });

  it('is accepted on a custom role through the roles route and stored with the reads it implies', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Own time only', permissions: ['billing.manageTimeEntries'] });
    expect(res.status).toBe(201);
    const withOthers = await owner.api.post(`/api/lawfirms/${firm.id}/roles`)
      .send({ name: 'Time lead', permissions: ['billing.manageTimeEntries', NEW] });

    expect(withOthers.status).toBe(201);
    const reads = ['billing.viewTimeEntries', 'billing.viewRates'];
    expect(await permsOf(res.body.roleId)).toEqual(['billing.manageTimeEntries', ...reads]);
    expect(await permsOf(withOthers.body.roleId)).toEqual(['billing.manageTimeEntries', NEW, ...reads]);
  });
});

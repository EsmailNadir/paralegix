/**
 * Migration 0026 gives every existing firm's built-in Paralegal role
 * `billing.viewPlans`, which the narrowed member baseline no longer supplies.
 *
 * The migration's SQL is read from the file and run against seeded role rows,
 * the way the operator's runner applies it.
 *
 * WHAT BREAKS EACH TEST:
 *  - drop the `is_built_in` filter and a firm's custom role named "Paralegal"
 *    gains a code its admin never granted;
 *  - drop the `name` filter and the built-in Staff role gains plan reads;
 *  - drop the `not ... any` guard and the second run appends a duplicate;
 *  - remove the code from the Paralegal definition and the catalog test fails.
 */
import * as fs from 'fs';
import * as path from 'path';
import { testPool, createFirm } from '../support/setupInProcess';

const { BUILT_IN_ROLES } = require('../../src/modules/lawfirms/roles/permissions');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '0026_backfill_paralegal_view_plans.sql'),
  'utf8',
);

const CODE = 'billing.viewPlans';

async function seedRole(lawFirmId: string, name: string, permissions: string[], isBuiltIn: boolean) {
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

it('adds the code to a built-in Paralegal role and touches no other role', async () => {
  const firm = await createFirm();
  const paralegal = await seedRole(firm.id, 'Paralegal', ['billing.viewTimeEntries'], true);
  const staff = await seedRole(firm.id, 'Staff', ['tasks.view'], true);
  // Role names are unique per firm, so a custom "Paralegal" lives in a firm
  // that has no built-in one.
  const otherFirm = await createFirm();
  const customSameName = await seedRole(otherFirm.id, 'Paralegal', ['tasks.view'], false);
  const customOther = await seedRole(firm.id, 'Bookkeeper', ['billing.viewTimeEntries'], false);

  await testPool.query(SQL);

  expect(await permsOf(paralegal)).toEqual(['billing.viewTimeEntries', CODE]);
  expect(await permsOf(staff)).toEqual(['tasks.view']);
  expect(await permsOf(customSameName)).toEqual(['tasks.view']);
  expect(await permsOf(customOther)).toEqual(['billing.viewTimeEntries']);
});

it('backfills every firm, and a second run changes nothing', async () => {
  const a = await createFirm();
  const b = await createFirm();
  const lacked = await seedRole(a.id, 'Paralegal', ['tasks.view'], true);
  const had = await seedRole(b.id, 'Paralegal', [CODE, 'tasks.view'], true);

  await testPool.query(SQL);
  const afterFirst = { lacked: await permsOf(lacked), had: await permsOf(had) };
  await testPool.query(SQL);

  expect(afterFirst.lacked).toEqual(['tasks.view', CODE]);
  expect(afterFirst.had).toEqual([CODE, 'tasks.view']);
  expect(await permsOf(lacked)).toEqual(afterFirst.lacked);
  expect(await permsOf(had)).toEqual(afterFirst.had);
});

it('the catalog gives billing.viewPlans to Paralegal and not to Staff', () => {
  expect(BUILT_IN_ROLES.paralegal.permissions).toContain(CODE);
  expect(BUILT_IN_ROLES.staff.permissions).not.toContain(CODE);
});

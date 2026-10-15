/**
 * Migration 0027 carries the reads each manage code implies onto every role that
 * already holds the manage code, so roles saved before the rule existed stop
 * 403ing on the screens they can edit.
 *
 * The migration's SQL is read from the file and run against seeded role rows,
 * the way the operator's runner applies it.
 *
 * WHAT BREAKS EACH TEST:
 *  - widen a WHERE and a role with no related manage code gains a read;
 *  - drop a `not ... any` style guard and the second run appends again;
 *  - narrow to built-in roles and a firm's custom role keeps its 403;
 *  - add or remove a pair in MANAGE_IMPLIES_VIEW without regenerating the SQL
 *    and the drift test names the pair that differs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { testPool, createFirm } from '../support/setupInProcess';

const {
  MANAGE_IMPLIES_VIEW, withImpliedViewPermissions, BUILT_IN_ROLES,
} = require('../../src/modules/lawfirms/roles/permissions');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '0027_manage_implies_view_backfill.sql'),
  'utf8',
);

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

it('gives a role with manageTimeEntries the time entry and rate reads, after its own codes', async () => {
  const firm = await createFirm();
  const custom = await seedRole(firm.id, 'Timekeeper', ['matters.update', 'billing.manageTimeEntries']);

  await testPool.query(SQL);

  expect(await permsOf(custom)).toEqual([
    'matters.update', 'billing.manageTimeEntries', 'billing.viewTimeEntries', 'billing.viewRates',
  ]);
});

it('adds only the reads a role is missing and never a second copy', async () => {
  const firm = await createFirm();
  const partial = await seedRole(firm.id, 'Partial', ['billing.viewRates', 'billing.manageTimeEntries']);

  await testPool.query(SQL);

  expect(await permsOf(partial)).toEqual(['billing.viewRates', 'billing.manageTimeEntries', 'billing.viewTimeEntries']);
});

it('reaches built-in and custom roles alike', async () => {
  const firm = await createFirm();
  const builtIn = await seedRole(firm.id, 'Legacy Attorney', ['trust.manage'], true);
  const custom = await seedRole(firm.id, 'Trust clerk', ['trust.reconcile']);

  await testPool.query(SQL);

  expect(await permsOf(builtIn)).toEqual(['trust.manage', 'trust.view']);
  expect(await permsOf(custom)).toEqual(['trust.reconcile', 'trust.view']);
});

it('leaves a role holding only reads unchanged', async () => {
  const firm = await createFirm();
  const reads = ['billing.viewTimeEntries', 'billing.viewInvoices', 'trust.view'];
  const viewer = await seedRole(firm.id, 'Viewer', reads);

  await testPool.query(SQL);

  expect(await permsOf(viewer)).toEqual(reads);
});

it('leaves a role with no billing or trust code unchanged', async () => {
  const firm = await createFirm();
  const codes = ['matters.update', 'tasks.create', 'clients.manage'];
  const role = await seedRole(firm.id, 'Matters only', codes);
  const empty = await seedRole(firm.id, 'Empty', []);

  await testPool.query(SQL);

  expect(await permsOf(role)).toEqual(codes);
  expect(await permsOf(empty)).toEqual([]);
});

it('leaves a Staff-shaped role unchanged', async () => {
  const firm = await createFirm();
  const staff = await seedRole(firm.id, 'Staff', BUILT_IN_ROLES.staff.permissions, true);

  await testPool.query(SQL);

  expect(await permsOf(staff)).toEqual(BUILT_IN_ROLES.staff.permissions);
});

it('does not touch the updated_at of a role it did not change', async () => {
  const firm = await createFirm();
  const id = await seedRole(firm.id, 'Untouched', ['matters.update']);
  const { rows: before } = await testPool.query(`select updated_at from roles where id = $1`, [id]);

  await testPool.query(SQL);

  const { rows: after } = await testPool.query(`select updated_at from roles where id = $1`, [id]);
  expect(after[0].updated_at).toEqual(before[0].updated_at);
});

it('is idempotent: a second run changes no row', async () => {
  const firm = await createFirm();
  const ids = [
    await seedRole(firm.id, 'A', ['billing.manageInvoices', 'billing.recordPayments']),
    await seedRole(firm.id, 'B', ['billing.managePlans', 'billing.manageExpenses', 'billing.manageRates']),
    await seedRole(firm.id, 'C', ['billing.manageTimeEntries', 'billing.viewTimeEntries', 'billing.viewRates']),
  ];

  await testPool.query(SQL);
  const first = await Promise.all(ids.map(permsOf));
  const { rows: stamp } = await testPool.query(`select id, updated_at from roles where id = any($1)`, [ids]);
  await testPool.query(SQL);

  expect(await Promise.all(ids.map(permsOf))).toEqual(first);
  const { rows: after } = await testPool.query(`select id, updated_at from roles where id = any($1)`, [ids]);
  expect(after).toEqual(stamp);
});

it('gives every role exactly what withImpliedViewPermissions gives it, for every single manage code', async () => {
  const firm = await createFirm();
  const cases = Object.keys(MANAGE_IMPLIES_VIEW).map((manage) => [manage, ['matters.view', manage]] as const);
  const ids = await Promise.all(cases.map(([manage, codes]) => seedRole(firm.id, `Only ${manage}`, [...codes])));

  await testPool.query(SQL);

  for (let i = 0; i < cases.length; i++) {
    expect(await permsOf(ids[i])).toEqual(withImpliedViewPermissions([...cases[i][1]]));
  }
});

it('agrees with the manage-to-view map: the SQL names exactly the pairs the code lists', () => {
  const body = SQL.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const statements = body.split(';').map((s) => s.trim()).filter(Boolean);
  const fromSql: Record<string, string[]> = {};
  for (const stmt of statements) {
    const manage = /where\s+'([^']+)'\s*=\s*any\s*\(\s*permissions\s*\)/i.exec(stmt)?.[1];
    const views = /array\[([^\]]*)\]/i.exec(stmt)?.[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
    expect(manage).toBeTruthy();
    expect(views?.length).toBeGreaterThan(0);
    fromSql[manage as string] = views as string[];
  }

  expect(fromSql).toEqual(MANAGE_IMPLIES_VIEW);
  expect(Object.keys(fromSql)).toEqual(Object.keys(MANAGE_IMPLIES_VIEW));
});

it('declares itself an expand migration', () => {
  expect(SQL.split('\n')[0]).toBe('-- migration-mode: expand');
});

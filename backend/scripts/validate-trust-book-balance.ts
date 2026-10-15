// Inspect and (when safe) validate the trust_accounts_book_balance_nonneg CHECK,
// with an optional cleanup of negative-balance TEST accounts.
//
//   npx tsx backend/scripts/validate-trust-book-balance.ts          # inspect; validate if already clean
//   npx tsx backend/scripts/validate-trust-book-balance.ts --fix     # delete negative test accounts, then validate
//
// The constraint was added NOT VALID (migration 0080): it enforces every NEW
// write but never checked pre-existing rows. `VALIDATE` only succeeds when no
// account has a negative stored book balance.
//
// --fix removes negative-balance accounts that are clearly test data (name in the
// allowlist below) plus their transactions and reconciliations, then validates.
// It ABORTS if any negative account is NOT in the allowlist, so it can never
// delete a real firm's trust account. Transactions are append-only (a DB trigger
// blocks deleting `completed` rows), so they are first transitioned to `void`
// (the one UPDATE the trigger permits) and then deleted — no superuser, no
// trigger-disabling required.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
// DB_TARGET picks DATABASE_URL_LOCAL / _STAGING / _PROD, falling back to DATABASE_URL,
// the same way the server does. TLS only for a hosted database.
const { resolveDbUrl, needsSsl } = require('../src/shared/database/resolveDbUrl');

// Account names that only ever come from automated test / verify runs.
const TEST_ACCOUNT_NAMES = ['IOLTA Test', 'VERIFY'];

const fmt = (cents: any) => `$${(Number(cents) / 100).toFixed(2)}`;
const doFix = process.argv.includes('--fix');

async function validate(c: any) {
  await c.query('alter table trust_accounts validate constraint trust_accounts_book_balance_nonneg');
  const { rows } = await c.query(
    `select convalidated from pg_constraint where conname = 'trust_accounts_book_balance_nonneg'`);
  console.log(`trust_accounts_book_balance_nonneg validated = ${rows[0]?.convalidated}`);
}

(async () => {
  const connectionString = resolveDbUrl();
  if (!connectionString) { console.error('No database URL: set DB_TARGET and DATABASE_URL_<TARGET>, or DATABASE_URL (backend/.env).'); process.exit(1); }
  console.log(`Database: ${process.env.DB_TARGET || 'DATABASE_URL (DB_TARGET unset)'}`);
  const c = new Client({ connectionString, ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined });
  await c.connect();

  const { rows: negs } = await c.query(`
    select a.id, a.name as account_name, a.book_balance_cents, lf.name as firm_name,
           (select count(*) from trust_transactions t where t.trust_account_id = a.id)::int as txn_count
      from trust_accounts a
      join law_firms lf on lf.id = a.law_firm_id
     where a.book_balance_cents < 0
     order by a.book_balance_cents asc`);

  if (negs.length === 0) {
    console.log('No negative-balance accounts. Validating constraint...');
    await validate(c);
    await c.end();
    return;
  }

  console.log(`${negs.length} account(s) have a negative book balance:`);
  for (const r of negs) {
    console.log(`  ${fmt(r.book_balance_cents).padStart(12)}  ${r.firm_name} — ${r.account_name}  (${r.txn_count} txns)  [${r.id}]`);
  }

  if (!doFix) {
    console.log('\nRun with --fix to delete the test accounts above, then validate.');
    console.log('(The constraint already enforces all NEW writes; this is optional cleanup.)');
    await c.end();
    return;
  }

  // Safety: refuse to delete anything that is not recognizably test data.
  const nonTest = negs.filter((r: any) => !TEST_ACCOUNT_NAMES.includes(r.account_name));
  if (nonTest.length > 0) {
    console.error(`\nABORTED: ${nonTest.length} negative account(s) are NOT in the test allowlist `
      + `(${TEST_ACCOUNT_NAMES.join(', ')}). Refusing to delete real data:`);
    for (const r of nonTest) console.error(`  ${r.firm_name} — ${r.account_name} [${r.id}]`);
    await c.end();
    process.exit(1);
  }

  const ids = negs.map((r: any) => r.id);
  console.log(`\nDeleting ${ids.length} test account(s) + their transactions/reconciliations...`);
  try {
    await c.query('begin');
    // Append-only trigger blocks DELETE of `completed` rows but permits the
    // completed→void transition; flip to void first, then delete.
    const voided = await c.query(
      `update trust_transactions set status = 'void'
        where trust_account_id = any($1::uuid[]) and status <> 'void'`, [ids]);
    const recs = await c.query(
      `delete from trust_reconciliations where trust_account_id = any($1::uuid[])`, [ids]);
    const txns = await c.query(
      `delete from trust_transactions where trust_account_id = any($1::uuid[])`, [ids]);
    const accts = await c.query(
      `delete from trust_accounts where id = any($1::uuid[])`, [ids]);
    await c.query('commit');
    console.log(`Deleted: ${accts.rowCount} accounts, ${txns.rowCount} transactions `
      + `(${voided.rowCount} voided first), ${recs.rowCount} reconciliations.`);
  } catch (e) {
    await c.query('rollback');
    throw e;
  }

  console.log('\nValidating constraint...');
  await validate(c);
  await c.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};

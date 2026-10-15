#!/usr/bin/env node

// Remediation report: trust deposits that were collected electronically BEFORE the
// per-trust-account connected-account routing existed. Those deposits (source in
// 'stripe'/'ach' with a Stripe payment reference) settled into the firm's OPERATING
// Stripe account, not a trust bank account — they are recorded correctly in the
// ledger but the physical funds landed in operating and must be moved to the trust
// bank account by each firm.
//
// This script only REPORTS. It moves no money and changes no data. Each affected
// firm must transfer the listed amount operating -> trust at the bank and record it.
//
//   npx tsx backend/scripts/report-stripe-trust-deposits.ts          # human-readable
//   npx tsx backend/scripts/report-stripe-trust-deposits.ts --json   # machine-readable

const { pool } = require('../src/shared/database/db');

function centsToUsd(cents: any) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

async function main() {
  const asJson = process.argv.slice(2).includes('--json');

  const { rows } = await pool.query(
    `select t.law_firm_id,
            lf.name              as firm_name,
            t.trust_account_id,
            ta.name              as trust_account_name,
            t.id                 as trust_transaction_id,
            t.client_id,
            cl.name              as client_name,
            t.amount_cents,
            t.txn_date,
            t.stripe_session_id,
            t.stripe_payment_intent_id
       from trust_transactions t
       join law_firms      lf on lf.id = t.law_firm_id
       left join trust_accounts ta on ta.id = t.trust_account_id
       left join clients   cl on cl.id = t.client_id
      where t.type = 'deposit'
        and t.status <> 'void'
        and t.source in ('stripe', 'ach')
        and (t.stripe_session_id is not null or t.stripe_payment_intent_id is not null)
      order by t.law_firm_id, t.txn_date`,
  );

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No electronically-collected trust deposits found. Nothing to remediate.');
    return;
  }

  const byFirm = new Map();
  for (const r of rows) {
    if (!byFirm.has(r.law_firm_id)) byFirm.set(r.law_firm_id, { name: r.firm_name, rows: [], totalCents: 0 });
    const bucket = byFirm.get(r.law_firm_id);
    bucket.rows.push(r);
    bucket.totalCents += Number(r.amount_cents || 0);
  }

  console.log('Electronically-collected trust deposits that settled into OPERATING funds');
  console.log('(each firm must transfer the total operating -> trust bank and record it)\n');

  let grandTotal = 0;
  for (const [firmId, bucket] of byFirm) {
    grandTotal += bucket.totalCents;
    console.log(`Firm: ${bucket.name || '(unnamed)'}  [${firmId}]`);
    console.log(`  Total to move to trust: ${centsToUsd(bucket.totalCents)} across ${bucket.rows.length} deposit(s)`);
    for (const r of bucket.rows) {
      const ref = r.stripe_payment_intent_id || r.stripe_session_id || '';
      console.log(`    ${r.txn_date}  ${centsToUsd(r.amount_cents).padStart(12)}  `
        + `${(r.trust_account_name || r.trust_account_id)}  `
        + `client=${r.client_name || r.client_id || '-'}  ${ref}`);
    }
    console.log('');
  }
  console.log(`Grand total across all firms: ${centsToUsd(grandTotal)}`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('report-stripe-trust-deposits failed:', err);
    pool.end();
    process.exit(1);
  });

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};

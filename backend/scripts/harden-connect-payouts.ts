#!/usr/bin/env node

'use strict';

/**
 * Backfill Stripe Connect payout hardening onto EXISTING connected accounts.
 *
 * WHY: payout hardening (a payout-schedule delay + debit_negative_balances) is
 * applied automatically only at onboarding (createConnectAccount /
 * createTrustConnectAccount in stripe.service.js). Accounts connected before that
 * change have no payout delay, so the automatic fund recovery gated by
 * STRIPE_AUTO_RECOVERY_ENABLED often can't reverse a disputed / returned charge —
 * the funds have already paid out to the firm's bank. This applies the same
 * settings to every existing connected account so recovery works for them too.
 *
 * WHAT: for each firm OPERATING account (law_firms.stripe_account_id) sets a payout
 * delay + debit_negative_balances=true; for each TRUST connected account
 * (trust_accounts.stripe_connected_account_id) sets the delay only and
 * debit_negative_balances=false — a trust account's bank is an IOLTA holding client
 * money and must never be auto-debited.
 *
 * SAFETY: idempotent (re-applying the same settings is a no-op), additive, never
 * moves money and never touches the ledger. Run --dry-run first. A per-account
 * failure (e.g. an account that never finished onboarding) is reported and skipped,
 * not fatal.
 *
 * USAGE (operator-run, not scheduled):
 *   npx tsx backend/scripts/harden-connect-payouts.ts --dry-run
 *   npx tsx backend/scripts/harden-connect-payouts.ts
 *   npx tsx backend/scripts/harden-connect-payouts.ts --only=operating
 *   npx tsx backend/scripts/harden-connect-payouts.ts --only=trust
 *
 * It hardens the connected accounts of whichever environment DATABASE_URL /
 * DB_TARGET points at, using that environment's STRIPE_SECRET_KEY (test vs live).
 * To harden staging's accounts, run with the staging DB + staging (test-mode) key.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool } = require('../src/shared/database/db');
const stripeService = require('../src/modules/stripe/stripe.service');

function parseArgs(argv: any) {
  const args = { dryRun: false, only: 'all' };
  argv.forEach((arg: any) => {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--only=')) args.only = arg.split('=')[1];
  });
  return args;
}

async function loadOperatingAccounts() {
  const { rows } = await pool.query(
    `select id as law_firm_id, stripe_account_id
       from law_firms
      where stripe_account_id is not null
      order by id`,
  );
  return rows;
}

async function loadTrustAccounts() {
  const { rows } = await pool.query(
    `select id, law_firm_id, stripe_connected_account_id
       from trust_accounts
      where stripe_connected_account_id is not null
      order by law_firm_id, id`,
  );
  return rows;
}

async function harden(kind: any, accountId: any, trust: any, summary: any, dryRun: any) {
  if (dryRun) {
    console.log(`[dry-run] would harden ${kind} account ${accountId} (trust=${trust})`);
    summary.wouldUpdate += 1;
    return;
  }
  try {
    await stripeService.updateConnectPayoutSettings(accountId, { trust });
    console.log(`hardened ${kind} account ${accountId}`);
    summary.updated += 1;
  } catch (err: any) {
    console.error(`FAILED ${kind} account ${accountId}: ${err.message}`);
    summary.failures.push({ kind, accountId, error: err.message });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = { updated: 0, wouldUpdate: 0, failures: [] as any[] };

  if (args.only === 'all' || args.only === 'operating') {
    try {
      const ops = await loadOperatingAccounts();
      console.log(`operating accounts: ${ops.length}`);
      for (const row of ops) {
        await harden('operating', row.stripe_account_id, false, summary, args.dryRun);
      }
    } catch (err: any) {
      console.error(`FAILED to load operating accounts: ${err.message}`);
      summary.failures.push({ kind: 'operating', accountId: null, error: err.message });
    }
  }

  if (args.only === 'all' || args.only === 'trust') {
    try {
      const trusts = await loadTrustAccounts();
      console.log(`trust connected accounts: ${trusts.length}`);
      for (const row of trusts) {
        await harden('trust', row.stripe_connected_account_id, true, summary, args.dryRun);
      }
    } catch (err: any) {
      // e.g. an older DB without the trust-Connect columns (migration 0092).
      // Report and continue rather than aborting the whole run.
      console.error(`FAILED to load trust connected accounts: ${err.message}`);
      summary.failures.push({ kind: 'trust', accountId: null, error: err.message });
    }
  }

  console.log('---');
  console.log(JSON.stringify(summary, null, 2));
  await pool.end();
  if (summary.failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('harden-connect-payouts failed:', err);
  process.exit(1);
});

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};

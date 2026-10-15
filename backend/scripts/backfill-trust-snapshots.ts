//
// Backfill / repair the trust-ledger running-balance snapshots.
//
// Each trust_transactions row carries two stored running-balance snapshots:
//   account_balance_after_cents  — the account book balance after this row
//   client_balance_after_cents   — the (account, client) balance after this row
// and each trust_accounts row carries book_balance_cents (the account running
// total). Historically these were written at insert time only and could drift
// from the true ledger (e.g. earlier buggy code, or partial updates). Because
// the read path is moving from re-SUMming the whole ledger to reading the
// latest non-void snapshot, the snapshots must first be made internally
// consistent with the actual transaction history.
//
// This script recomputes, deterministically per account and per (account,
// client), the running balance over rows ordered by (created_at, id):
//   - Only NON-VOID rows move the running balance: deposit = +amount, every
//     other type = -amount (matching balanceExpr in trust.repository.js).
//   - A non-void row's snapshot is set to the running balance AFTER applying it.
//   - A void row does not move the running balance; its snapshot is set to the
//     current running balance at its position (post-reversal for a reversing
//     row, pre-/unchanged otherwise). Void rows are excluded from every balance
//     read, so this value is audit-only and never feeds the parity check.
//   - trust_accounts.book_balance_cents is set to the final account running
//     total (the latest non-void account snapshot), so the stored book balance
//     equals the ledger.
//
// Usage: npx tsx backend/scripts/backfill-trust-snapshots.ts
//
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
// DB_TARGET picks DATABASE_URL_LOCAL / _STAGING / _PROD, falling back to DATABASE_URL,
// the same way the server does. TLS only for a hosted database.
const { resolveDbUrl, needsSsl } = require('../src/shared/database/resolveDbUrl');

const delta = (type: any, amount: any) => (type === 'deposit' ? amount : -amount);

(async () => {
  const connectionString = resolveDbUrl();
  if (!connectionString) { console.error('No database URL: set DB_TARGET and DATABASE_URL_<TARGET>, or DATABASE_URL (backend/.env).'); process.exit(1); }
  console.log(`Database: ${process.env.DB_TARGET || 'DATABASE_URL (DB_TARGET unset)'}`);
  const c = new Client({ connectionString, ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  await c.query('begin');
  try {
    const { rows: accounts } = await c.query(
      `select id, law_firm_id from trust_accounts order by law_firm_id, id`
    );

    let txnUpdates = 0;
    let acctUpdates = 0;
    const drifts = [];

    for (const acc of accounts) {
      const { rows: txns } = await c.query(
        `select id, type, amount_cents, client_id, status,
                account_balance_after_cents, client_balance_after_cents
           from trust_transactions
          where law_firm_id = $1 and trust_account_id = $2
          order by created_at, id`,
        [acc.law_firm_id, acc.id]
      );

      let acctRunning = 0;             // account running balance (non-void only)
      const clientRunning = new Map(); // client_id -> running balance (non-void only)

      for (const t of txns) {
        const amt = Number(t.amount_cents);
        const isVoid = t.status === 'void';
        const cliKey = t.client_id || '__null__';

        let acctSnap;
        let cliSnap;
        if (isVoid) {
          // Void rows do not move the running balance; snapshot the current
          // (post-reversal) running totals for audit readability.
          acctSnap = acctRunning;
          cliSnap = clientRunning.get(cliKey) || 0;
        } else {
          acctRunning += delta(t.type, amt);
          const cliBefore = clientRunning.get(cliKey) || 0;
          const cliAfter = cliBefore + delta(t.type, amt);
          clientRunning.set(cliKey, cliAfter);
          acctSnap = acctRunning;
          cliSnap = cliAfter;
        }

        if (Number(t.account_balance_after_cents) !== acctSnap ||
            Number(t.client_balance_after_cents) !== cliSnap) {
          await c.query(
            `update trust_transactions
                set account_balance_after_cents = $3, client_balance_after_cents = $4
              where law_firm_id = $1 and id = $2`,
            [acc.law_firm_id, t.id, acctSnap, cliSnap]
          );
          txnUpdates++;
        }
      }

      // Repair the account's stored book balance to equal the ledger.
      const { rows: accRow } = await c.query(
        `select book_balance_cents from trust_accounts where law_firm_id = $1 and id = $2`,
        [acc.law_firm_id, acc.id]
      );
      const stored = Number(accRow[0].book_balance_cents);
      if (stored !== acctRunning) {
        drifts.push({ accountId: acc.id, stored, recomputed: acctRunning });
        await c.query(
          `update trust_accounts set book_balance_cents = $3 where law_firm_id = $1 and id = $2`,
          [acc.law_firm_id, acc.id, acctRunning]
        );
        acctUpdates++;
      }
    }

    await c.query('commit');
    console.log(`Backfill complete. accounts=${accounts.length} txnSnapshotsUpdated=${txnUpdates} accountBookBalancesRepaired=${acctUpdates}`);
    if (drifts.length) {
      console.log('Repaired account book-balance drift:');
      for (const d of drifts) console.log(`  account ${d.accountId}: stored=${d.stored} -> recomputed=${d.recomputed}`);
    } else {
      console.log('No account book-balance drift found.');
    }
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};

import { testPool } from './db';

/**
 * Resolve once another connection in this worker's database is blocked acquiring
 * a row lock on `invoices` (a `select ... for update`). Matching the blocked
 * statement, not just any Lock wait, stops an unrelated waiter from releasing
 * the caller before the request under test has actually queued.
 */
export async function waitForInvoiceLockWaiter(neverBlockedMessage: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await testPool.query(
      `select 1 from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query ilike '%from invoices %for update%'`,
    );
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(neverBlockedMessage);
}

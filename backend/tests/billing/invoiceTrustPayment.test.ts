/**
 * Paying an invoice from a client's trust account.
 *
 * This path spans two modules that each own a transaction: `recordPayment` locks
 * the invoice row with `select ... for update`, and the trust withdrawal it
 * issues writes a `trust_transactions` row whose `invoice_id` foreign key needs
 * a key-share lock on that same row. Nothing covered a SUCCESSFUL payment here,
 * which is how the two locks came to deadlock against each other unnoticed: the
 * request waited out the statement timeout and answered 500.
 *
 * So the first case below is the one that matters, and it is deliberately the
 * plainest possible request. If the two writes ever stop sharing one
 * transaction, it goes red by timing out rather than by asserting a subtlety.
 *
 * The rest pin what sharing a transaction must NOT cost: the overdraft guard,
 * the over-payment guard, and all-or-nothing behaviour across both tables.
 */
import {
  testPool,
  createFirm,
  createInvoice,
  createPersonClient,
  createTrustDeposit,
  ownerOf,
  drainEvents,
  type Actor,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');

const DEPOSITED_CENTS = 500_000;

async function seedWorld() {
  const firm = await createFirm({ planId: 'enterprise' });
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Marsh Holdings' });
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 50_000 });
  const { accountId } = await createTrustDeposit(firm.id, client.id, {
    amountCents: DEPOSITED_CENTS,
  });
  return { firm, owner, client, invoice, accountId };
}

const paymentUrl = (firmId: string, clientId: string, invoiceId: string) =>
  `/api/lawfirms/${firmId}/billing/invoices/client/${clientId}/${invoiceId}/payment`;

const payFromTrust = (
  owner: Actor,
  firmId: string,
  clientId: string,
  invoiceId: string,
  accountId: string,
  dollars = 100,
) => owner.api
  .put(paymentUrl(firmId, clientId, invoiceId))
  .send({ paymentAmount: dollars, paymentSource: 'trust', trustAccountId: accountId });

/** Every withdrawal row on this firm's ledger, newest first. */
async function withdrawals(lawFirmId: string) {
  const { rows } = await testPool.query(
    `select id, amount_cents, client_id, invoice_id, status, reverses_transaction_id
       from trust_transactions
      where law_firm_id = $1 and type = 'withdrawal'
      order by created_at desc`,
    [lawFirmId],
  );
  return rows;
}

async function invoiceRow(invoiceId: string) {
  const { rows } = await testPool.query(
    `select amount_paid_cents, status from invoices where id = $1`,
    [invoiceId],
  );
  return rows[0];
}

/** Payment entries are a child table, not a column on the invoice. */
async function paymentRows(invoiceId: string) {
  const { rows } = await testPool.query(
    `select amount_cents, payment_source, trust_transaction_id, trust_account_id
       from invoice_payments where invoice_id = $1 order by sort_order`,
    [invoiceId],
  );
  return rows;
}

/** The client's trust balance, by the ledger's own definition of balance. */
async function clientBalanceCents(lawFirmId: string, clientId: string) {
  const { rows } = await testPool.query(
    `select coalesce(sum(case when status = 'completed'
              then (case when type = 'deposit' then amount_cents else -amount_cents end)
              else 0 end), 0)::bigint as balance
       from trust_transactions
      where law_firm_id = $1 and client_id = $2`,
    [lawFirmId, clientId],
  );
  return Number(rows[0].balance);
}

describe('paying an invoice from trust', () => {
  describe('the happy path', () => {
    it('answers 200 promptly instead of deadlocking until the statement timeout', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();

      const startedAt = Date.now();
      const res = await payFromTrust(owner, firm.id, client.id, invoice.id, accountId);
      const elapsedMs = Date.now() - startedAt;

      expect(res.status).toBe(200);
      // The deadlock did not fail fast: it blocked until Postgres cancelled the
      // statement, about 30 seconds. A generous ceiling still separates the two
      // outcomes by an order of magnitude, and keeps this from flaking on a
      // loaded machine.
      expect(elapsedMs).toBeLessThan(10_000);
    });

    it('records the payment on the invoice', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();

      await payFromTrust(owner, firm.id, client.id, invoice.id, accountId);

      expect(Number((await invoiceRow(invoice.id)).amount_paid_cents)).toBe(10_000);

      // The payment entry has to carry the link back to the ledger, or the
      // reversal path on a deleted payment has nothing to void.
      const entries = await paymentRows(invoice.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].payment_source).toBe('trust');
      expect(entries[0].trust_account_id).toBe(accountId);
      expect(entries[0].trust_transaction_id).toEqual(expect.any(String));
    });

    it('writes exactly one withdrawal, linked to the invoice and the client', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();

      await payFromTrust(owner, firm.id, client.id, invoice.id, accountId);

      const rows = await withdrawals(firm.id);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount_cents)).toBe(10_000);
      expect(rows[0].client_id).toBe(client.id);
      expect(rows[0].invoice_id).toBe(invoice.id);
      expect(rows[0].status).toBe('completed');
    });

    it('reduces the client trust balance by the amount paid', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();

      await payFromTrust(owner, firm.id, client.id, invoice.id, accountId);

      expect(await clientBalanceCents(firm.id, client.id)).toBe(DEPOSITED_CENTS - 10_000);
    });

    it('keeps the account book balance in step with the ledger', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();

      await payFromTrust(owner, firm.id, client.id, invoice.id, accountId);

      const { rows } = await testPool.query(
        `select book_balance_cents from trust_accounts where id = $1`, [accountId],
      );
      // The book balance is maintained by the same locked write as the ledger
      // row. A withdrawal that rolled back only one of the two would show here.
      expect(Number(rows[0].book_balance_cents)).toBe(DEPOSITED_CENTS - 10_000);
    });

    it('marks the invoice paid when trust covers the whole balance', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();

      // The invoice total is 50,000 cents, so 500 dollars settles it exactly.
      const res = await payFromTrust(owner, firm.id, client.id, invoice.id, accountId, 500);

      expect(res.status).toBe(200);
      const row = await invoiceRow(invoice.id);
      expect(Number(row.amount_paid_cents)).toBe(50_000);
      expect(row.status).toBe('paid');
    });
  });

  describe('all or nothing across both tables', () => {
    it('leaves no withdrawal behind when the invoice write fails after it', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();
      // Fail the invoice UPDATE, which runs after the withdrawal inside the same
      // transaction. This is the ordering the old compensating-void block
      // existed to paper over; sharing one transaction makes the rollback do it.
      const gate = gateMethod(invoicesRepo, '_applyUpdateLocked');
      gate.failNext(new Error('injected: invoice update failed'));

      try {
        const startedAt = Date.now();
        const res = await payFromTrust(owner, firm.id, client.id, invoice.id, accountId);
        expect(res.status).toBe(500);
        // Fast, so this case cannot pass by way of the deadlock: on separate
        // connections the withdrawal never completes either, which would leave
        // the ledger empty for the wrong reason and make the assertions below
        // meaningless.
        expect(Date.now() - startedAt).toBeLessThan(10_000);
      } finally {
        gate.restore();
      }

      // Neither half may survive. A withdrawal left behind (even a voided one)
      // means client money left the ledger for an invoice that was never paid.
      expect(await withdrawals(firm.id)).toHaveLength(0);
      expect(await clientBalanceCents(firm.id, client.id)).toBe(DEPOSITED_CENTS);
      expect(Number((await invoiceRow(invoice.id)).amount_paid_cents)).toBe(0);
    });

    it('leaves the account book balance untouched on that rollback', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();
      const gate = gateMethod(invoicesRepo, '_applyUpdateLocked');
      gate.failNext(new Error('injected: invoice update failed'));

      try {
        await payFromTrust(owner, firm.id, client.id, invoice.id, accountId);
      } finally {
        gate.restore();
      }

      const { rows } = await testPool.query(
        `select book_balance_cents from trust_accounts where id = $1`, [accountId],
      );
      expect(Number(rows[0].book_balance_cents)).toBe(DEPOSITED_CENTS);
    });
  });

  describe('the guards still fire under the shared transaction', () => {
    it('refuses to overdraw the trust account and records nothing', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();
      // Lower the deposit so the invoice total exceeds it, and the refusal is
      // the overdraft guard rather than the over-payment guard.
      await testPool.query(
        `update invoices set total_cents = 900000 where id = $1`, [invoice.id],
      );

      const res = await payFromTrust(owner, firm.id, client.id, invoice.id, accountId, 6_000);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INSUFFICIENT_TRUST_BALANCE');
      expect(await withdrawals(firm.id)).toHaveLength(0);
      expect(Number((await invoiceRow(invoice.id)).amount_paid_cents)).toBe(0);
    });

    it('rejects an over-payment before touching the ledger', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();

      // 900 dollars against a 500 dollar invoice. The over-payment guard runs
      // ahead of the withdrawal on purpose, so the ledger must be untouched.
      const res = await payFromTrust(owner, firm.id, client.id, invoice.id, accountId, 900);

      expect(res.status).toBe(400);
      expect(await withdrawals(firm.id)).toHaveLength(0);
      expect(await clientBalanceCents(firm.id, client.id)).toBe(DEPOSITED_CENTS);
    });

    it('refuses a trust account belonging to another firm', async () => {
      const { firm, owner, client, invoice } = await seedWorld();
      const other = await createFirm({ planId: 'enterprise' });
      const otherClient = await createPersonClient(other.id);
      const { accountId: foreignAccount } = await createTrustDeposit(other.id, otherClient.id);

      const res = await payFromTrust(owner, firm.id, client.id, invoice.id, foreignAccount);

      expect(res.status).toBe(404);
      expect(await withdrawals(other.id)).toHaveLength(0);
    });
  });

  describe('reversing a trust-funded payment', () => {
    it('voids the linked withdrawal and restores the balance', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();
      await payFromTrust(owner, firm.id, client.id, invoice.id, accountId);
      expect(await clientBalanceCents(firm.id, client.id)).toBe(DEPOSITED_CENTS - 10_000);

      const res = await owner.api
        .delete(`${paymentUrl(firm.id, client.id, invoice.id)}?paymentIndex=0`);

      expect(res.status).toBe(200);
      await drainEvents();

      // The ledger is append-only, so a void does two things: it marks the
      // original void AND posts a linked reversing entry. Both carry status
      // 'void', so neither contributes to a balance.
      const rows = await withdrawals(firm.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((r: any) => r.status === 'void')).toBe(true);
      const original = rows.find((r: any) => !r.reverses_transaction_id);
      const reversal = rows.find((r: any) => r.reverses_transaction_id);
      expect(original).toBeDefined();
      expect(reversal!.reverses_transaction_id).toBe(original!.id);

      // What actually matters to the client: the money is back.
      expect(await clientBalanceCents(firm.id, client.id)).toBe(DEPOSITED_CENTS);
    });
  });

  describe('marking a trust-paid invoice unpaid', () => {
    it('voids every trust withdrawal behind it and gives the client the money back', async () => {
      // Resetting to unpaid clears every payment on the invoice. A trust-funded
      // one left its withdrawal standing would keep the client's trust balance
      // short AND leave the invoice payable from trust again: the same money
      // spent twice.
      const { firm, owner, client, invoice, accountId } = await seedWorld();
      expect((await payFromTrust(owner, firm.id, client.id, invoice.id, accountId, 100.01)).status).toBe(200);
      expect((await payFromTrust(owner, firm.id, client.id, invoice.id, accountId, 150)).status).toBe(200);
      expect((await owner.api.put(paymentUrl(firm.id, client.id, invoice.id))
        .send({ paymentAmount: 50, paymentSource: 'external' })).status).toBe(200);
      expect(await clientBalanceCents(firm.id, client.id)).toBe(DEPOSITED_CENTS - 25_001);
      expect(Number((await invoiceRow(invoice.id)).amount_paid_cents)).toBe(30_001);

      const res = await owner.api.put(paymentUrl(firm.id, client.id, invoice.id)).send({ isPaid: false });

      expect(res.status).toBe(200);
      await drainEvents();
      expect(await invoiceRow(invoice.id)).toEqual({ amount_paid_cents: '0', status: 'outstanding' });
      expect(await paymentRows(invoice.id)).toEqual([]);
      const rows = await withdrawals(firm.id);
      // Two originals, each voided, each with its void lineage row.
      expect(rows).toHaveLength(4);
      expect(rows.every((r: any) => r.status === 'void')).toBe(true);
      expect(rows.filter((r: any) => !r.reverses_transaction_id).map((r: any) => Number(r.amount_cents)).sort())
        .toEqual([10_001, 15_000]);
      expect(await clientBalanceCents(firm.id, client.id)).toBe(DEPOSITED_CENTS);
      const book = await testPool.query('select book_balance_cents from trust_accounts where id = $1', [accountId]);
      expect(Number(book.rows[0].book_balance_cents)).toBe(DEPOSITED_CENTS);
    });
  });

  describe('two payments in a row', () => {
    it('writes one withdrawal each and leaves the balance correct', async () => {
      const { firm, owner, client, invoice, accountId } = await seedWorld();

      // Sequential, not concurrent: the point is that the first payment's
      // transaction fully releases its locks, so the second is not blocked by
      // leftovers from the first.
      const first = await payFromTrust(owner, firm.id, client.id, invoice.id, accountId, 100);
      const second = await payFromTrust(owner, firm.id, client.id, invoice.id, accountId, 150);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await withdrawals(firm.id)).toHaveLength(2);
      expect(Number((await invoiceRow(invoice.id)).amount_paid_cents)).toBe(25_000);
      expect(await clientBalanceCents(firm.id, client.id)).toBe(DEPOSITED_CENTS - 25_000);
    });
  });
});

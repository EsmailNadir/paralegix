/**
 * Removing a trust-funded payment reverses its withdrawal in the same transaction.
 * When the ledger refuses the reversal (the entry was reconciled, or its period is
 * closed) the removal is refused whole: the payment stays on the invoice and the
 * withdrawal stays on the ledger, so the client's trust balance is never short.
 */
import { randomUUID } from 'crypto';
import { testPool, createTrustDeposit } from '../../support/setupInProcess';
import { seedWorld, invoiceRow, paymentRows, assertInvoiceInvariants, type World } from './lifecycleKit';

let w: World;
let accountId: string;
let withdrawalId: string;
beforeEach(async () => {
  w = await seedWorld(100_000);
  ({ accountId } = await createTrustDeposit(w.firm.id, w.clientId, { amountCents: 500_000 }));
  expect((await pay({ paymentAmount: 400, paymentSource: 'trust', trustAccountId: accountId })).status).toBe(200);
  const { rows } = await testPool.query("select id from trust_transactions where type = 'withdrawal'");
  withdrawalId = rows[0].id;
});
const pay = (b: any) => w.owner.api.put(`${w.inv}/payment`).send(b);

async function standing() {
  const payments = await paymentRows(w.invoiceId);
  const { rows } = await testPool.query(
    "select status from trust_transactions where type = 'withdrawal' and reverses_transaction_id is null");
  return { payments: payments.map((p: any) => p.cents), withdrawal: rows[0].status };
}

async function reconcileWithdrawal() {
  const reconciliationId = randomUUID();
  await testPool.query(
    `insert into trust_reconciliations (id, law_firm_id, trust_account_id, reconciliation_date,
        bank_statement_balance_cents, book_balance_cents, client_ledger_total_cents, is_reconciled, discrepancy_cents)
     values ($1, $2, $3, current_date, 460000, 460000, 460000, true, 0)`,
    [reconciliationId, w.firm.id, accountId],
  );
  await testPool.query(
    'update trust_transactions set cleared_at = now(), cleared_in_reconciliation_id = $2 where id = $1',
    [withdrawalId, reconciliationId],
  );
}

const unchanged = { payments: [40_000], withdrawal: 'completed' };

describe('a trust withdrawal that cannot be reversed', () => {
  it('refuses to delete the payment when the withdrawal is reconciled', async () => {
    await reconcileWithdrawal();

    const res = await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/trust withdrawal/i);
    expect(res.body.error).toMatch(/reconcil/i);
    expect(await standing()).toEqual(unchanged);
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(Number(row.amount_paid_cents)).toBe(40_000);
  });

  it('refuses to delete the payment when its period was closed after it was posted', async () => {
    await testPool.query('update trust_accounts set book_close_date = current_date + 30 where id = $1', [accountId]);

    const res = await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/closed period/i);
    expect(await standing()).toEqual(unchanged);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('refuses a reset to unpaid and leaves a manual payment recorded beside it in place', async () => {
    expect((await pay({ paymentAmount: 100 })).status).toBe(200);
    await reconcileWithdrawal();

    const res = await pay({ isPaid: false });

    expect(res.status).toBe(409);
    expect((await standing()).payments).toEqual([40_000, 10_000]);
    expect((await standing()).withdrawal).toBe('completed');
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('refuses to un-pay the installment that the trust payment settled', async () => {
    const plan = await w.owner.api.post(`${w.inv}/payment-plan`).send({
      installmentAmount: 300, frequencyDays: 30, planStartDate: '2030-01-01',
    });
    expect(plan.status).toBe(200);
    const spent = await w.owner.api.put(`${w.inv}/payment`).send({
      paymentAmount: 300, paymentSource: 'trust', trustAccountId: accountId, installmentIndex: 0,
    });
    expect(spent.status).toBe(200);
    const { rows } = await testPool.query(
      "select id from trust_transactions where type = 'withdrawal' and status = 'completed' order by created_at desc limit 1");
    await testPool.query('update trust_accounts set book_close_date = current_date + 30 where id = $1', [accountId]);

    const res = await w.owner.api.delete(`${w.inv}/payment-plan/installment/0/payment`);

    expect(res.status).toBe(409);
    const after = await testPool.query('select status from trust_transactions where id = $1', [rows[0].id]);
    expect(after.rows[0].status).toBe('completed');
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([40_000, 30_000]);
    await assertInvoiceInvariants(w.invoiceId);
  });
});

describe('a trust withdrawal that can be reversed', () => {
  it('is reversed together with the payment removal', async () => {
    const res = await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`);

    expect(res.status).toBe(200);
    expect(await standing()).toEqual({ payments: [], withdrawal: 'void' });
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(Number((await invoiceRow(w.invoiceId)).amount_paid_cents)).toBe(0);
    expect(row.is_paid).toBe(false);
  });
});

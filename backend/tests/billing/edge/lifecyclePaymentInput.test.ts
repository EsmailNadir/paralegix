/**
 * Payment inputs and edits at their edges: a malformed trust account id, a
 * correction that leaves the amount alone, and an invoice with nothing to pay.
 */
import { testPool } from '../../support/setupInProcess';
import { seedWorld, invoiceRow, paymentRows, assertInvoiceInvariants, type World } from './lifecycleKit';

let w: World;
beforeEach(async () => { w = await seedWorld(100_000); });
const pay = (b: any) => w.owner.api.put(`${w.inv}/payment`).send(b);

describe('a trust payment with a malformed account id', () => {
  it('is a 400 that names the field, and nothing is recorded', async () => {
    const res = await pay({ paymentAmount: 100, paymentSource: 'trust', trustAccountId: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/trustAccountId|trust account/i);
    expect(await paymentRows(w.invoiceId)).toEqual([]);
    await assertInvoiceInvariants(w.invoiceId);
  });
});

describe('correcting a payment without changing its amount', () => {
  async function overpaidByAcknowledgedReprice() {
    expect((await pay({ paymentAmount: 600 })).status).toBe(200);
    const reprice = await w.owner.api.patch(`${w.inv}/line-items`)
      .send({ flatFees: [{ name: 'Fee', amount: 500 }], acknowledgeOverpayment: true });
    expect(reprice.status).toBe(200);
  }

  it('a note edit is allowed on an invoice whose total was lowered below what was paid', async () => {
    await overpaidByAcknowledgedReprice();

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, note: 'check 1042' });

    expect(res.status).toBe(200);
    expect(res.body.invoice.payments[0].note).toBe('check 1042');
    await assertInvoiceInvariants(w.invoiceId, { allowExcess: true });
  });

  it('a date edit is allowed there too, and the paid total is untouched', async () => {
    await overpaidByAcknowledgedReprice();

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, date: '2026-01-15' });

    expect(res.status).toBe(200);
    expect(Number((await invoiceRow(w.invoiceId)).amount_paid_cents)).toBe(60_000);
  });

  it('raising the amount on such an invoice is still refused', async () => {
    await overpaidByAcknowledgedReprice();

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, amount: 650 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceed the invoice total/i);
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([60_000]);
  });
});

describe('an invoice with a zero total', () => {
  beforeEach(async () => {
    await testPool.query('update invoices set total_cents = 0 where id = $1', [w.invoiceId]);
  });

  it('reads paid once it is marked paid', async () => {
    const res = await pay({ isPaid: true });

    expect(res.status).toBe(200);
    const row = await invoiceRow(w.invoiceId);
    expect(row.is_paid).toBe(true);
    expect(row.paid_date).not.toBeNull();
    expect(row.status).toBe('paid');
    expect(res.body.invoice.status).toBe('paid');
    expect(await paymentRows(w.invoiceId)).toEqual([]);
  });

  it('is not awaiting payment and never overdue, paid or not', async () => {
    await testPool.query("update invoices set due_date = current_date - 30 where id = $1", [w.invoiceId]);
    const base = `/api/lawfirms/${w.firm.id}/billing/invoices/firm`;

    const unpaid = (await w.owner.api.get(`${base}?awaitingOnly=true`)).body;
    expect(unpaid.invoices).toHaveLength(0);
    expect((await w.owner.api.get(`/api/lawfirms/${w.firm.id}/billing/workbench`)).body.collections.overdueCount).toBe(0);

    expect((await pay({ isPaid: true })).status).toBe(200);
    const list = (await w.owner.api.get(base)).body;
    expect(list.invoices[0].status).toBe('paid');
    expect((await w.owner.api.get(`${base}?awaitingOnly=true`)).body.invoices).toHaveLength(0);
  });
});

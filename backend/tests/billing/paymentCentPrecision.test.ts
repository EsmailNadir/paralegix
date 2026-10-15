/**
 * A payment is a whole number of cents, and the balance check is exact.
 *
 * The schema accepted any positive number and the service let a payment
 * through up to one cent over the balance "for float dust". Neither is
 * needed once amounts are whole cents: the comparison is integer cents, so
 * a payment fits the balance exactly or it does not. A value finer than a
 * cent is refused rather than rounded into an amount nobody typed.
 */
import {
  testPool,
  createFirm,
  createInvoice,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}`;
const pay = (amount: number) => owner.api.put(`${B()}/payment`).send({ paymentAmount: amount, paidDate: '2026-03-20' });

async function money() {
  const { rows } = await testPool.query(
    'select total_cents, amount_paid_cents, balance_due_cents, is_paid from invoices where id = $1',
    [invoiceId],
  );
  return {
    total: Number(rows[0].total_cents),
    paid: Number(rows[0].amount_paid_cents),
    due: Number(rows[0].balance_due_cents),
    isPaid: rows[0].is_paid as boolean,
  };
}

async function paymentCents() {
  const { rows } = await testPool.query(
    'select amount_cents from invoice_payments where invoice_id = $1 order by sort_order', [invoiceId],
  );
  return rows.map((r: any) => Number(r.amount_cents));
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { name: 'Cent Client' })).id;
  invoiceId = (await createInvoice(firm.id, clientId, { totalCents: 10_000 })).id; // $100.00
});

describe('recording a payment', () => {
  it('accepts exactly the balance and marks the invoice paid', async () => {
    const res = await pay(100);

    expect(res.status).toBe(200);
    expect(await money()).toEqual({ total: 10_000, paid: 10_000, due: 0, isPaid: true });
    expect(await paymentCents()).toEqual([10_000]);
  });

  /** RED IF the one-cent slack survives: 200 and amount_paid_cents 10001. */
  it('refuses one cent over the balance and writes nothing', async () => {
    const res = await pay(100.01);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the remaining balance/i);
    expect(await money()).toEqual({ total: 10_000, paid: 0, due: 10_000, isPaid: false });
    expect(await paymentCents()).toEqual([]);
  });

  /** Same boundary after a partial payment, where the slack used to sit on the remainder. */
  it('refuses one cent over what remains after a partial payment, then takes the exact remainder', async () => {
    expect((await pay(60)).status).toBe(200);

    const over = await pay(40.01);
    expect(over.status).toBe(400);
    expect(await paymentCents()).toEqual([6_000]);

    expect((await pay(40)).status).toBe(200);
    expect(await money()).toEqual({ total: 10_000, paid: 10_000, due: 0, isPaid: true });
  });

  /** RED IF sub-cent input is accepted: 10.999 records 1100 cents, 0.005 records 1 cent. */
  it.each([10.999, 0.005, 33.333])('refuses %p, which is not a whole number of cents, and writes nothing', async (amount) => {
    const res = await pay(amount);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/whole cents/i);
    expect(await paymentCents()).toEqual([]);
    expect((await money()).paid).toBe(0);
  });

  it('settles 100.00 to the cent with 33.33, 33.33 and 33.34', async () => {
    expect((await pay(33.33)).status).toBe(200);
    expect((await pay(33.33)).status).toBe(200);
    const last = await pay(33.34);

    expect(last.status).toBe(200);
    expect(await paymentCents()).toEqual([3_333, 3_333, 3_334]);
    expect(await money()).toEqual({ total: 10_000, paid: 10_000, due: 0, isPaid: true });
    expect(last.body.invoice.payments.map((p: any) => p.amount)).toEqual([33.33, 33.33, 33.34]);
  });
});

describe('editing a payment', () => {
  beforeEach(async () => {
    expect((await pay(50)).status).toBe(200);
  });

  /** RED IF editPayment keeps its +1 cent epsilon: 200 and 10001 paid. */
  it('refuses an edit that would overpay by one cent', async () => {
    const res = await owner.api.patch(`${B()}/payment`).send({ paymentIndex: 0, amount: 100.01 });

    expect(res.status).toBe(400);
    expect(await paymentCents()).toEqual([5_000]);
    expect((await money()).paid).toBe(5_000);
  });

  it('refuses a sub-cent edit', async () => {
    const res = await owner.api.patch(`${B()}/payment`).send({ paymentIndex: 0, amount: 50.005 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/whole cents/i);
    expect(await paymentCents()).toEqual([5_000]);
  });

  it('accepts an edit to exactly the total', async () => {
    const res = await owner.api.patch(`${B()}/payment`).send({ paymentIndex: 0, amount: 100 });

    expect(res.status).toBe(200);
    expect(await money()).toEqual({ total: 10_000, paid: 10_000, due: 0, isPaid: true });
  });
});

describe('other money inputs on the invoice', () => {
  /** RED IF the credit-note schema accepts sub-cent amounts (0.005 is written off as 1 cent). */
  it('refuses a sub-cent credit note and writes no adjustment', async () => {
    const res = await owner.api.post(`${B()}/credit-note`).send({ amount: 0.005, type: 'discount' });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select count(*)::int as n from invoice_adjustments where invoice_id = $1', [invoiceId]);
    expect(rows[0].n).toBe(0);
  });

  /** RED IF add-amount accepts sub-cent amounts. */
  it('refuses a sub-cent added amount and leaves the total alone', async () => {
    const res = await owner.api.patch(`${B()}/add-amount`).send({ amount: 10.999 });

    expect(res.status).toBe(400);
    expect((await money()).total).toBe(10_000);
  });

  it('still takes a whole-cent credit note', async () => {
    const res = await owner.api.post(`${B()}/credit-note`).send({ amount: 0.01, type: 'discount' });

    expect(res.status).toBe(200);
    expect((await money()).due).toBe(9_999);
  });
});

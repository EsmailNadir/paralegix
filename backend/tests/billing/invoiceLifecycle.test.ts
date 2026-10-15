/**
 * The client invoice lifecycle, driven through the real routes.
 *
 * `invoices.service.ts` is the largest uncovered file in the backend, 1,359
 * statements at 7% before this file, and it is the money: create, pay, partly
 * pay, over-pay, credit, adjust, delete. A defect here is a wrong bill rather
 * than a cosmetic bug, so the assertions are on FIGURES and on the derived
 * balance, not on status codes.
 *
 * Amounts are stated twice on purpose. The API speaks dollars
 * (`totalAmount: 1000`) while the column is `total_cents` (100000) and
 * `balance_due_cents` is a generated column, so each case checks the row as well
 * as the response. A conversion bug that cancels out in one direction shows up
 * in the other.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Paying Client', email: 'pays@example.test' });
  await drainEvents();
});

const invoicesPath = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

/**
 * Create a client-context invoice for a whole-dollar amount.
 *
 * A single flat fee carries the amount, because the service refuses an invoice
 * whose `totalAmount` does not equal the sum of its line items ("Invoice total
 * does not match line items"). That rule is asserted directly further down; here
 * it just means a fixture cannot state a total out of thin air.
 */
async function createInvoice(totalAmount: number, overrides: Record<string, unknown> = {}) {
  const res = await owner.api.post(invoicesPath()).send({
    invoiceName: `Invoice for ${totalAmount}`,
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-31',
    totalAmount,
    flatFeesAmount: totalAmount,
    flatFees: [{ description: 'Fixed fee', amount: totalAmount }],
    ...overrides,
  });
  return res;
}

/** The stored row, in cents, including the generated balance column. */
async function row(invoiceId: string) {
  const { rows } = await testPool.query(
    `select total_cents, amount_paid_cents, balance_due_cents, status, is_paid
       from invoices where id = $1`,
    [invoiceId],
  );
  return rows[0];
}

describe('creating a client invoice', () => {
  it('stores the total in cents and derives a full balance due', async () => {
    const res = await createInvoice(1000);

    expect(res.status).toBe(201);
    // The create envelope is `{ message, invoice }`, not the `{ message, xId }`
    // shape the backend conventions describe for a create. Pinned rather than
    // read through a `??` fallback, which would keep passing if it changed.
    expect(res.body.message).toBe('Invoice saved successfully');
    const invoiceId = res.body.invoice.id;
    expect(invoiceId).toEqual(expect.any(String));

    const stored = await row(invoiceId);
    // Dollars in, cents stored. The 100x error this guards against is the most
    // expensive mistake available in this file.
    expect(Number(stored.total_cents)).toBe(100_000);
    expect(Number(stored.amount_paid_cents)).toBe(0);
    // `balance_due_cents` is generated always as stored, so it is the database's
    // answer rather than the service's.
    expect(Number(stored.balance_due_cents)).toBe(100_000);
  });

  it('stores a fractional amount without losing the cents', async () => {
    const res = await createInvoice(1234.56);

    const stored = await row(res.body.invoice.id);
    expect(Number(stored.total_cents)).toBe(123_456);
  });

  it('refuses a total that does not match its line items', async () => {
    // The invariant that stops an invoice claiming one figure while its lines
    // add to another, which is what a client would dispute.
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Mismatched',
      invoiceDate: '2026-03-01',
      totalAmount: 1000,
      flatFeesAmount: 400,
      flatFees: [{ description: 'Fixed fee', amount: 400 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match line items/i);
  });

  it('rejects an invoice with no name', async () => {
    const res = await owner.api.post(invoicesPath()).send({
      invoiceDate: '2026-03-01', totalAmount: 100,
    });

    expect(res.status).toBe(400);
  });

  it('refuses a member without the billing permission', async () => {
    const { memberWith } = require('../support/setupInProcess');
    const reader = await memberWith(firm.id, ['clients.view']);

    const res = await reader.api.post(invoicesPath()).send({
      invoiceName: 'Should not exist', invoiceDate: '2026-03-01', totalAmount: 100,
    });

    expect(res.status).toBe(403);
  });
});

describe('recording a payment', () => {
  async function invoiceFor(amount: number) {
    const res = await createInvoice(amount);
    expect(res.status).toBe(201);
    return res.body.invoice.id as string;
  }

  it('reduces the balance by a partial payment and leaves the invoice unpaid', async () => {
    const invoiceId = await invoiceFor(1000);

    const paid = await owner.api
      .put(`${invoicesPath()}/${invoiceId}/payment`)
      .send({ paymentAmount: 400, paidDate: '2026-03-10' });
    expect(paid.status).toBe(200);
    await drainEvents();

    const stored = await row(invoiceId);
    expect(Number(stored.amount_paid_cents)).toBe(40_000);
    expect(Number(stored.balance_due_cents)).toBe(60_000);
    expect(stored.is_paid).toBe(false);
  });

  it('marks the invoice paid when the payments reach the total', async () => {
    const invoiceId = await invoiceFor(1000);

    await owner.api.put(`${invoicesPath()}/${invoiceId}/payment`)
      .send({ paymentAmount: 600, paidDate: '2026-03-10' });
    await owner.api.put(`${invoicesPath()}/${invoiceId}/payment`)
      .send({ paymentAmount: 400, paidDate: '2026-03-11' });
    await drainEvents();

    const stored = await row(invoiceId);
    expect(Number(stored.amount_paid_cents)).toBe(100_000);
    expect(Number(stored.balance_due_cents)).toBe(0);
    expect(stored.is_paid).toBe(true);
  });

  it('keeps cents exact across several odd payments', async () => {
    const invoiceId = await invoiceFor(100);

    // Three payments that only sum correctly if each is converted independently
    // and none is rounded twice.
    for (const amount of [33.33, 33.33, 33.34]) {
      // eslint-disable-next-line no-await-in-loop
      await owner.api.put(`${invoicesPath()}/${invoiceId}/payment`)
        .send({ paymentAmount: amount, paidDate: '2026-03-10' });
    }
    await drainEvents();

    const stored = await row(invoiceId);
    expect(Number(stored.amount_paid_cents)).toBe(10_000);
    expect(Number(stored.balance_due_cents)).toBe(0);
  });

  it('rejects a zero or negative payment', async () => {
    const invoiceId = await invoiceFor(1000);

    for (const amount of [0, -50]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await owner.api.put(`${invoicesPath()}/${invoiceId}/payment`)
        .send({ paymentAmount: amount, paidDate: '2026-03-10' });
      expect(res.status).toBe(400);
    }
  });

  it('does not let one firm record a payment on another firm\'s invoice', async () => {
    const invoiceId = await invoiceFor(1000);
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .put(`/api/lawfirms/${otherFirm.id}/billing/invoices/client/${client.id}/${invoiceId}/payment`)
      .send({ paymentAmount: 1000, paidDate: '2026-03-10' });

    expect([403, 404]).toContain(res.status);
    const stored = await row(invoiceId);
    expect(Number(stored.amount_paid_cents)).toBe(0);
  });
});

// Credit notes, with the exact balance they leave, are pinned in
// `invoiceAdjustments.test.ts`.

describe('deleting an invoice', () => {
  it('removes it and stops it appearing in the client list', async () => {
    const created = await createInvoice(1000);
    const invoiceId = created.body.invoice.id;

    const before = await owner.api.get(invoicesPath());
    expect(JSON.stringify(before.body)).toContain(invoiceId);

    const deleted = await owner.api.delete(`${invoicesPath()}/${invoiceId}`);
    expect([200, 204]).toContain(deleted.status);
    await drainEvents();

    const after = await owner.api.get(invoicesPath());
    expect(JSON.stringify(after.body)).not.toContain(invoiceId);
  });
});

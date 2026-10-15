/**
 * A payment is addressed by the id the invoice payload carries for it, not only
 * by its position in the list: a double-clicked delete or an edit from a stale
 * tab names a payment that may no longer be where it was, and must touch nothing
 * else. The position stays accepted for callers that do not send an id.
 */
import { gateMethod, type Gate } from '../../support/gate';
import { drainEvents } from '../../support/setupInProcess';
import { seedWorld, paymentRows, assertInvoiceInvariants, type World } from './lifecycleKit';

const invoicesRepo = require('../../../src/modules/billing/invoices/invoices.repository');

let w: World;
let gate: Gate | null = null;
beforeEach(async () => { w = await seedWorld(100_000); });
afterEach(() => { gate?.restore(); gate = null; });
const pay = (b: any) => w.owner.api.put(`${w.inv}/payment`).send(b);
const cents = async () => (await paymentRows(w.invoiceId)).map((p: any) => p.cents);

async function recordThree() {
  let invoice: any;
  for (const amount of [100, 200, 300]) {
    const res = await pay({ paymentAmount: amount });
    expect(res.status).toBe(200);
    invoice = res.body.invoice;
  }
  return invoice.payments as Array<{ id: string; amount: number }>;
}

describe('the invoice payload names each payment', () => {
  it('gives every payment a distinct id that survives later writes to the invoice', async () => {
    const payments = await recordThree();
    const ids = payments.map((p) => p.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);

    // A new payment, an edit of a different payment and a credit note each rewrite the invoice.
    expect((await pay({ paymentAmount: 50 })).status).toBe(200);
    expect((await w.owner.api.patch(`${w.inv}/payment`).send({ paymentId: ids[0], note: 'check 7' })).status).toBe(200);
    const read = await w.owner.api.post(`${w.inv}/credit-note`).send({ amount: 10, type: 'discount' });

    expect(read.status).toBe(200);
    expect(read.body.invoice.payments.slice(0, 3).map((p: any) => p.id)).toEqual(ids);
  });
});

describe('deleting by id', () => {
  it('removes the named payment wherever it sits in the list', async () => {
    const payments = await recordThree();

    const res = await w.owner.api.delete(`${w.inv}/payment?paymentId=${payments[1].id}`);

    expect(res.status).toBe(200);
    expect(await cents()).toEqual([10_000, 30_000]);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a double-clicked delete removes one payment and refuses the second request', async () => {
    const payments = await recordThree();
    gate = gateMethod(invoicesRepo, 'runInvoiceTxn');
    const del = async () => w.owner.api.delete(`${w.inv}/payment?paymentId=${payments[0].id}`);
    const a = del();
    const b = del();
    await gate.arrived(2);
    gate.open();
    const results = await Promise.all([a, b]);
    await drainEvents();

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await cents()).toEqual([20_000, 30_000]);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('refuses an id that is not on the invoice and removes nothing', async () => {
    await recordThree();

    const res = await w.owner.api.delete(`${w.inv}/payment?paymentId=00000000-0000-4000-8000-000000000000`);

    expect(res.status).toBe(409);
    expect(await cents()).toEqual([10_000, 20_000, 30_000]);
  });

  it('refuses a malformed id with a 400', async () => {
    await recordThree();

    const res = await w.owner.api.delete(`${w.inv}/payment?paymentId=not-a-uuid`);

    expect(res.status).toBe(400);
    expect(await cents()).toEqual([10_000, 20_000, 30_000]);
  });

  it('still removes by position when no id is sent', async () => {
    await recordThree();

    const res = await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`);

    expect(res.status).toBe(200);
    expect(await cents()).toEqual([20_000, 30_000]);
  });
});

describe('editing by id', () => {
  it('edits the named payment, not whichever one now sits at its old position', async () => {
    const payments = await recordThree();
    expect((await w.owner.api.delete(`${w.inv}/payment?paymentId=${payments[0].id}`)).status).toBe(200);

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentId: payments[2].id, amount: 350 });

    expect(res.status).toBe(200);
    expect(await cents()).toEqual([20_000, 35_000]);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('an edit from a stale tab for a payment another tab deleted is refused and changes nothing', async () => {
    const payments = await recordThree();
    expect((await w.owner.api.delete(`${w.inv}/payment?paymentId=${payments[0].id}`)).status).toBe(200);

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentId: payments[0].id, amount: 350 });

    expect(res.status).toBe(409);
    expect(await cents()).toEqual([20_000, 30_000]);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('still edits by position when no id is sent', async () => {
    await recordThree();

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 1, amount: 250 });

    expect(res.status).toBe(200);
    expect(await cents()).toEqual([10_000, 25_000, 30_000]);
  });

  it('refuses a body that names neither an id nor a position', async () => {
    await recordThree();

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ amount: 250 });

    expect(res.status).toBe(400);
    expect(await cents()).toEqual([10_000, 20_000, 30_000]);
  });
});

describe('un-paying an installment by payment id', () => {
  async function planWithOnePaid() {
    expect((await w.owner.api.post(`${w.inv}/payment-plan`).send({
      installmentAmount: 500, frequencyDays: 30, planStartDate: '2030-01-01',
    })).status).toBe(200);
    const paid = await pay({ paymentAmount: 500, installmentIndex: 0 });
    expect(paid.status).toBe(200);
    return paid.body.invoice.payments as Array<{ id: string }>;
  }

  it('un-pays when the id names the payment that settled the installment', async () => {
    const [settling] = await planWithOnePaid();

    const res = await w.owner.api.delete(`${w.inv}/payment-plan/installment/0/payment?paymentId=${settling.id}`);

    expect(res.status).toBe(200);
    expect(await cents()).toEqual([]);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('refuses when the id names a different payment than the one that settled the installment', async () => {
    await planWithOnePaid();

    const res = await w.owner.api.delete(
      `${w.inv}/payment-plan/installment/0/payment?paymentId=00000000-0000-4000-8000-000000000000`);

    expect(res.status).toBe(409);
    expect(await cents()).toEqual([50_000]);
  });
});

/**
 * An invoice that is reopened (its balance is positive again after it was settled)
 * carries no settlement date, whichever write reopened it.
 */
import { seedWorld, invoiceRow, assertInvoiceInvariants, type World } from './lifecycleKit';

let w: World;
beforeEach(async () => { w = await seedWorld(100_000); });
const pay = (b: any) => w.owner.api.put(`${w.inv}/payment`).send(b);

async function expectReopened() {
  const { row } = await assertInvoiceInvariants(w.invoiceId);
  expect(row.is_paid).toBe(false);
  expect(row.paid_date).toBeNull();
}

it('adding an amount to a settled invoice clears the paid date', async () => {
  expect((await pay({ isPaid: true })).status).toBe(200);
  expect((await invoiceRow(w.invoiceId)).paid_date).not.toBeNull();

  const res = await w.owner.api.patch(`${w.inv}/add-amount`).send({ amount: 50 });

  expect(res.status).toBe(200);
  await expectReopened();
  expect(res.body.invoice.paidDate).toBeNull();
});

it('removing a credit note from an invoice marked paid clears the paid date', async () => {
  const add = await w.owner.api.post(`${w.inv}/credit-note`).send({ amount: 400, type: 'discount' });
  expect((await pay({ isPaid: true })).status).toBe(200);
  expect((await invoiceRow(w.invoiceId)).paid_date).not.toBeNull();

  const res = await w.owner.api.delete(`${w.inv}/credit-note?creditNoteId=${add.body.invoice.creditNotes[0].id}`);

  expect(res.status).toBe(200);
  await expectReopened();
});

it('adding an amount to an invoice that is not settled leaves it unsettled with no paid date', async () => {
  expect((await pay({ paymentAmount: 200 })).status).toBe(200);

  expect((await w.owner.api.patch(`${w.inv}/add-amount`).send({ amount: 50 })).status).toBe(200);

  await expectReopened();
});

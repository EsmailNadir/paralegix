/**
 * Marking an overpaid invoice paid never lowers amount_paid below the sum of the recorded payments.
 */
import {
  drainEvents, createFirm, createPersonClient, ownerOf, testPool,
  type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm; let owner: Actor; let client: ClientRecord;
beforeEach(async () => { firm = await createFirm(); owner = await ownerOf(firm.id); client = await createPersonClient(firm.id, { name: 'C' }); await drainEvents(); });

it('keeps amount_paid equal to the recorded payments when an overpaid invoice is marked paid', async () => {
  const base = `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
  const created = await owner.api.post(base).send({ invoiceName: 'A', invoiceDate: '2026-03-01', flatFees: [{ description: 'F', amount: 100 }] });
  const id = created.body.invoice.id;
  await owner.api.put(`${base}/${id}/payment`).send({ paymentAmount: 100, paidDate: '2026-04-01' });
  // Lower the bill to 60.00 below what was paid, acknowledging the 40.00 credit.
  await owner.api.patch(`${base}/${id}/line-items`).send({ timeEntries: [], expenses: [], flatFees: [{ description: 'F', amount: 60 }], acknowledgeOverpayment: true });
  const res = await owner.api.put(`${base}/${id}/payment`).send({ isPaid: true });
  expect(res.status).toBe(200);
  const r = (await testPool.query(
    `select amount_paid_cents::int paid, (select coalesce(sum(amount_cents),0)::int from invoice_payments where invoice_id = $1) pay from invoices where id = $1`, [id])).rows[0];
  expect(r.pay).toBe(10_000);
  expect(r.paid).toBe(10_000);
});

/**
 * Re-saving an invoice's hourly lines keeps the exact half-up amount (0.35 h x $27.50 = 962.5 cents is 963).
 */
import {
  drainEvents, createFirm, createPersonClient, ownerOf, testPool,
  type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm; let owner: Actor; let client: ClientRecord;
beforeEach(async () => {
  firm = await createFirm(); owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'C' }); await drainEvents();
});

it('re-saving 0.35 h at $27.50 keeps 963 cents', async () => {
  const t = await owner.api.post(`/api/lawfirms/${firm.id}/billing/time-entries`).send({
    context: 'client', clientId: client.id, userId: owner.uid, hours: 0.35, date: '2026-03-10', hourlyRate: 27.5,
  });
  const base = `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
  const created = await owner.api.post(base).send({
    invoiceName: 'I', invoiceDate: '2026-03-12', totalAmount: 9.63,
    timeEntries: [{ id: t.body.timeEntry.id, hours: 0.35, rate: 27.5, amount: 9.63 }],
  });
  const id = created.body.invoice.id;
  await owner.api.patch(`${base}/${id}/line-items`).send({
    timeEntries: [{ id: t.body.timeEntry.id, hours: 0.35, rate: 27.5, amount: 9.63 }], flatFees: [], expenses: [],
  });
  const total = Number((await testPool.query('select total_cents from invoices where id = $1', [id])).rows[0].total_cents);
  expect(total).toBe(963);
});

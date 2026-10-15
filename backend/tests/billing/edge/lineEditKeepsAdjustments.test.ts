/**
 * Editing line items keeps amounts added after creation (add-amount and late fee rows): total = lines + tax + adjustments.
 */
import { randomUUID } from 'crypto';
import {
  drainEvents, createFirm, createPersonClient, ownerOf, testPool,
  type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm; let owner: Actor; let client: ClientRecord;
beforeEach(async () => {
  firm = await createFirm(); owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'C' }); await drainEvents();
});

it('keeps a $10.10 added amount after an unrelated line edit (total 100.00 + 10.10)', async () => {
  const base = `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
  const fee = { description: 'F', amount: 100 };
  const created = await owner.api.post(base).send({
    invoiceName: `A ${randomUUID().slice(0, 5)}`, invoiceDate: '2026-03-01', totalAmount: 100, flatFees: [fee],
  });
  const id = created.body.invoice.id;
  const added = await owner.api.patch(`${base}/${id}/add-amount`).send({ amount: 10.1, note: 'extra' });
  expect(added.status).toBe(200);
  const total = async () => Number((await testPool.query('select total_cents from invoices where id = $1', [id])).rows[0].total_cents);
  expect(await total()).toBe(11010);
  const edited = await owner.api.patch(`${base}/${id}/line-items`).send({
    timeEntries: [], expenses: [], flatFees: [fee],
  });
  expect(edited.status).toBe(200);
  expect(await total()).toBe(11010);
});

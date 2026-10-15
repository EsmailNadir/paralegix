/**
 * Tax is rounded half up in integer arithmetic on create and after a line edit (an exact half cent rounds up).
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

it.each([[7.25, 3000, 218], [9.975, 10000, 998], [7.25, 6200, 450]])(
  'tax at %p%% on %p cents is %p cents on create and after a line edit',
  async (rate, subtotal, wantTax) => {
    const base = `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
    const created = await owner.api.post(base).send({
      invoiceName: `T ${randomUUID().slice(0, 5)}`, invoiceDate: '2026-03-01', taxRate: rate,
      totalAmount: subtotal / 100, flatFees: [{ description: 'F', amount: subtotal / 100 }],
    });
    expect(created.status).toBe(201);
    const id = created.body.invoice.id;
    const tax = async () => Number((await testPool.query('select tax_cents from invoices where id = $1', [id])).rows[0].tax_cents);
    expect(await tax()).toBe(wantTax);
    await owner.api.patch(`${base}/${id}/line-items`).send({
      timeEntries: [], expenses: [], flatFees: [{ description: 'F', amount: subtotal / 100 }],
    });
    expect(await tax()).toBe(wantTax);
  },
);

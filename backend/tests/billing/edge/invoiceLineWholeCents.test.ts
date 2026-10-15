/**
 * Invoice line amounts must be whole cents, like every other money input.
 */
import { randomUUID } from "crypto";
import {
  drainEvents, createFirm, createPersonClient, ownerOf, testPool,
  type Actor, type Firm, type ClientRecord,
} from "../../support/setupInProcess";

let firm: Firm; let owner: Actor; let client: ClientRecord;
beforeEach(async () => {
  firm = await createFirm(); owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: "C" }); await drainEvents();
});

it.each([0.004, 0.005, 1.005, 10.999])('refuses a flat fee line of %p dollars (not whole cents)', async (amount) => {
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`).send({
    invoiceName: `X${randomUUID().slice(0, 5)}`, invoiceDate: "2026-03-01",
    flatFees: [{ description: "F", amount }],
  });
  expect(res.status).toBe(400);
  void testPool;
});

it.each([0.004, 1.005, 10.999])('refuses a flat fee of %p dollars when editing line items', async (amount) => {
  const base = `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
  const created = await owner.api.post(base).send({
    invoiceName: `X${randomUUID().slice(0, 5)}`, invoiceDate: '2026-03-01',
    flatFees: [{ description: 'F', amount: 10 }],
  });
  expect(created.status).toBe(201);
  const res = await owner.api.patch(`${base}/${created.body.invoice.id}/line-items`).send({
    timeEntries: [], expenses: [], flatFees: [{ description: 'F', amount }],
  });
  expect(res.status).toBe(400);
});

it('still accepts whole-cent amounts written the way a form posts them', async () => {
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`).send({
    invoiceName: `X${randomUUID().slice(0, 5)}`, invoiceDate: '2026-03-01',
    flatFees: [{ description: 'F', amount: '33.33' }],
  });
  expect(res.status).toBe(201);
  expect(Number((await testPool.query('select total_cents from invoices where id = $1', [res.body.invoice.id])).rows[0].total_cents)).toBe(3333);
});

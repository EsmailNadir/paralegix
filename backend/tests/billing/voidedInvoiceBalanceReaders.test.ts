/**
 * Matter balances and the daily digest after an invoice is voided.
 *
 * RED IF: a closed matter whose only invoice was voided still reads "payment
 * ongoing" with an outstanding balance or counts it in billed-to-date, or the
 * digest still lists the voided invoice as due.
 */
import { testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm } from '../support/setupInProcess';
import { seedMatter } from '../support/matters';
import { findDigestInvoices } from '../../src/modules/notifications/digest/digest.repository';

const mattersRepo = require('../../src/modules/matters/matters.repository');

let firm: Firm;
let owner: Actor;
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

async function matterWithInvoice() {
  const client = await createPersonClient(firm.id, { name: 'Closed Matter Client' });
  const matterId = await seedMatter(firm.id, {
    name: 'Closed matter', status: 'closed', clientIds: [client.id], memberUids: [owner.uid],
  });
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/billing/invoices`).send({
    matterId, invoiceName: 'Final bill', invoiceDate: dayOffset(-5), dueDate: dayOffset(2),
    totalAmount: 1000, flatFeesAmount: 1000, flatFees: [{ description: 'Final', amount: 1000 }],
  });
  expect(res.status).toBe(201);
  await drainEvents();
  return { matterId, invoiceId: res.body.invoice.id as string };
}

it('a closed matter is no longer "payment ongoing" once its only invoice is voided', async () => {
  const { matterId, invoiceId } = await matterWithInvoice();
  expect(await mattersRepo.findByIdRaw(firm.id, matterId))
    .toMatchObject({ outstandingBalanceCents: 100_000, paymentOngoing: true, billedTotalCents: 100_000 });

  expect((await owner.api.post(`/api/lawfirms/${firm.id}/billing/invoices/matter/${matterId}/${invoiceId}/void`)).status).toBe(200);

  expect(await mattersRepo.findByIdRaw(firm.id, matterId))
    .toMatchObject({ outstandingBalanceCents: 0, paymentOngoing: false, billedTotalCents: 0 });
  const listed = await owner.api.get(`/api/lawfirms/${firm.id}/matters?limit=500&paymentOngoing=true`);
  expect(listed.status).toBe(200);
  expect(listed.body.matters.map((m: any) => m.id)).not.toContain(matterId);
});

it('the daily digest stops listing a voided invoice as due', async () => {
  const { invoiceId, matterId } = await matterWithInvoice();
  const due = async () => (await findDigestInvoices(firm.id, dayOffset(0), dayOffset(7))).map((r: any) => r.id);
  expect(await due()).toContain(invoiceId);

  expect((await owner.api.post(`/api/lawfirms/${firm.id}/billing/invoices/matter/${matterId}/${invoiceId}/void`)).status).toBe(200);

  expect(await due()).not.toContain(invoiceId);
});

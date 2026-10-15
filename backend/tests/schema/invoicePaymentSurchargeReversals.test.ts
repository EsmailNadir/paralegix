import { createFirm, createPersonClient, createInvoice, testPool } from '../support/setupInProcess';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');

async function paymentFixture() {
  const firm = await createFirm();
  const client = await createPersonClient(firm.id);
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 10_000 });
  return { context: { type: 'client', lawFirmId: firm.id, entityId: client.id }, invoiceId: invoice.id };
}

it('preserves fee refund and dispute counters through invoice payment rewrites', async () => {
  const { context, invoiceId } = await paymentFixture();
  await invoicesRepo.update(context, invoiceId, {
    payments: [{ amount: 100, surchargeCents: 430, surchargeRefundedCents: 250, surchargeDisputedCents: 150 }],
  });
  const invoice = await invoicesRepo.findById(context, invoiceId);
  expect(invoice.payments).toHaveLength(1);
  expect(invoice.payments[0]).toMatchObject({ surchargeCents: 430, surchargeRefundedCents: 250, surchargeDisputedCents: 150 });
  await invoicesRepo.update(context, invoiceId, { payments: invoice.payments });
  const { rows } = await testPool.query(
    'select surcharge_refunded_cents, surcharge_disputed_cents from invoice_payments where invoice_id = $1', [invoiceId],
  );
  expect(rows).toEqual([{ surcharge_refunded_cents: '250', surcharge_disputed_cents: '150' }]);
});

it('defaults fee reversal counters to zero for payments created by older writers', async () => {
  const { context, invoiceId } = await paymentFixture();
  const { rows } = await testPool.query(
    `insert into invoice_payments (invoice_id, law_firm_id, sort_order, amount_cents)
     values ($1, $2, 0, 10000) returning surcharge_refunded_cents, surcharge_disputed_cents`,
    [invoiceId, context.lawFirmId],
  );
  expect(rows).toEqual([{ surcharge_refunded_cents: '0', surcharge_disputed_cents: '0' }]);
});

it('allows a dispute to reverse the entire client-paid fee', async () => {
  const { context, invoiceId } = await paymentFixture();
  const { rows } = await testPool.query(
    `insert into invoice_payments
       (invoice_id, law_firm_id, sort_order, amount_cents, surcharge_cents, surcharge_refunded_cents, surcharge_disputed_cents)
     values ($1, $2, 0, 10000, 430, 430, 430)
     returning surcharge_refunded_cents, surcharge_disputed_cents`,
    [invoiceId, context.lawFirmId],
  );
  expect(rows).toEqual([{ surcharge_refunded_cents: '430', surcharge_disputed_cents: '430' }]);
});

it.each([
  [-1, 0], [0, -1], [200, 201], [431, 0],
])('rejects invalid fee reversal counters refunded=%i disputed=%i', async (refunded, disputed) => {
  const { context, invoiceId } = await paymentFixture();
  await expect(testPool.query(
    `insert into invoice_payments
       (invoice_id, law_firm_id, sort_order, amount_cents, surcharge_cents, surcharge_refunded_cents, surcharge_disputed_cents)
     values ($1, $2, 0, 10000, 430, $3, $4)`,
    [invoiceId, context.lawFirmId, refunded, disputed],
  )).rejects.toMatchObject({ code: '23514' });
});

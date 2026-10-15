/**
 * A Stripe payment cannot be deleted from the invoice by hand.
 *
 * Stripe holds the other half of that record. `charge.refunded` and
 * `charge.dispute.created` find the payment by its payment intent id; delete
 * the row and a later refund at Stripe returns the money while this invoice
 * still shows it collected. The refusal is per payment: a manually recorded
 * payment on the same invoice stays deletable, as it always was.
 */
import {
  testPool,
  createFirm,
  createInvoice,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedStripePaidInvoice, STRIPE_INVOICE_CENTS } from '../support/stripeWebhook';

let firm: Firm;
let owner: Actor;

const paymentUrl = (clientId: string, invoiceId: string, index: number) =>
  `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}/payment?paymentIndex=${index}`;

async function payments(invoiceId: string) {
  const { rows } = await testPool.query(
    `select amount_cents, payment_source, stripe_payment_intent_id
       from invoice_payments where invoice_id = $1 order by sort_order`,
    [invoiceId],
  );
  return rows.map((r: any) => ({
    cents: Number(r.amount_cents), source: r.payment_source, intent: r.stripe_payment_intent_id,
  }));
}

async function amountPaidCents(invoiceId: string) {
  const { rows } = await testPool.query('select amount_paid_cents from invoices where id = $1', [invoiceId]);
  return Number(rows[0].amount_paid_cents);
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

/** RED IF deletePayment does not check the source: 200, and the Stripe row is gone. */
it('refuses to delete a payment Stripe collected, and keeps it where a refund will find it', async () => {
  const { invoiceId, clientId } = await seedStripePaidInvoice(firm.id, 'pi_delete_refused');

  const res = await owner.api.delete(paymentUrl(clientId, invoiceId, 0));

  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/Stripe/);
  expect(await payments(invoiceId)).toEqual([
    { cents: STRIPE_INVOICE_CENTS, source: 'stripe', intent: 'pi_delete_refused' },
  ]);
  expect(await amountPaidCents(invoiceId)).toBe(STRIPE_INVOICE_CENTS);
});

/** RED IF the refusal is per invoice rather than per payment, or missing. */
it('still deletes a manual payment on the same invoice', async () => {
  const client = await createPersonClient(firm.id, { email: 'mixed@example.test' });
  const { id: invoiceId } = await createInvoice(firm.id, client.id, { totalCents: 50_000 });
  await testPool.query(
    `insert into invoice_payments (invoice_id, law_firm_id, sort_order, amount_cents, payment_date, payment_source)
     values ($1, $2, 0, 10000, current_date, 'external')`,
    [invoiceId, firm.id],
  );
  await testPool.query(
    `insert into invoice_payments (invoice_id, law_firm_id, sort_order, amount_cents, payment_date, payment_source,
                                   stripe_payment_intent_id)
     values ($1, $2, 1, 25000, current_date, 'stripe', 'pi_mixed')`,
    [invoiceId, firm.id],
  );
  await testPool.query('update invoices set amount_paid_cents = 35000 where id = $1', [invoiceId]);

  const stripeDelete = await owner.api.delete(paymentUrl(client.id, invoiceId, 1));
  expect(stripeDelete.status).toBe(409);
  expect(await amountPaidCents(invoiceId)).toBe(35_000);

  const manualDelete = await owner.api.delete(paymentUrl(client.id, invoiceId, 0));
  expect(manualDelete.status).toBe(200);
  expect(await payments(invoiceId)).toEqual([{ cents: 25_000, source: 'stripe', intent: 'pi_mixed' }]);
  expect(await amountPaidCents(invoiceId)).toBe(25_000);
});

/**
 * Which invoices the Stripe reconciliation job has to look at.
 *
 * The job used to load EVERY invoice on the platform, with every payment, line
 * item and instalment hydrated, and then discard the ones with no Stripe state
 * in JavaScript. On a platform of any size that is the whole billing table in
 * one process's memory to repair a handful of rows.
 *
 * `listStripeCandidateInvoices` moves that filter into SQL and pages the
 * result. The cases below pin the two things that makes it safe:
 *
 *   IT MUST NOT NARROW THE JOB. Stripe state hides in two places: on the
 *   invoice (an open payment request or checkout session) and on a payment. A
 *   prefilter that only checked the invoice row would silently stop repairing
 *   the other, and nothing would look wrong until a client's paid invoice
 *   stayed open.
 *
 *   IT MUST NOT WIDEN IT EITHER. An invoice a firm never sent to Stripe has
 *   nothing to reconcile, and fetching it is the cost the change exists to
 *   remove.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

async function makeInvoice(name: string) {
  const res = await owner.api.post(B()).send({
    invoiceName: name,
    invoiceDate: '2026-03-01',
    dueDate: '2026-04-01',
    totalAmount: 500,
    flatFeesAmount: 500,
    flatFees: [{ description: 'Fixed fee', amount: 500 }],
  });
  expect(res.status).toBe(201);
  return res.body.invoice.id as string;
}

/** Every candidate id this firm contributes, across as many pages as it takes. */
async function candidateIds(pageSize = 500) {
  const ids: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page: any[] = await invoicesRepo.listStripeCandidateInvoices({ after, pageSize });
    if (!page.length) break;
    for (const { invoice, context } of page) {
      if (context.lawFirmId === firm.id) ids.push(invoice.id);
    }
    after = page[page.length - 1].invoice.id;
  }
  return ids;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Reconcile Scan Firm' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Scan Client' });
  await drainEvents();
});

it('leaves out an invoice that never went near Stripe', async () => {
  const plain = await makeInvoice('Cash only');

  expect(await candidateIds()).not.toContain(plain);
});

it('picks up Stripe state carried on the invoice row', async () => {
  const id = await makeInvoice('Checkout invoice');
  const res = await testPool.query('update invoices set stripe_checkout_session_id = $2 where id = $1', [id, 'cs_test_1']);
  expect(res.rowCount).toBe(1);

  expect(await candidateIds()).toContain(id);
});

it('picks up an invoice whose only Stripe state is a PAYMENT', async () => {
  const id = await makeInvoice('Paid at Stripe');
  await testPool.query(
    `insert into invoice_payments (id, law_firm_id, invoice_id, sort_order, amount_cents, payment_source)
     values ($1, $2, $3, 0, 50000, 'stripe')`,
    [randomUUID(), firm.id, id],
  );

  // The old scan found this in JavaScript, by reading the hydrated payments
  // array. A prefilter that only looked at the invoice row would drop it.
  expect(await candidateIds()).toContain(id);
});

it('does not pick up a payment that mentions Stripe only in its note', async () => {
  const id = await makeInvoice('Noted at Stripe');
  await testPool.query(
    `insert into invoice_payments (id, law_firm_id, invoice_id, sort_order, amount_cents, note)
     values ($1, $2, $3, 0, 50000, 'Paid via Stripe checkout')`,
    [randomUUID(), firm.id, id],
  );

  // `isStripePaymentEntry` reads what the row records about Stripe, never the
  // words a person typed in its note, and the query mirrors it clause for clause.
  expect(await candidateIds()).not.toContain(id);
});

it('returns every candidate across pages, not just the first page', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const id = await makeInvoice(`Checkout ${i}`);
    await testPool.query('update invoices set stripe_checkout_session_id = $2 where id = $1', [id, `cs_page_${i}`]);
    ids.push(id);
  }

  // A page size below the candidate count is the whole point: a paged reader
  // that dropped the tail would repair the first page and quietly abandon the
  // rest, which is worse than the unpaged scan it replaced.
  const seen = await candidateIds(2);
  expect(seen.sort()).toEqual(ids.sort());
});

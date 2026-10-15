/**
 * Deleting an invoice decides and deletes under one lock.
 *
 * The delete used to read the invoice, check it for Stripe and trust money,
 * and then delete in a separate unlocked statement. A payment that committed
 * in between went with the invoice (Stripe: the refund handler then finds
 * nothing) or tripped the trust ledger's append-only trigger as a raw 500.
 *
 * The first two cases make the window deterministic: this spec holds the
 * invoice row lock, lets the delete block on it, commits a payment from the
 * holding transaction (what a webhook or a trust payment does), and only then
 * lets the delete continue. The third races two real requests through a gate.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createInvoice,
  createPersonClient,
  createTrustDeposit,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { waitForInvoiceLockWaiter as waitForLock } from '../support/invoiceLockWaiter';
import { gateMethod, type Gate } from '../support/gate';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');

let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;
let gate: Gate | null = null;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}`;

const waitForInvoiceLockWaiter = () =>
  waitForLock('The delete never blocked on the held invoice row lock');

async function invoiceExists() {
  const { rows } = await testPool.query('select 1 from invoices where id = $1', [invoiceId]);
  return rows.length === 1;
}

async function paymentRows() {
  const { rows } = await testPool.query(
    'select amount_cents, payment_source from invoice_payments where invoice_id = $1', [invoiceId],
  );
  return rows.map((r: any) => ({ cents: Number(r.amount_cents), source: r.payment_source }));
}

/** Hold the invoice row, start the delete, run `inHold` once it is waiting, commit. */
async function deleteWhileHeld(inHold: (held: any) => Promise<void>) {
  const held = await testPool.connect();
  async function del() {
    return owner.api.delete(`${B()}/${invoiceId}`);
  }
  try {
    await held.query('begin');
    await held.query('select id from invoices where id = $1 for update', [invoiceId]);
    const deleting = del();
    await waitForInvoiceLockWaiter();
    await inHold(held);
    await held.query('commit');
    return await deleting;
  } finally {
    await held.query('rollback').catch(() => undefined);
    held.release();
  }
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { name: 'Race Client' })).id;
  invoiceId = (await createInvoice(firm.id, clientId, { totalCents: 50_000 })).id;
});

afterEach(() => {
  gate?.restore();
  gate = null;
});

/** RED IF the check runs before the lock: 200, and the invoice and its Stripe payment are gone. */
it('refuses when a Stripe payment lands while the delete waits, and keeps both', async () => {
  const res = await deleteWhileHeld(async (held) => {
    await held.query(
      `insert into invoice_payments (invoice_id, law_firm_id, sort_order, amount_cents, payment_date,
                                     payment_source, stripe_payment_intent_id)
       values ($1, $2, 0, 25000, current_date, 'stripe', 'pi_landed_mid_delete')`,
      [invoiceId, firm.id],
    );
    await held.query('update invoices set amount_paid_cents = 25000 where id = $1', [invoiceId]);
  });

  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/Stripe/);
  expect(await invoiceExists()).toBe(true);
  expect(await paymentRows()).toEqual([{ cents: 25_000, source: 'stripe' }]);
});

/** RED IF the check runs before the lock: the trust FK's SET NULL hits the append-only trigger, 500. */
it('refuses cleanly when a trust withdrawal lands while the delete waits', async () => {
  const accountId = randomUUID();
  await testPool.query(
    `insert into trust_accounts (id, law_firm_id, name, account_type, status, book_balance_cents)
     values ($1, $2, 'Race IOLTA', 'iolta', 'active', 500000)`,
    [accountId, firm.id],
  );

  const res = await deleteWhileHeld(async (held) => {
    await held.query(
      `insert into trust_transactions (id, law_firm_id, trust_account_id, type, amount_cents, client_id,
                                       invoice_id, txn_date, description, status)
       values ($1, $2, $3, 'withdrawal', 20000, $4, $5, current_date, 'Paid from trust', 'completed')`,
      [randomUUID(), firm.id, accountId, clientId, invoiceId],
    );
  });

  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/trust/i);
  expect(await invoiceExists()).toBe(true);
});

/**
 * Two real requests, proved to overlap at the context lock both now take.
 * Either order is legal; a deleted invoice that a payment landed on is not.
 * RED IF delete does not take the lock (the gate never sees two arrivals).
 */
it('never ends with a deleted invoice whose trust payment went through', async () => {
  const { accountId } = await createTrustDeposit(firm.id, clientId, { amountCents: 500_000 });
  gate = gateMethod(invoicesRepo, 'lockBillingContext');

  async function pay() {
    return owner.api.put(`${B()}/${invoiceId}/payment`)
      .send({ paymentAmount: 100, paymentSource: 'trust', trustAccountId: accountId });
  }
  async function del() {
    return owner.api.delete(`${B()}/${invoiceId}`);
  }
  const paying = pay();
  const deleting = del();
  await gate.arrived(2);
  gate.open();
  const [payRes, delRes] = await Promise.all([paying, deleting]);
  await drainEvents();

  const { rows: withdrawals } = await testPool.query(
    `select invoice_id from trust_transactions where law_firm_id = $1 and type = 'withdrawal'`, [firm.id],
  );
  expect([payRes.status, delRes.status]).not.toContain(500);
  if (delRes.status === 200) {
    expect(payRes.status).toBe(404);
    expect(await invoiceExists()).toBe(false);
    expect(withdrawals).toEqual([]);
  } else {
    expect(delRes.status).toBe(409);
    expect(payRes.status).toBe(200);
    expect(await invoiceExists()).toBe(true);
    expect(await paymentRows()).toEqual([{ cents: 10_000, source: 'trust' }]);
    expect(withdrawals).toEqual([{ invoice_id: invoiceId }]);
  }
});

it('still deletes an invoice with no Stripe or trust money on it', async () => {
  const res = await owner.api.delete(`${B()}/${invoiceId}`);

  expect(res.status).toBe(200);
  expect(await invoiceExists()).toBe(false);
});

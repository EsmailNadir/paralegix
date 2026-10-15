/**
 * A balance change that lowers what is owed must close the Stripe Checkout
 * session priced at the old balance, or the client can still pay the superseded
 * amount and overpay with no refund workflow behind it.
 *
 * The payment request itself stays open: the pay link prices from the current
 * balance when the client opens it, so only the already-priced session is
 * expired. The line-item edit does this; these specs hold the other balance
 * changes to the same standard. No live Stripe call is possible: stripe.config
 * is replaced wholesale and every surface a case does not stub throws, so a
 * case that reaches for a hosted Stripe Invoice fails on the call.
 */
jest.mock('../../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    accounts: { create: fn(), retrieve: fn(), update: fn(), createLoginLink: fn() },
    customers: { create: fn(), list: fn(), retrieve: fn(), update: fn() },
    invoices: { create: fn(), retrieve: fn(), voidInvoice: fn(), finalizeInvoice: fn() },
    invoiceItems: { create: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    paymentIntents: { create: fn(), retrieve: fn(), search: fn() },
    transfers: { create: fn(), retrieve: fn(), createReversal: fn() },
    refunds: { create: fn() },
  };
});

import { testPool } from '../../support/setupInProcess';
import { seedWorld, assertInvoiceInvariants, type World } from './lifecycleKit';

const PAY_LINK = 'tok_lifecycle_link';
const SESSION = 'cs_lifecycle_link';
const fakeStripe = () => require('../../../src/modules/stripe/stripe.config');

let w: World;
let live: Set<string>;

function surfaces(node: any = fakeStripe(), path = ''): Array<[string, jest.Mock]> {
  const out: Array<[string, jest.Mock]> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'webhooks') continue;
    const name = path ? `${path}.${key}` : key;
    if (jest.isMockFunction(value)) out.push([name, value as jest.Mock]);
    else if (value && typeof value === 'object') out.push(...surfaces(value, name));
  }
  return out;
}

async function linkPointers() {
  const { rows } = await testPool.query(
    'select stripe_checkout_session_id, stripe_payment_requested, pay_link_token, status from invoices where id = $1',
    [w.invoiceId],
  );
  return rows[0];
}

beforeEach(async () => {
  live = new Set([SESSION]);
  for (const [name, fn] of surfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  const s = fakeStripe();
  s.checkout.sessions.retrieve.mockImplementation(async (id: string) => ({ id, status: live.has(id) ? 'open' : 'expired' }));
  s.checkout.sessions.expire.mockImplementation(async (id: string) => { live.delete(id); return { id, status: 'expired' }; });

  w = await seedWorld(100_000);
  const res = await testPool.query(
    `update invoices set pay_link_token = $2,
            stripe_checkout_session_id = $3, stripe_checkout_session_account_id = 'platform',
            stripe_payment_requested = true, stripe_payment_status = 'pending'
      where id = $1`,
    [w.invoiceId, PAY_LINK, SESSION],
  );
  expect(res.rowCount).toBe(1);
});

/** Puts an open checkout session back on the invoice and live at Stripe, as a client reopening the pay link would. */
async function reopenSession() {
  live = new Set([SESSION]);
  const res = await testPool.query(
    `update invoices set stripe_checkout_session_id = $2, stripe_checkout_session_account_id = 'platform'
      where id = $1`,
    [w.invoiceId, SESSION],
  );
  expect(res.rowCount).toBe(1);
}

/** The session pointer is gone and the payment request, with its pay link, is still open. */
async function expectRequestOpenWithoutSession() {
  expect(await linkPointers()).toMatchObject({
    stripe_checkout_session_id: null, stripe_payment_requested: true, pay_link_token: PAY_LINK,
  });
}

describe('after the balance drops, no Stripe surface is left payable at the old balance', () => {
  it('a manual partial payment expires the checkout session and keeps the payment request open', async () => {
    expect((await linkPointers()).stripe_checkout_session_id).toBe(SESSION);

    const res = await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 400 });

    expect(res.status).toBe(200);
    expect([...live]).toEqual([]);
    await expectRequestOpenWithoutSession();
    expect((await linkPointers()).status).toBe('partially_paid');
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('marking the invoice paid expires the checkout session', async () => {
    const res = await w.owner.api.put(`${w.inv}/payment`).send({ isPaid: true });

    expect(res.status).toBe(200);
    expect([...live]).toEqual([]);
    expect((await linkPointers()).stripe_checkout_session_id).toBeNull();
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a write-off expires the checkout session and keeps the payment request open', async () => {
    const res = await w.owner.api.post(`${w.inv}/credit-note`).send({ amount: 400, type: 'write_off' });

    expect(res.status).toBe(200);
    expect([...live]).toEqual([]);
    await expectRequestOpenWithoutSession();
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('raising a payment amount expires the reopened checkout session', async () => {
    expect((await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 400 })).status).toBe(200);
    await reopenSession();

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, amount: 500 });

    expect(res.status).toBe(200);
    expect([...live]).toEqual([]);
    await expectRequestOpenWithoutSession();
    await assertInvoiceInvariants(w.invoiceId);
  });
});

describe('a balance change that does not lower what is owed leaves the links alone', () => {
  it('a note-only payment edit does not touch Stripe', async () => {
    expect((await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 400 })).status).toBe(200);
    await reopenSession();

    const res = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, note: 'check 9' });

    expect(res.status).toBe(200);
    expect([...live]).toEqual([SESSION]);
    expect((await linkPointers()).stripe_checkout_session_id).toBe(SESSION);
  });

  it('removing a credit note leaves the session closed and does not reach for Stripe', async () => {
    const add = await w.owner.api.post(`${w.inv}/credit-note`).send({ amount: 400, type: 'discount' });
    expect(add.status).toBe(200);
    expect([...live]).toEqual([]);
    const callsBefore = surfaces().reduce((n, [, fn]) => n + fn.mock.calls.length, 0);

    const res = await w.owner.api.delete(`${w.inv}/credit-note?creditNoteId=${add.body.invoice.creditNotes[0].id}`);

    expect(res.status).toBe(200);
    expect(surfaces().reduce((n, [, fn]) => n + fn.mock.calls.length, 0)).toBe(callsBefore);
    expect([...live]).toEqual([]);
    await expectRequestOpenWithoutSession();
    await assertInvoiceInvariants(w.invoiceId);
  });
});

describe('when Stripe cannot be reached', () => {
  it('the payment still commits and the invoice stays consistent', async () => {
    fakeStripe().checkout.sessions.retrieve.mockImplementation(async () => { throw new Error('stripe is down'); });

    const res = await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 400 });

    expect(res.status).toBe(200);
    expect((await linkPointers()).stripe_payment_requested).toBe(true);
    await assertInvoiceInvariants(w.invoiceId);
  });
});

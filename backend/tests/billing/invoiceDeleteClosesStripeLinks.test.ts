/**
 * Deleting an invoice closes the way to pay it, the way voiding does.
 *
 * The one payable surface is the checkout session a client opened from the
 * invoice's pay link (or the portal). Delete refuses outright when Stripe
 * reports that session complete, and otherwise expires it BEFORE the row goes,
 * so an unreachable Stripe aborts the delete instead of leaving a deleted
 * invoice with a live checkout. A hosted Stripe invoice id left on an
 * installment row by the retired per-installment path is never read.
 *
 * RED IF: an open checkout session is left open after a delete; a completed
 * session no longer refuses with 409, or something is expired before the
 * refusal; Stripe being unreachable lets the delete through; an invoice with no
 * session starts calling Stripe; a legacy row-level hosted invoice is consulted
 * again; or a direct-charge firm's calls lose `{ stripeAccount }`.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE: stripe.config is replaced wholesale.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
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

import {
  testPool, createFirm, createPersonClient, createInvoice, ownerOf, drainEvents,
  type Actor, type Firm,
} from '../support/setupInProcess';

const DIRECT_ACCOUNT = 'acct_direct_delete_links';
const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

/** What Stripe reports per object id; an id not listed is "No such object". */
let invoiceStatus: Record<string, string>;
let sessionStatus: Record<string, string>;
let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;

const deleteRoute = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}`;

const missing = (id: string) =>
  Object.assign(new Error(`No such object: '${id}'`), { code: 'resource_missing', statusCode: 404 });

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

async function invoiceExists() {
  const { rowCount } = await testPool.query('select 1 from invoices where id = $1', [invoiceId]);
  return rowCount === 1;
}

/** A whole-invoice payment request: a pay link, plus the checkout session the client opened from it. */
async function seedSession(sessionId: string) {
  const res = await testPool.query(
    `update invoices set pay_link_token = $2, stripe_checkout_session_id = $3,
            stripe_payment_requested = true, stripe_payment_status = 'pending'
      where id = $1`,
    [invoiceId, `tok_${sessionId}`, sessionId]);
  expect(res.rowCount).toBe(1);
}

async function seedInstallments(hostedIds: Array<string | null>) {
  await testPool.query('update invoices set payment_plan_enabled = true where id = $1', [invoiceId]);
  for (const [i, hosted] of hostedIds.entries()) {
    await testPool.query(
      `insert into invoice_expected_payments
         (invoice_id, law_firm_id, sort_order, due_date, amount_cents, status, stripe_invoice_id, stripe_payment_status)
       values ($1, $2, $3, current_date + 10 + $3::int, 10000, 'pending', $4, $5)`,
      [invoiceId, firm.id, i, hosted, hosted ? 'pending' : null]);
  }
}

async function goDirect() {
  await testPool.query(
    `update law_firms set stripe_account_id = $2, stripe_charges_enabled = true,
            stripe_onboarding_complete = true, direct_charges_enabled = true where id = $1`,
    [firm.id, DIRECT_ACCOUNT]);
}

beforeEach(async () => {
  invoiceStatus = {};
  sessionStatus = {};
  for (const [name, fn] of surfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  const s = fakeStripe();
  s.invoices.retrieve.mockImplementation(async (id: string) => {
    if (!invoiceStatus[id]) throw missing(id);
    return { id, status: invoiceStatus[id] };
  });
  s.invoices.voidInvoice.mockImplementation(async (id: string) => {
    invoiceStatus[id] = 'void';
    return { id, status: 'void' };
  });
  s.checkout.sessions.retrieve.mockImplementation(async (id: string) => {
    if (!sessionStatus[id]) throw missing(id);
    return { id, status: sessionStatus[id] };
  });
  s.checkout.sessions.expire.mockImplementation(async (id: string) => {
    sessionStatus[id] = 'expired';
    return { id, status: 'expired' };
  });

  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { email: 'payer@example.test' })).id;
  invoiceId = (await createInvoice(firm.id, clientId, { totalCents: 25_000 })).id;
});

describe('deleting closes the checkout session', () => {
  it('expires an open checkout session', async () => {
    sessionStatus = { cs_open: 'open' };
    await seedSession('cs_open');

    const res = await owner.api.delete(deleteRoute());

    expect(res.status).toBe(200);
    expect(fakeStripe().checkout.sessions.expire).toHaveBeenCalledWith('cs_open');
    expect(sessionStatus.cs_open).toBe('expired');
    expect(await invoiceExists()).toBe(false);
    await drainEvents();
  });

  it('makes no Stripe call for an invoice that never had a link', async () => {
    const res = await owner.api.delete(deleteRoute());

    expect(res.status).toBe(200);
    expect(fakeStripe().invoices.retrieve).not.toHaveBeenCalled();
    expect(fakeStripe().checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(await invoiceExists()).toBe(false);
    await drainEvents();
  });

  it('treats a session Stripe no longer knows as already closed', async () => {
    // Not in sessionStatus, so retrieve answers resource_missing.
    await seedSession('cs_gone');

    const res = await owner.api.delete(deleteRoute());

    expect(res.status).toBe(200);
    expect(fakeStripe().checkout.sessions.retrieve).toHaveBeenCalledWith('cs_gone');
    expect(fakeStripe().checkout.sessions.expire).not.toHaveBeenCalled();
    expect(await invoiceExists()).toBe(false);
    await drainEvents();
  });

  it('ignores a hosted invoice id left on an installment row, even one Stripe reports paid', async () => {
    invoiceStatus = { in_legacy: 'paid' };
    await seedInstallments(['in_legacy']);

    const res = await owner.api.delete(deleteRoute());

    expect(res.status).toBe(200);
    expect(fakeStripe().invoices.retrieve).not.toHaveBeenCalled();
    expect(await invoiceExists()).toBe(false);
    await drainEvents();
  });
});

describe('a session that has collected refuses the delete', () => {
  const REFUSAL = /refund the client in Stripe and remove the payment/i;

  it('refuses with 409 when a checkout session completed, and expires nothing', async () => {
    sessionStatus = { cs_done: 'complete' };
    await seedSession('cs_done');

    const res = await owner.api.delete(deleteRoute());

    expect(res.status).toBe(409);
    expect(res.body.message || res.body.error).toMatch(REFUSAL);
    expect(await invoiceExists()).toBe(true);
    expect(fakeStripe().checkout.sessions.expire).not.toHaveBeenCalled();
    expect(sessionStatus).toEqual({ cs_done: 'complete' });
  });
});

describe('Stripe cannot be reached', () => {
  let errors: jest.SpyInstance;
  let warns: jest.SpyInstance;
  afterEach(() => {
    errors.mockRestore();
    warns.mockRestore();
  });

  it('aborts the delete when the checkout session cannot be read, and the invoice stays', async () => {
    await seedSession('cs_open');
    fakeStripe().checkout.sessions.retrieve.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }));
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    warns = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await owner.api.delete(deleteRoute());

    expect(res.status).toBe(502);
    expect(res.body.message || res.body.error).toMatch(/could not reach Stripe/i);
    expect(await invoiceExists()).toBe(true);
  });

  it('aborts the delete when expiring an open session fails, and the invoice stays', async () => {
    sessionStatus = { cs_open: 'open' };
    await seedSession('cs_open');
    fakeStripe().checkout.sessions.expire.mockRejectedValue(
      Object.assign(new Error('rate limited'), { type: 'StripeRateLimitError' }));
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    warns = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await owner.api.delete(deleteRoute());

    expect(res.status).toBe(502);
    expect(res.body.message || res.body.error).toMatch(/could not reach Stripe/i);
    expect(await invoiceExists()).toBe(true);
  });
});

describe('a direct-charge firm', () => {
  it('addresses every call to its own account', async () => {
    await goDirect();
    sessionStatus = { cs_open: 'open' };
    await seedSession('cs_open');

    const res = await owner.api.delete(deleteRoute());

    expect(res.status).toBe(200);
    const onAccount = { stripeAccount: DIRECT_ACCOUNT };
    const s = fakeStripe();
    expect(s.checkout.sessions.retrieve.mock.calls).toEqual([['cs_open', {}, onAccount]]);
    expect(s.checkout.sessions.expire.mock.calls).toEqual([['cs_open', {}, onAccount]]);
    expect(await invoiceExists()).toBe(false);
    await drainEvents();
  });
});

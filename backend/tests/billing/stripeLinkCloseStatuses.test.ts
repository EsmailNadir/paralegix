/**
 * What closing an invoice's checkout session does with each status and each error.
 *
 * The one Stripe surface a void or a delete closes is the checkout session
 * opened from the invoice's pay link. An expire that fails with
 * `invalid_request_error` usually means the session changed between the read
 * and the write (the client completed it, or it expired on its own), so the
 * session is read again and judged by what it is now: expired counts as closed,
 * complete refuses with the refund message, and only a session that is still
 * open, or a genuine network or API failure, stops a delete as "could not reach
 * Stripe".
 *
 * RED IF: a session completed mid-close is reported as an outage, or deleted
 * over; a session expired mid-close blocks the delete; an invalid request on a
 * session that is still open stops being refused; a network error is no longer
 * a 502, or triggers a second read; or a void goes through over a session that
 * completed mid-close.
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

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

let sessionStatus: Record<string, string>;
let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;

const onInvoice = (suffix = '') => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}${suffix}`;
const errorText = (res: any) => String(res.body.message || res.body.error || '');

const missing = (id: string) =>
  Object.assign(new Error(`No such object: '${id}'`), { code: 'resource_missing', statusCode: 404 });
const invalidRequest = (message: string) =>
  Object.assign(new Error(message), { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error', statusCode: 400 });
const networkError = () =>
  Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' });

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

async function invoiceStatusColumn() {
  const { rows } = await testPool.query('select status from invoices where id = $1', [invoiceId]);
  return rows[0].status;
}

/** A whole-invoice pay-link request whose checkout session is `session`. */
async function seedSession(session: string) {
  const res = await testPool.query(
    `update invoices set stripe_checkout_session_id = $2, pay_link_token = $3,
            stripe_payment_requested = true, stripe_payment_status = 'pending'
      where id = $1`,
    [invoiceId, session, `tok_${invoiceId}`]);
  expect(res.rowCount).toBe(1);
}

beforeEach(async () => {
  sessionStatus = {};
  for (const [name, fn] of surfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  const s = fakeStripe();
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

describe('an expire that fails with an invalid request, on a delete', () => {
  it('counts the session as closed when it is expired by the time it is read again', async () => {
    sessionStatus = { cs_open: 'open' };
    await seedSession('cs_open');
    fakeStripe().checkout.sessions.expire.mockImplementation(async () => {
      sessionStatus.cs_open = 'expired';
      throw invalidRequest('Session already expired');
    });

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(200);
    expect(await invoiceExists()).toBe(false);
    await drainEvents();
  });

  it('refuses with the refund message when the session completed in between', async () => {
    sessionStatus = { cs_open: 'open' };
    await seedSession('cs_open');
    fakeStripe().checkout.sessions.expire.mockImplementation(async () => {
      sessionStatus.cs_open = 'complete';
      throw invalidRequest('Session is complete');
    });

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(409);
    expect(errorText(res)).toMatch(/refund the client in Stripe and remove the payment/i);
    expect(await invoiceExists()).toBe(true);
  });
});

describe('an expire that fails, on a delete, when the session is still open', () => {
  it('is a 502 after an invalid request, and the invoice stays', async () => {
    sessionStatus = { cs_open: 'open' };
    await seedSession('cs_open');
    fakeStripe().checkout.sessions.expire.mockRejectedValue(invalidRequest('Cannot expire this session'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(502);
    expect(errorText(res)).toMatch(/could not reach Stripe/i);
    expect(await invoiceExists()).toBe(true);
    errors.mockRestore();
  });

  it('is a 502 without a second read when the failure is a network error', async () => {
    sessionStatus = { cs_open: 'open' };
    await seedSession('cs_open');
    fakeStripe().checkout.sessions.expire.mockRejectedValue(networkError());
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(502);
    expect(fakeStripe().checkout.sessions.retrieve).toHaveBeenCalledTimes(1);
    expect(await invoiceExists()).toBe(true);
    errors.mockRestore();
  });
});

describe('an expire that fails because the session completed in between, on voiding the invoice', () => {
  it('refuses the void, and the invoice is not voided', async () => {
    sessionStatus = { cs_open: 'open' };
    await seedSession('cs_open');
    fakeStripe().checkout.sessions.expire.mockImplementation(async () => {
      sessionStatus.cs_open = 'complete';
      throw invalidRequest('Session is complete');
    });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await owner.api.post(onInvoice('/void'));

    expect(res.status).toBe(409);
    expect(errorText(res)).toMatch(/already paid/i);
    expect(await invoiceStatusColumn()).not.toBe('voided');
    errors.mockRestore();
  });
});

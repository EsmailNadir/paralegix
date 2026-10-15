/**
 * A manual payment keeps the pointer to a bank payment that is still settling.
 *
 * Recording a manual payment expires the open checkout session, because it was
 * priced at the old balance, and clears the invoice's pointer to it. A session
 * that is already `complete` with a bank debit still processing is not open: it
 * cannot be expired, and money is on its way through it. The pointer is what
 * makes the next checkout answer 409 PAYMENT_PROCESSING instead of letting the
 * client pay the remainder by card on top, and what void and delete use to find
 * it. So the pointer is cleared only when the session is gone for good: it was
 * open and has just been expired, it had already expired, or Stripe says it does
 * not exist. When Stripe cannot be read, nothing is known, so it stays.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE: stripe.config is replaced wholesale, and
 * every surface a case does not stub throws.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    accounts: { retrieve: fn() },
    customers: { create: fn(), list: fn(), retrieve: fn(), update: fn() },
    invoices: { create: fn(), retrieve: fn(), voidInvoice: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    paymentIntents: { create: fn(), retrieve: fn() },
  };
});

import {
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  request,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const SESSION = 'cs_ach_in_flight';
const ACCOUNT = 'acct_in_flight_express';

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

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

let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;
const token = () => `tok_${invoiceId}`;

const onInvoice = (suffix = '') => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}${suffix}`;

async function sessionPointer() {
  const { rows } = await testPool.query('select stripe_checkout_session_id from invoices where id = $1', [invoiceId]);
  return rows[0].stripe_checkout_session_id;
}

/** What Stripe answers for the session the invoice points at. */
function sessionIs(answer: () => Promise<any>) {
  fakeStripe().checkout.sessions.retrieve.mockImplementation(async (id: string) => {
    if (id !== SESSION) throw new Error(`unexpected session ${id}`);
    return answer();
  });
}

const BANK_PAYMENT_PROCESSING = async () => ({
  id: SESSION, object: 'checkout.session', status: 'complete', payment_status: 'unpaid',
  amount_total: 25_000, metadata: { paymentMethod: 'bank', invoiceAmountCents: '25000' },
});

async function recordManualPayment() {
  const res = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 100 });
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  for (const [name, fn] of surfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const connected = await testPool.query(
    `update law_firms set stripe_account_id = $2, stripe_charges_enabled = true, stripe_onboarding_complete = true
      where id = $1`, [firm.id, ACCOUNT]);
  expect(connected.rowCount).toBe(1);
  clientId = (await createPersonClient(firm.id, { email: 'ach-payer@example.test' })).id;
  invoiceId = (await createInvoice(firm.id, clientId, { totalCents: 25_000 })).id;
  const linked = await testPool.query(
    `update invoices set stripe_checkout_session_id = $2, stripe_checkout_session_account_id = 'platform',
            pay_link_token = $3, stripe_payment_requested = true, stripe_payment_status = 'pending'
      where id = $1`,
    [invoiceId, SESSION, `tok_${invoiceId}`],
  );
  expect(linked.rowCount).toBe(1);
});

describe('a bank payment still processing when a manual payment is recorded', () => {
  it('keeps the pointer, so the pay link refuses a second payment with 409', async () => {
    sessionIs(BANK_PAYMENT_PROCESSING);

    await recordManualPayment();

    expect(await sessionPointer()).toBe(SESSION);
    expect(fakeStripe().checkout.sessions.expire).not.toHaveBeenCalled();

    const res = await request().post(`/api/pay/${token()}/checkout`).send({ method: 'card' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A bank payment is already processing for this invoice. Please wait for it to complete.');
    expect(fakeStripe().checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe('the session pointer after a manual payment', () => {
  it('stays when Stripe cannot be reached', async () => {
    sessionIs(async () => { throw Object.assign(new Error('connection reset'), { type: 'StripeConnectionError' }); });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await recordManualPayment();
    } finally {
      errorSpy.mockRestore();
    }

    expect(await sessionPointer()).toBe(SESSION);
  });

  it('is cleared when Stripe has no such session', async () => {
    sessionIs(async () => {
      throw Object.assign(new Error(`No such checkout.session: '${SESSION}'`), { code: 'resource_missing', statusCode: 404 });
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await recordManualPayment();
    } finally {
      errorSpy.mockRestore();
    }

    expect(await sessionPointer()).toBeNull();
  });

  it('is cleared when the session had already expired', async () => {
    sessionIs(async () => ({ id: SESSION, status: 'expired' }));

    await recordManualPayment();

    expect(await sessionPointer()).toBeNull();
  });

  it('is cleared once an open session has been expired', async () => {
    sessionIs(async () => ({ id: SESSION, status: 'open' }));
    fakeStripe().checkout.sessions.expire.mockResolvedValue({ id: SESSION, status: 'expired' });

    await recordManualPayment();

    expect(fakeStripe().checkout.sessions.expire.mock.calls).toEqual([[SESSION]]);
    expect(await sessionPointer()).toBeNull();
  });

  it('stays when expiring the open session fails', async () => {
    sessionIs(async () => ({ id: SESSION, status: 'open' }));
    fakeStripe().checkout.sessions.expire.mockRejectedValue(
      Object.assign(new Error('connection reset'), { type: 'StripeConnectionError' }),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await recordManualPayment();
    } finally {
      errorSpy.mockRestore();
    }

    expect(await sessionPointer()).toBe(SESSION);
  });
});

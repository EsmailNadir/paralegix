/**
 * A payment link minted while an invoice is being voided or deleted never
 * outlives it.
 *
 * Voiding and deleting close the invoice's checkout session, and creating a
 * link writes its pointers afterwards. Each side used to act outside the invoice
 * row lock, so a link minted between the close and the commit survived: on a
 * void its pointers landed on a voided invoice, on a delete the link outlived
 * the row. Now both sides meet at the row lock. Creation re-checks the invoice
 * under it and withdraws the Stripe object it just made when it lost; void and
 * delete re-read the invoice under it and close any pointer that appeared
 * since their first pass.
 *
 * Every case is made deterministic the way invoiceDeleteRace is: this spec
 * holds the invoice row lock, lets the request run up to the point where it
 * blocks on it, commits the competing change from the holding transaction, then
 * releases.
 *
 * A whole-invoice request-payment makes no Stripe object: it records a pay link
 * token, and the checkout session is minted only when the client opens it. So
 * the request-payment cases assert the token never lands on a voided invoice
 * and that no Stripe object is created at all.
 *
 * RED IF: a request-payment that lost to a void leaves a pay link on the voided
 * invoice, or any request creates a Stripe object; a portal checkout that lost
 * to a void leaves its session payable, or its pointer on the voided invoice; a void or delete does not
 * close a checkout session that was opened while it waited; or a request on a
 * live invoice stops recording its pay link.
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
import { waitForInvoiceLockWaiter as waitForLock } from '../support/invoiceLockWaiter';
import { portalPath, portalPerson, seedClientInvoice } from '../clients/portalWorld';

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

/** What Stripe reports per session id; an id not listed is "No such object". */
let sessionStatus: Record<string, string>;
let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}`;
const onInvoice = (suffix = '') => `${B()}/${invoiceId}${suffix}`;
const stripeRoute = (suffix: string) => `/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}${suffix}`;
const errorText = (res: any) => String(res.body.message || res.body.error || '');

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

const waitForInvoiceLockWaiter = () =>
  waitForLock('The request never blocked on the held invoice row lock');

/**
 * Hold the row of `lockedInvoiceId`, start the request, run `inHold` once it is
 * waiting on the lock, commit, and return the request's response.
 */
async function raceWhileHeld(
  start: () => Promise<any>,
  inHold: (held: any) => Promise<void>,
  lockedInvoiceId: string = invoiceId,
) {
  const held = await testPool.connect();
  try {
    await held.query('begin');
    await held.query('select id from invoices where id = $1 for update', [lockedInvoiceId]);
    // supertest sends only once awaited, so wrap it to put the request on the wire now.
    const request = (async () => start())();
    await waitForInvoiceLockWaiter();
    await inHold(held);
    await held.query('commit');
    return await request;
  } finally {
    await held.query('rollback').catch(() => undefined);
    held.release();
  }
}

async function invoiceRow(id: string = invoiceId) {
  const { rows } = await testPool.query(
    `select status, pay_link_token, stripe_checkout_session_id, stripe_payment_requested
       from invoices where id = $1`, [id]);
  return rows[0];
}

/** A request-payment creates no Stripe object of any kind. */
function expectNoStripeObjectCreated() {
  const s = fakeStripe();
  expect(s.invoices.create).not.toHaveBeenCalled();
  expect(s.invoices.finalizeInvoice).not.toHaveBeenCalled();
  expect(s.checkout.sessions.create).not.toHaveBeenCalled();
}

/** The recipients snapshot is frozen up front so no request writes the row before the lock under test. */
async function freezeBillTo(id: string) {
  await testPool.query(
    `update invoices set billing_snapshot_at = now(), billing_emails = array['payer@example.test'],
            billing_contact_email = 'payer@example.test', billing_client_name = 'Payer' where id = $1`, [id]);
}

beforeEach(async () => {
  sessionStatus = {};
  for (const [name, fn] of surfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  const s = fakeStripe();
  s.customers.list.mockResolvedValue({ data: [] });
  s.customers.create.mockResolvedValue({ id: 'cus_race' });
  s.checkout.sessions.create.mockImplementation(async () => {
    sessionStatus.cs_made = 'open';
    return { id: 'cs_made', url: 'https://checkout.stripe.test/cs_made' };
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
  await testPool.query(
    `update law_firms set stripe_account_id = 'acct_race_firm', stripe_charges_enabled = true,
            stripe_onboarding_complete = true, direct_charges_enabled = false where id = $1`, [firm.id]);
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { email: 'payer@example.test' })).id;
  invoiceId = (await createInvoice(firm.id, clientId, { totalCents: 25_000 })).id;
  await freezeBillTo(invoiceId);
});

describe('a payment request on a live invoice', () => {
  it('records its pay link on the invoice and creates no Stripe object', async () => {
    const res = await owner.api.post(stripeRoute('/request'));

    expect(res.status).toBe(200);
    const row = await invoiceRow();
    expect(row).toMatchObject({ stripe_payment_requested: true, stripe_checkout_session_id: null });
    expect(row.pay_link_token).toEqual(expect.any(String));
    expect(res.body.paymentUrl).toContain(`/pay/${row.pay_link_token}`);
    expectNoStripeObjectCreated();
    await drainEvents();
  });
});

describe('a link that loses the race to a void', () => {
  it('leaves no pay link on the voided invoice, for a request-payment', async () => {
    const res = await raceWhileHeld(
      () => owner.api.post(stripeRoute('/request')),
      async (held) => {
        await held.query(`update invoices set status = 'voided' where id = $1`, [invoiceId]);
      },
    );

    expect(res.status).toBe(409);
    expect(errorText(res)).toMatch(/voided/i);
    expectNoStripeObjectCreated();
    expect(await invoiceRow()).toMatchObject({
      status: 'voided', pay_link_token: null, stripe_payment_requested: false,
    });
  });

  it('has its checkout session expired and no pointer left, for a portal checkout', async () => {
    const payer = await portalPerson(firm.id, 'Paula Payer');
    const invoice = await seedClientInvoice(firm.id, payer.clientId, {
      totalCents: 480_00, invoiceNumber: 'INV-RACE-1', stripePaymentRequested: true,
    });
    await freezeBillTo(invoice.id);

    const res = await raceWhileHeld(
      () => payer.api.get(portalPath(firm.id, `billing/pay/${invoice.id}?method=card`)),
      async (held) => {
        await held.query(`update invoices set status = 'voided' where id = $1`, [invoice.id]);
      },
      invoice.id,
    );

    expect(res.status).toBe(409);
    expect(sessionStatus.cs_made).toBe('expired');
    expect(fakeStripe().checkout.sessions.expire).toHaveBeenCalledWith('cs_made');
    expect(await invoiceRow(invoice.id)).toMatchObject({ status: 'voided', stripe_checkout_session_id: null });
  });
});

describe('a link that loses the race to a delete', () => {
  it('is refused with nothing left at Stripe, for a request-payment', async () => {
    const res = await raceWhileHeld(
      () => owner.api.post(stripeRoute('/request')),
      async (held) => {
        await held.query('delete from invoices where id = $1', [invoiceId]);
      },
    );

    expect(res.status).toBe(404);
    expect(await invoiceRow()).toBeUndefined();
    expectNoStripeObjectCreated();
    await drainEvents();
  });
});

describe('a checkout session opened while a void waits for the lock', () => {
  const mintLateLink = (held: any) => held.query(
    `update invoices set pay_link_token = 'tok_late', stripe_checkout_session_id = 'cs_late',
            stripe_payment_requested = true, stripe_payment_status = 'pending' where id = $1`, [invoiceId]);

  it('is closed by the void before it commits', async () => {
    sessionStatus.cs_late = 'open';

    const res = await raceWhileHeld(
      () => owner.api.post(onInvoice('/void')),
      mintLateLink,
    );

    expect(res.status).toBe(200);
    expect(sessionStatus.cs_late).toBe('expired');
    expect(fakeStripe().checkout.sessions.expire).toHaveBeenCalledWith('cs_late');
    expect(await invoiceRow()).toMatchObject({
      status: 'voided', pay_link_token: null, stripe_checkout_session_id: null, stripe_payment_requested: false,
    });
  });

  it('refuses the void when that session completed, and leaves the invoice as it was', async () => {
    sessionStatus.cs_late = 'complete';

    const res = await raceWhileHeld(
      () => owner.api.post(onInvoice('/void')),
      mintLateLink,
    );

    expect(res.status).toBe(409);
    expect(errorText(res)).toMatch(/already paid/i);
    expect(fakeStripe().checkout.sessions.expire).not.toHaveBeenCalled();
    expect(await invoiceRow()).toMatchObject({
      status: 'outstanding', pay_link_token: 'tok_late', stripe_checkout_session_id: 'cs_late',
    });
  });
});

describe('a checkout session opened while a delete waits for the lock', () => {
  const mintLateLink = (held: any) => held.query(
    `update invoices set pay_link_token = 'tok_late', stripe_checkout_session_id = 'cs_late',
            stripe_payment_requested = true, stripe_payment_status = 'pending' where id = $1`, [invoiceId]);

  it('is closed by the delete before the row goes', async () => {
    sessionStatus.cs_late = 'open';

    const res = await raceWhileHeld(
      () => owner.api.delete(onInvoice()),
      mintLateLink,
    );

    expect(res.status).toBe(200);
    expect(sessionStatus.cs_late).toBe('expired');
    expect(fakeStripe().checkout.sessions.expire).toHaveBeenCalledWith('cs_late');
    expect(await invoiceRow()).toBeUndefined();
    await drainEvents();
  });

  it('refuses the delete when that session completed, and the invoice stays', async () => {
    sessionStatus.cs_late = 'complete';

    const res = await raceWhileHeld(
      () => owner.api.delete(onInvoice()),
      mintLateLink,
    );

    expect(res.status).toBe(409);
    expect(fakeStripe().checkout.sessions.expire).not.toHaveBeenCalled();
    expect(await invoiceRow()).toMatchObject({ stripe_checkout_session_id: 'cs_late' });
  });
});

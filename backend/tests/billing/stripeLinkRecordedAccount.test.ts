/**
 * A checkout session is torn down on the account it was created on, not on the
 * account the firm's charges point at today. (A payment request is a pay link;
 * the Stripe object behind it is the checkout session minted when the client
 * opens it, from the link or from the portal.)
 *
 * A link is created on the firm's own connected account for a direct-charge
 * firm and on the platform for a destination-charge one. A firm can switch
 * between the two afterwards, and Stripe only finds an object on the account
 * it lives on, so teardown addressed by the CURRENT setup got "No such object",
 * swallowed it, and left the old link payable. The account is therefore
 * recorded beside the session id when the session is made ('platform' or the
 * acct_ id) and used at teardown. A row with nothing recorded predates the
 * columns and still falls back to the firm's current setup.
 *
 * RED IF: a link created under one charge model is torn down against the other
 * after a switch (it stays live); a row with nothing recorded stops falling
 * back to the current setup; or a checkout session (portal or pay link) is
 * stored without the account it was created on.
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
import { request } from '../support/app';
import { portalPath, portalPerson, seedClientInvoice } from '../clients/portalWorld';

const FIRM_ACCOUNT = 'acct_recorded_firm';
const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

type Kind = 'direct' | 'platform';

/** Open Stripe objects by id, with the account each lives on (null: the platform). */
let live: Map<string, string | null>;
let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;

const accountOf = (opts: any): string | null =>
  (opts && typeof opts.stripeAccount === 'string' ? opts.stripeAccount : null);

function find(id: string, opts: any) {
  if (!live.has(id) || live.get(id) !== accountOf(opts)) {
    throw Object.assign(new Error(`No such object: '${id}'`), { code: 'resource_missing', statusCode: 404 });
  }
}

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

/** Put the firm on direct charges, or on destination charges (both are connected). */
async function setFirmKind(kind: Kind) {
  const res = await testPool.query(
    `update law_firms set stripe_account_id = $2, stripe_charges_enabled = true,
            stripe_onboarding_complete = true, direct_charges_enabled = $3 where id = $1`,
    [firm.id, FIRM_ACCOUNT, kind === 'direct']);
  expect(res.rowCount).toBe(1);
}

/** The account a link made under `kind` lives on, as Stripe sees it. */
const liveAccountFor = (kind: Kind) => (kind === 'direct' ? FIRM_ACCOUNT : null);
/** The value the app should have recorded for it. */
const recordedFor = (kind: Kind) => (kind === 'direct' ? FIRM_ACCOUNT : 'platform');
const other = (kind: Kind): Kind => (kind === 'direct' ? 'platform' : 'direct');

/** An open pay-link request whose checkout session was made under `kind`, with `account` recorded. */
async function seedSession(kind: Kind, account: string | null) {
  live.set('cs_top', liveAccountFor(kind));
  const res = await testPool.query(
    `update invoices set stripe_checkout_session_id = 'cs_top', stripe_checkout_session_account_id = $2,
            pay_link_token = $3, stripe_payment_requested = true, stripe_payment_status = 'pending'
      where id = $1`,
    [invoiceId, account, `tok_${invoiceId}`]);
  expect(res.rowCount).toBe(1);
}

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}`;
const onInvoice = (suffix = '') => `${B()}/${invoiceId}${suffix}`;
const stripeRoute = (suffix: string) => `/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}${suffix}`;

beforeEach(async () => {
  live = new Map();
  for (const [name, fn] of surfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  const s = fakeStripe();
  s.checkout.sessions.retrieve.mockImplementation(async (id: string, _p: any, opts: any) => {
    find(id, opts);
    return { id, status: 'open' };
  });
  s.checkout.sessions.expire.mockImplementation(async (id: string, _p: any, opts: any) => {
    find(id, opts);
    live.delete(id);
    return { id, status: 'expired' };
  });

  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { email: 'payer@example.test' })).id;
  invoiceId = (await createInvoice(firm.id, clientId, { totalCents: 25_000 })).id;
});

describe.each<Kind>(['direct', 'platform'])('a link created under %s charges, after the firm switches', (made) => {
  const now = other(made);
  beforeEach(() => setFirmKind(now));

  it('is closed when the invoice is deleted', async () => {
    await seedSession(made, recordedFor(made));

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(200);
    expect([...live.keys()]).toEqual([]);
    await drainEvents();
  });

  it('has the recorded session account cleared with the session id and the pay link when the invoice is voided', async () => {
    await seedSession(made, recordedFor(made));

    const res = await owner.api.post(onInvoice('/void'));

    expect(res.status).toBe(200);
    expect(live.has('cs_top')).toBe(false);
    const { rows } = await testPool.query(
      `select stripe_checkout_session_id, stripe_checkout_session_account_id, pay_link_token
         from invoices where id = $1`, [invoiceId]);
    expect(rows[0]).toEqual({
      stripe_checkout_session_id: null, stripe_checkout_session_account_id: null, pay_link_token: null,
    });
  });

  it('has its checkout session expired by voidPaymentRequest', async () => {
    await seedSession(made, recordedFor(made));

    const res = await owner.api.post(stripeRoute('/void'));

    expect(res.status).toBe(200);
    expect(live.has('cs_top')).toBe(false);
  });

  it('has its checkout session expired when a manual payment changes the balance', async () => {
    await seedSession(made, recordedFor(made));

    const res = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 100 });

    expect(res.status).toBe(200);
    expect(live.has('cs_top')).toBe(false);
  });

  it('has its checkout session expired when a line-item edit changes the total', async () => {
    await seedSession(made, recordedFor(made));

    const res = await owner.api.patch(onInvoice('/line-items')).send({
      timeEntries: [], flatFees: [{ description: 'Fixed fee', amount: 300 }], expenses: [],
    });

    expect(res.status).toBe(200);
    expect([...live.keys()]).toEqual([]);
  });
});

describe('a row with no recorded account', () => {
  it.each<Kind>(['direct', 'platform'])('is torn down against the current %s setup', async (kind) => {
    await setFirmKind(kind);
    await seedSession(kind, null);

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(200);
    expect([...live.keys()]).toEqual([]);
    await drainEvents();
  });

  it('is not found, so the delete still goes through, when the setup has since changed', async () => {
    // Legacy behaviour kept on purpose: with nothing recorded the current setup
    // is the only guess, and a wrong guess reads "No such object" (gone).
    await setFirmKind('platform');
    await seedSession('direct', null);

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(200);
    // The retrieve was addressed to the platform (the current guess) and missed.
    expect(fakeStripe().checkout.sessions.retrieve.mock.calls).toEqual([['cs_top']]);
    expect(live.has('cs_top')).toBe(true);
    await drainEvents();
  });
});

describe.each<Kind>(['direct', 'platform'])('creating a link under %s charges', (kind) => {
  beforeEach(async () => {
    await setFirmKind(kind);
    const s = fakeStripe();
    s.customers.list.mockResolvedValue({ data: [] });
    s.customers.create.mockResolvedValue({ id: 'cus_recorded' });
    s.checkout.sessions.create.mockImplementation(async (_params: any, opts: any) => {
      live.set('cs_made', accountOf(opts));
      return { id: 'cs_made', url: 'https://checkout.stripe.test/cs_made' };
    });
  });

  it('records the account on a pay-link checkout session, and teardown after a switch still reaches it', async () => {
    const res = await owner.api.post(stripeRoute('/request'));
    expect(res.status).toBe(200);
    // The request itself is a pay link: no Stripe customer or invoice is made.
    expect(fakeStripe().customers.create).not.toHaveBeenCalled();
    expect(fakeStripe().invoices.create).not.toHaveBeenCalled();
    const { rows: [requested] } = await testPool.query(
      'select pay_link_token, stripe_checkout_session_id from invoices where id = $1', [invoiceId]);
    expect(requested.pay_link_token).toEqual(expect.any(String));
    expect(requested.stripe_checkout_session_id).toBeNull();

    const pay = await request().post(`/api/pay/${requested.pay_link_token}/checkout`).send({ method: 'card' });
    expect(pay.status).toBe(200);
    expect(live.get('cs_made')).toBe(liveAccountFor(kind));

    const { rows } = await testPool.query(
      'select stripe_checkout_session_id, stripe_checkout_session_account_id from invoices where id = $1',
      [invoiceId]);
    expect(rows[0]).toEqual({
      stripe_checkout_session_id: 'cs_made', stripe_checkout_session_account_id: recordedFor(kind),
    });

    await setFirmKind(other(kind));
    const del = await owner.api.delete(onInvoice());
    expect(del.status).toBe(200);
    expect(live.has('cs_made')).toBe(false);
    await drainEvents();
  });

  it('records the account on a portal checkout session, and teardown after a switch still reaches it', async () => {
    const payer = await portalPerson(firm.id, 'Paula Payer');
    const invoice = await seedClientInvoice(firm.id, payer.clientId, {
      totalCents: 480_00, invoiceNumber: 'INV-REC-1', stripePaymentRequested: true,
    });
    await testPool.query(
      `update invoices set invoice_name = 'INV-REC-1', stripe_payment_status = 'pending' where id = $1`, [invoice.id]);

    const res = await payer.api.get(portalPath(firm.id, `billing/pay/${invoice.id}?method=card`));
    expect(res.status).toBe(200);

    const { rows } = await testPool.query(
      'select stripe_checkout_session_id, stripe_checkout_session_account_id from invoices where id = $1',
      [invoice.id]);
    expect(rows[0]).toEqual({
      stripe_checkout_session_id: 'cs_made', stripe_checkout_session_account_id: recordedFor(kind),
    });

    await setFirmKind(other(kind));
    const del = await owner.api.delete(
      `/api/lawfirms/${firm.id}/billing/invoices/client/${payer.clientId}/${invoice.id}`);
    expect(del.status).toBe(200);
    expect(live.has('cs_made')).toBe(false);
    await drainEvents();
  });
});

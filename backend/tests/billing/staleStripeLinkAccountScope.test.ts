/**
 * Tearing down a stale Stripe payment link addresses the account the link
 * lives on.
 *
 * A whole-invoice payment request is a pay link; the Stripe object behind it
 * is the Checkout Session minted when the client opens the link. A
 * direct-charge firm's session is created ON its own connected account. Stripe
 * only finds such an object when the call carries `{ stripeAccount }`;
 * addressed on the platform it answers "No such checkout session". Three
 * teardown paths must address it there: deleting the invoice, a manual payment
 * that changes the balance, and a line-item edit that changes the total. A
 * swallowed 404 with the local pointer cleared anyway looks fine on screen
 * while the old session stays payable at the superseded amount.
 *
 * After a balance change only the session is expired: the payment request
 * itself stays open, because the pay link prices from the current balance.
 *
 * RED IF: deleteInvoice or expireStaleCheckoutSession drops the firm's account
 * for a direct-charge firm (the session is still live at the end), adds an
 * account for a platform (destination-charge) firm, or a balance change
 * cancels the payment request instead of only expiring the session.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE: stripe.config is replaced wholesale,
 * and every surface a case does not stub throws.
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
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const DIRECT_ACCOUNT = 'acct_direct_stale_links';
const EXPRESS_ACCOUNT = 'acct_express_stale_links';
const SESSION = 'cs_stale_link';

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

type FirmKind = 'direct' | 'platform';

/** Open Stripe objects by id, with the account each lives on (null: the platform). */
let live: Map<string, string | null>;
let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}`;
const onInvoice = (suffix = '') => `${B()}/${invoiceId}${suffix}`;

/** The exact arguments a call naming `id` must carry for this kind of firm. */
const argsFor = (kind: FirmKind, id: string) =>
  (kind === 'direct' ? [id, {}, { stripeAccount: DIRECT_ACCOUNT }] : [id]);

function accountOf(opts: any): string | null {
  return opts && typeof opts.stripeAccount === 'string' ? opts.stripeAccount : null;
}

/** Stripe's behaviour: an object is only found on the account it was created on. */
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

/** Put the firm on direct charges, or on a connected Express account with destination charges. */
async function connectFirm(kind: FirmKind) {
  const res = await testPool.query(
    `update law_firms set stripe_account_id = $2, stripe_charges_enabled = true,
            stripe_onboarding_complete = true, direct_charges_enabled = $3
      where id = $1`,
    [firm.id, kind === 'direct' ? DIRECT_ACCOUNT : EXPRESS_ACCOUNT, kind === 'direct'],
  );
  expect(res.rowCount).toBe(1);
}

/** An open pay-link request whose checkout session lives on the account the firm's charges use. */
async function seedLiveSession(kind: FirmKind) {
  live.set(SESSION, kind === 'direct' ? DIRECT_ACCOUNT : null);
  const res = await testPool.query(
    `update invoices set stripe_checkout_session_id = $2, pay_link_token = $3,
            stripe_payment_requested = true, stripe_payment_status = 'pending'
      where id = $1`,
    [invoiceId, SESSION, `tok_${invoiceId}`],
  );
  expect(res.rowCount).toBe(1);
}

async function stripePointers() {
  const { rows } = await testPool.query(
    `select stripe_checkout_session_id, stripe_checkout_session_account_id, stripe_payment_requested,
            stripe_payment_status, pay_link_token, amount_paid_cents
       from invoices where id = $1`, [invoiceId]);
  return rows[0];
}

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

describe.each<FirmKind>(['direct', 'platform'])('a %s-charge firm', (kind) => {
  beforeEach(() => connectFirm(kind));

  it('deleting the invoice expires its checkout session where it lives', async () => {
    await seedLiveSession(kind);

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(200);
    // The link is dead at Stripe. For a direct firm addressed on the platform
    // the retrieve 404s and nothing is expired, so this goes red.
    expect([...live.keys()]).toEqual([]);
    expect(fakeStripe().checkout.sessions.retrieve.mock.calls).toEqual([argsFor(kind, SESSION)]);
    expect(fakeStripe().checkout.sessions.expire.mock.calls).toEqual([argsFor(kind, SESSION)]);
    const { rowCount } = await testPool.query('select 1 from invoices where id = $1', [invoiceId]);
    expect(rowCount).toBe(0);
  });

  it('a manual payment expires the session priced at the old balance and keeps the request open', async () => {
    await seedLiveSession(kind);

    const res = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 100 });

    expect(res.status).toBe(200);
    expect([...live.keys()]).toEqual([]);
    expect(fakeStripe().checkout.sessions.expire.mock.calls).toEqual([argsFor(kind, SESSION)]);
    // Only the session pointer is cleared; the pay link still works and prices
    // from the new balance.
    expect(await stripePointers()).toMatchObject({
      stripe_checkout_session_id: null,
      stripe_checkout_session_account_id: null,
      stripe_payment_requested: true,
      stripe_payment_status: 'pending',
      pay_link_token: `tok_${invoiceId}`,
      amount_paid_cents: '10000',
    });
  });

  it('a line-item edit that changes the total expires the session and keeps the request open', async () => {
    await seedLiveSession(kind);

    const res = await owner.api.patch(onInvoice('/line-items')).send({
      timeEntries: [], flatFees: [{ description: 'Fixed fee', amount: 300 }], expenses: [],
    });

    expect(res.status).toBe(200);
    expect([...live.keys()]).toEqual([]);
    expect(fakeStripe().checkout.sessions.expire.mock.calls).toEqual([argsFor(kind, SESSION)]);
    expect(await stripePointers()).toMatchObject({
      stripe_checkout_session_id: null,
      stripe_payment_requested: true,
      stripe_payment_status: 'pending',
      pay_link_token: `tok_${invoiceId}`,
    });
  });
});

describe('regressions on the same paths', () => {
  beforeEach(() => connectFirm('direct'));

  it('makes no Stripe call when the invoice never had a link', async () => {
    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(200);
    expect(fakeStripe().checkout.sessions.retrieve).not.toHaveBeenCalled();
    await drainEvents();
  });

  it('refuses to delete when Stripe cannot be reached, so no link outlives the invoice', async () => {
    await seedLiveSession('direct');
    fakeStripe().checkout.sessions.retrieve.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBeGreaterThanOrEqual(500);
    const { rowCount } = await testPool.query('select 1 from invoices where id = $1', [invoiceId]);
    expect(rowCount).toBe(1);
    warn.mockRestore();
  });
});

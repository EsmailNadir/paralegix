/**
 * The Stripe Connect surface: whether a firm (or one of its trust accounts) is
 * connected, who may ask, and who may disconnect it.
 *
 * `stripeApplicationFee.test.ts` pins the platform fee arithmetic and
 * `stripePaymentGuards.test.ts` pins the payment-request guards. Neither touches
 * the eight `/api/stripe/connect` and `/api/stripe/trust-connect` routes, which
 * is where these rules live:
 *
 *   STATUS IS READABLE, THE ACCOUNT IS NOT MANAGEABLE. Firm status needs only
 *   `billing.viewInvoices` (not baseline), but creating, disconnecting or opening the
 *   Express dashboard needs `settings.manageFirm`. The dashboard link exposes
 *   payout and bank data, so it is deliberately on the stricter gate rather than
 *   the same one as status.
 *
 *   THE TRUST SIDE IS PER ACCOUNT, NOT PER FIRM. A firm may hold several trust
 *   accounts, each with its own connected bank, so every trust route carries a
 *   `trustAccountId` and must refuse one belonging to another firm.
 *
 *   THE LOCAL MIRROR FOLLOWS STRIPE. `charges_enabled` and `details_submitted`
 *   are re-read from Stripe on every status call and written back, so a firm that
 *   finished onboarding in Stripe's UI stops being told it has not.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE. `stripe.config` is replaced wholesale
 * below, and any surface a test does not deliberately stub throws rather than
 * returning, so an unexpected reach for the API fails loudly instead of hanging.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const refuse = (name: string) => jest.fn(() => {
    throw new Error(`stripe.${name} was called; this spec must not reach the Stripe API`);
  });

  return {
    accounts: {
      create: refuse('accounts.create'),
      retrieve: refuse('accounts.retrieve'),
      update: refuse('accounts.update'),
      createLoginLink: refuse('accounts.createLoginLink'),
      del: refuse('accounts.del'),
    },
    accountLinks: { create: refuse('accountLinks.create') },
    customers: { create: refuse('customers.create') },
    checkout: { sessions: { create: refuse('checkout.sessions.create') } },
    paymentIntents: { create: refuse('paymentIntents.create') },
    invoices: { create: refuse('invoices.create') },
  };
});

import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

let firm: Firm;
let owner: Actor;
/** Baseline only: holds `billing.viewInvoices` and `trust.view`, neither manage code. */
let baseline: Actor;
let otherFirm: Firm;
let otherOwner: Actor;
let trustAccountId: string;

const CONNECT = (lawFirmId: string, suffix = '') => `/api/stripe/connect/${lawFirmId}${suffix}`;
const TRUST_CONNECT = (lawFirmId: string, accountId: string, suffix = '') =>
  `/api/stripe/trust-connect/${lawFirmId}/${accountId}${suffix}`;

/** A trust account, written directly so no Stripe surface is touched. */
async function seedTrustAccount(lawFirmId: string, overrides: Record<string, any> = {}) {
  const id = randomUUID();
  await testPool.query(
    `insert into trust_accounts
       (id, law_firm_id, name, bank_name, account_number_last4, account_type,
        stripe_connected_account_id, stripe_charges_enabled, stripe_onboarding_complete)
     values ($1, $2, 'IOLTA', 'First Legal Bank', '9876', 'iolta', $3, $4, $5)`,
    [
      id, lawFirmId,
      overrides.stripeConnectedAccountId ?? null,
      overrides.stripeChargesEnabled ?? false,
      overrides.stripeOnboardingComplete ?? false,
    ],
  );
  return id;
}

async function firmRow(lawFirmId: string) {
  const { rows } = await testPool.query('select * from law_firms where id = $1', [lawFirmId]);
  return rows[0];
}

async function trustRow(id: string) {
  const { rows } = await testPool.query('select * from trust_accounts where id = $1', [id]);
  return rows[0];
}

beforeEach(async () => {
  // The mock factory runs once per module registry, so the `jest.fn`s keep their
  // call history across tests. Several cases below assert that Stripe was NOT
  // reached, and without this they would see a call an earlier test made.
  // `clearAllMocks`, not `resetAllMocks`: the latter would strip the throwing
  // implementations the factory installed and turn an unexpected SDK call into a
  // silent `undefined`.
  jest.clearAllMocks();

  firm = await createFirm({ name: 'Stripe Ops Firm' });
  owner = await ownerOf(firm.id);
  baseline = await memberWith(firm.id, []);
  trustAccountId = await seedTrustAccount(firm.id);

  otherFirm = await createFirm({ name: 'Neighbour LLP' });
  otherOwner = await ownerOf(otherFirm.id);
});

describe('firm connect status', () => {
  it('reports a firm that has never connected as disconnected', async () => {
    const res = await owner.api.get(CONNECT(firm.id, '/status'));

    expect(res.status).toBe(200);
    // Every field, not just `connected`. The billing screen reads each one to
    // decide which of the three onboarding states to render, and a missing
    // boolean renders as "not yet" for a firm that is fully live.
    expect(res.body).toEqual({
      connected: false,
      directCharges: false,
      stripeAccountId: null,
      chargesEnabled: false,
      payoutsEnabled: false,
      onboardingComplete: false,
    });
    // Nothing was asked of Stripe: there is no account id to ask about.
    expect(fakeStripe().accounts.retrieve).not.toHaveBeenCalled();
  });

  it('re-reads the live status from Stripe for a connected firm', async () => {
    await testPool.query(
      `update law_firms set stripe_account_id = 'acct_live', stripe_charges_enabled = false,
                            stripe_onboarding_complete = false
        where id = $1`, [firm.id],
    );
    fakeStripe().accounts.retrieve.mockResolvedValueOnce({
      id: 'acct_live', charges_enabled: true, payouts_enabled: true, details_submitted: true,
    });

    const res = await owner.api.get(CONNECT(firm.id, '/status'));

    // The stored mirror said false for both. Serving the stale copy would tell a
    // firm that finished onboarding in Stripe's own UI that it still has not.
    expect(res.body).toMatchObject({
      connected: true, stripeAccountId: 'acct_live',
      chargesEnabled: true, payoutsEnabled: true, onboardingComplete: true,
    });
    expect(fakeStripe().accounts.retrieve).toHaveBeenCalledWith('acct_live');
  });

  it('writes the refreshed status back to the firm row', async () => {
    await testPool.query(
      `update law_firms set stripe_account_id = 'acct_live' where id = $1`, [firm.id],
    );
    fakeStripe().accounts.retrieve.mockResolvedValueOnce({
      id: 'acct_live', charges_enabled: true, payouts_enabled: true, details_submitted: true,
    });

    await owner.api.get(CONNECT(firm.id, '/status'));

    // The mirror is what every OTHER code path reads, including the payment
    // guard that refuses a charge on a firm with charges disabled. A status call
    // that answered correctly without updating it would leave payments refused.
    expect(await firmRow(firm.id)).toMatchObject({
      stripe_charges_enabled: true, stripe_onboarding_complete: true,
    });
  });

  it('falls back to the stored mirror when Stripe cannot be reached', async () => {
    await testPool.query(
      `update law_firms set stripe_account_id = 'acct_live', stripe_charges_enabled = true,
                            stripe_onboarding_complete = true
        where id = $1`, [firm.id],
    );
    fakeStripe().accounts.retrieve.mockRejectedValueOnce(new Error('Stripe is down'));

    const res = await owner.api.get(CONNECT(firm.id, '/status'));

    // A Stripe outage must not read as "this firm is not connected", which is
    // what would send a live firm back through onboarding.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true, chargesEnabled: true, onboardingComplete: true,
    });
    // Unknown rather than assumed: payouts cannot be read from the local mirror.
    expect(res.body.payoutsEnabled).toBe(false);
  });

  it('refuses a member whose role grants nothing the status', async () => {
    // Gated on `billing.viewInvoices`, which is not baseline, so the status needs
    // an explicit grant.
    const res = await baseline.api.get(CONNECT(firm.id, '/status'));

    expect(res.status).toBe(403);
    expect(res.body.connected).toBeUndefined();
  });

  it('does not report another firm status', async () => {
    await testPool.query(
      `update law_firms set stripe_account_id = 'acct_theirs' where id = $1`, [otherFirm.id],
    );

    const res = await owner.api.get(CONNECT(otherFirm.id, '/status'));

    // Seeded first, so the refusal cannot pass as an unconfigured firm.
    expect(res.status).toBe(403);
    expect(fakeStripe().accounts.retrieve).not.toHaveBeenCalled();
  });
});

describe('managing the firm connected account', () => {
  it('refuses a baseline member the dashboard link', async () => {
    await testPool.query(
      `update law_firms set stripe_account_id = 'acct_live' where id = $1`, [firm.id],
    );

    const res = await baseline.api.get(CONNECT(firm.id, '/dashboard-link'));

    // The Express dashboard shows payouts and bank details, so it sits on
    // `settings.manageFirm` rather than the invoice-view gate that guards status.
    // Testing status alone would miss a gate that had been levelled to match it.
    expect(res.status).toBe(403);
    expect(fakeStripe().accounts.createLoginLink).not.toHaveBeenCalled();
  });

  it('refuses a baseline member the disconnect', async () => {
    await testPool.query(
      `update law_firms set stripe_account_id = 'acct_live' where id = $1`, [firm.id],
    );

    const res = await baseline.api.delete(CONNECT(firm.id));

    expect(res.status).toBe(403);
    // The row is the assertion: disconnecting a live account stops every client
    // payment the firm is expecting.
    expect(await firmRow(firm.id)).toMatchObject({ stripe_account_id: 'acct_live' });
  });

  it('refuses a member of another firm every connect route', async () => {
    const status = await otherOwner.api.get(CONNECT(firm.id, '/status'));
    const link = await otherOwner.api.get(CONNECT(firm.id, '/dashboard-link'));
    const create = await otherOwner.api.post(CONNECT(firm.id, '/create-account')).send({});
    const remove = await otherOwner.api.delete(CONNECT(firm.id));

    expect([status.status, link.status, create.status, remove.status])
      .toEqual([403, 403, 403, 403]);
    expect(await firmRow(firm.id)).toMatchObject({ stripe_account_id: null });
  });

  it('answers rather than throwing when there is no account to link to', async () => {
    const res = await owner.api.get(CONNECT(firm.id, '/dashboard-link'));

    // A firm that has not onboarded yet reaches this route from the same screen.
    // It must be a clean refusal, not a 500 from a null account id.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('trust connect status', () => {
  it('reports a trust account with no connected bank as disconnected', async () => {
    const res = await owner.api.get(TRUST_CONNECT(firm.id, trustAccountId, '/status'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      connected: false, chargesEnabled: false, payoutsEnabled: false, onboardingComplete: false,
    });
  });

  it('re-reads the live status for a connected trust account', async () => {
    const connected = await seedTrustAccount(firm.id, {
      stripeConnectedAccountId: 'acct_trust', stripeChargesEnabled: false,
    });
    fakeStripe().accounts.retrieve.mockResolvedValueOnce({
      id: 'acct_trust', charges_enabled: true, payouts_enabled: false, details_submitted: true,
    });

    const res = await owner.api.get(TRUST_CONNECT(firm.id, connected, '/status'));

    expect(res.body).toMatchObject({ connected: true, chargesEnabled: true, onboardingComplete: true });
    expect(fakeStripe().accounts.retrieve).toHaveBeenCalledWith('acct_trust');
  });

  it('writes the refreshed trust status back to the account row', async () => {
    const connected = await seedTrustAccount(firm.id, {
      stripeConnectedAccountId: 'acct_trust',
    });
    fakeStripe().accounts.retrieve.mockResolvedValueOnce({
      id: 'acct_trust', charges_enabled: true, payouts_enabled: false, details_submitted: true,
    });

    await owner.api.get(TRUST_CONNECT(firm.id, connected, '/status'));

    expect(await trustRow(connected)).toMatchObject({
      stripe_charges_enabled: true, stripe_onboarding_complete: true,
    });
  });

  it('keeps two trust accounts of one firm apart', async () => {
    const live = await seedTrustAccount(firm.id, { stripeConnectedAccountId: 'acct_one' });
    fakeStripe().accounts.retrieve.mockResolvedValueOnce({
      id: 'acct_one', charges_enabled: true, payouts_enabled: false, details_submitted: true,
    });

    const liveStatus = await owner.api.get(TRUST_CONNECT(firm.id, live, '/status'));
    const otherStatus = await owner.api.get(TRUST_CONNECT(firm.id, trustAccountId, '/status'));

    // The whole reason these routes carry an account id: a firm may hold several
    // trust banks, and connecting one must not report the others as connected.
    expect(liveStatus.body.connected).toBe(true);
    expect(otherStatus.body.connected).toBe(false);
  });

  it('does not serve a trust account belonging to another firm', async () => {
    const theirs = await seedTrustAccount(otherFirm.id, {
      stripeConnectedAccountId: 'acct_theirs',
    });

    const res = await owner.api.get(TRUST_CONNECT(firm.id, theirs, '/status'));

    // A real, connected account at another firm. The refusal is the tenant scope,
    // not a missing row, and Stripe is never asked about it.
    expect(res.status).toBe(404);
    expect(fakeStripe().accounts.retrieve).not.toHaveBeenCalled();
  });

  it('refuses a member whose role grants nothing the trust status', async () => {
    const read = await baseline.api.get(TRUST_CONNECT(firm.id, trustAccountId, '/status'));

    // `trust.view` is not baseline, so the trust status needs an explicit grant.
    expect(read.status).toBe(403);
    expect(read.body.connected).toBeUndefined();
  });
});

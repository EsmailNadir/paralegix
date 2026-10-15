/**
 * Stripe Connect onboarding and disconnection, for a firm's OPERATING account and
 * for a TRUST account's own connected account, driven through the real routes.
 *
 * What makes these routes dangerous is invisible on screen:
 *
 *   - The operating account and a trust account are separate connected accounts
 *     so client trust money never settles into operating revenue. Onboarding a
 *     trust account must write `trust_accounts.stripe_connected_account_id` and
 *     leave `law_firms.stripe_account_id` alone, and the reverse.
 *   - Payout hardening differs by kind. An operating account may let Stripe
 *     debit its bank to cover a clawback (`debit_negative_balances: true`). A
 *     trust account's bank is an IOLTA holding client money and must NEVER be
 *     auto-debited, so it gets `false`. Flip that boolean and a dispute silently
 *     takes one client's money out of trust to cover another's charge.
 *   - A trust account cannot be disconnected while its Stripe balance still holds
 *     funds, or that money is stranded off-ledger.
 *
 * So every case asserts the exact argument object handed to Stripe and the
 * resulting row, not a status code.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE. `stripe.config` is replaced by the object
 * in the `jest.mock` factory below. Every SDK surface is a `jest.fn` that THROWS
 * unless a case stubs it, and `beforeEach` puts every one back to throwing, so an
 * unexpected reach for the API fails the request loudly instead of returning
 * `undefined`.
 */

jest.mock('../../src/modules/stripe/stripe.config', () => {
  const refuse = () => jest.fn();
  return {
    accounts: {
      create: refuse(),
      retrieve: refuse(),
      update: refuse(),
      createLoginLink: refuse(),
    },
    accountLinks: { create: refuse() },
    balance: { retrieve: refuse() },
    customers: { create: refuse(), retrieve: refuse(), update: refuse() },
    invoices: { create: refuse(), retrieve: refuse(), voidInvoice: refuse(), finalizeInvoice: refuse() },
    invoiceItems: { create: refuse() },
    checkout: { sessions: { create: refuse(), retrieve: refuse(), expire: refuse() } },
    paymentIntents: { create: refuse(), retrieve: refuse(), list: refuse() },
  };
});

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

// Read once at module load by stripe.service.ts. Deleted before the first request
// loads the app so the production default (7 business days) is what runs and
// what the assertions below spell out.
delete process.env.STRIPE_CONNECT_PAYOUT_DELAY_DAYS;
const PAYOUT_DELAY_DAYS = 7;

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

/** Every jest.fn on the fake, with its dotted path. */
function fakeSurfaces(node: any = fakeStripe(), path = ''): Array<[string, jest.Mock]> {
  const out: Array<[string, jest.Mock]> = [];
  for (const [key, value] of Object.entries(node)) {
    const name = path ? `${path}.${key}` : key;
    if (jest.isMockFunction(value)) out.push([name, value as jest.Mock]);
    else if (value && typeof value === 'object') out.push(...fakeSurfaces(value, name));
  }
  return out;
}

/** Total calls across every Stripe surface. Zero means Stripe was never reached. */
const stripeCallCount = () => fakeSurfaces().reduce((sum, [, fn]) => sum + fn.mock.calls.length, 0);

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  // Back to refusing on every surface, so a stub one case installed cannot
  // quietly answer a call in the next.
  for (const [name, fn] of fakeSurfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }

  firm = await createFirm({ name: 'Onboarding & Partners' });
  owner = await ownerOf(firm.id);
});

async function firmStripeRow(lawFirmId: string) {
  const { rows } = await testPool.query(
    `select stripe_account_id, stripe_charges_enabled, stripe_onboarding_complete
       from law_firms where id = $1`,
    [lawFirmId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function connectFirm(lawFirmId: string, accountId: string) {
  const res = await testPool.query(
    `update law_firms
        set stripe_account_id = $2, stripe_charges_enabled = true, stripe_onboarding_complete = true
      where id = $1`,
    [lawFirmId, accountId],
  );
  expect(res.rowCount).toBe(1);
}

async function seedTrustAccount(
  lawFirmId: string,
  overrides: { name?: string; connectedAccountId?: string | null; chargesEnabled?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into trust_accounts
       (id, law_firm_id, name, account_type, status, book_balance_cents,
        stripe_connected_account_id, stripe_charges_enabled, stripe_onboarding_complete)
     values ($1, $2, $3, 'iolta', 'active', 0, $4, $5, $5)`,
    [
      id,
      lawFirmId,
      overrides.name ?? 'Client Funds IOLTA',
      overrides.connectedAccountId ?? null,
      overrides.chargesEnabled ?? false,
    ],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function trustStripeRow(trustAccountId: string) {
  const { rows } = await testPool.query(
    `select stripe_connected_account_id, stripe_charges_enabled, stripe_onboarding_complete, updated_by
       from trust_accounts where id = $1`,
    [trustAccountId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/* ------------------------------------------------------------------ */
/*  Operating account: POST /connect/:lawFirmId/create-account         */
/* ------------------------------------------------------------------ */

describe('POST /api/stripe/connect/:lawFirmId/create-account', () => {
  const url = () => `/api/stripe/connect/${firm.id}/create-account`;

  function stubHappyOnboarding(accountId = 'acct_new_operating') {
    const stripe = fakeStripe();
    stripe.accounts.create.mockResolvedValue({ id: accountId });
    stripe.accounts.update.mockResolvedValue({ id: accountId });
    stripe.accountLinks.create.mockResolvedValue({ url: `https://connect.stripe.test/${accountId}` });
  }

  it('refuses the owner of another firm and creates nothing', async () => {
    stubHappyOnboarding();
    const otherFirm = await createFirm();
    const outsider = await ownerOf(otherFirm.id);

    const res = await outsider.api.post(url());

    // Breaks if the route loses `requirePermission` AND the service loses its
    // membership check: a stranger would mint a connected account against a
    // firm they do not belong to and point its payouts at their own bank.
    expect(res.status).toBe(403);
    expect(stripeCallCount()).toBe(0);
    expect((await firmStripeRow(firm.id)).stripe_account_id).toBeNull();
  });

  it('refuses a member without settings.manageFirm and creates nothing', async () => {
    stubHappyOnboarding();
    const biller = await memberWith(firm.id, ['billing.recordPayments']);

    const res = await biller.api.post(url());

    // Breaks if the route's permission code is widened to a billing one.
    expect(res.status).toBe(403);
    expect(stripeCallCount()).toBe(0);
    expect((await firmStripeRow(firm.id)).stripe_account_id).toBeNull();
  });

  it('creates a Standard account tagged with the firm and stores it, not yet chargeable', async () => {
    stubHappyOnboarding('acct_op_1');

    const res = await owner.api.post(url());

    expect(res.status).toBe(200);
    const stripe = fakeStripe();
    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
    // Breaks if the account type, the capabilities, or the metadata that lets
    // `account.updated` find this firm again changes. Standard (full dashboard,
    // the firm pays fees, Stripe carries losses) is what takes invoice-payment
    // liability off Paralegix; stripeDirectCharges.test.ts covers the charges.
    expect(stripe.accounts.create).toHaveBeenCalledWith({
      controller: {
        fees: { payer: 'account' },
        losses: { payments: 'stripe' },
        stripe_dashboard: { type: 'full' },
        requirement_collection: 'stripe',
      },
      metadata: { lawFirmId: firm.id },
      business_type: 'company',
      company: { name: 'Onboarding & Partners' },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    // Breaks if the id is not persisted, or if a fresh account is stored as
    // already able to take payments before Stripe says it can.
    expect(await firmStripeRow(firm.id)).toEqual({
      stripe_account_id: 'acct_op_1',
      stripe_charges_enabled: false,
      stripe_onboarding_complete: false,
    });

    expect(res.body).toEqual({ url: 'https://connect.stripe.test/acct_op_1', accountId: 'acct_op_1' });
    expect(stripe.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_op_1',
      refresh_url: `${FRONTEND_URL}/lawfirm/${firm.id}/settings/payments?stripe=refresh`,
      return_url: `${FRONTEND_URL}/lawfirm/${firm.id}/settings/payments?stripe=return`,
      type: 'account_onboarding',
    });
  });

  it('leaves a Standard account\'s payout settings to the firm', async () => {
    stubHappyOnboarding('acct_op_2');

    const res = await owner.api.post(url());

    expect(res.status).toBe(200);
    // Breaks if onboarding tries to rewrite payout settings the platform does not
    // control on a Standard account. Trust accounts keep payout hardening (below).
    expect(fakeStripe().accounts.update).not.toHaveBeenCalled();
  });

  it('resumes onboarding for an already-connected firm without creating a second account', async () => {
    await connectFirm(firm.id, 'acct_existing_op');
    fakeStripe().accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.test/resume' });

    const res = await owner.api.post(url());

    expect(res.status).toBe(200);
    // Breaks if the "already has an account" branch is removed: every click
    // would orphan the firm's real account and replace it with an empty one.
    expect(fakeStripe().accounts.create).not.toHaveBeenCalled();
    expect(fakeStripe().accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'acct_existing_op', type: 'account_onboarding' }),
    );
    expect(res.body).toEqual({ url: 'https://connect.stripe.test/resume', accountId: 'acct_existing_op' });
    expect((await firmStripeRow(firm.id)).stripe_account_id).toBe('acct_existing_op');
  });
});

/* ------------------------------------------------------------------ */
/*  Operating account: DELETE /connect/:lawFirmId                      */
/* ------------------------------------------------------------------ */

describe('DELETE /api/stripe/connect/:lawFirmId', () => {
  const url = () => `/api/stripe/connect/${firm.id}`;

  it('refuses the owner of another firm and leaves the account connected', async () => {
    await connectFirm(firm.id, 'acct_keep_me');
    const otherFirm = await createFirm();
    const outsider = await ownerOf(otherFirm.id);

    const res = await outsider.api.delete(url());

    // Breaks if cross-firm callers reach `disconnectAccount`: a stranger could
    // switch off a firm's payment collection.
    expect(res.status).toBe(403);
    expect((await firmStripeRow(firm.id)).stripe_account_id).toBe('acct_keep_me');
  });

  it('refuses a member without settings.manageFirm', async () => {
    await connectFirm(firm.id, 'acct_keep_me_too');
    const biller = await memberWith(firm.id, ['billing.recordPayments']);

    const res = await biller.api.delete(url());

    expect(res.status).toBe(403);
    expect((await firmStripeRow(firm.id)).stripe_account_id).toBe('acct_keep_me_too');
  });

  it('clears the account and both readiness flags, for this firm only', async () => {
    await connectFirm(firm.id, 'acct_going_away');
    const neighbour = await createFirm();
    await connectFirm(neighbour.id, 'acct_neighbour');

    const res = await owner.api.delete(url());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ disconnected: true });
    // Breaks if either flag is left true: `requestPayment` gates on
    // `stripe_charges_enabled`, and a stale true with a null account would send
    // a destination charge to nowhere.
    expect(await firmStripeRow(firm.id)).toEqual({
      stripe_account_id: null,
      stripe_charges_enabled: false,
      stripe_onboarding_complete: false,
    });
    // Breaks if the update loses its firm scope.
    expect((await firmStripeRow(neighbour.id)).stripe_account_id).toBe('acct_neighbour');
    // Local only: the Stripe account itself is never deleted.
    expect(stripeCallCount()).toBe(0);
  });

  it('answers 400 when nothing is connected', async () => {
    const res = await owner.api.delete(url());

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('No Stripe account connected');
  });
});

/* ------------------------------------------------------------------ */
/*  Trust account: POST /trust-connect/.../create-account              */
/* ------------------------------------------------------------------ */

describe('POST /api/stripe/trust-connect/:lawFirmId/:trustAccountId/create-account', () => {
  const url = (trustAccountId: string, lawFirmId = firm.id) =>
    `/api/stripe/trust-connect/${lawFirmId}/${trustAccountId}/create-account`;

  function stubHappyTrustOnboarding(accountId = 'acct_new_trust') {
    const stripe = fakeStripe();
    stripe.accounts.create.mockResolvedValue({ id: accountId });
    stripe.accounts.update.mockResolvedValue({ id: accountId });
    stripe.accountLinks.create.mockResolvedValue({ url: `https://connect.stripe.test/${accountId}` });
  }

  it('refuses the owner of another firm and creates nothing', async () => {
    stubHappyTrustOnboarding();
    const trustAccountId = await seedTrustAccount(firm.id);
    const otherFirm = await createFirm();
    const outsider = await ownerOf(otherFirm.id);

    const res = await outsider.api.post(url(trustAccountId));

    expect(res.status).toBe(403);
    expect(stripeCallCount()).toBe(0);
    expect((await trustStripeRow(trustAccountId)).stripe_connected_account_id).toBeNull();
  });

  it('refuses a member holding only trust.view', async () => {
    stubHappyTrustOnboarding();
    const trustAccountId = await seedTrustAccount(firm.id);
    // `trust.view` lets this caller SEE the trust account; only `trust.manage`
    // may connect a bank to it.
    const viewer = await memberWith(firm.id, ['trust.view']);

    const res = await viewer.api.post(url(trustAccountId));

    expect(res.status).toBe(403);
    expect(stripeCallCount()).toBe(0);
    expect((await trustStripeRow(trustAccountId)).stripe_connected_account_id).toBeNull();
  });

  it("refuses another firm's trust account named under the caller's own firm", async () => {
    stubHappyTrustOnboarding();
    const otherFirm = await createFirm();
    const theirTrust = await seedTrustAccount(otherFirm.id, { name: 'Their IOLTA' });

    // The owner passes the permission gate for THEIR firm; only the service's
    // firm-scoped lookup stands between them and the other firm's account.
    const res = await owner.api.post(url(theirTrust));

    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
    expect((await trustStripeRow(theirTrust)).stripe_connected_account_id).toBeNull();
  });

  it('creates a trust-tagged Express account and stores it on the trust account only', async () => {
    stubHappyTrustOnboarding('acct_trust_1');
    const trustAccountId = await seedTrustAccount(firm.id, { name: 'Smith IOLTA' });

    const res = await owner.api.post(url(trustAccountId));

    expect(res.status).toBe(200);
    // Breaks if `trustAccountId` or `purpose: 'trust'` drop out of the metadata:
    // `account.updated` and the deposit handlers use them to route a trust
    // account's events back to the right ledger.
    expect(fakeStripe().accounts.create).toHaveBeenCalledWith({
      type: 'express',
      metadata: { lawFirmId: firm.id, trustAccountId, purpose: 'trust' },
      business_type: 'company',
      company: { name: 'Smith IOLTA' },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    });

    expect(await trustStripeRow(trustAccountId)).toEqual({
      stripe_connected_account_id: 'acct_trust_1',
      stripe_charges_enabled: false,
      stripe_onboarding_complete: false,
      updated_by: owner.uid,
    });
    // Breaks if the trust path writes the firm's OPERATING account column:
    // client trust deposits would then settle into operating funds.
    expect((await firmStripeRow(firm.id)).stripe_account_id).toBeNull();

    expect(res.body).toEqual({ url: 'https://connect.stripe.test/acct_trust_1', accountId: 'acct_trust_1' });
    expect(fakeStripe().accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_trust_1',
      refresh_url: `${FRONTEND_URL}/lawfirm/${firm.id}/trust?stripe=refresh`,
      return_url: `${FRONTEND_URL}/lawfirm/${firm.id}/trust?stripe=return`,
      type: 'account_onboarding',
    });
  });

  it('delays payouts but NEVER lets Stripe debit the trust bank', async () => {
    stubHappyTrustOnboarding('acct_trust_2');
    const trustAccountId = await seedTrustAccount(firm.id);

    const res = await owner.api.post(url(trustAccountId));

    expect(res.status).toBe(200);
    // Breaks if `{ trust: true }` is dropped from the onboarding call, or if
    // `debit_negative_balances: !trust` is inverted: Stripe would then be
    // allowed to pull a clawback straight out of an IOLTA account.
    expect(fakeStripe().accounts.update).toHaveBeenCalledTimes(1);
    expect(fakeStripe().accounts.update).toHaveBeenCalledWith('acct_trust_2', {
      settings: {
        payouts: {
          schedule: { interval: 'daily', delay_days: PAYOUT_DELAY_DAYS },
          debit_negative_balances: false,
        },
      },
    });
  });

  it('resumes onboarding for an already-connected trust account without creating a second one', async () => {
    const trustAccountId = await seedTrustAccount(firm.id, { connectedAccountId: 'acct_trust_existing' });
    fakeStripe().accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.test/trust-resume' });

    const res = await owner.api.post(url(trustAccountId));

    expect(res.status).toBe(200);
    expect(fakeStripe().accounts.create).not.toHaveBeenCalled();
    expect(fakeStripe().accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'acct_trust_existing', type: 'account_onboarding' }),
    );
    expect(res.body.accountId).toBe('acct_trust_existing');
  });
});

/* ------------------------------------------------------------------ */
/*  Trust account: dashboard link                                       */
/* ------------------------------------------------------------------ */

describe('GET /api/stripe/trust-connect/:lawFirmId/:trustAccountId/dashboard-link', () => {
  const url = (trustAccountId: string) => `/api/stripe/trust-connect/${firm.id}/${trustAccountId}/dashboard-link`;

  it('refuses the owner of another firm and mints no login link', async () => {
    const trustAccountId = await seedTrustAccount(firm.id, { connectedAccountId: 'acct_trust_dash_x' });
    fakeStripe().accounts.createLoginLink.mockResolvedValue({ url: 'https://dash.stripe.test/leak' });
    const outsider = await ownerOf((await createFirm()).id);

    const res = await outsider.api.get(url(trustAccountId));

    // A login link is a live session on the trust bank's Stripe dashboard.
    expect(res.status).toBe(403);
    expect(fakeStripe().accounts.createLoginLink).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('dash.stripe.test');
  });

  it('refuses a member holding only trust.view', async () => {
    const trustAccountId = await seedTrustAccount(firm.id, { connectedAccountId: 'acct_trust_dash_v' });
    fakeStripe().accounts.createLoginLink.mockResolvedValue({ url: 'https://dash.stripe.test/leak' });
    const viewer = await memberWith(firm.id, ['trust.view']);

    const res = await viewer.api.get(url(trustAccountId));

    expect(res.status).toBe(403);
    expect(fakeStripe().accounts.createLoginLink).not.toHaveBeenCalled();
  });

  it("opens the TRUST account's dashboard, not the firm's operating one", async () => {
    await connectFirm(firm.id, 'acct_operating_dash');
    const trustAccountId = await seedTrustAccount(firm.id, { connectedAccountId: 'acct_trust_dash' });
    fakeStripe().accounts.createLoginLink.mockResolvedValue({ url: 'https://dash.stripe.test/trust' });

    const res = await owner.api.get(url(trustAccountId));

    // Breaks if the service reads `law_firms.stripe_account_id` here: the firm
    // would land in its operating dashboard believing it was the trust bank.
    expect(res.status).toBe(200);
    expect(fakeStripe().accounts.createLoginLink).toHaveBeenCalledTimes(1);
    expect(fakeStripe().accounts.createLoginLink).toHaveBeenCalledWith('acct_trust_dash');
    expect(res.body).toEqual({ url: 'https://dash.stripe.test/trust' });
  });

  it('answers 400 when the trust account has no bank connected', async () => {
    const trustAccountId = await seedTrustAccount(firm.id);

    const res = await owner.api.get(url(trustAccountId));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('No trust bank account connected');
    expect(stripeCallCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Trust account: DELETE (disconnect)                                  */
/* ------------------------------------------------------------------ */

describe('DELETE /api/stripe/trust-connect/:lawFirmId/:trustAccountId', () => {
  const url = (trustAccountId: string) => `/api/stripe/trust-connect/${firm.id}/${trustAccountId}`;

  it('refuses the owner of another firm and leaves the bank connected', async () => {
    const trustAccountId = await seedTrustAccount(firm.id, { connectedAccountId: 'acct_trust_keep', chargesEnabled: true });
    fakeStripe().balance.retrieve.mockResolvedValue({ available: [], pending: [] });
    const outsider = await ownerOf((await createFirm()).id);

    const res = await outsider.api.delete(url(trustAccountId));

    expect(res.status).toBe(403);
    expect(stripeCallCount()).toBe(0);
    expect((await trustStripeRow(trustAccountId)).stripe_connected_account_id).toBe('acct_trust_keep');
  });

  it('refuses a member holding only trust.view', async () => {
    const trustAccountId = await seedTrustAccount(firm.id, { connectedAccountId: 'acct_trust_keep_v', chargesEnabled: true });
    fakeStripe().balance.retrieve.mockResolvedValue({ available: [], pending: [] });
    const viewer = await memberWith(firm.id, ['trust.view']);

    const res = await viewer.api.delete(url(trustAccountId));

    expect(res.status).toBe(403);
    expect((await trustStripeRow(trustAccountId)).stripe_connected_account_id).toBe('acct_trust_keep_v');
  });

  it("checks the trust account's own Stripe balance, then clears the connection when it is empty", async () => {
    const trustAccountId = await seedTrustAccount(firm.id, { connectedAccountId: 'acct_trust_empty', chargesEnabled: true });
    fakeStripe().balance.retrieve.mockResolvedValue({
      available: [{ amount: 0, currency: 'usd' }],
      pending: [{ amount: 0, currency: 'usd' }],
    });

    const res = await owner.api.delete(url(trustAccountId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ disconnected: true });
    // Breaks if the balance is read on the platform account (no
    // `stripeAccount`) instead of the connected one.
    expect(fakeStripe().balance.retrieve).toHaveBeenCalledWith({ stripeAccount: 'acct_trust_empty' });
    expect(await trustStripeRow(trustAccountId)).toEqual({
      stripe_connected_account_id: null,
      stripe_charges_enabled: false,
      stripe_onboarding_complete: false,
      updated_by: owner.uid,
    });
  });

  it('refuses while the connected account still holds an available balance', async () => {
    const trustAccountId = await seedTrustAccount(firm.id, { connectedAccountId: 'acct_trust_funded', chargesEnabled: true });
    fakeStripe().balance.retrieve.mockResolvedValue({
      available: [{ amount: 12_345, currency: 'usd' }],
      pending: [],
    });

    const res = await owner.api.delete(url(trustAccountId));

    // Breaks if the balance guard is removed: $123.45 of client money would be
    // left in a Stripe account the firm can no longer see from Paralegix.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STRIPE_TRUST_HAS_BALANCE');
    expect(await trustStripeRow(trustAccountId)).toMatchObject({
      stripe_connected_account_id: 'acct_trust_funded',
      stripe_charges_enabled: true,
    });
  });

  it('counts a NEGATIVE pending balance as outstanding, not as money that cancels out', async () => {
    const trustAccountId = await seedTrustAccount(firm.id, { connectedAccountId: 'acct_trust_negative', chargesEnabled: true });
    // A returned ACH deposit leaves the account owing. Summed with signs, this
    // would read as zero and let the firm walk away from the debt.
    fakeStripe().balance.retrieve.mockResolvedValue({
      available: [{ amount: 0, currency: 'usd' }],
      pending: [{ amount: -5_000, currency: 'usd' }],
    });

    const res = await owner.api.delete(url(trustAccountId));

    // Breaks if `Math.abs` is dropped from the balance sum.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STRIPE_TRUST_HAS_BALANCE');
    expect((await trustStripeRow(trustAccountId)).stripe_connected_account_id).toBe('acct_trust_negative');
  });

  it('refuses to disconnect when Stripe cannot report the balance', async () => {
    const trustAccountId = await seedTrustAccount(firm.id, { connectedAccountId: 'acct_trust_unknown', chargesEnabled: true });
    fakeStripe().balance.retrieve.mockRejectedValue(new Error('network unreachable'));

    const res = await owner.api.delete(url(trustAccountId));

    // Fails closed: an unverifiable balance might be client money still in Stripe.
    // Breaks if an unreadable balance is treated as an empty one.
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('STRIPE_TRUST_BALANCE_UNKNOWN');
    expect((await trustStripeRow(trustAccountId)).stripe_connected_account_id).toBe('acct_trust_unknown');
  });
});

/* ------------------------------------------------------------------ */
/*  From onboarding to the first deposit: no application fee on trust   */
/* ------------------------------------------------------------------ */

describe('a trust account onboarded through the route', () => {
  it('receives an electronic deposit in full, with no application fee, to its own account', async () => {
    const stripe = fakeStripe();
    stripe.accounts.create.mockResolvedValue({ id: 'acct_trust_deposit' });
    stripe.accounts.update.mockResolvedValue({});
    stripe.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.test/deposit' });
    stripe.customers.create.mockResolvedValue({ id: 'cus_trust_payer' });
    stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_trust', url: 'https://checkout.stripe.test/cs_trust' });

    // The firm also has an OPERATING account, so a deposit routed there would
    // have somewhere to go and the destination assertion below has teeth.
    await connectFirm(firm.id, 'acct_operating_not_for_trust');
    const trustAccountId = await seedTrustAccount(firm.id, { name: 'Deposit IOLTA' });

    const onboarded = await owner.api.post(`/api/stripe/trust-connect/${firm.id}/${trustAccountId}/create-account`);
    expect(onboarded.status).toBe(200);

    // Stripe finishing onboarding arrives as `account.updated`; its handler is
    // covered elsewhere, so the outcome is set directly here.
    const ready = await testPool.query(
      `update trust_accounts set stripe_charges_enabled = true, stripe_onboarding_complete = true
        where id = $1 and stripe_connected_account_id = 'acct_trust_deposit'`,
      [trustAccountId],
    );
    expect(ready.rowCount).toBe(1);
    const optIn = await testPool.query(
      `update law_firms
          set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{trust}',
                                   '{"electronicTrustDepositsAllowed": true}'::jsonb, true),
              plan = coalesce(plan, '{}'::jsonb) || '{"stripeCustomerId": "cus_firm_subscription"}'::jsonb
        where id = $1`,
      [firm.id],
    );
    expect(optIn.rowCount).toBe(1);
    const client = await createPersonClient(firm.id, { name: 'Dana Depositor', email: 'dana@example.test' });

    const res = await owner.api.post(`/api/stripe/trust/${firm.id}/request-deposit`).send({
      trustAccountId, clientId: client.id, amountCents: 750_00,
    });

    expect(res.status).toBe(200);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const params = stripe.checkout.sessions.create.mock.calls[0][0];
    // Breaks if an `application_fee_amount` is ever added to the trust
    // deposit, at either level: client trust funds must land in full.
    expect(params.payment_intent_data).not.toHaveProperty('application_fee_amount');
    expect(params).not.toHaveProperty('application_fee_amount');
    // Breaks if the destination is the firm's operating account.
    expect(params.payment_intent_data.transfer_data).toEqual({ destination: 'acct_trust_deposit' });
    expect(params.line_items[0].price_data.unit_amount).toBe(75_000);
    expect(params.payment_method_types).toEqual(['us_bank_account']);
    expect(params.payment_intent_data.metadata).toMatchObject({
      lawFirmId: firm.id, trustAccountId, clientId: client.id, depositType: 'trust',
    });
  });
});

/* ------------------------------------------------------------------ */
/*  updateConnectPayoutSettings: the backfill script's entry point       */
/* ------------------------------------------------------------------ */

// No route reaches this function directly: onboarding goes through the
// swallowing `applyConnectPayoutHardening` wrapper (covered above), and the only
// other caller is `scripts/harden-connect-payouts.ts`, which needs a FAILURE to
// surface so it can report which accounts were not hardened. So it is called
// directly here.
describe('updateConnectPayoutSettings', () => {
  const service = () => require('../../src/modules/stripe/stripe.service');

  it('rethrows a Stripe failure instead of swallowing it', async () => {
    fakeStripe().accounts.update.mockRejectedValue(new Error('account is restricted'));

    // Breaks if the swallow-and-warn from the onboarding wrapper migrates into
    // this function: the backfill would report every account as hardened.
    await expect(service().updateConnectPayoutSettings('acct_backfill', { trust: false }))
      .rejects.toThrow('account is restricted');
  });

  it('refuses a missing account id without calling Stripe', async () => {
    await expect(service().updateConnectPayoutSettings(null, { trust: true }))
      .rejects.toThrow('accountId is required');
    expect(stripeCallCount()).toBe(0);
  });

  it('writes the trust shape for a trust account and the operating shape by default', async () => {
    fakeStripe().accounts.update.mockResolvedValue({});

    await service().updateConnectPayoutSettings('acct_backfill_trust', { trust: true });
    await service().updateConnectPayoutSettings('acct_backfill_op');

    const calls = fakeStripe().accounts.update.mock.calls;
    expect(calls).toEqual([
      ['acct_backfill_trust', { settings: { payouts: { schedule: { interval: 'daily', delay_days: 7 }, debit_negative_balances: false } } }],
      // Breaks if the default flips to trust: every operating account the
      // backfill touches would lose clawback recovery from its own bank.
      ['acct_backfill_op', { settings: { payouts: { schedule: { interval: 'daily', delay_days: 7 }, debit_negative_balances: true } } }],
    ]);
  });
});

export {};

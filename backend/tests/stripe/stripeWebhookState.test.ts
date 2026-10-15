/**
 * What each Stripe webhook event type actually DOES to the row it names.
 *
 * `webhookIdempotency.test.ts` already covers the two things that sit in front
 * of every handler: signature verification and the `stripe_events` claim. It
 * deliberately picks an event whose metadata matches nothing, so no handler ever
 * changes a row. This file is the other half: the same real route, real
 * signature, real Postgres, but with metadata that resolves to a seeded firm,
 * trust account or invoice, so the assertion is the persisted state.
 *
 * The events chosen are exactly those whose handlers make NO outbound Stripe
 * call: `account.updated`, `invoice.voided` (acknowledged and ignored),
 * `checkout.session.expired` and `checkout.session.async_payment_failed`.
 * Everything they do is a database decision.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE. `stripe.config` is replaced wholesale by
 * the object built in the `jest.mock` factory below. The real `Stripe` client is
 * never constructed in this module registry, so there is no HTTP client to reach
 * the network with, and `STRIPE_SECRET_KEY` from `.env` is never read. The one
 * genuine Stripe function the fake carries is `Stripe.webhooks`, a static that
 * does an HMAC-SHA256 compare through Node's crypto with no I/O at all. Every
 * other SDK surface the service touches is present only as a function that
 * throws, so a handler that reached for one would fail the test loudly rather
 * than silently bill a real account.
 *
 * The state guards matter more than the happy paths.
 * `handleCheckoutAsyncPaymentFailed` refuses to act on an invoice already marked
 * `completed`, because Stripe does not order its deliveries: a failure event
 * emitted before a payment can arrive after it, and applying it would wipe the
 * record of money that actually arrived.
 *
 * An invoice payment request is a pay link (`pay_link_token`) with a checkout
 * session minted when the client opens it. No hosted Stripe invoice is ever
 * created for one, so an `invoice.voided` delivery is not about a payment
 * request and must change nothing.
 */

// The fake stands in for the whole `stripe.config` module. Built inside the
// factory because a `jest.mock` factory may not close over anything but a
// `mock`-prefixed binding, and the fake has to exist before the app graph loads.
jest.mock('../../src/modules/stripe/stripe.config', () => {
  // `require`, not `import`: the package's ESM entry does not parse under Jest,
  // and `stripe.config.ts` in the app requires it the same way.
  const StripeLib = require('stripe');

  /** Any SDK surface a handler is not supposed to reach. Loud, not silent. */
  const refuse = (name: string) => () => {
    throw new Error(`stripe.${name} was called; this spec must not reach the Stripe API`);
  };

  return {
    // The only real Stripe code in this file. A pure static: HMAC compare, no
    // client, no key, no network.
    webhooks: StripeLib.webhooks,
    invoices: {
      create: refuse('invoices.create'),
      retrieve: refuse('invoices.retrieve'),
      voidInvoice: refuse('invoices.voidInvoice'),
      finalizeInvoice: refuse('invoices.finalizeInvoice'),
    },
    invoiceItems: { create: refuse('invoiceItems.create') },
    customers: { create: refuse('customers.create') },
    accounts: {
      create: refuse('accounts.create'),
      retrieve: refuse('accounts.retrieve'),
      update: refuse('accounts.update'),
      createLoginLink: refuse('accounts.createLoginLink'),
    },
    accountLinks: { create: refuse('accountLinks.create') },
    checkout: {
      sessions: {
        create: refuse('checkout.sessions.create'),
        retrieve: refuse('checkout.sessions.retrieve'),
        expire: refuse('checkout.sessions.expire'),
      },
    },
    paymentIntents: {
      create: refuse('paymentIntents.create'),
      retrieve: refuse('paymentIntents.retrieve'),
      list: refuse('paymentIntents.list'),
    },
    transfers: { createReversal: refuse('transfers.createReversal') },
  };
});

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  drainEvents,
  type Firm,
} from '../support/setupInProcess';
import { request } from '../support/app';

const Stripe = require('stripe');

const WEBHOOK_SECRET = 'whsec_webhook_state_spec_secret';

let eventCounter = 0;
/** Unique per delivery so the `stripe_events` claim never dedupes one case into another. */
const nextEventId = () => `evt_state_${eventCounter++}_${randomUUID().slice(0, 8)}`;

/** Wrap a Stripe object in the event envelope the route unwraps. */
function envelope(type: string, object: any) {
  return JSON.stringify({
    id: nextEventId(),
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
}

/**
 * POST a genuinely-signed webhook, the way Stripe would, and fail the test if
 * the route did not accept it. A 400 here would mean signature verification
 * rejected the delivery and no handler ran at all, which would turn every
 * "the row is unchanged" assertion below into a false green.
 */
async function deliver(payload: string) {
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const res = await request()
    .post('/api/webhooks/stripe')
    .set('stripe-signature', signature)
    // The STRING, not a Buffer. supertest re-encodes a Buffer body, so the bytes
    // `express.raw()` hands to `constructEvent` would no longer match what was
    // signed and every delivery would fail verification.
    .set('content-type', 'application/json')
    .send(payload);
  await drainEvents();
  expect(res.status).toBe(200);
  return res;
}

/** The Stripe payment-request columns on an invoice row, read straight from Postgres. */
async function invoiceStripeState(invoiceId: string) {
  const { rows } = await testPool.query(
    `select stripe_payment_status, stripe_checkout_session_id, stripe_payment_requested,
            pay_link_token
       from invoices where id = $1`,
    [invoiceId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Record the Stripe account the checkout session was created on, as session creation does. */
async function recordSessionAccount(invoiceId: string) {
  const res = await testPool.query(
    `update invoices set stripe_checkout_session_account_id = 'platform' where id = $1`,
    [invoiceId],
  );
  expect(res.rowCount).toBe(1);
}

async function recordedSessionAccount(invoiceId: string) {
  const { rows } = await testPool.query(
    'select stripe_checkout_session_account_id from invoices where id = $1',
    [invoiceId],
  );
  expect(rows).toHaveLength(1);
  return rows[0].stripe_checkout_session_account_id;
}

async function firmConnectState(lawFirmId: string) {
  const { rows } = await testPool.query(
    `select stripe_charges_enabled, stripe_onboarding_complete
       from law_firms where id = $1`,
    [lawFirmId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Seed an invoice already carrying a requested Stripe payment: a pay link with an open checkout session. */
async function seedRequestedInvoice(
  firmId: string,
  overrides: {
    sessionId?: string | null;
    paymentStatus?: string | null;
  } = {},
) {
  const client = await createPersonClient(firmId, { email: 'payer@example.test' });
  const invoice = await createInvoice(firmId, client.id, { totalCents: 250_00 });
  const result = await testPool.query(
    `update invoices
        set stripe_checkout_session_id = $2,
            stripe_payment_status = $3,
            stripe_payment_requested = true,
            pay_link_token = $4
      where id = $1`,
    [
      invoice.id,
      overrides.sessionId ?? 'cs_seeded',
      overrides.paymentStatus ?? 'pending',
      `tok_${invoice.id}`,
    ],
  );
  // The seed is the premise of every assertion below; an update that matched no
  // row would leave the columns at their defaults and quietly change what is
  // being tested.
  expect(result.rowCount).toBe(1);
  // `context_type = 'client'` on the factory invoice, with the client itself as
  // the context entity, so this is the metadata pair the handlers resolve on.
  return { invoiceId: invoice.id, contextType: 'client', entityId: client.id };
}

beforeAll(() => {
  // Set before the first request, which is when the app graph is first required.
  // Assigned rather than defaulted: whatever `.env` holds must not decide which
  // secret this file signs with.
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

describe('account.updated', () => {
  const accountEvent = (id: string, chargesEnabled: boolean, detailsSubmitted: boolean) => envelope(
    'account.updated',
    { id, object: 'account', charges_enabled: chargesEnabled, details_submitted: detailsSubmitted },
  );

  it("caches a firm's connected-account status onto its law_firms row", async () => {
    const firm = await createFirm();
    const accountId = `acct_firm_${randomUUID().slice(0, 8)}`;
    const seeded = await testPool.query(
      `update law_firms set stripe_account_id = $2 where id = $1`,
      [firm.id, accountId],
    );
    expect(seeded.rowCount).toBe(1);

    await deliver(accountEvent(accountId, true, true));

    // These two booleans are the gate on `requestPayment`: a firm whose
    // `stripe_charges_enabled` never flips to true after onboarding cannot
    // collect anything, and one left true after Stripe disables charges collects
    // into an account that will reject the charge.
    expect(await firmConnectState(firm.id)).toEqual({
      stripe_charges_enabled: true,
      stripe_onboarding_complete: true,
    });
  });

  it('clears the cached flags when Stripe reports the account can no longer charge', async () => {
    const firm = await createFirm();
    const accountId = `acct_firm_${randomUUID().slice(0, 8)}`;
    await testPool.query(
      `update law_firms
          set stripe_account_id = $2, stripe_charges_enabled = true,
              stripe_onboarding_complete = true
        where id = $1`,
      [firm.id, accountId],
    );
    expect((await firmConnectState(firm.id)).stripe_charges_enabled).toBe(true);

    await deliver(accountEvent(accountId, false, false));

    // The handler reads `account.charges_enabled || false`. A version that only
    // ever wrote `true` would satisfy the case above and leave a suspended firm
    // able to keep issuing payment links.
    expect(await firmConnectState(firm.id)).toEqual({
      stripe_charges_enabled: false,
      stripe_onboarding_complete: false,
    });
  });

  it("routes a TRUST connected account to its trust_accounts row, not the firm's", async () => {
    const firm = await createFirm();
    const firmAccountId = `acct_firm_${randomUUID().slice(0, 8)}`;
    const trustAccountId = randomUUID();
    const trustConnectedId = `acct_trust_${randomUUID().slice(0, 8)}`;

    await testPool.query(
      `update law_firms set stripe_account_id = $2 where id = $1`,
      [firm.id, firmAccountId],
    );
    const seededTrust = await testPool.query(
      `insert into trust_accounts
         (id, law_firm_id, name, account_type, status, stripe_connected_account_id)
       values ($1, $2, 'Spec IOLTA', 'iolta', 'active', $3)`,
      [trustAccountId, firm.id, trustConnectedId],
    );
    expect(seededTrust.rowCount).toBe(1);

    await deliver(accountEvent(trustConnectedId, true, true));

    const { rows } = await testPool.query(
      `select stripe_charges_enabled, stripe_onboarding_complete
         from trust_accounts where id = $1`,
      [trustAccountId],
    );
    expect(rows[0]).toEqual({ stripe_charges_enabled: true, stripe_onboarding_complete: true });

    // The firm's OPERATING account is a different Stripe account with a different
    // bank behind it. Client trust money settles into the trust connected
    // account; marking the operating account chargeable off a trust event would
    // be the commingling the two-account split exists to prevent.
    expect(await firmConnectState(firm.id)).toEqual({
      stripe_charges_enabled: false,
      stripe_onboarding_complete: false,
    });
  });

  it('leaves every firm alone when the account id belongs to nobody', async () => {
    const firm = await createFirm();
    await testPool.query(
      `update law_firms set stripe_account_id = $2 where id = $1`,
      [firm.id, `acct_owned_${randomUUID().slice(0, 8)}`],
    );

    // `deliver` asserts a 200, and the claim assertion below proves the route ran
    // the handler rather than bailing out before it. Without both, "nothing
    // changed" would also be the answer if the request had failed outright.
    const payload = accountEvent(`acct_unknown_${randomUUID().slice(0, 8)}`, true, true);
    await deliver(payload);
    const eventId = JSON.parse(payload).id;
    const { rows } = await testPool.query(
      'select event_id from stripe_events where event_id = $1', [eventId],
    );
    expect(rows).toHaveLength(1);

    expect(await firmConnectState(firm.id)).toEqual({
      stripe_charges_enabled: false,
      stripe_onboarding_complete: false,
    });
  });
});

describe('invoice.voided', () => {
  const voidedEvent = (stripeInvoiceId: string, metadata: any) => envelope(
    'invoice.voided',
    { id: stripeInvoiceId, object: 'invoice', metadata },
  );

  it('is acknowledged and leaves an open pay-link request untouched', async () => {
    const firm = await createFirm();
    const { invoiceId, contextType, entityId } = await seedRequestedInvoice(firm.id, {
      sessionId: 'cs_live',
    });

    // Full Paralegix metadata naming the requested invoice. `deliver` asserts the 200 (a refusal would make Stripe retry for
    // days); the row assertion breaks if anything ends or clears the request,
    // which would show "not requested" while the client's pay link still works.
    await deliver(voidedEvent('in_stray', {
      lawFirmId: firm.id, invoiceId, contextType, entityId,
    }));

    expect(await invoiceStripeState(invoiceId)).toEqual({
      stripe_payment_status: 'pending',
      stripe_checkout_session_id: 'cs_live',
      stripe_payment_requested: true,
      pay_link_token: `tok_${invoiceId}`,
    });
  });
});

describe('checkout.session.expired', () => {
  const expiredEvent = (sessionId: string, metadata: any) => envelope(
    'checkout.session.expired',
    { id: sessionId, object: 'checkout.session', metadata },
  );

  it('clears the stale session pointer but leaves the payment status alone', async () => {
    const firm = await createFirm();
    const { invoiceId, contextType, entityId } = await seedRequestedInvoice(firm.id, {
      sessionId: 'cs_expiring',
    });

    await deliver(expiredEvent('cs_expiring', {
      lawFirmId: firm.id, invoiceId, contextType, entityId,
    }));

    const state = await invoiceStripeState(invoiceId);
    expect(state.stripe_checkout_session_id).toBeNull();
    // An expired Checkout Session says nothing about the pay link, which still
    // works and mints a fresh session when opened. Marking the invoice failed
    // here would hide a live payment link from the firm.
    expect(state.stripe_payment_status).toBe('pending');
    expect(state.stripe_payment_requested).toBe(true);
    expect(state.pay_link_token).toBe(`tok_${invoiceId}`);
  });

  it('clears the recorded session account along with the session id', async () => {
    const firm = await createFirm();
    const { invoiceId, contextType, entityId } = await seedRequestedInvoice(firm.id, {
      sessionId: 'cs_expiring_acct',
    });
    await recordSessionAccount(invoiceId);

    await deliver(expiredEvent('cs_expiring_acct', {
      lawFirmId: firm.id, invoiceId, contextType, entityId,
    }));

    expect(await recordedSessionAccount(invoiceId)).toBeNull();
  });

  it('ignores an expiry for a session the firm no longer points at', async () => {
    const firm = await createFirm();
    // `getClientCheckoutUrl` expires an amount-mismatched session and mints a
    // fresh one; the old session's expiry names the OLD id. Clearing on it would
    // drop the fresh pointer, and every portal visit would mint another.
    const { invoiceId, contextType, entityId } = await seedRequestedInvoice(firm.id, {
      sessionId: 'cs_fresh',
    });

    await deliver(expiredEvent('cs_stale', {
      lawFirmId: firm.id, invoiceId, contextType, entityId,
    }));

    expect((await invoiceStripeState(invoiceId)).stripe_checkout_session_id).toBe('cs_fresh');
  });

  it('leaves a completed invoice untouched', async () => {
    const firm = await createFirm();
    const { invoiceId, contextType, entityId } = await seedRequestedInvoice(firm.id, {
      sessionId: 'cs_after_payment',
      paymentStatus: 'completed',
    });

    await deliver(expiredEvent('cs_after_payment', {
      lawFirmId: firm.id, invoiceId, contextType, entityId,
    }));

    // Stripe expires the session it created for a payment that has already
    // settled. The session id on a paid invoice is the audit trail of how it was
    // paid.
    const state = await invoiceStripeState(invoiceId);
    expect(state.stripe_checkout_session_id).toBe('cs_after_payment');
    expect(state.stripe_payment_status).toBe('completed');
  });
});

describe('checkout.session.async_payment_failed', () => {
  const failedEvent = (sessionId: string, metadata: any) => envelope(
    'checkout.session.async_payment_failed',
    { id: sessionId, object: 'checkout.session', metadata },
  );

  it('marks the invoice failed and drops the dead session', async () => {
    const firm = await createFirm();
    const { invoiceId, contextType, entityId } = await seedRequestedInvoice(firm.id, {
      sessionId: 'cs_ach_bounced',
    });

    await deliver(failedEvent('cs_ach_bounced', {
      lawFirmId: firm.id, invoiceId, contextType, entityId,
    }));

    // A bank debit started at checkout can fail days later. No funds arrived, so
    // the invoice has to go back to being collectable rather than sitting on a
    // pending status forever.
    const state = await invoiceStripeState(invoiceId);
    expect(state.stripe_payment_status).toBe('failed');
    expect(state.stripe_checkout_session_id).toBeNull();
  });

  it('clears the recorded session account along with the session id', async () => {
    const firm = await createFirm();
    const { invoiceId, contextType, entityId } = await seedRequestedInvoice(firm.id, {
      sessionId: 'cs_ach_acct',
    });
    await recordSessionAccount(invoiceId);

    await deliver(failedEvent('cs_ach_acct', {
      lawFirmId: firm.id, invoiceId, contextType, entityId,
    }));

    expect(await recordedSessionAccount(invoiceId)).toBeNull();
  });

  it('never marks a completed invoice failed', async () => {
    const firm = await createFirm();
    const { invoiceId, contextType, entityId } = await seedRequestedInvoice(firm.id, {
      sessionId: 'cs_late_failure',
      paymentStatus: 'completed',
    });

    await deliver(failedEvent('cs_late_failure', {
      lawFirmId: firm.id, invoiceId, contextType, entityId,
    }));

    // The failure of one attempt must not overwrite a payment that succeeded on
    // another. This invoice has money against it.
    const state = await invoiceStripeState(invoiceId);
    expect(state.stripe_payment_status).toBe('completed');
    expect(state.stripe_checkout_session_id).toBe('cs_late_failure');
  });

  it('does not touch an invoice when the failed session was a TRUST deposit', async () => {
    const firm = await createFirm();
    const { invoiceId, contextType, entityId } = await seedRequestedInvoice(firm.id, {
      sessionId: 'cs_trust_deposit',
    });

    const payload = failedEvent('cs_trust_deposit', {
      lawFirmId: firm.id, invoiceId, contextType, entityId, depositType: 'trust',
    });
    await deliver(payload);
    const eventId = JSON.parse(payload).id;
    const { rows } = await testPool.query(
      'select event_id from stripe_events where event_id = $1', [eventId],
    );
    // Proves the delivery was accepted and dispatched, so the unchanged invoice
    // below is the route's `depositType` branch and not a rejected request.
    expect(rows).toHaveLength(1);

    // Trust deposits are ACH and are posted (and failed) on the payment_intent
    // events, never through the invoice path. Routing one here would stamp
    // `failed` onto whichever unrelated invoice the metadata happened to name.
    const state = await invoiceStripeState(invoiceId);
    expect(state.stripe_payment_status).toBe('pending');
    expect(state.stripe_checkout_session_id).toBe('cs_trust_deposit');
  });
});

export {};

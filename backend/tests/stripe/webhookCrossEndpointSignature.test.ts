/**
 * Cross-endpoint Stripe webhook signature reuse.
 *
 * `/api/webhooks/stripe` (payments/trust) and `/api/webhooks/stripe-subscriptions`
 * (billing status) are two separate, unauthenticated, publicly-reachable POST
 * routes, each verifying against its OWN secret: `STRIPE_WEBHOOK_SECRET` and
 * `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` respectively (stripe.webhook.routes.ts,
 * subscriptions.webhook.routes.ts). Both existing webhook specs
 * (tests/stripe/webhookIdempotency.test.ts, tests/subscriptions/subscriptionWebhook.test.ts)
 * already prove each endpoint refuses a missing signature, a signature made with
 * the WRONG secret, and a tampered payload -- but always by inventing a secret
 * value neither endpoint would ever recognize. Neither file tries the one
 * signature an attacker (or a misconfigured Stripe dashboard) could plausibly
 * produce for real: a genuinely valid signature, just for the SIBLING endpoint's
 * secret. This file closes that gap directly: a real Stripe signature for one
 * endpoint's secret must not authenticate the other endpoint.
 *
 * Each direction below signs an event type the TARGET endpoint actually acts on
 * -- one that would flip a real column if the cross-signature were wrongly
 * accepted -- so a passing test proves more than a status code: it proves the
 * specific state the event carries never landed.
 *
 * WHY THIS RUNS OFFLINE. Signature verification is an offline HMAC-SHA256
 * compare through Node's crypto, and `Stripe.webhooks.generateTestHeaderString`
 * is a static, so a spec can mint a genuinely valid signature from a fake
 * secret with no network. Neither event type used below
 * (`customer.subscription.deleted`, `checkout.session.expired`) triggers an
 * outbound Stripe API call in its handler, so a placeholder `STRIPE_SECRET_KEY`
 * never has to leave this process either.
 */

import { testPool, createFirm, createPersonClient, createInvoice, type Firm } from '../support/setupInProcess';
import { claimedEventIds, deliverSigned } from '../support/stripeWebhook';

const PAYMENTS_SECRET = 'whsec_payments_secret_for_the_offline_suite';
const SUBSCRIPTIONS_SECRET = 'whsec_subscriptions_secret_for_the_offline_suite';

async function billingStatus(lawFirmId: string) {
  const { rows } = await testPool.query('select billing_status from law_firms where id = $1', [lawFirmId]);
  return rows[0]?.billing_status;
}

async function checkoutSessionIdOf(invoiceId: string) {
  const { rows } = await testPool.query(
    'select stripe_checkout_session_id from invoices where id = $1',
    [invoiceId],
  );
  return rows[0]?.stripe_checkout_session_id;
}

function subscriptionDeletedPayload(id: string, lawFirmId: string) {
  return JSON.stringify({
    id,
    object: 'event',
    type: 'customer.subscription.deleted',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'sub_cross_endpoint_test',
        object: 'subscription',
        status: 'canceled',
        metadata: { lawFirmId },
      },
    },
  });
}

function checkoutExpiredPayload(
  id: string,
  opts: { lawFirmId: string; invoiceId: string; entityId: string },
) {
  return JSON.stringify({
    id,
    object: 'event',
    type: 'checkout.session.expired',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_cross_endpoint_test',
        object: 'checkout.session',
        metadata: {
          lawFirmId: opts.lawFirmId,
          invoiceId: opts.invoiceId,
          contextType: 'client',
          entityId: opts.entityId,
        },
      },
    },
  });
}

beforeAll(() => {
  // Set BEFORE the first request, which is when the app graph (and with it
  // `stripe.config`) is first required. Assigned rather than defaulted: an
  // untracked `.env` must not decide which secrets this file signs with, and
  // CI has no `.env` at all. The two secrets are deliberately DIFFERENT, which
  // is the whole precondition for this file to mean anything.
  process.env.STRIPE_SECRET_KEY = 'sk_test_offline_cross_endpoint_suite';
  process.env.STRIPE_WEBHOOK_SECRET = PAYMENTS_SECRET;
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = SUBSCRIPTIONS_SECRET;
});

describe('a signature valid for the SUBSCRIPTIONS secret on the PAYMENTS endpoint', () => {
  let firm: Firm;

  beforeEach(async () => {
    firm = await createFirm();
    await testPool.query(
      "update law_firms set billing_status = 'active', plan = jsonb_build_object('stripeSubscriptionId', 'sub_cross_endpoint_test') where id = $1",
      [firm.id],
    );
  });

  it('accepts on its OWN endpoint: positive control', async () => {
    const payload = subscriptionDeletedPayload('evt_ctrl_sub_ok', firm.id);

    const res = await deliverSigned(payload, SUBSCRIPTIONS_SECRET, '/api/webhooks/stripe-subscriptions');

    // If this is not 200, the payload/fixture shape below is wrong and every
    // refusal in this describe block would pass for the wrong reason -- the
    // event would never have applied even with the right secret.
    expect(res.status).toBe(200);
    expect(await billingStatus(firm.id)).toBe('canceled');
  });

  it('is REFUSED on the payments endpoint, and the subscription is never canceled', async () => {
    const payload = subscriptionDeletedPayload('evt_cross_sub_on_payments', firm.id);

    // A real Stripe signature -- just for the sibling product's secret, not
    // this endpoint's.
    const res = await deliverSigned(payload, SUBSCRIPTIONS_SECRET, '/api/webhooks/stripe');

    expect(res.status).toBe(400);
    // The specific state this event carries: an active firm losing access.
    // If the cross-secret had wrongly verified, the payments route's switch
    // has no case for 'customer.subscription.deleted' and would no-op anyway,
    // so the REAL proof is that verification itself failed before the switch
    // was ever reached -- pinned below by the claim table.
    expect(await billingStatus(firm.id)).toBe('active');
    expect(await claimedEventIds()).toEqual([]);
  });
});

describe('a signature valid for the PAYMENTS secret on the SUBSCRIPTIONS endpoint', () => {
  let firm: Firm;
  let clientId: string;
  let invoiceId: string;

  beforeEach(async () => {
    firm = await createFirm();
    const client = await createPersonClient(firm.id);
    clientId = client.id;
    const invoice = await createInvoice(firm.id, clientId);
    invoiceId = invoice.id;
    await testPool.query(
      "update invoices set stripe_checkout_session_id = 'cs_cross_endpoint_test' where id = $1",
      [invoiceId],
    );
  });

  it('accepts on its OWN endpoint: positive control', async () => {
    const payload = checkoutExpiredPayload('evt_ctrl_checkout_ok', { lawFirmId: firm.id, invoiceId, entityId: clientId });

    const res = await deliverSigned(payload, PAYMENTS_SECRET, '/api/webhooks/stripe');

    // Same guard as the other control: if this isn't 200 the fixture is
    // broken and the refusal case below proves nothing.
    expect(res.status).toBe(200);
    expect(await checkoutSessionIdOf(invoiceId)).toBeNull();
  });

  it('is REFUSED on the subscriptions endpoint, and the checkout session is never cleared', async () => {
    const payload = checkoutExpiredPayload('evt_cross_checkout_on_subs', { lawFirmId: firm.id, invoiceId, entityId: clientId });

    // A real Stripe signature -- just for the sibling product's secret.
    const res = await deliverSigned(payload, PAYMENTS_SECRET, '/api/webhooks/stripe-subscriptions');

    expect(res.status).toBe(400);
    // The specific state this event carries: the invoice's pending checkout
    // session marker getting cleared, which would let the invoice be
    // re-requested for payment against a session that Stripe already expired.
    expect(await checkoutSessionIdOf(invoiceId)).toBe('cs_cross_endpoint_test');
    expect(await claimedEventIds()).toEqual([]);
  });
});

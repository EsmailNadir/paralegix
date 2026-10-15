/**
 * Stripe webhook idempotency, driven through the REAL app against Postgres.
 *
 * Stripe retries a webhook until it gets a 2xx, and it will happily deliver the
 * same event several times. Every handler behind this route moves money: applies
 * a payment to an invoice, posts a trust deposit, reverses a refund. Processing
 * one delivery twice pays an invoice twice.
 *
 * `stripe_events` is the guard. It is a two-column table whose primary key is the
 * Stripe event id, claimed with `insert ... on conflict do nothing`, and the
 * whole mechanism was untested: the existing webhook spec reaches into
 * `router.stack` and stubs `claimStripeEvent` to `true`, so it never exercises
 * the claim at all.
 *
 * WHY THIS CAN BE TESTED WITHOUT NETWORK OR KEYS. Signature verification is
 * offline: `constructEvent` does an HMAC-SHA256 compare through Node's crypto,
 * with no HTTP. `Stripe.webhooks.generateTestHeaderString` is a static, so a
 * spec can produce a genuinely valid signature from a fake secret. And
 * `new Stripe(key)` performs no I/O at construction, so a fake key is enough to
 * get past the route's `if (!stripe) return 503` guard.
 *
 * The events chosen below are the ones whose handlers make NO outbound Stripe
 * call, so nothing reaches the network even if a real key happens to sit in
 * `.env`.
 */

import { drainEvents } from '../support/setupInProcess';
import { request } from '../support/app';
import { claimedEventIds, deliverSigned, stripeEventPayload } from '../support/stripeWebhook';

// `require`, not `import`: the package's ESM entry does not parse under Jest,
// and `stripe.config.ts` in the app requires it the same way.
const Stripe = require('stripe');

const WEBHOOK_SECRET = 'whsec_test_secret_for_the_offline_suite';

/**
 * A `checkout.session.expired` event.
 *
 * Picked deliberately: `handleCheckoutExpired` only clears
 * `invoices.stripeCheckoutSessionId` and makes no outbound Stripe call, so the
 * test exercises the claim/release protocol without touching the network. The
 * session references no invoice we created, so the handler is a no-op and any
 * state left behind is the idempotency table's doing, not the handler's.
 */
function eventPayload(id: string) {
  return stripeEventPayload(id, 'checkout.session.expired', {
    id: 'cs_test_session',
    object: 'checkout.session',
    metadata: {},
  });
}

const deliver = (payload: string, secret = WEBHOOK_SECRET) => deliverSigned(payload, secret);

beforeAll(() => {
  // Set BEFORE the first request, which is when the app graph (and with it
  // `stripe.config`) is first required. Assigned rather than defaulted: whatever
  // `.env` holds must not decide whether this file talks to the real Stripe.
  process.env.STRIPE_SECRET_KEY = 'sk_test_offline_suite_placeholder';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

describe('signature verification', () => {
  it('refuses an event signed with the WRONG secret, and claims NOTHING', async () => {
    const res = await deliver(eventPayload('evt_wrong_secret'), 'whsec_not_the_real_secret');

    // The webhook endpoint is unauthenticated and publicly reachable. The
    // signature is the only thing standing between it and anyone who can POST
    // JSON, and every handler behind it moves money.
    expect(res.status).toBe(400);
    // Asserting the TABLE. Claiming before verifying would let anyone with the
    // event id poison the dedupe table, so Stripe's genuine retry of that id
    // would be answered "duplicate" and silently dropped. That is a way to make
    // a real payment never apply.
    expect(await claimedEventIds()).toEqual([]);
  });

  it('refuses an event with NO signature header at all', async () => {
    const res = await request()
      .post('/api/webhooks/stripe')
      .set('content-type', 'application/json')
      .send(eventPayload('evt_no_sig'));

    expect(res.status).toBe(400);
  });

  it('refuses a payload that does not match its signature', async () => {
    const signed = eventPayload('evt_tampered');
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: signed, secret: WEBHOOK_SECRET,
    });

    const res = await request()
      .post('/api/webhooks/stripe')
      .set('stripe-signature', signature)
      .set('content-type', 'application/json')
      // Signed one body, sent another.
      .send(eventPayload('evt_tampered_different'));

    expect(res.status).toBe(400);
  });
});

describe('idempotency', () => {
  it('answers a redelivery as a duplicate, without claiming the id a second time', async () => {
    await deliver(eventPayload('evt_repeated'));

    const second = await deliver(eventPayload('evt_repeated'));
    await drainEvents();

    // Stripe retries until it gets a 2xx, so a redelivery is normal traffic, not
    // an attack. The second one has to be acknowledged, not refused, or Stripe
    // keeps retrying forever.
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    // One row, not two. The primary key would refuse the second insert anyway;
    // what this pins is that the route treats the refusal as "already seen"
    // rather than as an error.
    expect(await claimedEventIds()).toEqual(['evt_repeated']);
  });

  it('claims a first delivery without calling it a duplicate, and treats two DIFFERENT event ids independently', async () => {
    const first = await deliver(eventPayload('evt_alpha'));
    const second = await deliver(eventPayload('evt_beta'));
    await drainEvents();

    // If the first is a 503 the whole file is meaningless: `stripe` would be
    // null and every request refused before reaching the idempotency guard.
    expect([first.status, second.status]).toEqual([200, 200]);
    // The negative half. A route that always reported `duplicate: true` would
    // satisfy the redelivery case above while dropping every real event.
    expect(first.body.duplicate).toBeUndefined();
    // Deduping on anything coarser than the event id, the session id say, would
    // drop the genuine follow-up events Stripe sends about one payment.
    expect(second.body.duplicate).toBeUndefined();
    expect((await claimedEventIds()).sort()).toEqual(['evt_alpha', 'evt_beta']);
  });

  // Two deliveries of one event in flight together are pinned, with a gate that
  // proves they overlapped, in `webhookConcurrency.test.ts`.

  it('acknowledges an event type it does not handle', async () => {
    const payload = stripeEventPayload('evt_unhandled', 'customer.created', { id: 'cus_test' });

    const res = await deliver(payload);

    // Stripe sends event types the app has never heard of. Answering anything
    // other than 2xx makes it retry them forever and eventually disable the
    // endpoint, taking the events that DO matter down with it.
    expect(res.status).toBe(200);
  });
});

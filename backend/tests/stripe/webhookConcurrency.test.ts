/**
 * The Stripe idempotency guard, with evidence that the two deliveries overlapped.
 *
 * `webhookIdempotency.test.ts` covers the guard's behaviour one delivery at a
 * time. A concurrent case written as `await Promise.all([deliver(p), deliver(p)])`
 * starts two requests and hopes. Node runs one callback at a time, so the
 * second delivery may not reach the claim until the first has already inserted
 * its row, in which case the test proves sequential deduplication and would pass
 * unchanged against a guard with no atomicity at all.
 *
 * This file pins the same contract with a barrier: both deliveries are held
 * INSIDE `claimStripeEvent` at the same moment, and the test chooses when to
 * release them. `gate.entered()` is the control, because a barrier that never
 * fired would leave these cases as the same hope with more ceremony.
 *
 * It also covers a claim that fails: that must surface a 500 so Stripe retries
 * rather than process without the guard. A handler that fails after the claim
 * must release it; `stripeInvoiceEffectRecovery.test.ts` pins that, with the
 * invoice money asserted on both the failed delivery and the retry.
 *
 * Offline, like its sibling: signature verification is an HMAC compare in Node's
 * crypto, `generateTestHeaderString` is a static, and `new Stripe(key)` performs
 * no I/O. The gated handler never runs, so nothing reaches the network.
 */

import { drainEvents } from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';
import { claimedEventIds, deliverSigned, stripeEventPayload } from '../support/stripeWebhook';

// `require`, not `import`: the route reaches the service through the module
// object, so the gate has to replace the property on that same object.
const stripeService = require('../../src/modules/stripe/stripe.service');

const WEBHOOK_SECRET = 'whsec_test_secret_for_the_offline_suite';

let gate: Gate | null = null;

const expiredEvent = (id: string) => stripeEventPayload(id, 'checkout.session.expired', {
  id: 'cs_test_session', object: 'checkout.session', metadata: {},
});

const deliver = (payload: string) => deliverSigned(payload, WEBHOOK_SECRET);

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

afterEach(() => {
  // Unconditional. A spec that fails between `arrived` and `open` would
  // otherwise leave a request paused forever and turn a clear assertion failure
  // into a suite timeout.
  gate?.restore();
  gate = null;
});

describe('two deliveries of one event, proved to be inside the guard together', () => {
  it('lets exactly one claim win when both are held at the claim', async () => {
    gate = gateMethod(stripeService, 'claimStripeEvent');
    const payload = expiredEvent('evt_gated_concurrent');

    const first = deliver(payload);
    const second = deliver(payload);

    // The evidence. Both requests have reached `claimStripeEvent` and neither
    // has run the insert. This is the moment the sibling spec can only hope for.
    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);
    expect(await claimedEventIds()).toEqual([]);

    gate.open();
    const [a, b] = await Promise.all([first, second]);
    await drainEvents();

    // The database decides the winner through the primary key on
    // (endpoint, event_id). The loser finds the winner's claim still processing
    // and is refused with a 409, so Stripe retries it rather than treating an
    // attempt that may yet fail as done.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await claimedEventIds()).toEqual(['evt_gated_concurrent']);
    expect([a, b].filter((r) => r.status === 200 && r.body.duplicate === undefined)).toHaveLength(1);
    // The control: exactly two calls reached the barrier. A gate installed on
    // the wrong property would let this pass as an ordinary sequential run.
    expect(gate.entered()).toBe(2);
  });
});

describe('a claim that fails must not let processing continue', () => {
  it('answers 500 so Stripe retries, and claims nothing', async () => {
    // The guard is the only thing standing between a retry and a double
    // payment. If it cannot be consulted, the route must refuse rather than
    // process unguarded, and it must fail in a way Stripe will retry.
    gate = gateMethod(stripeService, 'claimStripeEvent');
    gate.open();
    gate.failNext(new Error('stripe_events unavailable'));

    const res = await deliver(expiredEvent('evt_claim_broken'));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/idempotency/i);
    // The controlled missing side effect: the row was never written, and the
    // event was never processed.
    expect(await claimedEventIds()).toEqual([]);
    expect(gate.entered()).toBe(1);
  });
});

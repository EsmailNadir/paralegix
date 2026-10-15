/**
 * Deliver signed events to the Stripe SUBSCRIPTION webhook
 * (`/api/webhooks/stripe-subscriptions`), and build the subscription and
 * invoice objects Stripe puts in them.
 *
 * Delivery is real: the payload is signed with the `Stripe.webhooks` static (an
 * HMAC compare, no network) and POSTed to the real route, so signature
 * verification, the `stripe_events` claim and the handler all run. A spec sets
 * `process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` to the same secret, and
 * `STRIPE_ENTERPRISE_MONTHLY_PRICE_ID` to `ENTERPRISE_MONTHLY_PRICE`, before its
 * first request: `stripePrices.ts` freezes the price map when the app graph is
 * first required.
 */
import { testPool } from './db';
import { drainEvents } from './events';
import { setFirmPlan } from './factories';
import { deliverSigned } from './stripeWebhook';

export const SUBSCRIPTION_WEBHOOK_PATH = '/api/webhooks/stripe-subscriptions';
export const ENTERPRISE_MONTHLY_PRICE = 'price_test_enterprise_monthly';
export const PERIOD_START = '2026-06-01T00:00:00.000Z';
export const PERIOD_END = '2026-07-01T00:00:00.000Z';

/** Seconds since epoch, which is the only date shape Stripe puts on the wire. */
export const secs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

export type SubscriptionOverrides = {
  id?: string;
  status?: string;
  lawFirmId?: string | undefined;
  customer?: string;
  /** `null` sends a price object with no id. */
  priceId?: string | null;
  /** Omit the price object on the item entirely. */
  noPriceObject?: boolean;
  /** Send an empty item list. */
  noItems?: boolean;
  periodStart?: string | null;
  periodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  trialEnd?: string | null;
  /** Render the period on the subscription root (pre-2025-03-31 shape) instead of the item. */
  legacyPeriodShape?: boolean;
};

/**
 * A Stripe subscription object as the webhook renders it.
 *
 * The period lives on the ITEM by default: Stripe moved
 * `current_period_start`/`end` off the subscription root in API version
 * 2025-03-31.basil, and the handler reads the item first with a fallback to the
 * root. `legacyPeriodShape` renders the old one.
 */
export function stripeSubscription(o: SubscriptionOverrides = {}): any {
  const start = o.periodStart === undefined ? PERIOD_START : o.periodStart;
  const end = o.periodEnd === undefined ? PERIOD_END : o.periodEnd;
  const item: any = { id: 'si_test_1', object: 'subscription_item' };
  if (!o.noPriceObject) {
    item.price = { id: o.priceId === undefined ? ENTERPRISE_MONTHLY_PRICE : o.priceId, object: 'price' };
  }
  const sub: any = {
    id: o.id ?? 'sub_test_1',
    object: 'subscription',
    status: o.status ?? 'active',
    customer: o.customer ?? 'cus_test_1',
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    trial_end: o.trialEnd ? secs(o.trialEnd) : null,
    metadata: o.lawFirmId === undefined ? {} : { lawFirmId: o.lawFirmId },
    items: { object: 'list', data: o.noItems ? [] : [item] },
  };
  const periodOn = o.legacyPeriodShape ? sub : item;
  periodOn.current_period_start = start ? secs(start) : null;
  periodOn.current_period_end = end ? secs(end) : null;
  return sub;
}

/** A subscription invoice. `parent.subscription_details` is the current shape. */
export function subscriptionInvoice(
  o: { amountPaid?: number; subscriptionId?: string | null; paidAt?: number } = {},
): any {
  const subId = o.subscriptionId === undefined ? 'sub_test_1' : o.subscriptionId;
  return {
    id: 'in_test_1',
    object: 'invoice',
    amount_paid: o.amountPaid ?? 249_00,
    ...(o.paidAt ? { status_transitions: { paid_at: o.paidAt } } : {}),
    ...(subId ? { parent: { subscription_details: { subscription: subId } } } : {}),
  };
}

/** A subscription event envelope with a fixed id, as the exact string that gets signed. */
export function subscriptionEventPayload(id: string, type: string, object: unknown, created?: number) {
  return JSON.stringify({
    id,
    object: 'event',
    type,
    created: created ?? Math.floor(Date.now() / 1000),
    data: { object },
  });
}

/**
 * What Stripe holds for each subscription id, as `subscriptions.retrieve`
 * answers it. The subscription handlers read Stripe's CURRENT state rather than
 * trusting the event payload, so a spec has to say what that state is.
 *
 * By default it follows the events: every subscription object delivered through
 * `subscriptionWebhookSender` becomes Stripe's state for its id, which is what
 * Stripe would answer for an event delivered in order. A spec that needs Stripe
 * to disagree with a payload (a stale retry, a subscription that is gone) PINS
 * the id with `setStripeSubscription` or `removeStripeSubscription`, and later
 * deliveries no longer move it.
 *
 * Wire it in with `mockSubscriptionRetrieve.mockImplementation(retrieveStripeSubscription)`.
 * The store is emptied before every test.
 */
const stripeSubscriptions = new Map<string, any>();
const pinnedSubscriptionIds = new Set<string>();

beforeEach(() => {
  stripeSubscriptions.clear();
  pinnedSubscriptionIds.clear();
});

export function setStripeSubscription(subscription: any) {
  pinnedSubscriptionIds.add(subscription.id);
  stripeSubscriptions.set(subscription.id, subscription);
}

export function removeStripeSubscription(subscriptionId: string) {
  pinnedSubscriptionIds.add(subscriptionId);
  stripeSubscriptions.delete(subscriptionId);
}

function recordDeliveredSubscription(payload: string) {
  const object = JSON.parse(payload)?.data?.object;
  if (object?.object !== 'subscription' || !object.id || pinnedSubscriptionIds.has(object.id)) return;
  stripeSubscriptions.set(object.id, object);
}

/** `subscriptions.retrieve` against the store: a copy, or Stripe's 404 for an unknown id. */
export async function retrieveStripeSubscription(subscriptionId: string) {
  const found = stripeSubscriptions.get(subscriptionId);
  if (found) return JSON.parse(JSON.stringify(found));
  throw Object.assign(new Error(`No such subscription: '${subscriptionId}'`), {
    statusCode: 404, code: 'resource_missing',
  });
}

/**
 * Senders bound to one webhook secret. `deliver` returns the raw response and
 * drains nothing, so a refusal or an overlap can be asserted; `send` builds the
 * envelope, delivers it and drains the event bus, so listener work has landed
 * before the spec reads a row.
 */
export function subscriptionWebhookSender(secret: string) {
  const deliver = (payload: string, withSecret = secret) => {
    recordDeliveredSubscription(payload);
    return deliverSigned(payload, withSecret, SUBSCRIPTION_WEBHOOK_PATH);
  };
  async function send(id: string, type: string, object: unknown, created?: number) {
    const res = await deliver(subscriptionEventPayload(id, type, object, created));
    await drainEvents();
    return res;
  }
  return { deliver, send };
}

/**
 * The firm's billing state as the app's gates see it: the two CHECK-constrained
 * columns plus the plan jsonb. Read with plain SQL, never through the code under
 * test.
 */
export async function billingRow(lawFirmId: string) {
  const { rows } = await testPool.query(
    'select billing_status, plan_id, plan from law_firms where id = $1',
    [lawFirmId],
  );
  return rows[0];
}

/**
 * Put the firm in a known billing state as its ENTIRE plan, without going
 * through a handler. `setFirmPlan` routes planId/billingStatus to their columns,
 * which is where migration 0200 made them authoritative.
 */
export const seedPlan = (lawFirmId: string, plan: Record<string, unknown>) =>
  setFirmPlan(lawFirmId, plan, { replace: true });

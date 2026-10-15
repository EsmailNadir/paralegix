/**
 * A deliberate comp/override must survive a stray Stripe webhook for the very
 * subscription the comp action just canceled.
 *
 * `adminCompFirm` (`src/modules/admin/admin.service.ts`) is the ONLY way a
 * firm's `plan.comped` flag gets set on a firm that has a real Stripe
 * subscription: it best-effort cancels that subscription
 * (`stripe.subscriptions.cancel(...).catch(() => {})`) and clears
 * `stripeSubscriptionId` off the firm row. Cancelling on Stripe's side is
 * asynchronous from the app's point of view -- the API call returns before (or
 * sometimes without) Stripe's own webhooks for that same subscription finishing
 * delivery, and `subscription.metadata.lawFirmId` on the OLD subscription still
 * names this firm, so a `customer.subscription.updated` or
 * `customer.subscription.deleted` event for it can arrive at any point after
 * the comp action, including seconds later.
 *
 * `handleSubscriptionChange` already has a `canceledSubscriptionId` guard built
 * for exactly this class of staleness (a delayed event for a subscription the
 * firm has since moved past), and `subscriptionCrossTenant.test.ts` proves it
 * for the resubscribe case. But `adminCompFirm` never sets that marker when it
 * clears `stripeSubscriptionId`, and `handleSubscriptionDeleted` never reads it
 * at all -- so a stray event for the just-canceled subscription reaches a
 * comped firm with nothing to recognise it as stale, and both handlers apply it
 * unconditionally: `comped` is forced back to `false` and `billingStatus` is
 * overwritten from the subscription's last known state. The admin's deliberate
 * override is silently undone by the same cancellation the override caused.
 */
const mockSubscriptionCancel = jest.fn();
const mockSubscriptionRetrieve = jest.fn();

jest.mock('../../src/modules/stripe/stripe.config', () => {
  // A real Stripe instance so `webhooks.constructEvent`/`generateTestHeaderString`
  // stay the genuine offline HMAC implementation; only the method the admin comp
  // route calls, and the read the subscription handler makes, are replaced.
  const StripeCtor = require('stripe');
  const instance = new StripeCtor('sk_test_offline_comped_override_suite');
  instance.subscriptions.cancel = (...args: any[]) => mockSubscriptionCancel(...args);
  instance.subscriptions.retrieve = (...args: any[]) => mockSubscriptionRetrieve(...args);
  return instance;
});

import { randomUUID } from 'crypto';
import {
  as,
  createFirm,
  drainEvents,
  setFirmPlan,
  testPool,
  tokenFor,
  type CallerAgent,
  type Firm,
} from '../support/setupInProcess';
import {
  ENTERPRISE_MONTHLY_PRICE,
  billingRow,
  retrieveStripeSubscription,
  stripeSubscription,
  subscriptionWebhookSender,
} from '../support/subscriptionWebhook';

const WEBHOOK_SECRET = 'whsec_comped_override_secret_for_the_offline_suite';

const { send: deliverSubscriptionEvent } = subscriptionWebhookSender(WEBHOOK_SECRET);

const subscription = (o: { id: string; lawFirmId: string; status: string }) =>
  stripeSubscription({ ...o, customer: 'cus_test_comped' });

async function platformAdmin(): Promise<CallerAgent> {
  const uid = `admin-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email, name, user_type, is_admin)
     values ($1, $2, 'Billing Admin', 'firm_member', true)`,
    [uid, `${uid}@example.test`],
  );
  return as(tokenFor({ uid }));
}

let firm: Firm;
let admin: CallerAgent;

beforeAll(() => {
  // Assigned before the app graph is first required, same reasoning as the
  // sibling webhook suites: an untracked `.env` must not decide the secret this
  // file signs with, and CI has none of these set at all.
  process.env.STRIPE_SECRET_KEY = 'sk_test_offline_comped_override_suite';
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = ENTERPRISE_MONTHLY_PRICE;
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockSubscriptionCancel.mockResolvedValue({ id: 'sub_canceled_by_comp' });
  mockSubscriptionRetrieve.mockImplementation(retrieveStripeSubscription);
  firm = await createFirm({ name: 'Comped Override Firm' });
  await setFirmPlan(firm.id, {
    planId: 'enterprise',
    billingStatus: 'active',
    stripeCustomerId: 'cus_test_comped',
    stripeSubscriptionId: 'sub_to_be_comped',
  });
  admin = await platformAdmin();
  await drainEvents();
});

describe('a stray webhook for the subscription an admin comp just cancelled', () => {
  it('does not revoke the comp on an UPDATED event for the cancelled subscription', async () => {
    const compRes = await admin
      .post(`/api/admin/lawfirms/${firm.id}/subscription/comp`)
      .send({ reason: 'Design partner' });
    expect(compRes.status).toBe(200);

    const compedRow = await billingRow(firm.id);
    expect(compedRow.billing_status).toBe('comped');
    expect(compedRow.plan.comped).toBe(true);
    expect(compedRow.plan.stripeSubscriptionId).toBeNull();

    // Stripe's own cancellation of `sub_to_be_comped` had not yet finished
    // propagating (or a retry/proration event fires) when this arrives, still
    // reporting the subscription as active. Its metadata still names this firm.
    const res = await deliverSubscriptionEvent(
      'evt_comped_stray_updated', 'customer.subscription.updated',
      subscription({ id: 'sub_to_be_comped', lawFirmId: firm.id, status: 'active' }),
    );
    expect(res.status).toBe(200);

    const after = await billingRow(firm.id);
    // The deliberate override must survive: still comped, not silently flipped
    // back to a Stripe-derived 'active' status with comped:false.
    expect(after.plan.comped).toBe(true);
    expect(after.billing_status).toBe('comped');
  });

  it('does not revoke the comp on the DELETED event for the cancelled subscription', async () => {
    const compRes = await admin
      .post(`/api/admin/lawfirms/${firm.id}/subscription/comp`)
      .send({ reason: 'Design partner' });
    expect(compRes.status).toBe(200);

    const compedRow = await billingRow(firm.id);
    expect(compedRow.billing_status).toBe('comped');
    expect(compedRow.plan.comped).toBe(true);

    // The cancellation the comp action itself requested finally completes on
    // Stripe's side and its `deleted` webhook arrives, still naming this firm.
    const res = await deliverSubscriptionEvent(
      'evt_comped_stray_deleted', 'customer.subscription.deleted',
      subscription({ id: 'sub_to_be_comped', lawFirmId: firm.id, status: 'canceled' }),
    );
    expect(res.status).toBe(200);

    const after = await billingRow(firm.id);
    // Before the fix, handleSubscriptionDeleted applies unconditionally because
    // stripeSubscriptionId is already null (nothing to compare against), wiping
    // the comp to billingStatus 'canceled', comped:false.
    expect(after.plan.comped).toBe(true);
    expect(after.billing_status).toBe('comped');
  });

  // The control, a DELETE still locking out an uncomped firm with no stored
  // subscription id, is pinned in `subscriptionCrossTenant.test.ts`.
});

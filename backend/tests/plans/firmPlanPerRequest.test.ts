/**
 * How often a request reads the firm's plan, and how fresh that read is.
 *
 * A request under `/api/lawfirms/:lawFirmId` passes the workspace billing gate
 * (`requireActiveBilling`) and, on a plan-gated router, the feature gate
 * (`requireFeature`) as well; the dashboard reads the plan a third time for its
 * signing section. All of them want the same row, so the request loads it once
 * and every consumer reuses that load.
 *
 * The other half is freshness. The reuse is scoped to ONE request, so a plan or
 * subscription change written by the Stripe webhook must be what the very next
 * request sees. A cache that outlived the request would keep a canceled firm
 * working, or keep a firm that just upgraded locked out of what it paid for,
 * and neither shows up as an error.
 */

// Hoisted above the imports by Jest. See tests/subscriptions/subscriptionWebhook
// .test.ts for why the Stripe client is a real instance with one method stubbed.
// The subscription handler reads Stripe's current state, which the support
// store answers from the events this file delivers.
const mockSubscriptionRetrieve = jest.fn();

jest.mock('../../src/modules/stripe/stripe.config', () => {
  const StripeCtor = require('stripe');
  const instance = new StripeCtor('sk_test_offline_plan_memo_suite');
  instance.subscriptions.retrieve = (...args: any[]) => mockSubscriptionRetrieve(...args);
  return instance;
});

import {
  createFirm,
  drainEvents,
  ownerOf,
  setFirmPlan,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  ENTERPRISE_MONTHLY_PRICE,
  PERIOD_END,
  PERIOD_START,
  retrieveStripeSubscription,
  stripeSubscription,
  subscriptionEventPayload,
  subscriptionWebhookSender,
} from '../support/subscriptionWebhook';

const WEBHOOK_SECRET = 'whsec_plan_memo_secret_for_the_offline_suite';

// The one statement `loadFirmPlan` issues. Matching the statement rather than
// spying on the function counts real round trips, whichever module reference a
// caller holds.
const PLAN_LOAD_SQL = 'select plan_id, billing_status, plan, settings from law_firms';

const subscriptionEvent = (id: string, type: string, lawFirmId: string, status: string) =>
  subscriptionEventPayload(id, type, stripeSubscription({
    id: 'sub_plan_memo_1', customer: 'cus_plan_memo_1', lawFirmId, status,
  }));

const { deliver } = subscriptionWebhookSender(WEBHOOK_SECRET);

async function deliverWebhook(payload: string) {
  const res = await deliver(payload);
  await drainEvents();
  return res;
}

/** Run `fn` and count how many times the app's pool issued the plan load. */
async function countPlanLoads(fn: () => Promise<unknown>): Promise<number> {
  const { pool } = require('../../src/shared/database/db');
  const spy = jest.spyOn(pool, 'query');
  try {
    await fn();
    return spy.mock.calls.filter(([arg]: any[]) => {
      const text = typeof arg === 'string' ? arg : arg?.text;
      return typeof text === 'string' && text.includes(PLAN_LOAD_SQL);
    }).length;
  } finally {
    spy.mockRestore();
  }
}

let firm: Firm;
let owner: Actor;

beforeAll(() => {
  // Set before the first request loads the app, which is when stripePrices.ts
  // freezes its price map.
  process.env.STRIPE_SECRET_KEY = 'sk_test_offline_plan_memo_suite';
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = ENTERPRISE_MONTHLY_PRICE;
});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  mockSubscriptionRetrieve.mockReset();
  mockSubscriptionRetrieve.mockImplementation(retrieveStripeSubscription);
});

const trustAccounts = (f: Firm = firm) => owner.api.get(`/api/lawfirms/${f.id}/trust/accounts`);

describe('a plan change is visible on the very next request', () => {
  it('unlocks trust accounting right after the webhook moves the firm onto a plan that includes it', async () => {
    await setFirmPlan(firm.id, { planId: 'basic', billingStatus: 'active' }, { replace: true });
    const before = await trustAccounts();
    expect(before.status).toBe(403);

    const hook = await deliverWebhook(
      subscriptionEvent('evt_plan_memo_upgrade', 'customer.subscription.created', firm.id, 'active'),
    );
    expect(hook.status).toBe(200);

    const after = await trustAccounts();
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ accounts: [] });
  });

  it('locks the workspace right after the webhook reports the subscription deleted', async () => {
    await setFirmPlan(firm.id, {
      planId: 'enterprise',
      billingStatus: 'active',
      comped: false,
      stripeSubscriptionId: 'sub_plan_memo_1',
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
    }, { replace: true });
    const before = await trustAccounts();
    expect(before.status).toBe(200);

    const hook = await deliverWebhook(
      subscriptionEvent('evt_plan_memo_delete', 'customer.subscription.deleted', firm.id, 'canceled'),
    );
    expect(hook.status).toBe(200);

    const after = await trustAccounts();
    expect(after.status).toBe(402);
    expect(after.body.code).toBe('BILLING_INACTIVE');
  });
});

describe('one plan load per request', () => {
  it('loads the plan once for a route behind both the billing gate and a feature gate', async () => {
    let status = 0;
    const loads = await countPlanLoads(async () => {
      status = (await trustAccounts()).status;
    });

    expect(status).toBe(200);
    expect(loads).toBe(1);
  });

  it('loads the plan once for the dashboard, which also reads it for the signing section', async () => {
    let body: any;
    const loads = await countPlanLoads(async () => {
      body = (await owner.api.get(`/api/lawfirms/${firm.id}/dashboard-summary`)
        .set('x-timezone', 'America/New_York')).body;
    });

    // The signing section is permitted, so the dashboard reaches its plan check.
    // That the check still withholds the section on a plan without signing is
    // pinned in tests/dashboard/dashboardSummary.test.ts.
    expect(body.permissions.signatures).toBe(true);
    expect(body.sectionErrors).toEqual({});
    expect(loads).toBe(1);
  });

  it('does not reuse one request plan load on the next request', async () => {
    const loads = await countPlanLoads(async () => {
      expect((await trustAccounts()).status).toBe(200);
      expect((await trustAccounts()).status).toBe(200);
    });

    expect(loads).toBe(2);
  });
});

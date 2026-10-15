/**
 * The subscription service, tested OFFLINE against a fake transport.
 *
 * Unmocks subscription.service and requestDeduplicator and intercepts at fetch,
 * verifying url assembly, request body construction, tenant scoping,
 * and ApiError translation without a running backend.
 */
jest.unmock('@/services/subscription.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import subscriptionService from '@/services/subscription.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';

const bodyOf = (call: { body: unknown }): Record<string, unknown> =>
  call.body as Record<string, unknown>;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('subscriptionService.getStatus', () => {
  it('requests the firm subscription status endpoint', async () => {
    api.get(`/api/lawfirms/${LAW_FIRM_ID}/subscriptions/status`, {
      planId: 'professional',
      billingStatus: 'active',
      currentPeriodEnd: '2026-10-01T00:00:00Z',
    });

    const res = await subscriptionService.getStatus(LAW_FIRM_ID);

    expect(res.planId).toBe('professional');
    expect(res.billingStatus).toBe('active');
    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/subscriptions/status`);
  });

  it('scopes to the requested firm segment', async () => {
    api.get(`/api/lawfirms/${OTHER_FIRM_ID}/subscriptions/status`, {
      planId: 'starter',
      billingStatus: 'active',
    });

    await subscriptionService.getStatus(OTHER_FIRM_ID);

    const call = api.calls('GET')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${OTHER_FIRM_ID}/subscriptions/status`);
  });
});

describe('subscriptionService.createCheckout', () => {
  it('posts planId and interval to /checkout and returns session url', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/subscriptions/checkout`, {
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
    });

    const res = await subscriptionService.createCheckout(LAW_FIRM_ID, 'enterprise', 'annual');

    expect(res.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_123');
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/subscriptions/checkout`);
    expect(bodyOf(call)).toEqual({ planId: 'enterprise', interval: 'annual' });
  });

  it('surfaces ApiError when checkout creation fails', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/subscriptions/checkout`, {
      status: 400,
      body: { error: 'Invalid plan selected' },
    });

    await expect(subscriptionService.createCheckout(LAW_FIRM_ID, 'starter', 'monthly'))
      .rejects
      .toThrow(ApiError);
  });
});

describe('subscriptionService.createPortalSession', () => {
  it('posts to /portal and returns customer portal url', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/subscriptions/portal`, {
      portalUrl: 'https://billing.stripe.com/p/session/test_portal_456',
    });

    const res = await subscriptionService.createPortalSession(LAW_FIRM_ID);

    expect(res.portalUrl).toBe('https://billing.stripe.com/p/session/test_portal_456');
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/subscriptions/portal`);
  });
});

describe('subscriptionService.changePlan', () => {
  it('posts planId and interval to /change-plan', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/subscriptions/change-plan`, {
      message: 'Plan changed successfully',
    });

    const res = await subscriptionService.changePlan(LAW_FIRM_ID, 'starter', 'monthly');

    expect(res.message).toBe('Plan changed successfully');
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/subscriptions/change-plan`);
    expect(bodyOf(call)).toEqual({ planId: 'starter', interval: 'monthly' });
  });
});

describe('subscriptionService.cancel', () => {
  it('posts to /cancel and returns confirmation message', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/subscriptions/cancel`, {
      message: 'Subscription scheduled for cancellation at period end',
    });

    const res = await subscriptionService.cancel(LAW_FIRM_ID);

    expect(res.message).toContain('cancellation');
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/subscriptions/cancel`);
  });
});

describe('subscriptionService.reactivate', () => {
  it('posts to /reactivate and returns confirmation message', async () => {
    api.post(`/api/lawfirms/${LAW_FIRM_ID}/subscriptions/reactivate`, {
      message: 'Subscription reactivated',
    });

    const res = await subscriptionService.reactivate(LAW_FIRM_ID);

    expect(res.message).toBe('Subscription reactivated');
    const call = api.calls('POST')[0];
    expect(call.url).toBe(`http://localhost:5001/api/lawfirms/${LAW_FIRM_ID}/subscriptions/reactivate`);
  });
});

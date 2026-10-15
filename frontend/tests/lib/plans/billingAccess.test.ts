/**
 * The client half of the paywall gate.
 *
 * This file exists because the two gates disagreed. The backend expires a
 * no-card trial the moment `trialEndsAt` passes
 * (`shared/plans/planEnforcement.ts`), while this module treated any firm whose
 * stored status said `trialing` as active. For the whole tail of a lapsed trial
 * the client rendered the workspace and the backend answered 402 to every
 * request inside it, which is what the user saw: a dashboard of red banners
 * instead of a paywall.
 *
 * What has to break for these to go red: remove the `trialEndsAt` check from
 * `isBillingActive`, or let it expire a Stripe-tracked trial, and the specs
 * below fail. Both are the real defects.
 */
import {
  isBillingActive,
  isBillingIncomplete,
  isBillingLocked,
  isTrialExpired,
  isTrialing,
} from '@/lib/plans/billingAccess';

const HOUR_MS = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('isBillingActive', () => {
  it('grants access to a paid firm', () => {
    expect(isBillingActive({ billingStatus: 'active' })).toBe(true);
  });

  it('grants access to a comped firm whatever its status says', () => {
    expect(isBillingActive({ billingStatus: 'canceled', comped: true })).toBe(true);
    expect(isBillingActive({ billingStatus: 'past_due', unlimitedOverride: true })).toBe(true);
  });

  it('locks the three inactive statuses', () => {
    expect(isBillingLocked({ billingStatus: 'incomplete' })).toBe(true);
    expect(isBillingLocked({ billingStatus: 'past_due' })).toBe(true);
    expect(isBillingLocked({ billingStatus: 'canceled' })).toBe(true);
  });

  it('locks an unrecognized status rather than failing open', () => {
    expect(isBillingLocked({ billingStatus: 'something_new' })).toBe(true);
    expect(isBillingLocked({ billingStatus: null })).toBe(true);
    expect(isBillingLocked(null)).toBe(true);
  });

  it('grants access to a trial that is still running', () => {
    expect(isBillingActive({ billingStatus: 'trialing', trialEndsAt: iso(48 * HOUR_MS) })).toBe(true);
  });

  it('locks a no-card trial whose end date has passed', () => {
    expect(isBillingActive({ billingStatus: 'trialing', trialEndsAt: iso(-HOUR_MS) })).toBe(false);
  });

  it('leaves a Stripe-tracked trial alone once its date passes', () => {
    // Stripe moves this firm to active or past_due by webhook. Expiring it here
    // would lock a firm that has already paid.
    expect(isBillingActive({
      billingStatus: 'trialing',
      trialEndsAt: iso(-HOUR_MS),
      stripeSubscriptionId: 'sub_123',
    })).toBe(true);
  });

  it('treats a trial with no end date, or an unparseable one, as live', () => {
    expect(isBillingActive({ billingStatus: 'trialing' })).toBe(true);
    expect(isBillingActive({ billingStatus: 'trialing', trialEndsAt: 'not-a-date' })).toBe(true);
  });

  it('still honours comped over an expired trial', () => {
    expect(isBillingActive({
      billingStatus: 'trialing',
      trialEndsAt: iso(-HOUR_MS),
      comped: true,
    })).toBe(true);
  });
});

describe('status helpers', () => {
  it('isTrialExpired answers only for trials', () => {
    expect(isTrialExpired({ billingStatus: 'canceled', trialEndsAt: iso(-HOUR_MS) })).toBe(false);
    expect(isTrialExpired({ billingStatus: 'trialing', trialEndsAt: iso(-HOUR_MS) })).toBe(true);
  });

  it('isTrialing normalizes both spellings', () => {
    expect(isTrialing('trialing')).toBe(true);
    expect(isTrialing('active')).toBe(false);
  });

  it('isBillingIncomplete matches only the never-checked-out status', () => {
    expect(isBillingIncomplete('incomplete')).toBe(true);
    expect(isBillingIncomplete('canceled')).toBe(false);
  });
});

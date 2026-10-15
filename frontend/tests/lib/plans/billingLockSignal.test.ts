/**
 * The 402 broadcast the firm layout listens on.
 *
 * A 402 is the ONLY signal available when the cached billing status is stale, so
 * the parsing here decides whether a locked firm gets the paywall or a page full
 * of red banners. What has to break for these to go red: a listener that stops
 * being called, an unsubscribe that does not unsubscribe, a firm id read out of
 * the wrong URL segment (which would route the lock to the wrong firm, or to
 * none), or a `details.billingStatus` that stops reaching the screen (which
 * downgrades the paywall to its unknown-cause wording).
 */
import {
  billingStatusFromBody,
  emitBillingLock,
  lawFirmIdFromUrl,
  onBillingLock,
} from '@/lib/plans/billingLockSignal';

describe('onBillingLock', () => {
  it('delivers a signal to every subscriber', () => {
    const a = jest.fn();
    const b = jest.fn();
    const offA = onBillingLock(a);
    const offB = onBillingLock(b);

    emitBillingLock({ lawFirmId: 'firm-1', billingStatus: 'past_due' });

    expect(a).toHaveBeenCalledWith({ lawFirmId: 'firm-1', billingStatus: 'past_due' });
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it('stops delivering after unsubscribe', () => {
    const listener = jest.fn();
    const off = onBillingLock(listener);
    off();

    emitBillingLock({ lawFirmId: 'firm-1', billingStatus: null });

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps delivering when one listener throws', () => {
    // The emitter runs inside apiFetch. A subscriber that throws must not turn
    // one firm's 402 into a failed request for everything else on the page.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const thrower = jest.fn(() => {
      throw new Error('listener blew up');
    });
    const survivor = jest.fn();
    const offA = onBillingLock(thrower);
    const offB = onBillingLock(survivor);

    expect(() => emitBillingLock({ lawFirmId: null, billingStatus: null })).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);

    offA();
    offB();
    consoleError.mockRestore();
  });
});

describe('lawFirmIdFromUrl', () => {
  it('reads the firm id out of a firm workspace route', () => {
    expect(lawFirmIdFromUrl('https://api.example.com/api/lawfirms/firm-1/matters?limit=25'))
      .toBe('firm-1');
  });

  it('reads the firm id out of a client portal route', () => {
    expect(lawFirmIdFromUrl('https://api.example.com/api/client-portal/lawfirm/firm-2/invoices'))
      .toBe('firm-2');
  });

  it('decodes an encoded id', () => {
    expect(lawFirmIdFromUrl('/api/lawfirms/firm%2F3/tasks')).toBe('firm/3');
  });

  it('returns null for a route that names no firm', () => {
    expect(lawFirmIdFromUrl('https://api.example.com/api/users/profile')).toBeNull();
  });
});

describe('billingStatusFromBody', () => {
  it('reads the status the backend puts in details', () => {
    expect(billingStatusFromBody({
      error: 'inactive',
      code: 'BILLING_INACTIVE',
      details: { billingStatus: 'canceled' },
    })).toBe('canceled');
  });

  it('returns null when the body carries no usable status', () => {
    expect(billingStatusFromBody({ details: {} })).toBeNull();
    expect(billingStatusFromBody({ details: { billingStatus: '' } })).toBeNull();
    expect(billingStatusFromBody({ details: null })).toBeNull();
    expect(billingStatusFromBody('nope')).toBeNull();
    expect(billingStatusFromBody(null)).toBeNull();
  });
});

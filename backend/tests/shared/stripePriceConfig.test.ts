/**
 * `verifyStripePriceConfig` compares the configured Stripe price IDs with what the
 * code charges for each plan (`PLAN_TIERS[plan].pricing`).
 *
 * It exists because every "annual" price ID in local and staging was a copy of the
 * monthly one: an annual checkout billed the monthly amount every month, and
 * `planFromPriceId` recorded the subscription as monthly. Nothing failed. Each case
 * here is one way a price can be wrong while every request still succeeds.
 */
import { verifyStripePriceConfig, type StripePriceFacts } from '../../src/shared/plans/stripePriceConfig';

const MAP = {
  basic: { monthly: 'price_bm', annual: 'price_ba' },
  professional: { monthly: 'price_pm', annual: 'price_pa' },
  enterprise: { monthly: 'price_em', annual: 'price_ea' },
};

const price = (unitAmount: number, interval: 'month' | 'year', extra: Partial<StripePriceFacts> = {}): StripePriceFacts => ({
  unitAmount, currency: 'usd', interval, intervalCount: 1, active: true, ...extra,
});

/** The prices the code's plan table expects, keyed by id. */
const CORRECT: Record<string, StripePriceFacts> = {
  price_bm: price(2000, 'month'), price_ba: price(20000, 'year'),
  price_pm: price(5000, 'month'), price_pa: price(50000, 'year'),
  price_em: price(10000, 'month'), price_ea: price(100000, 'year'),
};

describe('verifyStripePriceConfig', () => {
  it('passes a configuration that matches the plan table', () => {
    expect(verifyStripePriceConfig(MAP, CORRECT)).toEqual([]);
  });

  it('flags one price id used for two slots, the way every annual id was a monthly copy', () => {
    const map = { ...MAP, basic: { monthly: 'price_bm', annual: 'price_bm' } };
    const problems = verifyStripePriceConfig(map, CORRECT);
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('basic monthly and basic annual share price price_bm'),
      expect.stringContaining('basic annual: bills every 1 month, expected every 1 year'),
      expect.stringContaining('basic annual: 2000 cents, expected 20000'),
    ]));
  });

  it('flags a wrong amount, a wrong interval, another currency and an archived price', () => {
    const problems = verifyStripePriceConfig(MAP, {
      ...CORRECT,
      price_pm: price(4900, 'month'),
      price_pa: price(50000, 'month'),
      price_em: price(10000, 'month', { currency: 'eur' }),
      price_ea: price(100000, 'year', { active: false }),
    });
    expect(problems).toEqual([
      'professional monthly: 4900 cents, expected 5000',
      'professional annual: bills every 1 month, expected every 1 year',
      'enterprise monthly: currency eur, expected usd',
      'enterprise annual: price price_ea is archived',
    ]);
  });

  it('flags a missing id and an id Stripe does not know', () => {
    const map = { ...MAP, enterprise: { monthly: null, annual: 'price_gone' } };
    expect(verifyStripePriceConfig(map, CORRECT)).toEqual([
      'enterprise monthly: no price id configured',
      'enterprise annual: price price_gone was not found in this Stripe account',
    ]);
  });
});

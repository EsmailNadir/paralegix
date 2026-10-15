/**
 * Plan and billing-interval labels for the subscription panel and the admin
 * firm pages, plus the recurring-price string.
 *
 * `formatPlanPrice` is the one that touches money: the stored value is integer
 * cents, so a version that forgot to divide would print a $500 plan as
 * "$50,000.00/yr", and one that printed a price for a comped firm would
 * advertise a charge that is not happening. Both are pinned.
 */
import {
  INTERVAL_LABELS,
  PLAN_LABELS,
  formatPlanPrice,
  intervalAdverb,
  intervalLabel,
  planLabel,
} from '@/lib/plans/planLabels';

describe('planLabel', () => {
  it.each([
    ['starter', 'Starter'],
    ['basic', 'Basic'],
    ['professional', 'Professional'],
    ['enterprise', 'Enterprise'],
  ])('labels %p as %p', (id, label) => {
    expect(planLabel(id)).toBe(label);
    expect(PLAN_LABELS[id]).toBe(label);
  });

  it('shows an unknown plan id as-is rather than blank', () => {
    expect(planLabel('legacy_gold')).toBe('legacy_gold');
  });

  it('shows a dash for no plan', () => {
    expect(planLabel(null)).toBe('-');
    expect(planLabel(undefined)).toBe('-');
    expect(planLabel('')).toBe('-');
  });
});

describe('intervalLabel', () => {
  it('labels the stored intervals and passes an unknown one through', () => {
    expect(intervalLabel('monthly')).toBe('Monthly');
    expect(intervalLabel('annual')).toBe('Annual');
    expect(INTERVAL_LABELS).toEqual({ monthly: 'Monthly', annual: 'Annual' });
    expect(intervalLabel('weekly')).toBe('weekly');
  });

  it('is null for no interval', () => {
    expect(intervalLabel(null)).toBeNull();
    expect(intervalLabel('')).toBeNull();
  });
});

describe('intervalAdverb', () => {
  it('reads after "Billed": annually, monthly, or the raw value', () => {
    expect(intervalAdverb('annual')).toBe('annually');
    expect(intervalAdverb('monthly')).toBe('monthly');
    expect(intervalAdverb('quarterly')).toBe('quarterly');
  });

  it('is null for no interval', () => {
    expect(intervalAdverb(undefined)).toBeNull();
    expect(intervalAdverb('')).toBeNull();
  });
});

describe('formatPlanPrice', () => {
  it('formats integer cents as dollars with the interval suffix', () => {
    expect(formatPlanPrice({ billingInterval: 'annual', planPriceCents: 50000 })).toBe('$500.00/yr');
    expect(formatPlanPrice({ billingInterval: 'monthly', planPriceCents: 5000 })).toBe('$50.00/mo');
  });

  it('groups thousands and keeps cents exact', () => {
    expect(formatPlanPrice({ billingInterval: 'annual', planPriceCents: 123456 })).toBe('$1,234.56/yr');
  });

  it('prints a zero price rather than hiding it, since $0 is a real (free) price', () => {
    expect(formatPlanPrice({ billingInterval: 'monthly', planPriceCents: 0 })).toBe('$0.00/mo');
  });

  it('omits the suffix for an interval it has no suffix for', () => {
    expect(formatPlanPrice({ billingInterval: 'weekly', planPriceCents: 1000 })).toBe('$10.00');
  });

  it('is null when the firm is not on a priced interval', () => {
    expect(formatPlanPrice({ billingInterval: null, planPriceCents: 5000 })).toBeNull();
    expect(formatPlanPrice({ billingInterval: 'monthly', planPriceCents: null })).toBeNull();
    expect(formatPlanPrice({ billingInterval: 'monthly' })).toBeNull();
    expect(formatPlanPrice({})).toBeNull();
  });
});

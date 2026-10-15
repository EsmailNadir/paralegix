import { paymentPlanCadenceLabel } from '@/components/billingComp/utils';

describe('paymentPlanCadenceLabel', () => {
  it.each([
    [7, 'week'],
    [14, '2 wks'],
    [30, 'month'],
    [1, '1 day'],
    [10, '10 days'],
    [31, '31 days'],
    [365, '365 days'],
  ])('labels %i days as "%s"', (days, label) => {
    expect(paymentPlanCadenceLabel(days)).toBe(label);
  });

  it('reads a plan with no cadence on record as monthly, as the server does', () => {
    expect(paymentPlanCadenceLabel(undefined)).toBe('month');
    expect(paymentPlanCadenceLabel(null)).toBe('month');
    expect(paymentPlanCadenceLabel(0)).toBe('month');
  });
});

/**
 * "Split into N" refuses a count that would leave a payment under one cent.
 *
 * Each of the first N - 1 payments is rounded up to a whole cent, so a count near the number
 * of cents in the balance leaves the last payment at nothing or below it, and the server
 * saves fewer rows than the preview showed. The count is refused with a message instead.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import PaymentPlanFields, {
  buildPaymentPlanPayload,
  buildPaymentPlanSchedule,
  EMPTY_PAYMENT_PLAN,
  paymentCountError,
} from '@/components/billingComp/PaymentPlanFields';

const countForm = (n: number, extra: Record<string, unknown> = {}) => ({
  ...EMPTY_PAYMENT_PLAN, installmentMode: 'count' as const, paymentCount: String(n), frequency: '30', startDate: '2026-04-01', ...extra,
});

describe('paymentCountError', () => {
  it('refuses 101 payments of $100.00, where the last would be $0.00', () => {
    expect(paymentCountError(100, 101)).toMatch(/cannot be split into 101 payments/);
  });

  it('refuses 89 payments of $50.00, where the last would be below zero', () => {
    expect(paymentCountError(50, 89)).toMatch(/cannot be split into 89 payments/);
  });

  it('accepts 100 payments of $100.00, every one a dollar', () => {
    expect(paymentCountError(100, 100)).toBeNull();
  });

  it('accepts a count whose last payment is exactly one cent', () => {
    // 10,000 cents in 102 payments: 101 x 99 cents = 9,999, leaving one cent.
    expect(paymentCountError(100, 102)).toBeNull();
  });

  it('accepts an ordinary split', () => {
    expect(paymentCountError(1000, 4)).toBeNull();
  });

  it('has nothing to say about an empty or zero count', () => {
    expect(paymentCountError(100, 0)).toBeNull();
    expect(paymentCountError(100, NaN)).toBeNull();
  });
});

describe('a count the balance cannot be split into', () => {
  it('previews no rows and refuses to build a payload', () => {
    expect(buildPaymentPlanSchedule(countForm(101), 100)).toEqual([]);

    const built = buildPaymentPlanPayload(countForm(101), 100);
    expect(built.payload).toBeUndefined();
    expect(built.error).toMatch(/Use fewer payments/);
  });

  it('never previews a payment of zero or less for $50.00 into 89', () => {
    expect(buildPaymentPlanSchedule(countForm(89), 50)).toEqual([]);
  });

  it('checks the balance left after a down payment, not the whole balance', () => {
    // $101.00 less a $1.00 down payment leaves $100.00, which cannot be split into 101 payments,
    // though the whole $101.00 could be.
    const values = countForm(101, { downPayment: '1.00', downPaymentPaid: true });
    expect(paymentCountError(101, 101)).toBeNull();
    expect(buildPaymentPlanSchedule(values, 101).filter((r) => !r.isDownPayment)).toEqual([]);
    expect(buildPaymentPlanPayload(values, 101).error).toMatch(/Use fewer payments/);
  });

  it('still previews one row per payment, each at least a cent, for a count that fits', () => {
    const rows = buildPaymentPlanSchedule(countForm(100), 100).map((r) => Math.round(r.amount * 100));
    expect(rows).toHaveLength(100);
    expect(rows.every((r) => r >= 1)).toBe(true);
    expect(rows.reduce((a, b) => a + b, 0)).toBe(10_000);
  });
});

describe('the form', () => {
  it('shows the message beneath the payment count', () => {
    render(
      <PaymentPlanFields
        values={countForm(101)}
        onChange={() => {}}
        balance={100}
        radioName="plan-test"
      />,
    );

    expect(screen.getByRole('alert').textContent).toMatch(/cannot be split into 101 payments/);
  });

  it('shows no message for a count that fits', () => {
    render(
      <PaymentPlanFields
        values={countForm(4)}
        onChange={() => {}}
        balance={100}
        radioName="plan-test"
      />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
  });
});

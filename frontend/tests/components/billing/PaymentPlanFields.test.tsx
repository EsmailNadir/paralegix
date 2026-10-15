import { render, screen } from '@testing-library/react';
import PaymentPlanFields, {
  buildPaymentPlanSchedule,
  buildPaymentPlanPayload,
  EMPTY_PAYMENT_PLAN,
  type PaymentPlanFormValues,
} from '@/components/billingComp/PaymentPlanFields';

describe('PaymentPlanFields and Calculation Utilities', () => {
  describe('buildPaymentPlanSchedule', () => {
    it('generates schedule for count mode with equal installments', () => {
      const values: PaymentPlanFormValues = {
        ...EMPTY_PAYMENT_PLAN,
        installmentMode: 'count',
        paymentCount: '4',
        frequency: '30',
        startDate: '2026-09-01',
      };

      const schedule = buildPaymentPlanSchedule(values, 1000.0);
      expect(schedule).toHaveLength(4);
      expect(schedule[0].amount).toBe(250.0);
      expect(schedule[3].amount).toBe(250.0);
    });

    it('includes down payment row when downPayment is specified', () => {
      const values: PaymentPlanFormValues = {
        ...EMPTY_PAYMENT_PLAN,
        installmentMode: 'count',
        paymentCount: '2',
        downPayment: '200.00',
        downPaymentPaid: true,
        frequency: '14',
        startDate: '2026-09-01',
      };

      const schedule = buildPaymentPlanSchedule(values, 1000.0);
      expect(schedule).toHaveLength(3); // 1 down payment + 2 installments
      expect(schedule[0].label).toBe('Down Payment');
      expect(schedule[0].amount).toBe(200.0);
      expect(schedule[1].amount).toBe(400.0);
      expect(schedule[2].amount).toBe(400.0);
    });
  });

  describe('buildPaymentPlanPayload', () => {
    it('validates and returns formatted payload for valid form values', () => {
      const values: PaymentPlanFormValues = {
        ...EMPTY_PAYMENT_PLAN,
        installmentMode: 'count',
        paymentCount: '3',
        frequency: '30',
        startDate: '2026-09-01',
      };

      const result = buildPaymentPlanPayload(values, 900.0);
      expect(result.error).toBeUndefined();
      expect(result.payload).toBeDefined();
      expect(result.payload?.installmentAmount).toBe(300.0);
      expect(result.payload?.frequencyDays).toBe(30);
      expect(result.payload?.planStartDate).toBe('2026-09-01');
    });

    it('returns error when down payment exceeds balance', () => {
      const values: PaymentPlanFormValues = {
        ...EMPTY_PAYMENT_PLAN,
        downPayment: '1200.00',
      };

      const result = buildPaymentPlanPayload(values, 1000.0);
      expect(result.error).toContain('Down payment must be less than the remaining balance');
    });

    it('returns error when start date is missing', () => {
      const values: PaymentPlanFormValues = {
        ...EMPTY_PAYMENT_PLAN,
        installmentMode: 'count',
        paymentCount: '2',
        startDate: '',
      };

      const result = buildPaymentPlanPayload(values, 500.0);
      expect(result.error).toContain('Select a start date');
    });

    describe('installment cap', () => {
      const base: PaymentPlanFormValues = {
        ...EMPTY_PAYMENT_PLAN,
        installmentMode: 'amount',
        frequency: '30',
        startDate: '2026-09-01',
      };
      const LIMIT = /can have at most 120/;

      it('accepts exactly 120 installments and refuses 121 by amount', () => {
        expect(buildPaymentPlanPayload({ ...base, installmentAmount: '10' }, 1200).error).toBeUndefined();
        expect(buildPaymentPlanPayload({ ...base, installmentAmount: '10' }, 1200.01).error).toMatch(LIMIT);
      });

      it('refuses 0.01 on 10,000 with the limit and a hint to raise the amount', () => {
        const result = buildPaymentPlanPayload({ ...base, installmentAmount: '0.01' }, 10_000);
        expect(result.error).toMatch(LIMIT);
        expect(result.error).toMatch(/larger installment amount/i);
      });

      it('refuses a payment count above 120 and accepts 120', () => {
        const count = { ...base, installmentMode: 'count' as const };
        expect(buildPaymentPlanPayload({ ...count, paymentCount: '120' }, 1200).error).toBeUndefined();
        expect(buildPaymentPlanPayload({ ...count, paymentCount: '121' }, 1200).error).toMatch(LIMIT);
      });

      it('counts the down payment as one of the 120', () => {
        const withDown = { ...base, installmentAmount: '10', downPayment: '10', downPaymentPaid: true };
        expect(buildPaymentPlanPayload(withDown, 1200).error).toBeUndefined();
        expect(buildPaymentPlanPayload(withDown, 1210).error).toMatch(LIMIT);
      });

      it('does not build a preview with more than 120 rows', () => {
        expect(buildPaymentPlanSchedule({ ...base, installmentAmount: '0.01' }, 10_000)).toEqual([]);
        expect(buildPaymentPlanSchedule({ ...base, installmentAmount: '10' }, 1200)).toHaveLength(120);
      });
    });

    describe('typed amounts', () => {
      const base: PaymentPlanFormValues = {
        ...EMPTY_PAYMENT_PLAN,
        installmentMode: 'amount',
        frequency: '30',
        startDate: '2026-09-01',
      };

      it('refuses an installment amount with a third decimal place instead of rounding it', () => {
        const result = buildPaymentPlanPayload({ ...base, installmentAmount: '300.005' }, 1200);
        expect(result).toEqual({ error: 'Amounts can have at most two decimal places.' });
      });

      it('refuses a down payment with a third decimal place', () => {
        const result = buildPaymentPlanPayload(
          { ...base, installmentAmount: '300', downPayment: '0.004', downPaymentPaid: true }, 1200);
        expect(result).toEqual({ error: 'Amounts can have at most two decimal places.' });
      });

      it('accepts whole cents, including 0.01 and 33.33', () => {
        expect(buildPaymentPlanPayload({ ...base, installmentAmount: '0.01' }, 1.2).payload?.installmentAmount).toBe(0.01);
        expect(buildPaymentPlanPayload({ ...base, installmentAmount: '33.33' }, 1200).payload?.installmentAmount).toBe(33.33);
      });

      it('treats a typed down payment of 0 or 0.00 as no down payment', () => {
        for (const downPayment of ['0', '0.00']) {
          const result = buildPaymentPlanPayload({ ...base, installmentAmount: '300', downPayment }, 1200);
          expect(result.error).toBeUndefined();
          expect(result.payload).not.toHaveProperty('downPaymentAmount');
        }
      });

      it('keeps the existing wording for a missing or non-positive installment', () => {
        expect(buildPaymentPlanPayload({ ...base, installmentAmount: '' }, 1200))
          .toEqual({ error: 'Enter a valid installment amount' });
        expect(buildPaymentPlanPayload({ ...base, installmentAmount: '0' }, 1200))
          .toEqual({ error: 'Enter a valid installment amount' });
      });

      it('keeps the existing wording for a malformed down payment', () => {
        expect(buildPaymentPlanPayload({ ...base, installmentAmount: '300', downPayment: 'abc' }, 1200))
          .toEqual({ error: 'Enter a valid down payment amount' });
      });
    });
  });

  describe('PaymentPlanFields Component', () => {
    it('renders strategy radio buttons and input fields', () => {
      const handleChange = jest.fn();
      const values: PaymentPlanFormValues = {
        ...EMPTY_PAYMENT_PLAN,
        installmentMode: 'count',
        paymentCount: '3',
        startDate: '2026-09-01',
      };

      render(
        <PaymentPlanFields
          values={values}
          onChange={handleChange}
          balance={600.0}
          radioName="test-plan"
        />,
      );

      expect(screen.getByText('Installment Strategy')).toBeInTheDocument();
      expect(screen.getByText('Split into N')).toBeInTheDocument();
      expect(screen.getByText('Fixed amount')).toBeInTheDocument();
      expect(screen.getByText(/Generated Schedule Preview/i)).toBeInTheDocument();
    });
  });
});

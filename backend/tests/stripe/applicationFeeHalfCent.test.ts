/**
 * The platform fees are a percentage of a charge, rounded half up to a whole
 * cent on integers. A float product lands a hair under an exact half cent
 * (1500 x 0.009 is 13.499999999999998), so the fee for a $15.00 direct charge
 * must read 14 cents and not 13.
 *
 * The pricing environment variables are removed so the defaults (0.9% direct,
 * 3.8% + 30 cents destination, 0.8% ACH trust fee capped at $5) are what run.
 *
 * RED IF: a fee goes back to a float product, or rounds a half cent down.
 */
delete process.env.STRIPE_DIRECT_APPLICATION_FEE_RATE;
delete process.env.STRIPE_DIRECT_APPLICATION_FEE_FIXED_CENTS;
delete process.env.STRIPE_APPLICATION_FEE_RATE;
delete process.env.STRIPE_APPLICATION_FEE_FIXED_CENTS;
delete process.env.STRIPE_TRUST_ACH_FEE_RATE;
delete process.env.STRIPE_TRUST_ACH_FEE_CAP_CENTS;

jest.mock('../../src/modules/stripe/stripe.config', () => ({}));

import { applicationFeeCents } from '../../src/modules/stripe/processingFees';
import { computeTrustAchFeeCents } from '../../src/modules/stripe/stripe.service';

describe('direct application fee (0.9%, no fixed part)', () => {
  it.each([[1500, 14], [500, 5], [4800, 43], [48000, 432], [1, 0], [0, 0]])(
    '%p cents is a %p cent fee',
    (charge, fee) => {
      // A direct charge keeps only the margin, whatever the method.
      expect(applicationFeeCents('card', charge, true)).toBe(fee);
      expect(applicationFeeCents('bank', charge, true)).toBe(fee);
    },
  );
});

describe('destination card application fee (3.8% + 30 cents)', () => {
  it.each([[1250, 78], [2500, 125], [10, 10]])(
    '%p cents is a %p cent fee, never above the charge',
    (charge, fee) => expect(applicationFeeCents('card', charge, false)).toBe(fee),
  );
});

describe('ACH trust deposit fee (0.8%, capped)', () => {
  it.each([[1500, 12], [62500, 500], [62, 0], [63, 1]])(
    '%p cents is a %p cent fee',
    (deposit, fee) => expect(computeTrustAchFeeCents(deposit)).toBe(fee),
  );
});

/**
 * Every processing-fee number, pinned to the cent. Nothing here is visible on
 * screen: a wrong gross-up silently shorts the firm or overcharges its client.
 * The pricing env vars are deleted first so the defaults are what runs, and the
 * module is loaded in an isolated registry so that deletion is what it reads.
 */
const FEE_ENV = [
  'STRIPE_APPLICATION_FEE_RATE', 'STRIPE_APPLICATION_FEE_FIXED_CENTS',
  'STRIPE_ACH_FEE_RATE', 'STRIPE_ACH_FEE_CAP_CENTS',
  'STRIPE_DIRECT_APPLICATION_FEE_RATE', 'STRIPE_DIRECT_APPLICATION_FEE_FIXED_CENTS',
];
let fees: typeof import('../../src/modules/stripe/processingFees');

function withFeeSchedule(overrides: Record<string, string>, run: (configured: typeof fees) => void) {
  const saved = new Map(FEE_ENV.map((key) => [key, process.env[key]]));
  try {
    for (const key of FEE_ENV) {
      if (key in overrides) process.env[key] = overrides[key];
      else delete process.env[key];
    }
    jest.isolateModules(() => run(require('../../src/modules/stripe/processingFees')));
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeAll(() => {
  for (const key of FEE_ENV) delete process.env[key];
  jest.isolateModules(() => {
    fees = require('../../src/modules/stripe/processingFees');
  });
});

describe('estimatedCostCents', () => {
  it('charges a card 3.8% plus 30 cents', () => {
    // round(100000 * 0.038) = 3800, plus 30.
    expect(fees.estimatedCostCents('card', 100_000)).toBe(3_830);
  });

  it('charges a bank transfer 0.8% capped at $5, plus 0.9% uncapped', () => {
    // 0.8% of $100 is 80c (under the cap), 0.9% is 90c.
    expect(fees.estimatedCostCents('bank', 10_000)).toBe(170);
    // 0.8% of $1,000 is $8, capped to $5; 0.9% is $9.
    expect(fees.estimatedCostCents('bank', 100_000)).toBe(1_400);
  });

  it('never exceeds the charge itself', () => {
    expect(fees.estimatedCostCents('card', 10)).toBe(10);
  });
});

describe('applicationFeeCents', () => {
  it('takes the full card cost on a destination charge', () => {
    expect(fees.applicationFeeCents('card', 38_000, false)).toBe(1_474);
  });

  it('takes the lower bank cost on a destination charge', () => {
    // min(round(38000 * 0.008) = 304, 500) + round(38000 * 0.009) = 342.
    expect(fees.applicationFeeCents('bank', 38_000, false)).toBe(646);
  });

  it('takes only the 0.9% margin on a direct charge, whatever the method', () => {
    expect(fees.applicationFeeCents('card', 100_000, true)).toBe(900);
    expect(fees.applicationFeeCents('bank', 100_000, true)).toBe(900);
  });
});

describe('clientSurchargeCents (gross-up)', () => {
  it.each([
    // [method, invoice cents, surcharge cents]
    ['card', 100_000, 3_981],
    ['card', 38_000, 1_532],
    ['card', 250_000, 9_906],
    ['bank', 100_000, 1_413],
    ['bank', 38_000, 657],
    ['bank', 250_000, 2_775],
  ] as const)('%s on %i cents adds %i cents', (method, invoiceCents, expected) => {
    expect(fees.clientSurchargeCents(method, invoiceCents)).toBe(expected);
  });

  it('leaves the firm exactly the invoice amount after the destination fee', () => {
    for (const method of ['card', 'bank'] as const) {
      for (const invoiceCents of [1, 99, 12_345, 100_000, 987_654]) {
        const gross = invoiceCents + fees.clientSurchargeCents(method, invoiceCents);
        expect(gross - fees.applicationFeeCents(method, gross, false)).toBeGreaterThanOrEqual(invoiceCents);
        // One cent less would short the firm, so the surcharge is the smallest that works.
        const oneLess = gross - 1;
        if (oneLess >= invoiceCents) {
          expect(oneLess - fees.applicationFeeCents(method, oneLess, false)).toBeLessThan(invoiceCents);
        }
      }
    }
  });

  it('is zero on a non-positive invoice', () => {
    expect(fees.clientSurchargeCents('card', 0)).toBe(0);
  });

  it('prices the maximum invoice without work proportional to its amount', () => {
    jest.isolateModules(() => {
      const money = require('../../src/modules/billing/shared/money');
      const originalPercent = money.percentOfCents;
      const percentSpy = jest.spyOn(money, 'percentOfCents').mockImplementation((...args: unknown[]) => {
        // Stop the broken linear scan immediately instead of freezing this test.
        if (percentSpy.mock.calls.length > 200) throw new Error('Gross-up exceeded 200 percentage calculations');
        return originalPercent(...args);
      });
      try {
        const scopedFees = require('../../src/modules/stripe/processingFees');
        const invoiceCents = money.MAX_MONEY_AMOUNT * 100;
        expect(scopedFees.clientSurchargeCents('bank', invoiceCents)).toBe(908_174_067);
        expect(scopedFees.clientSurchargeCents('card', invoiceCents)).toBe(3_950_103_981);
        expect(percentSpy.mock.calls.length).toBeLessThanOrEqual(200);
      } finally {
        percentSpy.mockRestore();
      }
    });
  });

  it.each([61_200, 61_437, 61_438, 61_439, 61_500, 61_999])(
    'charges the smallest exact bank surcharge across the cap for %i cents', (invoice) => {
      let smallestGross = invoice;
      const cost = (gross: number) => Math.min(Math.floor((gross * 8 + 500) / 1_000), 500)
        + Math.floor((gross * 9 + 500) / 1_000);
      while (smallestGross - cost(smallestGross) < invoice) smallestGross += 1;
      expect(fees.clientSurchargeCents('bank', invoice)).toBe(smallestGross - invoice);
    },
  );

  it('finds the earliest sufficient gross when overridden bank rates round together', () => {
    withFeeSchedule({ STRIPE_ACH_FEE_RATE: '0.25', STRIPE_DIRECT_APPLICATION_FEE_RATE: '0.25' }, (configured) => {
      // At gross 1 both fees round to zero; at gross 2 both round to one.
      // A search assuming the net always increases skips the valid one-cent gross.
      expect(configured.clientSurchargeCents('bank', 1)).toBe(0);
      for (const invoice of [3, 99, 501, 999, 1_501]) {
        let smallestGross = invoice;
        const cost = (gross: number) => Math.min(Math.floor((gross + 2) / 4), 500)
          + Math.floor((gross + 2) / 4);
        while (smallestGross - cost(smallestGross) < invoice) smallestGross += 1;
        expect(configured.clientSurchargeCents('bank', invoice)).toBe(smallestGross - invoice);
      }
    });
  });

  it('uses overridden rate precision, card fixed fee and bank cap in the gross-up', () => {
    withFeeSchedule({
      STRIPE_APPLICATION_FEE_RATE: '0.042156',
      STRIPE_APPLICATION_FEE_FIXED_CENTS: '55',
      STRIPE_ACH_FEE_RATE: '0.007896',
      STRIPE_ACH_FEE_CAP_CENTS: '111',
      STRIPE_DIRECT_APPLICATION_FEE_RATE: '0.012346',
    }, (configured) => {
      for (const method of ['card', 'bank'] as const) {
        for (const invoice of [1, 99, 1_001, 13_800, 14_000, 14_200, 100_000]) {
          const cost = (gross: number) => method === 'card'
            ? Math.floor((gross * 4_216 + 50_000) / 100_000) + 55
            : Math.min(Math.floor((gross * 790 + 50_000) / 100_000), 111)
              + Math.floor((gross * 1_235 + 50_000) / 100_000);
          let smallestGross = invoice;
          while (smallestGross - cost(smallestGross) < invoice) smallestGross += 1;
          expect(configured.clientSurchargeCents(method, invoice)).toBe(smallestGross - invoice);
        }
      }
    });
  });
});

/**
 * `computeLateFeeCents`, the arithmetic behind a late fee.
 *
 * Pure, so it needs no database and no request, and it is the kind of code an
 * end-to-end test reaches only through twenty setups. Money is integer cents,
 * a flat component is dollars converted with `toCents`, and the percentage is
 * applied to the REMAINING balance rather than the invoice total, so a partly
 * paid invoice is charged on what is still owed.
 *
 * Every case here states a figure a client would be billed, so a wrong answer is
 * a wrong bill rather than a cosmetic defect.
 */
const { computeLateFeeCents } = require('../../src/modules/billing/invoices/invoices.service');

describe('computeLateFeeCents', () => {
  describe('when it charges nothing', () => {
    it('returns 0 when no late fee is configured', () => {
      expect(computeLateFeeCents(100_000, null)).toBe(0);
      expect(computeLateFeeCents(100_000, undefined)).toBe(0);
    });

    it('returns 0 when the fee exists but is not enabled', () => {
      // `enabled !== true` on purpose: a stored `"true"` string or a missing key
      // must not switch on a charge to a client.
      expect(computeLateFeeCents(100_000, { enabled: false, flatAmount: 25 })).toBe(0);
      expect(computeLateFeeCents(100_000, { flatAmount: 25 })).toBe(0);
      expect(computeLateFeeCents(100_000, { enabled: 'true', flatAmount: 25 })).toBe(0);
    });

    it('returns 0 when nothing is owed', () => {
      // A fully paid or over-paid invoice cannot attract a late fee.
      expect(computeLateFeeCents(0, { enabled: true, flatAmount: 25 })).toBe(0);
      expect(computeLateFeeCents(-5_000, { enabled: true, flatAmount: 25 })).toBe(0);
    });

    it('returns 0 when the configured fee comes to nothing', () => {
      expect(computeLateFeeCents(100_000, { enabled: true })).toBe(0);
      expect(computeLateFeeCents(100_000, { enabled: true, flatAmount: 0, percent: 0 })).toBe(0);
    });
  });

  describe('the flat component', () => {
    it('converts dollars to cents', () => {
      // The stored value is dollars; the return is cents. Getting this backwards
      // is a 100x error on a real invoice.
      expect(computeLateFeeCents(100_000, { enabled: true, flatAmount: 25 })).toBe(2_500);
    });

    it('handles a fractional dollar amount', () => {
      expect(computeLateFeeCents(100_000, { enabled: true, flatAmount: 12.34 })).toBe(1_234);
    });

    it('ignores a non-numeric amount rather than producing NaN', () => {
      // A NaN here would be written to a bigint cents column.
      expect(computeLateFeeCents(100_000, { enabled: true, flatAmount: 'abc' })).toBe(0);
    });
  });

  describe('the percentage component', () => {
    it('applies the percentage to the REMAINING balance, not the invoice total', () => {
      // 1.5% of $1,000 remaining.
      expect(computeLateFeeCents(100_000, { enabled: true, percent: 1.5 })).toBe(1_500);
    });

    it('rounds to the nearest cent', () => {
      // 1.5% of $333.33 is 499.995 cents, which must land on a whole cent.
      expect(computeLateFeeCents(33_333, { enabled: true, percent: 1.5 })).toBe(500);
    });

    it('ignores a negative percentage', () => {
      // A negative fee would be a credit applied through the penalty path.
      expect(computeLateFeeCents(100_000, { enabled: true, percent: -5 })).toBe(0);
    });
  });

  describe('both components together', () => {
    it('adds the flat amount to the percentage', () => {
      // $25 flat plus 1.5% of $1,000.
      expect(computeLateFeeCents(100_000, {
        enabled: true, flatAmount: 25, percent: 1.5,
      })).toBe(4_000);
    });

    it('never returns a negative total', () => {
      expect(computeLateFeeCents(100_000, {
        enabled: true, flatAmount: -50, percent: 1,
      })).toBe(0);
    });

    it('scales with the remaining balance, so a part payment lowers the fee', () => {
      const full = computeLateFeeCents(100_000, { enabled: true, percent: 2 });
      const halfPaid = computeLateFeeCents(50_000, { enabled: true, percent: 2 });

      expect(full).toBe(2_000);
      expect(halfPaid).toBe(1_000);
    });
  });
});

/**
 * Generated cases, on top of the hand-picked examples above.
 *
 * The hand-picked cases establish what each rule MEANS (dollars-to-cents,
 * percent-of-remaining, never negative). These generated cases check that the
 * rules hold across a wide sweep of configurations and balances, using three
 * different kinds of oracle so a genuine defect cannot hide behind one weak
 * assertion:
 *
 *  1. A parallel formula, transcribed independently from `computeLateFeeCents`
 *     rather than by calling it - the direct oracle.
 *  2. Additivity: charging the flat and percent components separately and
 *     adding the results must equal charging both together, whenever neither
 *     component is negative (a relationship between two calls of the function
 *     under test, used because it is a genuine algebraic property with no
 *     independent formula simpler than the direct oracle above).
 *  3. Monotonicity: for one fixed fee configuration, a strictly larger
 *     remaining balance can never produce a strictly smaller fee.
 */
describe('computeLateFeeCents: generated cases', () => {
  const SEED = 20260901;

  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Independent re-derivation of the rule (dollars flat -> cents, rounded;
   * percent applied to the remaining balance, rounded half up via `Math.round`;
   * components stack; the total floors at zero), NOT a call to the function
   * under test.
   */
  function expectedFeeCents(remainingCents: number, lateFee: any): number {
    if (!lateFee || lateFee.enabled !== true) return 0;
    if (!(remainingCents > 0)) return 0;
    const flatAmount = Number(lateFee.flatAmount);
    const flatCents = Number.isFinite(flatAmount) ? Math.round(flatAmount * 100) : 0;
    const percent = Number(lateFee.percent);
    const percentCents =
      Number.isFinite(percent) && percent > 0 ? Math.round(remainingCents * (percent / 100)) : 0;
    const fee = flatCents + percentCents;
    return fee > 0 ? fee : 0;
  }

  it('matches an independently-derived formula across a large seeded sweep', () => {
    const rand = mulberry32(SEED);

    const remainingCentsCases = [
      0, -1, 1, 100, // nothing owed, overpaid, one cent, one dollar
      99_999_999_99, // a large allowed total
      ...Array.from({ length: 20 }, () => Math.floor(rand() * 500_000_00)),
    ];
    const flatAmounts = [0, 0.01, -5, 25, 999.99, ...Array.from({ length: 8 }, () => Math.round((rand() * 500 - 50) * 100) / 100)];
    const percents = [0, -3, 1.5, 100, ...Array.from({ length: 8 }, () => Math.round((rand() * 20 - 2) * 100) / 100)];

    let checked = 0;
    for (const remainingCents of remainingCentsCases) {
      for (const flatAmount of flatAmounts) {
        for (const percent of percents) {
          for (const enabled of [true, false]) {
            const lateFee = { enabled, flatAmount, percent };
            const actual = computeLateFeeCents(remainingCents, lateFee);
            const expected = expectedFeeCents(remainingCents, lateFee);
            expect(actual).toBe(expected);
            checked += 1;
          }
        }
      }
    }
    // A sanity floor so a future refactor that shrinks the sweep to nothing
    // does not quietly pass by checking zero cases.
    expect(checked).toBeGreaterThan(1000);
  });

  it('never returns a negative fee, for any generated configuration', () => {
    const rand = mulberry32(SEED + 1);
    for (let i = 0; i < 200; i += 1) {
      const remainingCents = Math.floor(rand() * 2_000_00) - 1_000_00; // includes negative
      const lateFee = {
        enabled: rand() > 0.1,
        flatAmount: Math.round((rand() * 400 - 200) * 100) / 100,
        percent: Math.round((rand() * 40 - 20) * 100) / 100,
      };
      expect(computeLateFeeCents(remainingCents, lateFee)).toBeGreaterThanOrEqual(0);
    }
  });

  it('is additive: charging flat and percent separately sums to charging both together, when neither is negative', () => {
    const rand = mulberry32(SEED + 2);
    for (let i = 0; i < 100; i += 1) {
      const remainingCents = 1 + Math.floor(rand() * 1_000_000_00);
      const flatAmount = Math.round(rand() * 1_000 * 100) / 100; // >= 0
      const percent = Math.round(rand() * 20 * 100) / 100; // >= 0

      const flatOnly = computeLateFeeCents(remainingCents, { enabled: true, flatAmount, percent: 0 });
      const percentOnly = computeLateFeeCents(remainingCents, { enabled: true, flatAmount: 0, percent });
      const both = computeLateFeeCents(remainingCents, { enabled: true, flatAmount, percent });

      expect(both).toBe(flatOnly + percentOnly);
    }
  });

  it('is monotonic: for one fixed configuration, a larger remaining balance never produces a smaller fee', () => {
    const rand = mulberry32(SEED + 3);
    for (let i = 0; i < 30; i += 1) {
      const lateFee = {
        enabled: true,
        flatAmount: Math.round(rand() * 200 * 100) / 100,
        percent: Math.round(rand() * 10 * 100) / 100,
      };

      const balances = Array.from({ length: 10 }, () => Math.floor(rand() * 1_000_000_00)).sort(
        (a, b) => a - b,
      );

      let previousFee = -Infinity;
      for (const remainingCents of balances) {
        const fee = computeLateFeeCents(remainingCents, lateFee);
        expect(fee).toBeGreaterThanOrEqual(previousFee);
        previousFee = fee;
      }
    }
  });
});

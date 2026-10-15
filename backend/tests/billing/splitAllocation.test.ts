import {
  allocateWorkToPayers,
  balanceRoundedShares,
  roundSplitValue,
  FULL_PORTION_BP,
} from '../../src/modules/billing/shared/splitAllocation';

/**
 * Deterministic seeded PRNG (mulberry32), so a failing generated case is
 * reproducible from the seed printed alongside it rather than lost to
 * `Math.random()`. Same generator this slice uses in the other two generated-
 * case files (`timeEntryRoundedAmounts.test.ts`, `lateFeeMath.test.ts`); kept
 * local to each file rather than shared, since it is ten lines and the point
 * is that any one file's failure is reproducible on its own.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random set of payer portions, in basis points, that sum to exactly FULL_PORTION_BP. */
function randomPortions(rand: () => number, count: number): number[] {
  if (count === 1) return [FULL_PORTION_BP];
  const cuts = Array.from({ length: count - 1 }, () => Math.floor(rand() * FULL_PORTION_BP));
  cuts.sort((a, b) => a - b);
  const bounds = [0, ...cuts, FULL_PORTION_BP];
  return bounds.slice(1).map((b, i) => b - bounds[i]);
}

/** Fisher-Yates using the same seeded generator, so a shuffle is reproducible too. */
function shuffle<T>(rand: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const toCentsInt = (dollars: number) => Math.round(dollars * 100);

describe('split allocation rounding', () => {
  it.each([
    [1.006, 1.01],
    ['2.126', 2.13],
    [null, 0],
    [undefined, 0],
  ])('rounds %p to %p', (value, expected) => {
    expect(roundSplitValue(value as number)).toBe(expected);
  });

  it('returns no shares for no payers', () => {
    expect(balanceRoundedShares(10, [])).toEqual([]);
  });

  it('returns zeroes for a zero total', () => {
    expect(balanceRoundedShares(0, [0.33, 0.33, 0.34])).toEqual([0, 0, 0]);
  });

  it('puts the rounding remainder on the last non-zero payer', () => {
    expect(balanceRoundedShares(100, [33.333, 33.333, 33.333])).toEqual([33.33, 33.33, 33.34]);
  });

  it('keeps a split invoice reconciled per line', () => {
    const result = allocateWorkToPayers({
      payers: [
        { clientId: 'payer-a', portionBp: 3333 },
        { clientId: 'payer-b', portionBp: 3333 },
        { clientId: 'payer-c', portionBp: 3334 },
      ],
      timeEntries: [{ id: 'time-1', amount: 100, hours: 1 }],
      flatFees: [{ id: 'fee-1', amount: 10 }],
    });

    expect(result.map((payer) => payer.totalAmount)).toEqual([36.66, 36.66, 36.68]);
    expect(result.reduce((sum, payer) => sum + payer.totalAmount, 0)).toBe(110);
    expect(result.map((payer) => payer.totalHours)).toEqual([0.33, 0.33, 0.34]);
  });

  it('does not give an unused zero-share payer the remainder', () => {
    const result = allocateWorkToPayers({
      payers: [
        { clientId: 'payer-a', portionBp: 5000 },
        { clientId: 'payer-b', portionBp: 0 },
        { clientId: 'payer-c', portionBp: 5000 },
      ],
      timeEntries: [{ amount: 1, hours: 0.1 }],
      flatFees: [],
    });

    expect(result.map((payer) => payer.totalAmount)).toEqual([0.5, 0, 0.5]);
  });
});

/**
 * Generated cases, on top of the hand-picked examples above.
 *
 * A hand-picked example proves the rule reads correctly for one shape. It does
 * not prove the remainder-assignment rule holds for an arbitrary total, payer
 * count, and split, or that the result does not depend on the ORDER lines
 * happen to be submitted in - both are exactly the kind of thing that looks
 * fine on every screen and quietly drifts a split invoice's total away from
 * the source work it was built from.
 *
 * Every assertion below computes its expected value independently of
 * `balanceRoundedShares`/`allocateWorkToPayers` - by re-deriving the total in
 * integer cents from the SAME inputs the generator built, never by calling the
 * function under test twice and comparing the two calls to each other (except
 * where the invariant genuinely IS a relationship between two calls, as with
 * order-independence, which has no other possible oracle).
 */
describe('split allocation: generated cases', () => {
  const SEED = 20260901;

  it('balanceRoundedShares: shares always sum to exactly the rounded total, in cents', () => {
    const rand = mulberry32(SEED);
    const totalsCents = [
      0, 1, 2, 99, 100, 999_999_99, // zero, one cent, two cents, large
      ...Array.from({ length: 40 }, () => Math.floor(rand() * 10_000_000)),
    ];

    for (const totalCents of totalsCents) {
      for (const payerCount of [1, 2, 3, 7, 25]) {
        const portions = randomPortions(rand, payerCount);
        const total = totalCents / 100;
        const rawShares = portions.map((bp) => total * (bp / FULL_PORTION_BP));

        const shares = balanceRoundedShares(total, rawShares);

        expect(shares).toHaveLength(payerCount);
        expect(shares.every((s) => s >= 0)).toBe(true);
        const sumCents = shares.reduce((sum, s) => sum + toCentsInt(s), 0);
        expect(sumCents).toBe(totalCents);
      }
    }
  });

  it('balanceRoundedShares: a payer with a zero raw share never receives the remainder', () => {
    const rand = mulberry32(SEED + 1);
    for (let i = 0; i < 30; i += 1) {
      const totalCents = 1 + Math.floor(rand() * 5_000_000); // never zero: a zero total legitimately zeroes everyone
      const payerCount = 2 + Math.floor(rand() * 10);
      const portions = randomPortions(rand, payerCount);
      const total = totalCents / 100;
      const rawShares = portions.map((bp) => total * (bp / FULL_PORTION_BP));

      const shares = balanceRoundedShares(total, rawShares);

      portions.forEach((bp, index) => {
        if (bp === 0) expect(shares[index]).toBe(0);
      });
    }
  });

  it('allocateWorkToPayers: per-payer totals sum to exactly the combined work total, in cents', () => {
    const rand = mulberry32(SEED + 2);

    const cases = [
      { lineCount: 1, feeCount: 0, payerCount: 1 },
      { lineCount: 0, feeCount: 1, payerCount: 2 }, // one-cent-style edge: no time, one flat fee
      { lineCount: 20, feeCount: 5, payerCount: 50 }, // many recipients
    ];
    for (let i = 0; i < 25; i += 1) {
      cases.push({
        lineCount: Math.floor(rand() * 8),
        feeCount: Math.floor(rand() * 4),
        payerCount: 1 + Math.floor(rand() * 12),
      });
    }

    for (const { lineCount, feeCount, payerCount } of cases) {
      const payers = randomPortions(rand, payerCount).map((portionBp, index) => ({
        clientId: `payer-${index}`,
        portionBp,
      }));
      // Amounts as integer cents first, so the independently-computed grand total
      // never accumulates the float drift the SUT itself is built to avoid.
      const timeEntries = Array.from({ length: lineCount }, () => {
        const amountCents = Math.floor(rand() * 500_00); // up to $500 a line
        return { amount: amountCents / 100, hours: roundSplitValue(rand() * 10) };
      });
      const flatFees = Array.from({ length: feeCount }, () => {
        const amountCents = Math.floor(rand() * 10_000_00); // up to $10,000 a fee
        return { amount: amountCents / 100 };
      });

      const expectedGrandTotalCents =
        timeEntries.reduce((sum, e) => sum + toCentsInt(e.amount), 0) +
        flatFees.reduce((sum, f) => sum + toCentsInt(f.amount), 0);

      const result = allocateWorkToPayers({ payers, timeEntries, flatFees });

      expect(result).toHaveLength(payerCount);
      expect(result.every((p) => p.totalAmount >= 0)).toBe(true);
      const actualSumCents = result.reduce((sum, p) => sum + toCentsInt(p.totalAmount), 0);
      expect(actualSumCents).toBe(expectedGrandTotalCents);
    }
  });

  it('allocateWorkToPayers: the per-payer totals do not depend on the order lines are submitted in', () => {
    const rand = mulberry32(SEED + 3);

    for (let i = 0; i < 15; i += 1) {
      const payerCount = 1 + Math.floor(rand() * 8);
      const payers = randomPortions(rand, payerCount).map((portionBp, index) => ({
        clientId: `payer-${index}`,
        portionBp,
      }));
      const timeEntries = Array.from({ length: Math.floor(rand() * 10) }, (_v, idx) => ({
        id: `time-${idx}`,
        amount: Math.floor(rand() * 500_00) / 100,
        hours: roundSplitValue(rand() * 10),
      }));
      const flatFees = Array.from({ length: Math.floor(rand() * 5) }, (_v, idx) => ({
        id: `fee-${idx}`,
        amount: Math.floor(rand() * 10_000_00) / 100,
      }));

      const originalResult = allocateWorkToPayers({ payers, timeEntries, flatFees });
      const shuffledResult = allocateWorkToPayers({
        payers,
        timeEntries: shuffle(rand, timeEntries),
        flatFees: shuffle(rand, flatFees),
      });

      // Compare by clientId rather than array position: payer order is not what
      // this invariant is about.
      const byClient = (rows: typeof originalResult) =>
        Object.fromEntries(rows.map((r) => [r.clientId, r.totalAmount]));
      expect(byClient(shuffledResult)).toEqual(byClient(originalResult));
    }
  });
});

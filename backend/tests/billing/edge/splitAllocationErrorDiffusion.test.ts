/**
 * Split allocation keeps every line exact while each payer's overall share stays within a cent of exact. Pure, no database.
 */
import { allocateWorkToPayers } from '../../../src/modules/billing/shared/splitAllocation';

const cents = (d: number) => Math.round(d * 100);

it('1000 lines of 0.03 split 50/50 leaves each payer within 1 cent of 15.00', () => {
  const r = allocateWorkToPayers({
    payers: [{ clientId: 'a', portionBp: 5000 }, { clientId: 'b', portionBp: 5000 }],
    timeEntries: Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`, hours: 0.03, amount: 0.03 })),
    flatFees: [],
  });
  r.forEach((p) => expect(Math.abs(cents(p.totalAmount) - 1500)).toBeLessThanOrEqual(1));
});

it('100 lines of 0.07 split three ways leaves each payer within 1 cent of 2.33', () => {
  const r = allocateWorkToPayers({
    payers: [{ clientId: 'a', portionBp: 3333 }, { clientId: 'b', portionBp: 3333 }, { clientId: 'c', portionBp: 3334 }],
    timeEntries: Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, hours: 0.07, amount: 0.07 })),
    flatFees: [],
  });
  r.forEach((p) => expect(Math.abs(cents(p.totalAmount) - 233.33)).toBeLessThanOrEqual(1));
});

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('generated bills', () => {
  /**
   * RED IF: a line stops summing to its source amount, or the odd cents pile up
   * on one payer so their overall share drifts more than a cent from exact.
   */
  it('keeps every line exact and every payer within a cent of their exact share across 200 seeded bills', () => {
    const rand = mulberry32(20261003);
    for (let bill = 0; bill < 200; bill += 1) {
      const payerCount = 2 + Math.floor(rand() * 5);
      const byAmount = rand() < 0.5;
      let portions: number[];
      if (byAmount) {
        // Percent shares that are whole basis points, summing to 10000.
        const cuts = Array.from({ length: payerCount - 1 }, () => Math.floor(rand() * 10000)).sort((x, y) => x - y);
        portions = [...cuts, 10000].map((c, i) => c - (i === 0 ? 0 : cuts[i - 1]));
      } else {
        const base = Math.floor(10000 / payerCount);
        portions = Array.from({ length: payerCount }, (_, i) => (i === payerCount - 1 ? 10000 - base * (payerCount - 1) : base));
      }
      const lineCount = 1 + Math.floor(rand() * 60);
      const lineCents = Array.from({ length: lineCount }, () => 1 + Math.floor(rand() * (rand() < 0.5 ? 40 : 90_000)));
      const timeEntries = lineCents.map((c, i) => ({ id: `t${i}`, hours: 0.01, amount: c / 100 }));

      const result = allocateWorkToPayers({
        payers: portions.map((portionBp, i) => ({ clientId: `p${i}`, portionBp })),
        timeEntries,
        flatFees: [],
      });

      lineCents.forEach((c, lineIndex) => {
        const lineSum = result.reduce((s, p) => s + cents(p.timeEntries[lineIndex].allocationAmount), 0);
        expect(lineSum).toBe(c);
      });
      const totalCents = lineCents.reduce((s, c) => s + c, 0);
      result.forEach((p, i) => {
        const exact = (totalCents * portions[i]) / 10000;
        expect(Math.abs(cents(p.totalAmount) - exact)).toBeLessThanOrEqual(1);
      });
    }
  });
});

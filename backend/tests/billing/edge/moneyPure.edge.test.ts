/**
 * Pure money arithmetic checked against oracles written in integer cents.
 *
 * Nothing here touches the database. Every expected value is computed with
 * integer arithmetic (BigInt where a product can pass 2^53), never by calling
 * the function under test a second time or by repeating its float formula.
 */
import {
  toCents,
  fromCents,
  MAX_MONEY_AMOUNT,
} from '../../../src/modules/billing/shared/money';
import { isWholeCents } from '../../../src/modules/billing/shared/moneyInput';
import { roundHoursUp } from '../../../src/modules/billing/shared/timeRounding';
import {
  resolveRate,
  resolveRateFromRatesTable,
} from '../../../src/modules/billing/shared/rateResolution';
import {
  allocateWorkToPayers,
  FULL_PORTION_BP,
} from '../../../src/modules/billing/shared/splitAllocation';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The shortest decimal a person would type for a whole-cent integer. */
function centsToText(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = cents - whole * 100;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

describe('dollars to cents and back', () => {
  it('survives a JSON round trip for the awkward whole-cent values', () => {
    const cents = [
      1, 10, 29, 57, 58, 110, 115, 128, 145, 1005, 123_456_789,
      // 1234567.89 and the 0.1 + 0.2 neighbourhood.
      123_456_789, 30, 3_000_000_001,
      // 4503599627370.49 dollars: 450359962737049 cents, near 2^52.
      450_359_962_737_049,
      // 9007199254740.99 dollars: 900719925474099 cents, the largest whole-cent
      // dollar amount whose cent count is still a safe integer.
      900_719_925_474_099,
    ];
    for (const c of cents) {
      const dollars = JSON.parse(JSON.stringify(fromCents(c)));
      expect(toCents(dollars)).toBe(c);
      // The dollars number prints as the exact decimal text, with no float dust.
      expect(String(dollars)).toBe(String(Number(centsToText(c))));
    }
  });

  it('round-trips 20000 seeded whole-cent values up to the safe-integer ceiling', () => {
    const rand = mulberry32(8675309);
    for (let i = 0; i < 20_000; i += 1) {
      // Alternate magnitudes so small, mid and huge values are all hit.
      const digits = 1 + (i % 15);
      const c = Math.floor(rand() * 10 ** digits);
      expect(toCents(fromCents(c))).toBe(c);
      expect(toCents(Number(centsToText(c)))).toBe(c);
    }
  });

  it('keeps the validated maximum exactly representable in cents', () => {
    expect(toCents(MAX_MONEY_AMOUNT)).toBe(100_000_000_000);
    expect(fromCents(100_000_000_000)).toBe(MAX_MONEY_AMOUNT);
  });
});

describe('isWholeCents', () => {
  const accepted: Array<[number, string]> = [
    [0, 'zero'], [0.01, 'one cent'], [33.33, '33.33 (33.33*100 is 3332.9999999999995)'],
    [1234567.89, 'large with cents'], [4503599627370.49, 'near 2^52'],
    [1000, 'whole'], [0.1, 'a tenth'], [19.99, '19.99'], [1.1, '1.1'],
    [1_000_000_000, 'the maximum'], [123456789012.34, 'twelve digits'],
  ];
  it.each(accepted)('accepts %p (%s)', (value) => {
    expect(isWholeCents(value)).toBe(true);
  });

  const refused: Array<[number, string]> = [
    [0.001, 'a tenth of a cent'], [0.005, 'half a cent'], [10.999, 'three decimals'],
    [1e-7, 'exponent form'], [1e21, 'exponent form, huge'], [-1, 'negative'],
    [-0.01, 'negative cent'], [1.005, 'binary-unfriendly half cent'],
    [Number.NaN, 'NaN'], [Number.POSITIVE_INFINITY, 'infinity'],
  ];
  it.each(refused)('refuses %p (%s)', (value) => {
    expect(isWholeCents(value)).toBe(false);
  });

  it('agrees with cents round trip for every whole-cent text up to 50000.00', () => {
    for (let c = 0; c <= 5_000_000; c += 1) {
      if (!isWholeCents(Number(centsToText(c)))) {
        throw new Error(`isWholeCents refused ${centsToText(c)}`);
      }
    }
  });
});

describe('roundHoursUp at exact increment boundaries (hours are stored as numeric(6,2))', () => {
  /**
   * Oracle in integers. An increment of `m` minutes is m * 100 / 60 hundredths
   * of an hour. A value of `h` hundredths bills as the smallest whole number of
   * increments that covers it, then up to the next whole hundredth because the
   * column cannot hold a fraction of one.
   */
  function expectedHundredths(h: number, m: number): number {
    // steps = ceil(h / (m * 5 / 3)) = ceil(3h / (5m)), all integers.
    const steps = Math.ceil((3 * h) / (5 * m));
    // steps * 5m / 3 hundredths, rounded UP to an integer.
    return Math.ceil((steps * 5 * m) / 3);
  }

  it.each([6, 10, 12, 15, 30, 60, 1, 5])(
    'matches the integer oracle for every hundredth from 0.01 to 24.00 on a %i-minute increment',
    (m) => {
      const cfg = { enabled: true, incrementMinutes: m };
      for (let h = 1; h <= 2400; h += 1) {
        const got = Math.round(roundHoursUp(h / 100, cfg) * 100);
        const want = expectedHundredths(h, m);
        if (got !== want) {
          throw new Error(`${h / 100}h on ${m} min: got ${got / 100}h, expected ${want / 100}h`);
        }
      }
    },
  );

  it.each([
    // [hours, minutes, expected hours]
    [0.1, 6, 0.1], [0.11, 6, 0.2], [0.9, 6, 0.9], [0.91, 6, 1],
    [0.1, 10, 0.17], [0.11, 10, 0.17], [0.9, 10, 1], [0.17, 10, 0.34], [0.18, 10, 0.34],
    [0.1, 12, 0.2], [0.2, 12, 0.2], [0.21, 12, 0.4], [0.9, 12, 1],
    [0.1, 15, 0.25], [0.25, 15, 0.25], [0.26, 15, 0.5], [0.9, 15, 1],
    [0.1, 30, 0.5], [0.5, 30, 0.5], [0.51, 30, 1], [0.9, 30, 1],
  ])('bills %ph on a %i-minute increment as %ph', (hours, minutes, expected) => {
    expect(roundHoursUp(hours, { enabled: true, incrementMinutes: minutes })).toBe(expected);
  });

  it('never bills less than the work and never more than one increment above it', () => {
    for (const m of [6, 10, 12, 15, 30]) {
      const cfg = { enabled: true, incrementMinutes: m };
      for (let h = 1; h <= 2400; h += 1) {
        const billed = Math.round(roundHoursUp(h / 100, cfg) * 100);
        expect(billed).toBeGreaterThanOrEqual(h);
        // One increment plus the one hundredth the column rounds up by.
        expect(billed - h).toBeLessThanOrEqual(Math.ceil((5 * m) / 3));
      }
    }
  });

  it('passes the hours through unchanged when rounding is off', () => {
    expect(roundHoursUp(0.07, { enabled: false, incrementMinutes: 6 })).toBe(0.07);
    expect(roundHoursUp(0.07, undefined)).toBe(0.07);
  });
});

describe('rate resolution precedence', () => {
  const entry = { userId: 'u1' };
  const matterMembers = [{ userId: 'u1', hourlyRate: 301 }];
  const clientBillingRates = { memberRates: { u1: 302 }, defaultRate: 303 };
  const chargeCode = { memberRates: { u1: 304 }, defaultRate: 305 };
  const memberDefaultRates = { u1: 306 };
  const firmDefaultRate = 307;
  const all = {
    entry, matterMembers, clientBillingRates, chargeCode, memberDefaultRates, firmDefaultRate,
  };

  it('walks the nine tiers in order as each higher tier is removed', () => {
    expect(resolveRate({ ...all, entry: { userId: 'u1', hourlyRate: 300 } }))
      .toEqual({ rate: 300, source: 'time entry override' });
    expect(resolveRate(all)).toEqual({ rate: 301, source: 'matter member rate' });
    expect(resolveRate({ ...all, matterMembers: [] }))
      .toEqual({ rate: 302, source: 'client member rate' });
    expect(resolveRate({ ...all, matterMembers: [], clientBillingRates: { defaultRate: 303 } }))
      .toEqual({ rate: 303, source: 'client default rate' });
    expect(resolveRate({ ...all, matterMembers: [], clientBillingRates: null }))
      .toEqual({ rate: 304, source: 'charge code member rate' });
    expect(resolveRate({
      ...all, matterMembers: [], clientBillingRates: null, chargeCode: { defaultRate: 305 },
    })).toEqual({ rate: 305, source: 'charge code default' });
    expect(resolveRate({
      ...all, matterMembers: [], clientBillingRates: null, chargeCode: null,
    })).toEqual({ rate: 306, source: 'user default rate' });
    expect(resolveRate({
      ...all, matterMembers: [], clientBillingRates: null, chargeCode: null, memberDefaultRates: {},
    })).toEqual({ rate: 307, source: 'firm default rate' });
    expect(resolveRate({ entry })).toEqual({ rate: 0, source: 'none' });
  });

  it('treats a configured zero as a real rate that wins over every lower tier', () => {
    expect(resolveRate({ ...all, matterMembers: [{ userId: 'u1', hourlyRate: 0 }] }))
      .toEqual({ rate: 0, source: 'matter member rate' });
    expect(resolveRate({ ...all, entry: { userId: 'u1', hourlyRate: 0 } }))
      .toEqual({ rate: 0, source: 'time entry override' });
    expect(resolveRate({ ...all, matterMembers: [], clientBillingRates: { defaultRate: '0' } }))
      .toEqual({ rate: 0, source: 'client default rate' });
  });

  it('reads a numeric string from a numeric column as that rate, not as unset', () => {
    expect(resolveRate({ entry, chargeCode: { defaultRate: '123.45' } }))
      .toEqual({ rate: 123.45, source: 'charge code default' });
  });

  it('does not let a matter member row for another user price this user', () => {
    expect(resolveRate({ ...all, matterMembers: [{ userId: 'u2', hourlyRate: 1 }] }))
      .toEqual({ rate: 302, source: 'client member rate' });
  });

  it('applies the same order when rates come from the rates table, ties go to the first row', () => {
    const rates = [
      { scopeKind: 'firm', rateCents: 700 },
      { scopeKind: 'member', userId: 'u1', rateCents: 600 },
      { scopeKind: 'billing_code', billingCodeId: 'bc', rateCents: 500 },
      { scopeKind: 'billing_code', billingCodeId: 'bc', userId: 'u1', rateCents: 400 },
      { scopeKind: 'client', clientId: 'c', rateCents: 300 },
      { scopeKind: 'client', clientId: 'c', userId: 'u1', rateCents: 200 },
      { scopeKind: 'matter', matterId: 'm', userId: 'u1', rateCents: 100 },
      { scopeKind: 'matter', matterId: 'm', userId: 'u1', rateCents: 99 },
    ];
    const base = { userId: 'u1', matterId: 'm', clientId: 'c', billingCodeId: 'bc' };
    expect(resolveRateFromRatesTable({ ...base, rates }).rateCents).toBe(100);
    expect(resolveRateFromRatesTable({ ...base, rates: rates.slice(0, 6) }).rateCents).toBe(200);
    expect(resolveRateFromRatesTable({ ...base, rates: rates.slice(0, 5) }).rateCents).toBe(300);
    expect(resolveRateFromRatesTable({ ...base, rates: rates.slice(0, 4) }).rateCents).toBe(400);
    expect(resolveRateFromRatesTable({ ...base, rates: rates.slice(0, 3) }).rateCents).toBe(500);
    expect(resolveRateFromRatesTable({ ...base, rates: rates.slice(0, 2) }).rateCents).toBe(600);
    expect(resolveRateFromRatesTable({ ...base, rates: rates.slice(0, 1) }).rateCents).toBe(700);
    expect(resolveRateFromRatesTable({ ...base, rates: [] }).rateCents).toBe(0);
    // An explicit zero entry override wins over everything.
    expect(resolveRateFromRatesTable({ ...base, entryRateCents: 0, rates }).rateCents).toBe(0);
  });
});

describe('allocateWorkToPayers sums to the source in exact cents', () => {
  function randomPortions(rand: () => number, count: number): number[] {
    const cuts = Array.from({ length: count - 1 }, () => 1 + Math.floor(rand() * (FULL_PORTION_BP - 1)));
    cuts.sort((a, b) => a - b);
    const bounds = [0, ...cuts, FULL_PORTION_BP];
    return bounds.slice(1).map((b, i) => b - bounds[i]).filter((p) => p > 0);
  }

  const centsOf = (dollars: number) => Math.round(dollars * 100);

  it('splits the named awkward amounts across the named share counts without losing a cent', () => {
    for (const totalCents of [10_000, 1, 10_001, 100_000_000, 99_999_999_999, 7, 333_333]) {
      for (const n of [2, 3, 7]) {
        const portions = Array.from({ length: n }, (_, i) => (i === n - 1 ? FULL_PORTION_BP - Math.floor(FULL_PORTION_BP / n) * (n - 1) : Math.floor(FULL_PORTION_BP / n)));
        const result = allocateWorkToPayers({
          payers: portions.map((p, i) => ({ clientId: `c${i}`, portionBp: p })),
          timeEntries: [],
          flatFees: [{ id: 'f', amount: totalCents / 100 }],
        });
        const sum = result.reduce((s, p) => s + centsOf(p.flatFeesAmount), 0);
        expect({ totalCents, n, sum }).toEqual({ totalCents, n, sum: totalCents });
      }
    }
  });

  it('assigns shares that sum exactly to the total on 300 seeded totals and 2-6 payers', () => {
    const rand = mulberry32(424242);
    for (let i = 0; i < 300; i += 1) {
      const n = 2 + Math.floor(rand() * 5);
      const totalCents = 1 + Math.floor(rand() * 10 ** (2 + Math.floor(rand() * 9)));
      const portions = randomPortions(rand, n);
      const result = allocateWorkToPayers({
        payers: portions.map((p, k) => ({ clientId: `c${k}`, portionBp: p })),
        timeEntries: [],
        flatFees: [{ id: 'f', amount: totalCents / 100 }],
      });
      const shareCents = result.map((p) => centsOf(p.flatFeesAmount));
      expect({ i, totalCents, sum: shareCents.reduce((a, b) => a + b, 0) })
        .toEqual({ i, totalCents, sum: totalCents });
      shareCents.forEach((c) => expect(c).toBeGreaterThanOrEqual(0));
    }
  });

  it('keeps every time line, its hours and the payer totals reconciled across many lines', () => {
    const rand = mulberry32(1337);
    for (let round = 0; round < 60; round += 1) {
      const n = 2 + Math.floor(rand() * 5);
      const portions = randomPortions(rand, n);
      const lines = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, k) => ({
        id: `t${k}`,
        hours: (1 + Math.floor(rand() * 800)) / 100,
        amount: (1 + Math.floor(rand() * 400_000)) / 100,
      }));
      const fees = Array.from({ length: Math.floor(rand() * 4) }, (_, k) => ({
        id: `f${k}`,
        amount: (1 + Math.floor(rand() * 100_000)) / 100,
      }));
      const result = allocateWorkToPayers({
        payers: portions.map((p, k) => ({ clientId: `c${k}`, portionBp: p })),
        timeEntries: lines,
        flatFees: fees,
      });
      // Per line, the payers' amounts and hours add back to the line.
      lines.forEach((line, li) => {
        const amt = result.reduce((s, p) => s + centsOf(p.timeEntries[li].allocationAmount), 0);
        const hrs = result.reduce((s, p) => s + centsOf(p.timeEntries[li].allocationHours), 0);
        expect({ round, li, amt }).toEqual({ round, li, amt: centsOf(line.amount) });
        expect({ round, li, hrs }).toEqual({ round, li, hrs: centsOf(line.hours) });
      });
      fees.forEach((fee, fi) => {
        const amt = result.reduce((s, p) => s + centsOf(p.flatFees[fi].allocationAmount), 0);
        expect({ round, fi, amt }).toEqual({ round, fi, amt: centsOf(fee.amount) });
      });
      // Per payer, the headline total is the sum of that payer's own lines.
      const grand = lines.reduce((s, l) => s + centsOf(l.amount), 0) + fees.reduce((s, f) => s + centsOf(f.amount), 0);
      let payerSum = 0;
      result.forEach((p) => {
        const own = p.timeEntries.reduce((s, l) => s + centsOf(l.allocationAmount), 0)
          + p.flatFees.reduce((s, l) => s + centsOf(l.allocationAmount), 0);
        expect(centsOf(p.totalAmount)).toBe(own);
        payerSum += own;
      });
      expect(payerSum).toBe(grand);
    }
  });

  it('bounds one split total to within half a cent per payer of the exact share', () => {
    // The last payer absorbs the rounding of every other share, so the error is
    // bounded by (payers - 1) / 2 cents rather than by one cent.
    const rand = mulberry32(99);
    for (let i = 0; i < 300; i += 1) {
      const n = 2 + Math.floor(rand() * 5);
      const totalCents = 1 + Math.floor(rand() * 10 ** (2 + Math.floor(rand() * 9)));
      const portions = randomPortions(rand, n);
      const result = allocateWorkToPayers({
        payers: portions.map((p, k) => ({ clientId: `c${k}`, portionBp: p })),
        timeEntries: [],
        flatFees: [{ id: 'f', amount: totalCents / 100 }],
      });
      result.forEach((p, k) => {
        const ideal = (totalCents * portions[k]) / FULL_PORTION_BP;
        const actual = centsOf(p.flatFeesAmount);
        expect(Math.abs(actual - ideal)).toBeLessThanOrEqual((portions.length - 1) / 2 + 1e-9);
      });
    }
  });
});

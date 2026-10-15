/**
 * Edge cases of the payment plan form helpers: the preview must add up to the
 * balance in whole cents, never list a row at or below zero, and list as many
 * rows as the saved plan will have.
 *
 * The server builds its schedule from the payload alone (`installmentAmount`
 * and the cadence), so the count of rows it saves is
 * `ceil(regular balance / installmentAmount)`, whatever "number of payments"
 * the firm typed.
 */
import {
  buildPaymentPlanPayload,
  buildPaymentPlanSchedule,
  EMPTY_PAYMENT_PLAN,
  type PaymentPlanFormValues,
} from '@/components/billingComp/PaymentPlanFields';

/** Deterministic PRNG so a failing case reproduces from its index. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const form = (patch: Partial<PaymentPlanFormValues>): PaymentPlanFormValues => ({
  ...EMPTY_PAYMENT_PLAN, startDate: '2026-04-01', ...patch,
});
const cents = (rows: Array<{ amount: number }>) => rows.map((r) => Math.round(r.amount * 100));

describe('amount mode', () => {
  it('adds up to the balance in whole cents with no zero row across 300 seeded balances', () => {
    const rand = mulberry32(4242);
    const problems: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const balanceCents = 2 + Math.floor(rand() * 3_000_000);
      const downCents = rand() < 0.4 ? 1 + Math.floor(rand() * (balanceCents - 1)) : 0;
      const regular = balanceCents - downCents;
      const instCents = Math.max(1, Math.ceil(regular / 110) + Math.floor(rand() * regular * 0.5));
      const values = form({
        installmentMode: 'amount',
        installmentAmount: (instCents / 100).toFixed(2),
        downPayment: downCents ? (downCents / 100).toFixed(2) : '',
        downPaymentPaid: true,
        frequency: '30',
      });

      const rows = cents(buildPaymentPlanSchedule(values, balanceCents / 100));
      const tag = `case ${i} balance ${balanceCents} down ${downCents} inst ${instCents}`;
      if (rows.reduce((a, b) => a + b, 0) !== balanceCents) problems.push(`${tag}: sums to ${rows.reduce((a, b) => a + b, 0)}`);
      if (rows.some((r) => r <= 0)) problems.push(`${tag}: a row at or below zero`);
      const regularRows = downCents ? rows.slice(1) : rows;
      if (regularRows.length !== Math.ceil(regular / instCents)) problems.push(`${tag}: ${regularRows.length} rows`);
      if (regularRows.slice(0, -1).some((r) => r !== instCents)) problems.push(`${tag}: a non-final row differs`);
    }
    expect(problems).toEqual([]);
  });

  it('previews nothing for a down payment larger than the balance', () => {
    const rows = buildPaymentPlanSchedule(form({ installmentAmount: '100', downPayment: '600', frequency: '30' }), 500);

    expect(rows).toEqual([]);
  });

  it('refuses a down payment equal to the balance when building the payload', () => {
    const built = buildPaymentPlanPayload(form({
      installmentAmount: '100', downPayment: '500', downPaymentPaid: true, frequency: '30',
    }), 500);

    expect(built.payload).toBeUndefined();
    expect(built.error).toMatch(/less than the remaining balance/i);
  });
});

describe('count mode', () => {
  it('lists the number of rows the saved plan will have, none at or below zero, when each payment is at least a dollar', () => {
    const problems: string[] = [];
    for (const balanceCents of [100, 101, 250, 999, 1000, 2000, 9999, 10_000, 14_400, 100_001, 123_457, 5_000_000]) {
      for (let n = 1; n <= Math.min(120, Math.floor(balanceCents / 100)); n += 1) {
        const values = form({ installmentMode: 'count', paymentCount: String(n), frequency: '30' });
        const built = buildPaymentPlanPayload(values, balanceCents / 100);
        if (built.payload === undefined) { problems.push(`balance ${balanceCents} payments ${n}: refused ${built.error}`); continue; }
        const preview = cents(buildPaymentPlanSchedule(values, balanceCents / 100));
        const saved = Math.ceil(balanceCents / Math.round(built.payload.installmentAmount * 100));
        const tag = `balance ${balanceCents} payments ${n}`;
        if (preview.length !== n) problems.push(`${tag}: preview has ${preview.length} rows`);
        if (preview.some((r) => r <= 0)) problems.push(`${tag}: preview ${JSON.stringify(preview.slice(-3))} has a row at or below zero`);
        if (preview.length !== saved) problems.push(`${tag}: preview ${preview.length} rows, saved plan ${saved}`);
        if (preview.reduce((a, b) => a + b, 0) !== balanceCents) problems.push(`${tag}: sums to ${preview.reduce((a, b) => a + b, 0)}`);
        if (preview.slice(0, -1).some((r) => r !== preview[0])) problems.push(`${tag}: a non-final row differs`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('puts the remainder of an uneven split on the last row', () => {
    const rows = cents(buildPaymentPlanSchedule(
      form({ installmentMode: 'count', paymentCount: '3', frequency: '30' }), 100,
    ));

    expect(rows).toEqual([3334, 3334, 3332]);
  });
});

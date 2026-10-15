/**
 * The schedule a plan generates adds up, for ~200 seeded balances.
 *
 * Whatever balance, instalment and down payment are chosen, the stored rows
 * must sum to the balance in whole cents, hold no zero-cent row, hold no row
 * above the instalment except the down payment, and stay within the 120-row cap.
 * The generator is a fixed-seed PRNG, so a failing case reproduces from its seed.
 */
import { usePlanKit, seededRandom } from './planKit';

const k = usePlanKit(1000);

const CASES = 200;
const SEED = 20260401;

interface Case {
  n: number;
  balanceCents: number;
  installmentCents: number;
  downCents: number;
  paidDown: boolean;
  frequencyDays: number;
  start: string;
}

function buildCases(): Case[] {
  const rand = seededRandom(SEED);
  const cases: Case[] = [];
  for (let n = 0; n < CASES; n += 1) {
    const magnitude = rand();
    const balanceCents = magnitude < 0.15
      ? 2 + Math.floor(rand() * 500)
      : magnitude < 0.6 ? 1_000 + Math.floor(rand() * 100_000) : 100_000 + Math.floor(rand() * 5_000_000);
    const hasDown = rand() < 0.4;
    const downCents = hasDown ? 1 + Math.floor(rand() * (balanceCents - 1)) : 0;
    const regular = balanceCents - downCents;
    // At least ceil(regular / 110) so the row count stays inside the cap.
    const floorCents = Math.max(1, Math.ceil(regular / 110));
    const shape = rand();
    const installmentCents = shape < 0.05 ? regular
      : shape < 0.1 ? regular + 1 + Math.floor(rand() * 10_000)
        : shape < 0.4 ? floorCents + Math.floor(rand() * floorCents)
        : floorCents + Math.floor(rand() * Math.max(1, regular * 0.6));
    const day = 1 + Math.floor(rand() * 28);
    const month = 1 + Math.floor(rand() * 12);
    cases.push({
      n,
      balanceCents,
      installmentCents,
      downCents,
      paidDown: hasDown && rand() < 0.3,
      frequencyDays: [7, 14, 30, 30, 45][Math.floor(rand() * 5)],
      start: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    });
  }
  return cases;
}

describe('the generated schedule adds up for every seeded case', () => {
  it('draws a spread of shapes so the property is not exercised on one kind of plan', () => {
    const cases = buildCases();
    const count = (pred: (c: Case) => boolean) => cases.filter(pred).length;
    expect(count((c) => c.downCents > 0)).toBeGreaterThanOrEqual(60);
    expect(count((c) => c.paidDown)).toBeGreaterThanOrEqual(15);
    expect(count((c) => c.installmentCents >= c.balanceCents - c.downCents)).toBeGreaterThanOrEqual(10);
    expect(count((c) => c.frequencyDays === 30)).toBeGreaterThanOrEqual(50);
    expect(count((c) => c.balanceCents < 500)).toBeGreaterThanOrEqual(15);
    expect(count((c) => (c.balanceCents - c.downCents) % c.installmentCents !== 0)).toBeGreaterThanOrEqual(100);
    expect(count((c) => Math.ceil((c.balanceCents - c.downCents) / c.installmentCents) > 50)).toBeGreaterThanOrEqual(20);
  });

  it(`sums to the balance in whole cents across ${CASES} balances`, async () => {
    const violations: string[] = [];

    for (const c of buildCases()) {
      // eslint-disable-next-line no-await-in-loop -- one invoice per case, in order
      const id = await k.createInvoice(c.balanceCents / 100);
      // eslint-disable-next-line no-await-in-loop
      const res = await k.setPlan({
        installmentAmount: c.installmentCents / 100,
        frequencyDays: c.frequencyDays,
        planStartDate: c.start,
        ...(c.downCents > 0 ? {
          downPaymentAmount: c.downCents / 100,
          downPaymentAlreadyPaid: c.paidDown,
          ...(c.paidDown ? {} : { downPaymentDueDate: c.start }),
        } : {}),
      }, id);
      const tag = `case ${c.n} ${JSON.stringify(c)}`;
      if (res.status !== 200) { violations.push(`${tag}: status ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`); continue; }

      // eslint-disable-next-line no-await-in-loop
      const rows = await k.rows(id);
      const cents = rows.map((r) => Number(r.amount_cents));
      const regular = c.balanceCents - c.downCents;
      const regularRows = rows.filter((r) => !r.is_down_payment);
      const regularCents = regularRows.map((r) => Number(r.amount_cents));

      if (cents.reduce((a, b) => a + b, 0) !== c.balanceCents) violations.push(`${tag}: rows sum ${cents.reduce((a, b) => a + b, 0)}`);
      if (cents.some((v) => v <= 0)) violations.push(`${tag}: a zero or negative row`);
      if (rows.length > 120) violations.push(`${tag}: ${rows.length} rows`);
      if (regularCents.slice(0, -1).some((v) => v !== c.installmentCents)) violations.push(`${tag}: a non-final row differs from the instalment`);
      const last = regularCents[regularCents.length - 1];
      if (last > c.installmentCents && regularCents.length > 1) violations.push(`${tag}: last row ${last} above the instalment`);
      if (regularCents.reduce((a, b) => a + b, 0) !== regular) violations.push(`${tag}: regular rows do not sum to ${regular}`);
      if (regularRows.length !== Math.ceil(regular / c.installmentCents)) violations.push(`${tag}: ${regularRows.length} regular rows`);
      if (c.downCents > 0) {
        const down = rows.filter((r) => r.is_down_payment);
        if (down.length !== 1 || Number(down[0].amount_cents) !== c.downCents) violations.push(`${tag}: down payment row wrong`);
        if (down[0] && down[0].status !== (c.paidDown ? 'paid' : 'pending')) violations.push(`${tag}: down payment status ${down[0].status}`);
      }

      // eslint-disable-next-line no-await-in-loop
      const inv = await k.invoice(id);
      const owed = c.balanceCents - (c.paidDown ? c.downCents : 0);
      if (Number(inv.balance_due_cents) !== owed) violations.push(`${tag}: balance ${inv.balance_due_cents} != ${owed}`);
      const pendingSum = rows.filter((r) => r.status !== 'paid').reduce((a, r) => a + Number(r.amount_cents), 0);
      if (pendingSum !== owed) violations.push(`${tag}: pending rows ${pendingSum} != balance ${owed}`);
    }

    expect(violations).toEqual([]);
  }, 240_000);
});

describe('the edges of the schedule shape', () => {
  it('writes a single row when the instalment equals the balance', async () => {
    const id = await k.createInvoice(432.1);
    expect((await k.setPlan({ installmentAmount: 432.1 }, id)).status).toBe(200);

    expect(await k.shape(id)).toEqual([[43_210, 'pending']]);
  });

  it('writes a single row for the balance when the instalment is larger than it', async () => {
    const id = await k.createInvoice(432.1);
    expect((await k.setPlan({ installmentAmount: 9999.99 }, id)).status).toBe(200);

    expect(await k.shape(id)).toEqual([[43_210, 'pending']]);
  });

  it('puts the remainder on the last row, never on the first', async () => {
    const id = await k.createInvoice(100);
    expect((await k.setPlan({ installmentAmount: 33.33 }, id)).status).toBe(200);

    expect(await k.shape(id)).toEqual([[3_333, 'pending'], [3_333, 'pending'], [3_333, 'pending'], [1, 'pending']]);
  });

  it('refuses a down payment equal to the balance and writes no plan', async () => {
    const id = await k.createInvoice(500);

    const res = await k.setPlan({ installmentAmount: 100, downPaymentAmount: 500 }, id);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/less than the remaining balance/i);
    expect(await k.rows(id)).toHaveLength(0);
  });

  it('refuses a down payment larger than the balance and writes no plan', async () => {
    const id = await k.createInvoice(500);

    const res = await k.setPlan({ installmentAmount: 100, downPaymentAmount: 500.01 }, id);

    expect(res.status).toBe(400);
    expect(await k.rows(id)).toHaveLength(0);
  });

  it('accepts a down payment one cent under the balance and schedules one cent', async () => {
    const id = await k.createInvoice(500);

    const res = await k.setPlan({ installmentAmount: 100, downPaymentAmount: 499.99 }, id);

    expect(res.status).toBe(200);
    expect(await k.shape(id)).toEqual([[49_999, 'pending'], [1, 'pending']]);
  });

  it('counts the down payment toward the 120-row cap', async () => {
    const atCap = await k.createInvoice(1200);
    const over = await k.createInvoice(1200);

    // 119 regular rows + the down payment is exactly 120; 120 + down is 121.
    const ok = await k.setPlan({ installmentAmount: 10, downPaymentAmount: 10 }, atCap);
    const refused = await k.setPlan({ installmentAmount: 9.99, downPaymentAmount: 10 }, over);

    expect(ok.status).toBe(200);
    expect(await k.rows(atCap)).toHaveLength(120);
    expect(refused.status).toBe(400);
    expect(await k.rows(over)).toHaveLength(0);
  });
});

describe('a plan created on a partially paid invoice', () => {
  it('schedules only what is still owed and keeps the earlier payment', async () => {
    expect((await k.pay({ paymentAmount: 300, paidDate: '2026-03-10' })).status).toBe(200);

    const res = await k.setPlan({ installmentAmount: 250 });

    expect(res.status).toBe(200);
    expect(await k.shape()).toEqual([[25_000, 'pending'], [25_000, 'pending'], [20_000, 'pending']]);
    expect(await k.payments()).toHaveLength(1);
    expect((await k.invoice()).status).toBe('partially_paid');
    await k.expectScheduleMatchesBalance(undefined, 'plan on partial');
  });

  it('refuses a down payment equal to what is still owed', async () => {
    await k.pay({ paymentAmount: 300, paidDate: '2026-03-10' });

    const res = await k.setPlan({ installmentAmount: 250, downPaymentAmount: 700 });

    expect(res.status).toBe(400);
    expect(await k.rows()).toHaveLength(0);
  });

  it('refuses a down payment larger than what is still owed even though it is below the invoice total', async () => {
    await k.pay({ paymentAmount: 300, paidDate: '2026-03-10' });

    const res = await k.setPlan({ installmentAmount: 250, downPaymentAmount: 800 });

    expect(res.status).toBe(400);
  });

  it('records a down payment already received as a payment and counts it toward the schedule', async () => {
    await k.pay({ paymentAmount: 300, paidDate: '2026-03-10' });

    const res = await k.setPlan({ installmentAmount: 200, downPaymentAmount: 100, downPaymentAlreadyPaid: true });

    expect(res.status).toBe(200);
    const inv = await k.invoice();
    expect(Number(inv.amount_paid_cents)).toBe(40_000);
    expect(Number(inv.balance_due_cents)).toBe(60_000);
    expect((await k.payments()).map((p) => Number(p.amount_cents))).toEqual([30_000, 10_000]);
    expect(await k.shape()).toEqual([[10_000, 'paid'], [20_000, 'pending'], [20_000, 'pending'], [20_000, 'pending']]);
    await k.expectScheduleMatchesBalance(undefined, 'paid down payment on partial');
  });

  it('refuses a plan on an invoice that is already paid in full', async () => {
    await k.pay({ isPaid: true });

    const res = await k.setPlan({ installmentAmount: 250 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no remaining balance/i);
  });
});

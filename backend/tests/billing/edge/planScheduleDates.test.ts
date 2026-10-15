/**
 * The dates a payment plan generates.
 *
 * Instalment dates are day-only calendar labels. They are walked from the plan
 * start with `dayjs` in the server process's zone, so the cases that matter are
 * month ends (a 31st that has no 31st next month), leap years, and cadences
 * that cross a daylight-saving change in a zone ahead of or behind UTC.
 *
 * `frequencyDays === 30` is the "monthly" setting, so a 30-day cadence is a
 * calendar month, not thirty days.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1200);

/** The due dates of the plan on `id`, in schedule order. */
async function dates(id: string) {
  return (await k.rows(id)).map((r) => r.due_date);
}

/** `n` dates `stepDays` apart from `start`, by pure calendar arithmetic. */
function everyNDays(start: string, stepDays: number, n: number) {
  const [y, m, d] = start.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d + stepDays * i)).toISOString().slice(0, 10));
}

async function planOf(total: number, body: Record<string, unknown>) {
  const id = await k.createInvoice(total);
  const res = await k.setPlan(body, id);
  expect(res.status).toBe(200);
  return id;
}

describe('monthly instalments', () => {
  it('lands the first instalment on the start date', async () => {
    const id = await planOf(300, { installmentAmount: 100, planStartDate: '2026-01-31' });

    expect((await dates(id))[0]).toBe('2026-01-31');
  });

  it('clamps a 31st to the last day of a shorter month', async () => {
    const id = await planOf(300, { installmentAmount: 100, planStartDate: '2026-01-31' });

    expect((await dates(id))[1]).toBe('2026-02-28');
  });

  it('clamps a 29th to the 28th in a non-leap February and keeps it on the 29th in a leap one', async () => {
    const leap = await planOf(200, { installmentAmount: 100, planStartDate: '2028-01-29' });
    const plain = await planOf(200, { installmentAmount: 100, planStartDate: '2027-01-29' });

    expect(await dates(leap)).toEqual(['2028-01-29', '2028-02-29']);
    expect(await dates(plain)).toEqual(['2027-01-29', '2027-02-28']);
  });

  it('puts a leap-day start on the 29th of the following months', async () => {
    const id = await planOf(300, { installmentAmount: 100, planStartDate: '2028-02-29' });

    expect(await dates(id)).toEqual(['2028-02-29', '2028-03-29', '2028-04-29']);
  });

  it('keeps a 30th on the 30th through the 30-day and 31-day months', async () => {
    const id = await planOf(400, { installmentAmount: 100, planStartDate: '2026-04-30' });

    expect(await dates(id)).toEqual(['2026-04-30', '2026-05-30', '2026-06-30', '2026-07-30']);
  });

  it('counts a 30-day cadence as a calendar month, not thirty days', async () => {
    const id = await planOf(300, { installmentAmount: 100, frequencyDays: 30, planStartDate: '2026-01-01' });

    // Thirty days from 1 January is 31 January; a month is 1 February.
    expect(await dates(id)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('treats a 31-day cadence as plain days', async () => {
    const id = await planOf(300, { installmentAmount: 100, frequencyDays: 31, planStartDate: '2026-01-01' });

    expect(await dates(id)).toEqual(['2026-01-01', '2026-02-01', '2026-03-04']);
  });

  it('starts the regular instalments one month after the start date when there is a down payment', async () => {
    const id = await planOf(300, {
      installmentAmount: 100, planStartDate: '2026-01-15', downPaymentAmount: 100, downPaymentDueDate: '2026-01-20',
    });

    const rows = await k.rows(id);
    expect(rows.map((r) => [r.due_date, Number(r.amount_cents), r.is_down_payment])).toEqual([
      ['2026-01-20', 10_000, true], ['2026-02-15', 10_000, false], ['2026-03-15', 10_000, false],
    ]);
  });

  it('dates a down payment on the start date when no down payment date is given', async () => {
    const id = await planOf(300, { installmentAmount: 100, planStartDate: '2026-01-15', downPaymentAmount: 100 });

    expect((await dates(id))[0]).toBe('2026-01-15');
  });
});

describe('day-count instalments', () => {
  it.each([1, 7, 14, 45, 90, 365])('adds exactly %i days between instalments', async (step) => {
    const id = await planOf(600, { installmentAmount: 100, frequencyDays: step, planStartDate: '2026-02-20' });

    expect(await dates(id)).toEqual(everyNDays('2026-02-20', step, 6));
  });

  it('starts the regular instalments one cadence after the start date when there is a down payment', async () => {
    const id = await planOf(300, {
      installmentAmount: 100, frequencyDays: 14, planStartDate: '2026-03-01',
      downPaymentAmount: 100, downPaymentDueDate: '2026-03-01',
    });

    expect(await dates(id)).toEqual(['2026-03-01', '2026-03-15', '2026-03-29']);
  });

  it('puts the invoice due date on the last instalment and the next payment date on the first', async () => {
    const id = await planOf(300, { installmentAmount: 100, frequencyDays: 10, planStartDate: '2026-05-01' });

    const inv = await k.invoice(id);
    expect(inv.due_date).toBe('2026-05-21');
    expect(inv.next_payment_date).toBe('2026-05-01');
  });
});

describe('a cadence that crosses a daylight-saving change', () => {
  // The dates are walked in the process's own zone, which Jest cannot change
  // from inside a spec (its `process.env` is a copy, so assigning TZ never
  // reaches the runtime). The zone this runs under is whatever the shell set:
  // `TZ=Asia/Beirut npx jest ...` repeats every case in a zone whose clocks skip
  // local midnight, and `TZ=Pacific/Auckland` in one ahead of UTC. The expected
  // dates are pure calendar arithmetic, so they hold in every zone.
  it('keeps a weekly cadence on consecutive calendar weeks across the March changes', async () => {
    const id = await planOf(1200, { installmentAmount: 100, frequencyDays: 7, planStartDate: '2026-03-20' });

    expect(await dates(id)).toEqual(everyNDays('2026-03-20', 7, 12));
  });

  it('keeps a daily cadence on consecutive calendar days across the March changes', async () => {
    const id = await planOf(1200, { installmentAmount: 100, frequencyDays: 1, planStartDate: '2026-03-25' });

    expect(await dates(id)).toEqual(everyNDays('2026-03-25', 1, 12));
  });

  it('keeps a weekly cadence on consecutive calendar weeks across the September and October changes', async () => {
    const id = await planOf(1200, { installmentAmount: 100, frequencyDays: 7, planStartDate: '2026-09-20' });

    expect(await dates(id)).toEqual(everyNDays('2026-09-20', 7, 12));
  });

  it('keeps a cadence on consecutive calendar days across the November changes', async () => {
    const id = await planOf(1200, { installmentAmount: 100, frequencyDays: 3, planStartDate: '2026-10-25' });

    expect(await dates(id)).toEqual(everyNDays('2026-10-25', 3, 12));
  });

  it('keeps monthly dates on the same day of the month across both changes', async () => {
    const id = await planOf(1200, { installmentAmount: 100, frequencyDays: 30, planStartDate: '2026-03-15' });

    expect(await dates(id)).toEqual([
      '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15', '2026-07-15', '2026-08-15',
      '2026-09-15', '2026-10-15', '2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15',
    ]);
  });

  it('keeps a long cadence on the right day when the walk spans several years of changes', async () => {
    const id = await planOf(1200, { installmentAmount: 100, frequencyDays: 91, planStartDate: '2026-03-28' });

    expect(await dates(id)).toEqual(everyNDays('2026-03-28', 91, 12));
  });
});

describe('the dates the route returns', () => {
  it('serialises every instalment, the due date and the next payment date as bare YYYY-MM-DD days', async () => {
    const id = await k.createInvoice(300);
    const res = await k.setPlan({ installmentAmount: 100, planStartDate: '2026-04-01T23:30:00-08:00' }, id);

    expect(res.status).toBe(200);
    const inv = res.body.invoice;
    expect(inv.nextPaymentDate).toBe('2026-04-01');
    expect(inv.dueDate).toBe('2026-06-01');
    expect(inv.paymentPlan.expectedPayments.map((e: any) => e.dueDate)).toEqual(['2026-04-01', '2026-05-01', '2026-06-01']);
  });
});

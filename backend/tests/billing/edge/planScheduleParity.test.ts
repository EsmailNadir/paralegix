/**
 * The saved payment plan matches the shared schedule fixture.
 *
 * `tests/fixtures/paymentPlanSchedules.json` lists form inputs and the schedule
 * each must produce. The frontend preview (`buildPaymentPlanSchedule`) is held
 * to the same file in `frontend/tests/components/billing/PaymentPlanScheduleParity.test.ts`,
 * so the schedule a firm confirms on screen and the one the server saves cannot
 * drift apart without one of the two specs going red.
 *
 * Each case posts the payload the form would send to the real route and reads
 * the stored instalment rows back.
 */
import fixture from '../../fixtures/paymentPlanSchedules.json';
import { usePlanKit } from './planKit';

interface FixtureRow { date: string | null; cents: number; isDownPayment: boolean }
interface FixtureCase {
  name: string;
  balanceCents: number;
  payload: Record<string, unknown> & { planStartDate: string };
  rows: FixtureRow[];
}

const cases = (fixture as unknown as { cases: FixtureCase[] }).cases;

const k = usePlanKit(1000);

it('has the spread of cases the parity claim depends on', () => {
  expect(cases.length).toBeGreaterThanOrEqual(60);
  expect(cases.filter((c) => c.payload.frequencyDays === 30).length).toBeGreaterThanOrEqual(25);
  expect(cases.filter((c) => c.payload.frequencyDays !== 30).length).toBeGreaterThanOrEqual(20);
  expect(cases.filter((c) => c.payload.downPaymentAmount !== undefined).length).toBeGreaterThanOrEqual(10);
  expect(cases.filter((c) => c.payload.downPaymentAlreadyPaid === true).length).toBeGreaterThanOrEqual(3);
  expect(cases.filter((c) => c.rows.length === 1).length).toBeGreaterThanOrEqual(2);
  expect(cases.some((c) => c.rows.length === 120)).toBe(true);
});

it('saves exactly the dates and cents the fixture lists for every case', async () => {
  const mismatches: string[] = [];

  for (const c of cases) {
    // eslint-disable-next-line no-await-in-loop -- one invoice per case
    const id = await k.createInvoice(c.balanceCents / 100);
    // eslint-disable-next-line no-await-in-loop
    const res = await k.setPlan(c.payload, id);
    if (res.status !== 200) { mismatches.push(`${c.name}: status ${res.status}`); continue; }

    // eslint-disable-next-line no-await-in-loop
    const stored = (await k.rows(id)).map((r) => ({
      date: r.due_date, cents: Number(r.amount_cents), isDownPayment: r.is_down_payment,
    }));
    const expected = c.rows.map((r) => ({
      date: r.date ?? c.payload.planStartDate, cents: r.cents, isDownPayment: r.isDownPayment,
    }));
    if (JSON.stringify(stored) !== JSON.stringify(expected)) {
      const firstDiff = expected.findIndex((e, i) => JSON.stringify(e) !== JSON.stringify(stored[i]));
      mismatches.push(`${c.name}: row ${firstDiff} saved ${JSON.stringify(stored[firstDiff])}, expected ${JSON.stringify(expected[firstDiff])} (${stored.length} rows saved, ${expected.length} expected)`);
    }
  }

  expect(mismatches).toEqual([]);
}, 240_000);

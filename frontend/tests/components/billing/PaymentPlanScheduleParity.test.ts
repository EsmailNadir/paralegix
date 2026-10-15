/**
 * The payment plan preview matches the shared schedule fixture.
 *
 * `backend/tests/fixtures/paymentPlanSchedules.json` lists form inputs and the
 * schedule each must produce. The server is held to the same file in
 * `backend/tests/billing/edge/planScheduleParity.test.ts`, so the schedule a firm
 * confirms on screen and the one the server saves cannot drift apart without one
 * of the two specs going red. The fixture holds only cases both sides agree on.
 */
import dayjs from 'dayjs';
import {
  buildPaymentPlanPayload,
  buildPaymentPlanSchedule,
  type PaymentPlanFormValues,
} from '@/components/billingComp/PaymentPlanFields';
import fixture from '../../../../backend/tests/fixtures/paymentPlanSchedules.json';

interface FixtureRow { date: string | null; cents: number; isDownPayment: boolean }
interface FixtureCase {
  name: string;
  balanceCents: number;
  values: PaymentPlanFormValues;
  payload: Record<string, unknown>;
  rows: FixtureRow[];
}

const cases = (fixture as unknown as { cases: FixtureCase[] }).cases;
const display = (day: string) => dayjs(day).format('MMM DD, YYYY');

it('has the spread of cases the parity claim depends on', () => {
  expect(cases.length).toBeGreaterThanOrEqual(60);
  expect(cases.filter((c) => c.payload.frequencyDays === 30).length).toBeGreaterThanOrEqual(25);
  expect(cases.filter((c) => c.values.installmentMode === 'count').length).toBeGreaterThanOrEqual(8);
  expect(cases.filter((c) => c.payload.downPaymentAmount !== undefined).length).toBeGreaterThanOrEqual(10);
});

describe('the form values produce the payload the server saved the fixture schedule from', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const built = buildPaymentPlanPayload(c.values, c.balanceCents / 100);

    expect(built.error).toBeUndefined();
    expect(built.payload).toEqual(c.payload);
  });
});

describe('the preview lists the same instalments the server saves', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const preview = buildPaymentPlanSchedule(c.values, c.balanceCents / 100);

    expect(preview.map((r) => Math.round(r.amount * 100))).toEqual(c.rows.map((r) => r.cents));
    expect(preview.map((r) => r.date)).toEqual(
      c.rows.map((r) => (r.date === null ? 'Collected' : display(r.date))),
    );
    expect(preview.map((r) => Boolean(r.isDownPayment))).toEqual(c.rows.map((r) => r.isDownPayment));
    expect(preview.reduce((sum, r) => sum + Math.round(r.amount * 100), 0)).toBe(c.balanceCents);
  });
});

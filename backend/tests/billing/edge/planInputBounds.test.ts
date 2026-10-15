/**
 * Frequency and start date are bounded, so an absurd value is a 400 and never reaches Postgres.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

it('refuses an absurd frequency with a client error', async () => {
  const res = await k.setPlan({ installmentAmount: 500, frequencyDays: 4_000_000, planStartDate: '2026-04-01' });
  expect(res.status).toBe(400);
});

it('refuses a start date that pushes the second instalment past year 9999 with a client error', async () => {
  const res = await k.setPlan({ installmentAmount: 500, frequencyDays: 30, planStartDate: '9999-12-31' });
  expect(res.status).toBe(400);
});

it('refuses a cadence longer than a year', async () => {
  const res = await k.setPlan({ installmentAmount: 500, frequencyDays: 366 });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toMatch(/365/);
});

it('accepts a cadence of exactly a year', async () => {
  const res = await k.setPlan({ installmentAmount: 500, frequencyDays: 365 });
  expect(res.status).toBe(200);
  expect((await k.rows()).map((r) => r.due_date)).toEqual(['2026-04-01', '2027-04-01']);
});

it('refuses a start date before the earliest a plan may start', async () => {
  const res = await k.setPlan({ installmentAmount: 500, planStartDate: '1999-12-31' });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toMatch(/2000-01-01/);
});

it('refuses a start date more than five years ahead and accepts one inside the window', async () => {
  const farOff = new Date();
  farOff.setUTCFullYear(farOff.getUTCFullYear() + 6);
  expect((await k.setPlan({ installmentAmount: 500, planStartDate: farOff.toISOString().slice(0, 10) })).status).toBe(400);

  const near = new Date();
  near.setUTCFullYear(near.getUTCFullYear() + 4);
  expect((await k.setPlan({ installmentAmount: 500, planStartDate: near.toISOString().slice(0, 10) })).status).toBe(200);
});

it('refuses a cadence above a year when the schedule is replaced', async () => {
  expect((await k.setPlan({ installmentAmount: 500 })).status).toBe(200);
  const res = await k.owner.api.patch(k.on('/payment-plan/schedule')).send({
    installments: [{ dueDate: '2026-06-01', amount: 1000 }], frequencyDays: 4_000_000,
  });
  expect(res.status).toBe(400);
});

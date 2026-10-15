/**
 * No path that adds a schedule row can take a plan past MAX_PLAN_INSTALLMENTS.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

async function fullPlan() {
  const id = await k.createInvoice(1200);
  expect((await k.setPlan({ installmentAmount: 10 }, id)).status).toBe(200);
  expect(await k.rows(id)).toHaveLength(120);
  return id;
}

it('refuses a shortfall carried off the end of a full plan', async () => {
  const id = await fullPlan();
  const res = await k.pay({ paymentAmount: 5, installmentIndex: 119, shortfallAction: 'add_to_next', paidDate: '2026-04-01' }, id);

  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toMatch(/120/);
  expect(await k.rows(id)).toHaveLength(120);
  expect(await k.payments(id)).toHaveLength(0);
});

it('folds an amount added to a full plan into the last open instalment', async () => {
  const id = await fullPlan();
  const res = await k.owner.api.patch(k.on('/add-amount', id)).send({ amount: 10 });

  expect(res.status).toBe(200);
  const rows = await k.rows(id);
  expect(rows).toHaveLength(120);
  expect(Number(rows[119].amount_cents)).toBe(2_000);
  await k.expectScheduleMatchesBalance(id, 'add amount to a full plan');
});

it('refuses lowering the last instalment of a full plan, which would need a 121st row', async () => {
  const id = await fullPlan();
  const res = await k.owner.api.patch(k.on('/payment-plan/installment/119', id)).send({ amount: 5 });

  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toMatch(/120/);
  const rows = await k.rows(id);
  expect(rows).toHaveLength(120);
  expect(Number(rows[119].amount_cents)).toBe(1_000);
});

it('still appends a row to a plan with room left', async () => {
  const id = await k.createInvoice(1000);
  expect((await k.setPlan({ installmentAmount: 250 }, id)).status).toBe(200);
  const res = await k.owner.api.patch(k.on('/add-amount', id)).send({ amount: 100 });

  expect(res.status).toBe(200);
  expect(await k.rows(id)).toHaveLength(5);
  await k.expectScheduleMatchesBalance(id, 'add amount with room');
});

/**
 * A plan invoice owns its next payment date, so a request that only moves that date is refused.
 */
import { freezeClockAt, unfreezeClock } from '../../support/setupInProcess';
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

beforeEach(async () => {
  expect((await k.setPlan({ installmentAmount: 500, planStartDate: '2026-05-01' })).status).toBe(200);
});
afterEach(() => unfreezeClock());

it('refuses a next-payment-date-only update and leaves the stored date on the earliest open instalment', async () => {
  freezeClockAt('2026-05-20T12:00:00-07:00');
  const res = await k.owner.api.put(k.on('/payment')).send({ nextPaymentDate: '2026-12-01' });

  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toMatch(/payment plan/i);
  expect((await k.invoice()).next_payment_date).toBe('2026-05-01');

  const list = await k.owner.api.get(k.base()).set('x-timezone', 'America/Los_Angeles');
  const detail = list.body.invoices.find((i: any) => i.id === k.invoiceId);
  expect(detail.paymentPlan.expectedPayments[0].status).toBe('overdue');
  expect(detail.status).toBe('overdue');
});

it('still moves the next payment date on an invoice without a plan', async () => {
  const id = await k.createInvoice(1000);
  const res = await k.owner.api.put(k.on('/payment', id)).send({ nextPaymentDate: '2026-12-01' });

  expect(res.status).toBe(200);
  expect(String((await k.invoice(id)).next_payment_date)).toContain('2026-12-01');
});

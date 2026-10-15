/**
 * The next payment day is the earliest open instalment by date, and the schedule is stored in date order.
 */
import { freezeClockAt, unfreezeClock } from '../../support/setupInProcess';
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

beforeEach(async () => {
  expect((await k.setPlan()).status).toBe(200);
});
afterEach(() => unfreezeClock());

it('lists an invoice as overdue when its earliest open instalment is past due, whatever order the rows are stored in', async () => {
  expect((await k.owner.api.patch(k.on('/payment-plan/installment/0')).send({ dueDate: '2026-08-01' })).status).toBe(200);
  expect((await k.invoice()).next_payment_date).toBe('2026-05-01');
  freezeClockAt('2026-05-15T12:00:00-07:00');

  const res = await k.owner.api
    .get(`/api/lawfirms/${k.firm.id}/billing/invoices/firm?dueGroup=overdue`)
    .set('x-timezone', 'America/Los_Angeles');

  expect(res.status).toBe(200);
  expect(res.body.invoices.map((i: any) => i.id)).toContain(k.invoiceId);
});

it('does not list an invoice under Outstanding when its own status says overdue', async () => {
  expect((await k.owner.api.patch(k.on('/payment-plan/installment/0')).send({ dueDate: '2026-08-01' })).status).toBe(200);
  freezeClockAt('2026-05-15T12:00:00-07:00');

  const res = await k.owner.api
    .get(`/api/lawfirms/${k.firm.id}/billing/invoices/firm?status=outstanding`)
    .set('x-timezone', 'America/Los_Angeles');

  for (const invoice of res.body.invoices) expect(invoice.status).toBe('outstanding');
});

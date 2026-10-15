/**
 * A refit keeps the pre-due reminder stamp of every row whose date is unchanged.
 */
import { testPool, freezeClockAt, unfreezeClock, emailsMatching, resetEmails } from '../../support/setupInProcess';
import { sendOverdueReminders } from '../../../src/modules/billing/invoices/invoiceReminders.service';
import { usePlanKit } from './planKit';

const k = usePlanKit(400);

async function passAt(iso: string) {
  unfreezeClock();
  freezeClockAt(iso);
  return sendOverdueReminders(k.firm.id);
}

beforeEach(async () => {
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  await testPool.query(`update law_firms set settings = jsonb_build_object('timezone', 'America/Los_Angeles') where id = $1`, [k.firm.id]);
  await testPool.query('update clients set email = $2 where id = $1', [k.client.id, 'plan-reminder@example.test']);
  expect((await k.setPlan({ installmentAmount: 100, planStartDate: '2026-03-15' })).status).toBe(200);
  resetEmails();
});
afterEach(() => unfreezeClock());

it('is remembered across a credit note that refits the schedule, so the client is not reminded twice in a day', async () => {
  const res = await k.owner.api.patch(k.on('/payment-plan/schedule')).send({
    installments: [{ dueDate: '2026-03-18', amount: 200 }, { dueDate: '2026-03-19', amount: 200 }],
  });
  expect(res.status).toBe(200);
  expect((await k.owner.api.patch(k.on('/pre-due-reminder')).send({ planDays: 5 })).status).toBe(200);
  expect((await passAt('2026-03-15T09:00:00-07:00')).sent).toBe(2);
  resetEmails();

  expect((await k.owner.api.post(k.on('/credit-note')).send({ amount: 10, type: 'discount' })).status).toBe(200);
  const stats = await passAt('2026-03-15T20:00:00-07:00');

  expect(stats.sent).toBe(0);
  expect(emailsMatching(/Upcoming payment/)).toHaveLength(0);
});

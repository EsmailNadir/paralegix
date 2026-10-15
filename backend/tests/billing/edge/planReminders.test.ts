/**
 * Pre-due reminders for plan instalments, and the next-payment bookkeeping that
 * decides what counts as overdue.
 *
 * A firm in Los Angeles runs the reminder pass at 9am on 15 March 2026. Each
 * open instalment due 1 to N days ahead gets one reminder per firm day, stamped
 * on the instalment itself.
 */
import {
  testPool,
  freezeClockAt,
  unfreezeClock,
  sentEmails,
  emailsMatching,
  resetEmails,
} from '../../support/setupInProcess';
import { sendOverdueReminders } from '../../../src/modules/billing/invoices/invoiceReminders.service';
import { usePlanKit } from './planKit';

const k = usePlanKit(400);

const DAY = (iso: string) => `${iso}T09:00:00-07:00`;

const upcoming = () => emailsMatching(/Upcoming payment/);
const amountsIn = () => upcoming().map((e) => String(e.subject)).sort();

async function passAt(iso: string) {
  unfreezeClock();
  freezeClockAt(iso);
  return sendOverdueReminders(k.firm.id);
}

async function planDue(dates: string[], amounts: number[], planDays: number) {
  const res = await k.owner.api.patch(k.on('/payment-plan/schedule')).send({
    installments: dates.map((dueDate, i) => ({ dueDate, amount: amounts[i] })),
  });
  expect(res.status).toBe(200);
  const reminder = await k.owner.api.patch(k.on('/pre-due-reminder')).send({ planDays });
  expect(reminder.status).toBe(200);
}

beforeEach(async () => {
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  await testPool.query(
    `update law_firms set settings = jsonb_build_object('timezone', 'America/Los_Angeles') where id = $1`,
    [k.firm.id],
  );
  await testPool.query('update clients set email = $2 where id = $1', [k.client.id, 'plan-reminder@example.test']);
  expect((await k.setPlan({ installmentAmount: 100, planStartDate: '2026-03-15' })).status).toBe(200);
  resetEmails();
});

afterEach(() => unfreezeClock());

describe('the window a plan instalment is reminded in', () => {
  it('reminds instalments due 1 to N days ahead, and not one N+1 days out', async () => {
    // Due tomorrow, in five days, in six and in seven; N is five days.
    await planDue(['2026-03-16', '2026-03-20', '2026-03-21', '2026-03-22'], [100, 100, 100, 100], 5);

    const stats = await passAt(DAY('2026-03-15'));

    expect(stats.sent).toBe(2);
    const stamped = (await testPool.query(
      `select due_date, pre_due_reminder_sent_at is not null as reminded
         from invoice_expected_payments where invoice_id = $1 order by sort_order`,
      [k.invoiceId],
    )).rows;
    expect(stamped.map((r: any) => [r.due_date, r.reminded])).toEqual([
      ['2026-03-16', true], ['2026-03-20', true], ['2026-03-21', false], ['2026-03-22', false],
    ]);
    expect(upcoming()).toHaveLength(2);
  });

  it('names the instalment and its amount, not the whole balance', async () => {
    await planDue(['2026-03-16', '2026-03-30'], [150, 250], 5);

    await passAt(DAY('2026-03-15'));

    const mails = upcoming();
    expect(mails).toHaveLength(1);
    expect(String(mails[0].subject)).toMatch(/Upcoming payment/);
    expect(String(mails[0].html)).toContain('150.00');
    expect(String(mails[0].html)).not.toContain('400.00');
  });

  it('sends nothing when the window is not set on the plan', async () => {
    const res = await k.owner.api.patch(k.on('/payment-plan/schedule')).send({
      installments: [{ dueDate: '2026-03-16', amount: 400 }],
    });
    expect(res.status).toBe(200);

    const stats = await passAt(DAY('2026-03-15'));

    expect(stats.sent).toBe(0);
    expect(sentEmails()).toHaveLength(0);
  });

  it('does not remind an instalment that has been paid', async () => {
    await planDue(['2026-03-16', '2026-03-17'], [200, 200], 5);
    expect((await k.pay({ paymentAmount: 200, installmentIndex: 0, paidDate: '2026-03-15' })).status).toBe(200);
    resetEmails();

    const stats = await passAt(DAY('2026-03-15'));

    expect(stats.sent).toBe(1);
    const reminded = (await testPool.query(
      `select due_date from invoice_expected_payments
        where invoice_id = $1 and pre_due_reminder_sent_at is not null`, [k.invoiceId],
    )).rows;
    expect(reminded.map((r: any) => r.due_date)).toEqual(['2026-03-17']);
  });

  it('reminds at most once per firm day, and again the next firm day', async () => {
    await planDue(['2026-03-18'], [400], 5);

    expect((await passAt(DAY('2026-03-15'))).sent).toBe(1);
    expect((await passAt('2026-03-15T23:30:00-07:00')).sent).toBe(0);
    expect((await passAt(DAY('2026-03-16'))).sent).toBe(1);

    expect(upcoming()).toHaveLength(2);
  });

  it('counts the day in the firm zone, so the evening before the window is still outside it', async () => {
    await planDue(['2026-03-21'], [400], 5);

    // 6pm Pacific on the 15th is already the 16th in UTC: five days out by the
    // UTC calendar, six by the firm's.
    expect((await passAt('2026-03-15T18:00:00-07:00')).sent).toBe(0);
    expect((await passAt(DAY('2026-03-16'))).sent).toBe(1);
  });
});

describe('the stored next payment date and the schedule', () => {
  it('keeps the next payment date on the earliest open instalment through payments in any order', async () => {
    expect((await k.pay({ paymentAmount: 100, installmentIndex: 1, paidDate: '2026-03-15' })).status).toBe(200);
    expect((await k.invoice()).next_payment_date).toBe('2026-03-15');

    expect((await k.pay({ paymentAmount: 100, installmentIndex: 0, paidDate: '2026-03-15' })).status).toBe(200);
    expect((await k.invoice()).next_payment_date).toBe('2026-05-15');
  });

  it('puts a next payment date supplied with an instalment payment on the next open instalment', async () => {
    const res = await k.pay({
      paymentAmount: 100, installmentIndex: 0, paidDate: '2026-03-15', nextPaymentDate: '2026-04-20',
    });
    expect(res.status).toBe(200);

    const rows = await k.rows();
    expect(rows[0].status).toBe('paid');
    expect(rows[1].due_date).toBe('2026-04-20');
    expect((await k.invoice()).next_payment_date).toBe('2026-04-20');
  });
});

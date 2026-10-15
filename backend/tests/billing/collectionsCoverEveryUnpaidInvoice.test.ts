/**
 * Automated collections cover every unpaid invoice with a due date.
 *
 * An invoice is delivered once it exists and is visible in the client portal,
 * so "sent" does not mean emailed. The overdue reminder pass, the pre-due
 * reminder pass (invoice level and plan installments), the automatic late-fee
 * sweep and the firm digest therefore act on an invoice that was never emailed
 * and has no Stripe link. With no frozen bill-to record to read, the reminder
 * recipients resolve live from the client. A voided invoice is excluded from
 * all of them.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  sentEmails,
  emailsMatching,
  recipientsOf,
  resetEmails,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';
import { sendOverdueReminders } from '../../src/modules/billing/invoices/invoiceReminders.service';
import { applyAutoLateFees } from '../../src/modules/billing/invoices/lateFees.service';
import { findDigestInvoices } from '../../src/modules/notifications/digest/digest.repository';

const CLIENT_EMAIL = 'payer@collections.test';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let seq = 0;
let previousKillSwitch: string | undefined;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

/** `offset` days from today (UTC), as the 'YYYY-MM-DD' a `date` column stores. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
}

/** An invoice through the real create route. It is never emailed and has no Stripe link. */
async function createInvoice(dueDate: string, totalAmount = 1000): Promise<string> {
  seq += 1;
  const res = await owner.api.post(B()).send({
    invoiceName: `Collections ${seq}`,
    invoiceDate: day(-60),
    dueDate,
    totalAmount,
    flatFeesAmount: totalAmount,
    flatFees: [{ description: 'Fixed fee', amount: totalAmount }],
  });
  expect(res.status).toBe(201);
  return res.body.invoice.id as string;
}

async function voidInvoice(invoiceId: string) {
  const res = await owner.api.post(`${B()}/${invoiceId}/void`).send({});
  expect(res.status).toBe(200);
}

async function stored(invoiceId: string) {
  const { rows } = await testPool.query(
    `select status, total_cents, billing_snapshot_at, stripe_invoice_id,
            stripe_checkout_session_id, stripe_payment_requested
       from invoices where id = $1`,
    [invoiceId],
  );
  expect(rows).toHaveLength(1);
  return { ...rows[0], totalCents: Number(rows[0].total_cents) };
}

/** The premise of every case: nothing was emailed and no Stripe link exists. */
async function expectNeverDelivered(invoiceId: string) {
  const row = await stored(invoiceId);
  expect(row.billing_snapshot_at).toBeNull();
  expect(row.stripe_invoice_id).toBeNull();
  expect(row.stripe_checkout_session_id).toBeNull();
  expect(row.stripe_payment_requested).toBe(false);
}

/** The reminder bookkeeping, zero-valued when no reminder row exists yet. */
async function reminderState(invoiceId: string) {
  const { rows } = await testPool.query(
    'select coalesce(sent_count, 0) as sent_count, pre_due_sent_at from reminders where invoice_id = $1',
    [invoiceId],
  );
  return rows[0] || { sent_count: 0, pre_due_sent_at: null };
}

async function addInstallment(invoiceId: string, dueDate: string) {
  await testPool.query(
    'update invoices set payment_plan_enabled = true, plan_pre_reminder_days = 5 where id = $1',
    [invoiceId],
  );
  await testPool.query(
    `insert into invoice_expected_payments
       (invoice_id, law_firm_id, sort_order, installment_id, due_date, amount_cents, status)
     values ($1, $2, 0, 'inst-1', $3::date, 25000, 'pending')`,
    [invoiceId, firm.id, dueDate],
  );
}

beforeEach(async () => {
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  firm = await createFirm({ name: 'Collections LLP' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Pat Payer', email: CLIENT_EMAIL });
  await testPool.query(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(
          'invoiceReminderEnabled', true,
          'invoiceReminderDays', '[7, 14, 30]'::jsonb,
          'defaultPreDueReminderDays', 5,
          'billing', jsonb_build_object('lateFee', jsonb_build_object(
            'enabled', true, 'autoApply', true, 'flatAmount', 25, 'percent', 0, 'graceDays', 0)))
      where id = $1`,
    [firm.id],
  );
  resetEmails();
});

afterEach(() => {
  if (previousKillSwitch === undefined) delete process.env.DISABLE_ALL_REMINDER_EMAILS;
  else process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

describe('an invoice that was never emailed and has no Stripe link', () => {
  /** RED IF the overdue pass or the sweep requires a send: nothing is reminded or charged. */
  it('still gets the overdue reminder and the automatic late fee', async () => {
    const id = await createInvoice(day(-30));
    await expectNeverDelivered(id);

    const reminders = await sendOverdueReminders(firm.id);
    const fees = await applyAutoLateFees(firm.id);
    await drainEvents();

    expect(reminders).toMatchObject({ sent: 1, errors: 0 });
    // No frozen bill-to record exists, so the address resolves live.
    expect(recipientsOf(/past due/)).toEqual([CLIENT_EMAIL]);
    expect((await reminderState(id)).sent_count).toBe(1);
    expect(fees).toMatchObject({ applied: 1, errors: 0 });
    expect((await stored(id)).totalCents).toBe(102_500);
    // A reminder is not a delivery event: it must not freeze the bill-to record.
    expect((await stored(id)).billing_snapshot_at).toBeNull();
  });

  /** RED IF the upcoming selection requires a send: no "Upcoming payment" email goes out. */
  it('still gets the pre-due reminder', async () => {
    const id = await createInvoice(day(3));
    await expectNeverDelivered(id);

    const stats = await sendOverdueReminders(firm.id);

    expect(stats.sent).toBe(1);
    expect(recipientsOf(/Upcoming payment/)).toEqual([CLIENT_EMAIL]);
    expect((await reminderState(id)).pre_due_sent_at).toBeInstanceOf(Date);
  });

  /** RED IF plan installments are skipped on an invoice that was never emailed. */
  it('still gets the payment-plan installment pre-due reminder', async () => {
    // Due far enough out that the invoice-level window (5 days) stays shut and
    // only the installment can fire.
    const id = await createInvoice(day(60));
    await addInstallment(id, day(3));
    await expectNeverDelivered(id);

    const stats = await sendOverdueReminders(firm.id);

    expect(stats.sent).toBe(1);
    expect(recipientsOf(/installment 1/)).toEqual([CLIENT_EMAIL]);
    const { rows } = await testPool.query(
      'select pre_due_reminder_sent_at from invoice_expected_payments where invoice_id = $1', [id],
    );
    expect(rows[0].pre_due_reminder_sent_at).toBeInstanceOf(Date);
  });

  /** RED IF the digest requires a send: the invoice is missing from the list. */
  it('still appears in the firm digest', async () => {
    const id = await createInvoice(day(0));
    await expectNeverDelivered(id);

    const items = await findDigestInvoices(firm.id, day(0), day(7));

    expect(items.map((i: any) => i.id)).toEqual([id]);
    expect(items[0].amountCents).toBe(100_000);
  });
});

describe('a voided invoice is excluded from every automated pass', () => {
  /** The same invoice is collected before the void (positive control), and not after. */
  it('is reminded and charged before the void and by neither after it', async () => {
    const id = await createInvoice(day(-30));

    const before = await sendOverdueReminders(firm.id);
    const feesBefore = await applyAutoLateFees(firm.id);
    await drainEvents();
    expect(before.sent).toBe(1);
    expect(feesBefore.applied).toBe(1);
    expect(recipientsOf(/past due/)).toEqual([CLIENT_EMAIL]);
    resetEmails();

    await voidInvoice(id);
    // Reminder days are spaced, so push the last reminder back to make the
    // invoice due another one if it were still live.
    await testPool.query(
      "update reminders set last_sent_at = now() - interval '90 days' where invoice_id = $1", [id],
    );
    const totalAfterVoid = (await stored(id)).totalCents;

    const after = await sendOverdueReminders(firm.id);
    const feesAfter = await applyAutoLateFees(firm.id);
    await drainEvents();

    expect(after.sent).toBe(0);
    expect(feesAfter.applied).toBe(0);
    expect(sentEmails()).toHaveLength(0);
    expect((await stored(id)).totalCents).toBe(totalAfterVoid);
  });

  it('gets the pre-due reminder before the void and not after it', async () => {
    const live = await createInvoice(day(3));
    const doomed = await createInvoice(day(3));
    await voidInvoice(doomed);

    const stats = await sendOverdueReminders(firm.id);

    expect(stats.sent).toBe(1);
    expect(emailsMatching(/Upcoming payment/)).toHaveLength(1);
    expect((await reminderState(live)).pre_due_sent_at).toBeInstanceOf(Date);
    expect((await reminderState(doomed)).pre_due_sent_at).toBeNull();
  });

  it('is in the digest before the void and out of it after', async () => {
    const id = await createInvoice(day(0));
    expect((await findDigestInvoices(firm.id, day(0), day(7))).map((i: any) => i.id)).toEqual([id]);

    await voidInvoice(id);

    expect(await findDigestInvoices(firm.id, day(0), day(7))).toEqual([]);
  });
});

describe('the manual actions are unaffected', () => {
  it('a firm member can still send a reminder and apply a late fee by hand', async () => {
    const id = await createInvoice(day(-30));

    const reminder = await owner.api.post(`${B()}/${id}/send-reminder`).send({});
    expect(reminder.status).toBe(200);
    expect(reminder.body.sent).toBe(true);
    expect(recipientsOf(/past due/)).toEqual([CLIENT_EMAIL]);

    const fee = await owner.api.post(`${B()}/${id}/late-fee`).send({});
    expect(fee.status).toBe(200);
    expect(fee.body.lateFeeAmount).toBe(25);
    expect((await stored(id)).totalCents).toBe(102_500);
    expect((await stored(id)).billing_snapshot_at).toBeNull();
  });
});

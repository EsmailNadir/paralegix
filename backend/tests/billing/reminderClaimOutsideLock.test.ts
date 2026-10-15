/**
 * A reminder is claimed, then sent, then (only on failure) released.
 *
 * The send used to run inside the invoice transaction, holding the row lock
 * and the matter's billing lock across a network call, with the stamp written
 * after it. So a slow provider stalled every invoice write in the matter, and
 * a stamp lost after a successful send meant the next pass sent again. Now the
 * stamp is committed first, the mail goes out with no transaction open, and a
 * refused send gives the stamp back. The worst case is one reminder skipped,
 * never one sent twice.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  emailsMatching,
  holdNextEmail,
  rejectNextEmail,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';
import {
  sendOverdueReminders,
  sendReminderForInvoice,
} from '../../src/modules/billing/invoices/invoiceReminders.service';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');

const CLIENT_EMAIL = 'slow@client.test';
const realSetTimeout = global.setTimeout;

let firm: Firm;
let owner: Actor;
let clientId: string;
let matterId: string;
let previousKillSwitch: string | undefined;

/** Resolve `promise`, or 'timeout' after `ms`; never hangs the suite. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([promise, new Promise<'timeout'>((r) => realSetTimeout(() => r('timeout'), ms))]);
}

/** An issued matter invoice, `dueOffset` days from today. */
async function seedIssuedInvoice(dueOffset: number, totalCents = 100_000): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, client_id, context_type, invoice_number, invoice_name,
        status, total_cents, invoice_date, due_date, client_email, client_name,
        billing_snapshot_at, billing_emails)
     values ($1, $2, $3, $4, 'matter', $5, $5, 'outstanding', $6, current_date - 60, current_date + $7::int,
        $8::text, 'Slow Client', now(), array[$8::text])`,
    [id, firm.id, matterId, clientId, `INV-${id.slice(0, 8)}`, totalCents, dueOffset, CLIENT_EMAIL],
  );
  return id;
}

/** Reminder bookkeeping, zero-valued when the invoice has none. */
async function reminderRow(invoiceId: string) {
  const { rows } = await testPool.query(
    `select coalesce(sent_count, 0) as sent_count, last_sent_at, pre_due_sent_at,
            coalesce(recent_manual_sends, '{}') as recent_manual_sends
       from reminders where invoice_id = $1`,
    [invoiceId],
  );
  return rows[0] || { sent_count: 0, last_sent_at: null, pre_due_sent_at: null, recent_manual_sends: [] };
}

beforeEach(async () => {
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  firm = await createFirm({ name: 'Slow Mail LLP' });
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { name: 'Slow Client', email: CLIENT_EMAIL })).id;
  matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [clientId] });
  await testPool.query(
    `update law_firms set settings = jsonb_build_object(
       'invoiceReminderEnabled', true, 'invoiceReminderDays', '[7, 14, 30]'::jsonb, 'defaultPreDueReminderDays', 5)
      where id = $1`,
    [firm.id],
  );
});

afterEach(() => {
  if (previousKillSwitch === undefined) delete process.env.DISABLE_ALL_REMINDER_EMAILS;
  else process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

describe('the overdue pass', () => {
  /**
   * RED IF the stamp is written in the same transaction as the send: while the
   * mail is in flight the stamp is uncommitted, so this connection sees none.
   */
  it('has committed the stamp before the mail leaves, so a second pass sends nothing', async () => {
    const invoiceId = await seedIssuedInvoice(-30);
    const held = holdNextEmail();
    const pass = sendOverdueReminders(firm.id);
    try {
      expect(await within(held.arrived, 5_000)).not.toBe('timeout');
      const midSend = await reminderRow(invoiceId);
      expect(midSend.sent_count).toBe(1);
      expect(midSend.last_sent_at).toBeInstanceOf(Date);
    } finally {
      held.release();
    }
    expect((await pass).sent).toBe(1);

    expect((await sendOverdueReminders(firm.id)).sent).toBe(0);
    expect(emailsMatching(/past due/)).toHaveLength(1);
  });

  /**
   * RED IF the send runs under the matter's billing lock: the payment on the
   * OTHER invoice waits on `lockBillingContext` until the mail is released.
   */
  it('does not hold up a payment on another invoice in the same matter while the mail is slow', async () => {
    await seedIssuedInvoice(-30);
    const sibling = await seedIssuedInvoice(20, 50_000);
    const held = holdNextEmail();
    const pass = sendOverdueReminders(firm.id);
    async function payment() {
      return owner.api
        .put(`/api/lawfirms/${firm.id}/billing/invoices/matter/${matterId}/${sibling}/payment`)
        .send({ paymentAmount: 10, paidDate: '2026-03-20' });
    }
    let paying: ReturnType<typeof payment> | undefined;
    try {
      expect(await within(held.arrived, 5_000)).not.toBe('timeout');
      paying = payment();
      const outcome = await within(paying, 3_000);
      expect(outcome).not.toBe('timeout');
      expect((outcome as any).status).toBe(200);
      const { rows } = await testPool.query('select amount_paid_cents from invoices where id = $1', [sibling]);
      expect(Number(rows[0].amount_paid_cents)).toBe(1_000);
    } finally {
      held.release();
      await Promise.allSettled([pass, ...(paying ? [paying] : [])]);
    }
    await drainEvents();
  });

  /** Green before and after; RED IF the release step is dropped (the stamp would stay). */
  it('gives the claim back when the provider refuses, so the next pass retries', async () => {
    const invoiceId = await seedIssuedInvoice(-30);
    rejectNextEmail('provider unavailable');

    const first = await sendOverdueReminders(firm.id);
    expect(first.sent).toBe(0);
    expect(await reminderRow(invoiceId)).toMatchObject({ sent_count: 0, last_sent_at: null });

    const second = await sendOverdueReminders(firm.id);
    expect(second.sent).toBe(1);
    expect((await reminderRow(invoiceId)).sent_count).toBe(1);
    expect(emailsMatching(/past due/)).toHaveLength(1);
  });

  /** The at-most-once trade, pinned: a lost release skips a reminder, it never repeats one. */
  it('keeps the stamp when the release itself fails, and does not send on the next pass', async () => {
    const invoiceId = await seedIssuedInvoice(-30);
    const original = invoicesRepo.runReminderTxn;
    const spy = jest.spyOn(invoicesRepo, 'runReminderTxn')
      .mockImplementationOnce((...args: any[]) => original.apply(invoicesRepo, args))
      .mockRejectedValueOnce(new Error('connection lost'));
    try {
      rejectNextEmail('provider unavailable');
      const first = await sendOverdueReminders(firm.id);
      expect(first).toMatchObject({ sent: 0, errors: 1 });
    } finally {
      spy.mockRestore();
    }
    expect((await reminderRow(invoiceId)).sent_count).toBe(1);

    expect((await sendOverdueReminders(firm.id)).sent).toBe(0);
    expect(emailsMatching(/past due/)).toHaveLength(0);
  });
});

describe('the pre-due pass', () => {
  /** Green before and after; RED IF a refused installment send keeps its stamp. */
  it('gives back an installment stamp when the provider refuses', async () => {
    const invoiceId = await seedIssuedInvoice(60);
    await testPool.query(
      'update invoices set payment_plan_enabled = true, plan_pre_reminder_days = 5 where id = $1', [invoiceId],
    );
    await testPool.query(
      `insert into invoice_expected_payments
         (invoice_id, law_firm_id, sort_order, installment_id, due_date, amount_cents, status)
       values ($1, $2, 0, 'inst-1', current_date + 3, 25000, 'pending')`,
      [invoiceId, firm.id],
    );
    const stamp = async () => (await testPool.query(
      'select pre_due_reminder_sent_at from invoice_expected_payments where invoice_id = $1', [invoiceId],
    )).rows[0].pre_due_reminder_sent_at;

    rejectNextEmail('provider unavailable');
    await sendOverdueReminders(firm.id);
    expect(await stamp()).toBeNull();

    expect((await sendOverdueReminders(firm.id)).sent).toBe(1);
    expect(await stamp()).toBeInstanceOf(Date);
  });
});

describe('the manual send', () => {
  /** RED IF the manual stamp is written in the send's transaction (no committed entry mid-send). */
  it('has committed its rate-limit entry before the mail leaves', async () => {
    const invoiceId = await seedIssuedInvoice(-30);
    const held = holdNextEmail();
    const sending = sendReminderForInvoice({ lawFirmId: firm.id, matterId, invoiceId, actingUserId: owner.uid });
    try {
      expect(await within(held.arrived, 5_000)).not.toBe('timeout');
      expect((await reminderRow(invoiceId)).recent_manual_sends).toHaveLength(1);
    } finally {
      held.release();
    }
    expect(await sending).toEqual({ sent: true });
  });

  /** Green before and after; RED IF a refused manual send keeps consuming a rate-limit slot. */
  it('gives the rate-limit slot back when the provider refuses', async () => {
    const invoiceId = await seedIssuedInvoice(-30);
    rejectNextEmail('provider unavailable');

    const refused = await sendReminderForInvoice({ lawFirmId: firm.id, matterId, invoiceId, actingUserId: owner.uid });

    expect(refused.sent).toBe(false);
    expect(await reminderRow(invoiceId)).toMatchObject({ sent_count: 0, last_sent_at: null, recent_manual_sends: [] });
  });
});

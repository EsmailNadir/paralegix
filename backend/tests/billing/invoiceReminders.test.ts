import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  freezeClockAt,
  unfreezeClock,
  sentEmails,
  emailsMatching,
  recipientsOf,
  resetEmails,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatterMember } from '../support/matters';
import {
  daysPastDue,
  sendOverdueReminders,
  sendReminderForInvoice,
  sendInvoiceToEmail,
} from '../../src/modules/billing/invoices/invoiceReminders.service';

describe('daysPastDue', () => {
  // A day-only due date against the current instant. The old arithmetic parsed
  // the date as UTC midnight and subtracted `now`, so the count sat one short
  // until the clock reached that time of day and a [7] threshold fired on day 8.
  it('counts whole calendar days, whatever the time of day', () => {
    expect(daysPastDue('2026-09-04', new Date('2026-09-05T00:30:00Z'))).toBe(1);
    expect(daysPastDue('2026-09-04', new Date('2026-09-05T23:30:00Z'))).toBe(1);
    expect(daysPastDue('2026-09-04', new Date('2026-09-11T06:00:00Z'))).toBe(7);
  });

  it('is zero on the due day and negative before it', () => {
    expect(daysPastDue('2026-09-05', new Date('2026-09-05T18:00:00Z'))).toBe(0);
    expect(daysPastDue('2026-09-10', new Date('2026-09-05T18:00:00Z'))).toBe(-5);
  });
});

let firm: Firm;
let owner: Actor;

async function seedClient(lawFirmId: string, email: string = 'client@example.com', name: string = 'Test Client') {
  const id = randomUUID();
  await testPool.query(
    `insert into clients (id, law_firm_id, name, email, client_type) values ($1, $2, $3, $4, 'person')`,
    [id, lawFirmId, name, email],
  );
  return { id, email, name };
}

/**
 * A matter with a client attached.
 *
 * `matters` has no `client_id`: a matter can carry several clients with a
 * billing split between them, so the link lives in the `matter_clients`
 * junction. Writing it as a column on `matters` fails the insert rather than the
 * assertion, which reads as a broken test instead of a wrong fixture.
 */
async function seedMatter(lawFirmId: string, clientId: string, memberUid?: string) {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Test Matter', $3)`,
    [id, lawFirmId, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
    [id, clientId, lawFirmId],
  );
  // A manual send is a write on the matter, so the sender has to be on it.
  if (memberUid) await seedMatterMember(lawFirmId, id, memberUid);
  return { id };
}

/**
 * An invoice, written to the RELATIONAL columns.
 *
 * There is no `doc` jsonb on `invoices`. Money is integer cents in `total_cents`
 * / `amount_paid_cents`, the reminder state is three real columns
 * (`reminder_count`, `reminder_opt_out`, `recent_manual_reminders`), and a
 * payment plan's instalments live in `invoice_expected_payments`. The repository
 * maps all of that back into the dollar-denominated entity the service reads,
 * which is why the assertions below still speak in dollars while the seed speaks
 * in cents.
 *
 * `context_type` and the matter/client pair are load-bearing: a CHECK constraint
 * requires exactly one of `matter_id` or `client_context_id`, which is how the
 * schema tells a matter invoice from a client-level one.
 */
async function seedInvoice(
  lawFirmId: string,
  matterId: string,
  clientId: string,
  overrides: {
    totalAmount?: number;
    amountPaid?: number;
    totalWrittenOff?: number;
    dueDate?: string;
    isPaid?: boolean;
    status?: string;
    clientEmail?: string;
    clientName?: string;
    reminderOptOut?: boolean;
    recentManualReminders?: string[];
    instalments?: { status: string; amount: number; dueDate?: string }[];
  } = {},
) {
  const id = randomUUID();
  const invoiceNumber = `INV-${id.slice(0, 6).toUpperCase()}`;
  const toCents = (dollars: number) => Math.round(dollars * 100);

  await testPool.query(
    `insert into invoices (
       id, law_firm_id, matter_id, client_id, context_type, invoice_number, invoice_name,
       status, total_cents, amount_paid_cents, total_written_off_cents, is_paid,
       invoice_date, due_date, client_email, client_name,
       payment_plan_enabled
     ) values ($1, $2, $3, $4, 'matter', $5, $5, $6, $7, $8, $9, $10,
               current_date, $11, $12, $13, $14)`,
    [
      id,
      lawFirmId,
      matterId,
      clientId,
      invoiceNumber,
      overrides.status ?? 'outstanding',
      toCents(overrides.totalAmount ?? 1000),
      toCents(overrides.amountPaid ?? 0),
      toCents(overrides.totalWrittenOff ?? 0),
      overrides.isPaid ?? false,
      overrides.dueDate ?? '2026-08-01',
      overrides.clientEmail ?? 'client@example.com',
      overrides.clientName ?? 'Test Client',
      Boolean(overrides.instalments?.length),
    ],
  );

  // Reminder state is a shared `reminders` row (migration 0245). Seed one only
  // when this invoice actually has state, matching what the service writes.
  if (overrides.reminderOptOut || (overrides.recentManualReminders ?? []).length) {
    await testPool.query(
      `insert into reminders (law_firm_id, invoice_id, is_opted_out, recent_manual_sends)
       values ($1, $2, $3, $4)`,
      [lawFirmId, id, overrides.reminderOptOut ?? false, overrides.recentManualReminders ?? []],
    );
  }

  for (const [i, instalment] of (overrides.instalments ?? []).entries()) {
    // eslint-disable-next-line no-await-in-loop -- sort_order must follow the array
    await testPool.query(
      `insert into invoice_expected_payments
         (invoice_id, law_firm_id, sort_order, installment_id, due_date, amount_cents, status)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, lawFirmId, i, `inst-${i + 1}`, instalment.dueDate ?? null,
        toCents(instalment.amount), instalment.status],
    );
  }

  return { id, invoiceNumber };
}

/**
 * The reminder bookkeeping the service writes back. It lives on the shared
 * `reminders` row (migration 0245), one per invoice, so an invoice that has
 * never been reminded has no row and reads as the zero state.
 */
async function reminderState(id: string) {
  const { rows } = await testPool.query(
    `select coalesce(sent_count, 0)            as reminder_count,
            last_sent_at                       as last_reminder_sent_at,
            coalesce(recent_manual_sends, '{}') as recent_manual_reminders
       from reminders where invoice_id = $1`,
    [id],
  );
  return rows[0] || {
    reminder_count: 0, last_reminder_sent_at: null, recent_manual_reminders: [],
  };
}

/**
 * WHY THE TRANSPORT IS THE SEAM, NOT `emailService`.
 *
 * `invoiceReminders.service` destructures `sendInvoiceReminderEmail` and
 * `sendInvoiceByEmail` at module load, so it holds direct references to those
 * functions. A `jest.spyOn(emailService, ...)` installed afterwards replaces the
 * module's property and NOT the captured reference, so the service keeps calling
 * the original: the spy records nothing while the mail still goes out. That
 * failure is silent in the reassuring direction.
 *
 * The harness replaces the `resend` transport instead (`tests/support/email.mock`),
 * which sits below every one of those references. It also means the firm
 * notification toggle, the per-recipient daily cap and the compliance footer all
 * still run, so what is asserted is what a real recipient would receive.
 */
describe('Invoice Reminders Service', () => {
  beforeEach(async () => {
    // SET, not inherited. `DISABLE_ALL_REMINDER_EMAILS=true` is in the developer
    // `.env` this suite loads, and `remindersGloballyDisabled()` reads it at call
    // time, so every case here would short-circuit to "Reminders are disabled"
    // locally. CI has no `.env` at all, so the same file would exercise a
    // different branch there. Pinning it makes the branch under test the same in
    // both places; the kill switch has its own case at the end.
    process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

    firm = await createFirm({ name: 'Reminder Test Firm' });
    owner = await ownerOf(firm.id);

  });

  describe('sendReminderForInvoice (manual send)', () => {
    it('sends reminder for an unpaid invoice and records recentManualReminders timestamp', async () => {
      const client = await seedClient(firm.id, 'client1@example.com');
      const matter = await seedMatter(firm.id, client.id, owner.uid);
      const { id } = await seedInvoice(firm.id, matter.id, client.id, {
        totalAmount: 500,
        amountPaid: 100,
      });

      const result = await sendReminderForInvoice({
        lawFirmId: firm.id,
        invoiceId: id,
        matterId: matter.id,
        actingUserId: owner.uid,
      });

      expect(result.sent).toBe(true);
      // One message, to the client, and the amount is the REMAINING balance
      // (500 billed less 100 already paid), not the invoice total. Reminding a
      // client for money they have already paid is the failure this pins.
      const reminders = emailsMatching(/reminder|invoice/i);
      expect(reminders).toHaveLength(1);
      expect(recipientsOf(/reminder|invoice/i)).toEqual(['client1@example.com']);
      expect(reminders[0].html || reminders[0].text || '').toContain('400');

      // The write-back, read from the real columns. The rate limit below counts
      // `recent_manual_reminders`, so a send that emailed but failed to record
      // itself would let a firm send without limit.
      const state = await reminderState(id);
      expect(state.reminder_count).toBe(1);
      expect(state.last_reminder_sent_at).toBeInstanceOf(Date);
      expect(state.recent_manual_reminders).toHaveLength(1);
    });

    it('refuses to send reminder when invoice is already paid', async () => {
      const client = await seedClient(firm.id);
      const matter = await seedMatter(firm.id, client.id, owner.uid);
      const { id } = await seedInvoice(firm.id, matter.id, client.id, {
        isPaid: true,
        amountPaid: 1000,
      });

      const result = await sendReminderForInvoice({
        lawFirmId: firm.id,
        invoiceId: id,
        matterId: matter.id,
        actingUserId: owner.uid,
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toContain('already paid');
      expect(sentEmails()).toHaveLength(0);
    });

    it('refuses to send reminder when invoice has opted out', async () => {
      const client = await seedClient(firm.id);
      const matter = await seedMatter(firm.id, client.id, owner.uid);
      const { id } = await seedInvoice(firm.id, matter.id, client.id, {
        reminderOptOut: true,
      });

      const result = await sendReminderForInvoice({
        lawFirmId: firm.id,
        invoiceId: id,
        matterId: matter.id,
        actingUserId: owner.uid,
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toContain('Reminders are disabled for this invoice');
      expect(sentEmails()).toHaveLength(0);
    });

    it('enforces manual reminder rate limit (max 3 per 24 hours)', async () => {
      const client = await seedClient(firm.id);
      const matter = await seedMatter(firm.id, client.id, owner.uid);
      const now = new Date().toISOString();
      const { id } = await seedInvoice(firm.id, matter.id, client.id, {
        recentManualReminders: [now, now, now],
      });

      const result = await sendReminderForInvoice({
        lawFirmId: firm.id,
        invoiceId: id,
        matterId: matter.id,
        actingUserId: owner.uid,
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toContain('Unable to send reminder at this time');
      expect(sentEmails()).toHaveLength(0);
    });

    it('uses next pending installment amount when payment plan is active', async () => {
      const client = await seedClient(firm.id);
      const matter = await seedMatter(firm.id, client.id, owner.uid);
      const { id } = await seedInvoice(firm.id, matter.id, client.id, {
        totalAmount: 1000,
        instalments: [
          { status: 'paid', amount: 250 },
          { status: 'pending', amount: 250, dueDate: '2026-09-01' },
          { status: 'pending', amount: 500, dueDate: '2026-10-01' },
        ],
      });

      const result = await sendReminderForInvoice({
        lawFirmId: firm.id,
        invoiceId: id,
        matterId: matter.id,
        actingUserId: owner.uid,
      });

      expect(result.sent).toBe(true);
      // 250, the next PENDING instalment, not the 1000 invoice total and not the
      // 500 of the last one. A plan reminder that quotes the whole balance asks a
      // client to pay nine months early.
      const body = sentEmails()[0].html || sentEmails()[0].text || '';
      expect(body).toContain('250');
      expect(body).not.toContain('1,000');
    });
  });

  describe('sendInvoiceToEmail (issue / email invoice)', () => {
    it('emails invoice to specified recipient and creates recipient snapshot', async () => {
      const client = await seedClient(firm.id, 'client-primary@example.com');
      const matter = await seedMatter(firm.id, client.id, owner.uid);
      const { id } = await seedInvoice(firm.id, matter.id, client.id, {
        totalAmount: 1200,
      });

      const result = await sendInvoiceToEmail({
        lawFirmId: firm.id,
        invoiceId: id,
        matterId: matter.id,
        actingUserId: owner.uid,
        recipientEmail: 'custom-accountant@example.com',
        recipientName: 'Accountant Bob',
      });

      expect(result.sent).toBe(true);
      expect(result.to).toContain('custom-accountant@example.com');
      // The typed address is ADDITIVE: the client's own copy must still go out,
      // so filling in a one-off accountant can never silently divert the bill.
      expect(sentEmails()).toHaveLength(1);
      const to = recipientsOf(/./);
      expect(to).toContain('custom-accountant@example.com');
      expect(to).toContain('client-primary@example.com');
    });

    it('returns sent: false when no recipient email can be resolved', async () => {
      const client = await seedClient(firm.id, '');
      const matter = await seedMatter(firm.id, client.id, owner.uid);
      const { id } = await seedInvoice(firm.id, matter.id, client.id, {
        clientEmail: '',
      });

      const result = await sendInvoiceToEmail({
        lawFirmId: firm.id,
        invoiceId: id,
        matterId: matter.id,
        actingUserId: owner.uid,
        recipientEmail: '',
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toContain('No recipient email address');
    });
  });

  describe('the global kill switch', () => {
    it('sends nothing at all while DISABLE_ALL_REMINDER_EMAILS is on', async () => {
      // The operator switch that stops every reminder across the platform, used
      // when a mail problem is being investigated. It has to short-circuit BEFORE
      // the send, not merely suppress the transport, or a firm's rate-limit
      // counters advance for messages nobody received.
      process.env.DISABLE_ALL_REMINDER_EMAILS = 'true';
      const client = await seedClient(firm.id, 'client1@example.com');
      const matter = await seedMatter(firm.id, client.id, owner.uid);
      const { id } = await seedInvoice(firm.id, matter.id, client.id);

      const result = await sendReminderForInvoice({
        lawFirmId: firm.id, invoiceId: id, matterId: matter.id,
        actingUserId: owner.uid,
      });

      expect(result).toMatchObject({ sent: false, reason: 'Reminders are disabled' });
      expect(sentEmails()).toHaveLength(0);
      const state = await reminderState(id);
      expect(state.reminder_count).toBe(0);
      expect(state.recent_manual_reminders).toHaveLength(0);
    });
  });

  describe('sendOverdueReminders (scheduled batch)', () => {
    it('skips processing when firm settings have invoiceReminderEnabled = false', async () => {
      // Create firm with reminders disabled
      await testPool.query(
        `update law_firms set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{invoiceReminderEnabled}', 'false') where id = $1`,
        [firm.id],
      );

      const client = await seedClient(firm.id);
      const matter = await seedMatter(firm.id, client.id);
      await seedInvoice(firm.id, matter.id, client.id, {
        dueDate: '2026-07-01', // overdue
      });

      const stats = await sendOverdueReminders(firm.id);
      expect(stats.sent).toBe(0);
      expect(sentEmails()).toHaveLength(0);
    });

    it('sends overdue reminders when firm settings enable reminders and invoice meets threshold', async () => {
      await testPool.query(
        `update law_firms set settings = '{"invoiceReminderEnabled": true, "invoiceReminderDays": [7, 14, 30]}' where id = $1`,
        [firm.id],
      );

      const client = await seedClient(firm.id, 'overdue-client@example.com');
      const matter = await seedMatter(firm.id, client.id);
      const { id } = await seedInvoice(firm.id, matter.id, client.id, {
        dueDate: '2026-07-01', // Over 30 days overdue
        totalAmount: 750,
      });

      const stats = await sendOverdueReminders(firm.id);
      expect(stats.sent).toBeGreaterThanOrEqual(1);
      expect(recipientsOf(/./)).toEqual(['overdue-client@example.com']);

      // The batch has to record the send the same way a manual one does, or the
      // next nightly pass reminds the same client again.
      const state = await reminderState(id);
      expect(state.reminder_count).toBe(1);
      expect(state.last_reminder_sent_at).toBeInstanceOf(Date);
    });

    // B08.2: scheduled dunning must keep paid and voided invoices out
    // of the candidate set while still sending the eligible control invoice.
    // The positive control matters: an empty result would otherwise make this
    // pass even if the query rejected every invoice.
    it('excludes paid and voided invoices from the overdue batch', async () => {
      await testPool.query(
        `update law_firms set settings = '{"invoiceReminderEnabled": true, "invoiceReminderDays": [7, 14, 30]}' where id = $1`,
        [firm.id],
      );

      const eligibleClient = await seedClient(firm.id, 'eligible@example.com');
      const paidClient = await seedClient(firm.id, 'paid@example.com');
      const voidedClient = await seedClient(firm.id, 'voided@example.com');
      const eligibleMatter = await seedMatter(firm.id, eligibleClient.id);
      const paidMatter = await seedMatter(firm.id, paidClient.id);
      const voidedMatter = await seedMatter(firm.id, voidedClient.id);

      const eligible = await seedInvoice(firm.id, eligibleMatter.id, eligibleClient.id, {
        dueDate: '2026-07-01', totalAmount: 750,
      });
      await seedInvoice(firm.id, paidMatter.id, paidClient.id, {
        dueDate: '2026-07-01', totalAmount: 750, amountPaid: 750, isPaid: true,
      });
      await seedInvoice(firm.id, voidedMatter.id, voidedClient.id, {
        dueDate: '2026-07-01', totalAmount: 750, status: 'voided',
      });

      const stats = await sendOverdueReminders(firm.id);

      expect(stats.sent).toBe(1);
      expect(recipientsOf(/./)).toEqual(['eligible@example.com']);
      expect((await reminderState(eligible.id)).reminder_count).toBe(1);
      expect(recipientsOf(/./)).not.toEqual(expect.arrayContaining([
        'paid@example.com', 'voided@example.com',
      ]));
    });
  });
});

/**
 * The firm's own calendar decides when a reminder is due.
 *
 * `daysPastDue` takes a timezone and the sweep never passed one, so the count
 * ran on the server's UTC day. For every firm behind UTC there is a window each
 * evening where UTC has already turned over: a [7]-day threshold fires while it
 * is still day six where the firm and the client are, and a client is chased
 * for a bill that is not yet as late as the email says.
 *
 * The firm's calendar governs, not the recipient's, because the due date is the
 * firm's own term. It is `settings.timezone`, and an unset or unrecognised zone
 * falls back to UTC, which is the behaviour every firm had before.
 */
describe('overdue reminders follow the firm calendar, not UTC', () => {
  async function firmDueOn(dueDate: string, timezone: string | null) {
    const laFirm = await createFirm();
    await ownerOf(laFirm.id);
    await testPool.query(
      `update law_firms
          set settings = jsonb_build_object('invoiceReminderEnabled', true, 'invoiceReminderDays', '[7]'::jsonb)
                         || case when $2::text is null then '{}'::jsonb else jsonb_build_object('timezone', $2::text) end
        where id = $1`,
      [laFirm.id, timezone],
    );
    const client = await seedClient(laFirm.id, 'la-client@example.com');
    const matter = await seedMatter(laFirm.id, client.id);
    await seedInvoice(laFirm.id, matter.id, client.id, { dueDate, totalAmount: 500 });
    return laFirm;
  }

  beforeEach(() => {
    // Same reason as the suite above: the developer `.env` this suite loads
    // carries the kill switch, and CI has no `.env` at all.
    process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  });

  afterEach(() => {
    unfreezeClock();
  });

  it('does not send on the evening before the threshold, when UTC has already turned over', async () => {
    const laFirm = await firmDueOn('2026-03-09', 'America/Los_Angeles');
    // 18:00 in Los Angeles is 01:00 the NEXT day in UTC. Locally the invoice is
    // six days past due; read in UTC it is seven, and the reminder goes early.
    freezeClockAt('2026-03-15T18:00:00-07:00');

    const stats = await sendOverdueReminders(laFirm.id);

    expect(stats.sent).toBe(0);
    expect(recipientsOf(/./)).toEqual([]);
  });

  it('sends the next morning, when the firm calendar reaches the threshold', async () => {
    const laFirm = await firmDueOn('2026-03-09', 'America/Los_Angeles');
    freezeClockAt('2026-03-16T09:00:00-07:00');

    const stats = await sendOverdueReminders(laFirm.id);

    // The other half of the pair. Without it, a sweep that never sent at all
    // would satisfy the case above.
    expect(stats.sent).toBe(1);
    expect(recipientsOf(/./)).toEqual(['la-client@example.com']);
  });

  it('keeps the old UTC behaviour for a firm that has set no zone', async () => {
    const utcFirm = await firmDueOn('2026-03-09', null);
    freezeClockAt('2026-03-15T18:00:00-07:00');

    // Same instant as the first case. With no zone configured the firm gets
    // exactly what it got before, rather than a silently different calendar.
    const stats = await sendOverdueReminders(utcFirm.id);

    expect(stats.sent).toBe(1);
  });

  it('falls back to UTC rather than failing on an unrecognised zone', async () => {
    const typoFirm = await firmDueOn('2026-03-09', 'Amrica/Los_Angeles');
    freezeClockAt('2026-03-15T18:00:00-07:00');

    // A typo in one firm's settings must not throw and take the whole nightly
    // sweep down with it, leaving every other firm unreminded.
    const stats = await sendOverdueReminders(typoFirm.id);

    expect(stats.errors).toBe(0);
    expect(stats.sent).toBe(1);
  });
});

describe('overdue reminders: one per threshold reached', () => {
  /** A firm on [7, 14, 30] in Los Angeles, an invoice due on `dueDate`, and a reminder last sent at `lastSentAt`. */
  async function invoiceWithLastReminder(dueDate: string, lastSentAt: string | null) {
    const laFirm = await createFirm();
    await ownerOf(laFirm.id);
    await testPool.query(
      `update law_firms set settings = jsonb_build_object(
         'invoiceReminderEnabled', true, 'invoiceReminderDays', '[7, 14, 30]'::jsonb, 'timezone', 'America/Los_Angeles')
        where id = $1`,
      [laFirm.id],
    );
    const client = await seedClient(laFirm.id, 'stage-client@example.com');
    const matter = await seedMatter(laFirm.id, client.id);
    const { id } = await seedInvoice(laFirm.id, matter.id, client.id, { dueDate, totalAmount: 500 });
    if (lastSentAt) {
      await testPool.query(
        `insert into reminders (law_firm_id, invoice_id, sent_count, last_sent_at) values ($1, $2, 1, $3)`,
        [laFirm.id, id, lastSentAt],
      );
    }
    return laFirm;
  }

  beforeEach(() => {
    process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  });

  afterEach(() => {
    unfreezeClock();
  });

  /** Goes red if a reminder goes out every day once the first threshold has passed. */
  it('sends nothing the day after the day-7 reminder', async () => {
    // 25 hours after the day-7 send, so "a day has passed" by the clock.
    const laFirm = await invoiceWithLastReminder('2026-03-01', '2026-03-08T08:00:00-08:00');
    freezeClockAt('2026-03-09T10:00:00-07:00');

    expect((await sendOverdueReminders(laFirm.id)).sent).toBe(0);
  });

  /**
   * Goes red if the day-30 reminder is held back by the day-14 one: the old
   * check compared days since the last send with the gap to the FIRST
   * threshold, so it never passed.
   */
  it('sends the day-30 reminder after a day-14 one', async () => {
    const laFirm = await invoiceWithLastReminder('2026-03-01', '2026-03-15T09:00:00-07:00');
    freezeClockAt('2026-03-31T09:00:00-07:00');

    expect((await sendOverdueReminders(laFirm.id)).sent).toBe(1);
  });

  /**
   * Goes red if days since the last send are counted in elapsed hours: this
   * run is a minute earlier in the day than last week's, which read as six
   * days and skipped the day-14 reminder.
   */
  it('sends the day-14 reminder a week after day 7, whatever the time of day', async () => {
    const laFirm = await invoiceWithLastReminder('2026-03-01', '2026-03-08T09:01:00-08:00');
    freezeClockAt('2026-03-15T09:00:00-07:00');

    expect((await sendOverdueReminders(laFirm.id)).sent).toBe(1);
  });
});

describe('pre-due reminders follow the firm calendar', () => {
  beforeEach(() => {
    process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  });

  afterEach(() => {
    unfreezeClock();
  });

  /**
   * One day before due, for a firm in Los Angeles. Goes red if days-until-due
   * is counted on the UTC calendar: at 6pm Pacific on the 15th it is already
   * the 16th in UTC, so an invoice due the 17th reads as due tomorrow a day early.
   */
  it('does not send the evening before the window opens', async () => {
    const laFirm = await createFirm();
    await ownerOf(laFirm.id);
    await testPool.query(
      `update law_firms set settings = jsonb_build_object('defaultPreDueReminderDays', 1, 'timezone', 'America/Los_Angeles')
        where id = $1`,
      [laFirm.id],
    );
    const client = await seedClient(laFirm.id, 'predue-client@example.com');
    const matter = await seedMatter(laFirm.id, client.id);
    await seedInvoice(laFirm.id, matter.id, client.id, { dueDate: '2026-03-17', totalAmount: 500 });
    freezeClockAt('2026-03-15T18:00:00-07:00');

    await sendOverdueReminders(laFirm.id);

    expect(recipientsOf(/./)).toEqual([]);
  });

  /** A Los Angeles firm with a 5-day pre-due window. */
  async function preDueFirm(email: string) {
    const laFirm = await createFirm();
    await ownerOf(laFirm.id);
    await testPool.query(
      `update law_firms set settings = jsonb_build_object('defaultPreDueReminderDays', 5, 'timezone', 'America/Los_Angeles')
        where id = $1`,
      [laFirm.id],
    );
    const client = await seedClient(laFirm.id, email);
    const matter = await seedMatter(laFirm.id, client.id);
    return { laFirm, client, matter };
  }

  /** Run one pass at `iso`, with the clock re-frozen there. */
  async function passAt(lawFirmId: string, iso: string) {
    unfreezeClock();
    freezeClockAt(iso);
    return sendOverdueReminders(lawFirmId);
  }

  /**
   * RED IF "already sent" is counted in elapsed hours: the second pass runs two
   * seconds earlier in the day, so under 24 hours have passed although it is
   * the next day on the firm's calendar, and the reminder is skipped.
   */
  it('sends again on the next firm day even when the pass runs a little earlier', async () => {
    const { laFirm, client, matter } = await preDueFirm('cadence@example.com');
    const { id } = await seedInvoice(laFirm.id, matter.id, client.id, { dueDate: '2026-03-20', totalAmount: 500 });

    expect((await passAt(laFirm.id, '2026-03-15T09:00:05-07:00')).sent).toBe(1);
    resetEmails();

    expect((await passAt(laFirm.id, '2026-03-16T09:00:03-07:00')).sent).toBe(1);
    expect(recipientsOf(/Upcoming payment/)).toEqual(['cadence@example.com']);
    const { rows } = await testPool.query('select pre_due_sent_at from reminders where invoice_id = $1', [id]);
    expect(rows[0].pre_due_sent_at.toISOString()).toBe('2026-03-16T16:00:03.000Z');
  });

  /** RED IF the day rule lets a second pass on the same firm day send again. */
  it('sends at most once per firm day', async () => {
    const { laFirm, client, matter } = await preDueFirm('once@example.com');
    await seedInvoice(laFirm.id, matter.id, client.id, { dueDate: '2026-03-20', totalAmount: 500 });

    expect((await passAt(laFirm.id, '2026-03-16T09:00:00-07:00')).sent).toBe(1);
    expect((await passAt(laFirm.id, '2026-03-16T23:30:00-07:00')).sent).toBe(0);
    expect(recipientsOf(/Upcoming payment/)).toEqual(['once@example.com']);
  });

  /** RED IF installments keep the elapsed-hours rule. */
  it('applies the same day rule to plan installments', async () => {
    const { laFirm, client, matter } = await preDueFirm('installment@example.com');
    await testPool.query(
      `update law_firms set settings = settings - 'defaultPreDueReminderDays' where id = $1`, [laFirm.id],
    );
    const { id } = await seedInvoice(laFirm.id, matter.id, client.id, {
      dueDate: '2026-04-30',
      totalAmount: 500,
      instalments: [{ status: 'pending', amount: 250, dueDate: '2026-03-20' }],
    });
    await testPool.query('update invoices set plan_pre_reminder_days = 5 where id = $1', [id]);

    expect((await passAt(laFirm.id, '2026-03-15T09:00:05-07:00')).sent).toBe(1);
    expect((await passAt(laFirm.id, '2026-03-16T09:00:03-07:00')).sent).toBe(1);
    const { rows } = await testPool.query(
      'select pre_due_reminder_sent_at from invoice_expected_payments where invoice_id = $1', [id],
    );
    expect(rows[0].pre_due_reminder_sent_at.toISOString()).toBe('2026-03-16T16:00:03.000Z');
  });
});

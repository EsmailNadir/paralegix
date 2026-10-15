/**
 * B08.1 J03: invoice reminder claim collision, closed with a REAL concurrent race.
 *
 * `sendOverdueReminders` in `src/modules/billing/invoices/invoiceReminders.service.ts`
 * used to read a batch of overdue/upcoming invoices, decide eligibility in JS
 * (`shouldSendReminder` for overdue invoices, per-invoice/per-installment
 * day-window checks for pre-due reminders), send the email, and only THEN write
 * `lastReminderSentAt`/`reminderCount`/`preDueReminderSentAt` back via
 * `invoicesRepo.update`. That read-decide-send-write shape was check-then-act:
 * two overlapping cron sweeps could both read the same invoice/installment as
 * eligible before either had written its stamp, so a client got the same
 * reminder email twice, and (for the overdue branch) the send count was
 * computed from each pass's own stale read, so it under-counted the very
 * duplicate it exists to reveal.
 *
 * The fix mirrors the pattern the M09 late-fee concurrency fix already
 * established for this exact repository (`invoicesRepo.runInvoiceTxn`, see
 * `applyLateFeeCore` in `invoices.service.ts`): the eligibility re-check
 * and the stamp are claimed in one row-locked transaction committed before the
 * send (`runReminderTxn`, `select ... for update` on the invoice row). Two
 * overlapping sweeps calling `runReminderTxn` for the same invoice serialize on
 * that row lock:
 * whichever commits first stamps the reminder; the second re-reads under the
 * lock, sees its own just-written stamp, and sends nothing.
 *
 * All three describe blocks below prove that with a GATE forcing genuine
 * concurrent overlap at the entry to `invoicesRepo.runReminderTxn` (not a
 * `Promise.all` hope) — the same technique `signingReminderClaimRace.test.ts`
 * uses for the sibling signing-reminder fix.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  drainEvents,
  sentEmails,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');
import { sendOverdueReminders } from '../../src/modules/billing/invoices/invoiceReminders.service';

let firm: Firm;
let previousKillSwitch: string | undefined;

beforeEach(async () => {
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

  firm = await createFirm({ name: 'Race Firm' });
});

afterEach(() => {
  process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

/** A client + matter fixture invoices can attach to, seeded via plain SQL. */
async function seedMatterAndClient(lawFirmId: string) {
  const clientId = randomUUID();
  await testPool.query(
    `insert into clients (id, law_firm_id, name, email, client_type) values ($1, $2, 'Race Client', 'race-client@example.test', 'person')`,
    [clientId, lawFirmId],
  );
  const matterId = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, 'Race Matter', $3)`,
    [matterId, lawFirmId, `REF-${matterId.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
    [matterId, clientId, lawFirmId],
  );
  return { clientId, matterId };
}

describe('invoice overdue reminder claim collision (real concurrency)', () => {
  let invoiceId: string;

  beforeEach(async () => {
    await testPool.query(
      `update law_firms set settings = '{"invoiceReminderEnabled": true, "invoiceReminderDays": [7, 14, 30]}' where id = $1`,
      [firm.id],
    );

    const { matterId, clientId } = await seedMatterAndClient(firm.id);

    invoiceId = randomUUID();
    await testPool.query(
      `insert into invoices (id, law_firm_id, matter_id, client_id, context_type, invoice_number, invoice_name,
          status, total_cents, invoice_date, due_date, client_email, client_name)
       values ($1, $2, $3, $4, 'matter', $5, $5, 'outstanding', 100000, current_date - 40, current_date - 30, 'race-client@example.test', 'Race Client')`,
      [invoiceId, firm.id, matterId, clientId, `INV-${invoiceId.slice(0, 8)}`],
    );
  });

  it('two overlapping sweeps send exactly one overdue reminder for the same invoice', async () => {
    // Gate the entry to `runReminderTxn` itself, so both concurrent sweeps are
    // proved to reach the atomic claim/re-check transaction AT THE SAME TIME,
    // before either has acquired the row's `for update` lock. Opening the gate
    // releases both into the real transaction concurrently; Postgres's own row
    // lock is what serializes them, not JS-level bookkeeping.
    const gate = gateMethod(invoicesRepo, 'runReminderTxn');
    try {
      const passA = sendOverdueReminders(firm.id);
      const passB = sendOverdueReminders(firm.id);

      await gate.arrived(2);
      gate.open();

      const [resultA, resultB] = await Promise.all([passA, passB]);
      await drainEvents();

      // Exactly one of the two overlapping sweeps sent the reminder.
      expect(resultA.sent + resultB.sent).toBe(1);
      expect(sentEmails().filter((e) => /overdue|reminder/i.test(e.subject || ''))).toHaveLength(1);

      const { rows } = await testPool.query(
        `select sent_count as reminder_count, last_sent_at as last_reminder_sent_at
           from reminders where invoice_id = $1`,
        [invoiceId],
      );
      // The stamp write happens in the SAME locked transaction as the send, so
      // reminder_count increments exactly once - not zero (which a broken claim
      // that never wrote would produce) and not two (the original bug, where
      // both passes computed `+ 1` off their own stale pre-lock read).
      expect(rows[0].reminder_count).toBe(1);
      expect(rows[0].last_reminder_sent_at).not.toBeNull();
    } finally {
      gate.restore();
    }
  });
});

describe('invoice pre-due reminder claim collision (real concurrency)', () => {
  let invoiceId: string;

  beforeEach(async () => {
    const { matterId, clientId } = await seedMatterAndClient(firm.id);

    invoiceId = randomUUID();
    await testPool.query(
      `insert into invoices (id, law_firm_id, matter_id, client_id, context_type, invoice_number, invoice_name,
          status, total_cents, invoice_date, due_date, client_email, client_name)
       values ($1, $2, $3, $4, 'matter', $5, $5, 'outstanding', 100000, current_date - 5, current_date + 5, 'race-client@example.test', 'Race Client')`,
      [invoiceId, firm.id, matterId, clientId, `INV-${invoiceId.slice(0, 8)}`],
    );
    // The pre-due window is reminder state, so it is a `reminders` row now.
    await testPool.query(
      `insert into reminders (law_firm_id, invoice_id, pre_due_days) values ($1, $2, 7)`,
      [firm.id, invoiceId],
    );
  });

  it('two overlapping sweeps send exactly one invoice-level pre-due reminder', async () => {
    // The invoice is due in 5 days with a 7-day pre-due window, so it is picked
    // up ONLY by the pre-due branch (not overdue), which shares the same
    // runReminderTxn fix. Same gate technique as the overdue race above.
    const gate = gateMethod(invoicesRepo, 'runReminderTxn');
    try {
      const passA = sendOverdueReminders(firm.id);
      const passB = sendOverdueReminders(firm.id);

      await gate.arrived(2);
      gate.open();

      const [resultA, resultB] = await Promise.all([passA, passB]);
      await drainEvents();

      expect(resultA.sent + resultB.sent).toBe(1);
      expect(sentEmails()).toHaveLength(1);

      const { rows } = await testPool.query(
        `select pre_due_sent_at as pre_due_reminder_sent_at from reminders where invoice_id = $1`,
        [invoiceId],
      );
      expect(rows[0].pre_due_reminder_sent_at).not.toBeNull();
    } finally {
      gate.restore();
    }
  });
});

describe('invoice payment-plan installment reminder claim collision (real concurrency)', () => {
  let invoiceId: string;

  beforeEach(async () => {
    const { matterId, clientId } = await seedMatterAndClient(firm.id);

    invoiceId = randomUUID();
    await testPool.query(
      `insert into invoices (id, law_firm_id, matter_id, client_id, context_type, invoice_number, invoice_name,
          status, total_cents, invoice_date, due_date, client_email, client_name,
          payment_plan_enabled, plan_pre_reminder_days)
       values ($1, $2, $3, $4, 'matter', $5, $5, 'outstanding', 100000, current_date - 5, current_date + 60, 'race-client@example.test', 'Race Client',
          true, 7)`,
      [invoiceId, firm.id, matterId, clientId, `INV-${invoiceId.slice(0, 8)}`],
    );
    await testPool.query(
      `insert into invoice_expected_payments (invoice_id, law_firm_id, sort_order, installment_id, due_date, amount_cents, status)
       values ($1, $2, 0, 'inst-1', (current_date + 3), 50000, 'pending')`,
      [invoiceId, firm.id],
    );
  });

  it('two overlapping sweeps send exactly one installment pre-due reminder', async () => {
    // The invoice itself has no invoice-level due date (so the invoice-level
    // pre-due branch is inactive) and one pending installment due in 3 days
    // with a 7-day plan pre-reminder window, so only the installment loop
    // fires - still inside the SAME per-invoice runReminderTxn as the other two
    // branches.
    const gate = gateMethod(invoicesRepo, 'runReminderTxn');
    try {
      const passA = sendOverdueReminders(firm.id);
      const passB = sendOverdueReminders(firm.id);

      await gate.arrived(2);
      gate.open();

      const [resultA, resultB] = await Promise.all([passA, passB]);
      await drainEvents();

      expect(resultA.sent + resultB.sent).toBe(1);
      expect(sentEmails()).toHaveLength(1);

      const { rows } = await testPool.query(
        `select pre_due_reminder_sent_at from invoice_expected_payments where invoice_id = $1`,
        [invoiceId],
      );
      expect(rows[0].pre_due_reminder_sent_at).not.toBeNull();
    } finally {
      gate.restore();
    }
  });
});

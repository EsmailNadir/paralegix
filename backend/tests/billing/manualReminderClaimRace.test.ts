/**
 * Manual "send reminder now" claim collision, closed with a REAL concurrent race.
 *
 * `sendReminderForInvoice` in `src/modules/billing/invoices/invoiceReminders.service.ts`
 * is the firm-member-triggered manual send (a "Send reminder" button click), as
 * opposed to `sendOverdueReminders`'s cron sweep (see `invoiceReminderClaimRace.test.ts`
 * for that sibling fix). It used to read the invoice via `invoicesRepo.findById`,
 * check the 3-sends-per-24h rate limit plus balance/opt-out conditions in JS off
 * that one read, send the email, and only THEN write
 * `lastReminderSentAt`/`reminderCount`/`recentManualReminders` back via a plain
 * `invoicesRepo.update(context, invoiceId, {...})` with no row lock. That is the
 * same check-then-act shape the cron sweep had: two near-simultaneous manual
 * sends (a double-click, or two firm members both clicking "send now" within the
 * same moment) could both read the invoice as within the rate limit before
 * either had written back, so both would send - bypassing the cap the moment it
 * matters most, right at the boundary - and the write-back was a stale-data
 * last-write-wins, undercounting `recentManualReminders`/`reminderCount` by
 * however many sends the losing write dropped.
 *
 * The fix mirrors the cron-sweep fix exactly: the rate-limit re-check, the
 * balance/opt-out check and the reminder-stamp write are claimed in one
 * transaction that holds `select ... for update` on the invoice row and commits
 * before the send (`invoicesRepo.runReminderTxn`). Two overlapping manual sends for the
 * same invoice serialize on that row lock - whichever commits first stamps
 * `recentManualReminders`; the second re-reads under the lock and re-derives the
 * rate limit from that freshly-written array, not its own stale pre-lock read.
 *
 * The invoice below starts with 2 recorded sends in the last 24h (cap is 3), so
 * exactly ONE more send is legitimately allowed before the cap trips. A gate
 * forces genuine concurrent overlap at the entry to the serialization point
 * (not a `Promise.all` hope, per `tests/support/gate.ts`), proving the two
 * requests really were both in flight when the race window mattered.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  sentEmails,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';
import { seedMatterMember } from '../support/matters';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');
import { sendReminderForInvoice } from '../../src/modules/billing/invoices/invoiceReminders.service';

let firm: Firm;
let owner: Actor;
let previousKillSwitch: string | undefined;

beforeEach(async () => {
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

  firm = await createFirm({ name: 'Manual Reminder Race Firm' });
  owner = await ownerOf(firm.id);
});

afterEach(() => {
  process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

/** A client + matter fixture invoices can attach to, seeded via plain SQL. */
async function seedMatterAndClient(lawFirmId: string) {
  const clientId = randomUUID();
  await testPool.query(
    `insert into clients (id, law_firm_id, name, email, client_type) values ($1, $2, 'Race Client', 'manual-race-client@example.test', 'person')`,
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
  // A manual send is a write on the matter, so the sender has to be on it.
  await seedMatterMember(lawFirmId, matterId, owner.uid);
  return { clientId, matterId };
}

describe('manual invoice reminder claim collision (real concurrency)', () => {
  let invoiceId: string;
  let matterId: string;

  beforeEach(async () => {
    const seeded = await seedMatterAndClient(firm.id);
    matterId = seeded.matterId;
    const { clientId } = seeded;

    invoiceId = randomUUID();
    // 2 manual sends already recorded in the last 24h (cap is 3), so exactly
    // ONE more concurrent send should be admitted and the other rejected by
    // the rate limit - a correctly-serialized outcome, not a coin flip.
    const priorSends = [
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    ];
    await testPool.query(
      `insert into invoices (id, law_firm_id, matter_id, client_id, context_type, invoice_number, invoice_name,
          status, total_cents, invoice_date, due_date, client_email, client_name)
       values ($1, $2, $3, $4, 'matter', $5, $5, 'outstanding', 100000, current_date - 10, current_date + 20,
          'manual-race-client@example.test', 'Race Client')`,
      [invoiceId, firm.id, matterId, clientId, `INV-${invoiceId.slice(0, 8)}`],
    );
    // The send count and the 24h window of manual sends are a `reminders` row
    // (migration 0245), written inside the same locked transaction as the send.
    await testPool.query(
      `insert into reminders (law_firm_id, invoice_id, sent_count, recent_manual_sends)
       values ($1, $2, 2, $3)`,
      [firm.id, invoiceId, priorSends],
    );
  });

  it('two overlapping manual sends admit exactly one more, correctly rate-limiting the other', async () => {
    // Gate the entry to `runReminderTxn` itself, so both concurrent manual sends
    // are proved to reach the atomic claim/re-check transaction AT THE SAME
    // TIME, before either has acquired the row's `for update` lock. Opening the
    // gate releases both into the real transaction concurrently; Postgres's own
    // row lock is what serializes them, not JS-level bookkeeping.
    const gate = gateMethod(invoicesRepo, 'runReminderTxn');
    try {
      const passA = sendReminderForInvoice({ lawFirmId: firm.id, invoiceId, matterId, actingUserId: owner.uid }).catch((e: any) => e);
      const passB = sendReminderForInvoice({ lawFirmId: firm.id, invoiceId, matterId, actingUserId: owner.uid }).catch((e: any) => e);

      await gate.arrived(2);
      gate.open();

      const [resultA, resultB] = await Promise.all([passA, passB]);

      const results = [resultA, resultB];
      const sentResults = results.filter((r) => r && r.sent === true);
      const rejectedResults = results.filter((r) => r && r.sent === false);

      // Exactly one of the two overlapping manual sends went out - the cap
      // (3 per 24h, 2 already on record) allows precisely one more, and the
      // row lock means the second call re-derives the rate limit from the
      // FIRST call's freshly-written stamp rather than its own stale pre-lock
      // read.
      expect(sentResults).toHaveLength(1);
      expect(rejectedResults).toHaveLength(1);
      expect(rejectedResults[0].reason).toContain('Unable to send reminder at this time');
      expect(sentEmails().filter((e) => /reminder|invoice/i.test(e.subject || ''))).toHaveLength(1);

      const { rows } = await testPool.query(
        `select sent_count as reminder_count, recent_manual_sends as recent_manual_reminders
           from reminders where invoice_id = $1`,
        [invoiceId],
      );
      // Went from 2 recorded sends to 3, not 4 (both writes landing) and not
      // still 2 (the winning write lost entirely).
      expect(rows[0].reminder_count).toBe(3);
      expect(rows[0].recent_manual_reminders).toHaveLength(3);
    } finally {
      gate.restore();
    }
  });
});

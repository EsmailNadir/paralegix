/**
 * B08.2: invoice reminders' organization recipient snapshot.
 *
 * `invoiceReminders.service.ts#resolveRecipientEmails` reads
 * `readInvoiceSnapshot(invoice)` first and only falls back to a live roster
 * resolve when no snapshot exists (see its own doc comment: "An issued
 * invoice answers from its frozen snapshot ... a roster change after billing
 * does not redirect reminders for money already invoiced"). That is the exact
 * function BOTH `sendReminderForInvoice` (manual) and `sendOverdueReminders`
 * (the nightly cron) call to decide who gets mailed.
 *
 * `tests/organizations/billingRecipientSnapshotTiming.test.ts` proves the
 * freeze-on-issue rule thoroughly, but only through the `send-email` /
 * `send-email` resend routes (`sendInvoiceToEmail`). `tests/organizations/
 * regressions.test.ts` R3 exercises `sendReminderForInvoice` for an
 * organization, but only for invoices that were NEVER issued (no snapshot
 * exists yet), which is explicitly the one case where a live resolve is
 * still correct. Neither combination - an ALREADY-ISSUED organization
 * invoice, roster changed since, then reminded - is exercised anywhere, so
 * it is not proven that the reminder cron actually reads the frozen snapshot
 * rather than quietly re-resolving today's roster the way the pre-issue path
 * does. That is exactly the scenario this file pins.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  createInvoice,
  ownerOf,
  sentEmails,
  recipientsOf,
  type Firm,
  type ClientRecord,
  type Actor,
} from '../support/setupInProcess';
import { linkIdFor as linkIdInFirm } from './world';

const {
  sendInvoiceToEmail,
  sendReminderForInvoice,
  sendOverdueReminders,
} = require('../../src/modules/billing/invoices/invoiceReminders.service');

let firm: Firm;
let org: ClientRecord;
let owner: Actor;

interface RosterPerson {
  uid: string;
  clientId: string;
  email: string;
}

async function rosterPerson(name: string, email: string): Promise<RosterPerson> {
  const { uid } = await createPortalUser();
  const client = await createPersonClient(firm.id, { name, userId: uid, email });
  await linkPersonToOrg(firm.id, client.id, org.id, { canViewBilling: true, isEmailRecipient: true });
  return { uid, clientId: client.id, email };
}

// See tests/billing/invoiceReminders.test.ts: backend/.env sets
// DISABLE_ALL_REMINDER_EMAILS=true for the rest of the suite, so this file has
// to turn the kill switch off itself or every case below passes for the wrong
// reason (an empty outbox because nothing was allowed to send at all).
let previousKillSwitch: string | undefined;

beforeEach(async () => {
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  org = await createOrgClient(firm.id, { name: 'Acme Corporation', email: null });
});

afterEach(() => {
  process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

describe('organization recipient snapshot survives the reminder path', () => {
  it('sendReminderForInvoice mails the frozen roster, not the live one, after a roster change', async () => {
    const alice = await rosterPerson('Alice Attn', 'alice@example.test');
    const bob = await rosterPerson('Bob Second', 'bob@example.test');
    const invoice = await createInvoice(firm.id, org.id, { status: 'outstanding', totalCents: 750_00 });
    // Overdue, so the manual reminder below renders as a past-due notice
    // rather than an upcoming-payment one (both are legitimate `sendReminder-
    // ForInvoice` outputs; the past-due subject is what the assertion below
    // matches on).
    await testPool.query(`update invoices set due_date = current_date - 5 where id = $1`, [invoice.id]);

    // The first external send freezes the roster at this moment.
    const issueResult = await sendInvoiceToEmail({
      lawFirmId: firm.id, invoiceId: invoice.id, clientId: org.id, actingUserId: owner.uid,
    });
    expect(issueResult.sent).toBe(true);
    expect(issueResult.to.sort()).toEqual([alice.email, bob.email].sort());

    // Roster changes AFTER issue: Bob leaves, Carol joins.
    const bobLinkId = await linkIdInFirm(firm.id, bob.clientId, org.id);
    await testPool.query('update client_company_links set is_email_recipient = false where id = $1', [bobLinkId]);
    const carol = await rosterPerson('Carol Third', 'carol@example.test');
    await drainEvents();

    const reminderResult = await sendReminderForInvoice({
      lawFirmId: firm.id, invoiceId: invoice.id, clientId: org.id, actingUserId: owner.uid,
    });
    expect(reminderResult.sent).toBe(true);

    // THE RULE UNDER TEST: the reminder reaches the FROZEN roster from the
    // moment of issue - Bob (removed since) still gets it, Carol (added
    // since) does not - not today's live roster, which would be the reverse.
    const reminderTo = recipientsOf(/reminder/i);
    expect(reminderTo.sort()).toEqual([alice.email, bob.email].sort());
    expect(reminderTo).not.toContain(carol.email);
  });

  it('sendOverdueReminders (the nightly batch) honors the same frozen snapshot', async () => {
    await testPool.query(
      `update law_firms set settings = '{"invoiceReminderEnabled": true, "invoiceReminderDays": [1]}' where id = $1`,
      [firm.id],
    );

    const alice = await rosterPerson('Alice Attn', 'alice@example.test');
    const bob = await rosterPerson('Bob Second', 'bob@example.test');
    const invoice = await createInvoice(firm.id, org.id, { status: 'outstanding', totalCents: 500_00 });

    const issueResult = await sendInvoiceToEmail({
      lawFirmId: firm.id, invoiceId: invoice.id, clientId: org.id, actingUserId: owner.uid,
    });
    expect(issueResult.sent).toBe(true);

    // Make it overdue so the batch scan picks it up, and roster changes after
    // the freeze, same as the manual case above.
    await testPool.query(`update invoices set due_date = current_date - 5 where id = $1`, [invoice.id]);
    const bobLinkId = await linkIdInFirm(firm.id, bob.clientId, org.id);
    await testPool.query('update client_company_links set is_email_recipient = false where id = $1', [bobLinkId]);
    const carol = await rosterPerson('Carol Third', 'carol@example.test');
    await drainEvents();

    const stats = await sendOverdueReminders(firm.id);
    expect(stats.sent).toBeGreaterThanOrEqual(1);

    const batchTo = recipientsOf(/reminder/i);
    expect(batchTo.sort()).toEqual([alice.email, bob.email].sort());
    expect(batchTo).not.toContain(carol.email);
    expect(sentEmails().length).toBeGreaterThan(0);
  });
});

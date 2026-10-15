/**
 * A reminder's "View Invoice & Pay" link while a payment request is open.
 *
 * A request that passes a processing fee on goes out as a secure payment link
 * that needs no login. A reminder pointing at the client portal instead would
 * strand a client who cannot sign in, so the reminder must carry the same
 * link. Red if the reminder links to the portal when a pay link exists, or to
 * a pay link when the request has none.
 *
 * A link charges one figure: the full balance, or one payment-plan
 * installment. A reminder carries the link only when it asks for that same
 * figure, and then quotes what the link charges. Any other reminder links the
 * portal, so its button never charges a different amount than its text names.
 * Red if a reminder for one installment carries a link for another, if a
 * full-balance reminder carries an installment link or the reverse, or if a
 * reminder quotes the row's amount while the link charges less.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  sentEmails,
  resetEmails,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const TOKEN = 'reminder_pay_link_token_0123456789abcdefghij';

let firm: Firm;
let owner: Actor;
let previousKillSwitch: string | undefined;

beforeEach(async () => {
  // backend/.env turns every reminder email off for the suite; this file is
  // about what a reminder says, so it has to be allowed to send.
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  resetEmails();
  firm = await createFirm({ name: 'Reminder LLP' });
  owner = await ownerOf(firm.id);
});

afterEach(() => {
  process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

async function requestedInvoice(payLinkToken: string | null) {
  const client = await createPersonClient(firm.id, { email: 'payer@example.test' });
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });
  const res = await testPool.query(
    `update invoices
        set due_date = current_date - 10, stripe_payment_requested = true, stripe_payment_status = 'pending',
            pay_link_token = $2, billing_emails = '{payer@example.test}', billing_snapshot_at = now()
      where id = $1`,
    [invoice.id, payLinkToken],
  );
  expect(res.rowCount).toBe(1);
  return { clientId: client.id, invoiceId: invoice.id };
}

async function sendReminder(clientId: string, invoiceId: string) {
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}/send-reminder`);
  await drainEvents();
  // A refused send would leave the outbox empty and every assertion vacuous.
  expect(res.status).toBe(200);
  const [email] = sentEmails().filter((e) => (Array.isArray(e.to) ? e.to : [e.to]).includes('payer@example.test'));
  expect(email).toBeDefined();
  return email;
}

it('links to the secure payment link when the request has one', async () => {
  const { clientId, invoiceId } = await requestedInvoice(TOKEN);

  const email = await sendReminder(clientId, invoiceId);

  expect(email.html).toContain(`${FRONTEND_URL}/pay/${TOKEN}`);
  expect(email.html).not.toContain('/client/lawfirm/');
});

it('links to the client portal when the request has no pay link', async () => {
  const { clientId, invoiceId } = await requestedInvoice(null);

  const email = await sendReminder(clientId, invoiceId);

  expect(email.html).toContain(`${FRONTEND_URL}/client/lawfirm/${firm.id}/billing`);
  expect(email.html).not.toContain('/pay/');
});

/* ------------------------------------------------------------------ */
/*  A payment plan with a link open for one figure                      */
/* ------------------------------------------------------------------ */

const PORTAL = () => `${FRONTEND_URL}/client/lawfirm/${firm.id}/billing`;

/**
 * A $1,500.00 invoice on a three-part plan with $400.00 paid:
 *   inst-a  $400.00  paid
 *   inst-b  $500.00  pending, due in 3 days (installment 2, inside the 5-day window)
 *   inst-c  $600.00  pending, due in 33 days (installment 3, outside it)
 * so the balance is $1,100.00. Every figure differs, so a reminder that quotes
 * the wrong one renders a different dollar string. `extraPaidCents` is paid
 * outside the plan, which lowers the balance without settling a row.
 */
async function planInvoice(link: { installmentId: string | null }, opts: { overdue?: boolean; extraPaidCents?: number } = {}) {
  const client = await createPersonClient(firm.id, { email: 'payer@example.test' });
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 1500_00 });
  const res = await testPool.query(
    `update invoices
        set due_date = current_date + $3::int, invoice_name = 'INV-PLAN', payment_plan_enabled = true,
            plan_pre_reminder_days = 5, amount_paid_cents = $4, status = 'partially_paid',
            stripe_payment_requested = true, stripe_payment_status = 'pending',
            pay_link_token = $2, pay_link_installment_id = $5,
            billing_emails = '{payer@example.test}', billing_snapshot_at = now()
      where id = $1`,
    [invoice.id, TOKEN, opts.overdue ? -10 : 33, 400_00 + (opts.extraPaidCents ?? 0), link.installmentId],
  );
  expect(res.rowCount).toBe(1);
  const rows = [
    { id: 'inst-a', cents: 400_00, status: 'paid', dueIn: -30 },
    { id: 'inst-b', cents: 500_00, status: 'pending', dueIn: 3 },
    { id: 'inst-c', cents: 600_00, status: 'pending', dueIn: 33 },
  ];
  for (const [i, row] of rows.entries()) {
    const inserted = await testPool.query(
      `insert into invoice_expected_payments
         (invoice_id, law_firm_id, sort_order, installment_id, due_date, amount_cents, status)
       values ($1, $2, $3, $4, current_date + $5::int, $6, $7)`,
      [invoice.id, firm.id, i, row.id, row.dueIn, row.cents, row.status],
    );
    expect(inserted.rowCount).toBe(1);
  }
  return { clientId: client.id, invoiceId: invoice.id };
}

/** Run the firm-wide pass and return the one email it sent the client. */
async function runSweep() {
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/billing/invoices/send-reminders`);
  await drainEvents();
  expect(res.status).toBe(200);
  const emails = sentEmails().filter((e) => (Array.isArray(e.to) ? e.to : [e.to]).includes('payer@example.test'));
  // Exactly one reminder is due in each fixture, so this pins which one went.
  expect(emails).toHaveLength(1);
  return emails[0];
}

describe('a reminder carries the pay link only when it asks for what the link charges', () => {
  it('links the portal from an installment reminder when the link asks for a different installment', async () => {
    await planInvoice({ installmentId: 'inst-c' });

    const email = await runSweep();

    expect(email.subject).toContain('(installment 2)');
    expect(email.subject).toContain('($500.00 due)');
    expect(email.html).toContain(PORTAL());
    expect(email.html).not.toContain('/pay/');
  });

  it('carries the link on the linked installment reminder and quotes what the link charges', async () => {
    // $700.00 paid outside the plan leaves a $400.00 balance, so the link for
    // the $500.00 row charges $400.00, and the reminder has to say so.
    await planInvoice({ installmentId: 'inst-b' }, { extraPaidCents: 700_00 });

    const email = await runSweep();

    expect(email.subject).toContain('(installment 2)');
    expect(email.subject).toContain('($400.00 due)');
    expect(email.html).toContain(`${FRONTEND_URL}/pay/${TOKEN}`);
    expect(email.html).not.toContain('/client/lawfirm/');
  });

  it('links the portal from an installment reminder when the link asks for the full balance', async () => {
    await planInvoice({ installmentId: null });

    const email = await runSweep();

    expect(email.subject).toContain('(installment 2)');
    expect(email.subject).toContain('($500.00 due)');
    expect(email.html).toContain(PORTAL());
    expect(email.html).not.toContain('/pay/');
  });

  it('links the portal from an overdue full-balance reminder when the link asks for one installment', async () => {
    const enabled = await testPool.query(
      `update law_firms set settings = settings || '{"invoiceReminderEnabled": true}'::jsonb where id = $1`,
      [firm.id],
    );
    expect(enabled.rowCount).toBe(1);
    await planInvoice({ installmentId: 'inst-b' }, { overdue: true });

    const email = await runSweep();

    expect(email.subject).toContain('is past due ($1,100.00 outstanding)');
    expect(email.html).toContain(PORTAL());
    expect(email.html).not.toContain('/pay/');
  });

  it('carries the link on an overdue reminder when the link asks for the full balance', async () => {
    const enabled = await testPool.query(
      `update law_firms set settings = settings || '{"invoiceReminderEnabled": true}'::jsonb where id = $1`,
      [firm.id],
    );
    expect(enabled.rowCount).toBe(1);
    await planInvoice({ installmentId: null }, { overdue: true });

    const email = await runSweep();

    expect(email.subject).toContain('is past due ($1,100.00 outstanding)');
    expect(email.html).toContain(`${FRONTEND_URL}/pay/${TOKEN}`);
  });

  it('links the portal from a manual reminder for the next installment when the link asks for a later one', async () => {
    const { clientId, invoiceId } = await planInvoice({ installmentId: 'inst-c' });

    const email = await sendReminder(clientId, invoiceId);

    expect(email.subject).toContain('($500.00 due)');
    expect(email.html).toContain(PORTAL());
    expect(email.html).not.toContain('/pay/');
  });

  it('carries the link on a manual reminder for the linked installment, priced from the link', async () => {
    const { clientId, invoiceId } = await planInvoice({ installmentId: 'inst-b' }, { extraPaidCents: 700_00 });

    const email = await sendReminder(clientId, invoiceId);

    expect(email.subject).toContain('($400.00 due)');
    expect(email.html).toContain(`${FRONTEND_URL}/pay/${TOKEN}`);
  });
});

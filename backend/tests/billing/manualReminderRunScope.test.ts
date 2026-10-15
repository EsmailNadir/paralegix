/**
 * The firm-wide manual reminder run sends only what the caller could send one
 * invoice at a time.
 *
 * The per-invoice send-reminder routes need matter membership on a matter
 * invoice. The firm-wide POST .../send-reminders must apply the same wall: a
 * member reaches the matters they are on, an owner who is on none reaches no
 * matter invoice, and every client-context invoice of the firm is open to anyone
 * holding billing.manageInvoices. The cron entry point (no user) still covers
 * everything.
 *
 * RED IF: the manual run mails an invoice on a matter the caller is not on,
 * skips one on a matter the caller is on, skips a client-context invoice, or
 * the no-user cron pass stops covering every matter.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  memberWith,
  recipientsOf,
  resetEmails,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';
import { installEmailCapture } from '../support/email.mock';
import { sendOverdueReminders } from '../../src/modules/billing/invoices/invoiceReminders.service';

installEmailCapture();

const MATTER_A_EMAIL = 'matter-a@client.test';
const MATTER_B_EMAIL = 'matter-b@client.test';
const CLIENT_CTX_EMAIL = 'client-context@client.test';

let firm: Firm;
let owner: Actor;
let member: Actor;
let previousKillSwitch: string | undefined;

async function overdueMatterInvoice(matterId: string, clientId: string, email: string) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, client_id, context_type, invoice_number, invoice_name,
        status, total_cents, invoice_date, due_date, client_email, client_name)
     values ($1, $2, $3, $4, 'matter', $5, $5, 'overdue', 50000, current_date - 40, current_date - 10, $6, 'Matter Client')`,
    [id, firm.id, matterId, clientId, `INV-${id.slice(0, 8)}`, email],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

const runManual = (actor: Actor) =>
  actor.api.post(`/api/lawfirms/${firm.id}/billing/invoices/send-reminders`);

beforeEach(async () => {
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  resetEmails();
  firm = await createFirm({ name: 'Manual Run LLP' });
  await testPool.query(
    `update law_firms set settings = '{"invoiceReminderEnabled": true, "invoiceReminderDays": [7]}' where id = $1`,
    [firm.id],
  );
  owner = await ownerOf(firm.id);
  member = await memberWith(firm.id, ['billing.manageInvoices']);

  const clientA = await createPersonClient(firm.id, { name: 'Client A', email: MATTER_A_EMAIL });
  const clientB = await createPersonClient(firm.id, { name: 'Client B', email: MATTER_B_EMAIL });
  const clientCtx = await createPersonClient(firm.id, { name: 'Client Ctx', email: CLIENT_CTX_EMAIL });
  // The member is on matter A only; the owner is on neither.
  const matterA = await seedMatter(firm.id, { memberUids: [member.uid], clientIds: [clientA.id] });
  const matterB = await seedMatter(firm.id, { memberUids: [], clientIds: [clientB.id] });
  await overdueMatterInvoice(matterA, clientA.id, MATTER_A_EMAIL);
  await overdueMatterInvoice(matterB, clientB.id, MATTER_B_EMAIL);
  const ctxInvoice = await createInvoice(firm.id, clientCtx.id, { totalCents: 50_000 });
  await testPool.query('update invoices set due_date = current_date - 10, client_email = $2 where id = $1',
    [ctxInvoice.id, CLIENT_CTX_EMAIL]);
});

afterEach(() => {
  if (previousKillSwitch === undefined) delete process.env.DISABLE_ALL_REMINDER_EMAILS;
  else process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

it('lets the cron pass (no user) remind every overdue invoice in the firm (control)', async () => {
  const stats = await sendOverdueReminders(firm.id);

  expect(stats.sent).toBe(3);
  expect(recipientsOf(/./).sort()).toEqual([MATTER_A_EMAIL, MATTER_B_EMAIL, CLIENT_CTX_EMAIL].sort());
});

it('reminds a member only on the matter they are on, plus client-context invoices', async () => {
  const res = await runManual(member);

  expect(res.status).toBe(200);
  expect(res.body.sent).toBe(2);
  expect(recipientsOf(/./).sort()).toEqual([MATTER_A_EMAIL, CLIENT_CTX_EMAIL].sort());
});

it('reminds a firm owner who is on no matter only for client-context invoices', async () => {
  const res = await runManual(owner);

  expect(res.status).toBe(200);
  expect(res.body.sent).toBe(1);
  expect(recipientsOf(/./)).toEqual([CLIENT_CTX_EMAIL]);
});

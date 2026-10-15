/**
 * Voiding an invoice: cancelling a bill without destroying the record.
 *
 * `deleteInvoice` refuses an invoice the trust ledger points at and tells the
 * firm to void it instead. Nothing implemented that, so a firm that billed from
 * trust and then had to cancel had no path at all, and the bill went on being
 * chased: reminders, the late-fee sweep and accounts receivable all read it.
 *
 * The cases below are the ones that make a void mean anything:
 *
 *   IT MUST SURVIVE THE NEXT WRITE. `deriveInvoiceStatus` computes the status
 *   from the live amounts, and `_applyUpdateLocked` persists what it computed. A
 *   voided invoice still has a balance on paper, so without a terminal check the
 *   very next edit would derive 'outstanding' and write it back over the void.
 *
 *   IT MUST LEAVE COLLECTIONS. Reminders and the late-fee sweep both read
 *   `findUnpaidByDue`, and the firm's overdue bucket reads `isPastDue`. A
 *   voided invoice keeps its balance forever, so any of those still counting it
 *   would chase a client for a bill the firm cancelled.
 *
 *   IT MUST REFUSE A PAID INVOICE. Money collected against a bill is a second
 *   record: a trust withdrawal, or a charge at Stripe. Removing the payment
 *   reverses that half properly; voiding on top of it would leave the firm
 *   holding client money against a bill that no longer exists.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  sentEmails,
  resetEmails,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';
import { sendOverdueReminders } from '../../src/modules/billing/invoices/invoiceReminders.service';

const CLIENT_EMAIL = 'void@example.test';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const onInvoice = (suffix = '') => `${B()}/${invoiceId}${suffix}`;

const storedStatus = async (id = invoiceId) => {
  const { rows } = await testPool.query('select status from invoices where id = $1', [id]);
  return rows[0].status as string;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Void Client', email: CLIENT_EMAIL });

  const created = await owner.api.post(B()).send({
    invoiceName: 'To be cancelled',
    invoiceDate: '2026-03-01',
    // Comfortably past, so every collections path would pick it up.
    dueDate: '2026-03-31',
    totalAmount: 1000,
    flatFeesAmount: 1000,
    flatFees: [{ description: 'Fixed fee', amount: 1000 }],
  });
  expect(created.status).toBe(201);
  invoiceId = created.body.invoice.id;
  await drainEvents();
});

describe('voiding an unpaid invoice', () => {
  it('marks it voided and says so', async () => {
    const res = await owner.api.post(onInvoice('/void'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('voided');
    expect(await storedStatus()).toBe('voided');
  });

  it('keeps the invoice and its line items rather than deleting anything', async () => {
    await owner.api.post(onInvoice('/void'));

    const { rows } = await testPool.query(
      'select count(*)::int n from invoice_line_items where invoice_id = $1', [invoiceId],
    );
    // The whole point of void over delete: the record survives, with its links.
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('refuses to void the same invoice twice', async () => {
    expect((await owner.api.post(onInvoice('/void'))).status).toBe(200);

    const res = await owner.api.post(onInvoice('/void'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been voided/i);
  });

  it('does not let one firm void another firm invoice', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/billing/invoices/client/${client.id}/${invoiceId}/void`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await storedStatus()).not.toBe('voided');
  });
});

describe('the void survives what happens next', () => {
  it('is not overwritten by the status writeback on the next edit', async () => {
    await owner.api.post(onInvoice('/void'));

    // Any edit re-derives the status and persists it. A voided invoice still has
    // a balance, so a derivation that read only the amounts would compute
    // 'outstanding' here and quietly un-cancel the bill.
    const renamed = await owner.api.patch(onInvoice('/details')).send({ invoiceName: 'Renamed after void' });
    expect(renamed.status).toBe(200);

    expect(await storedStatus()).toBe('voided');
    expect((await owner.api.get(B())).body.invoices.find((i: any) => i.id === invoiceId).status)
      .toBe('voided');
  });
});

describe('a voided invoice leaves collections', () => {
  let previousKillSwitch: string | undefined;

  beforeEach(async () => {
    // The kill switch sits in the developer `.env` this suite loads; CI has none.
    previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
    process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
    await testPool.query(
      `update law_firms
          set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{invoiceReminderEnabled}', 'true'::jsonb, true)
        where id = $1`,
      [firm.id],
    );
    resetEmails();
  });

  afterEach(() => {
    if (previousKillSwitch === undefined) delete process.env.DISABLE_ALL_REMINDER_EMAILS;
    else process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
  });

  it('is not chased by the overdue reminder pass', async () => {
    // Control: the invoice is months past due and unpaid, and the pass mails it.
    const before = await sendOverdueReminders(firm.id);
    expect(before.sent).toBe(1);
    expect(sentEmails()).toHaveLength(1);

    // Forget that reminder so the second pass is decided by the void alone, not
    // by the cadence already having fired.
    await testPool.query('delete from reminders where invoice_id = $1', [invoiceId]);
    resetEmails();
    await owner.api.post(onInvoice('/void'));

    const stats = await sendOverdueReminders(firm.id);

    expect(stats.sent).toBe(0);
    expect(sentEmails()).toHaveLength(0);
  });

  it('drops out of the firm overdue bucket', async () => {
    const overdueCount = async () => {
      const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/workbench`);
      expect(res.status).toBe(200);
      return res.body.collections.overdueCount as number;
    };
    expect(await overdueCount()).toBe(1);

    await owner.api.post(onInvoice('/void'));

    expect(await overdueCount()).toBe(0);
  });

  it('is refused a late fee, while a live overdue invoice is charged one', async () => {
    // Merge into `billing` rather than jsonb_set the nested path: jsonb_set only
    // creates the LAST key, so on a firm with no `billing` object the old seed
    // wrote nothing and the 400 below came from "late fees are not enabled".
    await testPool.query(
      `update law_firms
          set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{billing}',
                coalesce(settings -> 'billing', '{}'::jsonb)
                || '{"lateFee": {"enabled": true, "flatAmount": 25, "percent": 0, "graceDays": 0, "autoApply": false}}'::jsonb,
                true)
        where id = $1`,
      [firm.id],
    );

    // Control: the same settings charge a live overdue invoice.
    const live = await owner.api.post(B()).send({
      invoiceName: 'Live and late', invoiceDate: '2026-03-01', dueDate: '2026-03-31',
      totalAmount: 1000, flatFeesAmount: 1000, flatFees: [{ description: 'Fixed fee', amount: 1000 }],
    });
    const charged = await owner.api.post(`${B()}/${live.body.invoice.id}/late-fee`);
    expect(charged.status).toBe(200);
    expect(charged.body.lateFeeAmount).toBe(25);

    await owner.api.post(onInvoice('/void'));
    const res = await owner.api.post(onInvoice('/late-fee'));

    // Charging a penalty on a cancelled bill is the worst of the collections
    // paths, because it grows the total the client is shown. A 400 like every
    // other late-fee skip: the cron sweep shares this rule and must skip, not throw.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/voided/i);
    const { rows } = await testPool.query('select total_cents from invoices where id = $1', [invoiceId]);
    expect(Number(rows[0].total_cents)).toBe(100_000);
  });
});

describe('voiding an invoice that carries payments', () => {
  it('refuses, and names removing the payment as the way through', async () => {
    const paid = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 400 });
    expect(paid.status).toBe(200);

    const res = await owner.api.post(onInvoice('/void'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/remove them first/i);
    expect(await storedStatus()).not.toBe('voided');
  });

  it('voids once the payment is removed', async () => {
    await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 400 });
    const removed = await owner.api.delete(onInvoice('/payment?paymentIndex=0'));
    expect(removed.status).toBe(200);

    // Remove, then void: the order that keeps the money record and the bill
    // record consistent with each other.
    expect((await owner.api.post(onInvoice('/void'))).status).toBe(200);
    expect(await storedStatus()).toBe('voided');
  });
});

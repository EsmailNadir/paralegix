/**
 * Nothing changes the money on a voided invoice.
 *
 * Voiding writes only the status. Every money route used to read the balance
 * and carry on, so a cancelled bill could take a payment (and be un-cancelled
 * by the status writeback), grow a credit note, a new total or a payment plan,
 * and be emailed or reminded to the client as if it were owed.
 *
 * RED IF: any listed route stops calling assertInvoiceNotVoided inside its
 * locked transaction. The route then answers 2xx or a different 4xx, and the
 * money snapshot moves.
 */
import {
  testPool, createFirm, createPersonClient, createTrustDeposit, ownerOf, drainEvents,
  sentEmails, resetEmails, type Actor, type ClientRecord, type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let invoiceId: string;
let creditNoteId: string;

// backend/.env switches reminder emails off for the whole suite. The reminder
// route short-circuits on it before it reads the invoice, so leaving it on would
// let 'send a reminder' pass without ever reaching the void check.
let previousKillSwitch: string | undefined;
beforeAll(() => {
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
});
afterAll(() => {
  if (previousKillSwitch === undefined) delete process.env.DISABLE_ALL_REMINDER_EMAILS;
  else process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const onInvoice = (suffix = '', id = invoiceId) => `${B()}/${id}${suffix}`;

async function issue(name: string) {
  const res = await owner.api.post(B()).send({
    invoiceName: name, invoiceDate: '2026-03-01', dueDate: '2026-03-31',
    totalAmount: 1000, flatFeesAmount: 1000, flatFees: [{ description: 'Fixed fee', amount: 1000 }],
  });
  expect(res.status).toBe(201);
  await drainEvents();
  return res.body.invoice.id as string;
}

/** Every stored money figure on the invoice and its children, for a before/after compare. */
async function moneySnapshot(id = invoiceId) {
  const { rows } = await testPool.query(
    `select i.status, i.total_cents, i.amount_paid_cents, i.total_written_off_cents, i.is_paid,
            i.payment_plan_enabled,
            (select count(*)::int from invoice_payments p where p.invoice_id = i.id) as payments,
            (select count(*)::int from invoice_adjustments a where a.invoice_id = i.id) as adjustments,
            (select coalesce(sum(e.amount_cents), 0)::bigint from invoice_expected_payments e where e.invoice_id = i.id) as scheduled_cents,
            (select coalesce(sum(li.amount_cents), 0)::bigint from invoice_line_items li where li.invoice_id = i.id) as line_cents
       from invoices i where i.id = $1`,
    [id],
  );
  return rows[0];
}

beforeEach(async () => {
  firm = await createFirm({ planId: 'enterprise' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Void Client', email: 'void@example.test' });
  invoiceId = await issue('To be cancelled');

  // State the plan and credit-note routes act on, set up while the invoice is live.
  const credit = await owner.api.post(onInvoice('/credit-note')).send({ amount: 50, type: 'write_off', description: 'Goodwill' });
  expect(credit.status).toBe(200);
  creditNoteId = credit.body.invoice.creditNotes[0].id;
  const plan = await owner.api.post(onInvoice('/payment-plan'))
    .send({ installmentAmount: 475, frequencyDays: 30, planStartDate: '2026-11-01' });
  expect(plan.status).toBe(200);

  expect((await owner.api.post(onInvoice('/void'))).status).toBe(200);
  await drainEvents();
  resetEmails();
});

const refused: Array<[string, () => Promise<any>]> = [
  ['record a payment', () => owner.api.put(onInvoice('/payment')).send({ paymentAmount: 100 })],
  ['mark it paid', () => owner.api.put(onInvoice('/payment')).send({ isPaid: true })],
  ['edit a payment', () => owner.api.patch(onInvoice('/payment')).send({ paymentIndex: 0, amount: 50 })],
  ['add a credit note', () => owner.api.post(onInvoice('/credit-note')).send({ amount: 25, type: 'discount' })],
  ['remove a credit note', () => owner.api.delete(onInvoice(`/credit-note?creditNoteId=${creditNoteId}`))],
  ['add an amount', () => owner.api.patch(onInvoice('/add-amount')).send({ amount: 75, note: 'Extra' })],
  ['replace its line items', () => owner.api.patch(onInvoice('/line-items'))
    .send({ flatFees: [{ description: 'Fixed fee', amount: 2000 }] })],
  ['set a payment plan', () => owner.api.post(onInvoice('/payment-plan'))
    .send({ installmentAmount: 100, frequencyDays: 30, planStartDate: '2026-12-01' })],
  ['remove the payment plan', () => owner.api.delete(onInvoice('/payment-plan'))],
  ['edit an installment', () => owner.api.patch(onInvoice('/payment-plan/installment/0')).send({ amount: 300 })],
  ['replace the schedule', () => owner.api.patch(onInvoice('/payment-plan/schedule'))
    .send({ installments: [{ dueDate: '2026-12-01', amount: 950 }] })],
  ['un-pay an installment', () => owner.api.delete(onInvoice('/payment-plan/installment/0/payment'))],
  ['send a reminder', () => owner.api.post(onInvoice('/send-reminder'))],
  ['email it to the client', () => owner.api.post(onInvoice('/send-email')).send({ recipientEmail: 'void@example.test' })],
];

describe('a voided invoice refuses', () => {
  it.each(refused)('to %s, and nothing moves', async (_label, call) => {
    const before = await moneySnapshot();
    expect(before.status).toBe('voided');

    const res = await call();
    await drainEvents();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/voided/i);
    expect(await moneySnapshot()).toEqual(before);
    expect(sentEmails()).toHaveLength(0);
  });
});

describe('a live invoice still accepts the same calls', () => {
  // The positive half: proves the request shapes above are valid, so the 409s
  // are the void talking and not a malformed body.
  it('records a payment and adds an amount', async () => {
    const live = await issue('Still live');
    expect((await owner.api.put(onInvoice('/payment', live)).send({ paymentAmount: 100 })).status).toBe(200);
    expect((await owner.api.patch(onInvoice('/add-amount', live)).send({ amount: 75, note: 'Extra' })).status).toBe(200);
    expect(await moneySnapshot(live)).toMatchObject({ amount_paid_cents: '10000', total_cents: '107500' });
  });

  it('can still be renamed after the void', async () => {
    const res = await owner.api.patch(onInvoice('/details')).send({ invoiceName: 'Renamed' });
    expect(res.status).toBe(200);
    expect((await moneySnapshot()).status).toBe('voided');
  });
});

describe('paying a voided invoice from trust', () => {
  it('refuses before any trust withdrawal is written', async () => {
    const { accountId } = await createTrustDeposit(firm.id, client.id, { amountCents: 500_000 });
    const withdrawals = async () => (await testPool.query(
      `select count(*)::int as n from trust_transactions where law_firm_id = $1 and type = 'withdrawal'`, [firm.id],
    )).rows[0].n;

    // Control: the identical request on a live invoice writes exactly one withdrawal.
    const live = await issue('Live trust bill');
    const ok = await owner.api.put(onInvoice('/payment', live))
      .send({ paymentAmount: 100, paymentSource: 'trust', trustAccountId: accountId });
    expect(ok.status).toBe(200);
    expect(await withdrawals()).toBe(1);

    const res = await owner.api.put(onInvoice('/payment'))
      .send({ paymentAmount: 100, paymentSource: 'trust', trustAccountId: accountId });

    expect(res.status).toBe(409);
    expect(await withdrawals()).toBe(1);
    const { rows } = await testPool.query(
      'select count(*)::int as n from trust_transactions where invoice_id = $1', [invoiceId],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('another firm', () => {
  it('cannot reach the voided invoice at all', async () => {
    const other = await createFirm();
    const otherOwner = await ownerOf(other.id);
    const before = await moneySnapshot();
    const res = await otherOwner.api
      .put(`/api/lawfirms/${other.id}/billing/invoices/client/${client.id}/${invoiceId}/payment`)
      .send({ paymentAmount: 100 });
    expect(res.status).toBe(404);
    expect(await moneySnapshot()).toEqual(before);
  });
});

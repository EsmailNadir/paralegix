/**
 * Paying an invoice from trust, and every way the payment and its ledger
 * withdrawal can come apart: refused payments, reversals, and the guards on
 * voiding or deleting an invoice that a withdrawal points at.
 *
 * The rule under test is that an invoice payment and the trust withdrawal behind
 * it live or die together. Each spec asserts the invoice side from
 * `invoice_payments` and the ledger side from `trust_transactions`, never one
 * from the other.
 */
import {
  testPool,
  drainEvents,
  sentEmails,
  resetEmails,
  createTrustDeposit,
  createPersonClient,
  createInvoice,
} from '../../support/setupInProcess';
import {
  seedWorld,
  invoiceRow,
  paymentRows,
  assertInvoiceInvariants,
  type World,
} from './lifecycleKit';

const bus = require('../../../src/shared/events/eventBus');

let w: World;
let accountId: string;
let emitted: Array<{ name: string; payload: any }> = [];
let emitSpy: jest.SpyInstance;

beforeEach(async () => {
  w = await seedWorld(100_000);
  ({ accountId } = await createTrustDeposit(w.firm.id, w.clientId, { amountCents: 500_000 }));
  emitted = [];
  const realEmit = bus.emit.bind(bus);
  emitSpy = jest.spyOn(bus, 'emit').mockImplementation((...args: any[]) => {
    emitted.push({ name: args[0], payload: args[1] });
    return realEmit(...args);
  });
  resetEmails();
});

afterEach(() => emitSpy.mockRestore());

const payTrust = (dollars: number, extra: Record<string, unknown> = {}, inv = w.inv, account = accountId) =>
  w.owner.api.put(`${inv}/payment`).send({ paymentAmount: dollars, paymentSource: 'trust', trustAccountId: account, ...extra });

const received = () => emitted.filter((e) => e.name === 'invoice.paymentReceived');
const receipts = () => sentEmails().filter((e) => /received your payment/i.test(e.text || ''));

async function withdrawals(lawFirmId = w.firm.id) {
  const { rows } = await testPool.query(
    `select id, amount_cents, status, invoice_id, txn_date, reverses_transaction_id
       from trust_transactions where law_firm_id = $1 and type = 'withdrawal' order by created_at, id`,
    [lawFirmId],
  );
  return rows.map((r: any) => ({ ...r, cents: Number(r.amount_cents) }));
}

async function clientTrustBalance(clientId = w.clientId) {
  const { rows } = await testPool.query(
    `select coalesce(sum(case when status = 'completed'
              then (case when type = 'deposit' then amount_cents else -amount_cents end) else 0 end), 0)::bigint as b
       from trust_transactions where law_firm_id = $1 and client_id = $2`,
    [w.firm.id, clientId],
  );
  return Number(rows[0].b);
}

describe('refused trust payments leave nothing behind', () => {
  it('insufficient client trust balance: 400, no payment row, no withdrawal, no event, no receipt', async () => {
    await testPool.query('update invoices set total_cents = 900000 where id = $1', [w.invoiceId]);

    const res = await payTrust(5_000.01);
    await drainEvents();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_TRUST_BALANCE');
    expect(await paymentRows(w.invoiceId)).toEqual([]);
    expect(await withdrawals()).toEqual([]);
    expect(await clientTrustBalance()).toBe(500_000);
    expect(received()).toHaveLength(0);
    expect(receipts()).toHaveLength(0);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a trust account that holds only ANOTHER client\'s money cannot pay this client\'s invoice', async () => {
    const other = await createPersonClient(w.firm.id, { name: 'Other Client' });
    const { accountId: otherAccount } = await createTrustDeposit(w.firm.id, other.id, { amountCents: 900_000 });

    const res = await payTrust(100, {}, w.inv, otherAccount);
    await drainEvents();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_TRUST_BALANCE');
    expect(await withdrawals()).toEqual([]);
    expect(await clientTrustBalance(other.id)).toBe(900_000);
    expect(await paymentRows(w.invoiceId)).toEqual([]);
    expect(received()).toHaveLength(0);
  });

  it('a firm on a plan without trust accounting cannot move trust money through the payment form', async () => {
    const starter = await seedWorld(100_000, 'starter');
    // Seed a deposit straight into the starter firm's ledger so the refusal is the plan gate, not a missing balance.
    const { accountId: starterAccount } = await createTrustDeposit(starter.firm.id, starter.clientId, { amountCents: 500_000 });

    const res = await starter.owner.api.put(`${starter.inv}/payment`)
      .send({ paymentAmount: 100, paymentSource: 'trust', trustAccountId: starterAccount });

    expect(res.status).toBe(403);
    expect(await paymentRows(starter.invoiceId)).toEqual([]);
    expect(await withdrawals(starter.firm.id)).toEqual([]);
  });

});

describe('a trust-funded payment and its withdrawal move together', () => {
  it('the payment row carries the withdrawal id and the withdrawal carries the invoice id and the payment day', async () => {
    const res = await payTrust(250.5, { paidDate: '2026-01-20' });
    expect(res.status).toBe(200);

    const { payments } = await assertInvoiceInvariants(w.invoiceId);
    const rows = await withdrawals();
    expect(rows).toHaveLength(1);
    expect(payments[0].trust_transaction_id).toBe(rows[0].id);
    expect(rows[0].invoice_id).toBe(w.invoiceId);
    expect(rows[0].cents).toBe(25_050);
    expect(rows[0].txn_date).toBe('2026-01-20');
    expect(await clientTrustBalance()).toBe(500_000 - 25_050);
  });

  it('deleting the payment restores the balance exactly once and a second delete is refused', async () => {
    await payTrust(400);

    const first = await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`);
    await drainEvents();
    const second = await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    const rows = await withdrawals();
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.status === 'void')).toBe(true);
    expect(await clientTrustBalance()).toBe(500_000);
    const book = await testPool.query('select book_balance_cents from trust_accounts where id = $1', [accountId]);
    expect(Number(book.rows[0].book_balance_cents)).toBe(500_000);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a trust payment cannot have its amount edited, but its note can change, and the withdrawal is untouched', async () => {
    await payTrust(400);
    const [before] = await withdrawals();

    const amount = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, amount: 100 });
    const note = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, note: 'retainer draw' });

    expect(amount.status).toBe(400);
    expect(note.status).toBe(200);
    const [after] = await withdrawals();
    expect(after).toEqual(before);
    expect((await paymentRows(w.invoiceId))[0].cents).toBe(40_000);
    await assertInvoiceInvariants(w.invoiceId);
  });

});

describe('voiding or deleting an invoice a withdrawal points at', () => {
  it('void is refused while the trust payment stands and succeeds once the payment is removed', async () => {
    await payTrust(400);

    const refused = await w.owner.api.post(`${w.inv}/void`).send({});

    expect(refused.status).toBe(409);
    expect((await invoiceRow(w.invoiceId)).status).toBe('partially_paid');
    expect((await withdrawals())[0].status).toBe('completed');
    expect(await clientTrustBalance()).toBe(500_000 - 40_000);

    expect((await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`)).status).toBe(200);
    await drainEvents();
    const ok = await w.owner.api.post(`${w.inv}/void`).send({});
    expect(ok.status).toBe(200);
    expect((await invoiceRow(w.invoiceId)).status).toBe('voided');
    expect(await clientTrustBalance()).toBe(500_000);
  });

  it('delete is refused while a live withdrawal references the invoice, and the withdrawal stays attributed', async () => {
    await payTrust(400);

    const res = await w.owner.api.delete(w.inv);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/trust/i);
    expect((await withdrawals())[0].invoice_id).toBe(w.invoiceId);
    expect((await invoiceRow(w.invoiceId)).status).toBe('partially_paid');
  });

  it('delete stays refused after the payment is removed, because the voided entries are permanent', async () => {
    await payTrust(400);
    expect((await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`)).status).toBe(200);
    await drainEvents();

    const res = await w.owner.api.delete(w.inv);

    expect(res.status).toBe(409);
    const rows = await withdrawals();
    expect(rows.every((r: any) => r.invoice_id === w.invoiceId || r.reverses_transaction_id)).toBe(true);
    expect((await invoiceRow(w.invoiceId)).status).toBe('outstanding');
  });

  it('another invoice for the same client is unaffected by a deleted trust payment on this one', async () => {
    const second = await createInvoice(w.firm.id, w.clientId, { totalCents: 50_000 });
    const secondInv = `${w.base}/${second.id}`;
    expect((await payTrust(100, {}, secondInv)).status).toBe(200);
    expect((await payTrust(400)).status).toBe(200);

    expect((await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`)).status).toBe(200);
    await drainEvents();

    const rows = await withdrawals();
    const live = rows.filter((r: any) => r.status === 'completed');
    expect(live.map((r: any) => ({ cents: r.cents, invoice: r.invoice_id }))).toEqual([
      { cents: 10_000, invoice: second.id },
    ]);
    expect(await clientTrustBalance()).toBe(500_000 - 10_000);
    await assertInvoiceInvariants(second.id);
    await assertInvoiceInvariants(w.invoiceId);
  });
});

describe('a mixed manual and trust history', () => {
  it('resetting to unpaid reverses only the trust withdrawals and zeroes the invoice', async () => {
    expect((await payTrust(100)).status).toBe(200);
    expect((await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 200, paymentSource: 'external' })).status).toBe(200);
    expect((await payTrust(300)).status).toBe(200);
    await drainEvents();
    expect(await clientTrustBalance()).toBe(500_000 - 40_000);

    const res = await w.owner.api.put(`${w.inv}/payment`).send({ isPaid: false });
    await drainEvents();

    expect(res.status).toBe(200);
    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments).toEqual([]);
    expect(row.status).toBe('outstanding');
    expect(await clientTrustBalance()).toBe(500_000);
    const rows = await withdrawals();
    expect(rows.filter((r: any) => !r.reverses_transaction_id).map((r: any) => r.cents).sort((a: number, b: number) => a - b))
      .toEqual([10_000, 30_000]);
    expect(rows.every((r: any) => r.status === 'void')).toBe(true);
  });

  it('deleting the manual payment in the middle leaves the trust payment and its withdrawal in place', async () => {
    expect((await payTrust(100)).status).toBe(200);
    expect((await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 200 })).status).toBe(200);
    expect((await payTrust(300)).status).toBe(200);

    expect((await w.owner.api.delete(`${w.inv}/payment?paymentIndex=1`)).status).toBe(200);
    await drainEvents();

    const { payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => [p.cents, p.payment_source])).toEqual([[10_000, 'trust'], [30_000, 'trust']]);
    expect((await withdrawals()).filter((r: any) => r.status === 'completed')).toHaveLength(2);
    expect(await clientTrustBalance()).toBe(500_000 - 40_000);
  });
});

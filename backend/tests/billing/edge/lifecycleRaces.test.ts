/**
 * Concurrent invoice mutations, proved to overlap inside the row-locked
 * transaction before either is allowed to continue, then judged by the money
 * invariants recomputed from Postgres.
 *
 * Every spec holds both requests at `runInvoiceTxn` (see `gate.ts`), so the
 * order they run in is the only thing left open. The assertions are therefore
 * about what must hold in EVERY order: paid plus written off never passes the
 * total, the paid figure equals the payment rows, a voided invoice carries no
 * payment, and exactly one of two competing writes wins.
 */
import { testPool, drainEvents, sentEmails, resetEmails, createTrustDeposit } from '../../support/setupInProcess';
import { gateMethod, type Gate } from '../../support/gate';
import {
  seedWorld,
  invoiceRow,
  paymentRows,
  assertInvoiceInvariants,
  type World,
} from './lifecycleKit';

const bus = require('../../../src/shared/events/eventBus');
const invoicesRepo = require('../../../src/modules/billing/invoices/invoices.repository');

let w: World;
let gate: Gate | null = null;
let emitted: Array<{ name: string; payload: any }> = [];
let emitSpy: jest.SpyInstance;

beforeEach(async () => {
  w = await seedWorld(100_000);
  emitted = [];
  const realEmit = bus.emit.bind(bus);
  emitSpy = jest.spyOn(bus, 'emit').mockImplementation((...args: any[]) => {
    emitted.push({ name: args[0], payload: args[1] });
    return realEmit(...args);
  });
  resetEmails();
});

afterEach(() => {
  gate?.restore();
  gate = null;
  emitSpy.mockRestore();
});

const received = () => emitted.filter((e) => e.name === 'invoice.paymentReceived');
const receipts = () => sentEmails().filter((e) => /received your payment/i.test(e.text || ''));

/** Starts the request on the call: a bare supertest chain is inert until awaited. */
async function fire(method: 'put' | 'patch' | 'post' | 'delete', url: string, body?: Record<string, unknown>) {
  const req = (w.owner.api as any)[method](url);
  return body === undefined ? req : req.send(body);
}

/** Run two requests with both paused inside the locking transaction, then release them together. */
async function race(a: () => Promise<any>, b: () => Promise<any>) {
  gate = gateMethod(invoicesRepo, 'runInvoiceTxn');
  const first = a();
  const second = b();
  await gate.arrived(2);
  expect(gate.waiting()).toBe(2);
  gate.open();
  const results = await Promise.all([first, second]);
  await drainEvents();
  expect(gate.entered()).toBeGreaterThanOrEqual(2);
  return results;
}

describe('two concurrent payments', () => {
  it('two full-balance payments: exactly one succeeds, one payment row, one event, one receipt', async () => {
    const [a, b] = await race(
      () => fire('put', `${w.inv}/payment`, { paymentAmount: 1000 }),
      () => fire('put', `${w.inv}/payment`, { paymentAmount: 1000 }),
    );

    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => p.cents)).toEqual([100_000]);
    expect(row.status).toBe('paid');
    expect(received()).toHaveLength(1);
    expect(receipts()).toHaveLength(1);
  });

  it('two "mark paid" requests: one balancing payment, never two', async () => {
    const [a, b] = await race(
      () => fire('put', `${w.inv}/payment`, { isPaid: true }),
      () => fire('put', `${w.inv}/payment`, { isPaid: true }),
    );

    expect([a.status, b.status]).toEqual([200, 200]);
    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => p.cents)).toEqual([100_000]);
    expect(Number(row.amount_paid_cents)).toBe(100_000);
    expect(received()).toHaveLength(1);
  });
});

describe('a payment racing other balance changes', () => {
  it('a payment and a write-off that each want the whole balance: exactly one lands', async () => {
    const [pay, credit] = await race(
      () => fire('put', `${w.inv}/payment`, { paymentAmount: 1000 }),
      () => fire('post', `${w.inv}/credit-note`, { amount: 1000, type: 'write_off' }),
    );

    expect([pay.status, credit.status].filter((s) => s === 200)).toHaveLength(1);
    expect([pay.status, credit.status].filter((s) => s === 400)).toHaveLength(1);
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(Number(row.amount_paid_cents) + Number(row.total_written_off_cents)).toBe(100_000);
  });

  it('a payment and a void: the invoice never ends voided while carrying a payment', async () => {
    const [pay, voided] = await race(
      () => fire('put', `${w.inv}/payment`, { paymentAmount: 100 }),
      () => fire('post', `${w.inv}/void`, {}),
    );

    const row = await invoiceRow(w.invoiceId);
    const payments = await paymentRows(w.invoiceId);
    // One of the two won and the other was refused with a conflict.
    expect([pay.status, voided.status].sort()).toEqual([200, 409].sort());
    if (row.status === 'voided') {
      expect(payments).toEqual([]);
      expect(Number(row.amount_paid_cents)).toBe(0);
      expect(received()).toHaveLength(0);
    } else {
      expect(payments.map((p: any) => p.cents)).toEqual([10_000]);
      await assertInvoiceInvariants(w.invoiceId);
      expect(received()).toHaveLength(1);
    }
  });

  it('a payment and a line-item edit that drops the total below it: never overpaid without acknowledgement', async () => {
    const [pay, edit] = await race(
      () => fire('put', `${w.inv}/payment`, { paymentAmount: 600 }),
      () => fire('patch', `${w.inv}/line-items`, { flatFees: [{ name: 'Fee', amount: 500 }] }),
    );

    expect([pay.status, edit.status].filter((s) => s === 200)).toHaveLength(1);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a payment and "add amount" that both succeed leave the totals adding up in either order', async () => {
    const [pay, add] = await race(
      () => fire('put', `${w.inv}/payment`, { paymentAmount: 1000 }),
      () => fire('patch', `${w.inv}/add-amount`, { amount: 250 }),
    );

    // Either order is legal: paid first then reopened by the 250, or 250 first and
    // the 1000 payment leaves 250 owing. A payment refused for exceeding the
    // balance is not possible here because the total only grew.
    expect([pay.status, add.status]).toEqual([200, 200]);
    const { row } = await assertInvoiceInvariants(w.invoiceId, { ignorePaidDate: true });
    expect(Number(row.total_cents)).toBe(125_000);
    expect(Number(row.amount_paid_cents)).toBe(100_000);
    expect(row.status).toBe('partially_paid');
  });
});

describe('payment edit and delete racing on one invoice', () => {
  async function twoPayments() {
    expect((await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 300 })).status).toBe(200);
    expect((await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 200 })).status).toBe(200);
    await drainEvents();
  }

  it('an edit and a delete of the SAME payment settle with the invariants intact', async () => {
    await twoPayments();

    const [edit, del] = await race(
      () => fire('patch', `${w.inv}/payment`, { paymentIndex: 0, amount: 350 }),
      () => fire('delete', `${w.inv}/payment?paymentIndex=0`),
    );

    expect(del.status).toBe(200);
    expect([200, 400]).toContain(edit.status);
    await assertInvoiceInvariants(w.invoiceId);
  });
});

describe('trust payments under concurrency', () => {
  it('deleting one trust payment twice at once reverses the withdrawal exactly once', async () => {
    const { accountId } = await createTrustDeposit(w.firm.id, w.clientId, { amountCents: 500_000 });
    const paid = await w.owner.api.put(`${w.inv}/payment`)
      .send({ paymentAmount: 400, paymentSource: 'trust', trustAccountId: accountId });
    expect(paid.status).toBe(200);

    const [a, b] = await race(
      () => fire('delete', `${w.inv}/payment?paymentIndex=0`),
      () => fire('delete', `${w.inv}/payment?paymentIndex=0`),
    );

    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const { rows } = await testPool.query(
      `select status, reverses_transaction_id from trust_transactions
        where law_firm_id = $1 and type = 'withdrawal'`,
      [w.firm.id],
    );
    // The original, voided, plus its single reversing entry.
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.status === 'void')).toBe(true);
    const book = await testPool.query('select book_balance_cents from trust_accounts where id = $1', [accountId]);
    expect(Number(book.rows[0].book_balance_cents)).toBe(500_000);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('two trust payments that together exceed the balance: one lands, the ledger shows one withdrawal', async () => {
    const { accountId } = await createTrustDeposit(w.firm.id, w.clientId, { amountCents: 500_000 });

    const [a, b] = await race(
      () => fire('put', `${w.inv}/payment`, { paymentAmount: 700, paymentSource: 'trust', trustAccountId: accountId }),
      () => fire('put', `${w.inv}/payment`, { paymentAmount: 700, paymentSource: 'trust', trustAccountId: accountId }),
    );

    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const { rows } = await testPool.query(
      `select amount_cents, status from trust_transactions where law_firm_id = $1 and type = 'withdrawal'`,
      [w.firm.id],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount_cents)).toBe(70_000);
    const book = await testPool.query('select book_balance_cents from trust_accounts where id = $1', [accountId]);
    expect(Number(book.rows[0].book_balance_cents)).toBe(430_000);
    await assertInvoiceInvariants(w.invoiceId);
  });
});

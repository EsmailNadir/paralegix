/**
 * Invoice totals, tax, adjustments and settlement, checked in integer cents.
 *
 * Expected values are computed with BigInt or integer arithmetic from the
 * inputs, never by repeating the service's float formula. After every mutation
 * the same invariants are asserted on the stored row:
 *
 *   amount_paid + total_written_off + balance_due == total
 *   total == sum(invoice_line_items) + tax_cents    (until an amount is added)
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  atInstant,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let seq = 0;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

/** round-half-up of cents * rate / 100 where the rate has at most 3 decimals. */
function taxCentsFor(subtotalCents: number, ratePercent: number): number {
  const thousandths = BigInt(Math.round(ratePercent * 1000));
  const numerator = BigInt(subtotalCents) * thousandths; // over 100 * 1000
  return Number((numerator * 2n + 100_000n) / 200_000n);
}

async function setBilling(patch: Record<string, unknown>) {
  await testPool.query(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object('billing',
               coalesce(settings -> 'billing', '{}'::jsonb) || $2::jsonb)
      where id = $1`,
    [firm.id, JSON.stringify(patch)],
  );
}

async function stored(invoiceId: string) {
  const { rows } = await testPool.query(
    `select i.total_cents, i.tax_cents, i.tax_rate, i.amount_paid_cents, i.total_written_off_cents,
            i.balance_due_cents, i.is_paid,
            coalesce((select sum(amount_cents) from invoice_line_items where invoice_id = i.id), 0) as line_cents,
            coalesce((select sum(amount_cents) from invoice_payments where invoice_id = i.id), 0) as payment_cents
       from invoices i where i.id = $1`,
    [invoiceId],
  );
  const r = rows[0];
  return {
    total: Number(r.total_cents),
    tax: Number(r.tax_cents),
    taxRate: r.tax_rate == null ? null : Number(r.tax_rate),
    paid: Number(r.amount_paid_cents),
    writtenOff: Number(r.total_written_off_cents),
    balance: Number(r.balance_due_cents),
    isPaid: r.is_paid as boolean,
    lines: Number(r.line_cents),
    payments: Number(r.payment_cents),
  };
}

/** paid + written off + balance is always the total, and the API agrees with the row. */
async function assertSettlementInvariant(invoiceId: string, apiInvoice?: any) {
  const s = await stored(invoiceId);
  expect(s.paid + s.writtenOff + s.balance).toBe(s.total);
  // The recorded payments are the amount paid, to the cent.
  expect(s.payments).toBe(s.paid);
  if (apiInvoice) {
    expect(Math.round(apiInvoice.totalAmount * 100)).toBe(s.total);
    expect(Math.round(apiInvoice.amountPaid * 100)).toBe(s.paid);
    expect(Math.round(apiInvoice.totalWrittenOff * 100)).toBe(s.writtenOff);
    expect(Math.round(apiInvoice.remainingBalance * 100)).toBe(Math.max(0, s.balance));
  }
  return s;
}

async function createFlatFeeInvoice(cents: number, extra: Record<string, unknown> = {}) {
  seq += 1;
  const dollars = cents / 100;
  const res = await owner.api.post(B()).send({
    invoiceName: `Edge ${seq} ${randomUUID().slice(0, 5)}`,
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-31',
    totalAmount: dollars,
    flatFeesAmount: dollars,
    flatFees: [{ description: 'Fee', amount: dollars }],
    ...extra,
  });
  return res;
}

async function newInvoiceId(cents: number, extra: Record<string, unknown> = {}) {
  const res = await createFlatFeeInvoice(cents, extra);
  expect(res.status).toBe(201);
  return res.body.invoice.id as string;
}

const pay = (id: string, paymentAmount: number) =>
  owner.api.put(`${B()}/${id}/payment`).send({ paymentAmount, paidDate: '2026-04-01' });

beforeEach(async () => {
  seq = 0;
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Totals Client' });
  await drainEvents();
});

describe('tax at fractional rates, rounded half up in cents', () => {
  // Subtotals chosen so none lands on an exact half cent: the product is x.2 to x.9.
  const cases: Array<[number, number]> = [
    [7.25, 123_456], // 8950.56
    [8.875, 123_456], // 10956.72
    [0.5, 123_457], // 617.285
    [7.25, 99_999], // 7249.9275
    [8.875, 1_000_001], // 88750.0888
    [0.5, 1_999], // 9.995
    [6.625, 33_333], // 2208.311
    [13, 7], // 0.91
  ];
  it.each(cases)('levies %p%% on %p cents as the exact rounded figure', async (rate, subtotal) => {
    const res = await createFlatFeeInvoice(subtotal, { taxRate: rate });
    expect(res.status).toBe(201);
    const s = await assertSettlementInvariant(res.body.invoice.id, res.body.invoice);
    const want = taxCentsFor(subtotal, rate);
    expect(s.tax).toBe(want);
    expect(s.total).toBe(subtotal + want);
    expect(s.lines).toBe(subtotal);
    expect(Math.round(res.body.invoice.taxAmount * 100)).toBe(want);
    expect(Math.round(res.body.invoice.subtotalAmount * 100)).toBe(subtotal);
  });

  it('rounds a product just above a half cent up and just below it down', async () => {
    // 8.875% of 5 cents = 0.44375 (down); of 6 cents = 0.5325 (up).
    const down = await createFlatFeeInvoice(5, { taxRate: 8.875 });
    const up = await createFlatFeeInvoice(6, { taxRate: 8.875 });
    expect((await stored(down.body.invoice.id)).tax).toBe(0);
    expect((await stored(up.body.invoice.id)).tax).toBe(1);
  });

  it('levies nothing at rate 0 and stores no rate', async () => {
    const res = await createFlatFeeInvoice(123_456, { taxRate: 0 });
    expect(res.status).toBe(201);
    const s = await stored(res.body.invoice.id);
    expect(s).toMatchObject({ tax: 0, taxRate: null, total: 123_456 });
  });

  it('doubles the bill at rate 100 and accepts the rate as a string', async () => {
    const full = await createFlatFeeInvoice(123_457, { taxRate: 100 });
    expect(await stored(full.body.invoice.id)).toMatchObject({ tax: 123_457, total: 246_914 });
    const asString = await createFlatFeeInvoice(123_456, { taxRate: '8.875' });
    expect((await stored(asString.body.invoice.id)).tax).toBe(taxCentsFor(123_456, 8.875));
  });

  it.each([-0.01, -1, 100.01, 250, 'abc'])('refuses a tax rate of %p', async (rate) => {
    const res = await createFlatFeeInvoice(10_000, { taxRate: rate });
    expect(res.status).toBe(400);
  });

  it('applies the firm default rate when the invoice carries none, and an invoice rate overrides it', async () => {
    await setBilling({ tax: { enabled: true, defaultRate: 7.25, label: 'Sales Tax' } });
    const byDefault = await createFlatFeeInvoice(123_456);
    expect((await stored(byDefault.body.invoice.id)).tax).toBe(taxCentsFor(123_456, 7.25));
    const overridden = await createFlatFeeInvoice(123_456, { taxRate: 0.5 });
    expect((await stored(overridden.body.invoice.id)).tax).toBe(taxCentsFor(123_456, 0.5));
  });

  it('levies tax on the sum of all line kinds together, not per line', async () => {
    // Three lines of 3.33 each. Per line, 8.875% of 333 = 29.55 -> 30 each (90);
    // on the subtotal 999 it is 88.66 -> 89.
    const res = await owner.api.post(B()).send({
      invoiceName: `Mixed ${randomUUID().slice(0, 5)}`,
      invoiceDate: '2026-03-01',
      taxRate: 8.875,
      flatFees: [{ description: 'Fee', amount: 3.33 }],
      expenses: [{ description: 'Exp A', amount: 3.33 }, { description: 'Exp B', amount: 3.33 }],
    });
    expect(res.status).toBe(201);
    const s = await stored(res.body.invoice.id);
    expect(s.lines).toBe(999);
    expect(s.tax).toBe(taxCentsFor(999, 8.875));
    expect(s.tax).toBe(89);
    expect(s.total).toBe(1088);
  });
});

describe('tax after later edits', () => {
  it('re-levies the stored rate on the new subtotal when lines change, with total = lines + tax each time', async () => {
    const id = await newInvoiceId(123_456, { taxRate: 8.875 });
    const steps: Array<{ flat: number[]; exp: number[] }> = [
      { flat: [123_456, 99_999], exp: [] }, // add a line
      { flat: [99_999], exp: [1_999] }, // remove one, add an expense
      { flat: [333], exp: [333, 334] }, // change them all
      { flat: [], exp: [] }, // remove everything
    ];
    for (const step of steps) {
      const res = await owner.api.patch(`${B()}/${id}/line-items`).send({
        timeEntries: [],
        flatFees: step.flat.map((c) => ({ description: 'F', amount: c / 100 })),
        expenses: step.exp.map((c) => ({ description: 'E', amount: c / 100 })),
        acknowledgeOverpayment: true,
      });
      expect(res.status).toBe(200);
      const subtotal = [...step.flat, ...step.exp].reduce((a, b) => a + b, 0);
      const s = await assertSettlementInvariant(id, res.body.invoice);
      expect(s.lines).toBe(subtotal);
      expect(s.tax).toBe(taxCentsFor(subtotal, 8.875));
      expect(s.total).toBe(subtotal + s.tax);
    }
  });

  it('replaces the stored rate when a new one is sent with the edit', async () => {
    const id = await newInvoiceId(10_000, { taxRate: 5 });
    const res = await owner.api.patch(`${B()}/${id}/line-items`).send({
      timeEntries: [], expenses: [], taxRate: 0.5,
      flatFees: [{ description: 'F', amount: 123.45 }],
    });
    expect(res.status).toBe(200);
    const s = await stored(id);
    expect(s.taxRate).toBe(0.5);
    expect(s.tax).toBe(taxCentsFor(12_345, 0.5));
    expect(s.total).toBe(12_345 + s.tax);
  });

  it('adds an amount to the total without re-levying tax or touching the lines', async () => {
    const id = await newInvoiceId(10_000, { taxRate: 10 });
    const before = await stored(id);
    expect(before).toMatchObject({ tax: 1000, total: 11_000 });
    const res = await owner.api.patch(`${B()}/${id}/add-amount`).send({ amount: 0.01, note: 'cent' });
    expect(res.status).toBe(200);
    const after = await assertSettlementInvariant(id, res.body.invoice);
    expect(after.total).toBe(11_001);
    expect(after.tax).toBe(1000);
    expect(after.lines).toBe(10_000);
  });
});

describe('late fees on the invoice', () => {
  const lateFee = (id: string) => owner.api.post(`${B()}/${id}/late-fee`);

  it('adds a flat fee once and refuses a second', async () => {
    await setBilling({ lateFee: { enabled: true, flatAmount: 25, percent: 0, graceDays: 5 } });
    const id = await newInvoiceId(100_000);
    const first = await lateFee(id);
    expect(first.status).toBe(200);
    expect(Math.round(first.body.lateFeeAmount * 100)).toBe(2500);
    const s = await assertSettlementInvariant(id, first.body.invoice);
    expect(s.total).toBe(102_500);
    expect((await lateFee(id)).status).toBe(400);
    expect((await stored(id)).total).toBe(102_500);
  });

  it('stacks flat and percent, with the percent taken on the remaining balance after a payment', async () => {
    await setBilling({ lateFee: { enabled: true, flatAmount: 12.34, percent: 1.5, graceDays: 0 } });
    const id = await newInvoiceId(33_333);
    expect((await pay(id, 100)).status).toBe(200); // 23333 remaining
    const res = await lateFee(id);
    expect(res.status).toBe(200);
    // 1.5% of 23333 = 349.995 -> 350, plus 1234 flat.
    const fee = 1234 + 350;
    expect(Math.round(res.body.lateFeeAmount * 100)).toBe(fee);
    const s = await assertSettlementInvariant(id, res.body.invoice);
    expect(s.total).toBe(33_333 + fee);
    expect(s.balance).toBe(23_333 + fee);
  });

  it('charges a percent fee that rounds to zero as nothing, not as a cent', async () => {
    await setBilling({ lateFee: { enabled: true, flatAmount: 0, percent: 5, graceDays: 0 } });
    const id = await newInvoiceId(3); // 5% of 3 cents = 0.15
    const res = await lateFee(id);
    expect(res.status).toBe(400);
    expect((await stored(id)).total).toBe(3);
  });

  it('lets a flat fee exceed a three-cent balance and keeps the invariant', async () => {
    await setBilling({ lateFee: { enabled: true, flatAmount: 0.5, percent: 10, graceDays: 0 } });
    const id = await newInvoiceId(3);
    const res = await lateFee(id);
    expect(res.status).toBe(200);
    // 10% of 3 cents rounds to 0; the flat 50 cents stands.
    expect(Math.round(res.body.lateFeeAmount * 100)).toBe(50);
    const s = await assertSettlementInvariant(id, res.body.invoice);
    expect(s.total).toBe(53);
  });

  it('applies the fee only once the day after the grace period has begun, in the firm zone', async () => {
    await setBilling({ lateFee: { enabled: true, flatAmount: 25, percent: 0, graceDays: 5 } });
    const id = await newInvoiceId(5_000); // due 2026-03-31, grace ends 2026-04-05
    const onGraceEnd = await atInstant('2026-04-05T20:00:00-04:00', () => lateFee(id));
    expect(onGraceEnd.status).toBe(400);
    expect((await stored(id)).total).toBe(5_000);
    const dayAfter = await atInstant('2026-04-06T08:00:00-04:00', () => lateFee(id));
    expect(dayAfter.status).toBe(200);
    expect((await stored(id)).total).toBe(7_500);
  });

  it('refuses a fee on an invoice that is already settled', async () => {
    await setBilling({ lateFee: { enabled: true, flatAmount: 25, percent: 0, graceDays: 0 } });
    const id = await newInvoiceId(5_000);
    expect((await pay(id, 50)).status).toBe(200);
    expect((await lateFee(id)).status).toBe(400);
    expect((await stored(id)).total).toBe(5_000);
  });
});

describe('payments and credit notes keep paid + written off + balance == total', () => {
  it('accepts a one-cent payment, the exact remainder, and refuses one cent more', async () => {
    const id = await newInvoiceId(10_000);
    const one = await pay(id, 0.01);
    expect(one.status).toBe(200);
    expect(await assertSettlementInvariant(id, one.body.invoice)).toMatchObject({ paid: 1, balance: 9_999 });

    const over = await pay(id, 100);
    expect(over.status).toBe(400); // 100.00 > 99.99 remaining
    expect((await stored(id)).paid).toBe(1);

    const exact = await pay(id, 99.99);
    expect(exact.status).toBe(200);
    expect(await assertSettlementInvariant(id, exact.body.invoice)).toMatchObject({ paid: 10_000, balance: 0, isPaid: true });

    const more = await pay(id, 0.01);
    expect(more.status).toBe(400);
  });

  it('sums 333 payments of one cent exactly, then settles the balance', async () => {
    const id = await newInvoiceId(1_000);
    for (let i = 0; i < 333; i += 1) {
      const res = await pay(id, 0.01);
      if (res.status !== 200) throw new Error(`payment ${i} -> ${res.status}`);
    }
    const mid = await assertSettlementInvariant(id);
    expect(mid).toMatchObject({ paid: 333, balance: 667, isPaid: false });
    const rest = await pay(id, 6.67);
    expect(rest.status).toBe(200);
    expect(await assertSettlementInvariant(id, rest.body.invoice)).toMatchObject({ paid: 1_000, balance: 0, isPaid: true });
  });

  it('settles with a credit note equal to the total and refuses one more cent', async () => {
    const id = await newInvoiceId(12_345);
    const over = await owner.api.post(`${B()}/${id}/credit-note`).send({ amount: 123.46, type: 'write_off' });
    expect(over.status).toBe(400);
    expect((await stored(id)).writtenOff).toBe(0);
    const exact = await owner.api.post(`${B()}/${id}/credit-note`).send({ amount: 123.45, type: 'write_off' });
    expect(exact.status).toBe(200);
    expect(await assertSettlementInvariant(id, exact.body.invoice)).toMatchObject({ writtenOff: 12_345, balance: 0 });
    expect((await pay(id, 0.01)).status).toBe(400);
  });

  it('lets a payment take the rest after a partial credit note, and refuses a payment past it', async () => {
    const id = await newInvoiceId(10_000);
    const credit = await owner.api.post(`${B()}/${id}/credit-note`).send({ amount: 33.33, type: 'discount' });
    expect(credit.status).toBe(200);
    await assertSettlementInvariant(id, credit.body.invoice);
    expect((await pay(id, 66.68)).status).toBe(400); // 66.67 remains
    const rest = await pay(id, 66.67);
    expect(rest.status).toBe(200);
    expect(await assertSettlementInvariant(id, rest.body.invoice)).toMatchObject({
      paid: 6_667, writtenOff: 3_333, balance: 0, isPaid: true,
    });
  });

  it('refuses a credit note that, with payments, would pass the total by a cent', async () => {
    const id = await newInvoiceId(10_000);
    expect((await pay(id, 60.01)).status).toBe(200);
    const over = await owner.api.post(`${B()}/${id}/credit-note`).send({ amount: 40, type: 'write_off' });
    expect(over.status).toBe(400);
    const ok = await owner.api.post(`${B()}/${id}/credit-note`).send({ amount: 39.98, type: 'write_off' });
    expect(ok.status).toBe(200);
    expect(await assertSettlementInvariant(id, ok.body.invoice)).toMatchObject({ balance: 1 });
  });

  it('holds the invariant through add-amount, partial pay, credit note, late fee and a line edit', async () => {
    await setBilling({ lateFee: { enabled: true, flatAmount: 1.11, percent: 2.5, graceDays: 0 } });
    const id = await newInvoiceId(20_001, { taxRate: 7.25 });
    const steps: Array<() => Promise<any>> = [
      () => owner.api.patch(`${B()}/${id}/add-amount`).send({ amount: 10.1 }),
      () => pay(id, 33.33),
      () => owner.api.post(`${B()}/${id}/credit-note`).send({ amount: 7.77, type: 'adjustment' }),
      () => owner.api.post(`${B()}/${id}/late-fee`),
    ];
    for (const step of steps) {
      const res = await step();
      expect(res.status).toBe(200);
      await assertSettlementInvariant(id, res.body.invoice);
    }
  });
});

describe('undoing and editing settlement keeps the invariant', () => {
  it('moves the balance back by exactly the removed payment or credit note', async () => {
    const id = await newInvoiceId(10_001);
    const p1 = await pay(id, 40);
    expect(p1.status).toBe(200);
    expect((await pay(id, 10.01)).status).toBe(200);
    const credit = await owner.api.post(`${B()}/${id}/credit-note`).send({ amount: 20.2, type: 'discount' });
    expect(credit.status).toBe(200);
    expect(await assertSettlementInvariant(id, credit.body.invoice)).toMatchObject({ paid: 5_001, writtenOff: 2_020, balance: 2_980 });

    const noteId = credit.body.invoice.creditNotes[0].id as string;
    const delNote = await owner.api.delete(`${B()}/${id}/credit-note`).query({ creditNoteId: noteId });
    expect(delNote.status).toBe(200);
    expect(await assertSettlementInvariant(id, delNote.body.invoice)).toMatchObject({ paid: 5_001, writtenOff: 0, balance: 5_000 });

    const delPay = await owner.api.delete(`${B()}/${id}/payment`).query({ paymentIndex: 0 });
    expect(delPay.status).toBe(200);
    expect(await assertSettlementInvariant(id, delPay.body.invoice)).toMatchObject({ paid: 1_001, balance: 9_000 });
  });

  it('lets a payment edit take the balance to exactly zero and refuses one cent past it', async () => {
    const id = await newInvoiceId(10_000);
    expect((await pay(id, 40)).status).toBe(200);
    expect((await pay(id, 10)).status).toBe(200);
    const over = await owner.api.patch(`${B()}/${id}/payment`).send({ paymentIndex: 1, amount: 60.01 });
    expect(over.status).toBe(400);
    expect((await stored(id)).paid).toBe(5_000);
    const exact = await owner.api.patch(`${B()}/${id}/payment`).send({ paymentIndex: 1, amount: 60 });
    expect(exact.status).toBe(200);
    expect(await assertSettlementInvariant(id, exact.body.invoice)).toMatchObject({ paid: 10_000, balance: 0, isPaid: true });
    const lower = await owner.api.patch(`${B()}/${id}/payment`).send({ paymentIndex: 1, amount: 59.99 });
    expect(lower.status).toBe(200);
    expect(await assertSettlementInvariant(id, lower.body.invoice)).toMatchObject({ paid: 9_999, balance: 1, isPaid: false });
  });
});

describe('large amounts and the dollars-to-cents round trip through the API', () => {
  it.each([
    [1234567.89, 123_456_789],
    [0.3, 30],
    [0.29, 29],
    [4503599.62, 450_359_962],
    [999_999_999.99, 99_999_999_999],
    [1_000_000_000, 100_000_000_000],
  ])('stores %p dollars as %p cents and reads the same dollars back', async (dollars, cents) => {
    const res = await createFlatFeeInvoice(cents);
    expect(res.status).toBe(201);
    expect((await stored(res.body.invoice.id)).total).toBe(cents);
    expect(res.body.invoice.totalAmount).toBe(dollars);
    const read = await owner.api.get(`${B()}`);
    const listed = (read.body.invoices as any[]).find((i) => i.id === res.body.invoice.id);
    expect(listed.totalAmount).toBe(dollars);
    expect(JSON.stringify(listed.totalAmount)).toBe(String(dollars));
  });

  it('refuses a line above the maximum with a 400, not a database error', async () => {
    for (const amount of [1_000_000_000.01, 4503599627370.49, 9007199254740.99, 1e17, 1e21]) {
      const res = await owner.api.post(B()).send({
        invoiceName: `Huge ${randomUUID().slice(0, 5)}`,
        invoiceDate: '2026-03-01',
        flatFees: [{ description: 'Fee', amount }],
      });
      expect({ amount, status: res.status }).toEqual({ amount, status: 400 });
    }
  });

  it('adds many maximum-size lines exactly, and levies tax on the big subtotal', async () => {
    const lines = Array.from({ length: 5 }, () => ({ description: 'Fee', amount: 999_999_999.99 }));
    const res = await owner.api.post(B()).send({
      invoiceName: `Big ${randomUUID().slice(0, 5)}`, invoiceDate: '2026-03-01', taxRate: 8.875, flatFees: lines,
    });
    expect(res.status).toBe(201);
    const subtotal = 5 * 99_999_999_999;
    const s = await assertSettlementInvariant(res.body.invoice.id, res.body.invoice);
    expect(s.lines).toBe(subtotal);
    expect(s.tax).toBe(taxCentsFor(subtotal, 8.875));
    expect(s.total).toBe(subtotal + s.tax);
  });
});

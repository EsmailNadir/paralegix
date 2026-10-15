/**
 * B02.3 validation matrix, invoice slice.
 *
 * `invoiceLifecycle.test.ts`, `invoiceAdjustments.test.ts` and
 * `invoiceInstallments.test.ts` already cover zero/negative amounts on the
 * payment, credit-note and payment-plan endpoints. None of them exercise the
 * money fields on invoice CREATION itself (`nonNegativeAmount` in
 * invoices.validation.ts), and nothing in the suite hits
 * `/calendar-payment-dates` at all. This file covers those two gaps plus one
 * server-owned-field and one date-handling case.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const invoicesPath = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const calendarPath = (query = '') => `/api/lawfirms/${firm.id}/billing/invoices/calendar-payment-dates${query}`;

async function invoiceCount() {
  const { rows } = await testPool.query(
    'select count(*)::int c from invoices where law_firm_id = $1', [firm.id],
  );
  return rows[0].c as number;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Invoice Matrix Firm' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Matrix Client', email: 'matrix@example.test' });
});

describe('money field validation on invoice creation', () => {
  it('rejects a negative flat-fee amount instead of shrinking the invoice total', async () => {
    // `nonNegativeAmount` in invoices.validation.ts exists so a "discount" can't
    // be smuggled in as a negative line item; that refine has no route-level
    // test anywhere in the suite.
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Negative Line',
      invoiceDate: '2026-03-01',
      totalAmount: -50,
      flatFeesAmount: -50,
      flatFees: [{ description: 'Bogus discount', amount: -50 }],
    });

    expect(res.status).toBe(400);
    expect(await invoiceCount()).toBe(0);
  });

  it('rejects a JSON numeric-overflow line-item amount (1e309)', async () => {
    // 1e309 parses as `Infinity`. `nonNegativeAmount`'s refine checks
    // `Number.isFinite`, so this must be a clean 400, not an invoice whose
    // total is silently `Infinity` or `NaN`.
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Overflow Line',
      invoiceDate: '2026-03-01',
      totalAmount: 1e309,
      flatFeesAmount: 1e309,
      flatFees: [{ description: 'Overflow fee', amount: 1e309 }],
    });

    expect(res.status).toBe(400);
    expect(await invoiceCount()).toBe(0);
  });

  it('rejects a malformed numeric string line-item amount', async () => {
    // Line-item amounts accept a string/number union (so the client can send
    // either), but `nonNegativeAmount`'s refine parses the string with
    // `parseFloat` and must reject anything that doesn't parse to a finite
    // non-negative number.
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Malformed Line',
      invoiceDate: '2026-03-01',
      totalAmount: 100,
      flatFeesAmount: 100,
      flatFees: [{ description: 'Bad string amount', amount: 'one hundred dollars' }],
    });

    expect(res.status).toBe(400);
    expect(await invoiceCount()).toBe(0);
  });

  it('accepts a line-item amount right at the documented maximum', async () => {
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'At The Cap',
      invoiceDate: '2026-03-01',
      totalAmount: 1_000_000_000,
      flatFeesAmount: 1_000_000_000,
      flatFees: [{ description: 'At the cap', amount: 1_000_000_000 }],
    });

    expect(res.status).toBe(201);
  });

  it('rejects a line-item amount one dollar past the documented maximum', async () => {
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'One Past The Cap',
      invoiceDate: '2026-03-01',
      totalAmount: 1_000_000_001,
      flatFeesAmount: 1_000_000_001,
      flatFees: [{ description: 'One past the cap', amount: 1_000_000_001 }],
    });

    // Rejecting max+1 on this field also rejects anything larger, such as 1e17,
    // whose cents overflow a bigint and used to answer 500 from the insert.
    expect(res.status).toBe(400);
    expect(await invoiceCount()).toBe(0);
  });
});

describe('calendar-date validity on invoiceDate/dueDate', () => {
  it('rejects an impossible invoiceDate instead of silently storing the rolled-over date', async () => {
    // Before the fix: `toTimestampOrNull` -> `localInputToUtcDate` built
    // '2026-02-30' with `Date.UTC(2026, 1, 30, ...)`, which doesn't validate
    // ranges and silently rolls forward to March 2. The invoice was created
    // as if the caller had asked for March 2, with no error at all.
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Impossible Date',
      invoiceDate: '2026-02-30',
      totalAmount: 100,
      flatFeesAmount: 100,
      flatFees: [{ description: 'Flat fee', amount: 100 }],
    });

    expect(res.status).toBe(400);
    expect(await invoiceCount()).toBe(0);
  });

  it('rejects an impossible dueDate the same way', async () => {
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Impossible Due Date',
      invoiceDate: '2026-03-01',
      dueDate: '2026-04-31',
      totalAmount: 100,
      flatFeesAmount: 100,
      flatFees: [{ description: 'Flat fee', amount: 100 }],
    });

    expect(res.status).toBe(400);
    expect(await invoiceCount()).toBe(0);
  });

  it('still accepts a real calendar date, including a genuine month-end and a leap day', async () => {
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Real Dates',
      invoiceDate: '2026-04-30',
      dueDate: '2028-02-29',
      totalAmount: 100,
      flatFeesAmount: 100,
      flatFees: [{ description: 'Flat fee', amount: 100 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.invoice.invoiceDate).toBe('2026-04-30');
    expect(res.body.invoice.dueDate).toBe('2028-02-29');
  });

  it('preserves the calendar date when a full ISO timestamp with a negative offset is sent instead of a bare day', async () => {
    // `invoiceDate`/`dueDate` back `invoices.invoice_date`/`due_date`, both
    // plain `date` (day-only) columns - confirmed in db/schema.sql. `dateInput`
    // in invoices.validation.ts explicitly documents accepting "a string
    // (day-only or full ISO ...)", but the service pipes that string through
    // `toTimestampOrNull` -> `localInputToUtcDate`, which for anything other
    // than a bare 'YYYY-MM-DD' or a 'YYYY-MM-DDTHH:mm' string falls through to
    // `new Date(localStr)` and produces a real UTC instant. The repository's
    // `toDateOnly` then does `date.toISOString().slice(0, 10)` on that
    // instant - a late-evening wall time at a negative offset converts to the
    // NEXT UTC calendar day, so an invoice dated "March 1st, 11:30pm Pacific"
    // (`2026-03-01T23:30:00-08:00`, which is `2026-03-02T07:30:00Z`) is stored
    // and returned as March 2nd, one day later than every part of the input
    // string said. Postgres's own `::date` cast of the identical string
    // returns '2026-03-01' - the literal calendar-date prefix, ignoring time
    // and offset entirely - confirming the app's conversion is the outlier,
    // not the correct reading.
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Full ISO With Offset',
      invoiceDate: '2026-03-01T23:30:00-08:00',
      dueDate: '2026-03-15T23:30:00-08:00',
      totalAmount: 100,
      flatFeesAmount: 100,
      flatFees: [{ description: 'Flat fee', amount: 100 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.invoice.invoiceDate).toBe('2026-03-01');
    expect(res.body.invoice.dueDate).toBe('2026-03-15');
  });
});

describe('server-owned fields on a details patch', () => {
  it('ignores generated/server-owned fields sent in the body instead of erroring or applying them', async () => {
    const created = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Real Invoice',
      invoiceDate: '2026-03-01',
      totalAmount: 500,
      flatFeesAmount: 500,
      flatFees: [{ description: 'Flat fee', amount: 500 }],
    });
    expect(created.status).toBe(201);
    const invoiceId = created.body.invoice.id;

    // `updateInvoiceDetailsSchema` names exactly five editable fields.
    // totalCents/amountPaidCents/lawFirmId/id are not among them, so Zod's
    // default "strip unknown keys" behaviour must drop them before the
    // service ever sees them - not error, not apply them.
    const res = await owner.api
      .patch(`${invoicesPath()}/${invoiceId}/details`)
      .send({
        invoiceName: 'Renamed, Not Reprised',
        totalCents: 999999999,
        amountPaidCents: 999999999,
        lawFirmId: '11111111-1111-1111-1111-111111111111',
        id: '22222222-2222-2222-2222-222222222222',
      });

    expect(res.status).toBe(200);

    const { rows } = await testPool.query(
      'select id, invoice_name, total_cents, amount_paid_cents, law_firm_id from invoices where id = $1',
      [invoiceId],
    );
    expect(rows[0].id).toBe(invoiceId);
    expect(rows[0].invoice_name).toBe('Renamed, Not Reprised');
    expect(Number(rows[0].total_cents)).toBe(50_000);
    expect(Number(rows[0].amount_paid_cents)).toBe(0);
    expect(rows[0].law_firm_id).toBe(firm.id);
  });
});

describe('calendar-payment-dates date window handling', () => {
  it('returns the full unwindowed set when only one bound is supplied, rather than erroring', async () => {
    // The route resolves its window inline (`from && to && from <= to`)
    // instead of through `shared/utils/calendarRange`, which the sibling
    // `dateWindow()` helper's own doc comment says "rejects a half-supplied or
    // inverted window". This route does not: a half-supplied or inverted
    // bound silently falls back to the unwindowed contract instead of a 400
    // or an actually-filtered result. Proven here by asking for a window that
    // excludes March and getting the March due date back anyway. Pinned
    // because nothing in the suite called this route at all before this file.
    const created = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Calendar Invoice',
      invoiceDate: '2026-03-01',
      dueDate: '2026-03-31',
      totalAmount: 200,
      flatFeesAmount: 200,
      flatFees: [{ description: 'Flat fee', amount: 200 }],
    });
    expect(created.status).toBe(201);
    const invoiceId = created.body.invoice.id;

    const halfSupplied = await owner.api.get(calendarPath('?from=2026-01-01'));
    const inverted = await owner.api.get(calendarPath('?from=2026-06-01&to=2026-01-01'));

    expect(halfSupplied.status).toBe(200);
    expect(inverted.status).toBe(200);
    expect(Array.isArray(halfSupplied.body.paymentDates)).toBe(true);
    expect(Array.isArray(inverted.body.paymentDates)).toBe(true);

    // A correctly-windowed read (`from` with no `to`, or `to` before `from`)
    // would exclude a March due date entirely. Finding it anyway is the
    // fallback-to-unwindowed behaviour, not a coincidence: a genuinely scoped
    // window would leave `entriesFor` empty for both requests.
    const entriesFor = (res: any) => res.body.paymentDates.filter(
      (e: any) => e.invoiceId === invoiceId && e.dueDate === '2026-03-31',
    );
    expect(entriesFor(halfSupplied)).toHaveLength(1);
    expect(entriesFor(inverted)).toHaveLength(1);
  });

  it('filters correctly when a valid, correctly-ordered window is supplied', async () => {
    // Control for the case above: a real window (both bounds, correctly
    // ordered) must actually exclude an out-of-range due date, proving the
    // fallback above is specific to the half-supplied/inverted cases and not
    // just this route always ignoring its window.
    const created = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Windowed Invoice',
      invoiceDate: '2026-03-01',
      dueDate: '2026-03-31',
      totalAmount: 200,
      flatFeesAmount: 200,
      flatFees: [{ description: 'Flat fee', amount: 200 }],
    });
    expect(created.status).toBe(201);
    const invoiceId = created.body.invoice.id;

    const outsideWindow = await owner.api.get(calendarPath('?from=2026-01-01&to=2026-01-31'));
    const insideWindow = await owner.api.get(calendarPath('?from=2026-03-01&to=2026-03-31'));

    const entriesFor = (res: any) => res.body.paymentDates.filter(
      (e: any) => e.invoiceId === invoiceId && e.dueDate === '2026-03-31',
    );
    expect(entriesFor(outsideWindow)).toHaveLength(0);
    expect(entriesFor(insideWindow)).toHaveLength(1);
  });
});

describe('boundary rules the audit found open', () => {
  async function seedInvoice() {
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Boundary', invoiceDate: '2026-03-01', totalAmount: 100, flatFeesAmount: 100,
      flatFees: [{ description: 'Fee', amount: 100 }],
    });
    expect(res.status).toBe(201);
    return res.body.invoice.id as string;
  }

  it('refuses a tax rate above one hundred percent', async () => {
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Taxed', invoiceDate: '2026-03-01', totalAmount: 100, flatFeesAmount: 100,
      flatFees: [{ description: 'Fee', amount: 100 }], taxRate: 250,
    });
    expect(res.status).toBe(400);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses a negative tax rate instead of silently ignoring it', async () => {
    const res = await owner.api.post(invoicesPath()).send({
      invoiceName: 'Taxed', invoiceDate: '2026-03-01', totalAmount: 100, flatFeesAmount: 100,
      flatFees: [{ description: 'Fee', amount: 100 }], taxRate: -5,
    });
    expect(res.status).toBe(400);
  });

  it('lets a line-item edit change the tax rate', async () => {
    const id = await seedInvoice();
    const res = await owner.api.patch(`${invoicesPath()}/${id}/line-items`).send({
      flatFees: [{ description: 'Fee', amount: 100 }], taxRate: 10,
    });
    expect(res.status).toBe(200);
    // Re-levied at the new rate: 100 plus 10%.
    expect(res.body.invoice.taxAmount).toBe(10);
    expect(res.body.invoice.totalAmount).toBe(110);
    expect(res.body.invoice.taxRate).toBe(10);
  });

  it('refuses a manual payment that claims to be a Stripe payment', async () => {
    const id = await seedInvoice();
    // Everything downstream treats `stripe` as a payment Stripe can reverse and
    // that the edit-amount path must refuse to touch. A manual entry wearing the
    // label would be a Stripe payment with no Stripe behind it.
    const res = await owner.api.put(`${invoicesPath()}/${id}/payment`)
      .send({ paymentAmount: 10, paymentSource: 'stripe' });
    expect(res.status).toBe(400);
  });

  it('refuses a fractional payment-plan frequency', async () => {
    const id = await seedInvoice();
    const res = await owner.api.post(`${invoicesPath()}/${id}/payment-plan`)
      .send({ installmentAmount: 25, frequencyDays: 0.5, startDate: '2026-04-01' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/frequencyDays|whole number/i);
  });
});

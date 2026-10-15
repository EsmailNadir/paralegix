/**
 * A wider sweep of invoices.validation.ts turned up more money fields with the
 * same bigint-overflow gap `invoiceValidationMatrix.test.ts` and
 * `invoiceLineItemEdits.test.ts` already closed for `nonNegativeAmount` and
 * `invoiceLineInputSchema`: a Zod `z.number()`/`z.union([z.number(), z.string()])`
 * field with no upper bound lets a huge-but-FINITE value (e.g. 1e17) through
 * unchanged, and it only fails once it is multiplied by 100 for cents storage
 * and written to a `bigint` column, past Postgres's ~9.223e18 range - a raw
 * "value out of range for type bigint" 500 instead of a clean 400.
 *
 * Each describe block below targets ONE field verified against its real write
 * path (not every field that LOOKS like this shape actually reproduces - some
 * are already guarded by an unrelated business-rule check that rejects a huge
 * value long before it reaches the database; those are documented, not tested,
 * since there is nothing here to prove failing).
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

const MAX_MONEY_AMOUNT = 1_000_000_000;

describe('line-item money fields on invoice creation', () => {
  let firm: Firm;
  let owner: Actor;
  let client: ClientRecord;
  const base = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

  async function invoiceCount() {
    const { rows } = await testPool.query(
      'select count(*)::int c from invoices where law_firm_id = $1', [firm.id],
    );
    return rows[0].c as number;
  }

  beforeEach(async () => {
    firm = await createFirm({ name: 'Line Overflow Firm' });
    owner = await ownerOf(firm.id);
    client = await createPersonClient(firm.id, { name: 'Line Overflow Client' });
  });

  describe('invoiceLineItemSchema.rate', () => {
    // `amount` is the only field the service recomputes totals from
    // (`sumLineAmounts`) and it is capped already; `rate` is stored purely for
    // display/reference but is written straight to `invoice_line_items.rate_cents`
    // (a bigint column) via `centsOrNull(item.rate)` in `lineToColumns`, with no
    // recompute and no bound in between.
    it('accepts a rate right at the documented maximum', async () => {
      const res = await owner.api.post(base()).send({
        invoiceName: 'Rate At Cap',
        invoiceDate: '2026-03-01',
        timeEntries: [{ description: 'Work', hours: 1, rate: MAX_MONEY_AMOUNT, amount: 50 }],
      });

      expect(res.status).toBe(201);
    });

    it('rejects a rate one dollar past the documented maximum', async () => {
      const res = await owner.api.post(base()).send({
        invoiceName: 'Rate Past Cap',
        invoiceDate: '2026-03-01',
        timeEntries: [{ description: 'Work', hours: 1, rate: MAX_MONEY_AMOUNT + 1, amount: 50 }],
      });

      // Rejecting max+1 also rejects anything larger, such as 1e17, whose cents
      // overflow a bigint and used to answer 500 from the insert.
      expect(res.status).toBe(400);
      expect(await invoiceCount()).toBe(0);
    });
  });

  describe('allocationAmount, all three line kinds', () => {
    // Every kind funnels through the SAME `lineToColumns` helper:
    // `allocation_amount_cents: item.allocationAmount != null ? centsOrNull(item.allocationAmount) : null`.
    // Each kind is sent on its own so the gap (and the fix) is proven for time
    // entries, flat fees and expenses alike, not just one of them.
    it.each([
      ['time-entry', { timeEntries: [{ description: 'Work', hours: 1, rate: 100, amount: 100, allocationAmount: 1e17 }] }],
      ['flat-fee', { flatFees: [{ description: 'Filing fee', amount: 50, allocationAmount: 1e17 }] }],
      ['expense', { expenses: [{ description: 'Courier', amount: 20, allocationAmount: 1e17 }] }],
    ])('rejects a huge but finite allocationAmount on a %s line', async (_kind, lines) => {
      const res = await owner.api.post(base()).send({
        invoiceName: 'Huge Allocation',
        invoiceDate: '2026-03-01',
        ...lines,
      });

      expect(res.status).toBe(400);
      expect(await invoiceCount()).toBe(0);
    });

    it('accepts an allocationAmount right at the documented maximum on all three kinds', async () => {
      const res = await owner.api.post(base()).send({
        invoiceName: 'Allocation At Cap',
        invoiceDate: '2026-03-01',
        timeEntries: [{ description: 'Work', hours: 1, rate: 100, amount: 100, allocationAmount: MAX_MONEY_AMOUNT }],
        flatFees: [{ description: 'Filing fee', amount: 50, allocationAmount: MAX_MONEY_AMOUNT }],
        expenses: [{ description: 'Courier', amount: 20, allocationAmount: MAX_MONEY_AMOUNT }],
      });

      expect(res.status).toBe(201);
    });
  });
});

describe('addAmountSchema.amount on PATCH .../add-amount', () => {
  // `addAmountToInvoice` folds `amount` straight into
  // `invoices.total_cents` (`centsOf(doc.totalAmount)` in the repository) with
  // no upper-bound check anywhere in the service - unlike `recordPayment`,
  // `editPayment`, and `addCreditNote`, which each reject before writing once
  // the requested figure would exceed the invoice's own (already-bounded)
  // remaining balance or total.
  let firm: Firm;
  let owner: Actor;
  let client: ClientRecord;
  let invoiceId: string;
  const base = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

  async function totalCentsOf(id: string) {
    const { rows } = await testPool.query('select total_cents from invoices where id = $1', [id]);
    return Number(rows[0].total_cents);
  }

  beforeEach(async () => {
    firm = await createFirm({ name: 'Add Amount Overflow Firm' });
    owner = await ownerOf(firm.id);
    client = await createPersonClient(firm.id, { name: 'Add Amount Overflow Client' });

    const created = await owner.api.post(base()).send({
      invoiceName: 'Base Invoice',
      invoiceDate: '2026-03-01',
      totalAmount: 100,
      flatFeesAmount: 100,
      flatFees: [{ description: 'Base fee', amount: 100 }],
    });
    expect(created.status).toBe(201);
    invoiceId = created.body.invoice.id;
    await drainEvents();
  });

  it('rejects a huge but finite add-amount instead of crashing total_cents', async () => {
    const before = await totalCentsOf(invoiceId);

    const res = await owner.api
      .patch(`${base()}/${invoiceId}/add-amount`)
      .send({ amount: 1e17, note: 'Huge charge' });

    expect(res.status).toBe(400);
    // Nothing applied: the invoice keeps its original total.
    expect(await totalCentsOf(invoiceId)).toBe(before);
  });

  it('accepts an add-amount right at the documented maximum', async () => {
    const res = await owner.api
      .patch(`${base()}/${invoiceId}/add-amount`)
      .send({ amount: MAX_MONEY_AMOUNT });

    expect(res.status).toBe(200);
    expect(await totalCentsOf(invoiceId)).toBe((MAX_MONEY_AMOUNT + 100) * 100);
  });
});

describe('setPaymentPlanSchema.installmentAmount on POST .../payment-plan', () => {
  // `downPaymentAmount` is already guarded (rejected once it would be >= the
  // remaining balance), but the plan HEADER field - `installmentAmount` -
  // is written straight to `invoices.plan_installment_cents` via
  // `centsOrNull(plan.installmentAmount)` with no such check. The per-line
  // schedule rows in `invoice_expected_payments` are separately clamped to the
  // remaining balance by `rebuildSchedule` (see the "CLAMPS an instalment
  // larger than the invoice" case in invoiceInstallments.test.ts), so those
  // never overflow - only the header column does.
  let firm: Firm;
  let owner: Actor;
  let client: ClientRecord;
  let invoiceId: string;
  const base = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
  const onInvoice = (suffix: string) => `${base()}/${invoiceId}${suffix}`;

  beforeEach(async () => {
    firm = await createFirm({ name: 'Plan Header Overflow Firm' });
    owner = await ownerOf(firm.id);
    client = await createPersonClient(firm.id, { name: 'Plan Header Overflow Client' });

    const created = await owner.api.post(base()).send({
      invoiceName: 'Plan Invoice',
      invoiceDate: '2026-03-01',
      totalAmount: 1200,
      flatFeesAmount: 1200,
      flatFees: [{ description: 'Fixed fee', amount: 1200 }],
    });
    expect(created.status).toBe(201);
    invoiceId = created.body.invoice.id;
    await drainEvents();
  });

  it('rejects a huge but finite installmentAmount instead of crashing plan_installment_cents', async () => {
    const res = await owner.api.post(onInvoice('/payment-plan')).send({
      installmentAmount: 1e17, frequencyDays: 30, planStartDate: '2026-04-01',
    });

    expect(res.status).toBe(400);

    const { rows } = await testPool.query(
      'select payment_plan_enabled from invoices where id = $1', [invoiceId],
    );
    // No plan was created at all: the invoice must not end up half-configured.
    expect(rows[0].payment_plan_enabled).toBe(false);
  });

  it('accepts an installmentAmount right at the documented maximum', async () => {
    const res = await owner.api.post(onInvoice('/payment-plan')).send({
      installmentAmount: MAX_MONEY_AMOUNT, frequencyDays: 30, planStartDate: '2026-04-01',
    });

    expect(res.status).toBe(200);
  });
});

describe('updateInstallmentSchema.amount on PATCH .../payment-plan/installment/:index', () => {
  // The edited amount replaces `expectedPayments[installmentIndex].amount`
  // outright with no bound check, and is written to
  // `invoice_expected_payments.amount_cents` on persist.
  let firm: Firm;
  let owner: Actor;
  let client: ClientRecord;
  let invoiceId: string;
  const base = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
  const onInvoice = (suffix: string) => `${base()}/${invoiceId}${suffix}`;

  const firstInstallmentCents = async () => {
    const { rows } = await testPool.query(
      `select amount_cents from invoice_expected_payments
        where invoice_id = $1 order by due_date limit 1`, [invoiceId],
    );
    return Number(rows[0].amount_cents);
  };

  beforeEach(async () => {
    firm = await createFirm({ name: 'Installment Overflow Firm' });
    owner = await ownerOf(firm.id);
    client = await createPersonClient(firm.id, { name: 'Installment Overflow Client' });

    const created = await owner.api.post(base()).send({
      invoiceName: 'Installment Edit Invoice',
      invoiceDate: '2026-03-01',
      // Billed AT the documented ceiling, because the amount under test is that
      // ceiling and an instalment is now held to the invoice's own balance. A
      // $1200 invoice would refuse it for having the wrong total rather than
      // for exceeding the bound, which is not what these cases are about.
      totalAmount: MAX_MONEY_AMOUNT,
      flatFeesAmount: MAX_MONEY_AMOUNT,
      flatFees: [{ description: 'Fixed fee', amount: MAX_MONEY_AMOUNT }],
    });
    expect(created.status).toBe(201);
    invoiceId = created.body.invoice.id;

    const plan = await owner.api.post(onInvoice('/payment-plan')).send({
      installmentAmount: MAX_MONEY_AMOUNT / 4, frequencyDays: 30, planStartDate: '2026-04-01',
    });
    expect(plan.status).toBe(200);
    await drainEvents();
  });

  it('rejects a huge but finite amount instead of crashing amount_cents', async () => {
    const before = await firstInstallmentCents();

    const res = await owner.api.patch(onInvoice('/payment-plan/installment/0')).send({ amount: 1e17 });

    expect(res.status).toBe(400);
    expect(await firstInstallmentCents()).toBe(before);
  });

  it('accepts an amount right at the documented maximum', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/installment/0')).send({ amount: MAX_MONEY_AMOUNT });

    expect(res.status).toBe(200);
    expect(await firstInstallmentCents()).toBe(MAX_MONEY_AMOUNT * 100);
  });
});

describe('replaceScheduleSchema.installments[].amount on PATCH .../payment-plan/schedule', () => {
  // A bulk schedule replace takes each incoming installment's `amount` as sent
  // (`roundCurrency(inst.amount)`). The aggregate is now held to the invoice's
  // remaining balance, but that check runs on the SUM, so a single huge value
  // still reaches `amount_cents` on an invoice billed for it. Only the schema
  // bound stands between that value and the column.
  let firm: Firm;
  let owner: Actor;
  let client: ClientRecord;
  let invoiceId: string;
  const base = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
  const onInvoice = (suffix: string) => `${base()}/${invoiceId}${suffix}`;

  const installmentCount = async () => {
    const { rows } = await testPool.query(
      'select count(*)::int c from invoice_expected_payments where invoice_id = $1', [invoiceId],
    );
    return rows[0].c as number;
  };

  beforeEach(async () => {
    firm = await createFirm({ name: 'Schedule Overflow Firm' });
    owner = await ownerOf(firm.id);
    client = await createPersonClient(firm.id, { name: 'Schedule Overflow Client' });

    const created = await owner.api.post(base()).send({
      invoiceName: 'Schedule Replace Invoice',
      invoiceDate: '2026-03-01',
      // Billed AT the documented ceiling, because the amount under test is that
      // ceiling and an instalment is now held to the invoice's own balance. A
      // $1200 invoice would refuse it for having the wrong total rather than
      // for exceeding the bound, which is not what these cases are about.
      totalAmount: MAX_MONEY_AMOUNT,
      flatFeesAmount: MAX_MONEY_AMOUNT,
      flatFees: [{ description: 'Fixed fee', amount: MAX_MONEY_AMOUNT }],
    });
    expect(created.status).toBe(201);
    invoiceId = created.body.invoice.id;

    const plan = await owner.api.post(onInvoice('/payment-plan')).send({
      installmentAmount: MAX_MONEY_AMOUNT / 4, frequencyDays: 30, planStartDate: '2026-04-01',
    });
    expect(plan.status).toBe(200);
    expect(await installmentCount()).toBe(4);
    await drainEvents();
  });

  it('rejects a huge but finite installment amount instead of crashing amount_cents', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/schedule')).send({
      installments: [{ amount: 1e17, dueDate: '2026-05-01' }],
    });

    expect(res.status).toBe(400);
    // The old schedule (four instalments) must survive a rejected replace untouched.
    expect(await installmentCount()).toBe(4);
  });

  it('accepts an installment amount right at the documented maximum', async () => {
    const res = await owner.api.patch(onInvoice('/payment-plan/schedule')).send({
      installments: [{ amount: MAX_MONEY_AMOUNT, dueDate: '2026-05-01' }],
    });

    expect(res.status).toBe(200);
    expect(await installmentCount()).toBe(1);
  });
});

describe('splitInvoiceLineItemSchema.amount on manual split-invoice lines', () => {
  // A manually-added line (one sent with no id) has no
  // backing unbilled row, so the cross-check that ties a selected line to a
  // real source amount never runs for it (`continue`s past it in the
  // allocation loop) - only the invoice's OWN internal totals have to agree,
  // and a caller fully controls both sides of that comparison. That is enough
  // to get an arbitrary (including negative, or bigint-overflowing) `amount`
  // all the way to `invoice_line_items.amount_cents` on insert.
  let firm: Firm;
  let owner: Actor;
  let person: ClientRecord;
  let matterId: string;
  const B = () => `/api/lawfirms/${firm.id}/billing`;

  async function invoiceCountForMatter() {
    const { rows } = await testPool.query(
      'select count(*)::int c from invoices where law_firm_id = $1 and matter_id = $2', [firm.id, matterId],
    );
    return rows[0].c as number;
  }

  beforeEach(async () => {
    firm = await createFirm({ name: 'Split Overflow Firm' });
    owner = await ownerOf(firm.id);
    person = await createPersonClient(firm.id, { name: 'Split Overflow Client' });

    const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Split Overflow Matter',
      clients: [{ clientId: person.id, name: 'Split Overflow Client' }],
    });
    expect(matter.status).toBe(201);
    matterId = matter.body.matterId;
    expect(matterId).toBeTruthy();
    await drainEvents();
  });

  it('rejects a huge but finite manual line amount instead of crashing the insert', async () => {
    const res = await owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
      invoiceDate: '2026-03-15',
      splitMode: 'manual',
      sourceSelection: { timeEntries: [], flatFees: [] },
      invoices: [{
        matterClientId: person.id,
        invoiceName: 'Manual Huge Share',
        totalAmount: 1e17,
        totalHours: 1,
        timeEntries: [{ description: 'Manual work', amount: 1e17, hours: 1 }],
      }],
    });

    expect(res.status).toBe(400);
    expect(await invoiceCountForMatter()).toBe(0);
  });

  it('rejects a negative line amount smuggled alongside a larger positive one', async () => {
    // Net total is a plausible, positive 50: only the SIGN of the second line
    // is wrong. The aggregate "must have a positive total" guard alone (which
    // looks only at the sum) does not catch this - the fix has to reject the
    // individual line.
    const res = await owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
      invoiceDate: '2026-03-15',
      splitMode: 'manual',
      sourceSelection: { timeEntries: [], flatFees: [] },
      invoices: [{
        matterClientId: person.id,
        invoiceName: 'Manual Negative Line',
        totalAmount: 50,
        totalHours: 2,
        timeEntries: [
          { description: 'Full charge', amount: 150, hours: 1 },
          { description: 'Bogus discount', amount: -100, hours: 1 },
        ],
      }],
    });

    expect(res.status).toBe(400);
    expect(await invoiceCountForMatter()).toBe(0);
  });

  it('accepts a manual line amount right at the documented maximum', async () => {
    const res = await owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
      invoiceDate: '2026-03-15',
      splitMode: 'manual',
      sourceSelection: { timeEntries: [], flatFees: [] },
      invoices: [{
        matterClientId: person.id,
        invoiceName: 'Manual At Cap',
        totalAmount: MAX_MONEY_AMOUNT,
        totalHours: 1,
        timeEntries: [{ description: 'Manual work', amount: MAX_MONEY_AMOUNT, hours: 1 }],
      }],
    });

    expect(res.status).toBe(201);
    expect(await invoiceCountForMatter()).toBe(1);
  });
});

describe('splitInvoiceLineItemSchema.rate / allocationAmount on manual split-invoice lines', () => {
  // Same shape as the `amount` gap directly above, but for the two fields that
  // were out of scope for that pass: `rate` and `allocationAmount` on
  // `splitInvoiceLineItemSchema` (and `allocationAmount` on
  // `splitInvoiceFlatFeeSchema`) were still bare `z.union([z.number(),
  // z.string()]).optional()` with no bound at all. Neither field feeds
  // `sumLineAmounts`/the aggregate cross-checks the way `amount` does, so
  // there is no aggregate guard to catch a huge value even on a NON-manual
  // line - but a manual line (no backing unbilled row) is the cleanest
  // reproduction, matching the sibling `amount` describe block above. Both
  // are written straight into bigint columns in `lineToColumns`:
  // `rate_cents: centsOrNull(item.rate)` and
  // `allocation_amount_cents: centsOrNull(item.allocationAmount)`, with no
  // recompute in between - the same `1e17 * 100` overflow past bigint range.
  let firm: Firm;
  let owner: Actor;
  let person: ClientRecord;
  let matterId: string;
  const B = () => `/api/lawfirms/${firm.id}/billing`;

  async function invoiceCountForMatter() {
    const { rows } = await testPool.query(
      'select count(*)::int c from invoices where law_firm_id = $1 and matter_id = $2', [firm.id, matterId],
    );
    return rows[0].c as number;
  }

  beforeEach(async () => {
    firm = await createFirm({ name: 'Split Rate Overflow Firm' });
    owner = await ownerOf(firm.id);
    person = await createPersonClient(firm.id, { name: 'Split Rate Overflow Client' });

    const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Split Rate Overflow Matter',
      clients: [{ clientId: person.id, name: 'Split Rate Overflow Client' }],
    });
    expect(matter.status).toBe(201);
    matterId = matter.body.matterId;
    expect(matterId).toBeTruthy();
    await drainEvents();
  });

  it('rejects a huge but finite manual line rate instead of crashing rate_cents', async () => {
    const res = await owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
      invoiceDate: '2026-03-15',
      splitMode: 'manual',
      sourceSelection: { timeEntries: [], flatFees: [] },
      invoices: [{
        matterClientId: person.id,
        invoiceName: 'Manual Huge Rate',
        totalAmount: 50,
        totalHours: 1,
        timeEntries: [{ description: 'Manual work', amount: 50, hours: 1, rate: 1e17 }],
      }],
    });

    expect(res.status).toBe(400);
    expect(await invoiceCountForMatter()).toBe(0);
  });

  it('rejects a huge but finite manual time-entry line allocationAmount instead of crashing allocation_amount_cents', async () => {
    const res = await owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
      invoiceDate: '2026-03-15',
      splitMode: 'manual',
      sourceSelection: { timeEntries: [], flatFees: [] },
      invoices: [{
        matterClientId: person.id,
        invoiceName: 'Manual Huge Time Entry Allocation',
        totalAmount: 50,
        totalHours: 1,
        timeEntries: [{ description: 'Manual work', amount: 50, hours: 1, allocationAmount: 1e17 }],
      }],
    });

    expect(res.status).toBe(400);
    expect(await invoiceCountForMatter()).toBe(0);
  });

  it('rejects a huge but finite manual flat-fee line allocationAmount instead of crashing allocation_amount_cents', async () => {
    const res = await owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
      invoiceDate: '2026-03-15',
      splitMode: 'manual',
      sourceSelection: { timeEntries: [], flatFees: [] },
      invoices: [{
        matterClientId: person.id,
        invoiceName: 'Manual Huge Flat Fee Allocation',
        totalAmount: 50,
        totalHours: 0,
        flatFeesAmount: 50,
        flatFees: [{ description: 'Manual fee', amount: 50, allocationAmount: 1e17 }],
      }],
    });

    expect(res.status).toBe(400);
    expect(await invoiceCountForMatter()).toBe(0);
  });

  it('accepts a manual line rate and allocationAmount right at the documented maximum', async () => {
    const res = await owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
      invoiceDate: '2026-03-15',
      splitMode: 'manual',
      sourceSelection: { timeEntries: [], flatFees: [] },
      invoices: [{
        matterClientId: person.id,
        invoiceName: 'Manual Rate And Allocation At Cap',
        totalAmount: 100,
        totalHours: 1,
        flatFeesAmount: 50,
        timeEntries: [{
          description: 'Manual work',
          amount: 50,
          hours: 1,
          rate: MAX_MONEY_AMOUNT,
          allocationAmount: MAX_MONEY_AMOUNT,
        }],
        flatFees: [{ description: 'Manual fee', amount: 50, allocationAmount: MAX_MONEY_AMOUNT }],
      }],
    });

    expect(res.status).toBe(201);
    expect(await invoiceCountForMatter()).toBe(1);
  });
});

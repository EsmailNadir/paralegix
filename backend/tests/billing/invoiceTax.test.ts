/**
 * Sales tax on an invoice: where it is levied, on what, and in which order.
 *
 * Tax is the one figure on an invoice that is derived rather than entered. The
 * service computes it as `round(subtotalCents * rate / 100)` and FOLDS IT INTO
 * `total_cents`, keeping the rate and the cash amount alongside for display. So
 * three separate things can be wrong while the screen still looks ordinary:
 *
 *   - the rate is applied to the wrong base (post-payment, or on top of an
 *     already-taxed total),
 *   - the tax is rounded the wrong way, a cent per invoice,
 *   - the tax is computed but never added to what the client owes, so the
 *     invoice reads $1,344.13 and settles for $1,234.56.
 *
 * Every figure here is chosen so the arithmetic actually differs between the
 * right answer and the plausible wrong one. $1,234.56 at 8.875% is 10,956.72
 * cents: rounding gives 10,957, truncating gives 10,956. A test at 10% on
 * $1,000 would pass either way and prove nothing.
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

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

/** The line-item subtotal every case in this file bills, in cents. */
const SUBTOTAL_CENTS = 123_456;
const SUBTOTAL = 1234.56;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;

/**
 * Turn on the firm's default tax rate.
 *
 * Billing settings live in `law_firms.settings -> 'billing'`, a jsonb blob with
 * no table of its own, so this is one merge rather than an insert. Seeded with
 * SQL rather than through the settings route: a fixture written by the code
 * under test cannot fail when that code is wrong.
 */
async function enableFirmTax(rate: number, enabled = true) {
  const { rowCount } = await testPool.query(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object(
               'billing',
               coalesce(settings -> 'billing', '{}'::jsonb)
                 || jsonb_build_object(
                      'tax',
                      jsonb_build_object('enabled', $2::boolean, 'defaultRate', $3::numeric, 'label', 'Sales Tax')
                    )
             )
      where id = $1`,
    [firm.id, enabled, rate],
  );
  expect(rowCount).toBe(1);

  // Prove the blob really carries the rate before any case leans on it. A merge
  // that silently landed nowhere would make every "tax was charged" assertion
  // below fail for the wrong reason, and every "no tax" assertion pass for one.
  const { rows } = await testPool.query(
    `select settings -> 'billing' -> 'tax' as tax from law_firms where id = $1`,
    [firm.id],
  );
  expect(rows[0].tax).toEqual({ enabled, defaultRate: rate, label: 'Sales Tax' });
}

/** Create the standard $1,234.56 invoice, optionally with a per-invoice rate. */
function createInvoice(body: Record<string, unknown> = {}) {
  return owner.api.post(B()).send({
    invoiceName: `Taxed ${Math.random().toString(36).slice(2, 8)}`,
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-31',
    totalAmount: SUBTOTAL,
    flatFeesAmount: SUBTOTAL,
    flatFees: [{ description: 'Fixed fee', amount: SUBTOTAL }],
    ...body,
  });
}

/** The stored money columns, including the generated balance. */
async function row(invoiceId: string) {
  const { rows } = await testPool.query(
    `select total_cents, tax_cents, tax_rate, amount_paid_cents, balance_due_cents, is_paid
       from invoices where id = $1`,
    [invoiceId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Taxable Client' });
  await drainEvents();
});

describe('levying the firm default rate', () => {
  it('adds tax on top of the line-item subtotal and rounds to the nearest cent', async () => {
    await enableFirmTax(8.875);

    const res = await createInvoice();
    expect(res.status).toBe(201);

    const stored = await row(res.body.invoice.id);
    // 123456 x 8.875% = 10,956.72 cents. Rounded, not truncated: a truncating
    // implementation stores 10,956 and the invoice is a cent light.
    expect(Number(stored.tax_cents)).toBe(10_957);
    // Folded into the total, which is what the client is asked to pay.
    expect(Number(stored.total_cents)).toBe(SUBTOTAL_CENTS + 10_957);
    // `balance_due_cents` is `generated always as ... stored`, so this is the
    // database's own arithmetic rather than the service's.
    expect(Number(stored.balance_due_cents)).toBe(134_413);
    expect(Number(stored.tax_rate)).toBe(8.875);
  });

  it('reports a subtotal that reconciles with the lines it was computed from', async () => {
    await enableFirmTax(8.875);

    const res = await createInvoice();

    // The invoice shows three figures and a client checks them against each
    // other: subtotal + tax must be the total, and the subtotal must be what
    // the lines add to. `subtotalAmount` is derived in the serializer as
    // total - tax, so a tax stored against the wrong base shows up here as a
    // subtotal that no line item explains.
    expect(res.body.invoice.subtotalAmount).toBe(SUBTOTAL);
    expect(res.body.invoice.taxAmount).toBe(109.57);
    expect(res.body.invoice.totalAmount).toBe(1344.13);
    expect(res.body.invoice.subtotalAmount + res.body.invoice.taxAmount)
      .toBeCloseTo(res.body.invoice.totalAmount, 2);
  });

  it('charges nothing when the firm has tax switched off, whatever rate is stored', async () => {
    // A firm that configured a rate and then disabled the feature must not be
    // silently billing its clients tax. The rate is left in place on purpose:
    // this pins the `enabled` gate, not the absence of a number.
    await enableFirmTax(8.875, false);

    const res = await createInvoice();

    const stored = await row(res.body.invoice.id);
    expect(Number(stored.tax_cents)).toBe(0);
    expect(Number(stored.total_cents)).toBe(SUBTOTAL_CENTS);
    expect(stored.tax_rate).toBeNull();
  });
});

describe('the order of operations against the line-item check', () => {
  it('validates the supplied total against the PRE-tax subtotal', async () => {
    await enableFirmTax(8.875);

    // The caller states the total it computed from the lines. Tax is levied
    // afterwards, server-side, so the figure that has to match is the untaxed
    // one. If the check ran after the tax was folded in, every taxed invoice a
    // composer submitted would be rejected as "does not match line items".
    const res = await createInvoice({ totalAmount: SUBTOTAL });

    expect(res.status).toBe(201);
    // And the invoice is nonetheless persisted at MORE than what was sent.
    expect(Number((await row(res.body.invoice.id)).total_cents)).toBe(134_413);
  });

  it('refuses a caller that sends the tax-inclusive figure as the line total', async () => {
    await enableFirmTax(8.875);

    // The mirror image of the case above, and the one that would double-tax:
    // 1344.13 does not equal the lines, so it is refused rather than accepted
    // and then taxed again to 1463.46.
    const res = await createInvoice({ totalAmount: 1344.13 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match line items/i);

    // Prove the refusal wrote nothing, rather than asserting an absence against
    // a world where nothing was ever attempted.
    const { rows } = await testPool.query(
      'select count(*)::int as n from invoices where law_firm_id = $1',
      [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('a per-invoice rate', () => {
  it('overrides the firm default', async () => {
    await enableFirmTax(8.875);

    const res = await createInvoice({ taxRate: 5 });

    const stored = await row(res.body.invoice.id);
    // 123456 x 5% = 6,172.8 cents, rounded to 6,173. Distinct from the firm
    // default's 10,957 in both value and rounding direction.
    expect(Number(stored.tax_cents)).toBe(6173);
    expect(Number(stored.tax_rate)).toBe(5);
    expect(Number(stored.total_cents)).toBe(SUBTOTAL_CENTS + 6173);
  });

  it('lets an explicit zero suppress the firm default', async () => {
    await enableFirmTax(8.875);

    // A tax-exempt client on a firm that otherwise charges tax. The service
    // distinguishes "no rate sent" (use the firm default) from "rate sent as 0"
    // (charge nothing), so an exempt invoice must come out untaxed rather than
    // falling back to 8.875%.
    const res = await createInvoice({ taxRate: 0 });

    const stored = await row(res.body.invoice.id);
    expect(Number(stored.tax_cents)).toBe(0);
    expect(Number(stored.total_cents)).toBe(SUBTOTAL_CENTS);
  });

  it('charges tax even when the firm feature is off', async () => {
    await enableFirmTax(8.875, false);

    // The firm-level switch only decides whether a DEFAULT is prefilled. An
    // invoice that names its own rate is taxed regardless, which is what makes
    // the two branches of the rate resolution genuinely distinct.
    const res = await createInvoice({ taxRate: 5 });

    expect(Number((await row(res.body.invoice.id)).tax_cents)).toBe(6173);
  });
});

describe('what the client actually owes', () => {
  it('leaves the tax outstanding when the client pays the subtotal', async () => {
    await enableFirmTax(8.875);
    const created = await createInvoice();
    const invoiceId = created.body.invoice.id;

    // A client paying the figure the lines add to has NOT settled the bill.
    const paid = await owner.api.put(`${B()}/${invoiceId}/payment`).send({
      paymentAmount: SUBTOTAL,
      paidDate: '2026-03-10',
    });
    expect(paid.status).toBe(200);

    const stored = await row(invoiceId);
    expect(Number(stored.amount_paid_cents)).toBe(SUBTOTAL_CENTS);
    // Exactly the tax is still owed. If the tax were computed for display but
    // never folded into `total_cents`, this payment would have settled the
    // invoice and the firm would never collect the 109.57 it is holding for the
    // tax authority.
    expect(Number(stored.balance_due_cents)).toBe(10_957);
    expect(stored.is_paid).toBe(false);
    expect(paid.body.invoice.remainingBalance).toBe(109.57);
  });

  it('settles once the tax is paid too', async () => {
    await enableFirmTax(8.875);
    const created = await createInvoice();
    const invoiceId = created.body.invoice.id;

    await owner.api.put(`${B()}/${invoiceId}/payment`).send({ paymentAmount: SUBTOTAL });
    const second = await owner.api.put(`${B()}/${invoiceId}/payment`).send({ paymentAmount: 109.57 });
    expect(second.status).toBe(200);

    const stored = await row(invoiceId);
    expect(Number(stored.balance_due_cents)).toBe(0);
    expect(stored.is_paid).toBe(true);
  });

  it('refuses a payment of one cent more than the taxed total', async () => {
    await enableFirmTax(8.875);
    const created = await createInvoice();

    // The over-payment guard has to be measuring against the TAXED total. A
    // guard reading the pre-tax subtotal would reject the legitimate 1344.13
    // below instead. The guard allows a one-cent epsilon for float dust, so
    // 1344.15 is the first amount it genuinely refuses.
    const over = await owner.api
      .put(`${B()}/${created.body.invoice.id}/payment`)
      .send({ paymentAmount: 1344.15 });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/exceeds the remaining balance/i);

    const exact = await owner.api
      .put(`${B()}/${created.body.invoice.id}/payment`)
      .send({ paymentAmount: 1344.13 });
    expect(exact.status).toBe(200);
    expect(Number((await row(created.body.invoice.id)).balance_due_cents)).toBe(0);
  });
});

describe('re-levying tax when the bill is edited', () => {
  it('recomputes the tax from the NEW subtotal rather than carrying the old amount', async () => {
    await enableFirmTax(8.875);
    const created = await createInvoice();
    const invoiceId = created.body.invoice.id;
    expect(Number((await row(invoiceId)).tax_cents)).toBe(10_957);

    // Halve the bill. 61,728 cents x 8.875% = 5,478.36 -> 5,478.
    const edited = await owner.api.patch(`${B()}/${invoiceId}/line-items`).send({
      timeEntries: [],
      flatFees: [{ description: 'Fixed fee', amount: 617.28 }],
      expenses: [],
    });
    expect(edited.status).toBe(200);

    const stored = await row(invoiceId);
    expect(Number(stored.tax_cents)).toBe(5478);
    // 67,206, not 72,685. Carrying the original 10,957 forward onto the halved
    // subtotal would overcharge the client 54.79 of tax the new lines never
    // produced, and the invoice would still look internally consistent.
    expect(Number(stored.total_cents)).toBe(67_206);
    expect(Number(stored.balance_due_cents)).toBe(67_206);
  });

  it('keeps the rate on the invoice, so a later edit is taxed at the same rate', async () => {
    await enableFirmTax(8.875);
    const created = await createInvoice({ taxRate: 5 });
    const invoiceId = created.body.invoice.id;

    // Editing the lines must not quietly re-resolve the rate from the firm
    // default: an invoice issued at 5% stays at 5%, even after the edit.
    const edited = await owner.api.patch(`${B()}/${invoiceId}/line-items`).send({
      timeEntries: [],
      flatFees: [{ description: 'Fixed fee', amount: 617.28 }],
      expenses: [],
    });
    expect(edited.status).toBe(200);

    const stored = await row(invoiceId);
    // 61,728 x 5% = 3,086.4 -> 3,086. At the firm's 8.875% it would be 5,478.
    expect(Number(stored.tax_cents)).toBe(3086);
    expect(Number(stored.total_cents)).toBe(64_814);
    expect(Number(stored.tax_rate)).toBe(5);
  });

  it('drops the tax to zero when every line is removed', async () => {
    await enableFirmTax(8.875);
    const created = await createInvoice();
    const invoiceId = created.body.invoice.id;

    const edited = await owner.api.patch(`${B()}/${invoiceId}/line-items`).send({
      timeEntries: [], flatFees: [], expenses: [],
    });
    expect(edited.status).toBe(200);

    const stored = await row(invoiceId);
    // Tax on nothing is nothing. A carried-forward tax amount would leave the
    // client owing 109.57 against an invoice with no lines at all.
    expect(Number(stored.tax_cents)).toBe(0);
    expect(Number(stored.total_cents)).toBe(0);
  });
});

describe('the firm list carries the same tax figures as the detail', () => {
  it('reports taxAmount and subtotalAmount with includeDetails, derived from the stored cents', async () => {
    await enableFirmTax(8.875);
    const created = await createInvoice();
    expect(created.status).toBe(201);
    const id = created.body.invoice.id;

    // `mapInvoiceRecord` used to read `taxAmount` / `subtotalAmount` /
    // `expensesAmount` straight off the repository row, which carries `taxCents`
    // and none of those, so every tax-bearing invoice listed with zero tax on
    // the matter and client invoice pages.
    const list = await owner.api.get(`/api/lawfirms/${firm.id}/billing/invoices/firm?includeDetails=true`);
    expect(list.status).toBe(200);
    const listed = list.body.invoices.find((inv: any) => inv.id === id);
    expect(listed.taxAmount).toBe(created.body.invoice.taxAmount);
    expect(listed.taxAmount).toBeGreaterThan(0);
    expect(listed.subtotalAmount).toBe(created.body.invoice.subtotalAmount);
    expect(Math.round((listed.subtotalAmount + listed.taxAmount) * 100)).toBe(Math.round(listed.totalAmount * 100));
  });
});

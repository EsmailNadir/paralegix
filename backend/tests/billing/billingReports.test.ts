/**
 * Billing reports: "what did this matter earn" and "what does this client owe".
 *
 * The whole module had no test, and it is 587 lines of hand-written SQL whose
 * entire output is money. Nothing here can fail visibly: a dropped term in a SUM,
 * a lost `law_firm_id`, or a UNION branch that stops being mutually exclusive all
 * produce a page that renders perfectly and states the wrong figure. So every
 * case below asserts an AMOUNT, not a status code.
 *
 * Four properties carry the module.
 *
 *   THE MONEY MODEL. A row's `totalBilled` is the invoice total, or the flat-fee
 *   amount when the total is zero; `totalOutstanding` is that total less
 *   write-offs and payments, floored at zero. Each of those four terms is
 *   asserted with a seeded value that makes its absence visible: no 100s and no
 *   0s, where a dropped term or a x100 slip still looks plausible.
 *
 *   ATTRIBUTION IS NOT FAN-OUT. Work that names a client belongs to that client;
 *   work that names nobody belongs to the matter's SOLE client, and to no one at
 *   all when the matter has several. That rule exists because spreading an
 *   unnamed receivable across every client on a matter counts it two or three
 *   times. The UNION branches implementing it are mutually exclusive by
 *   construction, and the cases below pin exactly that: an invoice that satisfies
 *   two branches' shapes must still be counted once.
 *
 *   THE ACTIVITY GATE. A matter or client with no time and no invoices is
 *   ABSENT from the list, not present at zero. The per-client matter breakdown
 *   deliberately does the opposite. Both are pinned, because "the row is missing"
 *   and "the row is zero" are the two ways this report lies.
 *
 *   TENANT SCOPE. `invoices.client_id`, `invoices.client_context_id` and
 *   `time_entries.client_id` are SINGLE-column foreign keys to `clients(id)`,
 *   with no firm in them. So another firm's invoice can legally carry THIS
 *   firm's client id, and only `law_firm_id = $1` inside the CTEs keeps its money
 *   out of this firm's report. The isolation cases seed exactly that row rather
 *   than an unrelated firm whose data could never have matched anyway.
 *
 * PERMISSIONS. The routes stack `billing.viewInvoices` AND
 * `billing.viewTimeEntries`. Neither is in `DEFAULT_PERMISSIONS`, so a member
 * whose role grants nothing is refused, and so is a caller with no membership in
 * the firm. Both cases are pinned below.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  stranger,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const base = (id: string = firm.id) => `/api/lawfirms/${id}/billing/reports`;

// ---------------------------------------------------------------------------
// Fixtures. Plain SQL through the test pool, never the code under test: a
// fixture built by the repository cannot fail when the repository is wrong.
// ---------------------------------------------------------------------------

async function seedPracticeArea(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    'insert into practice_areas (id, law_firm_id, name) values ($1, $2, $3)',
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedMatter(
  lawFirmId: string,
  overrides: { name?: string; status?: string; practiceAreaId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status, practice_area_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      lawFirmId,
      overrides.name ?? `Matter ${id.slice(0, 8)}`,
      `REF-${id.slice(0, 8)}`,
      overrides.status ?? 'active',
      overrides.practiceAreaId ?? null,
    ],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** Put a client on a matter. `matter_clients` is what "sole client" is read from. */
async function attachClient(lawFirmId: string, matterId: string, clientId: string) {
  const res = await testPool.query(
    'insert into matter_clients (law_firm_id, matter_id, client_id) values ($1, $2, $3)',
    [lawFirmId, matterId, clientId],
  );
  expect(res.rowCount).toBe(1);
}

interface InvoiceOpts {
  matterId?: string | null;
  clientContextId?: string | null;
  clientId?: string | null;
  totalCents?: number;
  flatFeesCents?: number;
  amountPaidCents?: number;
  writtenOffCents?: number;
  isPaid?: boolean;
  status?: string;
  dueDate?: string | null;
  nextPaymentDate?: string | null;
  planEnabled?: boolean;
  invoiceName?: string | null;
}

/**
 * An invoice. A CHECK constraint requires EXACTLY ONE of `matter_id` /
 * `client_context_id`, which is how the schema distinguishes a matter invoice
 * from a client-level one. `client_id` is separately the billed client, and on a
 * matter invoice it is the "names a client" signal the attribution rules read.
 */
async function seedInvoice(lawFirmId: string, opts: InvoiceOpts): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invoices
       (id, law_firm_id, matter_id, client_context_id, client_id, context_type,
        invoice_number, invoice_name, status, total_cents, flat_fees_amount_cents,
        amount_paid_cents, total_written_off_cents, is_paid,
        invoice_date, due_date, next_payment_date, payment_plan_enabled)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             current_date, $15, $16, $17)`,
    [
      id,
      lawFirmId,
      opts.matterId ?? null,
      opts.clientContextId ?? null,
      opts.clientId ?? null,
      opts.matterId ? 'matter' : 'client',
      `INV-${id.slice(0, 8)}`,
      opts.invoiceName ?? null,
      opts.status ?? 'outstanding',
      opts.totalCents ?? 0,
      opts.flatFeesCents ?? 0,
      opts.amountPaidCents ?? 0,
      opts.writtenOffCents ?? 0,
      opts.isPaid ?? false,
      opts.dueDate ?? null,
      opts.nextPaymentDate ?? null,
      opts.planEnabled ?? false,
    ],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** One installment on an invoice's payment plan. `due_date` is TEXT here. */
async function seedInstallment(
  lawFirmId: string,
  invoiceId: string,
  opts: { dueDate: string; amountCents: number; status?: string; sortOrder?: number },
) {
  const res = await testPool.query(
    `insert into invoice_expected_payments
       (invoice_id, law_firm_id, sort_order, due_date, amount_cents, status)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      invoiceId,
      lawFirmId,
      opts.sortOrder ?? 0,
      opts.dueDate,
      opts.amountCents,
      opts.status ?? 'pending',
    ],
  );
  expect(res.rowCount).toBe(1);
}

interface TimeOpts {
  matterId?: string | null;
  clientId?: string | null;
  hours: number;
  matterClientIds?: string[];
  billed?: boolean;
  billable?: boolean;
}

/**
 * A time entry. A CHECK constraint requires exactly one of `matter_id` /
 * `client_id`, so matter work and client-context work are separate shapes.
 * `matter_client_ids` is the jsonb array naming which clients on the matter the
 * entry is chargeable to.
 */
async function seedTime(lawFirmId: string, opts: TimeOpts): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, client_id, activity_date, hours,
        matter_client_ids, billable)
     values ('time', $1, $2, $3, $4, current_date, $5, $6::jsonb, $7)`,
    [
      id,
      lawFirmId,
      opts.matterId ?? null,
      opts.clientId ?? null,
      opts.hours,
      JSON.stringify(opts.matterClientIds ?? []),
      opts.billable ?? true,
    ],
  );
  expect(res.rowCount).toBe(1);
  // "Billed" means a line item on an invoice names the entry; the flag the
  // fixture used to set was dropped by migration 0228 because nothing set it.
  if (opts.billed) {
    const invoiceId = await seedInvoice(lawFirmId, {
      matterId: opts.matterId ?? undefined,
      clientContextId: opts.matterId ? undefined : (opts.clientId ?? undefined),
      totalCents: 0,
    });
    await testPool.query(
      `insert into invoice_line_items (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
       values ($1, $2, 'time_entry', $3, $4, 0, 0)`,
      [invoiceId, lawFirmId, id, opts.hours],
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const byMatter = (query = '', actor: Actor = owner) =>
  actor.api.get(`${base()}/by-matter${query}`);
const byClient = (query = '', actor: Actor = owner) =>
  actor.api.get(`${base()}/by-client${query}`);
const breakdown = (clientId: string, actor: Actor = owner, lawFirmId = firm.id) =>
  actor.api.get(`${base(lawFirmId)}/by-client/${clientId}/matters`);

/** The single row for `name`, asserted to exist. A missing row is its own bug. */
function rowNamed(body: any, name: string) {
  const matches = (body.rows ?? []).filter((r: any) => r.name === name);
  // Asserted rather than picked with `find`: a duplicated row is exactly how a
  // JOIN fan-out shows up, and `find` would hide it behind a correct-looking
  // first row.
  expect(matches).toHaveLength(1);
  return matches[0];
}

const names = (body: any) => (body.rows ?? []).map((r: any) => r.name);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

// ===========================================================================
describe('by-matter: the money on a matter', () => {
// ===========================================================================

  it('bills a matter for the sum of its invoice totals', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Acme v. Globex' });
    await seedInvoice(firm.id, { matterId, totalCents: 250_000 });
    await seedInvoice(firm.id, { matterId, totalCents: 137_500 });

    const res = await byMatter();

    expect(res.status).toBe(200);
    // 2500 + 1375. Either invoice dropping out leaves a figure that is still a
    // plausible amount of money, which is why both are asserted through the sum.
    expect(rowNamed(res.body, 'Acme v. Globex')).toMatchObject({
      invoiceCount: 2,
      totalBilled: 3875,
    });
  });

  it('falls back to the flat-fee amount when the invoice total is zero', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Flat Fee Matter' });
    await seedInvoice(firm.id, { matterId, totalCents: 0, flatFeesCents: 73_450 });

    const res = await byMatter();

    // A flat-fee invoice can carry its money only in flat_fees_amount_cents.
    // Without the fallback this matter reports $0 billed while the client holds
    // an invoice for $734.50.
    expect(rowNamed(res.body, 'Flat Fee Matter').totalBilled).toBe(734.5);
  });

  it('prefers the invoice total over the flat-fee amount when both are set', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Both Amounts' });
    await seedInvoice(firm.id, { matterId, totalCents: 250_000, flatFeesCents: 73_450 });

    const res = await byMatter();

    // Not 3234.50. flat_fees_amount_cents is a COMPONENT of total_cents, not an
    // addition to it, so summing the two bills the flat fee twice.
    expect(rowNamed(res.body, 'Both Amounts').totalBilled).toBe(2500);
  });

  it('subtracts both payments and write-offs from what is outstanding', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Part Paid' });
    await seedInvoice(firm.id, {
      matterId,
      totalCents: 500_000,
      amountPaidCents: 120_000,
      writtenOffCents: 30_000,
    });

    const res = await byMatter();

    // 5000 - 1200 - 300. Three distinct values so dropping either subtrahend
    // gives a different, wrong answer (3800 or 4700) rather than the same one.
    expect(rowNamed(res.body, 'Part Paid')).toMatchObject({
      totalBilled: 5000,
      totalOutstanding: 3500,
    });
  });

  it('never reports a negative outstanding balance on an overpaid invoice', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Overpaid' });
    await seedInvoice(firm.id, { matterId, totalCents: 40_000, amountPaidCents: 65_000 });

    const res = await byMatter();

    // Without the floor this is -250, and it nets against the firm's other
    // receivables, understating what the firm is owed.
    expect(rowNamed(res.body, 'Overpaid').totalOutstanding).toBe(0);
  });

  it('sums the hours logged against the matter', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Timed Matter' });
    await seedTime(firm.id, { matterId, hours: 3.25 });
    await seedTime(firm.id, { matterId, hours: 1.5 });

    const res = await byMatter();

    expect(rowNamed(res.body, 'Timed Matter')).toMatchObject({
      timeEntryCount: 2,
      totalHours: 4.75,
    });
  });

  it('counts already-billed and non-billable time in the matter total', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Mixed Time' });
    await seedTime(firm.id, { matterId, hours: 3.25 });
    await seedTime(firm.id, { matterId, hours: 1.5, billed: true });
    await seedTime(firm.id, { matterId, hours: 2.25, billable: false });

    const res = await byMatter();

    // The card states LIFETIME hours on the matter, not unbilled ones. Adding a
    // `billed = false` or `billable = true` predicate here would silently shrink
    // every matter's hours as the firm invoices its work.
    expect(rowNamed(res.body, 'Mixed Time').totalHours).toBe(7);
  });

  it('keeps another matter\'s time and money off this matter\'s row', async () => {
    const mine = await seedMatter(firm.id, { name: 'Mine' });
    const theirs = await seedMatter(firm.id, { name: 'Theirs' });
    await seedTime(firm.id, { matterId: mine, hours: 3.25 });
    await seedInvoice(firm.id, { matterId: mine, totalCents: 250_000 });
    await seedTime(firm.id, { matterId: theirs, hours: 9.75 });
    await seedInvoice(firm.id, { matterId: theirs, totalCents: 999_900 });

    const res = await byMatter();

    expect(rowNamed(res.body, 'Mine')).toMatchObject({ totalHours: 3.25, totalBilled: 2500 });
    expect(rowNamed(res.body, 'Theirs')).toMatchObject({ totalHours: 9.75, totalBilled: 9999 });
  });

  it('does not double a matter\'s total when two clients are on it', async () => {
    const a = await createPersonClient(firm.id, { name: 'Ada Byron' });
    const b = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const matterId = await seedMatter(firm.id, { name: 'Two Clients' });
    await attachClient(firm.id, matterId, a.id);
    await attachClient(firm.id, matterId, b.id);
    await seedInvoice(firm.id, { matterId, totalCents: 250_000 });
    await seedTime(firm.id, { matterId, hours: 3.25 });

    const res = await byMatter();

    // The classic fan-out: joining matter_clients directly into the row instead
    // of aggregating it first multiplies every figure by the client count. The
    // matter appears once (rowNamed asserts that) with unmultiplied figures.
    const row = rowNamed(res.body, 'Two Clients');
    expect(row.totalBilled).toBe(2500);
    expect(row.totalHours).toBe(3.25);
    expect(row.clientNames).toEqual(['Ada Byron', 'Grace Hopper']);
  });

  // M12: the case above proves ONE time entry and ONE invoice do not get
  // doubled by two clients on the matter. It cannot tell a query that is
  // genuinely safe apart from one that joins matter_time and matter_invoices
  // directly against each other instead of aggregating each first: with only
  // one row on each side, a 1x1 fan-out looks identical to no fan-out at all.
  // Three time entries against three invoices makes that distinction visible -
  // a direct join multiplies entry_count x invoice_count into 9 matched rows,
  // which would triple totalHours and triple totalBilled here.
  it('sums every time entry and every invoice on a matter exactly once, with several of each and two clients', async () => {
    const ada = await createPersonClient(firm.id, { name: 'Ada Byron' });
    const grace = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const matterId = await seedMatter(firm.id, { name: 'Compound Matter' });
    await attachClient(firm.id, matterId, ada.id);
    await attachClient(firm.id, matterId, grace.id);

    // Three distinct, non-round entries: a doubled or tripled sum is
    // unmistakable next to 5.90.
    await seedTime(firm.id, { matterId, hours: 1.23 });
    await seedTime(firm.id, { matterId, hours: 4.56 });
    await seedTime(firm.id, { matterId, hours: 0.11 });

    // Three distinct invoices, each with its own distinct payment recorded
    // against it.
    await seedInvoice(firm.id, { matterId, totalCents: 12_345, amountPaidCents: 1_000 });
    await seedInvoice(firm.id, { matterId, totalCents: 67_890, amountPaidCents: 2_000 });
    await seedInvoice(firm.id, { matterId, totalCents: 1_111, amountPaidCents: 111 });

    const res = await byMatter();

    const row = rowNamed(res.body, 'Compound Matter');
    expect(row.totalHours).toBeCloseTo(5.9, 2);
    expect(row.invoiceCount).toBe(3);
    // (12345 + 67890 + 1111) / 100
    expect(row.totalBilled).toBeCloseTo(813.46, 2);
    // billed minus (1000 + 2000 + 111) paid
    expect(row.totalOutstanding).toBeCloseTo(782.35, 2);
    expect(row.clientNames).toEqual(['Ada Byron', 'Grace Hopper']);
  });
});

// ===========================================================================
describe('by-matter: which matters appear at all', () => {
// ===========================================================================

  it('omits a matter with no time and no invoices', async () => {
    await seedMatter(firm.id, { name: 'Dormant' });
    const active = await seedMatter(firm.id, { name: 'Active' });
    await seedInvoice(firm.id, { matterId: active, totalCents: 250_000 });

    const res = await byMatter();

    // Both halves matter. Asserting only the absence would pass against a query
    // returning nothing at all.
    expect(names(res.body)).toEqual(['Active']);
    expect(res.body.totalItems).toBe(1);
  });

  it('includes a matter with time but no invoices, billed at zero', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Unbilled Work' });
    await seedTime(firm.id, { matterId, hours: 3.25 });

    const res = await byMatter();

    expect(rowNamed(res.body, 'Unbilled Work')).toMatchObject({
      totalHours: 3.25,
      invoiceCount: 0,
      totalBilled: 0,
      totalOutstanding: 0,
    });
  });

  it('leaves a client-level invoice out of every matter row and reports it as unlinked', async () => {
    const client = await createPersonClient(firm.id, { name: 'Direct Bill' });
    const matterId = await seedMatter(firm.id, { name: 'Has A Matter' });
    await seedInvoice(firm.id, { matterId, totalCents: 250_000 });
    await seedInvoice(firm.id, {
      clientContextId: client.id,
      clientId: client.id,
      totalCents: 88_800,
    });

    const res = await byMatter();

    // The $888 is real money on the firm's books that this GROUPING cannot show,
    // because it hangs off no matter. Rolling it into a matter row would put it
    // on the wrong matter; dropping it silently would make the firm total change
    // when the Group by toggle is switched.
    expect(rowNamed(res.body, 'Has A Matter').totalBilled).toBe(2500);
    expect(res.body.unlinkedInvoices).toEqual({ count: 1, totalAmount: 888 });
  });

  it('reports no unlinked invoices when every invoice hangs off a matter', async () => {
    const matterId = await seedMatter(firm.id, { name: 'All Linked' });
    await seedInvoice(firm.id, { matterId, totalCents: 250_000 });

    const res = await byMatter();

    // The counterpart of the case above: a report that always claimed unlinked
    // money would be just as wrong, and the previous test alone cannot tell.
    expect(res.body.unlinkedInvoices).toEqual({ count: 0, totalAmount: 0 });
  });
});

// ===========================================================================
describe('by-matter: the next payment due', () => {
// ===========================================================================

  it('takes the next due day from the invoice\'s first unpaid installment', async () => {
    const matterId = await seedMatter(firm.id, { name: 'On A Plan' });
    const invoiceId = await seedInvoice(firm.id, {
      matterId,
      totalCents: 500_000,
      dueDate: '2026-12-31',
      nextPaymentDate: '2026-11-30',
      planEnabled: true,
      invoiceName: 'Retainer 3',
    });
    await seedInstallment(firm.id, invoiceId, {
      sortOrder: 0, dueDate: '2026-01-05', amountCents: 62_500, status: 'paid',
    });
    await seedInstallment(firm.id, invoiceId, {
      sortOrder: 1, dueDate: '2026-03-09', amountCents: 62_500, status: 'pending',
    });

    const res = await byMatter();

    // The PAID installment is skipped and the plan beats both fallback dates.
    // Reading the wrong installment tells the firm to chase money already
    // collected, and states the wrong amount next to it.
    expect(rowNamed(res.body, 'On A Plan')).toMatchObject({
      nextPaymentDate: '2026-03-09',
      nextPaymentAmount: 625,
      nextPaymentFromPlan: true,
      nextPaymentInvoiceName: 'Retainer 3',
    });
  });

  it('falls back to the invoice next-payment date when there is no plan', async () => {
    const matterId = await seedMatter(firm.id, { name: 'No Plan' });
    await seedInvoice(firm.id, {
      matterId, totalCents: 500_000, dueDate: '2026-12-31', nextPaymentDate: '2026-11-30',
    });

    const res = await byMatter();

    expect(rowNamed(res.body, 'No Plan')).toMatchObject({
      nextPaymentDate: '2026-11-30',
      // No plan means no installment amount to state, so the card shows the date
      // alone rather than inventing a figure from the balance.
      nextPaymentAmount: null,
      nextPaymentFromPlan: false,
    });
  });

  it('falls back to the invoice due date when there is no next-payment date', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Due Date Only' });
    await seedInvoice(firm.id, { matterId, totalCents: 500_000, dueDate: '2026-12-31' });

    const res = await byMatter();

    expect(rowNamed(res.body, 'Due Date Only').nextPaymentDate).toBe('2026-12-31');
  });

  it('states no next payment for a settled invoice', async () => {
    const paidMatter = await seedMatter(firm.id, { name: 'Paid Off' });
    await seedInvoice(firm.id, {
      matterId: paidMatter,
      totalCents: 500_000,
      amountPaidCents: 500_000,
      isPaid: true,
      dueDate: '2026-12-31',
    });
    const creditedMatter = await seedMatter(firm.id, { name: 'Credited' });
    await seedInvoice(firm.id, {
      matterId: creditedMatter,
      totalCents: 500_000,
      writtenOffCents: 500_000,
      status: 'credited',
      dueDate: '2026-12-31',
    });

    const res = await byMatter();

    // A due date on a settled invoice is a payment reminder for money the firm
    // already has, or has forgiven.
    expect(rowNamed(res.body, 'Paid Off').nextPaymentDate).toBeNull();
    expect(rowNamed(res.body, 'Credited').nextPaymentDate).toBeNull();
  });

  it('picks the soonest due day across the matter\'s invoices', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Several Invoices' });
    await seedInvoice(firm.id, { matterId, totalCents: 500_000, dueDate: '2026-12-31' });
    await seedInvoice(firm.id, { matterId, totalCents: 250_000, dueDate: '2026-03-09' });
    await seedInvoice(firm.id, { matterId, totalCents: 137_500, dueDate: '2026-08-20' });

    const res = await byMatter();

    expect(rowNamed(res.body, 'Several Invoices').nextPaymentDate).toBe('2026-03-09');
  });

  it('sorts by soonest payment first and puts matters with none last', async () => {
    const soon = await seedMatter(firm.id, { name: 'Soon' });
    await seedInvoice(firm.id, { matterId: soon, totalCents: 250_000, dueDate: '2026-03-09' });
    const later = await seedMatter(firm.id, { name: 'Later' });
    await seedInvoice(firm.id, { matterId: later, totalCents: 250_000, dueDate: '2026-08-20' });
    const never = await seedMatter(firm.id, { name: 'Never' });
    await seedTime(firm.id, { matterId: never, hours: 3.25 });

    const res = await byMatter();

    // The report's whole job is telling a firm what to chase first. `nulls last`
    // is the load-bearing half: without it every matter with no due date floats
    // to the top and buries the ones that are owed.
    expect(names(res.body)).toEqual(['Soon', 'Later', 'Never']);
  });
});

// ===========================================================================
describe('by-matter: filters, paging and options', () => {
// ===========================================================================

  it('searches the matter name', async () => {
    const hit = await seedMatter(firm.id, { name: 'Acme v. Globex' });
    await seedInvoice(firm.id, { matterId: hit, totalCents: 250_000 });
    const miss = await seedMatter(firm.id, { name: 'Estate of Turing' });
    await seedInvoice(firm.id, { matterId: miss, totalCents: 137_500 });

    const res = await byMatter('?search=globex');

    expect(names(res.body)).toEqual(['Acme v. Globex']);
    // The count describes the FILTERED set, not the firm. A header stating 2
    // over a page of 1 is the paging bug this pins.
    expect(res.body.totalItems).toBe(1);
  });

  it('searches the names of the clients on the matter', async () => {
    const client = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const hit = await seedMatter(firm.id, { name: 'Matter One' });
    await attachClient(firm.id, hit, client.id);
    await seedInvoice(firm.id, { matterId: hit, totalCents: 250_000 });
    const miss = await seedMatter(firm.id, { name: 'Matter Two' });
    await seedInvoice(firm.id, { matterId: miss, totalCents: 137_500 });

    const res = await byMatter('?search=hopper');

    expect(names(res.body)).toEqual(['Matter One']);
  });

  it('treats a wildcard in the search term as a literal character', async () => {
    const hit = await seedMatter(firm.id, { name: 'Acme v. Globex' });
    await seedInvoice(firm.id, { matterId: hit, totalCents: 250_000 });

    const res = await byMatter('?search=%25');

    // `%` reaching ILIKE unescaped matches every matter, so a user searching for
    // a literal percent sign gets the whole firm back.
    expect(res.body.rows).toEqual([]);
    expect(res.body.totalItems).toBe(0);
  });

  it('filters by matter status', async () => {
    const open = await seedMatter(firm.id, { name: 'Still Open', status: 'active' });
    await seedInvoice(firm.id, { matterId: open, totalCents: 250_000 });
    const shut = await seedMatter(firm.id, { name: 'Wrapped Up', status: 'closed' });
    await seedInvoice(firm.id, { matterId: shut, totalCents: 137_500 });

    const res = await byMatter('?status=closed');

    expect(names(res.body)).toEqual(['Wrapped Up']);
    expect(res.body.totalItems).toBe(1);
  });

  it('filters by practice-area NAME, not id', async () => {
    const family = await seedPracticeArea(firm.id, 'Family Law');
    const estates = await seedPracticeArea(firm.id, 'Estate Planning');
    const a = await seedMatter(firm.id, { name: 'Custody', practiceAreaId: family });
    await seedInvoice(firm.id, { matterId: a, totalCents: 250_000 });
    const b = await seedMatter(firm.id, { name: 'Will', practiceAreaId: estates });
    await seedInvoice(firm.id, { matterId: b, totalCents: 137_500 });

    const res = await byMatter('?practiceArea=Family%20Law');

    // The dropdown sends names, mirroring how its options are built. Matching on
    // the id instead would make every selection return nothing.
    expect(names(res.body)).toEqual(['Custody']);
    expect(res.body.totalItems).toBe(1);
  });

  it('offers only the practice areas of matters that appear in the report', async () => {
    const family = await seedPracticeArea(firm.id, 'Family Law');
    const estates = await seedPracticeArea(firm.id, 'Estate Planning');
    const billed = await seedMatter(firm.id, { name: 'Custody', practiceAreaId: family });
    await seedInvoice(firm.id, { matterId: billed, totalCents: 250_000 });
    // Reachable by neither time nor money, so it is not in the report at all.
    await seedMatter(firm.id, { name: 'Dormant Will', practiceAreaId: estates });
    // Reportable, but with no practice area: must not contribute an empty option.
    const bare = await seedMatter(firm.id, { name: 'No Area' });
    await seedInvoice(firm.id, { matterId: bare, totalCents: 137_500 });

    const res = await byMatter();

    // An option that selects nothing is a dead end the user cannot tell from a
    // firm with no such matters.
    expect(res.body.practiceAreas).toEqual(['Family Law']);
  });

  it('pages the rows while reporting the whole match count', async () => {
    for (const [name, dueDate] of [['A', '2026-03-09'], ['B', '2026-04-09'], ['C', '2026-05-09']]) {
      const id = await seedMatter(firm.id, { name });
      await seedInvoice(firm.id, { matterId: id, totalCents: 250_000, dueDate });
    }

    const first = await byMatter('?limit=2');
    const second = await byMatter('?limit=2&page=2');

    expect(names(first.body)).toEqual(['A', 'B']);
    expect(first.body.totalItems).toBe(3);
    expect(names(second.body)).toEqual(['C']);
    // The count must describe the match set, not the page: a second page
    // reporting 1 makes the UI drop the pager and hide page 1.
    expect(second.body.totalItems).toBe(3);
  });

  it('returns every matching row when no limit is given', async () => {
    for (const name of ['A', 'B', 'C']) {
      const id = await seedMatter(firm.id, { name });
      await seedInvoice(firm.id, { matterId: id, totalCents: 250_000 });
    }

    const res = await byMatter();

    expect(res.body.rows).toHaveLength(3);
    expect(res.body.totalItems).toBe(3);
  });
});

// ===========================================================================
describe('by-client: whose receivable is it', () => {
// ===========================================================================

  let client: ClientRecord;

  beforeEach(async () => {
    client = await createPersonClient(firm.id, { name: 'Ada Byron' });
  });

  it('bills a client for an invoice raised directly against them', async () => {
    await seedInvoice(firm.id, {
      clientContextId: client.id, clientId: client.id, totalCents: 88_800,
    });

    const res = await byClient();

    expect(res.status).toBe(200);
    expect(rowNamed(res.body, 'Ada Byron')).toMatchObject({
      invoiceCount: 1,
      totalBilled: 888,
      totalOutstanding: 888,
    });
  });

  it('bills a client for a matter invoice that names them', async () => {
    const other = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const matterId = await seedMatter(firm.id, { name: 'Shared Matter' });
    await attachClient(firm.id, matterId, client.id);
    await attachClient(firm.id, matterId, other.id);
    await seedInvoice(firm.id, { matterId, clientId: client.id, totalCents: 250_000 });

    const res = await byClient();

    // Named on a MULTI-client matter, so only the naming rule can attribute it.
    expect(rowNamed(res.body, 'Ada Byron').totalBilled).toBe(2500);
    expect(names(res.body)).toEqual(['Ada Byron']);
  });

  it('bills a matter invoice naming nobody to the matter\'s sole client', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Sole Client Matter' });
    await attachClient(firm.id, matterId, client.id);
    await seedInvoice(firm.id, { matterId, totalCents: 250_000 });

    const res = await byClient();

    expect(rowNamed(res.body, 'Ada Byron').totalBilled).toBe(2500);
    expect(res.body.unattributedInvoices).toEqual({ count: 0, totalAmount: 0 });
  });

  it('counts a NAMED invoice on a sole-client matter exactly once', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Sole And Named' });
    await attachClient(firm.id, matterId, client.id);
    // This invoice satisfies BOTH attribution shapes at once: it names the
    // client, and its matter has exactly one client. The two UNION branches are
    // kept mutually exclusive by the `client_id is null` guard on the second,
    // and without it the firm's receivable from this client doubles to $5,000.
    await seedInvoice(firm.id, { matterId, clientId: client.id, totalCents: 250_000 });

    const res = await byClient();

    expect(rowNamed(res.body, 'Ada Byron')).toMatchObject({
      invoiceCount: 1,
      totalBilled: 2500,
    });
  });

  it('gives a matter invoice naming nobody on a multi-client matter to no one, and says so', async () => {
    const other = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const matterId = await seedMatter(firm.id, { name: 'Two Payers' });
    await attachClient(firm.id, matterId, client.id);
    await attachClient(firm.id, matterId, other.id);
    await seedInvoice(firm.id, { matterId, totalCents: 250_000 });
    // A second, attributable invoice so the clients still have rows to inspect.
    await seedInvoice(firm.id, { matterId, clientId: client.id, totalCents: 137_500 });

    const res = await byClient();

    // Spreading it across both clients would state $2,500 owed by each and
    // double the firm's receivable. Naming it as unattributed is what keeps the
    // firm total the same across both groupings.
    expect(rowNamed(res.body, 'Ada Byron').totalBilled).toBe(1375);
    expect(names(res.body)).toEqual(['Ada Byron']);
    expect(res.body.unattributedInvoices).toEqual({ count: 1, totalAmount: 2500 });
  });

  it('does not double a client\'s totals when they are on two matters', async () => {
    const a = await seedMatter(firm.id, { name: 'Matter A' });
    const b = await seedMatter(firm.id, { name: 'Matter B' });
    await attachClient(firm.id, a, client.id);
    await attachClient(firm.id, b, client.id);
    await seedInvoice(firm.id, { matterId: a, totalCents: 250_000 });
    await seedInvoice(firm.id, { matterId: b, totalCents: 137_500 });
    await seedTime(firm.id, { matterId: a, hours: 3.25 });

    const res = await byClient();

    // Joining the matter list into the row rather than aggregating it first
    // multiplies every figure by the matter count.
    const row = rowNamed(res.body, 'Ada Byron');
    expect(row).toMatchObject({
      matterCount: 2,
      invoiceCount: 2,
      totalBilled: 3875,
      totalHours: 3.25,
    });
    expect(row.matterNames).toEqual(['Matter A', 'Matter B']);
  });

  // M12: several time entries and several invoices attributed to each of two
  // clients on ONE shared matter, so a query that joins the client_time and
  // client_invoices sources directly (instead of aggregating each first) would
  // multiply one client's entry_count against the OTHER's invoice_count, or
  // vice versa, moving both clients' totals in a way a single-fact fixture
  // cannot expose.
  it('attributes several time entries and several invoices to each client on a shared matter exactly once', async () => {
    const other = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const matterId = await seedMatter(firm.id, { name: 'Shared Compound Matter' });
    await attachClient(firm.id, matterId, client.id);
    await attachClient(firm.id, matterId, other.id);

    // Two entries named to Ada, one to Grace.
    await seedTime(firm.id, { matterId, hours: 2.22, matterClientIds: [client.id] });
    await seedTime(firm.id, { matterId, hours: 3.33, matterClientIds: [client.id] });
    await seedTime(firm.id, { matterId, hours: 4.44, matterClientIds: [other.id] });

    // Two invoices billed to Ada, one to Grace.
    await seedInvoice(firm.id, { matterId, clientId: client.id, totalCents: 10_000, amountPaidCents: 500 });
    await seedInvoice(firm.id, { matterId, clientId: client.id, totalCents: 20_000, amountPaidCents: 1_500 });
    await seedInvoice(firm.id, { matterId, clientId: other.id, totalCents: 30_000, amountPaidCents: 3_000 });

    const res = await byClient();

    const adaRow = rowNamed(res.body, 'Ada Byron');
    expect(adaRow.totalHours).toBeCloseTo(5.55, 2); // 2.22 + 3.33, never touched by Grace's 4.44
    expect(adaRow.invoiceCount).toBe(2);
    expect(adaRow.totalBilled).toBeCloseTo(300, 2); // (10000 + 20000) / 100
    expect(adaRow.totalOutstanding).toBeCloseTo(280, 2); // 300 - (5 + 15)

    const graceRow = rowNamed(res.body, 'Grace Hopper');
    expect(graceRow.totalHours).toBeCloseTo(4.44, 2);
    expect(graceRow.invoiceCount).toBe(1);
    expect(graceRow.totalBilled).toBeCloseTo(300, 2); // 30000 / 100
    expect(graceRow.totalOutstanding).toBeCloseTo(270, 2); // 300 - 30
  });

  it('applies the same money model as by-matter', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Money Model' });
    await attachClient(firm.id, matterId, client.id);
    await seedInvoice(firm.id, {
      matterId, totalCents: 500_000, amountPaidCents: 120_000, writtenOffCents: 30_000,
    });
    await seedInvoice(firm.id, { matterId, totalCents: 0, flatFeesCents: 73_450 });

    const res = await byClient();

    // A second implementation of the same arithmetic is a second place for it to
    // drift, and the two reports disagreeing is the visible failure.
    expect(rowNamed(res.body, 'Ada Byron')).toMatchObject({
      totalBilled: 5734.5,
      totalOutstanding: 4234.5,
    });
  });
});

// ===========================================================================
describe('by-client: whose hours are they', () => {
// ===========================================================================

  let client: ClientRecord;

  beforeEach(async () => {
    client = await createPersonClient(firm.id, { name: 'Ada Byron' });
  });

  it('counts client-context time against that client', async () => {
    await seedTime(firm.id, { clientId: client.id, hours: 3.25 });

    const res = await byClient();

    expect(rowNamed(res.body, 'Ada Byron')).toMatchObject({
      timeEntryCount: 1,
      totalHours: 3.25,
    });
  });

  it('counts matter time against the client the entry names', async () => {
    const other = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const matterId = await seedMatter(firm.id, { name: 'Shared Matter' });
    await attachClient(firm.id, matterId, client.id);
    await attachClient(firm.id, matterId, other.id);
    await seedTime(firm.id, { matterId, hours: 3.25, matterClientIds: [client.id] });

    const res = await byClient();

    expect(names(res.body)).toEqual(['Ada Byron']);
    expect(rowNamed(res.body, 'Ada Byron').totalHours).toBe(3.25);
  });

  it('charges a named entry on a MULTI-client matter to only the client it names', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Named On Multi Client' });
    const other = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    await attachClient(firm.id, matterId, client.id);
    await attachClient(firm.id, matterId, other.id);
    await seedTime(firm.id, { matterId, hours: 3.25, matterClientIds: [client.id] });

    const res = await byClient();

    // This case used to seed the single `matter_client_id` column and assert the
    // report fell back to it. Migration 0197 folded that column into
    // `matter_client_ids` and dropped it, so the array is now the only record of
    // who matter work was for, and the fallback branch is gone from the query.
    // The rule it was really testing is unchanged and is what is asserted here:
    // on a multi-client matter, a NAMED entry goes to the named client alone.
    // The sole-client fallback must not fire, and the other client must not
    // appear at all.
    expect(names(res.body)).toEqual(['Ada Byron']);
    expect(rowNamed(res.body, 'Ada Byron').totalHours).toBe(3.25);
  });

  it('counts unnamed matter time against the matter\'s sole client', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Sole Client Matter' });
    await attachClient(firm.id, matterId, client.id);
    await seedTime(firm.id, { matterId, hours: 3.25 });

    const res = await byClient();

    expect(rowNamed(res.body, 'Ada Byron').totalHours).toBe(3.25);
  });

  it('counts NAMED time on a sole-client matter exactly once', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Sole And Named' });
    await attachClient(firm.id, matterId, client.id);
    // Same double-count shape as the invoice case: the entry names the sole
    // client, so both attribution branches describe it, and only the "names
    // nobody" guard on the third branch keeps it from being counted twice.
    await seedTime(firm.id, { matterId, hours: 3.25, matterClientIds: [client.id] });

    const res = await byClient();

    expect(rowNamed(res.body, 'Ada Byron')).toMatchObject({
      timeEntryCount: 1,
      totalHours: 3.25,
    });
  });

  it('gives unnamed time on a multi-client matter to nobody', async () => {
    const other = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const matterId = await seedMatter(firm.id, { name: 'Two Payers' });
    await attachClient(firm.id, matterId, client.id);
    await attachClient(firm.id, matterId, other.id);
    await seedTime(firm.id, { matterId, hours: 9.75 });
    // One named entry so both clients still have rows and the absence of the
    // 9.75 is visible against a present row rather than an empty report.
    await seedTime(firm.id, { matterId, hours: 3.25, matterClientIds: [client.id] });
    await seedTime(firm.id, { matterId, hours: 1.5, matterClientIds: [other.id] });

    const res = await byClient();

    // 9.75 hours charged to two clients is 19.5 hours the firm never worked.
    expect(rowNamed(res.body, 'Ada Byron').totalHours).toBe(3.25);
    expect(rowNamed(res.body, 'Grace Hopper').totalHours).toBe(1.5);
  });

  it('charges an entry naming two clients to each of them', async () => {
    const other = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const matterId = await seedMatter(firm.id, { name: 'Joint Work' });
    await attachClient(firm.id, matterId, client.id);
    await attachClient(firm.id, matterId, other.id);
    await seedTime(firm.id, { matterId, hours: 3.25, matterClientIds: [client.id, other.id] });

    const res = await byClient();

    // Deliberate, and the counterpart of the rule above: work the timekeeper
    // EXPLICITLY charged to both parties is each party's hours. Only work that
    // named nobody is withheld.
    expect(rowNamed(res.body, 'Ada Byron').totalHours).toBe(3.25);
    expect(rowNamed(res.body, 'Grace Hopper').totalHours).toBe(3.25);
  });
});

// ===========================================================================
describe('by-client: which clients appear, and filters', () => {
// ===========================================================================

  it('omits a client with no time and no invoices', async () => {
    await createPersonClient(firm.id, { name: 'Dormant Client' });
    const active = await createPersonClient(firm.id, { name: 'Active Client' });
    await seedInvoice(firm.id, {
      clientContextId: active.id, clientId: active.id, totalCents: 88_800,
    });

    const res = await byClient();

    expect(names(res.body)).toEqual(['Active Client']);
    expect(res.body.totalItems).toBe(1);
  });

  it('includes a client on a matter they have logged time against but not been billed for', async () => {
    const client = await createPersonClient(firm.id, { name: 'Unbilled Client' });
    const matterId = await seedMatter(firm.id, { name: 'Work In Progress' });
    await attachClient(firm.id, matterId, client.id);
    await seedTime(firm.id, { matterId, hours: 3.25 });

    const res = await byClient();

    expect(rowNamed(res.body, 'Unbilled Client')).toMatchObject({
      totalHours: 3.25,
      invoiceCount: 0,
      totalBilled: 0,
    });
  });

  it('searches the client name and the names of their matters', async () => {
    const hopper = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const byron = await createPersonClient(firm.id, { name: 'Ada Byron' });
    const globex = await seedMatter(firm.id, { name: 'Acme v. Globex' });
    await attachClient(firm.id, globex, byron.id);
    await seedInvoice(firm.id, { matterId: globex, totalCents: 250_000 });
    await seedInvoice(firm.id, {
      clientContextId: hopper.id, clientId: hopper.id, totalCents: 137_500,
    });

    const byName = await byClient('?search=hopper');
    const byMatterName = await byClient('?search=globex');

    expect(names(byName.body)).toEqual(['Grace Hopper']);
    expect(byName.body.totalItems).toBe(1);
    // Reaching a client through their matter's name is what makes the search box
    // behave the same on both tabs of the report.
    expect(names(byMatterName.body)).toEqual(['Ada Byron']);
  });

  it('pages the rows while reporting the whole match count', async () => {
    for (const name of ['A Client', 'B Client', 'C Client']) {
      const c = await createPersonClient(firm.id, { name });
      await seedInvoice(firm.id, {
        clientContextId: c.id, clientId: c.id, totalCents: 88_800,
      });
    }

    const first = await byClient('?limit=2');
    const second = await byClient('?limit=2&page=2');

    expect(names(first.body)).toEqual(['A Client', 'B Client']);
    expect(first.body.totalItems).toBe(3);
    expect(names(second.body)).toEqual(['C Client']);
    expect(second.body.totalItems).toBe(3);
  });
});

// ===========================================================================
describe('the per-client matter breakdown', () => {
// ===========================================================================

  let client: ClientRecord;

  beforeEach(async () => {
    client = await createPersonClient(firm.id, { name: 'Ada Byron' });
  });

  it('breaks the client\'s roll-up down by matter and adds back up to the card', async () => {
    const a = await seedMatter(firm.id, { name: 'Matter A', status: 'active' });
    const b = await seedMatter(firm.id, { name: 'Matter B', status: 'closed' });
    await attachClient(firm.id, a, client.id);
    await attachClient(firm.id, b, client.id);
    await seedInvoice(firm.id, {
      matterId: a, totalCents: 500_000, amountPaidCents: 120_000, writtenOffCents: 30_000,
    });
    await seedInvoice(firm.id, { matterId: b, totalCents: 137_500 });
    await seedTime(firm.id, { matterId: a, hours: 3.25 });
    await seedTime(firm.id, { matterId: b, hours: 1.5 });

    const res = await breakdown(client.id);
    const card = rowNamed((await byClient()).body, 'Ada Byron');

    expect(res.status).toBe(200);
    expect(res.body.matters).toEqual([
      { id: a, name: 'Matter A', status: 'active', hours: 3.25, invoiceCount: 1, billed: 5000, outstanding: 3500 },
      { id: b, name: 'Matter B', status: 'closed', hours: 1.5, invoiceCount: 1, billed: 1375, outstanding: 1375 },
    ]);
    expect(res.body.totalItems).toBe(2);
    // The modal opens FROM the card. Two implementations of the same attribution
    // rules that disagree is the failure this exists to catch, and it is only
    // visible when both are computed over the same world.
    const sum = (k: string) => res.body.matters.reduce((t: number, m: any) => t + m[k], 0);
    expect(sum('billed')).toBe(card.totalBilled);
    expect(sum('outstanding')).toBe(card.totalOutstanding);
    expect(sum('hours')).toBe(card.totalHours);
  });

  it('lists a matter the client is on even when nothing is attached to it', async () => {
    const active = await seedMatter(firm.id, { name: 'Matter A' });
    const dormant = await seedMatter(firm.id, { name: 'Zero Matter' });
    await attachClient(firm.id, active, client.id);
    await attachClient(firm.id, dormant, client.id);
    await seedInvoice(firm.id, { matterId: active, totalCents: 250_000 });

    const res = await breakdown(client.id);

    // Deliberately the OPPOSITE of the list's activity gate: the modal answers
    // "what does this client have with us", so a matter with no money on it
    // still belongs in the answer, at zero.
    expect(res.body.matters.map((m: any) => m.name)).toEqual(['Matter A', 'Zero Matter']);
    expect(res.body.matters[1]).toMatchObject({
      hours: 0, invoiceCount: 0, billed: 0, outstanding: 0,
    });
  });

  it('excludes a matter the client is not on', async () => {
    const theirs = await seedMatter(firm.id, { name: 'Their Matter' });
    const notTheirs = await seedMatter(firm.id, { name: 'Someone Else' });
    await attachClient(firm.id, theirs, client.id);
    await seedInvoice(firm.id, { matterId: theirs, totalCents: 250_000 });
    await seedInvoice(firm.id, { matterId: notTheirs, totalCents: 999_900 });

    const res = await breakdown(client.id);

    expect(res.body.matters.map((m: any) => m.name)).toEqual(['Their Matter']);
    expect(res.body.matters[0].billed).toBe(2500);
  });

  it('excludes another client\'s named invoice on a shared matter', async () => {
    const other = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const matterId = await seedMatter(firm.id, { name: 'Shared Matter' });
    await attachClient(firm.id, matterId, client.id);
    await attachClient(firm.id, matterId, other.id);
    await seedInvoice(firm.id, { matterId, clientId: client.id, totalCents: 250_000 });
    await seedInvoice(firm.id, { matterId, clientId: other.id, totalCents: 999_900 });

    const res = await breakdown(client.id);

    // Both invoices hang off the same matter, so a breakdown that grouped by
    // matter without re-applying the attribution filter would bill Ada $12,499.
    expect(res.body.matters).toHaveLength(1);
    expect(res.body.matters[0]).toMatchObject({ billed: 2500, invoiceCount: 1 });
  });

  it('refuses a malformed client id instead of crashing on the uuid cast', async () => {
    const res = await breakdown('not-a-uuid');

    // Found by this suite. This is the one route in the module with no schema on
    // it, and `clientId` reaches the repository as a `$2::uuid` cast, so a
    // malformed value raised a Postgres cast error and answered 500
    // INTERNAL_ERROR with a support-ticket error id on it. A value that is not a
    // uuid names no client, which is a refusal, not a server fault.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('excludes another client\'s named time on a shared matter', async () => {
    const other = await createPersonClient(firm.id, { name: 'Grace Hopper' });
    const matterId = await seedMatter(firm.id, { name: 'Shared Matter' });
    await attachClient(firm.id, matterId, client.id);
    await attachClient(firm.id, matterId, other.id);
    await seedTime(firm.id, { matterId, hours: 3.25, matterClientIds: [client.id] });
    await seedTime(firm.id, { matterId, hours: 9.75, matterClientIds: [other.id] });
    // Unnamed on a multi-client matter: nobody's, so in neither breakdown.
    await seedTime(firm.id, { matterId, hours: 1.5 });

    const res = await breakdown(client.id);

    expect(res.body.matters).toHaveLength(1);
    expect(res.body.matters[0].hours).toBe(3.25);
  });
});

// ===========================================================================
describe('another firm\'s money never reaches this firm\'s report', () => {
// ===========================================================================
// Each of the three routes is a different query with its own scoping, so each is
// tested separately. Every case seeds data on the other firm that WOULD match if
// the scope were dropped; a report that came back empty either way would prove
// nothing.

  let otherFirm: Firm;
  let ourClient: ClientRecord;

  beforeEach(async () => {
    otherFirm = await createFirm({ name: 'Rival LLP' });
    await ownerOf(otherFirm.id);
    ourClient = await createPersonClient(firm.id, { name: 'Ada Byron' });
  });

  it('keeps another firm\'s matters, hours and unlinked money out of by-matter', async () => {
    const ours = await seedMatter(firm.id, { name: 'Our Matter' });
    await seedInvoice(firm.id, { matterId: ours, totalCents: 250_000 });
    await seedTime(firm.id, { matterId: ours, hours: 3.25 });

    const rivalArea = await seedPracticeArea(otherFirm.id, 'Rival Practice');
    const theirs = await seedMatter(otherFirm.id, {
      name: 'Rival Matter', practiceAreaId: rivalArea,
    });
    await seedInvoice(otherFirm.id, { matterId: theirs, totalCents: 999_900 });
    await seedTime(otherFirm.id, { matterId: theirs, hours: 9.75 });
    const rivalClient = await createPersonClient(otherFirm.id, { name: 'Rival Client' });
    await seedInvoice(otherFirm.id, {
      clientContextId: rivalClient.id, clientId: rivalClient.id, totalCents: 777_700,
    });

    const res = await byMatter();

    expect(names(res.body)).toEqual(['Our Matter']);
    expect(res.body.totalItems).toBe(1);
    expect(rowNamed(res.body, 'Our Matter')).toMatchObject({
      totalBilled: 2500, totalHours: 3.25,
    });
    // The header's own figures are separate queries and scope separately.
    expect(res.body.unlinkedInvoices).toEqual({ count: 0, totalAmount: 0 });
    expect(res.body.practiceAreas).toEqual([]);
  });

  it('keeps another firm\'s clients and cross-firm rows out of by-client', async () => {
    await seedInvoice(firm.id, {
      clientContextId: ourClient.id, clientId: ourClient.id, totalCents: 88_800,
    });
    await seedTime(firm.id, { clientId: ourClient.id, hours: 3.25 });

    // Their own client, with money: must not appear as a row at all.
    const rivalClient = await createPersonClient(otherFirm.id, { name: 'Rival Client' });
    await seedInvoice(otherFirm.id, {
      clientContextId: rivalClient.id, clientId: rivalClient.id, totalCents: 777_700,
    });
    // `invoices.client_id` / `client_context_id` and `time_entries.client_id` are
    // single-column FKs to `clients(id)`, so the rival firm can legally point
    // these rows at OUR client. Only `law_firm_id = $1` inside the CTEs keeps
    // their money and hours off our client's card.
    await seedInvoice(otherFirm.id, {
      clientContextId: ourClient.id, clientId: ourClient.id, totalCents: 999_900,
    });
    await seedTime(otherFirm.id, { clientId: ourClient.id, hours: 9.75 });

    const res = await byClient();

    expect(names(res.body)).toEqual(['Ada Byron']);
    expect(res.body.totalItems).toBe(1);
    expect(rowNamed(res.body, 'Ada Byron')).toMatchObject({
      invoiceCount: 1,
      totalBilled: 888,
      totalOutstanding: 888,
      totalHours: 3.25,
      timeEntryCount: 1,
    });
    expect(res.body.unattributedInvoices).toEqual({ count: 0, totalAmount: 0 });
  });

  it('returns nothing for a client id belonging to another firm', async () => {
    const rivalClient = await createPersonClient(otherFirm.id, { name: 'Rival Client' });
    const theirs = await seedMatter(otherFirm.id, { name: 'Rival Matter' });
    await attachClient(otherFirm.id, theirs, rivalClient.id);
    await seedInvoice(otherFirm.id, { matterId: theirs, totalCents: 999_900 });

    const res = await breakdown(rivalClient.id);

    // The id is real and has a full roll-up behind it in the firm that owns it.
    // Only `matter_clients.law_firm_id = $1` stands between this caller and it.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matters: [], totalItems: 0 });
  });

  it('keeps another firm\'s invoice against our client out of the breakdown', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Our Matter' });
    await attachClient(firm.id, matterId, ourClient.id);
    await seedInvoice(firm.id, { matterId, totalCents: 250_000 });
    await seedTime(firm.id, { matterId, hours: 3.25 });

    const theirs = await seedMatter(otherFirm.id, { name: 'Rival Matter' });
    await seedInvoice(otherFirm.id, {
      matterId: theirs, clientId: ourClient.id, totalCents: 999_900,
    });
    await seedTime(otherFirm.id, {
      matterId: theirs, hours: 9.75, matterClientIds: [ourClient.id],
    });

    const res = await breakdown(ourClient.id);

    expect(res.body.matters).toEqual([
      { id: matterId, name: 'Our Matter', status: 'active', hours: 3.25, invoiceCount: 1, billed: 2500, outstanding: 2500 },
    ]);
  });
});

// ===========================================================================
describe('who may read the reports', () => {
// ===========================================================================
// Neither `billing.viewInvoices` nor `billing.viewTimeEntries` is in
// DEFAULT_PERMISSIONS, so a financial read needs an explicit role grant.

  beforeEach(async () => {
    const matterId = await seedMatter(firm.id, { name: 'Our Matter' });
    await seedInvoice(firm.id, { matterId, totalCents: 250_000 });
  });

  it('refuses a member whose role grants nothing on all three reports', async () => {
    const member = await memberWith(firm.id, []);
    const client = await createPersonClient(firm.id, { name: 'Ada Byron' });

    const matter = await byMatter('', member);
    const clients = await byClient('', member);
    const detail = await breakdown(client.id, member);

    // A role with an EMPTY permission array, which is the strictest role the
    // model can express. If this ever turns red the baseline has gained a
    // financial read and the reports are open to every member.
    expect(matter.status).toBe(403);
    expect(JSON.stringify(matter.body)).not.toContain('Our Matter');
    expect(clients.status).toBe(403);
    expect(detail.status).toBe(403);
  });

  it('refuses a signed-in caller who is not a member of the firm', async () => {
    const outsider = stranger();
    const client = await createPersonClient(firm.id, { name: 'Ada Byron' });

    const matter = await byMatter('', outsider);
    const clients = await byClient('', outsider);
    const detail = await breakdown(client.id, outsider);

    expect(matter.status).toBe(403);
    expect(clients.status).toBe(403);
    expect(detail.status).toBe(403);
    // A refusal that leaked the figures in the body would be the same breach
    // with a different status code on it.
    expect(JSON.stringify(matter.body)).not.toContain('Our Matter');
  });

  it('refuses a member of one firm reading another firm\'s reports', async () => {
    const otherFirm = await createFirm({ name: 'Rival LLP' });
    const rivalOwner = await ownerOf(otherFirm.id);

    const res = await byMatter('', rivalOwner);

    // An owner, and still refused: ownership is per firm, and this is the
    // cross-tenant read the whole permission layer exists to stop.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Our Matter');
  });

  it('refuses an unauthenticated caller', async () => {
    const { request } = require('../support/app');

    const res = await request().get(`${base()}/by-matter`).set('x-timezone', 'America/New_York');

    expect(res.status).toBe(401);
  });
});

/**
 * GET /billing/analytics/billing-summary — the firm's billing headline figures.
 *
 * The module had no test at all. Every field it returns is a NUMBER a firm reads
 * as fact: what it has billed, what it has collected, what it is still owed, and
 * how much of that is late. Nothing here fails visibly. A dropped write-off term,
 * a cents figure emitted where dollars were meant, a status filter that misses
 * partially-paid invoices, or a lost `law_firm_id` all render as a perfectly
 * composed dashboard stating the wrong number. So every case below asserts an
 * AMOUNT or a COUNT, never a status code alone, and the seeded values avoid 0 and
 * 100, where a dropped term or a x100 slip still looks plausible.
 *
 * Five properties carry the endpoint.
 *
 *   THE MONEY MODEL. `totalBilled` is the effective invoice total (the invoice
 *   total, or the flat-fee amount when the total is zero); `totalCollected` is
 *   `amount_paid_cents`; `totalOutstanding` is total less payments less
 *   write-offs, floored at zero. Storage is integer cents and the API speaks
 *   dollars, so each figure is asserted on the dollar side against a cent-valued
 *   seed.
 *
 *   TWO DIFFERENT DEFINITIONS OF "STILL OWED". `awaiting*` is
 *   `UNPAID_STATUS_KEYS` (outstanding | overdue | partially_paid) AND a positive
 *   balance. `overdue*` is `isInvoicePastDue`, which is deliberately NOT
 *   `status === 'overdue'`: `deriveInvoiceStatus` buckets any part-paid invoice as
 *   'partially_paid' before it ever reaches the overdue branch, so a status filter
 *   silently undercounts late AR. Both definitions get their own case, including
 *   the two edges that separate them from a naive filter: a part-paid-and-late
 *   invoice, and a zero-total invoice that reports 'outstanding' while owing
 *   nothing.
 *
 *   MEMBER SCOPE IS NOT UNIFORM, AND THAT IS THE DESIGN. `totalMatters` and the
 *   matter half of `unbilledTimeEntryCount` run through `listAccessibleMatters`,
 *   so a non-owner member sees only matters they are on (the ethical wall). The
 *   accounts-receivable totals deliberately do NOT: they are read from
 *   `firmInvoiceMoneyRecords` over every invoice in the firm, because a firm's
 *   books are not one attorney's books. Both halves are pinned, because a change
 *   in either direction is invisible on screen.
 *
 *   THE VIEWER'S CALENDAR. "This month" is the viewer's month, resolved through
 *   `Intl` in `req.tz`, and `totalRevenueThisMonth` projects each invoice's
 *   `created_at` instant into that same zone with `zonedDayString`. Near a month
 *   boundary a New York viewer and a UTC viewer are legitimately in different
 *   months, and the same seeded world must report different figures to each. Two
 *   cases pin exactly that, and neither side is an empty result.
 *
 *   TENANT SCOPE. `invoices.client_context_id` and `time_entries.client_id` are
 *   SINGLE-column foreign keys to `clients(id)`, with no firm in them, so another
 *   firm's row can legally carry THIS firm's client id. The isolation cases seed
 *   exactly that row rather than an unrelated firm whose data could never have
 *   matched anyway, and they assert the other firm's owner DOES see it, so an
 *   empty result can never be the reason they pass.
 *
 * THE GATE. The route sits behind `requireFeature('analytics')`, which
 * `planDefinitions.ts` gives to professional and enterprise only. Its own
 * permission is `billing.viewInvoices`, which is NOT in `DEFAULT_PERMISSIONS`:
 * financial reads need an explicit grant, so a member whose role carries no
 * codes is refused (covered under "who may read the summary"). The two gates
 * also deny a firm on a plan without analytics, a firm that opted the feature
 * out, and a caller who is not a member.
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
  freezeClockAt,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const path = (lawFirmId: string) =>
  `/api/lawfirms/${lawFirmId}/billing/analytics/billing-summary`;

// ---------------------------------------------------------------------------
// Fixtures. Plain SQL through the test pool, never the code under test: a
// fixture built by the repository cannot fail when the repository is wrong.
// ---------------------------------------------------------------------------

async function seedMatter(lawFirmId: string, name?: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, $3, $4, 'active')`,
    [id, lawFirmId, name ?? `Matter ${id.slice(0, 8)}`, `REF-${id.slice(0, 8)}`],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** Put a member on a matter. This is what the ethical wall reads. */
async function joinMatter(lawFirmId: string, matterId: string, userId: string) {
  const res = await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
     values ($1, $2, $3, 'member', now())`,
    [matterId, userId, lawFirmId],
  );
  expect(res.rowCount).toBe(1);
}

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
  /** The stored column, which the summary must never read as truth. */
  status?: string;
  dueDate?: string | null;
  nextPaymentDate?: string | null;
  /** An explicit instant, because `totalRevenueThisMonth` reads created_at. */
  createdAt?: string;
}

/**
 * An invoice. A CHECK constraint requires EXACTLY ONE of `matter_id` /
 * `client_context_id`, which is how the schema distinguishes a matter invoice
 * from a client-level one; `client_id` is separately the billed client.
 *
 * `created_at` is settable because it is the day `totalRevenueThisMonth` buckets
 * on. Leaving it to the column default ties every month case to whatever day the
 * suite happens to run, which is how a month-boundary test passes for a reason
 * that has nothing to do with the code.
 */
async function seedInvoice(lawFirmId: string, opts: InvoiceOpts): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invoices
       (id, law_firm_id, matter_id, client_context_id, client_id, context_type,
        invoice_number, status, total_cents, flat_fees_amount_cents,
        amount_paid_cents, total_written_off_cents, is_paid,
        invoice_date, due_date, next_payment_date, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             current_date, $14, $15, coalesce($16::timestamptz, now()))`,
    [
      id,
      lawFirmId,
      opts.matterId ?? null,
      opts.clientContextId ?? null,
      opts.clientId ?? null,
      opts.matterId ? 'matter' : 'client',
      `INV-${id.slice(0, 8)}`,
      opts.status ?? 'outstanding',
      opts.totalCents ?? 0,
      opts.flatFeesCents ?? 0,
      opts.amountPaidCents ?? 0,
      opts.writtenOffCents ?? 0,
      opts.isPaid ?? false,
      opts.dueDate ?? null,
      opts.nextPaymentDate ?? null,
      opts.createdAt ?? null,
    ],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** One recorded payment against an invoice. Separate from `amount_paid_cents`. */
async function seedPayment(
  lawFirmId: string,
  invoiceId: string,
  amountCents: number,
  sortOrder: number,
) {
  const res = await testPool.query(
    `insert into invoice_payments (invoice_id, law_firm_id, sort_order, amount_cents, payment_date)
     values ($1, $2, $3, $4, '2026-01-15')`,
    [invoiceId, lawFirmId, sortOrder, amountCents],
  );
  expect(res.rowCount).toBe(1);
}

interface TimeOpts {
  matterId?: string | null;
  clientId?: string | null;
  hours: number;
  /** Day-only 'YYYY-MM-DD'. Always explicit: this is what "this month" reads. */
  date: string;
  userId?: string | null;
}

/**
 * A time entry. A CHECK constraint requires exactly one of `matter_id` /
 * `client_id`, so matter work and client-context work are separate shapes.
 */
async function seedTime(lawFirmId: string, opts: TimeOpts): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, client_id, user_id, activity_date, hours, billable)
     values ('time', $1, $2, $3, $4, $5, $6, $7, true)`,
    [
      id,
      lawFirmId,
      opts.matterId ?? null,
      opts.clientId ?? null,
      opts.userId ?? null,
      opts.date,
      opts.hours,
    ],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/**
 * Put a time entry onto an invoice as a line item, which is the ONLY
 * authoritative "billed" signal (`time_entries.billed` is never maintained; see
 * billingReads.isSourceBilled). The invoice must be in the same billing context
 * as the entry, because `collectBilledIds` is built per context.
 */
async function billTimeEntry(lawFirmId: string, invoiceId: string, timeEntryId: string) {
  const res = await testPool.query(
    `insert into invoice_line_items (invoice_id, law_firm_id, kind, sort_order, source_id, amount_cents)
     values ($1, $2, 'time_entry', 0, $3, 0)`,
    [invoiceId, lawFirmId, timeEntryId],
  );
  expect(res.rowCount).toBe(1);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * The summary body, with the 200 asserted first. Reading figures off a body the
 * route never produced is how "the number is absent" passes as "the number is
 * correctly zero".
 */
async function figures(
  { actor = owner, lawFirmId = firm.id, tz }: { actor?: Actor; lawFirmId?: string; tz?: string } = {},
): Promise<any> {
  let req = actor.api.get(path(lawFirmId));
  if (tz) req = req.set('x-timezone', tz);
  const res = await req;
  expect(res.status).toBe(200);
  return res.body;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

// ===========================================================================
describe('the money model', () => {
// ===========================================================================

  it('reports billed, collected and outstanding in dollars off the cent columns', async () => {
    // Red when: a figure is emitted in cents, an invoice context is dropped from
    // the sum, or the outstanding subtraction loses a term.
    const matter = await seedMatter(firm.id);
    const client = await createPersonClient(firm.id);

    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 128_650,
      amountPaidCents: 41_325,
      dueDate: '2099-01-01',
    });
    await seedInvoice(firm.id, {
      clientContextId: client.id,
      clientId: client.id,
      totalCents: 267_400,
      writtenOffCents: 52_800,
      dueDate: '2099-01-01',
    });

    const body = await figures();

    // 1286.50 + 2674.00
    expect(body.totalBilled).toBe(3960.5);
    expect(body.totalCollected).toBe(413.25);
    // (1286.50 - 413.25) + (2674.00 - 528.00)
    expect(body.totalOutstanding).toBe(3019.25);
    expect(body.totalInvoices).toBe(2);
  });

  it('subtracts write-offs from outstanding, not only payments', async () => {
    // Red when: the `totalWrittenOff` term is dropped from remainingBalance. The
    // invoice carries no payments at all, so a payments-only subtraction leaves
    // the full 2674.00 standing and the firm chases money it forgave.
    const client = await createPersonClient(firm.id);
    await seedInvoice(firm.id, {
      clientContextId: client.id,
      totalCents: 267_400,
      writtenOffCents: 52_800,
      dueDate: '2099-01-01',
    });

    const body = await figures();

    expect(body.totalBilled).toBe(2674);
    expect(body.totalCollected).toBe(0);
    expect(body.totalOutstanding).toBe(2146);
  });

  it('bills the stored total, not the flat fees, when the invoice total is zero', async () => {
    // Red when: a flat-fee fallback returns to `getInvoiceTotal`, so analytics
    // bills money the invoice itself does not ask for.
    const matter = await seedMatter(firm.id);
    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 0,
      flatFeesCents: 61_450,
      dueDate: '2099-01-01',
    });
    // A billed neighbour, so the zero above is not an empty response.
    await seedInvoice(firm.id, { matterId: matter, totalCents: 10_000, dueDate: '2099-01-01' });

    const body = await figures();

    expect(body.totalBilled).toBe(100);
    expect(body.totalOutstanding).toBe(100);
    expect(body.awaitingAmount).toBe(100);
  });

  it('counts money collected once when an invoice was paid in two installments', async () => {
    // Red when: collected money is re-derived by summing `invoice_payments` on
    // top of `amount_paid_cents`. The two rows sum to exactly the column, so a
    // double count doubles the figure rather than shifting it by dust.
    const matter = await seedMatter(firm.id);
    const invoice = await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 128_650,
      amountPaidCents: 41_325,
      dueDate: '2099-01-01',
    });
    await seedPayment(firm.id, invoice, 20_000, 0);
    await seedPayment(firm.id, invoice, 21_325, 1);

    const body = await figures();

    expect(body.totalCollected).toBe(413.25);
    expect(body.totalOutstanding).toBe(873.25);
    expect(body.totalInvoices).toBe(1);
  });

  it('counts a matter invoice once even when the matter carries several clients', async () => {
    // Red when: the money records are rebuilt per matter-client rather than per
    // invoice. A three-client matter is where that fan-out triples a total while
    // every individual invoice still renders correctly.
    const matter = await seedMatter(firm.id);
    const first = await createPersonClient(firm.id, { name: 'First Co-client' });
    const second = await createPersonClient(firm.id, { name: 'Second Co-client' });
    const third = await createPersonClient(firm.id, { name: 'Third Co-client' });
    await attachClient(firm.id, matter, first.id);
    await attachClient(firm.id, matter, second.id);
    await attachClient(firm.id, matter, third.id);

    await seedInvoice(firm.id, {
      matterId: matter,
      clientId: first.id,
      totalCents: 84_900,
      dueDate: '2099-01-01',
    });

    const body = await figures();

    expect(body.totalInvoices).toBe(1);
    expect(body.totalBilled).toBe(849);
    expect(body.totalOutstanding).toBe(849);
    expect(body.awaitingCount).toBe(1);
  });

  it('derives every figure from the amounts, not the stored status column', async () => {
    // Red when: the summary trusts `invoices.status`. The column here says the
    // invoice is paid while its amounts say the firm is still owed 849.00, which
    // is the exact shape a stale status writeback leaves behind.
    const client = await createPersonClient(firm.id);
    await seedInvoice(firm.id, {
      clientContextId: client.id,
      totalCents: 84_900,
      status: 'paid',
      isPaid: false,
      dueDate: '2099-01-01',
    });

    const body = await figures();

    expect(body.totalOutstanding).toBe(849);
    expect(body.awaitingCount).toBe(1);
    expect(body.awaitingAmount).toBe(849);
    expect(body.totalCollected).toBe(0);
  });
});

// ===========================================================================
describe('what the firm is still owed', () => {
// ===========================================================================

  it('counts a part-paid invoice past its due date as overdue, though its status is partially_paid', async () => {
    // Red when: the overdue bucket is filtered as `status === 'overdue'`.
    // `deriveInvoiceStatus` returns 'partially_paid' for anything with a payment
    // on it, before the overdue branch is ever reached, so a status filter
    // reports this firm as having no late money at all.
    const matter = await seedMatter(firm.id);
    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 200_000,
      amountPaidCents: 35_000,
      dueDate: '2000-01-01',
    });

    const body = await figures();

    expect(body.overdueCount).toBe(1);
    expect(body.overdueAmount).toBe(1650);
    expect(body.awaitingCount).toBe(1);
    expect(body.awaitingAmount).toBe(1650);
  });

  it('leaves a fully paid invoice out of awaiting and overdue, however late it is', async () => {
    // Red when: the settled-invoice guard is lost. The paid invoice is years past
    // due, so it lands in both buckets the moment the balance check stops
    // governing. The second invoice keeps the expected figures non-zero, so a
    // route that returned nothing at all could not pass this.
    const matter = await seedMatter(firm.id);
    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 173_400,
      amountPaidCents: 173_400,
      isPaid: true,
      dueDate: '2000-01-01',
    });
    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 84_900,
      dueDate: '2099-01-01',
    });

    const body = await figures();

    expect(body.totalBilled).toBe(2583);
    expect(body.totalCollected).toBe(1734);
    expect(body.awaitingCount).toBe(1);
    expect(body.awaitingAmount).toBe(849);
    expect(body.overdueCount).toBe(0);
    expect(body.overdueAmount).toBe(0);
  });

  it('treats a written-off invoice as settled rather than awaiting', async () => {
    // Red when: 'credited' is folded into the unpaid statuses, or the balance
    // check stops running. A forgiven debt re-entering AR is how a firm chases a
    // client for money it already wrote off.
    const client = await createPersonClient(firm.id);
    await seedInvoice(firm.id, {
      clientContextId: client.id,
      totalCents: 267_400,
      writtenOffCents: 267_400,
      dueDate: '2000-01-01',
    });
    await seedInvoice(firm.id, {
      clientContextId: client.id,
      totalCents: 84_900,
      dueDate: '2099-01-01',
    });

    const body = await figures();

    expect(body.totalBilled).toBe(3523);
    expect(body.totalInvoices).toBe(2);
    expect(body.awaitingCount).toBe(1);
    expect(body.awaitingAmount).toBe(849);
    expect(body.totalOutstanding).toBe(849);
  });

  it('keeps a zero-total invoice out of awaiting even though its status is outstanding', async () => {
    // Red when: the `remainingBalance > 0` term is dropped from the awaiting
    // predicate. An empty invoice never reports 'paid' (there was nothing to
    // pay), so the status alone puts it in the awaiting count and the firm's
    // "invoices still owing" badge inflates with placeholders.
    const matter = await seedMatter(firm.id);
    await seedInvoice(firm.id, { matterId: matter, totalCents: 0, flatFeesCents: 0 });
    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 84_900,
      dueDate: '2099-01-01',
    });

    const body = await figures();

    expect(body.totalInvoices).toBe(2);
    expect(body.awaitingCount).toBe(1);
    expect(body.awaitingAmount).toBe(849);
  });

  it('prefers the next payment date over the due date when deciding late', async () => {
    // Red when: `nextPaymentDate` stops taking precedence. The due date here is
    // decades away and the next payment decades past, so the two columns cannot
    // both produce this answer.
    const matter = await seedMatter(firm.id);
    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 137_500,
      dueDate: '2099-01-01',
      nextPaymentDate: '2000-01-01',
    });

    const body = await figures();

    expect(body.overdueCount).toBe(1);
    expect(body.overdueAmount).toBe(1375);
  });
});

// ===========================================================================
describe("this month, in the viewer's calendar", () => {
// ===========================================================================

  it('counts only hours logged on or after the first of the month', async () => {
    // Red when: the month-start comparison is dropped and every hour the firm
    // ever logged is reported as this month's.
    const matter = await seedMatter(firm.id);
    await seedTime(firm.id, { matterId: matter, hours: 4.25, date: '2026-05-10' });
    await seedTime(firm.id, { matterId: matter, hours: 2.6, date: '2026-05-01' });
    await seedTime(firm.id, { matterId: matter, hours: 9.5, date: '2026-04-28' });

    freezeClockAt('2026-05-20T12:00:00-04:00');
    const body = await figures();

    expect(body.totalHoursThisMonth).toBe(6.85);
    // The excluded entry is real work that still exists, so the figure above is
    // a filter result and not an empty world.
    expect(body.unbilledTimeEntryCount).toBe(3);
  });

  it('counts only hours logged BEFORE the first of next month', async () => {
    // Red when: the month window carries only a lower bound, so an entry dated
    // in a future month is reported as this month's work. The dashboard's
    // `hoursThisWeek` carried the identical defect; both are fixed together.
    const matter = await seedMatter(firm.id);
    await seedTime(firm.id, { matterId: matter, hours: 4.25, date: '2026-05-10' });
    await seedTime(firm.id, { matterId: matter, hours: 8, date: '2026-06-03' });

    freezeClockAt('2026-05-20T12:00:00-04:00');
    const body = await figures();

    expect(body.totalHoursThisMonth).toBe(4.25);
    // Both halves. The June entry exists and is unbilled, so the figure above
    // is a filter result rather than a world with one entry in it.
    expect(body.unbilledTimeEntryCount).toBe(2);
  });

  it("resolves the month in the viewer's zone, so New York is still in March when UTC has rolled to April", async () => {
    // Red when: the month start is computed off the server's UTC month. The same
    // seeded world must answer differently to the two viewers, and neither answer
    // is empty, so a route that ignored the header could not produce both.
    const matter = await seedMatter(firm.id);
    await seedTime(firm.id, { matterId: matter, hours: 4.25, date: '2026-03-20' });
    await seedTime(firm.id, { matterId: matter, hours: 7.75, date: '2026-04-01' });

    // 2026-03-31 22:00 in New York; 2026-04-01 02:00 in UTC.
    freezeClockAt('2026-04-01T02:00:00Z');

    const newYork = await figures({ tz: 'America/New_York' });
    const utc = await figures({ tz: 'UTC' });

    // March for New York, April for UTC, from one seeded world. Each viewer
    // sees exactly the entry that falls in THEIR month, and the two answers are
    // disjoint, so neither can be produced by a route that ignored the header.
    //
    // This case previously expected 12 for New York, which was the open-ended
    // window speaking: it counted the 1 April entry as part of a March viewer's
    // month. The window is now bounded at both ends, so it does not.
    expect(newYork.totalHoursThisMonth).toBe(4.25);
    expect(utc.totalHoursThisMonth).toBe(7.75);
  });

  it("counts revenue from the invoice's creation instant, not every invoice on the books", async () => {
    // Red when: the revenue figure stops filtering by month and becomes a second
    // copy of totalBilled. The two must not agree here.
    const matter = await seedMatter(firm.id);
    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 91_800,
      createdAt: '2026-04-02T15:00:00Z',
      dueDate: '2099-01-01',
    });
    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 43_100,
      createdAt: '2026-03-28T15:00:00Z',
      dueDate: '2099-01-01',
    });

    freezeClockAt('2026-04-15T12:00:00-04:00');
    const body = await figures();

    expect(body.totalBilled).toBe(1349);
    expect(body.totalRevenueThisMonth).toBe(918);
  });

  it("projects an invoice's creation instant into the viewer's zone before bucketing it", async () => {
    // Red when: `zonedDayString` is replaced by a UTC day. The first invoice was
    // created at 22:00 on March 31st in New York and 02:00 on April 1st in UTC,
    // so it belongs to April for exactly one of the two viewers. The second
    // invoice keeps both answers non-zero.
    const client = await createPersonClient(firm.id);
    await seedInvoice(firm.id, {
      clientContextId: client.id,
      totalCents: 91_800,
      createdAt: '2026-04-01T02:00:00Z',
      dueDate: '2099-01-01',
    });
    await seedInvoice(firm.id, {
      clientContextId: client.id,
      totalCents: 25_600,
      createdAt: '2026-04-10T12:00:00Z',
      dueDate: '2099-01-01',
    });

    freezeClockAt('2026-04-15T12:00:00-04:00');

    const newYork = await figures({ tz: 'America/New_York' });
    const utc = await figures({ tz: 'UTC' });

    expect(newYork.totalRevenueThisMonth).toBe(256);
    expect(utc.totalRevenueThisMonth).toBe(1174);
    // Both viewers see the same books; only the month boundary moved.
    expect(newYork.totalBilled).toBe(1174);
    expect(utc.totalBilled).toBe(1174);
  });

  it("rolls the overdue line at the viewer's midnight, not the server's", async () => {
    // Red when: the past-due comparison stops threading `req.tz`. The invoice is
    // due on the day it is still evening of in New York and already yesterday in
    // UTC, so the same invoice is late for exactly one of the two viewers.
    const matter = await seedMatter(firm.id);
    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 137_500,
      dueDate: '2026-03-14',
    });

    // 2026-03-14 22:00 in New York; 2026-03-15 02:00 in UTC.
    freezeClockAt('2026-03-15T02:00:00Z');

    const newYork = await figures({ tz: 'America/New_York' });
    const utc = await figures({ tz: 'UTC' });

    expect(newYork.overdueCount).toBe(0);
    expect(newYork.overdueAmount).toBe(0);
    expect(utc.overdueCount).toBe(1);
    expect(utc.overdueAmount).toBe(1375);
    // Not-yet-late is still owed, on both sides of the boundary.
    expect(newYork.awaitingAmount).toBe(1375);
    expect(utc.awaitingAmount).toBe(1375);
  });
});

// ===========================================================================
describe('the badge counts', () => {
// ===========================================================================

  it('counts time entries still waiting to be invoiced, not their hours', async () => {
    // Red when: the unbilled count starts summing hours, or the line-item lookup
    // that marks an entry billed is lost. The hours are deliberately unequal to
    // the count so the two cannot be confused.
    const matter = await seedMatter(firm.id);
    const invoice = await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 84_900,
      dueDate: '2099-01-01',
    });
    const billed = await seedTime(firm.id, { matterId: matter, hours: 5.5, date: '2026-05-10' });
    await seedTime(firm.id, { matterId: matter, hours: 3.25, date: '2026-05-11' });
    await seedTime(firm.id, { matterId: matter, hours: 2.75, date: '2026-05-12' });
    await billTimeEntry(firm.id, invoice, billed);

    freezeClockAt('2026-05-20T12:00:00-04:00');
    const body = await figures();

    expect(body.unbilledTimeEntryCount).toBe(2);
    // The billed entry's hours still count as work done this month.
    expect(body.totalHoursThisMonth).toBe(11.5);
  });

  it('counts every matter the caller can reach', async () => {
    // Red when: the matter count stops reading the accessible-matter list. An
    // owner reaches all three.
    await seedMatter(firm.id);
    await seedMatter(firm.id);
    await seedMatter(firm.id);

    const body = await figures();

    expect(body.totalMatters).toBe(3);
  });
});

// ===========================================================================
describe('member scope', () => {
// ===========================================================================

  it('shows a member only the matters they are on, while the firm AR stays firm-wide', async () => {
    // Red when: either half of the asymmetry flips. Narrowing the AR totals to a
    // member's own matters drops every other attorney's outstanding balance from
    // the firm's books; widening `totalMatters` walks through the ethical wall.
    const theirs = await seedMatter(firm.id, 'Their matter');
    const other = await seedMatter(firm.id, 'Another attorney matter');
    await seedMatter(firm.id, 'A third matter');

    const member = await memberWith(firm.id, ['billing.viewInvoices']);
    await joinMatter(firm.id, theirs, member.uid);

    await seedInvoice(firm.id, {
      matterId: theirs,
      totalCents: 84_900,
      dueDate: '2099-01-01',
    });
    await seedInvoice(firm.id, {
      matterId: other,
      totalCents: 267_400,
      dueDate: '2099-01-01',
    });

    const asMember = await figures({ actor: member });
    const asOwner = await figures();

    expect(asMember.totalMatters).toBe(1);
    expect(asOwner.totalMatters).toBe(3);

    // The books are the firm's, so both callers read the same receivables.
    expect(asMember.totalBilled).toBe(3523);
    expect(asOwner.totalBilled).toBe(3523);
    expect(asMember.totalOutstanding).toBe(3523);
    expect(asMember.totalInvoices).toBe(2);
    expect(asMember.awaitingAmount).toBe(3523);
  });

  it('drops another attorney\'s matter work from a member\'s time figures but keeps client-context work', async () => {
    // Red when: the matter half stops running through the accessible-matter list,
    // or the client half starts being filtered by it. Client-context work has no
    // matter to be walled off by, and the summary counts it for every member.
    const theirs = await seedMatter(firm.id, 'Their matter');
    const other = await seedMatter(firm.id, 'Another attorney matter');
    const client = await createPersonClient(firm.id);

    const member = await memberWith(firm.id, ['billing.viewInvoices']);
    await joinMatter(firm.id, theirs, member.uid);

    await seedTime(firm.id, { matterId: theirs, hours: 4.25, date: '2026-05-10' });
    await seedTime(firm.id, { matterId: other, hours: 6.5, date: '2026-05-11' });
    await seedTime(firm.id, { clientId: client.id, hours: 1.75, date: '2026-05-12' });

    freezeClockAt('2026-05-20T12:00:00-04:00');

    const asMember = await figures({ actor: member });
    const asOwner = await figures();

    expect(asMember.unbilledTimeEntryCount).toBe(2);
    expect(asMember.totalHoursThisMonth).toBe(6);
    expect(asOwner.unbilledTimeEntryCount).toBe(3);
    expect(asOwner.totalHoursThisMonth).toBe(12.5);
  });
});

// ===========================================================================
describe('tenant isolation', () => {
// ===========================================================================

  it("never counts another firm's invoices, including one carrying this firm's client id", async () => {
    // `invoices.client_context_id` is a single-column FK to `clients(id)` with no
    // firm in it, so the neighbour's invoice below is a legal row pointing at THIS
    // firm's client. Only `law_firm_id = $1` inside findForFirmByContext keeps its
    // money out of these figures.
    const client = await createPersonClient(firm.id);
    await seedInvoice(firm.id, {
      clientContextId: client.id,
      totalCents: 84_900,
      dueDate: '2099-01-01',
    });

    const neighbour = await createFirm();
    const neighbourOwner = await ownerOf(neighbour.id);
    await seedInvoice(neighbour.id, {
      clientContextId: client.id,
      totalCents: 555_500,
      amountPaidCents: 111_100,
      dueDate: '2000-01-01',
    });

    const mine = await figures();

    expect(mine.totalInvoices).toBe(1);
    expect(mine.totalBilled).toBe(849);
    expect(mine.totalCollected).toBe(0);
    expect(mine.totalOutstanding).toBe(849);
    expect(mine.overdueCount).toBe(0);

    // The neighbour's invoice exists and is reachable, so the zeros above are a
    // scope result rather than an empty database.
    const theirs = await figures({ actor: neighbourOwner, lawFirmId: neighbour.id });
    expect(theirs.totalBilled).toBe(5555);
    expect(theirs.totalCollected).toBe(1111);
    expect(theirs.overdueCount).toBe(1);
  });

  it("never counts another firm's matters or time entries", async () => {
    // Same shape on the time side: `time_entries.client_id` is also a bare FK to
    // `clients(id)`, so the neighbour's client-context entry below legally names
    // THIS firm's client. It is the row that matters: this firm's own
    // client-context read is demonstrably live (its own 1.5-hour entry is
    // counted), and the firm's client list contains the very client that entry
    // points at, so the only thing keeping those 6.25 hours out of these figures
    // is `te.law_firm_id = $1` in listTimeEntriesForFirm.
    const client = await createPersonClient(firm.id);
    const matter = await seedMatter(firm.id);
    await seedTime(firm.id, { matterId: matter, hours: 3.25, date: '2026-05-10' });
    await seedTime(firm.id, { clientId: client.id, hours: 1.5, date: '2026-05-10' });

    const neighbour = await createFirm();
    const neighbourOwner = await ownerOf(neighbour.id);
    const neighbourMatter = await seedMatter(neighbour.id);
    await seedTime(neighbour.id, { matterId: neighbourMatter, hours: 8.5, date: '2026-05-10' });
    await seedTime(neighbour.id, { clientId: client.id, hours: 6.25, date: '2026-05-11' });

    freezeClockAt('2026-05-20T12:00:00-04:00');

    const mine = await figures();
    expect(mine.totalMatters).toBe(1);
    expect(mine.unbilledTimeEntryCount).toBe(2);
    expect(mine.totalHoursThisMonth).toBe(4.75);

    // The neighbour is not empty either, and its own cross-pointing entry is
    // equally absent from its figures: a client-context entry is attributed
    // through the OWNING firm's client list, which that client is not on.
    const theirs = await figures({ actor: neighbourOwner, lawFirmId: neighbour.id });
    expect(theirs.totalMatters).toBe(1);
    expect(theirs.unbilledTimeEntryCount).toBe(1);
    expect(theirs.totalHoursThisMonth).toBe(8.5);
  });
});

// ===========================================================================
describe('a firm with no billing activity', () => {
// ===========================================================================

  it('answers with a complete set of zeroes rather than omitting the fields', async () => {
    // Red when: a field stops being emitted, or an empty firm produces null or
    // NaN. The dashboard renders whatever it is handed, so an absent figure shows
    // as a blank tile rather than an error.
    const body = await figures();

    expect(body).toEqual({
      totalBilled: 0,
      totalCollected: 0,
      totalOutstanding: 0,
      totalHoursThisMonth: 0,
      totalRevenueThisMonth: 0,
      overdueCount: 0,
      overdueAmount: 0,
      awaitingCount: 0,
      awaitingAmount: 0,
      totalInvoices: 0,
      unbilledTimeEntryCount: 0,
      totalMatters: 0,
    });
  });
});

// ===========================================================================
describe("the analytics plan gate", () => {
// ===========================================================================

  it('refuses a firm on a plan without analytics and serves one that has it', async () => {
    // Red when: the `requireFeature('analytics')` mount is lost, or the feature
    // moves tiers. `planDefinitions.ts` gives analytics to professional and
    // enterprise only, so all four tiers are pinned here rather than assumed.
    for (const planId of ['starter', 'basic']) {
      const gated = await createFirm({ planId });
      const gatedOwner = await ownerOf(gated.id);

      const res = await gatedOwner.api.get(path(gated.id));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(res.body.error).toMatch(/not included in your current plan/i);
      expect(res.body.error).toMatch(/Billing analytics/);
      expect(res.body.totalBilled).toBeUndefined();
      expect(res.body.totalCollected).toBeUndefined();
    }

    for (const planId of ['professional', 'enterprise']) {
      const allowed = await createFirm({ planId });
      const allowedOwner = await ownerOf(allowed.id);

      const res = await allowedOwner.api.get(path(allowed.id));

      expect(res.status).toBe(200);
      expect(res.body.totalBilled).toBe(0);
    }
  });

  it("honours a firm's own opt-out on a plan that includes analytics", async () => {
    // Red when: the gate checks only the plan ceiling. The firm is on enterprise,
    // so nothing but `settings.features.analytics === false` can deny it, and the
    // figures below prove there was real money to withhold.
    const client = await createPersonClient(firm.id);
    await seedInvoice(firm.id, {
      clientContextId: client.id,
      totalCents: 84_900,
      dueDate: '2099-01-01',
    });

    const before = await figures();
    expect(before.totalBilled).toBe(849);

    await testPool.query(
      `update law_firms
          set settings = coalesce(settings, '{}'::jsonb)
            || jsonb_build_object('features', jsonb_build_object('analytics', false))
        where id = $1`,
      [firm.id],
    );

    const res = await owner.api.get(path(firm.id));

    expect(res.status).toBe(403);
    expect(res.body.totalBilled).toBeUndefined();
  });
});

// ===========================================================================
describe('who may read the summary', () => {
// ===========================================================================

  it('refuses a member whose role grants nothing, because billing.viewInvoices is not baseline', async () => {
    // Red when: the route's permission gate stops running, or `billing.viewInvoices`
    // returns to DEFAULT_PERMISSIONS. The role carries no codes at all, so any
    // answer other than a refusal means the baseline is granting the read.
    const matter = await seedMatter(firm.id);
    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 84_900,
      dueDate: '2099-01-01',
    });

    const member = await memberWith(firm.id, []);
    const res = await member.api.get(path(firm.id));

    expect(res.status).toBe(403);
    expect(res.body.totalBilled).toBeUndefined();
  });

  it('serves a member whose role grants billing.viewInvoices', async () => {
    const matter = await seedMatter(firm.id);
    await seedInvoice(firm.id, {
      matterId: matter,
      totalCents: 84_900,
      dueDate: '2099-01-01',
    });

    const member = await memberWith(firm.id, ['billing.viewInvoices']);
    const body = await figures({ actor: member });

    expect(body.totalBilled).toBe(849);
  });

  it('refuses a signed-in caller who is not a member of the firm', async () => {
    // Red when: the permission gate stops running, or the plan gate's non-member
    // fall-through starts answering instead of deferring. The firm has real money
    // on its books, so a leak would show as a figure rather than an empty body.
    const client = await createPersonClient(firm.id);
    await seedInvoice(firm.id, {
      clientContextId: client.id,
      totalCents: 267_400,
      dueDate: '2099-01-01',
    });

    const res = await stranger().api.get(path(firm.id));

    expect(res.status).toBe(403);
    expect(res.body.totalBilled).toBeUndefined();
    expect(res.body.totalInvoices).toBeUndefined();
  });
});

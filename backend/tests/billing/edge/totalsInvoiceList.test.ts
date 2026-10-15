/**
 * The firm invoice list: status filters, chip counts, due-bucket tiles and
 * paging, against the seeded ledger.
 *
 * RED IF: a status filter returns a row the ledger does not put in that
 * status, a chip count differs from the rows its filter returns, a page
 * boundary drops or repeats an invoice, or the awaiting tiles stop summing to
 * what is owed.
 */
import { buildWorld, remainingOf, sum, type World, type Entry } from './totalsWorld';
import { readList, readAllPages, owing, isLate, live, cents } from './totalsSurfaces';

let w: World;

beforeEach(async () => {
  w = await buildWorld();
});

const keysOf = (rows: any[]) => rows.map((r) => r.invoiceName).sort();
const idsOf = (rows: any[]) => rows.map((r) => r.id);
const keys = (es: Entry[]) => es.map((e) => e.key).sort();

/** Days from today to `day`, in calendar days. */
const daysFromToday = (w: World, day: string) =>
  Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${w.today}T00:00:00Z`)) / 86_400_000);

describe('status filters select exactly the ledger rows', () => {
  it('unpaid is every invoice with a balance, voided and settled ones excluded', async () => {
    const body = await readList(w, '?status=unpaid');
    expect(keysOf(body.invoices)).toEqual(keys(owing(w)));
    expect(body.totalItems).toBe(owing(w).length);
  });

  it('overdue is every invoice with a balance past its next payment day, part-paid ones included', async () => {
    const late = owing(w).filter((e) => isLate(w, e));
    // dueYesterday, orgOverdue, lateFee, planLate: the plan one is late on its first instalment, not its due date.
    expect(keys(late)).toEqual(['dueYesterday', 'lateFee', 'orgOverdue', 'planLate']);

    const body = await readList(w, '?status=overdue');

    expect(keysOf(body.invoices)).toEqual(keys(late));
    expect(body.totalItems).toBe(late.length);
  });

  it('part-paid invoices keep their own filter whether or not they are late', async () => {
    const body = await readList(w, '?status=partially_paid');
    expect(keysOf(body.invoices)).toEqual(['partial', 'plan', 'trustPaid']);
  });

  it('paid is every invoice settled in cash and credited every one a write-off settled, never a voided one', async () => {
    const settled = live(w).filter((e) => remainingOf(e) === 0 && (e.totalCents > 0 || e.paidCents > 0 || e.writtenOffCents > 0));
    const cash = settled.filter((e) => e.writtenOffCents === 0);
    const forgiven = settled.filter((e) => e.writtenOffCents > 0);

    const paid = await readList(w, '?status=paid');
    const credited = await readList(w, '?status=credited');

    expect(keysOf(paid.invoices)).toEqual(keys(cash));
    expect(keys(cash)).toEqual(['paid', 'stripePaid']);
    expect(keysOf(credited.invoices)).toEqual(keys(forgiven));
    expect(keys(forgiven)).toEqual(['credited', 'remainderOff']);
  });

  it('voided lists the cancelled invoice only', async () => {
    const body = await readList(w, '?status=voided');
    expect(keysOf(body.invoices)).toEqual(['voided']);
  });

  it('due_soon is every unpaid invoice due from today through thirty days out', async () => {
    const want = owing(w).filter((e) => e.dueDay !== null && daysFromToday(w, e.dueDay) >= 0 && daysFromToday(w, e.dueDay) <= 30);
    // The boundary rows are both in: today (dueToday) and the far edge is exercised by due8 and the split shares.
    expect(keys(want)).toContain('dueToday');

    const body = await readList(w, '?status=due_soon');

    expect(keysOf(body.invoices)).toEqual(keys(want));
    expect(body.totalItems).toBe(want.length);
  });
});

describe('chip counts', () => {
  /**
   * Zero-total invoices (`zero`, `zeroLate`) owe nothing and are settled by
   * nothing, so which chip they belong to is not a ledger question. Every
   * other invoice has one unambiguous status.
   */
  const withoutZeroTotals = (w: World) => w.ledger.filter((e) => e.totalCents > 0);

  it('count each non-zero invoice under one exclusive status and the chips partition the list', async () => {
    const { statusCounts } = await readList(w);
    const nonZero = withoutZeroTotals(w);
    const settled = nonZero.filter((e) => !e.voided && remainingOf(e) === 0 && e.writtenOffCents === 0);
    const forgiven = nonZero.filter((e) => !e.voided && remainingOf(e) === 0 && e.writtenOffCents > 0);
    const partPaid = nonZero.filter((e) => !e.voided && remainingOf(e) > 0 && e.paidCents > 0);

    expect(statusCounts.all).toBe(w.ledger.length);
    expect(statusCounts.voided).toBe(1);
    expect(statusCounts.paid).toBe(settled.length);
    expect(statusCounts.credited).toBe(forgiven.length);
    expect(statusCounts.partially_paid).toBe(partPaid.length);
    // No invoice here is both part-paid and late, so the one overlapping chip (`overdue`)
    // overlaps nothing and the five chips partition the whole list.
    expect(partPaid.filter((e) => isLate(w, e))).toEqual([]);
    // A zero-total invoice owes nothing, so it sits under no unpaid chip.
    const zeroTotals = w.ledger.length - nonZero.length;
    expect(statusCounts.paid + statusCounts.credited + statusCounts.partially_paid + statusCounts.outstanding
      + statusCounts.overdue + statusCounts.voided + zeroTotals).toBe(statusCounts.all);
  });

  it.each([['paid'], ['credited'], ['partially_paid'], ['voided'], ['outstanding']])(
    'the %s chip equals the number of rows its filter returns',
    async (status) => {
      const { statusCounts } = await readList(w);
      const filtered = await readList(w, `?status=${status}`);

      expect(statusCounts[status]).toBe(filtered.totalItems);
      expect(filtered.invoices).toHaveLength(filtered.totalItems);
    },
  );

  it('chips are computed over the scope, not the selected status, so selecting one never zeroes the rest', async () => {
    const all = (await readList(w)).statusCounts;
    const underFilter = (await readList(w, '?status=voided')).statusCounts;

    expect(underFilter).toEqual(all);
  });
});

describe('due-bucket tiles', () => {
  it('sum the whole awaiting set, in cents, and split it by bucket', async () => {
    const body = await readList(w, '?awaitingOnly=true');
    const ow = owing(w);
    const bucket = (e: Entry) => {
      if (e.dueDay === null) return 'no_date';
      const d = daysFromToday(w, e.dueDay);
      if (d < 0) return 'overdue';
      if (d <= 7) return 'this_week';
      if (d <= 30) return 'this_month';
      return 'later';
    };
    const t = body.dueGroupTotals;

    expect(t.all).toEqual({ count: ow.length, amount: sum(ow, remainingOf) / 100 });
    for (const g of ['overdue', 'this_week', 'this_month', 'later', 'no_date']) {
      const inGroup = ow.filter((e) => bucket(e) === g);
      expect(t[g]).toEqual({ count: inGroup.length, amount: sum(inGroup, remainingOf) / 100 });
    }
    // Four non-empty buckets plus the undated one, so a bucket mix-up cannot hide behind zeros.
    expect(t.overdue.count).toBe(4);
    expect(t.no_date.count).toBe(1);
    expect(t.this_week.count).toBeGreaterThan(0);
    expect(t.later.count).toBeGreaterThan(0);
  });
});

describe('paging', () => {
  it.each([1, 3, 7, 25])('pages of %i return every invoice once and a stable total on every page', async (limit) => {
    const { rows, totals } = await readAllPages(w, '', limit);

    expect(new Set(totals)).toEqual(new Set([w.ledger.length]));
    expect(idsOf(rows).sort()).toEqual(w.ledger.map((e) => e.id).sort());
    expect(new Set(idsOf(rows)).size).toBe(rows.length);
  });

  it.each(['createdAt:asc', 'createdAt:desc', 'paymentPriority:asc', 'paymentPriority:desc', 'dueGroup:asc', 'dueGroup:desc'])(
    'sort %s pages without dropping or repeating a row, in the same order as one big read',
    async (sort) => {
      const whole = await readList(w, `?sort=${encodeURIComponent(sort)}`);
      const { rows } = await readAllPages(w, `?sort=${encodeURIComponent(sort)}`, 4);

      expect(idsOf(rows)).toEqual(idsOf(whole.invoices));
    },
  );

  it('the money on all pages adds up to what is owed and what was billed', async () => {
    const { rows } = await readAllPages(w, '', 5);

    const liveRows = rows.filter((r) => r.status !== 'voided');
    const centsOf = (list: any[], pick: (r: any) => number) => list.reduce((acc, r) => acc + cents(pick(r)), 0);

    expect(centsOf(liveRows, (r) => r.remainingBalance)).toBe(sum(live(w), remainingOf));
    expect(centsOf(liveRows, (r) => r.totalAmount)).toBe(sum(live(w), (e) => e.totalCents));
  });

  it('a filtered list pages to the same total its filter reports', async () => {
    const { rows, totals } = await readAllPages(w, '?status=unpaid', 4);

    expect(new Set(totals)).toEqual(new Set([owing(w).length]));
    expect(keysOf(rows)).toEqual(keys(owing(w)));
  });
});

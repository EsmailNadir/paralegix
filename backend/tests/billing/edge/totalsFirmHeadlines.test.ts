/**
 * Firm headline money and counts, against the cents the test seeded.
 *
 * One firm carries live, part-paid, paid, credited, written-off, zero-total,
 * taxed, late-fee, three-way split, payment-plan, trust-paid, Stripe-paid,
 * voided and due-day-ladder invoices. Each surface below must state the same
 * figure, and each figure is computed from the seeded ledger, not read from
 * another surface.
 *
 * RED IF: any headline sums a voided invoice, drops a part-paid or plan
 * invoice, double counts a late part-paid invoice, or reads a due day in the
 * wrong zone.
 */
import { buildWorld, type World } from './totalsWorld';
import {
  expectedFigures, readWorkbench, readAnalytics, readDashboard, owing, isLate,
} from './totalsSurfaces';
import { remainingOf, sum, pay } from './totalsWorld';

let w: World;

beforeEach(async () => {
  w = await buildWorld();
});

describe('firm headline figures equal the seeded ledger', () => {
  it('the workbench states awaiting, collected, overdue and invoice counts exactly', async () => {
    const want = expectedFigures(w);
    // The world is only meaningful if the awkward invoices exist.
    expect(want.awaitingCount).toBe(18);
    expect(want.overdueCount).toBe(4);

    const wb = await readWorkbench(w);

    expect(wb.totalInvoices).toBe(want.totalInvoices);
    expect(wb.collectedCents).toBe(want.collectedCents);
    expect(wb.awaitingCount).toBe(want.awaitingCount);
    expect(wb.awaitingCents).toBe(want.outstandingCents);
    expect(wb.overdueCount).toBe(want.overdueCount);
    expect(wb.overdueCents).toBe(want.overdueCents);
    expect(wb.collectionsOverdueCount).toBe(want.overdueCount);
    expect(wb.attentionOverdueRows).toBe(want.overdueCount);
  });

  it('the billing summary states billed, collected, outstanding, awaiting and overdue exactly', async () => {
    const want = expectedFigures(w);

    const a = await readAnalytics(w);

    expect(a).toEqual({
      totalInvoices: want.totalInvoices,
      billedCents: want.billedCents,
      collectedCents: want.collectedCents,
      outstandingCents: want.outstandingCents,
      // Every invoice was created now, so all of it is this month's revenue.
      revenueThisMonthCents: want.billedCents,
      overdueCount: want.overdueCount,
      overdueCents: want.overdueCents,
      awaitingCount: want.awaitingCount,
      awaitingCents: want.outstandingCents,
    });
  });

  it('the dashboard states receivable, overdue and this month collected exactly', async () => {
    const want = expectedFigures(w);

    const d = await readDashboard(w);

    expect(d).toEqual({
      outstandingCents: want.outstandingCents,
      overdueCount: want.overdueCount,
      overdueCents: want.overdueCents,
      collectedMonthCents: want.collectedCents,
    });
  });

  it('workbench, billing summary and dashboard agree with each other on every shared figure', async () => {
    const [wb, a, d] = [await readWorkbench(w), await readAnalytics(w), await readDashboard(w)];

    expect(wb.overdueCount).toBe(a.overdueCount);
    expect(a.overdueCount).toBe(d.overdueCount);
    expect(wb.overdueCents).toBe(a.overdueCents);
    expect(a.overdueCents).toBe(d.overdueCents);
    expect(wb.awaitingCents).toBe(a.awaitingCents);
    expect(a.outstandingCents).toBe(d.outstandingCents);
    expect(wb.collectedCents).toBe(a.collectedCents);
    expect(wb.totalInvoices).toBe(a.totalInvoices);
  });

  it('counts the late part-paid invoice once in overdue and not at all in the part-paid tile', async () => {
    // A late part-paid invoice: paid in part, remainder due yesterday.
    const late = w.ledger.find((e) => e.key === 'dueYesterday')!;
    await pay(w, late, 2022);

    const want = expectedFigures(w);
    const wb = await readWorkbench(w);

    expect(wb.overdueCount).toBe(want.overdueCount);
    expect(wb.overdueCents).toBe(want.overdueCents);
    // part-paid and not late: partial, trustPaid, plan. The late one is in overdue only.
    const partNotLate = owing(w).filter((e) => e.paidCents > 0 && !isLate(w, e));
    expect(partNotLate.map((e) => e.key).sort()).toEqual(['partial', 'plan', 'trustPaid']);
    expect(wb.partiallyPaidCount).toBe(partNotLate.length);
    expect(wb.overdueCents).toBe(sum(owing(w).filter((e) => isLate(w, e)), remainingOf));
  });
});

const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../../shared/database/financialQuery');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const firmBillingService = require('../shared/firmBilling.service');
const { toCents, fromCents } = require('../shared/money');
const { UNPAID_STATUS_KEYS } = require('../shared/firmBillingWindow');
const { zonedDayString } = require('../../../shared/utils/time');

/**
 * Billing-specific analytics for a law firm (aggregated billing metrics).
 */
export async function getBillingSummary({ lawFirmId, actingUserId, timezone }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const tz = timezone || 'UTC';
  const now = new Date();
  // The viewer's current-month start as 'YYYY-MM-01'. Entry/invoice dates are
  // compared as calendar-day strings, so "this month" is the viewer's month
  // rather than the server's UTC month (which rolled over early near month-end).
  const monthStart = `${new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(now)}-01`;
  // The exclusive upper bound, as the same kind of 'YYYY-MM-01' string, so the
  // comparisons below stay plain string comparisons. Without it the window was
  // open-ended and an entry dated in a FUTURE month counted as this month's
  // work: a member could log time against next month and watch it appear in
  // this month's total. Built from monthStart rather than from `now`, so the
  // two ends can never disagree about which month the viewer is in.
  const [msYear, msMonth] = monthStart.split('-').map(Number);
  const nextMonthStart = msMonth === 12
    ? `${msYear + 1}-01-01`
    : `${msYear}-${String(msMonth + 1).padStart(2, '0')}-01`;

  // Load the firm-wide reads (accessible matters, firm clients, all invoices,
  // matter-clients) once and thread the shared payload through the time-entry
  // list, instead of independently re-running loadFirmBillingShared.
  // shared.matters is the same listAccessibleMatters result used for totalMatters.
  const shared = await firmBillingService.loadFirmBillingShared(lawFirmId, actingUserId);
  const accessibleMatters = shared.matters;
  // No `limit`, so this is the COMPLETE time-entry set. Every aggregate below
  // (hours this month, the unbilled count) counts the whole firm, never a page.
  const { timeEntries } = await firmBillingService.listFirmTimeEntries({ lawFirmId, actingUserId, shared });

  // Accounts-receivable totals are a FIRM figure and must cover every matter in
  // the firm — not just the caller's accessible matters. Deriving them from the
  // member-scoped invoice list dropped every other attorney's outstanding
  // balances and undercounted the firm's books. firmInvoiceMoneyRecords reads
  // all firm invoices (matter- and client-context) from the already-loaded,
  // law_firm_id-scoped invoicesByContext, with no membership filter.
  const invoices = firmBillingService.firmInvoiceMoneyRecords(shared.invoicesByContext);
  // A voided invoice was cancelled by the firm: it is not billed, collected or
  // owed. It is still a row in the invoice list, so `totalInvoices` below counts
  // `invoices`, and every money figure reads `liveInvoices`.
  const liveInvoices = invoices.filter((inv: any) => inv.status !== 'voided');

  const num = firmBillingService.toNumber;
  const round = firmBillingService.roundCurrency;

  // BL #3: sum every monetary aggregate in integer cents and convert once at the
  // end. A per-invoice value such as remainingBalance can carry float noise;
  // summing floats and rounding only the final total lets that noise accumulate
  // across many invoices. Working in cents removes the drift entirely.
  // totalAmount already includes flat fees (time + flat fees); don't re-add them.
  const totalBilledCents = liveInvoices.reduce((sum: any, inv: any) => sum + toCents(inv.totalAmount), 0);
  const totalCollectedCents = liveInvoices.reduce((sum: any, inv: any) => sum + toCents(inv.amountPaid), 0);
  const totalOutstandingCents = liveInvoices.reduce((sum: any, inv: any) => sum + toCents(inv.remainingBalance), 0);
  // Use the canonical past-due predicate, not `status === 'overdue'`. A partially
  // paid invoice reports status 'partially_paid' even when it is past its due date
  // (deriveInvoiceStatus buckets by payment state before the overdue check), so a
  // status filter silently undercounts overdue AR. isInvoicePastDue is the same
  // rule the billing workbench uses, so both surfaces now agree.
  const overdueInvoices = liveInvoices.filter((inv: any) => firmBillingService.isInvoicePastDue(inv, now, tz));

  // Invoices the firm is still owed money on. The predicate is the derived status
  // being one that still expects money PLUS a positive remaining balance: a
  // zero-total invoice never reports 'paid' (there was nothing to pay), so the
  // balance check is what keeps empty invoices out of the count and the total.
  // `status` here comes from firmInvoiceMoneyRecords, i.e. the canonical
  // deriveInvoiceStatus, so this agrees with the status every invoice row shows.
  // The three unpaid statuses cover every not-settled invoice, so which of
  // 'outstanding' / 'overdue' an invoice lands on (the only timezone-sensitive
  // part) cannot change this count.
  const awaitingInvoices = liveInvoices.filter(
    (inv: any) => UNPAID_STATUS_KEYS.has(inv.status) && toCents(inv.remainingBalance) > 0,
  );

  const totalHoursThisMonth = timeEntries.reduce((sum: any, entry: any) => {
    // entry.date is a day-only 'YYYY-MM-DD' calendar value; compare it directly.
    const day = entry.date ? String(entry.date).slice(0, 10) : null;
    if (!day || day < monthStart || day >= nextMonthStart) return sum;
    return sum + num(entry.hours);
  }, 0);

  const totalRevenueThisMonthCents = liveInvoices.reduce((sum: any, inv: any) => {
    // createdAt is a real instant (project into the viewer's zone); invoiceDate is
    // a day-only fallback. zonedDayString returns each as a 'YYYY-MM-DD' day.
    const day = zonedDayString(inv.createdAt || inv.invoiceDate, tz);
    if (!day || day < monthStart || day >= nextMonthStart) return sum;
    return sum + toCents(inv.totalAmount);
  }, 0);

  return {
    totalBilled: fromCents(totalBilledCents),
    totalCollected: fromCents(totalCollectedCents),
    totalOutstanding: fromCents(totalOutstandingCents),
    totalHoursThisMonth: round(totalHoursThisMonth),
    totalRevenueThisMonth: fromCents(totalRevenueThisMonthCents),
    overdueCount: overdueInvoices.length,
    overdueAmount: fromCents(overdueInvoices.reduce((sum: any, inv: any) => sum + toCents(inv.remainingBalance), 0)),
    // Firm-wide accounts-receivable headline: how many invoices still owe money
    // and how much. The billing overview reads these instead of summing a page of
    // its invoice list, which could only ever total the rows it happened to hold.
    awaitingCount: awaitingInvoices.length,
    awaitingAmount: fromCents(awaitingInvoices.reduce((sum: any, inv: any) => sum + toCents(inv.remainingBalance), 0)),
    // Every invoice the firm has. The invoices tab's badge reads this rather than
    // counting the page it is showing.
    totalInvoices: invoices.length,
    // Billable time entries still waiting to be invoiced, for the time tab's badge.
    unbilledTimeEntryCount: timeEntries.filter(
      (entry: any) => entry.billable !== false && entry.billingStatus === 'unbilled',
    ).length,
    totalMatters: accessibleMatters.length,
  };
}

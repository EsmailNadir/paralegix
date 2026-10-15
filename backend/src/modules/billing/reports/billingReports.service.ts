const reportsRepo = require('./billingReports.repository');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');

/**
 * The "Billing by matter" report: one page of matter roll-ups, plus the figures
 * the header states over the whole firm.
 *
 * `unlinkedInvoices` and `practiceAreas` are deliberately NOT narrowed by the
 * caller's filters. The first is a statement about what this grouping cannot
 * show at all, so narrowing it would make the shortfall look smaller than it is;
 * the second is the filter's own option list, and building it from the filtered
 * set would leave a chosen practice area as the only one on offer.
 */
export async function getByMatterReport({ lawFirmId, actingUserId, search, status, practiceArea, page, limit, offset }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const [listing, unlinkedInvoices, practiceAreas] = await Promise.all([
    reportsRepo.listByMatter(lawFirmId, { search, status, practiceArea, page, limit, offset }),
    reportsRepo.getUnlinkedInvoiceTotals(lawFirmId),
    reportsRepo.listReportPracticeAreas(lawFirmId),
  ]);

  return { ...listing, unlinkedInvoices, practiceAreas };
}

/**
 * The "Billing by client" report: one page of client roll-ups, plus the money
 * that belongs to no client row at all.
 *
 * That last figure is the counterpart of by-matter's `unlinkedInvoices`. Here it
 * is a matter invoice that names no client on a matter with several: it is
 * nobody's individual receivable, so it is in no row, and saying so is what stops
 * the firm total appearing to change when the Group by toggle is switched.
 */
export async function getByClientReport({ lawFirmId, actingUserId, search, page, limit, offset }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const [listing, unattributedInvoices] = await Promise.all([
    reportsRepo.listByClient(lawFirmId, { search, page, limit, offset }),
    reportsRepo.getUnattributedInvoiceTotals(lawFirmId),
  ]);

  return { ...listing, unattributedInvoices };
}

/** One client's roll-up broken down by matter, for the report's detail modal. */
export async function getClientMatterBreakdown({ lawFirmId, actingUserId, clientId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const matters = await reportsRepo.getClientMatterBreakdown(lawFirmId, clientId);
  return { matters, totalItems: matters.length };
}

/**
 * Automatic late-fee sweep.
 *
 * Runs from the daily reminder cron. For each firm that has late fees enabled
 * AND set to auto-apply, it finds overdue unpaid invoices and adds a one-time
 * late fee (not interest) to any that are past due beyond the grace period and
 * have not already been charged one. All eligibility + idempotency lives in
 * invoices.service.applyLateFeeCore, which runs under the invoice row lock.
 */

const { getFirmBillingSettings } = require('../shared/billingSettings');
const { firmZone } = require('../../../shared/utils/personalDay');
const { localDateFor } = require('../../../shared/utils/localTime');
const { forEachFirm } = require('../../../shared/utils/reminderHelpers');
const invoicesRepo = require('./invoices.repository');
const invoicesService = require('./invoices.service');

/**
 * `lawFirmId` narrows the sweep to one firm. The cron caller in `app.ts` passes
 * `undefined` to cover every firm, so it is optional rather than required.
 */
export async function applyAutoLateFees(lawFirmId?: string | null, { deadline = null }: any = {}) {
  const stats = { applied: 0, skipped: 0, errors: 0 };

  const coverage = await forEachFirm('lateFees', async (firm: any) => {
    const fid = firm.id;
    let lateFee;
    try {
      lateFee = (await getFirmBillingSettings(fid)).lateFee;
    } catch (err: any) {
      console.error(`[lateFees] Failed to read settings for firm ${fid}:`, err.message);
      stats.errors++;
      return;
    }
    if (!lateFee || lateFee.enabled !== true || lateFee.autoApply !== true) return;
    // Past-due is counted on the firm's calendar, as the reminder pass counts
    // it; a person applying a fee by hand is counted in their own zone.
    const firmTimeZone = await firmZone(fid);

    let overdue;
    try {
      overdue = await invoicesRepo.findUnpaidByDue(fid, 'overdue', localDateFor(firmTimeZone));
    } catch (err: any) {
      console.error(`[lateFees] Failed to load overdue invoices for firm ${fid}:`, err.message);
      stats.errors++;
      return;
    }

    for (const { invoice, context } of overdue) {
      try {
        const { applied } = await invoicesService.applyLateFeeCore({
          context,
          invoiceId: invoice.id,
          actingUserId: null,
          lateFee,
          timeZone: firmTimeZone,
        });
        if (applied) stats.applied++; else stats.skipped++;
      } catch (err: any) {
        console.error(`[lateFees] Failed to apply late fee for invoice ${invoice.id}:`, err.message);
        stats.errors++;
      }
    }
  }, { lawFirmId, deadline });

  // `truncated` says this run did not reach every firm, so the counts above cover
  // only `firmsProcessed` of them. Surfaced rather than left to look like a quiet
  // day with no late fees due.
  return { ...stats, ...coverage };
}

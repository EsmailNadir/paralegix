/**
 * Canonical derived invoice status.
 *
 * Single source of truth for the status an invoice should report, shared by:
 *   - shared/firmBilling.service.js  (deriveInvoiceStatus, read/display path)
 *   - invoices/invoices.repository.js (deriveStatusFromInvoice, persisted-status
 *     writeback inside the row-locked txn)
 *
 * Previously these were two hand-maintained, byte-for-byte mirrors kept apart to
 * dodge a circular require (firmBilling.service -> invoices.repository ->
 * firmBilling.service). This module breaks that cycle: it depends ONLY on
 * shared/money.js and the shared AppError leaf module (neither requires anything
 * in billing), so both callers can require it without re-introducing the cycle.
 *
 * Status values: 'credited' (settled by write-off) | 'paid' | 'partially_paid' |
 * 'overdue' | 'outstanding'. Every one is derived from the invoice's live
 * amounts, so the stored column is a cache of this function's output rather than
 * an input to it. All money math is done in integer cents to avoid float drift.
 */

const { toCents } = require('./money');
const { ConflictError } = require('../../../shared/errors/AppError');
// zonedDayString is the shared calendar-day helper: a day-only 'YYYY-MM-DD' value
// is returned unchanged (tz-independent), a real instant is projected into the
// zone. Day strings compare correctly with `<` (ISO lexicographic order). Passing
// no timezone yields the UTC day, so the persisted-status writeback (which passes
// none) stays UTC-stable and deterministic.
const { zonedDayString } = require('../../../shared/utils/time');

/**
 * Refuse an action on an invoice the firm has voided.
 *
 * Void is terminal: the bill was cancelled, so nothing may pay it, re-price it,
 * schedule it or send it to the client again. Call it inside the
 * `runInvoiceTxn` callback, on the row read under the lock, so a void that
 * commits first is always seen. `action` completes "you cannot ...".
 */
export function assertInvoiceNotVoided(inv: any, action: string) {
  if (inv && inv.status === 'voided') {
    throw new ConflictError(`This invoice has been voided, so you cannot ${action}.`);
  }
}

/**
 * The invoice's effective billable total in integer cents.
 */
export function invoiceTotalCents(inv: any) {
  return toCents(inv?.totalAmount);
}

/**
 * Derive the status for an invoice (camelCase shape) at `now`.
 * Pure: no DB access, no side-effects.
 */
export function deriveInvoiceStatus(inv: any, now = new Date(), timeZone = 'UTC') {
  // Void is the one status the FIRM sets and the amounts cannot argue with. A
  // voided invoice still has a balance on paper, so every rule below would
  // derive 'outstanding' or 'overdue' from it, and the status writeback in
  // `_applyUpdateLocked` would then persist that over the void on the next
  // write. Cancelling a bill has to survive the next edit to mean anything.
  if (inv.status === 'voided') return 'voided';

  const totalCents = invoiceTotalCents(inv);
  const amountPaidCents = toCents(inv.amountPaid);
  const writtenOffCents = toCents(inv.totalWrittenOff);
  const remainingCents = Math.max(0, totalCents - amountPaidCents - writtenOffCents);

  // A settled invoice is labelled by HOW it settled. `isPaid` marks one the firm
  // actually collected; without it, a cleared balance plus a write-off means the
  // debt was forgiven, not received, and reporting that as 'paid' credits the
  // firm with money it never took (an invoice paid $10 against $1,001 with $991
  // written off read as fully Paid).
  //
  // Derived from the live amounts, never from the stored column: a stale in-txn
  // read of the column (during the write that removes the last credit note) would
  // stick a reverted invoice on the wrong status.
  //
  // A zero-total invoice has nothing to collect, so it reads paid only once the
  // firm has marked it paid; until then it is simply outstanding (and, with no
  // balance, never overdue).
  if (remainingCents <= 0 && (totalCents > 0 || amountPaidCents > 0 || writtenOffCents > 0 || inv.isPaid === true)) {
    if (inv.isPaid === true) return 'paid';
    const hasWriteOff =
      writtenOffCents > 0 || (Array.isArray(inv.creditNotes) && inv.creditNotes.length > 0);
    if (hasWriteOff) return 'credited';
    return 'paid';
  }
  if (amountPaidCents > 0) return 'partially_paid';

  // overdue: not fully settled and (nextPaymentDate || dueDate) is before today,
  // where "today" is the current calendar day in `timeZone` (the viewer's zone on
  // display paths; UTC for the persisted-status writeback that passes no zone).
  if (remainingCents > 0 && !inv.isPaid) {
    const dueRaw = inv.nextPaymentDate || inv.dueDate;
    if (dueRaw) {
      const dueDay = zonedDayString(dueRaw, timeZone);
      const today = zonedDayString(now, timeZone);
      if (dueDay && today && dueDay < today) return 'overdue';
    }
  }
  return 'outstanding';
}

/**
 * Whether an invoice is past its due day: has a positive remaining balance, is
 * not flagged paid, and its (nextPaymentDate || dueDate) day is before `now`'s
 * day. Day-granular, integer-cent remaining (same semantics as
 * firmBilling.isInvoicePastDue.
 *
 * NOTE: this is intentionally NOT `deriveInvoiceStatus(inv) === 'overdue'`.
 * `deriveInvoiceStatus` returns 'partially_paid' (which short-circuits before the
 * overdue branch) whenever amountPaid > 0, so an invoice that is partially paid
 * AND past due would report 'partially_paid', not 'overdue'. `isPastDue` is the
 * pure past-due predicate (independent of the partial-payment bucket), so it
 * stays true for a partially-paid-and-overdue invoice. This is the single
 * canonical overdue predicate that firmBilling.isInvoicePastDue can delegate to
 * (adoption pending. firmBilling is under concurrent edit and is not touched
 * here) so the workbench's "overdue" bucket and any future shared past-due check
 * compute from one rule.
 */
export function isPastDue(inv: any, now = new Date(), timeZone = 'UTC') {
  // A cancelled bill is not owed, whatever its balance column says. Without this
  // a voided invoice stays in the firm's overdue bucket and its collections
  // total forever, because the remaining balance never moves.
  if (inv.status === 'voided') return false;

  const totalCents = invoiceTotalCents(inv);
  const remainingCents = Math.max(
    0,
    totalCents - toCents(inv.amountPaid) - toCents(inv.totalWrittenOff)
  );
  if (remainingCents <= 0 || inv.isPaid) return false;

  const dueRaw = inv.nextPaymentDate || inv.dueDate;
  if (!dueRaw) return false;
  const dueDay = zonedDayString(dueRaw, timeZone);
  const today = zonedDayString(now, timeZone);
  return Boolean(dueDay && today && dueDay < today);
}

/**
 * Live status for one payment-plan installment ('paid' | 'overdue' | 'pending').
 * The `status` column only ever gets written as 'pending' (at creation) or
 * 'paid' (when settled) - nothing flips it to 'overdue' as its due date passes,
 * so every installment list rendered the stored value forever, showing
 * "Upcoming" for installments months past due. Derived the same way
 * deriveInvoiceStatus derives the parent invoice's overdue state.
 */
export function deriveExpectedPaymentStatus(ep: any, now = new Date(), timeZone = 'UTC') {
  if (ep.status === 'paid') return 'paid';
  const dueDay = zonedDayString(ep.dueDate, timeZone);
  const today = zonedDayString(now, timeZone);
  if (dueDay && today && dueDay < today) return 'overdue';
  return 'pending';
}

/**
 * Returns `paymentPlan` with every installment's status live-derived via
 * deriveExpectedPaymentStatus, for the three call sites that otherwise pass
 * `inv.paymentPlan` straight through from the repository (formatInvoice,
 * firmBilling.mapInvoiceRecord, portal.serializePortalInvoice) - each would
 * otherwise re-implement the same map and risk drifting apart. Applied only
 * at the read/serialization boundary; the stored `expected_payments.status`
 * column itself is never rewritten to 'overdue' (see the write-time-truth
 * note on invoices.repository._applyUpdateLocked).
 */
export function deriveExpectedPayments(paymentPlan: any, now = new Date(), timeZone = 'UTC') {
  if (!paymentPlan || !Array.isArray(paymentPlan.expectedPayments)) return paymentPlan;
  return {
    ...paymentPlan,
    expectedPayments: paymentPlan.expectedPayments.map((ep: any) => ({
      ...ep,
      status: deriveExpectedPaymentStatus(ep, now, timeZone),
    })),
  };
}

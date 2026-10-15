/**
 * Refuse a charge code or expense category id that is not a code of that kind
 * in this firm.
 *
 * Both are written to `activities.billing_code_id`. Its composite key to
 * `billing_codes (law_firm_id, id)` refuses another firm's code, but a key
 * cannot see `kind`, so it would accept an expense category as a charge code.
 * This check covers both and answers 400 rather than a constraint error.
 */
import { createBillingCodesRepository, type BillingCodeKind } from './billingCodes.repository';
const { ValidationError } = require('../../../shared/errors/AppError');

const repos = {
  charge: createBillingCodesRepository('charge'),
  expense: createBillingCodesRepository('expense'),
};
const NOUN: Record<BillingCodeKind, string> = { charge: 'charge code', expense: 'expense category' };

export async function assertBillingCodeInFirm(
  kind: BillingCodeKind, lawFirmId: string, id: string | null | undefined, field: string,
) {
  if (id == null) return;
  if (!(await repos[kind].findById(lawFirmId, id))) {
    throw new ValidationError({ [field]: [`Select a ${NOUN[kind]} from this firm`] });
  }
}

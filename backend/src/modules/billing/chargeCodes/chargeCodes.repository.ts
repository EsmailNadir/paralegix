/**
 * Charge codes are the `kind = 'charge'` rows of `billing_codes` (migration
 * 0231). The repository is the shared one, fixed to that kind; see
 * `billing/shared/billingCodes.repository.ts` for the contract.
 */
import { createBillingCodesRepository } from '../shared/billingCodes.repository';

const codes = createBillingCodesRepository('charge');

export = {
  ...codes,
  /** True if any time entry in the firm references this charge code. */
  isUsedByTimeEntries: (lawFirmId: string, chargeCodeId: unknown) => codes.isInUse(lawFirmId, chargeCodeId),
};

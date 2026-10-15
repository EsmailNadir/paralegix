/**
 * Expense categories are the `kind = 'expense'` rows of `billing_codes`
 * (migration 0231). The repository is the shared one, fixed to that kind; see
 * `billing/shared/billingCodes.repository.ts` for the contract.
 */
import { createBillingCodesRepository } from '../shared/billingCodes.repository';

export = createBillingCodesRepository('expense');

import { z } from 'zod';
const { positiveMoneyAmount } = require('../shared/moneyInput');
const { MAX_PAGE_SIZE } = require('../shared/firmBillingWindow');
const { parseIdList } = require('../../../shared/database/pagination');
const { paging, dayOnly } = require('../../../shared/validation/listQuery');

/**
 * Most matter ids the firm-wide read will answer for in one request.
 *
 * Set to the page ceiling, because the two are the same promise from different
 * ends: the route will not return more than `MAX_PAGE_SIZE` rows, so accepting a
 * filter wider than that only buys a larger `= any(...)` array to select rows
 * the caller cannot receive. Refusing is better than silently ignoring the tail
 * of the list, which would look like missing data on the caller's screen.
 */
export const MAX_FIRM_MATTER_IDS = MAX_PAGE_SIZE;

/** A flat fee is on an invoice line item, or it is not. There is no third state. */
const FLAT_FEE_BILLING_STATUSES = ['billed', 'unbilled'] as const;
const BILLING_STATUS_ALT = FLAT_FEE_BILLING_STATUSES.join('|');

/**
 * `GET /billing/flat-fees/firm`: the firm-wide list's query params.
 *
 * `limit` is bounded by the shared `MAX_PAGE_SIZE`, and unlike the older firm
 * reads an omitted `limit` does NOT mean "everything": the service serves a
 * ceiling-sized page and reports `truncated`. A caller that asks for more than
 * the ceiling gets a 400 rather than a quietly smaller page, so the number of
 * rows it can receive is never a surprise.
 */
export const listFirmFlatFeesSchema = z.object({
  query: z.object({
    ...paging({ max: MAX_PAGE_SIZE }),
    // Comma-separated matter ids. Generous character bound so an over-long list
    // trips the count refinement below (which says what the real limit is)
    // rather than a length error that reads as a URL problem.
    matterIds: z.string()
      .max(MAX_FIRM_MATTER_IDS * 40)
      .refine(
        (value) => (parseIdList(value) || []).length <= MAX_FIRM_MATTER_IDS,
        `matterIds accepts at most ${MAX_FIRM_MATTER_IDS} ids`,
      )
      .optional(),
    clientId: z.string().max(100).optional(),
    context: z.enum(['matter', 'client']).optional(),
    // One status, or a comma-separated set, matching the firm time-entry read.
    billingStatus: z.string()
      .regex(new RegExp(`^(${BILLING_STATUS_ALT})(,(${BILLING_STATUS_ALT}))*$`))
      .optional(),
    dateFrom: dayOnly.optional(),
    dateTo: dayOnly.optional(),
    // The cheap shape of this read: the totals without any rows.
    countOnly: z.enum(['true', 'false']).optional(),
  }),
});

// `amount` is stored as `amount_cents` (bigint) via `amount * 100`. Zod's base
// number check already refuses Infinity/NaN, but a merely huge FINITE number
// (e.g. 1e17) sails through `.positive()` unchanged and reaches Postgres as a
// value outside bigint's range - see MAX_MONEY_AMOUNT's doc comment in
// shared/money.ts for the full explanation. The cap has nothing to do with any
// real flat fee's size; it exists purely to keep the value inside
// bigint-cents range with room to spare. Whole cents only: a sub-cent value is
// refused rather than rounded into an amount nobody entered.
const feeAmount = positiveMoneyAmount;

export const createFlatFeeSchema = z.object({
  body: z.object({
    matterId: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    description: z.string().min(1, 'description is required'),
    amount: feeAmount,
    date: dayOnly.nullable().optional(),
  }).superRefine((val, ctx) => {
    const hasMatterId = Boolean(val.matterId);
    const hasClientId = Boolean(val.clientId);
    if (hasMatterId === hasClientId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide exactly one of matterId or clientId',
        path: ['matterId'],
      });
    }
  }),
});

export const updateFlatFeeSchema = z.object({
  body: z.object({
    description: z.string().min(1).optional(),
    amount: feeAmount.optional(),
    date: dayOnly.nullable().optional(),
  }),
});

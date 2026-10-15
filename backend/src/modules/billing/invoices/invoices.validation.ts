import { z } from 'zod';

/**
 * A sales or gross-receipts tax rate, as a percentage. Zero to one hundred; a
 * string is accepted because the form posts it as one. Negative was silently
 * ignored downstream and 250% was accepted, so the range is checked here.
 */
const taxRateSchema = z.union([z.number(), z.string()])
  .nullable()
  .optional()
  .refine((v) => v == null || v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100), {
    message: 'taxRate must be a percentage between 0 and 100',
  });
const { INVOICE_SORT_FIELDS, DUE_GROUPS, MAX_PAGE_SIZE } = require('../shared/firmBillingWindow');
const { paging, sortModel, dayOnly, dateWindow } = require('../../../shared/validation/listQuery');
const { BILLING_RELATIONS } = require('../shared/clientInvoiceRelation');
const { hasValidCalendarDatePrefix } = require('../../../shared/validation/calendarDate');
const { MAX_MONEY_AMOUNT, MAX_PLAN_INSTALLMENTS } = require('../shared/money');
import { isWholeCents } from '../shared/moneyInput';
import { PLAN_EARLIEST_DAY, PLAN_MAX_YEARS_AHEAD } from '../plans/plans.validation';

const WHOLE_CENTS = { message: 'Amount must be in whole cents (at most two decimal places)' };

// A date field that accepts a string (day-only or full ISO, resolved later by
// `shared/utils/time`) or a numeric timestamp. A regex can't apply to the
// numeric branch, so this only checks calendar validity on a string's leading
// 'YYYY-MM-DD' component - the same Date.UTC rollover gap `shared/utils/time`
// guards against, caught here instead so an impossible invoiceDate/dueDate is
// a clean 400 rather than silently resolving to null.
const dateInput = z.union([z.string(), z.number()]).refine(
  (v) => typeof v !== 'string' || hasValidCalendarDatePrefix(v),
  { message: 'Must be a real calendar date' },
);

// Payment-plan schedule dates: always a plain string (never a numeric
// timestamp, unlike `dateInput`), checked with the same calendar-validity
// rule. `requiredDateString` also rejects an empty string, matching the
// `.min(1, ...)` messages these fields carried before this check existed.
const requiredDateString = (fieldName: string) => z.string()
  .min(1, `${fieldName} is required`)
  .refine(hasValidCalendarDatePrefix, { message: 'Must be a real calendar date' });
// Longest cadence a payment plan may step by: a year. Anything longer is a typo
// that would push the second instalment decades out.
const MAX_PLAN_FREQUENCY_DAYS = 365;

// A plan's start day carries the same bounds as a billing plan's start: no
// earlier than PLAN_EARLIEST_DAY and no further ahead than PLAN_MAX_YEARS_AHEAD
// years, so a mistyped year is a 400 and never reaches the schedule arithmetic.
const planStartDateString = requiredDateString('planStartDate')
  .refine((day: string) => day.slice(0, 10) >= PLAN_EARLIEST_DAY, { message: `must be on or after ${PLAN_EARLIEST_DAY}` })
  .refine((day: string) => {
    const latest = new Date();
    latest.setUTCFullYear(latest.getUTCFullYear() + PLAN_MAX_YEARS_AHEAD);
    return day.slice(0, 10) <= latest.toISOString().slice(0, 10);
  }, { message: `must be no more than ${PLAN_MAX_YEARS_AHEAD} years from today` });
const optionalDateString = z.string()
  .refine(hasValidCalendarDatePrefix, { message: 'Must be a real calendar date' })
  .optional();

// Monetary amount on a line item: string-or-number (coerced server-side via toNum),
// but never negative. Discounts/reductions are modeled as credit notes and
// write-offs, not negative lines; a negative amount would silently shrink the
// invoice total and can drive it below zero, which the DB rejects as an unhandled
// error. A zero line is still permitted.
//
// Also capped at MAX_MONEY_AMOUNT: this value is summed and multiplied into
// integer cents (`toCents`) and written to a `bigint` money column. A merely
// huge but FINITE number (e.g. 1e17) is `Number.isFinite`, so it survives the
// check above unchanged, and only fails once the *100 conversion pushes it
// past bigint's range - see MAX_MONEY_AMOUNT's doc comment in shared/money.ts.
//
// A line amount is held to whole cents like every other money input: toCents
// would otherwise round 0.004 to a zero-dollar line and 1.005 and 0.005 in
// opposite directions.
const nonNegativeAmount = z.union([z.number(), z.string()]).refine((v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_MONEY_AMOUNT;
}, { message: `amount must be a non-negative number no greater than ${MAX_MONEY_AMOUNT}` })
  .refine((v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return !Number.isFinite(n) || n < 0 || isWholeCents(n);
  }, WHOLE_CENTS);

// An optional dollar field (an hourly rate, or an allocation share of a line)
// that is NOT part of the trusted total computation the way `amount` is
// (`sumLineAmounts` never reads it) but is still written straight into a
// `bigint` cents column - `rate_cents`/`allocation_amount_cents` via
// `centsOrNull` in `lineToColumns` - with no recompute in between. Same
// bigint-overflow guard as `nonNegativeAmount`, sized on magnitude rather than
// sign: unlike `amount`, these fields are allowed to be omitted or negative
// today and nothing here means to change that, so the bound is `abs(n) <=
// MAX_MONEY_AMOUNT` rather than a non-negative range.
const optionalCappedAmount = z.union([z.number(), z.string()]).optional().refine((v) => {
  if (v === undefined) return true;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && Math.abs(n) <= MAX_MONEY_AMOUNT;
}, { message: `amount must not exceed ${MAX_MONEY_AMOUNT} in magnitude` });

// Line items must be objects with the fields the service actually reads
// (amount/hours/rate/description/id etc.). `.passthrough()` keeps it permissive so
// currently-valid payloads carrying extra fields are not rejected. The service
// recomputes monetary totals from these fields, so `amount` must be present and
// numeric (string-or-number, coerced server-side via toNum).
const invoiceLineItemSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  rate: optionalCappedAmount,
  hours: z.union([z.number(), z.string()]).optional(),
  amount: nonNegativeAmount,
  allocationPercent: z.union([z.number(), z.string()]).optional(),
  allocationAmount: optionalCappedAmount,
}).passthrough();

const invoiceFlatFeeSchema = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  amount: nonNegativeAmount,
  allocationPercent: z.union([z.number(), z.string()]).optional(),
  allocationAmount: optionalCappedAmount,
}).passthrough();

// Expense line items billed onto an invoice (source expense id + amount). The
// invoice stores its own line-item snapshot (kind='expense'); the service
// recomputes the total from `amount`. `.passthrough()` keeps display fields
// (category/vendor/date) the caller sends.
const invoiceExpenseSchema = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  amount: nonNegativeAmount,
  date: dateInput.nullable().optional(),
  category: z.string().nullable().optional(),
  expenseCategoryId: z.string().nullable().optional(),
  vendor: z.string().nullable().optional(),
  allocationPercent: z.union([z.number(), z.string()]).optional(),
  allocationAmount: optionalCappedAmount,
}).passthrough();

export const createInvoiceSchema = z.object({
  body: z.object({
    matterId: z.string().min(1),
    invoiceName: z.string().min(1),
    invoiceNumber: z.string().nullable().optional(),
    invoiceDate: dateInput,
    dueDate: dateInput.nullable().optional(),
    billingEmail: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    clientId: z.string().nullable().optional(),
    remitTo: z.union([
      z.string(),
      z.object({
        name: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
      }),
    ]).nullable().optional(),
    timeEntries: z.array(invoiceLineItemSchema).optional().default([]),
    flatFees: z.array(invoiceFlatFeeSchema).optional().default([]),
    expenses: z.array(invoiceExpenseSchema).optional().default([]),
    totalHours: z.union([z.number(), z.string()]).optional().default(0),
    totalAmount: z.union([z.number(), z.string()]).optional().default(0),
    flatFeesAmount: z.union([z.number(), z.string()]).optional().default(0),
    expensesAmount: z.union([z.number(), z.string()]).optional().default(0),
    taxRate: taxRateSchema,
  }),
});

// `amount` here used to be a bare string-or-number with no refine at all: no
// upper bound (the same bigint-overflow gap as `nonNegativeAmount` closes
// elsewhere - `centsOf(item.amount)` in `lineToColumns` on insert), and no
// lower bound either. The missing lower bound is a real, separate hole: a
// manually-added split line (one sent with no `id`) has no
// backing unbilled row, so the allocation cross-check that ties a normal
// selected line to its real source amount never runs for it - only the
// invoice's own internal totals (sum of lines == stated total, split shares ==
// selected source total) have to agree, and a caller controls both sides of
// that comparison. A negative line can hide inside an otherwise-plausible
// positive total, which is exactly the "smuggled discount" `nonNegativeAmount`
// was written to prevent for ordinary invoice creation. Reusing that same
// schema closes both gaps at once with the same bound already documented there.
// `rate`/`allocationAmount` here were bare `z.union([z.number(), z.string()]).optional()`
// with no upper bound at all - the same bigint-overflow gap `optionalCappedAmount`
// already closes for `invoiceLineItemSchema.rate`/`allocationAmount` on the create
// path. They were out of scope for the `amount` fix above because they weren't in
// the originally-enumerated field list, but they funnel through the exact same
// write path: `lineToColumns` writes both straight into bigint columns via
// `centsOrNull` (`rate_cents`, `allocation_amount_cents`) with no recompute or
// cross-check in between, for a manually-added line same as `amount`. Reusing
// `optionalCappedAmount` closes both fields with the bound already documented there.
const splitInvoiceLineItemSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  rate: optionalCappedAmount,
  hours: z.union([z.number(), z.string()]).optional(),
  amount: nonNegativeAmount,
  allocationPercent: z.union([z.number(), z.string()]).optional(),
  allocationAmount: optionalCappedAmount,
});

const splitInvoiceFlatFeeSchema = z.object({
  id: z.string().min(1).optional(),
  description: z.string(),
  amount: nonNegativeAmount,
  allocationPercent: z.union([z.number(), z.string()]).optional(),
  allocationAmount: optionalCappedAmount,
});

export const createClientInvoiceSchema = z.object({
  body: z.object({
    matterId: z.string().min(1).optional(),
    contextClientId: z.string().min(1).optional(),
    invoiceName: z.string().min(1),
    invoiceDate: dateInput,
    dueDate: dateInput.nullable().optional(),
    billingEmail: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    clientId: z.string().nullable().optional(),
    remitTo: z.union([
      z.string(),
      z.object({
        name: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
      }),
    ]).nullable().optional(),
    timeEntries: z.array(invoiceLineItemSchema).optional().default([]),
    flatFees: z.array(invoiceFlatFeeSchema).optional().default([]),
    expenses: z.array(invoiceExpenseSchema).optional().default([]),
    totalHours: z.union([z.number(), z.string()]).optional().default(0),
    totalAmount: z.union([z.number(), z.string()]).optional().default(0),
    flatFeesAmount: z.union([z.number(), z.string()]).optional().default(0),
    expensesAmount: z.union([z.number(), z.string()]).optional().default(0),
    taxRate: taxRateSchema,
  }),
});

export const createSplitInvoicesSchema = z.object({
  body: z.object({
    invoiceDate: dateInput,
    dueDate: dateInput.nullable().optional(),
    notes: z.string().nullable().optional(),
    remitTo: z.union([
      z.string(),
      z.object({
        name: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
      }),
    ]).nullable().optional(),
    splitMode: z.enum(['manual', 'equal', 'percentage', 'fixed_amount']),
    sourceSelection: z.object({
      timeEntries: z.array(z.string().min(1)).optional().default([]),
      flatFees: z.array(z.string().min(1)).optional().default([]),
    }),
    invoices: z.array(z.object({
      matterClientId: z.string().min(1),
      invoiceName: z.string().min(1),
      invoiceNumber: z.string().nullable().optional(),
      billingEmail: z.string().nullable().optional(),
      timeEntries: z.array(splitInvoiceLineItemSchema).optional().default([]),
      flatFees: z.array(splitInvoiceFlatFeeSchema).optional().default([]),
      totalHours: z.union([z.number(), z.string()]).optional().default(0),
      totalAmount: z.union([z.number(), z.string()]),
      flatFeesAmount: z.union([z.number(), z.string()]).optional().default(0),
      allocationPercent: z.union([z.number(), z.string()]).optional(),
      allocationAmount: z.union([z.number(), z.string()]).optional(),
    })).min(1, 'At least one split invoice is required'),
  }),
});

export const recordPaymentSchema = z.object({
  body: z.object({
    isPaid: z.boolean().optional(),
    paidDate: dateInput.nullable().optional(),
    paymentAmount: z.number().positive().refine(isWholeCents, WHOLE_CENTS).optional(),
    nextPaymentDate: dateInput.nullable().optional(),
    installmentIndex: z.number().int().min(0).optional(),
    invoiceNumber: z.string().optional(),
    paymentNote: z.string().optional(),
    shortfallAction: z.enum(['write_off', 'add_to_next', 'add_to_current']).optional(),
    // Trust payment fields. BL10: the service resolves the trust clientId/name
    // from the stored invoice (never the body), so only trustAccountId is
    // required for a trust payment. trustClientId/Name are accepted but ignored.
    // Never 'stripe': a Stripe payment is written by the webhook with its intent
    // id, and everything downstream (the edit-amount refusal, dedupe, the refund
    // lookup) treats that source as one Stripe can reverse. A manual entry that
    // borrowed the label would be a Stripe payment with no Stripe behind it.
    paymentSource: z.enum(['trust', 'external']).optional(),
    trustAccountId: z.string().uuid('trustAccountId must be a valid trust account id').optional(),
    trustClientId: z.string().optional(),
    trustClientName: z.string().optional(),
  }).refine((data) => {
    if (data.paymentSource === 'trust') {
      return !!data.trustAccountId;
    }
    return true;
  }, { message: 'trustAccountId is required when paymentSource is trust' }),
});

/**
 * A payment is named by the id the invoice payload carries for it. The position in
 * the list is still accepted for callers that predate ids; when both are sent the
 * id wins, so a stale position can never redirect the request.
 */
const paymentIdField = z.string().uuid('paymentId must be a valid payment id');

export const editPaymentSchema = z.object({
  body: z.object({
    paymentIndex: z.number().int().min(0).optional(),
    paymentId: paymentIdField.optional(),
    amount: z.number().positive().refine(isWholeCents, WHOLE_CENTS).optional(),
    // A payment day. The edit dialogs send 'YYYY-MM-DD'; an empty string means
    // "leave the day as recorded", which the service already treats that way.
    date: z.union([dayOnly, z.literal('')]).optional(),
    note: z.string().optional(),
    invoiceNumber: z.string().nullable().optional(),
  }).refine((data) => data.paymentId !== undefined || data.paymentIndex !== undefined, {
    message: 'Select a payment to edit.',
  }),
});

export const deletePaymentSchema = z.object({
  query: z.object({
    paymentIndex: z.coerce.number().int().min(0).optional(),
    paymentId: paymentIdField.optional(),
  }).refine((query) => query.paymentId !== undefined || query.paymentIndex !== undefined, {
    message: 'Select a payment to delete.',
  }),
});

export const unpayInstallmentSchema = z.object({
  query: z.object({ paymentId: paymentIdField.optional() }),
});

/**
 * A reminder window in whole days before the due date. `null` clears it. Zero
 * is allowed (no reminder) and the cap is a year: the value is written to an
 * integer column and a larger window is not a reminder, it is a second bill.
 */
const reminderDays = z.number().int('Must be a whole number of days').min(0).max(365).nullable().optional();

export const setPreDueReminderSchema = z.object({
  body: z.object({ invoiceDays: reminderDays, planDays: reminderDays }),
});

export const setReminderOptOutSchema = z.object({
  body: z.object({ optOut: z.boolean().optional() }),
});

export const updateInvoiceDetailsSchema = z.object({
  body: z.object({
    invoiceName: z.string().min(1).optional(),
    invoiceNumber: z.string().nullable().optional(),
    invoiceDate: dateInput.nullable().optional(),
    dueDate: dateInput.nullable().optional(),
    remitTo: z.union([
      z.string(),
      z.object({
        name: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
      }),
    ]).nullable().optional(),
  }),
});

// Hours on one editable invoice line, capped for the same bigint-overflow
// reason as `rate`/`amount` below: it is multiplied by `rate` (in cents) and
// the product is written to a `bigint` column, so an uncapped hours value can
// overflow that product even when `rate` alone is within range. The cap is a
// technical safety margin, not a plausible line-item duration: even a
// consolidated line spanning a firm's entire history would not approach it.
const MAX_LINE_ITEM_HOURS = 1_000_000;

// One editable invoice line. `id` is the source row id (time entry / flat fee /
// expense) and is what invoice_line_items.source_id is written from, but it is
// genuinely optional: source_id is nullable, so a line whose source row is gone —
// or that never had one, like a plan-generated fee — comes back with no id at all.
// Requiring it here made those invoices unsaveable. The guards that key on it
// simply skip a line without one. Money fields are floored at 0; the service
// recomputes a time entry's `amount` from hours x rate regardless of what is sent.
//
// `hours`/`rate`/`amount` are also capped at the top: all three feed a
// `*_cents` bigint column (`amount` and `rate` directly via `toCents`, `hours`
// indirectly through the hours x rate recompute for a time-entry line - see
// invoices.service.ts). A merely huge but FINITE value survives the base
// coercion unchanged and only fails once the conversion pushes it past
// bigint's range - see MAX_MONEY_AMOUNT's doc comment in shared/money.ts.
const invoiceLineInputSchema = z.object({
  id: z.string().min(1).nullable().optional(),
  name: z.string().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  date: dateInput.nullable().optional(),
  hours: z.coerce.number().min(0, 'Hours cannot be negative')
    .max(MAX_LINE_ITEM_HOURS, `hours cannot exceed ${MAX_LINE_ITEM_HOURS}`).optional(),
  rate: z.coerce.number().min(0, 'Rate cannot be negative')
    .max(MAX_MONEY_AMOUNT, `rate cannot exceed ${MAX_MONEY_AMOUNT}`).optional(),
  amount: z.coerce.number().min(0, 'Amount cannot be negative')
    .max(MAX_MONEY_AMOUNT, `amount cannot exceed ${MAX_MONEY_AMOUNT}`)
    .refine(isWholeCents, WHOLE_CENTS.message).default(0),
  userId: z.string().nullable().optional(),
  userName: z.string().nullable().optional(),
  chargeCodeId: z.string().nullable().optional(),
  allocationPercent: z.coerce.number().min(0).max(100).nullable().optional(),
  allocationAmount: z.coerce.number().min(0).nullable().optional(),
  utbmsTaskCode: z.string().nullable().optional(),
  utbmsActivityCode: z.string().nullable().optional(),
});

// Replace-all: the caller sends the complete surviving set for each kind, which is
// also how the repository persists them (writeChildren deletes and re-inserts). An
// omitted array therefore means "no lines of this kind", so a caller clearing one
// section must still send the other two.
export const updateLineItemsSchema = z.object({
  body: z.object({
    timeEntries: z.array(invoiceLineInputSchema).default([]),
    flatFees: z.array(invoiceLineInputSchema).default([]),
    expenses: z.array(invoiceLineInputSchema).default([]),
    // Omitted keeps the stored rate; present re-levies at the new one. This is
    // the only edit path an invoice's rate has, so a wrong rate at creation used
    // to be permanent.
    taxRate: taxRateSchema,
    acknowledgeOverpayment: z.boolean().optional(),
  }),
});

// Unlike recordPayment/editPayment/addCreditNote, `addAmountToInvoice` folds
// `amount` straight into `invoices.total_cents` with no upper-bound check of
// its own anywhere in the service (there is no existing balance for a huge
// value to be rejected against - it just enlarges the total). Same
// bigint-overflow guard as `nonNegativeAmount`.
// Unlike recordPayment/editPayment/addCreditNote, `addAmountToInvoice` folds
// `amount` straight into `invoices.total_cents` with no upper-bound check of
// its own anywhere in the service (there is no existing balance for a huge
// value to be rejected against - it just enlarges the total). Same
// bigint-overflow guard as `nonNegativeAmount`.
export const addAmountSchema = z.object({
  body: z.object({
    amount: z.number().positive('amount must be a positive number')
      .max(MAX_MONEY_AMOUNT, `amount must not exceed ${MAX_MONEY_AMOUNT}`)
      .refine(isWholeCents, WHOLE_CENTS),
    note: z.string().optional(),
  }),
});

export const addCreditNoteSchema = z.object({
  body: z.object({
    amount: z.number().positive('amount must be a positive number').refine(isWholeCents, WHOLE_CENTS),
    description: z.string().optional(),
    type: z.enum(['write_off', 'discount', 'adjustment']),
  }),
});

export const setPaymentPlanSchema = z.object({
  body: z.object({
    // `installmentAmount` larger than the invoice is legitimately accepted -
    // `rebuildSchedule` clamps the per-installment `invoice_expected_payments`
    // rows to the remaining balance (see the "CLAMPS an instalment larger than
    // the invoice" case in invoiceInstallments.test.ts) - but the plan HEADER
    // value is written to `invoices.plan_installment_cents` unclamped via
    // `centsOrNull`, so it still needs its own bigint-overflow cap. Whole cents,
    // so the schedule is built from the amount the firm typed, not a rounding of it.
    installmentAmount: z.number().positive('installmentAmount must be a positive number')
      .max(MAX_MONEY_AMOUNT, `installmentAmount must not exceed ${MAX_MONEY_AMOUNT}`)
      .refine(isWholeCents, WHOLE_CENTS),
    frequencyDays: z.number().int().positive('frequencyDays must be a positive whole number of days')
      .max(MAX_PLAN_FREQUENCY_DAYS, `frequencyDays must be at most ${MAX_PLAN_FREQUENCY_DAYS} days`),
    planStartDate: planStartDateString,
    // 0 means "no down payment" (the service only schedules one when it is
    // above zero). Anything else must be whole cents, so a sub-cent value
    // cannot become a zero-cent down-payment installment.
    downPaymentAmount: z.number().min(0)
      .max(MAX_MONEY_AMOUNT, `downPaymentAmount must not exceed ${MAX_MONEY_AMOUNT}`)
      .refine(isWholeCents, WHOLE_CENTS)
      .optional(),
    downPaymentAlreadyPaid: z.boolean().optional(),
    downPaymentDueDate: optionalDateString,
  }),
});

export const updateInstallmentSchema = z.object({
  body: z.object({
    dueDate: optionalDateString,
    // Replaces `expectedPayments[installmentIndex].amount` outright with no
    // other check on its size, straight into `invoice_expected_payments.amount_cents`.
    // Whole cents, so the schedule's exact-sum rule sees what was typed.
    amount: z.number().positive().max(MAX_MONEY_AMOUNT, `amount must not exceed ${MAX_MONEY_AMOUNT}`)
      .refine(isWholeCents, WHOLE_CENTS).optional(),
  }),
  params: z.object({
    invoiceId: z.string().min(1),
    installmentIndex: z.coerce.number().int().min(0),
  }).passthrough(),
});

export const replaceScheduleSchema = z.object({
  body: z.object({
    // At least one. An empty array cleared every instalment and left
    // `payment_plan_enabled` true, so the invoice claimed to be on a payment
    // plan with nothing scheduled: no instalment is ever due, no reminder ever
    // fires, and the balance ages with the screen still saying a plan is in
    // place. A caller who wants no plan has DELETE /payment-plan for that.
    // The service holds the unpaid instalments to the invoice's remaining
    // balance, so a schedule that does not add up is refused there. This bound
    // is still what stands between one huge value and `amount_cents`, because
    // that check reads the SUM. Whole cents, so the sum check sees the amounts
    // as typed rather than a rounding of them.
    installments: z.array(z.object({
      dueDate: requiredDateString('dueDate'),
      amount: z.number().positive('amount must be greater than 0')
        .max(MAX_MONEY_AMOUNT, `amount must not exceed ${MAX_MONEY_AMOUNT}`)
        .refine(isWholeCents, WHOLE_CENTS),
    })).min(1, 'A payment plan needs at least one instalment')
      .max(MAX_PLAN_INSTALLMENTS, `A payment plan can have at most ${MAX_PLAN_INSTALLMENTS} instalments`),
    frequencyDays: z.number().int().positive('frequencyDays must be a positive integer')
      .max(MAX_PLAN_FREQUENCY_DAYS, `frequencyDays must be at most ${MAX_PLAN_FREQUENCY_DAYS} days`)
      .optional(),
  }),
  params: z.object({
    invoiceId: z.string().min(1),
  }).passthrough(),
});

export const bulkCreateInvoicesSchema = z.object({
  body: z.object({
    contexts: z.array(z.object({
      type: z.enum(['matter', 'client']),
      entityId: z.string().min(1),
      // Bill only these lines instead of everything unbilled on the context.
      // Omitted means "everything", which is what a bill-the-whole-matter run
      // sends and what every caller sent before line selection existed.
      timeEntryIds: z.array(z.string().min(1)).optional(),
      flatFeeIds: z.array(z.string().min(1)).optional(),
    })).min(1, 'At least one context required'),
    invoiceDate: dateInput,
    dueDate: dateInput.nullable().optional(),
    invoiceNamePrefix: z.string().optional(),
  }),
});

// Firm invoice list: optional server-side pagination/filter/sort query params.
// All optional so a bare `GET /invoices/firm` still validates and returns the
// complete list, which is what the workbench and the billing summary rely on.
//
// `status` accepts the derived status keys (including `voided`, the firm's own
// cancellation) plus two pseudo-statuses the UI offers: `unpaid` (anything still owed) and `due_soon` (next payment within 30 days).
export const listFirmInvoicesSchema = z.object({
  query: z.object({
    ...paging({ max: MAX_PAGE_SIZE }),
    search: z.string().max(500).optional(),
    matterId: z.string().max(100).optional(),
    clientId: z.string().max(100).optional(),
    // Everything under one client relationship: their direct invoices plus every
    // invoice on a matter they are on. Wider than `clientId`, which asks who the
    // invoice was billed to.
    clientScope: z.string().max(100).optional(),
    billingRelation: z.enum(BILLING_RELATIONS).optional(),
    relatedClientId: z.string().uuid().optional(),
    includeDetails: z.enum(['true', 'false']).optional(),
    status: z.enum([
      'outstanding', 'overdue', 'partially_paid', 'paid', 'credited', 'voided', 'unpaid', 'due_soon',
    ]).optional(),
    dateFrom: dayOnly.optional(),
    dateTo: dayOnly.optional(),
    dueDateFrom: dayOnly.optional(),
    dueDateTo: dayOnly.optional(),
    dueGroup: z.enum(DUE_GROUPS).optional(),
    awaitingOnly: z.enum(['true', 'false']).optional(),
    sort: sortModel(INVOICE_SORT_FIELDS),
    tz: z.string().optional(),
  }).passthrough(),
});

// Calendar payment-date feed. `from`/`to` bound the read to the days being drawn;
// omitting them expands every invoice in the firm.
export const calendarPaymentDatesSchema = z.object({
  query: z.object({
    ...dateWindow(),
  }).passthrough(),
});

/**
 * The firm correcting who an invoice is billed to. At least one address, each
 * a real email; the list replaces the invoice's billing emails.
 */
export const updateBillingEmailsSchema = z.object({
  body: z.object({
    emails: z.array(z.string().trim().email('Enter a valid email address').max(320))
      .min(1, 'Enter at least one billing email')
      .max(20, 'Enter at most 20 billing emails'),
  }).strict(),
});

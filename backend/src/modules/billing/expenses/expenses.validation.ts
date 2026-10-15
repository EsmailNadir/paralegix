import { z } from 'zod';
const { positiveMoneyAmount } = require('../shared/moneyInput');
const { dayOnly } = require('../../../shared/validation/listQuery');

// `amount` is stored as `amount_cents` (bigint) via `amount * 100`. Zod's base
// number check already refuses Infinity/NaN, but a merely huge FINITE number
// (e.g. 1e17) sails through `.positive()` unchanged and reaches Postgres as a
// value outside bigint's range - see MAX_MONEY_AMOUNT's doc comment in
// shared/money.ts for the full explanation. The cap has nothing to do with any
// real expense's size; it exists purely to keep the value inside
// bigint-cents range with room to spare. Whole cents only: a sub-cent value is
// refused rather than rounded into an amount nobody entered.
const expenseAmount = positiveMoneyAmount;

export const createExpenseSchema = z.object({
  body: z.object({
    matterId: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    description: z.string().min(1, 'description is required').max(1000),
    amount: expenseAmount,
    date: dayOnly.nullable().optional(),
    category: z.string().max(100).optional().default(''),
    expenseCategoryId: z.string().uuid().nullable().optional(),
    vendor: z.string().max(500).optional().default(''),
    billable: z.boolean().optional().default(true),
    receiptUrl: z.string().url().nullable().optional(),
    context: z.any().optional(),
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

export const updateExpenseSchema = z.object({
  body: z.object({
    description: z.string().min(1).max(1000).optional(),
    amount: expenseAmount.optional(),
    date: dayOnly.nullable().optional(),
    category: z.string().max(100).optional(),
    expenseCategoryId: z.string().uuid().nullable().optional(),
    vendor: z.string().max(500).optional(),
    billable: z.boolean().optional(),
    receiptUrl: z.string().url().nullable().optional(),
  }),
});

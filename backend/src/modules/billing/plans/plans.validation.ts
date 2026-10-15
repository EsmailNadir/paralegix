import { z } from 'zod';
const { MAX_MONEY_AMOUNT } = require('../shared/money');
const { dayOnly } = require('../../../shared/validation/listQuery');

/** No retainer here starts before this; anything earlier is a typo (1900, 0026). */
export const PLAN_EARLIEST_DAY = '2000-01-01';
/** A start further ahead than this is a typo (2206), not a pre-arranged engagement. */
export const PLAN_MAX_YEARS_AHEAD = 5;

function latestPlanDay(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + PLAN_MAX_YEARS_AHEAD);
  return d.toISOString().slice(0, 10);
}

// The plan's start and next-run days. `nextRunDate` is the period generator's
// cursor, so it carries the same bounds as the start: every read walks it up to
// today one period at a time. 'YYYY-MM-DD' strings compare correctly as text.
const planDay = dayOnly
  .refine((day: string) => day >= PLAN_EARLIEST_DAY, { message: `must be on or after ${PLAN_EARLIEST_DAY}` })
  .refine((day: string) => day <= latestPlanDay(), {
    message: `must be no more than ${PLAN_MAX_YEARS_AHEAD} years from today`,
  });

const nullableString = z.string().nullable().optional();

// `amount` is stored as `amount_cents` (bigint) via `amount * 100`. Zod's base
// number check already refuses Infinity/NaN, but a merely huge FINITE number
// (e.g. 1e17) sails through `.positive()` unchanged and reaches Postgres as a
// value outside bigint's range - see MAX_MONEY_AMOUNT's doc comment in
// shared/money.ts for the full explanation. The cap has nothing to do with any
// real retainer's size; it exists purely to keep the value inside
// bigint-cents range with room to spare. (`includedHours` is a `numeric`
// column with no such conversion, so it needs no equivalent cap.)
const planAmount = z
  .number()
  .positive()
  .max(MAX_MONEY_AMOUNT, `amount cannot exceed ${MAX_MONEY_AMOUNT}`);

export const createPlanSchema = z.object({
  body: z.object({
    contextType: z.enum(['matter', 'client']),
    entityId: z.string().min(1),
    planType: z.enum(['retainer']).default('retainer'),
    name: z.string().min(1),
    status: z.enum(['active', 'paused', 'ended']).optional().default('active'),
    intervalUnit: z.enum(['week', 'month']),
    intervalCount: z.number().int().positive().optional().default(1),
    startDate: planDay,
    nextRunDate: planDay.optional(),
    amount: planAmount,
    includedHours: z.number().min(0).optional().default(0),
    billingEmail: nullableString,
    defaultDueDays: z.number().int().min(0).optional().default(0),
    defaultClientId: z.string().uuid().nullable().optional(),
    notes: nullableString,
    endCondition: z.enum(['manual', 'matter_closed', 'date']).optional().default('manual'),
    endDate: dayOnly.nullable().optional(),
  }),
});

export const updatePlanSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    status: z.enum(['active', 'paused', 'ended']).optional(),
    intervalUnit: z.enum(['week', 'month']).optional(),
    intervalCount: z.number().int().positive().optional(),
    startDate: planDay.optional(),
    nextRunDate: planDay.optional(),
    amount: planAmount.optional(),
    includedHours: z.number().min(0).optional(),
    billingEmail: nullableString,
    defaultDueDays: z.number().int().min(0).optional(),
    defaultClientId: z.string().uuid().nullable().optional(),
    notes: nullableString,
    endCondition: z.enum(['manual', 'matter_closed', 'date']).optional(),
    endDate: dayOnly.nullable().optional(),
  }),
});

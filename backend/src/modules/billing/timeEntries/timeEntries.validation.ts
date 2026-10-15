import { z } from 'zod';
const {
  TIME_ENTRY_SORT_FIELDS,
  BILLING_STATUSES,
  MAX_PAGE_SIZE,
} = require('../shared/firmBillingWindow');
const { paging, sortModel, dayOnly } = require('../../../shared/validation/listQuery');
const { MAX_HOURLY_RATE } = require('../shared/money');
import { isWholeCents } from '../shared/moneyInput';

const BILLING_STATUS_ALT = BILLING_STATUSES.join('|');

// Firm time-entry list: optional server-side pagination/filter/sort query params.
// All optional so a bare `GET /time-entries/firm` still validates; the service
// then serves it as one MAX_PAGE_SIZE page and flags the truncation. `limit` is
// bounded by `paging({ max })`, so asking for more than MAX_PAGE_SIZE is a 400
// rather than a silent clamp.
export const listFirmTimeEntriesSchema = z.object({
  query: z.object({
    ...paging({ max: MAX_PAGE_SIZE }),
    search: z.string().max(500).optional(),
    context: z.enum(['matter', 'client']).optional(),
    matterId: z.string().max(100).optional(),
    clientId: z.string().max(100).optional(),
    // Everything under a client relationship: their direct entries plus every
    // entry on a matter they are on. Wider than `clientId`, which asks who the
    // work is billed to.
    clientScope: z.string().max(100).optional(),
    userId: z.string().max(200).optional(),
    chargeCodeId: z.string().max(100).optional(),
    // One status, or a comma-separated set (e.g. everything not yet invoiced).
    billingStatus: z.string()
      .regex(new RegExp(`^(${BILLING_STATUS_ALT})(,(${BILLING_STATUS_ALT}))*$`))
      .optional(),
    dateFrom: dayOnly.optional(),
    dateTo: dayOnly.optional(),
    sort: sortModel(TIME_ENTRY_SORT_FIELDS),
    tz: z.string().optional(),
  }).passthrough(),
});

// A single dated entry cannot span more than one day's work, and time cannot be
// recorded for work that has not happened yet. One day of slack on the future
// bound covers a user whose local date is already ahead of UTC.
const MAX_HOURS_PER_ENTRY = 24;
const MAX_FUTURE_DAYS = 1;

// The smallest value `activities.hours` (numeric(6,2)) can hold without
// storing zero. More decimals are accepted: the modal sends minutes / 60.
const MIN_HOURS_PER_ENTRY = 0.01;

const entryHours = z
  .number()
  .min(MIN_HOURS_PER_ENTRY, `hours must be at least ${MIN_HOURS_PER_ENTRY}`)
  .max(MAX_HOURS_PER_ENTRY, `hours cannot exceed ${MAX_HOURS_PER_ENTRY} for a single entry`);

// `hourlyRate` is stored as `rate_cents` (bigint) via `hours * rate * 100`. Zod's
// base number check already refuses Infinity/NaN, but a merely huge FINITE
// number (e.g. 1e17) sails through `.nonnegative()` unchanged, gets multiplied
// by 100, and reaches Postgres as a value outside bigint's range (or, past 1e21,
// as a string in exponential notation bigint cannot parse at all). Either way
// the caller's malformed input became a raw, uncaught database error -> 500,
// instead of the 400 a bad rate should get. The cap has nothing to do with any
// real firm's pricing; it exists purely to keep the value inside bigint-cents
// range with room to spare. It is shared with the charge-code rates, which
// resolve into the same stored rate.

const entryRate = z
  .number()
  .nonnegative('hourly rate cannot be negative')
  .max(MAX_HOURLY_RATE, `hourly rate cannot exceed ${MAX_HOURLY_RATE}`)
  .refine(isWholeCents, 'hourly rate cannot have more than two decimal places')
  .nullable()
  .optional();

const entryDate = z.union([z.string(), z.number()]).superRefine((value, ctx) => {
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date format' });
    return;
  }
  const latest = new Date();
  latest.setUTCDate(latest.getUTCDate() + MAX_FUTURE_DAYS);
  if (parsed.getTime() > latest.getTime()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Time cannot be logged for a future date' });
  }
});

export const createTimeEntrySchema = z.object({
  body: z.object({
    matterId: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    matterClientIds: z.array(z.string().min(1)).nullable().optional(),
    userId: z.string().min(1),
    hours: entryHours,
    date: entryDate,
    name: z.string().optional().default(''),
    description: z.string().max(5000).optional().default(''),
    hourlyRate: entryRate,
    chargeCodeId: z.string().uuid().nullable().optional(),
    sourceTaskId: z.string().min(1).nullable().optional(),
    sourceEventId: z.string().min(1).nullable().optional(),
    utbmsTaskCode: z.string().nullable().optional(),
    utbmsActivityCode: z.string().nullable().optional(),
    billable: z.boolean().optional().default(true),
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
    if (val.matterClientIds && val.matterClientIds.length > 0 && !hasMatterId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'matterClientIds can only be used with a matter time entry',
        path: ['matterClientIds'],
      });
    }
    if (val.sourceTaskId && val.sourceEventId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either sourceTaskId or sourceEventId, not both',
        path: ['sourceTaskId'],
      });
    }
  }),
});

/**
 * Imported from the service rather than restated here: one number cannot drift
 * from itself, and a cap below the UI's select-all ceiling would turn a full,
 * legitimate selection into a 400. See `MAX_BULK_TIME_ENTRY_IDS` for how the
 * ceiling is derived.
 */
const { MAX_BULK_TIME_ENTRY_IDS } = require('./timeEntries.service');

export const bulkDeleteTimeEntriesSchema = z.object({
  body: z.object({
    timeEntryIds: z.array(z.string()).min(1).max(MAX_BULK_TIME_ENTRY_IDS),
  }),
});

export const updateTimeEntrySchema = z.object({
  body: z.object({
    hours: entryHours.optional(),
    date: entryDate.optional(),
    matterClientIds: z.array(z.string().min(1)).nullable().optional(),
    // Moves a client-logged entry onto one of that client's matters, so work
    // done before a matter existed can be billed under it.
    matterId: z.string().min(1).optional(),
    name: z.string().optional(),
    description: z.string().max(5000).optional(),
    hourlyRate: entryRate,
    chargeCodeId: z.string().uuid().nullable().optional(),
    sourceTaskId: z.string().min(1).nullable().optional(),
    sourceEventId: z.string().min(1).nullable().optional(),
    utbmsTaskCode: z.string().nullable().optional(),
    utbmsActivityCode: z.string().nullable().optional(),
    billable: z.boolean().optional(),
  }).superRefine((val, ctx) => {
    if (val.sourceTaskId && val.sourceEventId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either sourceTaskId or sourceEventId, not both',
        path: ['sourceTaskId'],
      });
    }
  }),
});

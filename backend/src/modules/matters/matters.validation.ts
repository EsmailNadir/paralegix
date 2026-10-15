import { z } from 'zod';
const { paging, sorting, lookup, dateWindow } = require('../../shared/validation/listQuery');
const { isValidCalendarDateString } = require('../../shared/validation/calendarDate');

export const VALID_MATTER_STATUSES = ['active', 'pending', 'on_hold', 'completed', 'blocked', 'closed', 'archived'];
export const VALID_BILLING_METHODS = ['hourly', 'flat', 'contingency', 'pro_bono'];

// Day-only date: 'YYYY-MM-DD', or null/'' to clear. Empty string is normalized to
// null in the service. An impossible day (e.g. "2026-02-30" or "2026-13-01")
// passes the regex but not `isValidCalendarDateString`, and without this refine
// it reached the `date` column unchanged: Postgres rejects it, and that raw
// error surfaced as an opaque 500 instead of a 400 naming the field.
const dateOnly = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidCalendarDateString, 'Must be a real calendar date'),
  z.literal(''),
  z.null(),
]).optional();

// Mirrors clients.validation.ts's preferredContactMethodEnum: a client created
// inline during matter creation is the same underlying client record.
const preferredContactMethodEnum = z.enum(['email', 'phone', 'sms', 'portal']);

// Shared matter-attribute fields accepted on both create and update.
const matterAttributeFields = {
  stageId: z.string().nullable().optional(),
  stagePipelineId: z.string().nullable().optional(),
  billingMethod: z.enum(VALID_BILLING_METHODS).optional(),
  isBillable: z.boolean().optional(),
  // Budget entered in dollars (converted to cents in the service). null clears it.
  budget: z.number().nonnegative().nullable().optional(),
  budgetIncludesExpenses: z.boolean().optional(),
  contingencyPercent: z.number().min(0).max(100).nullable().optional(),
  openDate: dateOnly,
  closeDate: dateOnly,
  statuteOfLimitationsDate: dateOnly,
  // Custom field values keyed by field-def id. Values are arbitrary scalars/arrays.
  customFields: z.record(z.string(), z.any()).optional(),
};

// Create matter payload (body only; lawFirmId comes from route params)
export const createMatterSchema = z.object({
  body: z.object({
    // Trimmed BEFORE the length check, matching `clients.validation`. Plain
    // `min(1)` counts whitespace as characters, so "   " passes it and the firm
    // gets a matter that looks blank in every list and cannot be searched for.
    name: z.string().trim().min(1, 'Name is required').max(200),
    matterNumber: z.string().optional(),
    description: z.string().max(5000).optional(),

    practiceAreaId: z.string().optional(),

    category: z.string().optional(),

    courtId: z.string().optional(),

    // A matter may have zero, one, or many leads (responsible attorneys).
    leadUserIds: z.array(z.string()).optional(),
    leadUserName: z.string().optional(),

    clients: z.array(z.object({
      clientId: z.string().uuid().optional(),
      userId: z.string().optional(),
      name: z.string().min(1),
      email: z.string().nullable().optional().transform(v => v ?? ''),
      phone: z.string().optional().default(''),
      organization: z.string().optional().default(''),
      address: z.string().optional().default(''),
      // null is the form's "None"; leaving the field out takes the 'email' default.
      preferredContactMethod: preferredContactMethodEnum.nullable().optional(),
    })).optional(),

    ...matterAttributeFields,
  }),
});

// Update matter payload (body only; lawFirmId + matterId come from params)
export const updateMatterSchema = z.object({
  body: z.object({
    // Optional, but not permitted to be EMPTY. A max with no min let an update
    // blank an existing matter's name outright, which is worse than the create
    // case: the matter already has work, money and documents hanging off it, and
    // becomes unfindable in every list and search the firm has.
    name: z.string().trim().min(1, 'Name is required').max(200).optional(),
    matterNumber: z.string().optional(),
    description: z.string().max(5000).optional(),
    status: z.enum(VALID_MATTER_STATUSES).optional(),

    // Manual "payment ongoing" override (money still expected on a done matter).
    paymentOngoing: z.boolean().optional(),

    practiceAreaId: z.string().nullable().optional(),

    category: z.string().nullable().optional(),

    courtId: z.string().nullable().optional(),

    // Replace the matter's lead set. An empty array clears all leads.
    leadUserIds: z.array(z.string()).optional(),

    ...matterAttributeFields,
  }),
});

// Toggle a matter's legal hold. A reason is optional and only meaningful when enabling.
export const setLegalHoldSchema = z.object({
  body: z.object({
    legalHold: z.boolean(),
    reason: z.string().max(2000).optional(),
  }),
});

// Fields the matters list may be sorted by, mirroring the repository's SORT_COLUMNS
// whitelist. Anything outside this set is rejected here rather than silently ignored.
const MATTER_SORT_FIELDS = ['name', 'status', 'matterNumber', 'category', 'createdAt', 'updatedAt', 'practiceArea', 'leadUser'];

// The filters that define WHICH matters a list request matches, independent of how
// many are returned. Shared by the list and the ids-only read behind "select all",
// so the two can't drift into matching different sets.
const matterListFilters = {
  status: z.enum(VALID_MATTER_STATUSES).optional(),
  // "Payment ongoing" is a derived flag rather than a stored status, so it gets
  // its own filter instead of a sentinel inside the `status` enum (which the
  // enum would reject). Combinable with `status`.
  paymentOngoing: z.enum(['true', 'false']).optional(),
  practiceAreaId: z.string().optional(),
  leadUserId: z.string().optional(),
  clientId: z.string().uuid().optional(),
  // A category *path* ("Litigation > Appeals"). Matches that node and everything
  // beneath it, so filtering on a parent includes its subcategories.
  category: z.string().max(200).optional(),
  search: z.string().max(500).optional(),
};

// List query. Every part is optional: omitting `limit` preserves the unlimited
// default (and the `{ matters }` response without `totalItems`), and omitting the
// filters/search/sort preserves the historic `created_at desc` full-list behaviour.
export const listMattersSchema = z.object({
  query: z.object({
    ...paging({ max: 500 }),
    ...matterListFilters,
    ...sorting(MATTER_SORT_FIELDS),
  }).passthrough(),
});

// Ids-only query: the same filters as the list, with no paging or sort (a
// selection is a set, and the caller wants all of it).
export const listMatterIdsSchema = z.object({
  query: z.object({ ...matterListFilters }).passthrough(),
});

// Typeahead query for matter pickers.
export const lookupMattersSchema = z.object({
  query: z.object({
    ...lookup({ max: 50 }),
    // Exact, case-insensitive title match for the advisory duplicate warning.
    exactName: z.string().max(200).optional(),
    // Restrict results to the matters linked to this client. Kept a plain string
    // (not a uuid) so a malformed value yields an empty result rather than a 400,
    // matching how `ids` handles an unusable value.
    clientId: z.string().max(100).optional(),
    // Return the complete enriched matter instead of the slim picker row.
    full: z.enum(['true', 'false']).optional(),
  }),
});

/**
 * The most matter ids any bulk matter route accepts.
 *
 * The matters grid sends its "select all" answer straight to these routes, so the
 * cap has to be exactly the ceiling `listMatterIds` applies to that answer: lower
 * and a full selection becomes a 400, absent and one request can put thousands of
 * per-matter listener chains and queries onto an instance whose pool holds twelve
 * connections. `MAX_SELECTABLE_IDS` in matters.service.ts is derived from this
 * constant rather than repeating the number, so the two cannot drift.
 *
 * Defined here, in the leaf module, because the service imports validation and
 * not the reverse; putting it in the service would make the schemas depend on the
 * whole service graph.
 */
export const MAX_BULK_MATTER_IDS = 5000;

export const bulkDeleteSchema = z.object({
  body: z.object({
    matterIds: z.array(z.string()).min(1, 'At least one matterId is required').max(MAX_BULK_MATTER_IDS),
  }),
});

export const bulkUpdateStatusSchema = z.object({
  body: z.object({
    matterIds: z.array(z.string()).min(1).max(MAX_BULK_MATTER_IDS),
    status: z.enum(VALID_MATTER_STATUSES),
  }),
});

export const bulkUpdatePracticeAreaSchema = z.object({
  body: z.object({
    matterIds: z.array(z.string()).min(1).max(MAX_BULK_MATTER_IDS),
    // A uuid, not just a non-empty string. The repository coerces a non-uuid to
    // null rather than refusing, so the looser schema turned a malformed id into
    // a silent CLEARING of the practice area on every matter in the batch.
    practiceAreaId: z.string().uuid(),
  }),
});

// null or an empty string clears the practice area (the edit modal's "None").
// The key itself stays required so an empty body cannot clear one by accident.
export const updatePracticeAreaSchema = z.object({
  body: z.object({
    practiceAreaId: z.string().nullable(),
  }),
});

// Conflict check: at least one of names/emails/organizations must be supplied.
export const conflictCheckSchema = z.object({
  body: z.object({
    names: z.array(z.string()).optional().default([]),
    emails: z.array(z.string()).optional().default([]),
    organizations: z.array(z.string()).optional().default([]),
    excludeClientIds: z.array(z.string().uuid()).optional().default([]),
  }).refine(
    (b) => (b.names.length + b.emails.length + b.organizations.length) > 0,
    { message: 'At least one name, email, or organization is required' },
  ),
});

// Firm-wide matter events feed for the calendar. `from`/`to` bound the read to the
// days being drawn; omitting them keeps the full-set contract.
export const listAllMatterEventsSchema = z.object({
  query: z.object({
    ...dateWindow(),
    tz: z.string().optional(),
  }).passthrough(),
});

// All optional so a bare `GET /:matterId/events` still validates and returns the
// complete list, which the calendar and the matter overview depend on.
export const listMatterEventsSchema = z.object({
  query: z.object({
    status: z.enum(['upcoming', 'completed', 'cancelled']).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }).passthrough(),
});

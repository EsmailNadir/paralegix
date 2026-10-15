import { z } from 'zod';
import { eventEndField } from '../../shared/validation/eventRange';
const { paging, sorting, lookup, dayOnly } = require('../../shared/validation/listQuery');
const { hasValidCalendarDatePrefix } = require('../../shared/validation/calendarDate');

// `dueDate` accepts a bare day ("2026-05-10") or a full datetime, so it can't
// be pinned to one regex shape the way a day-only field can. An impossible
// calendar date (e.g. "2026-02-30") has to be rejected here rather than
// reaching the `due_date` DATE column unchanged: Postgres refuses it, and that
// raw error otherwise surfaces as an opaque 500 instead of a clean 400.
const dueDateField = z.string()
  .refine((v) => hasValidCalendarDatePrefix(v), 'Must be a real calendar date');
const nullableDueDateField = z.union([z.string(), z.null()])
  .refine((v) => typeof v !== 'string' || hasValidCalendarDatePrefix(v), 'Must be a real calendar date');

const recurrenceSchema = z.object({
  enabled: z.boolean(),
  pattern: z.enum(['daily', 'weekly', 'monthly', 'custom']),
  interval: z.number().int().min(1).max(365).optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  endDate: nullableDueDateField.optional(),
  maxOccurrences: z.number().int().min(1).max(1000).nullable().optional(),
}).optional();

// Sortable task columns, kept in one place because they feed both the single
// `sortBy` enum and the multi-column `sort` pattern. Must stay in sync with
// SORT_COLUMNS in tasks.repository.js — a field accepted here but missing there
// is silently dropped from the ORDER BY.
const TASK_SORT_FIELDS = ['title', 'status', 'dueDate', 'assignedTo', 'matterId', 'createdAt', 'priority'];

// Firm task list: optional server-side pagination/filter/sort query params.
// All optional so a bare `GET /tasks` (full-set legacy behavior) still validates.
// The filters that define WHICH tasks a list request matches, independent of how
// many are returned. Shared by the list and the ids-only read behind "select all",
// so the two can't drift into matching different sets.
const taskListFilters = {
  // `active` is a filter-only sentinel meaning "not completed" - it spans open,
  // in_progress and blocked. Anything that surfaces outstanding work needs it:
  // matching a single status instead would silently omit in-progress and blocked
  // tasks that are still due. It is deliberately absent from the create/update
  // and bulk-status schemas, which set a real status on a row.
  status: z.enum(['open', 'in_progress', 'completed', 'blocked', 'active']).optional(),
  assignee: z.string().optional(),
  matterId: z.string().optional(),
  clientId: z.string().uuid().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  search: z.string().max(500).optional(),
  // Inclusive due-date window, day-only. The calendar sends these to bound its
  // read to the days it is drawing. They filter without paginating.
  dueFrom: dayOnly.optional(),
  dueTo: dayOnly.optional(),
};

export const listTasksSchema = z.object({
  query: z.object({
    // The tasks grid is the only caller and always pages by number, so `offset`
    // is not accepted here (unlike the matters/clients lists, which still serve
    // older `?limit=&offset=` callers).
    ...paging({ max: 200, withOffset: false }),
    ...taskListFilters,
    // Calendar reads include all-day spans overlapping the due-date window.
    includeSpanning: z.enum(['true', 'false']).optional(),
    ...sorting(TASK_SORT_FIELDS),
    tz: z.string().optional(),
  }).passthrough(),
});

// Ids-only query: the same filters as the list, with no paging or sort (a
// selection is a set, and the caller wants all of it).
export const listTaskIdsSchema = z.object({
  query: z.object({ ...taskListFilters }).passthrough(),
});

// Typeahead query for task pickers.
export const lookupTasksSchema = z.object({
  query: z.object({
    ...lookup({ max: 50 }),
    // Exact, case-insensitive title match for the advisory duplicate warning.
    exactName: z.string().max(500).optional(),
    // Restrict results to the tasks linked to this client. Kept a plain string
    // (not a uuid) so a malformed value yields an empty result rather than a 400,
    // matching how `ids` handles an unusable value.
    clientId: z.string().max(100).optional(),
    // Restrict results to one matter, so the duplicate-title advisory only
    // compares against tasks on the same matter rather than the whole firm.
    // Plain string for the same reason as clientId above.
    matterId: z.string().max(100).optional(),
  }),
});

export const createTaskSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(5000).optional(),
    location: z.string().max(500).optional(),
    matterId: z.string().optional(),
    dueDate: dueDateField.optional(),
    // Optional end, after the due date/time. All-day: the exclusive day after the last day.
    endsAt: eventEndField.optional(),
    allDay: z.boolean().optional(),
    assignedTo: z.array(z.string()).optional(),
    assignedToName: z.array(z.string()).optional(),
    practiceAreaId: z.string().optional(),
    practiceAreaName: z.string().optional(),
    courtId: z.string().optional(),
    courtName: z.string().optional(),
    status: z.enum(['open', 'in_progress', 'completed', 'blocked']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    clientIds: z.array(z.string()).optional(),
    reminderRecipientIds: z.array(z.string()).optional(),
    sendReminderEarly: z.boolean().optional(),
    skipCalendarEvent: z.boolean().optional(),
    recurrence: recurrenceSchema,
    dependencies: z.array(z.string()).max(20).optional(),
  }),
});

export const updateTaskSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(5000).optional(),
    location: z.string().max(500).nullable().optional(),
    matterId: z.string().nullable().optional(),
    dueDate: nullableDueDateField.optional(),
    // Null removes the end.
    endsAt: eventEndField.nullable().optional(),
    allDay: z.boolean().optional(),
    assignedTo: z.array(z.string()).nullable().optional(),
    assignedToName: z.array(z.string()).nullable().optional(),
    practiceAreaId: z.string().nullable().optional(),
    practiceAreaName: z.string().nullable().optional(),
    courtId: z.string().nullable().optional(),
    courtName: z.string().nullable().optional(),
    status: z.enum(['open', 'in_progress', 'completed', 'blocked']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    clientIds: z.array(z.string()).optional(),
    reminderRecipientIds: z.array(z.string()).optional(),
    sendReminderEarly: z.boolean().optional(),
    // `id` is the file this points at, and it is what the link is made of.
    // The other fields are what the upload route handed back and are read from
    // the file row now, so they are accepted and ignored. `objectPath` stays a
    // usable key for a client that has not been redeployed with the id.
    attachments: z.array(z.object({
      id: z.string().optional(),
      name: z.string(),
      objectPath: z.string(),
      url: z.string().optional(),
      size: z.number().optional(),
      type: z.string().optional(),
    })).optional(),
    skipCalendarEvent: z.boolean().optional(),
    recurrence: recurrenceSchema,
    dependencies: z.array(z.string()).max(20).optional(),
  }),
});

/**
 * The most ids any bulk route takes. The tasks grid sends its "select all" answer
 * straight to bulk-delete, bulk-status and bulk-matter alike, so the cap is the
 * ceiling `listTaskIds` applies. Imported from the service rather than restated
 * here: one number cannot drift from itself, and a cap below that ceiling would
 * turn a full, legitimate selection into a 400.
 */
const { MAX_BULK_TASK_IDS } = require('./tasks.service');

export const bulkDeleteSchema = z.object({
  body: z.object({
    taskIds: z.array(z.string()).min(1).max(MAX_BULK_TASK_IDS),
  }),
});

export const bulkStatusSchema = z.object({
  body: z.object({
    taskIds: z.array(z.string()).min(1).max(MAX_BULK_TASK_IDS),
    status: z.enum(['open', 'in_progress', 'completed', 'blocked']),
  }),
});

export const bulkMatterSchema = z.object({
  body: z.object({
    taskIds: z.array(z.string()).min(1).max(MAX_BULK_TASK_IDS),
    matterId: z.string().nullable(),
  }),
});

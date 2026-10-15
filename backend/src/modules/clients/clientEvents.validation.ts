import { z } from 'zod';
import { eventEndField } from '../../shared/validation/eventRange';
const { paging } = require('../../shared/validation/listQuery');
const { hasValidCalendarDatePrefix } = require('../../shared/validation/calendarDate');

// `date` accepts a day-only or full-datetime string (resolved later by
// `shared/utils/time`), so it can't be pinned to one regex shape here - but
// an impossible calendar date (e.g. "2026-02-30") must still be rejected
// rather than silently reaching `toTimestampOrNull`, which now returns null
// for it rather than the wrong rolled-over date.
const eventDateRequired = z.string().min(1, 'Date is required')
  .refine(hasValidCalendarDatePrefix, { message: 'Must be a real calendar date' });
const eventDateOptional = z.string()
  .refine(hasValidCalendarDatePrefix, { message: 'Must be a real calendar date' }).optional();

const MATTER_EVENT_TYPES = [
  'court_date',
  'hearing',
  'deposition',
  'filing_deadline',
  'discovery_cutoff',
  'mediation',
  'arbitration',
  'trial',
  'appeal_deadline',
  'statute_of_limitations',
  'meeting',
  'other',
];

const MATTER_EVENT_STATUSES = ['upcoming', 'completed', 'cancelled'];

/**
 * A document linked to an event.
 *
 * `fileId` is what the link IS; the rest is a snapshot the calendar renders
 * without a join. It used to key on `objectPath`, which a rename or a move
 * rewrote, so a link made before either one pointed at nothing afterwards.
 */
const linkedFileSchema = z.object({
  fileId: z.string().uuid(),
  name: z.string().min(1).max(500),
  size: z.number().nonnegative(),
  contentType: z.string().min(1).max(200),
  scope: z.enum(['matter', 'task', 'client', 'general']),
  scopeId: z.string().optional(),
});

// GET /clients/:clientId/events. Paging is opt-in: omitting `limit` returns the
// complete feed, which the tab's own count and the calendar still read.
export const listClientEventsSchema = z.object({
  query: z.object({
    ...paging({ max: 200 }),
    status: z.enum(MATTER_EVENT_STATUSES).optional(),
  }).passthrough(),
});

export const createClientEventSchema = z.object({
  body: z.object({
    type: z.enum(MATTER_EVENT_TYPES),
    title: z.string().min(1, 'Title is required').max(300),
    date: eventDateRequired,
    // Optional: a deadline is an instant, an appearance is a span.
    endsAt: eventEndField.optional(),
    allDay: z.boolean().optional(),
    notes: z.string().max(2000).optional(),
    courtId: z.string().optional(),
    locationName: z.string().max(300).optional(),
    location: z.string().max(500).optional(),
    status: z.enum(MATTER_EVENT_STATUSES).optional().default('upcoming'),
    matterId: z.string().optional(),
    assignedTo: z.array(z.string()).max(50).optional(),
    assignedToName: z.array(z.string()).max(50).optional(),
    // Directory contacts attending: everyone on the event who is not a firm
    // member. Replace-set, so sending [] clears them.
    contactIds: z.array(z.string()).max(50).optional(),
    linkedFiles: z.array(linkedFileSchema).max(20).optional(),
    clientVisible: z.boolean().optional(),
    clientDescription: z.string().max(2000).optional(),
  }),
});

export const updateClientEventSchema = z.object({
  body: z.object({
    source: z.enum(['matter', 'client']),
    matterId: z.string().optional(),
    type: z.enum(MATTER_EVENT_TYPES).optional(),
    title: z.string().min(1).max(300).optional(),
    date: eventDateOptional,
    // Null removes the end, turning a span back into an instant.
    endsAt: eventEndField.nullable().optional(),
    allDay: z.boolean().optional(),
    notes: z.string().max(2000).nullable().optional(),
    courtId: z.string().nullable().optional(),
    locationName: z.string().max(300).nullable().optional(),
    location: z.string().max(500).nullable().optional(),
    status: z.enum(MATTER_EVENT_STATUSES).optional(),
    assignedTo: z.array(z.string()).max(50).optional(),
    assignedToName: z.array(z.string()).max(50).optional(),
    // Directory contacts attending: everyone on the event who is not a firm
    // member. Replace-set, so sending [] clears them.
    contactIds: z.array(z.string()).max(50).optional(),
    linkedFiles: z.array(linkedFileSchema).max(20).optional(),
    clientVisible: z.boolean().optional(),
    clientDescription: z.string().max(2000).nullable().optional(),
  }),
});

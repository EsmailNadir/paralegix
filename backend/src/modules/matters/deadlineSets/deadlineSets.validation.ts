import { z } from 'zod';
const { MATTER_EVENT_TYPES } = require('../matterEvents.validation');

// A single deadline in a template: an event to create at an offset from the
// anchor date. `offsetDays` is the whole number of days; `offsetDirection`
// decides whether that lands before or after the anchor.
const deadlineItemSchema = z.object({
  title: z.string().min(1, 'Each deadline needs a title').max(300),
  type: z.enum(MATTER_EVENT_TYPES),
  offsetDays: z.number().int().min(0).max(3650),
  offsetDirection: z.enum(['before', 'after']).default('after'),
  // 'previous' chains this item's offset off the date computed for the item
  // before it, instead of the set's trigger date. Forced to 'trigger' for the
  // first item server-side, since it has no previous item.
  relativeTo: z.enum(['trigger', 'previous']).default('trigger'),
  clientVisible: z.boolean().optional(),
  notes: z.string().max(2000).optional().nullable(),
});

export const createDeadlineSetSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(200),
    description: z.string().max(1000).optional().nullable(),
    adjustForWeekends: z.boolean().optional(),
    items: z.array(deadlineItemSchema).min(1, 'Add at least one deadline').max(50),
  }),
});

export const updateDeadlineSetSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional().nullable(),
    adjustForWeekends: z.boolean().optional(),
    items: z.array(deadlineItemSchema).min(1, 'Add at least one deadline').max(50).optional(),
  }),
});

export const applyDeadlineSetSchema = z.object({
  body: z.object({
    anchorDate: z.string().min(1, 'Anchor date is required'),
  }),
});

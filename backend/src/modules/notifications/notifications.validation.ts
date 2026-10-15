import { z } from 'zod';

export const listNotificationsSchema = z.object({
  params: z.object({
    lawFirmId: z.string(),
  }),
  query: z.object({
    unreadOnly: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    // Filter to a set of notification types, comma-separated (the UI's filter
    // chips map to several types each, e.g. Invoices covers invoice_paid,
    // invoice_payment_reversed and invoice_credit_note_added). Bounded so the
    // generated `= any(...)` stays small.
    types: z.string().max(500).optional(),
    // Cursor for pagination: return rows older than this ISO timestamp,
    // tie-broken by `beforeId` (the id of the last row on the previous page).
    before: z.string().datetime().optional(),
    beforeId: z.string().uuid().optional(),
  }),
});

export const notificationIdSchema = z.object({
  params: z.object({
    lawFirmId: z.string(),
    notificationId: z.string(),
  }),
});

// markReadSchema kept as an alias so existing imports stay valid; the shape is
// identical (just the id-bearing params).
export const markReadSchema = notificationIdSchema;

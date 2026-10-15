import { z } from 'zod';
const { paging } = require('../../shared/validation/listQuery');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

// A checklist item as submitted from the "New document request" form: a
// label plus an optional description shown to the client to explain what
// exactly is needed for that item.
const itemInput = z.object({
  label: z.string().max(300),
  description: z.string().max(1000).optional().nullable(),
});

export const createRequestSchema = z.object({
  body: z.object({
    // Omitted/null makes a client-level "General" request not tied to any matter.
    matterId: z.string().uuid('Invalid matter').optional().nullable(),
    clientId: z.string().uuid('A client is required'),
    title: z.string().min(1, 'Title is required').max(300),
    note: z.string().max(5000).optional(),
    dueDate: isoDate.optional().nullable(),
    items: z.array(itemInput).max(50, 'Too many items').optional(),
    // Narrows the DOCUMENT_REQUEST_CREATED notification fan-out to one
    // roster contact instead of every eligible contact on a company client.
    // Meaningless (and rejected) for a person client, which has only one
    // recipient to begin with.
    contactClientId: z.string().uuid('Invalid contact').optional().nullable(),
  }),
  params: z.object({ lawFirmId: z.string() }),
});

export const updateRequestSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(300).optional(),
    note: z.string().max(5000).optional().nullable(),
    status: z.enum(['open', 'completed', 'cancelled']).optional(),
    dueDate: isoDate.optional().nullable(),
    addItems: z.array(itemInput).max(50).optional(),
  }),
  params: z.object({ lawFirmId: z.string(), id: z.string() }),
});

// Requests are never pruned, so a long-running matter accumulates them. Omitting
// `limit` still returns the whole set.
export const listRequestsSchema = z.object({
  query: z.object({
    matterId: z.string().uuid('A matter is required'),
    ...paging({ max: 200 }),
  }),
  params: z.object({ lawFirmId: z.string() }),
});

export const updateItemSchema = z.object({
  body: z.object({ status: z.enum(['pending', 'received', 'waived']) }),
  params: z.object({ lawFirmId: z.string(), id: z.string(), itemId: z.string() }),
});

export const linkItemFileSchema = z.object({
  body: z.object({ fileId: z.string().uuid('A file is required') }),
  params: z.object({ lawFirmId: z.string(), id: z.string(), itemId: z.string() }),
});

export const unlinkItemFileSchema = z.object({
  params: z.object({ lawFirmId: z.string(), id: z.string(), itemId: z.string(), fulfillmentId: z.string() }),
});

// GET /clients/:clientId (firm-side: every request addressed to one client, any matter).
export const listClientRequestsSchema = z.object({
  params: z.object({ lawFirmId: z.string(), clientId: z.string().uuid('Invalid client') }),
});

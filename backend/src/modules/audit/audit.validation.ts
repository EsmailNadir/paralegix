import { z } from 'zod';
// Bounded paging params, shared so every list agrees on how deep a window may go.
const { offsetParam } = require('../../shared/validation/listQuery');

// List query for the firm audit log. Numbers are coerced from the query string;
// action / actorUid are optional equality filters. lawFirmId comes from the
// route params.
export const listAuditEventsSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: offsetParam,
    action: z.string().min(1).optional(),
    actorUid: z.string().min(1).optional(),
  }),
  params: z.object({
    lawFirmId: z.string(),
  }),
});

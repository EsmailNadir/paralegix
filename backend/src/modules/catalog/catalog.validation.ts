import { z } from 'zod';
// Bounded paging params, shared so every list agrees on how deep a window may go.
const { offsetParam } = require('../../shared/validation/listQuery');

export const searchCourtsSchema = z.object({
  query: z.object({
    search: z.string().max(200).optional(),
    state: z.string().max(2).optional(),
    courtType: z.string().max(50).optional(),
    jurisdiction: z.string().max(20).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: offsetParam,
  }),
  params: z.object({ lawFirmId: z.string() }),
});

export const listUtbmsSchema = z.object({
  query: z.object({
    codeType: z.enum(['task', 'activity', 'expense']).optional(),
    practiceSet: z.string().max(50).optional(),
  }),
  params: z.object({ lawFirmId: z.string() }),
});

export const adoptCourtsSchema = z.object({
  body: z.object({
    catalogCourtIds: z.array(z.string().uuid()).min(1, 'Select at least one court').max(500),
  }),
  params: z.object({ lawFirmId: z.string() }),
});

export const adoptUtbmsSchema = z.object({
  body: z.object({
    utbmsCodeIds: z.array(z.string().uuid()).min(1, 'Select at least one code').max(500),
  }),
  params: z.object({ lawFirmId: z.string() }),
});

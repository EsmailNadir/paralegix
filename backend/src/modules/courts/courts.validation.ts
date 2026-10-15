import { z } from 'zod';

export const createCourtSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(200),
    abbreviation: z.string().max(50).optional(),
    city: z.string().max(200).optional(),
    state: z.string().max(200).optional(),
    address: z.string().max(500).optional(),
    courtType: z.string().max(100).optional(),
  }),
});

// On update an omitted field is left alone and null clears it, which is how the
// settings form removes a value the user emptied.
export const updateCourtSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(200).optional(),
    abbreviation: z.string().max(50).nullable().optional(),
    city: z.string().max(200).nullable().optional(),
    state: z.string().max(200).nullable().optional(),
    address: z.string().max(500).nullable().optional(),
    courtType: z.string().max(100).nullable().optional(),
  }),
});

import { z } from 'zod';

export const createLawFirmSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    firmSize: z.string().max(50).optional(),
    practiceArea: z.string().max(100).optional(),
  }),
});

export const updateLawFirmSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    // The contact fields can be cleared: the firm settings form sends null for
    // one left empty. The name cannot.
    description: z.string().max(2000).nullable().optional(),
    address: z.string().max(500).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    state: z.string().max(100).nullable().optional(),
    zip: z.string().max(20).nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
    email: z.string().email().nullable().optional(),
  }),
});

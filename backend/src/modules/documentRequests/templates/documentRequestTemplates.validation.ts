import { z } from 'zod';

// A checklist item as submitted from the preset form: a label plus an
// optional description shown to the client, mirroring documentRequests.validation.
const itemInput = z.object({
  label: z.string().min(1).max(300),
  description: z.string().max(1000).optional().nullable(),
});

export const createTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(150),
    defaultTitle: z.string().min(1, 'Default title is required').max(200),
    defaultNote: z.string().max(2000).nullable().optional(),
    items: z.array(itemInput).optional(),
  }),
});

export const updateTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(150).optional(),
    defaultTitle: z.string().min(1).max(200).optional(),
    defaultNote: z.string().max(2000).nullable().optional(),
    items: z.array(itemInput).optional(),
    archived: z.boolean().optional(),
  }),
});

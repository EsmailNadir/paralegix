import { z } from 'zod';

export const createNoteTemplateSchema = z.object({
  body: z.object({
    label: z.string().min(1, 'Label is required').max(100),
    noteType: z.string().max(50).optional(),
    subject: z.string().max(500).optional(),
    contentHtml: z.string().max(50000).optional(),
  }),
});

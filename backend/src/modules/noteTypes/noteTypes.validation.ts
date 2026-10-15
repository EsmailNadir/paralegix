import { z } from 'zod';

export const createNoteTypeSchema = z.object({
  body: z.object({
    label: z.string().min(1, 'Label is required').max(50),
  }),
});

// Mirrors StatusVariant in frontend/src/constants/statusMeta.ts — the palette
// every status/type color picker in the app draws from.
export const updateNoteTypeColorSchema = z.object({
  params: z.object({
    lawFirmId: z.string(),
    value: z.string().min(1).max(50),
  }),
  body: z.object({
    color: z.enum(['success', 'warning', 'danger', 'info', 'neutral', 'purple', 'indigo', 'teal', 'pink', 'cyan']),
  }),
});

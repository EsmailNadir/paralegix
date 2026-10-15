import { z } from 'zod';

export const createStageSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    pipelineId: z.string(),
    color: z.string().max(32).nullable().optional(),
    sortOrder: z.number().int().optional(),
    isClosed: z.boolean().optional(),
    parentStageId: z.string().uuid().nullable().optional(),
  }),
});

export const updateStageSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    color: z.string().max(32).nullable().optional(),
    sortOrder: z.number().int().optional(),
    isClosed: z.boolean().optional(),
    parentStageId: z.string().uuid().nullable().optional(),
  }),
});

import { z } from 'zod';

export const createStageSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    practiceAreaId: z.string().nullable().optional(),
    color: z.string().max(32).nullable().optional(),
    sortOrder: z.number().int().optional(),
    isClosed: z.boolean().optional(),
    parentStageId: z.string().uuid().nullable().optional(),
  }),
});

export const updateStageSchema = z.object({
  body: z.object({
    // A stage's pipeline is fixed once created, because its parent and children
    // live in the same one. Refused outright rather than stripped, so a client
    // that sends it learns the move did not happen.
    practiceAreaId: z.undefined({
      message: 'A stage cannot be moved to another pipeline. Create it in that pipeline instead.',
    }).optional(),
    name: z.string().min(1).max(100).optional(),
    color: z.string().max(32).nullable().optional(),
    sortOrder: z.number().int().optional(),
    isClosed: z.boolean().optional(),
    parentStageId: z.string().uuid().nullable().optional(),
  }),
});

export const reorderStagesSchema = z.object({
  body: z.object({
    stageIds: z.array(z.string()).min(1),
  }),
});

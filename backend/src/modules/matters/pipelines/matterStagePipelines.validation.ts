import { z } from 'zod';

const pipelineStageSchema = z.object({
  clientId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  color: z.string().max(32).nullable().optional(),
  sortOrder: z.number().int().min(0),
  isClosed: z.boolean().optional(),
  parentClientId: z.string().min(1).max(100).nullable(),
});

export const createPipelineSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    practiceAreaId: z.string().nullable().optional(),
    isDefault: z.boolean().optional(),
    stages: z.array(pipelineStageSchema).min(1),
  }),
});

export const updatePipelineSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    practiceAreaId: z.string().nullable().optional(),
    isDefault: z.boolean().optional(),
  }),
});

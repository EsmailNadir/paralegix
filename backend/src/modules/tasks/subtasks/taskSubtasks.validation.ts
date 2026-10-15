import { z } from 'zod';

export const createSubtaskSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Title is required').max(500),
    assigneeUserId: z.string().optional(),
    sortOrder: z.number().int().optional(),
  }),
});

export const updateSubtaskSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(500).optional(),
    isCompleted: z.boolean().optional(),
    // Empty string clears the assignee (stored as null).
    assigneeUserId: z.string().optional(),
    sortOrder: z.number().int().optional(),
  }),
});

export const reorderSubtasksSchema = z.object({
  body: z.object({
    subtaskIds: z.array(z.string().min(1)).min(1, 'subtaskIds is required'),
  }),
});

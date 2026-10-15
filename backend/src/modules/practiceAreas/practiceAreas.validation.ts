import { z } from 'zod';

export const createPracticeAreaSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(200),
  }),
});

export const updatePracticeAreaSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(200),
  }),
});

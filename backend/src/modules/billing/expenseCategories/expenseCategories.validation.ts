import { z } from 'zod';

const expenseCategoryCodePattern = /^[A-Z0-9_]{2,20}$/;

export const createExpenseCategorySchema = z.object({
  body: z.object({
    code: z.string().regex(expenseCategoryCodePattern, 'Code must be 2-20 characters, uppercase letters, numbers, and underscores only'),
    name: z.string().min(1, 'name is required').max(200),
  }),
  params: z.object({
    lawFirmId: z.string(),
  }),
});

export const updateExpenseCategorySchema = z.object({
  body: z.object({
    code: z.string().regex(expenseCategoryCodePattern, 'Code must be 2-20 characters, uppercase letters, numbers, and underscores only').optional(),
    name: z.string().min(1).max(200).optional(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    lawFirmId: z.string(),
    expenseCategoryId: z.string(),
  }),
});

export const reorderExpenseCategoriesSchema = z.object({
  body: z.object({
    expenseCategoryIds: z.array(z.string().uuid()).min(1, 'expenseCategoryIds array is required'),
  }),
  params: z.object({
    lawFirmId: z.string(),
  }),
});

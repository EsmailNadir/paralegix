import { z } from 'zod';

export const createCheckoutSchema = z.object({
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
  body: z.object({
    planId: z.enum(['basic', 'professional', 'enterprise']),
    interval: z.enum(['monthly', 'annual']),
  }),
});

export const changePlanSchema = z.object({
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
  body: z.object({
    planId: z.enum(['basic', 'professional', 'enterprise']),
    interval: z.enum(['monthly', 'annual']),
  }),
});

export const cancelSchema = z.object({
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

export const reactivateSchema = z.object({
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

export const portalSchema = z.object({
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

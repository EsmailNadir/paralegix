import { z } from 'zod';
import { hourlyRateAmount } from '../shared/moneyInput';

const chargeCodePattern = /^[A-Z0-9]{3,10}$/;

export const createChargeCodeSchema = z.object({
  body: z.object({
    code: z.string().regex(chargeCodePattern, 'Code must be 3-10 characters, uppercase letters and numbers only'),
    name: z.string().min(1, 'name is required'),
    defaultRate: hourlyRateAmount.nullable().optional(),
    memberRates: z.record(z.string(), hourlyRateAmount).optional(),
  }),
});

export const updateChargeCodeSchema = z.object({
  body: z.object({
    code: z.string().regex(chargeCodePattern, 'Code must be 3-10 characters, uppercase letters and numbers only').optional(),
    name: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
    defaultRate: hourlyRateAmount.nullable().optional(),
    memberRates: z.record(z.string(), hourlyRateAmount).optional(),
  }),
});

export const reorderChargeCodesSchema = z.object({
  body: z.object({
    chargeCodeIds: z.array(z.string().uuid()).min(1, 'chargeCodeIds array is required'),
  }),
});

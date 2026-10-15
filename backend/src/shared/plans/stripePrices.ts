/**
 * Maps Paralegix plan tiers to Stripe Price IDs.
 * Price IDs come from env vars so test/live mode can differ.
 */
export const PRICE_MAP = {
  basic: {
    monthly: process.env.STRIPE_BASIC_MONTHLY_PRICE_ID || null,
    annual: process.env.STRIPE_BASIC_ANNUAL_PRICE_ID || null,
  },
  professional: {
    monthly: process.env.STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID || null,
    annual: process.env.STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID || null,
  },
  enterprise: {
    monthly: process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID || null,
    annual: process.env.STRIPE_ENTERPRISE_ANNUAL_PRICE_ID || null,
  },
};

/** The Stripe Price ID for a plan and billing interval, or null if unmapped. */
export function getPriceId(planId: string, interval: string): string | null {
  const map = PRICE_MAP as Record<string, Record<string, string | null> | undefined>;
  return map[planId]?.[interval] || null;
}

/**
 * Reverse lookup: given a Stripe Price ID, return { planId, interval }.
 * Returns null if the price ID is not recognized.
 */
export function planFromPriceId(priceId?: string | null): { planId: string; interval: string } | null {
  if (!priceId) return null;
  for (const [planId, intervals] of Object.entries(PRICE_MAP)) {
    for (const [interval, id] of Object.entries(intervals)) {
      if (id === priceId) return { planId, interval };
    }
  }
  return null;
}

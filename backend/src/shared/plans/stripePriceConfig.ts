/**
 * Checks the configured Stripe price IDs against what the code charges.
 *
 * `PRICE_MAP` (stripePrices.ts) takes a price ID per plan and interval from the
 * environment, and nothing ties that ID to `PLAN_TIERS[plan].pricing`. A copied
 * monthly ID in an annual slot, a price for the wrong amount, or an archived price
 * all check out without an error; the client is simply billed the wrong thing, and
 * `planFromPriceId` records the wrong interval. `scripts/verify-stripe-prices.ts`
 * fetches the configured prices and reports what this finds.
 */
import { PLAN_TIERS } from './planDefinitions';

/** The fields of a Stripe Price this check reads. */
export interface StripePriceFacts {
  unitAmount: number | null;
  currency: string;
  interval: string | null;
  intervalCount: number | null;
  active: boolean;
}

type PriceMap = Record<string, Record<string, string | null>>;

const EXPECTED_INTERVAL: Record<string, string> = { monthly: 'month', annual: 'year' };

/** Every mismatch, as one line each. Empty means the configuration matches the plan table. */
export function verifyStripePriceConfig(priceMap: PriceMap, prices: Record<string, StripePriceFacts>): string[] {
  const problems: string[] = [];
  const slotsById = new Map<string, string[]>();

  for (const [planId, intervals] of Object.entries(priceMap)) {
    for (const [interval, id] of Object.entries(intervals)) {
      const slot = `${planId} ${interval}`;
      if (id) slotsById.set(id, [...(slotsById.get(id) || []), slot]);
    }
  }
  for (const [id, slots] of slotsById) {
    if (slots.length > 1) problems.push(`${slots.join(' and ')} share price ${id}`);
  }

  for (const [planId, intervals] of Object.entries(priceMap)) {
    const tier = (PLAN_TIERS as Record<string, { pricing?: Record<string, number> }>)[planId];
    for (const [interval, id] of Object.entries(intervals)) {
      const slot = `${planId} ${interval}`;
      if (!id) { problems.push(`${slot}: no price id configured`); continue; }
      const price = prices[id];
      if (!price) { problems.push(`${slot}: price ${id} was not found in this Stripe account`); continue; }
      if (!price.active) { problems.push(`${slot}: price ${id} is archived`); continue; }
      if (price.currency !== 'usd') problems.push(`${slot}: currency ${price.currency}, expected usd`);
      const wantInterval = EXPECTED_INTERVAL[interval];
      if (price.interval !== wantInterval || price.intervalCount !== 1) {
        problems.push(`${slot}: bills every ${price.intervalCount} ${price.interval}, expected every 1 ${wantInterval}`);
      }
      const wantCents = tier?.pricing?.[interval];
      if (wantCents != null && price.unitAmount !== wantCents) {
        problems.push(`${slot}: ${price.unitAmount} cents, expected ${wantCents}`);
      }
    }
  }
  return problems;
}

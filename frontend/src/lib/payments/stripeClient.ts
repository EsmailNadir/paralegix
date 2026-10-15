import { loadStripe, type Stripe } from "@stripe/stripe-js";

const cache = new Map<string, Promise<Stripe | null>>();

/**
 * Stripe.js for one firm's connected account, loaded once per account. Card
 * payments are direct charges on the firm's own Stripe account, so the card
 * form tokenizes the card there with the platform's publishable key. Resolves
 * null when no publishable key is configured.
 */
export function stripeForAccount(stripeAccountId: string): Promise<Stripe | null> {
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!key) return Promise.resolve(null);
  let entry = cache.get(stripeAccountId);
  if (!entry) {
    entry = loadStripe(key, { stripeAccount: stripeAccountId });
    cache.set(stripeAccountId, entry);
  }
  return entry;
}

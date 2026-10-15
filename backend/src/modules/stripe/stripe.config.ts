const Stripe = require('stripe');

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.warn('[stripe] STRIPE_SECRET_KEY not set. Stripe features will be unavailable');
}

/**
 * Pinned, deliberately. An SDK upgrade moves the default API version with it and
 * changes wire shapes underneath code that never changed: `Invoice.payment_intent`
 * disappeared in 2025-03-31.basil and the payment-intent read went null for every
 * hosted-invoice payment until the reader learnt the new shape.
 * Bump this on purpose, with the changelog open, and update the readers with it.
 *
 * `maxNetworkRetries` covers the idempotent calls (every write here carries an
 * idempotency key or is a retrieve); `timeout` keeps a hung Stripe call from
 * holding a webhook or a request open indefinitely.
 */
const STRIPE_API_VERSION = '2026-08-26.dahlia';

const stripe = key
  ? new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 30_000 })
  : null;

export = stripe;

// Check the Stripe price IDs in the environment against the plan table.
//
//   npx tsx backend/scripts/verify-stripe-prices.ts
//
// Reads STRIPE_SECRET_KEY and the six STRIPE_*_{MONTHLY,ANNUAL}_PRICE_ID values from
// backend/.env (or the process environment), fetches each price from that Stripe
// account, and prints every mismatch with PLAN_TIERS pricing. Read-only. Exits 1 on
// any problem. Run it for each environment before a deploy that changes the IDs.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const Stripe = require('stripe');
const { PRICE_MAP } = require('../src/shared/plans/stripePrices');
const { verifyStripePriceConfig } = require('../src/shared/plans/stripePriceConfig');

(async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { console.error('STRIPE_SECRET_KEY is not set.'); process.exit(1); }
  const stripe = new Stripe(key);
  console.log(`Stripe mode: ${key.startsWith('sk_live_') ? 'LIVE' : 'test'}`);

  const ids = new Set<string>();
  for (const intervals of Object.values(PRICE_MAP) as Array<Record<string, string | null>>) {
    for (const id of Object.values(intervals)) if (id) ids.add(id);
  }
  const prices: Record<string, any> = {};
  for (const id of ids) {
    try {
      const p = await stripe.prices.retrieve(id);
      prices[id] = {
        unitAmount: p.unit_amount, currency: p.currency, active: p.active,
        interval: p.recurring?.interval ?? null, intervalCount: p.recurring?.interval_count ?? null,
      };
    } catch (err: any) {
      if (err?.code !== 'resource_missing') throw err;
    }
  }

  const problems = verifyStripePriceConfig(PRICE_MAP, prices);
  if (!problems.length) { console.log('All six prices match the plan table.'); return; }
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
})().catch((err) => { console.error(err?.message || err); process.exit(1); });

// A module, so its top-level consts do not collide with the other scripts' in the
// shared tools typecheck.
export {};

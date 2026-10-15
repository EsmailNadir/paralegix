#!/usr/bin/env node

// Bill trust deposit ACH processing fees that accrued but were never charged
// (typically because the firm had no subscription customer when the deposit
// settled). Adds an invoice item to each firm's subscription customer and marks the
// fee billed. Safe to run repeatedly. Intended to run on a schedule.
//
//   npx tsx backend/scripts/bill-accrued-trust-fees.ts            # bill up to 500
//   npx tsx backend/scripts/bill-accrued-trust-fees.ts --limit=50

const stripeService = require('../src/modules/stripe/stripe.service');

function parseArgs(argv: any) {
  const args = { limit: 500 };
  argv.forEach((arg: any) => {
    if (arg.startsWith('--limit=')) {
      const n = Number(arg.split('=')[1]);
      if (Number.isFinite(n) && n > 0) args.limit = n;
    }
  });
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await stripeService.sweepAccruedTrustFees(args);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('bill-accrued-trust-fees failed:', err);
  process.exit(1);
});

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};

#!/usr/bin/env node

const stripeService = require('../src/modules/stripe/stripe.service');

function parseArgs(argv: any) {
  const args: { dryRun: boolean; limit: number | null } = {
    dryRun: true,
    limit: null,
  };

  argv.forEach((arg: any) => {
    if (arg === '--apply') {
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.split('=')[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.limit = parsed;
      }
    }
  });

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await stripeService.reconcileStripeInvoices(args);

  if (summary.failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Stripe reconciliation failed:', err);
  process.exit(1);
});

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};

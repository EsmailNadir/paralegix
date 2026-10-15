// Every online-payment fee number in one place. A client invoice payment costs
// an estimated processing fee, which the firm absorbs or (when the firm passes
// it on) the client pays on top. Paralegix collects its share as the Stripe
// application fee. Rates are env-overridable so pricing can be tuned without a
// redeploy.
import { percentOfCents } from '../billing/shared/money';

export type PaymentMethodKind = 'card' | 'bank';
export const PAYMENT_METHOD_KINDS: readonly PaymentMethodKind[] = ['card', 'bank'];

// Card: Stripe's ~2.9% + 30c plus the 0.9% Paralegix margin. On a destination
// charge (a firm on an Express account) the platform is the merchant of
// record and Stripe debits its processing cost from the PLATFORM balance, so
// this whole amount is the application fee and Paralegix pays Stripe from it.
// Without it every payment is collected at a loss.
const CARD_RATE = Number(process.env.STRIPE_APPLICATION_FEE_RATE ?? 0.038);
const CARD_FIXED_CENTS = Number(process.env.STRIPE_APPLICATION_FEE_FIXED_CENTS ?? 30);

// Bank (ACH): Stripe's 0.8% capped at $5, plus the same 0.9% margin.
const BANK_STRIPE_RATE = Number(process.env.STRIPE_ACH_FEE_RATE ?? 0.008);
const BANK_STRIPE_CAP_CENTS = Number(process.env.STRIPE_ACH_FEE_CAP_CENTS ?? 500);

// The Paralegix margin. On a DIRECT charge (a firm on its own Standard account)
// the firm pays Stripe's processing fee itself, so this is the platform's whole
// take: 0.9% with no fixed part keeps the margin where the destination model
// left it and the firm's total cost where it was.
const MARGIN_RATE = Number(process.env.STRIPE_DIRECT_APPLICATION_FEE_RATE ?? 0.009);
const MARGIN_FIXED_CENTS = Number(process.env.STRIPE_DIRECT_APPLICATION_FEE_FIXED_CENTS ?? 0);

function wholeCents(amountCents: unknown): number {
  return Math.round(Number(amountCents) || 0);
}

/**
 * The estimated processing cost of a charge of `grossCents`, never more than
 * the charge itself (Stripe rejects an application fee larger than the amount).
 */
export function estimatedCostCents(method: PaymentMethodKind, grossCents: number): number {
  const gross = wholeCents(grossCents);
  if (gross <= 0) return 0;
  const cost = method === 'card'
    ? percentOfCents(gross, CARD_RATE * 100) + CARD_FIXED_CENTS
    : Math.min(percentOfCents(gross, BANK_STRIPE_RATE * 100), BANK_STRIPE_CAP_CENTS)
      + percentOfCents(gross, MARGIN_RATE * 100);
  return Math.min(cost, gross);
}

/** The Paralegix margin alone: the application fee on a direct charge. */
function marginCents(grossCents: number): number {
  const gross = wholeCents(grossCents);
  if (gross <= 0) return 0;
  return Math.min(percentOfCents(gross, MARGIN_RATE * 100) + MARGIN_FIXED_CENTS, gross);
}

/**
 * The `application_fee_amount` for a charge of `grossCents`. A destination
 * charge keeps the whole estimated cost (Paralegix pays Stripe from it); a
 * direct charge keeps only the margin.
 */
export function applicationFeeCents(method: PaymentMethodKind, grossCents: number, direct: boolean): number {
  return direct ? marginCents(grossCents) : estimatedCostCents(method, grossCents);
}

/**
 * The fee to add on top of an invoice payment of `invoiceCents` when the client
 * pays it: the smallest surcharge that leaves the firm the full invoice amount
 * after the estimated cost of the larger charge. Grossed up rather than a flat
 * percentage of the invoice, because the cost is charged on the surcharge too.
 */
export function clientSurchargeCents(method: PaymentMethodKind, invoiceCents: number): number {
  const invoice = wholeCents(invoiceCents);
  if (invoice <= 0) return 0;
  const netOf = (gross: number) => gross - estimatedCostCents(method, gross);

  // Match percentOfCents' rate precision. Before rounding, the capped bank
  // cost is the smaller of two lines: (bank + margin) * gross, or cap +
  // margin * gross. Solve both and take the earlier possible gross. Ignoring
  // the cap would leave a cent-by-cent scan proportional to the invoice.
  const preciseRate = (rate: number) => Math.round(rate * 100 * 1_000) / 100_000;
  const threshold = (costRate: number, fixed: number, roundingError: number) => {
    const netRate = 1 - preciseRate(costRate);
    return netRate > 0 ? (invoice + fixed - roundingError) / netRate : Infinity;
  };
  const lowerBound = method === 'card'
    ? threshold(CARD_RATE, CARD_FIXED_CENTS, 0.5)
    : Math.min(
      threshold(preciseRate(BANK_STRIPE_RATE) + preciseRate(MARGIN_RATE), 0, 1),
      threshold(MARGIN_RATE, BANK_STRIPE_CAP_CENTS, 0.5),
    );
  if (!Number.isFinite(lowerBound)) throw new RangeError('Processing fee rates must leave a positive net payment');

  // The allowance covers each percentage's half-cent rounding. Start just
  // below it to protect the bound from floating-point division, then inspect
  // ascending cents so simultaneous bank/margin rounding cannot skip an
  // earlier sufficient gross. This scan depends on the rates, not the amount.
  let gross = Math.max(invoice, Math.floor(lowerBound) - 1);
  while (netOf(gross) < invoice) gross += 1;
  return gross - invoice;
}

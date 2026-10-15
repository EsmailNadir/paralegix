import { formatCents } from "@/lib/utils/currency";

/** Display names for the plan tiers, which are stored lowercase. */
export const PLAN_LABELS: Record<string, string> = {
  starter: "Starter",
  basic: "Basic",
  professional: "Professional",
  enterprise: "Enterprise",
};

/** Display names for the billing intervals, which are stored lowercase. */
export const INTERVAL_LABELS: Record<string, string> = {
  monthly: "Monthly",
  annual: "Annual",
};

const INTERVAL_SUFFIXES: Record<string, string> = {
  monthly: "/mo",
  annual: "/yr",
};

/** The interval as it reads after "Billed": "monthly", "annually". */
export function intervalAdverb(interval: string | null | undefined): string | null {
  if (!interval) return null;
  return interval === "annual" ? "annually" : interval === "monthly" ? "monthly" : interval;
}

export function planLabel(planId: string | null | undefined): string {
  if (!planId) return "-";
  return PLAN_LABELS[planId] || planId;
}

export function intervalLabel(interval: string | null | undefined): string | null {
  if (!interval) return null;
  return INTERVAL_LABELS[interval] || interval;
}

/**
 * A firm's recurring charge, e.g. "$500.00/yr" - the list price for the tier and
 * interval it is on. Null when the firm is not on a priced interval (comped, or
 * never subscribed). What Stripe actually collected can differ through a coupon or
 * proration; that is the firm's last-payment figure, not this.
 */
export function formatPlanPrice(plan: {
  billingInterval?: string | null;
  planPriceCents?: number | null;
}): string | null {
  const interval = plan.billingInterval;
  if (!interval || plan.planPriceCents == null) return null;
  return `${formatCents(plan.planPriceCents)}${INTERVAL_SUFFIXES[interval] || ""}`;
}
